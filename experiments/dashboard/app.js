/**
 * Dashboard experiment: diagnostics + oscilloscope.
 * UI text: Traditional Chinese. Code/comments: English.
 */

import { omni, PINS_CONFIG, MA_WINDOW, FLOATING_ADC_IDS } from '../../web/core/state.js';
import { clearBleQueue, resetFloatingBuffers, setAfterProcessCallback } from '../../web/core/events.js';
import { u32Delta } from '../../web/core/unpacker.js';
import { computeTouchModeMask } from '../../web/core/touchMask.js';
import { applyDeviceConfig } from '../../web/core/configApply.js';
import * as ble from '../../web/core/ble.js';

const ANALOG_FOUR_IDS = [0, 1, 3, 4];
const G2_ID = 2;
const ANALOG_MODE_IDS = [0, 1, 2, 3, 4];
const DIGITAL_IDS = [5, 6, 7, 8];
const DIGITAL_PULL_BITS = 0x1e0;

const MODE_ICON = { normal: 'gauge', pullup: 'magnet', touch: 'fingerprint' };
const MODE_TITLE = { normal: '一般（類比）', pullup: '上拉', touch: '觸控' };

const WAVE_RGB = [
    [34, 211, 238],
    [99, 102, 241],
    [251, 191, 36],
    [52, 211, 153],
    [244, 114, 182],
    [16, 185, 129],
    [59, 130, 246],
    [168, 85, 247],
    [249, 115, 22]
];

const AUTO_RANGE_WINDOW = 80;
const AUTO_RANGE_MIN_SPAN = 140;
const RAW_OVERLAY_ALPHA = 80;
const CHART_RANGE_US = 5_000_000;
const VREF = 3.3;

let rootEl = null;
let omniP5 = null;
let styleTag = null;

let waveAutoScale = false;
let waveAutoLo = 0;
let waveAutoHi = 4095;
let showRawOverlay = false;
let sidebarCollapsed = false;
let landscapeScopeMode = false;

const rawPacketHistory = [];
const crosshair = { active: false, x: 0, y: 0 };
let canvasHostEl = null;
let canvasPointerMove = null;
let canvasPointerLeave = null;

let prevTsUs = null;
let droppedPackets = 0;
let totalPacketsForQuality = 0;
let smoothHz = 0;

let dataListener = null;

function isLightTheme() {
    return document.body.classList.contains('theme-light');
}

function isMobileLikeViewport() {
    const coarse = window.matchMedia?.('(pointer: coarse)')?.matches;
    const narrow = window.innerWidth <= 900;
    return Boolean(coarse || narrow);
}

function injectDashboardStyles() {
    if (styleTag) return;
    styleTag = document.createElement('style');
    styleTag.textContent = `
      .dash-float-pulse{animation:dashPulse 1.5s ease-in-out infinite;}
      @keyframes dashPulse{
        0%{box-shadow:0 0 0 0 rgba(251,191,36,.00)}
        50%{box-shadow:0 0 0 2px rgba(251,191,36,.30),0 0 18px rgba(251,191,36,.14)}
        100%{box-shadow:0 0 0 0 rgba(251,191,36,.00)}
      }
      .dash-landscape-scope #dashboardSidebar{display:none!important;}
      .dash-landscape-scope #dashboardCardsWrap{display:none!important;}
      .dash-landscape-scope #canvasParent{aspect-ratio:16/7!important;min-height:66vh;}
      @media (max-width:768px){
        #toolbarActions.dash-toolbar{
          display:grid;
          grid-template-columns:repeat(3,minmax(0,1fr));
          gap:8px;
          width:100%;
          overflow-x:visible;
        }
        #sidebarToggleBtn{grid-column:1;grid-row:1;}
        #waveAutoBtn{grid-column:2;grid-row:1;}
        #rawOverlayBtn{grid-column:3;grid-row:1;}
        #clearBtn{grid-column:1;grid-row:2;}
        #exportBtn{grid-column:2 / span 2;grid-row:2;}
        #toolbarActions.dash-toolbar .dash-tool-btn{min-height:32px;padding:0.35rem 0.5rem;font-size:9px;}
        #canvasParent.dash-chart-host.canvas-container{
          aspect-ratio:unset!important;
          height:clamp(168px,38vh,300px)!important;
          min-height:156px;
          max-height:42vh;
        }
        #canvasParent.dash-chart-host.canvas-container canvas{
          width:100%!important;height:100%!important;display:block;
        }
        #dashboardCardsWrap .dash-data-card{padding:0.45rem 0.5rem!important;}
      }
      @media (max-width:768px){
        .dash-landscape-scope #canvasParent.dash-chart-host.canvas-container{
          height:auto!important;
          max-height:none!important;
          min-height:55vh!important;
          aspect-ratio:16/7!important;
        }
      }
    `;
    document.head.appendChild(styleTag);
}

function createKalman1D(processNoise, measNoise) {
    let x = null;
    let P = 1;
    const Q = processNoise;
    const R = measNoise;
    return function (z) {
        if (x === null) x = z;
        P += Q;
        const K = P / (P + R);
        x += K * (z - x);
        P *= 1 - K;
        return Math.round(x);
    };
}

function createMovingAverage(windowSize) {
    const buf = [];
    return function (z) {
        buf.push(z);
        if (buf.length > windowSize) buf.shift();
        let s = 0;
        for (let i = 0; i < buf.length; i++) s += buf[i];
        return Math.round(s / buf.length);
    };
}

function rebuildChannelFilters() {
    const mode = document.getElementById('filterSelect')?.value || 'kalman';
    omni.channelFilters = PINS_CONFIG.map((p) => {
        if (p.type === 'digital') return (z) => z;
        if (mode === 'none') return (z) => z;
        if (mode === 'ma') return createMovingAverage(MA_WINDOW);
        return createKalman1D(4, 64);
    });
}

function gpioNum(logicalId) {
    return PINS_CONFIG[logicalId].gpio;
}

function markDirty() {
    const si = document.getElementById('syncIndicator');
    if (si) si.innerText = '⚠️ 設定已變更，請按「應用配置」';
}

function getAnalogModeKey(id) {
    if (omni.channelMode[id] === 'touch') return 'touch';
    if ((omni.pullupMask >> id) & 1) return 'pullup';
    return 'normal';
}

function setModeButtonIcon(modeBtn, id) {
    if (!modeBtn) return;
    const key = getAnalogModeKey(id);
    modeBtn.innerHTML = `<i data-lucide="${MODE_ICON[key]}" class="w-[14px] h-[14px]"></i>`;
    modeBtn.title = MODE_TITLE[key];
    if (window.lucide) window.lucide.createIcons();
}

function getWaveColorCss(id, alpha = 1) {
    const [r, g, b] = WAVE_RGB[id];
    return `rgba(${r},${g},${b},${alpha})`;
}

function updateCardColorStyle(id) {
    const card = document.getElementById(`card-${id}`);
    const title = document.getElementById(`card-title-${id}`);
    if (!card || !title) return;
    const borderColor = getWaveColorCss(id, 0.48);
    const titleColor = getWaveColorCss(id, 0.9);
    card.style.borderColor = borderColor;
    title.style.color = titleColor;
}

function updateCardTitles() {
    for (let id = 0; id < 9; id++) {
        const t = document.getElementById(`card-title-${id}`);
        const u = document.getElementById(`card-unit-${id}`);
        if (!t || !u) continue;
        const g = gpioNum(id);
        if (DIGITAL_IDS.includes(id)) {
            t.textContent = `GPIO ${g} · 數位`;
            u.textContent = '0／4095';
        } else if (omni.channelMode[id] === 'touch') {
            t.textContent = `GPIO ${g} · 觸控`;
            u.textContent = '積分 0–4095';
        } else {
            t.textContent = `GPIO ${g} · 類比`;
            u.textContent = (omni.pullupMask >> id) & 1 ? '12-bit（上拉）' : '12-bit';
        }
        updateCardColorStyle(id);
    }
}

function updateWaveTitle() {
    const el = document.getElementById('waveSectionTitle');
    if (el) el.textContent = '即時感測波形';
}

function buildCsvText() {
    const gpioHeader = PINS_CONFIG.map((p) => `GPIO${p.gpio}`);
    const header = ['timestamp_us', ...gpioHeader];
    const lines = [header.join(',')];
    for (let r = 0; r < omni.packetHistory.length; r++) {
        const pkt = omni.packetHistory[r];
        const row = [pkt.tsUs];
        for (let i = 0; i < 9; i++) row.push(pkt.values[i] != null ? pkt.values[i] : '');
        lines.push(row.join(','));
    }
    return '\ufeff' + lines.join('\n');
}

async function exportCsv(ev) {
    if (ev) ev.preventDefault();
    if (omni.packetHistory.length === 0) {
        alert('尚無資料可匯出，請先連線並接收資料。');
        return;
    }
    const csv = buildCsvText();
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const baseName = `OmniSense_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;
    const file = new File([blob], baseName, { type: 'text/csv' });
    const si = document.getElementById('syncIndicator');

    try {
        if (window.showSaveFilePicker) {
            const handle = await window.showSaveFilePicker({
                suggestedName: baseName,
                types: [{ description: 'CSV', accept: { 'text/csv': ['.csv'] } }]
            });
            const writable = await handle.createWritable();
            await writable.write(blob);
            await writable.close();
            if (si) si.innerText = '已儲存 CSV';
            return;
        }
    } catch (e) {
        if (e?.name === 'AbortError') return;
    }

    try {
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
            await navigator.share({ files: [file], title: 'OmniSense Lab CSV', text: '匯出感測資料' });
            if (si) si.innerText = '已開啟系統分享';
            return;
        }
    } catch (e) {
        if (e?.name === 'AbortError') return;
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = baseName;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    requestAnimationFrame(() => {
        URL.revokeObjectURL(url);
        a.remove();
    });
    if (si) si.innerText = '已觸發下載';
}

function clearWaveform(ev) {
    if (ev) ev.preventDefault();
    clearBleQueue();
    omni.packetHistory.length = 0;
    rawPacketHistory.length = 0;
    resetFloatingBuffers();
    rebuildChannelFilters();
    prevTsUs = null;
    droppedPackets = 0;
    totalPacketsForQuality = 0;
    smoothHz = 0;
    updateConnectionDiagnostics();
    const el = document.getElementById('syncIndicator');
    if (el) el.innerText = '已清除波形緩衝';
}

async function apply() {
    if (!ble.getRxChar()) return;
    const btn = document.getElementById('applyBtn');
    const originalText = btn?.innerText || '應用配置';
    const originalClass = btn?.className || '';

    const f = parseInt(document.getElementById('freqRange').value, 10);
    const r = parseInt(document.getElementById('resSelect').value, 10);
    const am = omni.activeMask & 0x01ff;
    const pu = ((omni.pullupMask & 0x01ff) | DIGITAL_PULL_BITS) & 0x01ff;
    omni.pullupMask = pu;
    const tm = computeTouchModeMask();
    await applyDeviceConfig({ freq: f, res: r, activeMask: am, pullupMask: pu, touchMask: tm });
    omni.lastFreq = f;
    omni.lastRes = r;

    const si = document.getElementById('syncIndicator');
    if (si) si.innerText = '⚡ 同步完成';
    updateWaveTitle();

    if (btn) {
        btn.innerText = '✓ 已同步';
        btn.className = btn.className
            .replace('from-cyan-600', 'from-emerald-600')
            .replace('to-blue-600', 'to-emerald-500')
            .replace('hover:from-cyan-500', 'hover:from-emerald-500')
            .replace('hover:to-blue-500', 'hover:to-emerald-400');
        window.setTimeout(() => {
            if (!btn) return;
            btn.innerText = originalText;
            btn.className = originalClass;
        }, 1200);
    }
}

function syncPinButtonStyle(id, active) {
    const btn = document.getElementById(`btn-${id}`);
    if (!btn) return;
    const isDig = DIGITAL_IDS.includes(id);
    const colorClass = isDig
        ? 'bg-emerald-600 border-emerald-500 text-white shadow-md shadow-emerald-900/20'
        : id === G2_ID
          ? 'bg-amber-500 border-amber-400 text-white shadow-md shadow-amber-900/20'
          : 'bg-cyan-500 border-cyan-400 text-white shadow-md shadow-cyan-900/20';
    btn.className = `pin-btn min-h-[34px] w-full min-w-0 px-2 rounded-md border text-[10px] font-mono font-bold tabular-nums transition-transform active:scale-[0.98] ${
        active ? colorClass : 'border-slate-600 text-slate-500 bg-slate-800/60'
    }`;
}

function updateCardVisibility(id) {
    const card = document.getElementById(`card-${id}`);
    if (!card) return;
    const active = (omni.activeMask >> id) & 1;
    card.classList.toggle('hidden', !active);
}

function syncPinUiFromState() {
    for (let id = 0; id < 9; id++) {
        const active = (omni.activeMask >> id) & 1;
        syncPinButtonStyle(id, active);
        updateCardVisibility(id);
        if (ANALOG_MODE_IDS.includes(id)) setModeButtonIcon(document.getElementById(`mode-${id}`), id);
    }
}

function togglePin(id) {
    omni.activeMask ^= 1 << id;
    omni.activeMask &= 0x01ff;
    if (DIGITAL_IDS.includes(id)) omni.channelMode[id] = 'dig';
    const active = (omni.activeMask >> id) & 1;
    syncPinButtonStyle(id, active);
    updateCardVisibility(id);
    markDirty();
}

function cycleAnalogMode(id) {
    if (id === G2_ID) {
        // G2 only supports normal/pullup for this dashboard UX.
        if ((omni.pullupMask >> id) & 1) {
            omni.channelMode[id] = 'adc';
            omni.pullupMask &= ~(1 << id);
        } else {
            omni.channelMode[id] = 'adc';
            omni.pullupMask |= 1 << id;
        }
        omni.pullupMask &= 0x01ff;
        omni.pullupMask |= DIGITAL_PULL_BITS;
        setModeButtonIcon(document.getElementById(`mode-${id}`), id);
        updateCardTitles();
        updateWaveTitle();
        markDirty();
        return;
    }
    const key = getAnalogModeKey(id);
    if (key === 'normal') {
        omni.channelMode[id] = 'adc';
        omni.pullupMask |= 1 << id;
    } else if (key === 'pullup') {
        omni.channelMode[id] = 'touch';
        omni.pullupMask |= 1 << id;
    } else {
        omni.channelMode[id] = 'adc';
        omni.pullupMask &= ~(1 << id);
    }
    omni.pullupMask &= 0x01ff;
    omni.pullupMask |= DIGITAL_PULL_BITS;
    setModeButtonIcon(document.getElementById(`mode-${id}`), id);
    updateCardTitles();
    updateWaveTitle();
    markDirty();
}

function loadP5() {
    if (window.p5) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/p5.js/1.4.0/p5.js';
        s.onload = () => resolve();
        s.onerror = () => reject(new Error('p5 load failed'));
        document.head.appendChild(s);
    });
}

function getWaveYRangeManual() {
    const minEl = document.getElementById('waveYMin');
    const maxEl = document.getElementById('waveYMax');
    let lo = minEl ? parseInt(minEl.value, 10) : 0;
    let hi = maxEl ? parseInt(maxEl.value, 10) : 4095;
    if (!Number.isFinite(lo)) lo = 0;
    if (!Number.isFinite(hi)) hi = 4095;
    lo = Math.max(0, Math.min(4094, lo));
    hi = Math.max(1, Math.min(4095, hi));
    if (lo >= hi) {
        lo = Math.max(0, hi - 1);
        if (minEl) minEl.value = String(lo);
    }
    if (hi <= lo) {
        hi = Math.min(4095, lo + 1);
        if (maxEl) maxEl.value = String(hi);
    }
    return { lo, hi };
}

function syncWaveZoomLabels() {
    const { lo, hi } = getWaveYRangeManual();
    const l = document.getElementById('waveYMinLabel');
    const h = document.getElementById('waveYMaxLabel');
    if (l) l.textContent = String(lo);
    if (h) h.textContent = String(hi);
}

function updateWaveZoomUiVisibility() {
    const wrap = document.getElementById('waveZoomManual');
    const btn = document.getElementById('waveAutoBtn');
    if (wrap) wrap.classList.toggle('hidden', waveAutoScale);
    if (btn) {
        btn.setAttribute('aria-pressed', String(waveAutoScale));
        btn.classList.toggle('bg-cyan-700/70', waveAutoScale);
        btn.classList.toggle('hover:bg-cyan-600/80', waveAutoScale);
        btn.classList.toggle('bg-slate-700/60', !waveAutoScale);
        btn.classList.toggle('hover:bg-slate-600/80', !waveAutoScale);
    }
}

function getAutoWaveRange(packetHistory) {
    const start = Math.max(0, packetHistory.length - AUTO_RANGE_WINDOW);
    const vals = [];
    for (let k = start; k < packetHistory.length; k++) {
        const pkt = packetHistory[k];
        for (let i = 0; i < 9; i++) {
            if (!((omni.activeMask >> i) & 1)) continue;
            const v = pkt.values[i];
            if (v == null || !Number.isFinite(v)) continue;
            vals.push(v);
        }
    }
    if (vals.length < 8) return { lo: waveAutoLo, hi: waveAutoHi };
    vals.sort((a, b) => a - b);
    const n = vals.length - 1;
    const qLo = vals[Math.max(0, Math.floor(n * 0.05))];
    const qHi = vals[Math.max(0, Math.floor(n * 0.95))];
    const span = Math.max(1, qHi - qLo);
    const pad = Math.max(40, span * 0.18);
    let targetLo = Math.max(0, qLo - pad);
    let targetHi = Math.min(4095, qHi + pad);
    if (targetHi - targetLo < AUTO_RANGE_MIN_SPAN) {
        const mid = (targetLo + targetHi) * 0.5;
        targetLo = Math.max(0, mid - AUTO_RANGE_MIN_SPAN * 0.5);
        targetHi = Math.min(4095, mid + AUTO_RANGE_MIN_SPAN * 0.5);
    }
    const loAlpha = targetLo < waveAutoLo ? 0.28 : 0.08;
    const hiAlpha = targetHi > waveAutoHi ? 0.28 : 0.08;
    waveAutoLo += (targetLo - waveAutoLo) * loAlpha;
    waveAutoHi += (targetHi - waveAutoHi) * hiAlpha;
    if (waveAutoHi - waveAutoLo < 1) waveAutoHi = waveAutoLo + 1;
    return { lo: waveAutoLo, hi: waveAutoHi };
}

function getCurrentWaveRange(packetHistory) {
    if (waveAutoScale) return getAutoWaveRange(packetHistory);
    return getWaveYRangeManual();
}

function wireWaveZoomControls() {
    const minEl = document.getElementById('waveYMin');
    const maxEl = document.getElementById('waveYMax');
    const onChange = (which) => {
        if (which === 'min' && minEl && maxEl) {
            const lo = parseInt(minEl.value, 10);
            const hi = parseInt(maxEl.value, 10);
            if (lo >= hi) maxEl.value = String(Math.min(4095, lo + 1));
        } else if (which === 'max' && minEl && maxEl) {
            const lo = parseInt(minEl.value, 10);
            const hi = parseInt(maxEl.value, 10);
            if (hi <= lo) minEl.value = String(Math.max(0, hi - 1));
        }
        syncWaveZoomLabels();
        omniP5?.redraw();
    };
    minEl?.addEventListener('input', () => onChange('min'));
    maxEl?.addEventListener('input', () => onChange('max'));
    document.getElementById('waveAutoBtn')?.addEventListener('click', () => {
        waveAutoScale = !waveAutoScale;
        updateWaveZoomUiVisibility();
        omniP5?.redraw();
    });
    document.getElementById('waveZoomResetBtn')?.addEventListener('click', () => {
        if (minEl) minEl.value = '0';
        if (maxEl) maxEl.value = '4095';
        waveAutoLo = 0;
        waveAutoHi = 4095;
        syncWaveZoomLabels();
        omniP5?.redraw();
    });
    document.getElementById('rawOverlayBtn')?.addEventListener('click', () => {
        showRawOverlay = !showRawOverlay;
        const btn = document.getElementById('rawOverlayBtn');
        if (btn) {
            btn.setAttribute('aria-pressed', String(showRawOverlay));
            btn.classList.toggle('bg-cyan-700/70', showRawOverlay);
            btn.classList.toggle('hover:bg-cyan-600/80', showRawOverlay);
            btn.classList.toggle('bg-slate-700/60', !showRawOverlay);
            btn.classList.toggle('hover:bg-slate-600/80', !showRawOverlay);
        }
        omniP5?.redraw();
    });
    syncWaveZoomLabels();
    updateWaveZoomUiVisibility();
    if (window.lucide) window.lucide.createIcons();
}

function toVoltage(v) {
    return (v / 4095) * VREF;
}

function formatTimeFromRight(usOffset) {
    return `${(usOffset / 1_000_000).toFixed(1)}s`;
}

function drawAxesAndGrid(p, chart) {
    const { left, right, top, bottom, yLo, yHi } = chart;
    const light = isLightTheme();
    const axisStroke = light ? [148, 163, 184] : [51, 65, 85];
    const labelMain = light ? [71, 85, 105] : [148, 163, 184];
    const labelMinor = light ? [100, 116, 139] : [100, 116, 139];
    p.stroke(...axisStroke);
    p.strokeWeight(1);
    p.line(left, top, left, bottom);
    p.line(right, top, right, bottom);
    p.line(left, bottom, right, bottom);

    p.fill(...labelMain);
    p.noStroke();
    p.textSize(9);
    p.textAlign(p.LEFT, p.CENTER);
    p.text(`${Math.round(yHi)}`, left + 2, top + 8);
    p.text(`${Math.round(yLo)}`, left + 2, bottom - 8);
    p.textAlign(p.RIGHT, p.CENTER);
    p.text(`${toVoltage(yHi).toFixed(2)}V`, right - 2, top + 8);
    p.text(`${toVoltage(yLo).toFixed(2)}V`, right - 2, bottom - 8);

    p.textAlign(p.CENTER, p.TOP);
    for (let i = 0; i <= 5; i++) {
        const x = p.map(i, 0, 5, left, right);
        p.stroke(...axisStroke, light ? 100 : 120);
        p.line(x, top, x, bottom);
        p.noStroke();
        const sec = -5 + i;
        p.fill(...labelMinor);
        p.text(`${sec}s`, x, bottom + 3);
    }
}

function mapTsToX(ts, endTs, left, right) {
    const dt = CHART_RANGE_US - u32Delta(endTs >>> 0, ts >>> 0);
    return left + (dt / CHART_RANGE_US) * (right - left);
}

function wireCanvasPointer() {
    const c = canvasHostEl;
    if (!c) return;
    canvasPointerMove = (ev) => {
        const rect = c.getBoundingClientRect();
        const px = ev.clientX ?? ev.touches?.[0]?.clientX;
        const py = ev.clientY ?? ev.touches?.[0]?.clientY;
        if (px == null || py == null) return;
        crosshair.active = true;
        crosshair.x = px - rect.left;
        crosshair.y = py - rect.top;
        omniP5?.redraw();
    };
    canvasPointerLeave = () => {
        crosshair.active = false;
        omniP5?.redraw();
    };
    c.addEventListener('pointermove', canvasPointerMove);
    c.addEventListener('pointerleave', canvasPointerLeave);
    c.addEventListener('touchmove', canvasPointerMove, { passive: true });
    c.addEventListener('touchend', canvasPointerLeave, { passive: true });
}

function unwireCanvasPointer() {
    const c = canvasHostEl;
    if (!c) return;
    if (canvasPointerMove) {
        c.removeEventListener('pointermove', canvasPointerMove);
        c.removeEventListener('touchmove', canvasPointerMove);
    }
    if (canvasPointerLeave) {
        c.removeEventListener('pointerleave', canvasPointerLeave);
        c.removeEventListener('touchend', canvasPointerLeave);
    }
    canvasPointerMove = null;
    canvasPointerLeave = null;
}

function drawCrosshair(p, chart, packetHistory) {
    if (!crosshair.active || packetHistory.length < 2) return;
    const { left, right, top, bottom, yLo, yHi } = chart;
    const cx = Math.max(left, Math.min(right, crosshair.x));
    const cy = Math.max(top, Math.min(bottom, crosshair.y));
    const endTs = packetHistory[packetHistory.length - 1].tsUs >>> 0;

    const light = isLightTheme();
    p.stroke(light ? 100 : 148, light ? 116 : 163, light ? 139 : 184, 160);
    p.strokeWeight(1);
    p.line(cx, top, cx, bottom);
    p.line(left, cy, right, cy);

    const tNorm = (cx - left) / Math.max(right - left, 1);
    const targetTsOffset = (1 - tNorm) * CHART_RANGE_US;
    const targetTs = (endTs - targetTsOffset) >>> 0;
    let nearest = packetHistory[packetHistory.length - 1];
    let best = Number.POSITIVE_INFINITY;
    for (let i = packetHistory.length - 1; i >= 0; i--) {
        const pkt = packetHistory[i];
        const d = Math.abs(u32Delta(pkt.tsUs >>> 0, targetTs));
        if (d < best) {
            best = d;
            nearest = pkt;
        }
    }

    let sample = null;
    for (let i = 0; i < 9; i++) {
        if (!((omni.activeMask >> i) & 1)) continue;
        if (nearest.values[i] != null) {
            sample = { id: i, v: nearest.values[i] };
            break;
        }
    }
    if (!sample) return;
    const rel = -u32Delta(endTs, nearest.tsUs >>> 0);
    const txt = `時間 ${formatTimeFromRight(rel)}  數值 ${sample.v}  電壓 ${toVoltage(sample.v).toFixed(2)}V`;
    const tw = p.textWidth(txt) + 10;
    const th = 18;
    const tx = Math.min(right - tw - 2, Math.max(left + 2, cx + 8));
    const ty = Math.max(top + 2, cy - th - 6);
    p.noStroke();
    if (light) p.fill(255, 255, 255, 228);
    else p.fill(15, 23, 42, 225);
    p.rect(tx, ty, tw, th, 4);
    if (light) p.fill(15, 23, 42);
    else p.fill(226, 232, 240);
    p.textSize(9);
    p.textAlign(p.LEFT, p.TOP);
    p.text(txt, tx + 5, ty + 4);

    const sampleY = p.map(sample.v, yLo, yHi, bottom, top);
    p.noStroke();
    p.fill(...WAVE_RGB[sample.id], 220);
    p.circle(cx, sampleY, 6);
}

function wireP5() {
    const packetHistory = omni.packetHistory;
    omniP5 = new window.p5((p) => {
        p.setup = () => {
            const par = document.getElementById('canvasParent');
            if (!par) return;
            p.createCanvas(par.offsetWidth, par.offsetHeight).parent(par);
            p.noLoop();
        };
        p.draw = () => {
            if (isLightTheme()) p.background(248, 250, 252);
            else p.background(10, 15, 30);
            if (packetHistory.length < 2) return;
            const { lo: yLo, hi: yHi } = getCurrentWaveRange(packetHistory);
            const endTs = packetHistory[packetHistory.length - 1].tsUs >>> 0;
            const chart = {
                left: 42,
                right: p.width - 44,
                top: 10,
                bottom: p.height - 24,
                yLo,
                yHi
            };
            drawAxesAndGrid(p, chart);

            for (let i = 0; i < 9; i++) {
                if (!((omni.activeMask >> i) & 1)) continue;
                const [cr, cg, cb] = WAVE_RGB[i];

                if (showRawOverlay) {
                    p.stroke(cr, cg, cb, RAW_OVERLAY_ALPHA);
                    p.strokeWeight(1);
                    p.noFill();
                    p.beginShape();
                    for (let k = 0; k < rawPacketHistory.length; k++) {
                        const pkt = rawPacketHistory[k];
                        if (pkt.values[i] == null) continue;
                        const x = mapTsToX(pkt.tsUs, endTs, chart.left, chart.right);
                        const y = p.map(pkt.values[i], yLo, yHi, chart.bottom, chart.top);
                        p.vertex(x, y);
                    }
                    p.endShape();
                }

                p.stroke(cr, cg, cb);
                p.strokeWeight(2);
                p.noFill();
                p.beginShape();
                for (let k = 0; k < packetHistory.length; k++) {
                    const pkt = packetHistory[k];
                    if (pkt.values[i] == null) continue;
                    const x = mapTsToX(pkt.tsUs, endTs, chart.left, chart.right);
                    const y = p.map(pkt.values[i], yLo, yHi, chart.bottom, chart.top);
                    p.vertex(x, y);
                }
                p.endShape();
            }

            drawCrosshair(p, chart, packetHistory);
        };
    });
}

function updateConnectionDiagnostics() {
    const freqEl = document.getElementById('actualFreqLabel');
    const qEl = document.getElementById('linkQualityLabel');
    const freqPill = document.getElementById('actualFpsPill');
    const qPill = document.getElementById('connQualityPill');
    const hzText = `實測頻率：${smoothHz > 0 ? smoothHz.toFixed(1) : '--'} Hz`;
    let qualityText = '連線品質：--';
    if (freqEl) freqEl.innerText = `實測頻率：${smoothHz > 0 ? smoothHz.toFixed(1) : '--'} Hz`;
    if (qEl) {
        const loss = totalPacketsForQuality > 0 ? droppedPackets / totalPacketsForQuality : 0;
        let label = '優';
        if (loss > 0.08) label = '差';
        else if (loss > 0.03) label = '中';
        qualityText = `連線品質：${label}${totalPacketsForQuality > 0 ? `（遺失 ${(loss * 100).toFixed(1)}%）` : ''}`;
        qEl.innerText = qualityText;
    }
    if (freqPill) freqPill.innerText = hzText;
    if (qPill) qPill.innerText = qualityText;
}

function updateSidebarLayout() {
    const sidebar = document.getElementById('dashboardSidebar');
    const cardsWrap = document.getElementById('dashboardCardsWrap') || document.getElementById('dataCards');
    if (sidebar) sidebar.classList.toggle('hidden', sidebarCollapsed && !landscapeScopeMode);
    if (cardsWrap) cardsWrap.classList.toggle('hidden', landscapeScopeMode);
}

function resizeDashboardCanvas() {
    const par = document.getElementById('canvasParent');
    if (!par || !omniP5) return;
    const w = Math.max(1, par.offsetWidth);
    const h = Math.max(1, par.offsetHeight);
    omniP5.resizeCanvas(w, h);
}

function evaluateLandscapeScopeMode() {
    landscapeScopeMode =
        isMobileLikeViewport() &&
        window.matchMedia('(orientation: landscape)').matches &&
        window.innerHeight <= 560;
    const root = document.getElementById('dashboardRoot');
    if (root) root.classList.toggle('dash-landscape-scope', landscapeScopeMode);
    updateSidebarLayout();
    resizeDashboardCanvas();
    omniP5?.redraw();
}

function attachDataListener() {
    if (dataListener) return;
    dataListener = (ev) => {
        if (omni.currentViewId !== 'dashboard') return;
        const ch = ev.detail.channels;

        const rawRow = { tsUs: ev.detail.tsUs, values: Array(9).fill(null) };
        for (let i = 0; i < 9; i++) {
            if (ch[i]) rawRow.values[i] = ch[i].raw;
        }
        rawPacketHistory.push(rawRow);
        if (rawPacketHistory.length > 200) rawPacketHistory.shift();

        if (prevTsUs != null) {
            const dt = u32Delta(ev.detail.tsUs >>> 0, prevTsUs >>> 0);
            if (dt > 0) {
                const hz = 1_000_000 / dt;
                smoothHz = smoothHz <= 0 ? hz : smoothHz * 0.84 + hz * 0.16;
            }
            const expected = 1_000_000 / Math.max(1, omni.lastFreq || 50);
            const missing = Math.max(0, Math.round(dt / expected) - 1);
            droppedPackets += missing;
            totalPacketsForQuality += 1 + missing;
        }
        prevTsUs = ev.detail.tsUs;
        updateConnectionDiagnostics();

        const lowFps = omni.measuredFps < 30;
        omni.domFrame++;
        for (let i = 0; i < 9; i++) {
            if (!ch[i]) continue;
            if (lowFps && ((omni.domFrame + i) & 1)) continue;
            const card = document.getElementById(`card-${i}`);
            if (card?.classList.contains('hidden')) continue;

            const el = document.getElementById(`val-${i}`);
            if (el) el.innerText = ch[i].filtered;

            const hint = document.getElementById(`float-hint-${i}`);
            if (!hint) continue;
            if (omni.channelMode[i] === 'touch') {
                hint.classList.remove('hidden');
                hint.innerText = '觸控';
                hint.className = 'text-[8px] text-cyan-400/90 mt-0.5 min-h-[1rem] text-center md:text-left';
                card?.classList.remove('dash-float-pulse');
            } else if (FLOATING_ADC_IDS.has(i) && ch[i].floating) {
                hint.classList.remove('hidden');
                hint.innerText = '可能懸空';
                hint.className = 'text-[8px] text-amber-400/90 mt-0.5 min-h-[1rem] text-center md:text-left';
                card?.classList.add('dash-float-pulse');
            } else {
                hint.classList.add('hidden');
                card?.classList.remove('dash-float-pulse');
            }
        }
    };
    window.addEventListener('omnisense:data', dataListener);
}

function detachDataListener() {
    if (!dataListener) return;
    window.removeEventListener('omnisense:data', dataListener);
    dataListener = null;
}

function buildAnalogRow(id) {
    const row = document.createElement('div');
    row.className = 'grid grid-cols-[1fr_2.25rem] items-center gap-1 min-w-0';
    const activeBtn = document.createElement('button');
    activeBtn.type = 'button';
    activeBtn.id = `btn-${id}`;
    activeBtn.textContent = `G${gpioNum(id)}`;
    activeBtn.title = '開啟／關閉';
    activeBtn.onclick = () => togglePin(id);

    const modeBtn = document.createElement('button');
    modeBtn.type = 'button';
    modeBtn.id = `mode-${id}`;
    modeBtn.className =
        'mode-cycle-btn flex items-center justify-center w-9 h-9 rounded-md border border-slate-600/90 bg-slate-900/90 text-slate-100 hover:bg-slate-700/90 active:scale-95 transition-transform shrink-0 shadow-sm';
    modeBtn.onclick = () => cycleAnalogMode(id);
    setModeButtonIcon(modeBtn, id);

    row.appendChild(activeBtn);
    row.appendChild(modeBtn);
    return row;
}

function initDashboardUi() {
    injectDashboardStyles();
    omni.pullupMask = (omni.pullupMask & 0x01ff) | DIGITAL_PULL_BITS;
    if (omni.channelMode[G2_ID] === 'touch') omni.channelMode[G2_ID] = 'adc';
    DIGITAL_IDS.forEach((id) => {
        omni.channelMode[id] = 'dig';
    });

    const a4 = document.getElementById('pins-analog-four');
    ANALOG_FOUR_IDS.forEach((id) => a4.appendChild(buildAnalogRow(id)));
    const g2 = document.getElementById('pins-g2');
    g2.appendChild(buildAnalogRow(G2_ID));

    const dig = document.getElementById('pins-digital');
    DIGITAL_IDS.forEach((id) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.id = `btn-${id}`;
        b.textContent = `G${gpioNum(id)}`;
        b.title = '開啟／關閉（數位）';
        b.className =
            'pin-btn min-h-[34px] rounded-md border border-slate-600/90 text-[10px] font-mono font-bold tabular-nums px-1 active:scale-[0.98] transition-transform shadow-sm';
        b.onclick = () => togglePin(id);
        dig.appendChild(b);
    });

    const cards = document.getElementById('dashboardCardsWrap') || document.getElementById('dataCards');
    if (!cards) {
        throw new Error('找不到資料卡容器（dashboardCardsWrap/dataCards）');
    }
    for (let id = 0; id < 9; id++) {
        const c = document.createElement('div');
        c.id = `card-${id}`;
        c.className =
            'dash-data-card glass-card p-2 sm:p-3 md:p-4 rounded-lg sm:rounded-xl md:rounded-2xl transition-all border border-slate-700/50 text-center md:text-left';
        c.innerHTML = `<p id="card-title-${id}" class="text-[9px] font-black uppercase">GPIO ${gpioNum(id)}</p><p id="val-${id}" class="text-lg sm:text-xl md:text-2xl font-mono font-bold text-slate-100 tabular-nums">---</p><p id="card-unit-${id}" class="text-[8px] text-slate-600 mt-0.5">—</p><p id="float-hint-${id}" class="text-[8px] text-amber-400/90 mt-0.5 min-h-[1rem] hidden text-center md:text-left"></p>`;
        cards.appendChild(c);
    }

    syncPinUiFromState();
    updateCardTitles();
    updateWaveTitle();
    if (window.lucide) window.lucide.createIcons();
    rebuildChannelFilters();
    document.getElementById('filterSelect').onchange = () => {
        rebuildChannelFilters();
        const si = document.getElementById('syncIndicator');
        if (si) si.innerText = '已切換濾波';
    };
    document.getElementById('applyBtn').addEventListener('click', apply, { passive: false });
    document.getElementById('clearBtn').addEventListener('click', clearWaveform, { passive: false });
    document.getElementById('exportBtn').addEventListener('click', exportCsv, { passive: false });
    document.getElementById('sidebarToggleBtn')?.addEventListener('click', () => {
        sidebarCollapsed = !sidebarCollapsed;
        updateSidebarLayout();
    });
    document.getElementById('freqRange').addEventListener('input', (e) => {
        document.getElementById('freqLabel').innerText = e.target.value;
    });
    wireWaveZoomControls();
    evaluateLandscapeScopeMode();
    window.addEventListener('resize', evaluateLandscapeScopeMode);
    updateConnectionDiagnostics();
}

function onFrameAfterProcess() {
    if (omni.currentViewId !== 'dashboard') return;
    omniP5?.redraw();
}

export async function mount(root) {
    rootEl = root;
    omni.currentViewId = 'dashboard';
    const htmlUrl = new URL('./ui.html', import.meta.url);
    const r = await fetch(htmlUrl);
    root.innerHTML = await r.text();
    try {
        initDashboardUi();
        await loadP5();
        wireP5();
        requestAnimationFrame(() => {
            resizeDashboardCanvas();
            omniP5?.redraw();
        });
        canvasHostEl = document.getElementById('canvasParent');
        wireCanvasPointer();
        attachDataListener();
        setAfterProcessCallback(onFrameAfterProcess);
    } catch (err) {
        console.error('Dashboard mount failed:', err);
        root.innerHTML = `<div class="glass-card rounded-xl border border-rose-500/40 bg-rose-950/20 p-4 text-sm text-rose-200">主控台載入失敗，請重新整理頁面。<br><span class="text-rose-300/90">${String(err?.message || err)}</span></div>`;
    }
}

export async function onConnected() {
    rebuildChannelFilters();
    resetFloatingBuffers();
    await apply();
}

export async function unmount() {
    detachDataListener();
    setAfterProcessCallback(null);
    window.removeEventListener('resize', evaluateLandscapeScopeMode);
    unwireCanvasPointer();
    canvasHostEl = null;
    if (omniP5) {
        omniP5.remove();
        omniP5 = null;
    }
    rawPacketHistory.length = 0;
    if (rootEl) {
        rootEl.innerHTML = '';
        rootEl = null;
    }
}
