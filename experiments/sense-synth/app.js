/**
 * Omni Mixer cartridge (Web Audio + p5 scope).
 * UI language is Traditional Chinese by requirement.
 */

import { omni } from '../../web/core/state.js';
import { applyDeviceConfig } from '../../web/core/configApply.js';
import { computeTouchModeMask } from '../../web/core/touchMask.js';
import * as ble from '../../web/core/ble.js';

const CHANS = [0, 1, 2, 3, 4];
const ADC_MAX = 4095;
const NOISE_GATE_DELTA = 10;
const ADSR_SEC = 0.05;
/** 僅邏輯通道 2（G2 / GPIO2）啟用 */
const PRESET_ACTIVE = 0x04;
const PRESET_PULLUP = 0;
const PRESET_MODES = ['adc', 'adc', 'adc', 'adc', 'adc', 'dig', 'dig', 'dig', 'dig'];

const COLOR_RGB = [
    [34, 211, 238],
    [99, 102, 241],
    [251, 191, 36],
    [52, 211, 153],
    [244, 114, 182]
];

const STYLE_PRESETS = {
    elegant: { mode: 'continuous', min: 220, max: 660, osc: 'sine' },
    magical: { mode: 'continuous', min: 880, max: 3500, osc: 'triangle' },
    /** 類比有變化時觸發離散音階；預設 */
    piano: { mode: 'piano', osc: 'triangle' }
};

const PIANO_MIDI_MIN = 48;
const PIANO_MIDI_MAX = 83;
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

let rootEl = null;
let styleLink = null;
let dataHandler = null;
let vizP5 = null;

let audioCtx = null;
let masterGain = null;
/** @type {{ osc: OscillatorNode, gain: GainNode }[]} */
let voices = [];

/** 預設僅 G2 開啟，其餘關閉 */
const channelOn = [false, false, true, false, false];
/** @type {(number | null)[]} 首次讀值只建立基準、不發聲 */
const lastAdc = [null, null, null, null, null];
const currentFreq = [220, 220, 220, 220, 220];
/** 拾音器視覺：能量與相位 */
const pickupLevel = [0, 0, 0, 0, 0];
const pickupPhase = [0, 0, 0, 0, 0];
let isAudioReady = false;
let volumeValue = 0.42;

function injectCss() {
    if (styleLink) return;
    styleLink = document.createElement('link');
    styleLink.rel = 'stylesheet';
    styleLink.href = new URL('./style.css', import.meta.url).href;
    document.head.appendChild(styleLink);
}

function loadP5() {
    if (window.p5) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/p5.js/1.4.0/p5.js';
        s.onload = () => resolve();
        s.onerror = () => reject(new Error('p5'));
        document.head.appendChild(s);
    });
}

function getStyleMode() {
    return rootEl?.querySelector('#omx-style')?.value || 'piano';
}

function getFreqRange() {
    const mode = getStyleMode();
    if (mode === 'custom') {
        const minV = Number(rootEl?.querySelector('#omx-fmin')?.value);
        const maxV = Number(rootEl?.querySelector('#omx-fmax')?.value);
        const min = Number.isFinite(minV) ? Math.max(20, minV) : 220;
        const max = Number.isFinite(maxV) ? Math.max(min + 1, maxV) : 1200;
        return { mode: 'continuous', min, max, osc: 'sine' };
    }
    return STYLE_PRESETS[mode] || STYLE_PRESETS.piano;
}

function mapAdcToFreq(adc, min, max) {
    const x = Math.max(0, Math.min(ADC_MAX, adc)) / ADC_MAX;
    return min + x * (max - min);
}

function adcToMidi(adc) {
    const x = Math.max(0, Math.min(ADC_MAX, adc)) / ADC_MAX;
    return Math.round(PIANO_MIDI_MIN + x * (PIANO_MIDI_MAX - PIANO_MIDI_MIN));
}

function midiToHz(m) {
    return 440 * Math.pow(2, (m - 69) / 12);
}

function midiToNoteName(midi) {
    const m = Math.max(0, Math.min(127, Math.round(midi)));
    const oct = Math.floor(m / 12) - 1;
    return `${NOTE_NAMES[m % 12]}${oct}`;
}

function refreshCustomInputs() {
    const wrap = rootEl?.querySelector('#omx-custom-wrap');
    const isCustom = getStyleMode() === 'custom';
    if (wrap) wrap.classList.toggle('hidden', !isCustom);
}

function refreshHzLabels() {
    const mode = getStyleMode();
    const piano = mode === 'piano';
    for (let i = 0; i < CHANS.length; i++) {
        const el = rootEl?.querySelector(`#omx-hz-${i}`);
        if (!el) continue;
        if (!channelOn[i]) {
            el.textContent = '—';
            continue;
        }
        if (piano) {
            const m = 69 + 12 * Math.log2(Math.max(1e-6, currentFreq[i] / 440));
            el.textContent = midiToNoteName(m);
        } else {
            el.textContent = `${Math.round(currentFreq[i])} Hz`;
        }
    }
}

function ensureAudioGraph() {
    if (audioCtx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    audioCtx = new AC();
    masterGain = audioCtx.createGain();
    masterGain.gain.value = 0;
    masterGain.connect(audioCtx.destination);

    const cfg = getFreqRange();
    const baseHz = cfg.mode === 'piano' ? midiToHz(60) : (cfg.min ?? 220);
    for (let i = 0; i < 5; i++) {
        const osc = audioCtx.createOscillator();
        osc.type = cfg.mode === 'piano' ? 'triangle' : cfg.osc;
        osc.frequency.value = baseHz;
        const gain = audioCtx.createGain();
        gain.gain.value = 0;
        osc.connect(gain);
        gain.connect(masterGain);
        osc.start();
        voices.push({ osc, gain });
    }
}

function applyMasterGain() {
    if (!audioCtx || !masterGain) return;
    // hard ceiling to keep summed output <= 1.0
    const gain = Math.max(0, Math.min(1, volumeValue));
    masterGain.gain.setTargetAtTime(gain, audioCtx.currentTime, ADSR_SEC);
}

/** 關閉的通道靜音；開啟的通道音量由 onData（有類比變化時）決定 */
function syncChannelMutes() {
    if (!audioCtx || voices.length !== 5) return;
    const now = audioCtx.currentTime;
    for (let i = 0; i < 5; i++) {
        if (!channelOn[i]) {
            voices[i].gain.gain.cancelScheduledValues(now);
            voices[i].gain.gain.setTargetAtTime(0, now, ADSR_SEC);
        }
    }
}

function applyOscTypeFromStyle() {
    const cfg = getFreqRange();
    const t = cfg.mode === 'piano' ? 'triangle' : cfg.osc;
    for (const v of voices) v.osc.type = t;
}

async function resumeAudio() {
    ensureAudioGraph();
    if (!audioCtx) return;
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    isAudioReady = true;
    rootEl?.querySelector('#omx-enable')?.classList.add('hidden');
    applyMasterGain();
    syncChannelMutes();
}

function onData(ev) {
    if (omni.currentViewId !== 'sense-synth') return;
    const channels = ev.detail.channels;
    const cfg = getFreqRange();
    const isPiano = cfg.mode === 'piano';

    for (let i = 0; i < 5; i++) {
        pickupLevel[i] *= 0.93;
    }

    const activeCount = channelOn.filter(Boolean).length || 1;
    const perVoice = Math.min(1, 1 / activeCount) * 0.9;

    for (let i = 0; i < CHANS.length; i++) {
        if (!channelOn[i]) continue;
        const c = channels[CHANS[i]];
        if (!c) continue;

        const adc = c.filtered;
        if (lastAdc[i] == null) {
            lastAdc[i] = adc;
            continue;
        }

        const delta = Math.abs(adc - lastAdc[i]);
        if (delta < NOISE_GATE_DELTA) {
            if (audioCtx && voices.length === 5 && !isPiano) {
                const now = audioCtx.currentTime;
                voices[i].gain.gain.setTargetAtTime(0, now, 0.04);
            }
            continue;
        }

        lastAdc[i] = adc;
        pickupLevel[i] = Math.min(1, delta / 200);

        if (isPiano) {
            const midi = adcToMidi(adc);
            const hz = midiToHz(midi);
            currentFreq[i] = hz;
            if (audioCtx && voices.length === 5) {
                const now = audioCtx.currentTime;
                voices[i].osc.frequency.cancelScheduledValues(now);
                voices[i].osc.frequency.setValueAtTime(hz, now);
                const g = voices[i].gain;
                g.gain.cancelScheduledValues(now);
                g.gain.setValueAtTime(0, now);
                g.gain.linearRampToValueAtTime(perVoice * 0.88, now + 0.004);
                g.gain.linearRampToValueAtTime(0, now + 0.36);
            }
        } else {
            const f = mapAdcToFreq(adc, cfg.min, cfg.max);
            currentFreq[i] = f;
            if (audioCtx && voices.length === 5) {
                const now = audioCtx.currentTime;
                voices[i].osc.frequency.cancelScheduledValues(now);
                voices[i].osc.frequency.setValueAtTime(voices[i].osc.frequency.value, now);
                voices[i].osc.frequency.linearRampToValueAtTime(f, now + 0.008);
                voices[i].gain.gain.cancelScheduledValues(now);
                voices[i].gain.gain.setTargetAtTime(perVoice, now, 0.025);
            }
        }
    }

    refreshHzLabels();
    pickupPhase.forEach((_, i) => {
        pickupPhase[i] += 0.14 + pickupLevel[i] * 0.35;
    });
    vizP5?.redraw();
}

function mountP5(host) {
    const P = window.p5;
    vizP5 = new P((p) => {
        p.setup = () => {
            p.createCanvas(Math.max(300, host.clientWidth || 320), 260).parent(host);
            p.noLoop();
        };
        p.draw = () => {
            p.background(18, 14, 10);
            const pad = 12;
            const w = p.width - pad * 2;
            const h = p.height - pad * 2;
            p.noStroke();
            p.fill(28, 22, 16);
            p.rect(pad, pad, w, h, 6);

            const colW = w / 5;
            for (let ci = 0; ci < 5; ci++) {
                const cx = pad + colW * ci + colW * 0.5;
                const [r, g, b] = COLOR_RGB[ci];
                const en = pickupLevel[ci];
                p.stroke(r, g, b, 40 + en * 120);
                p.strokeWeight(1);
                p.line(cx - colW * 0.38, pad + 6, cx - colW * 0.38, pad + h - 6);
                p.line(cx + colW * 0.38, pad + 6, cx + colW * 0.38, pad + h - 6);

                const amp = en * (h * 0.38) + 2;
                const wobble = Math.sin(pickupPhase[ci]) * amp * (0.35 + en * 0.65);
                p.strokeWeight(2.4 + en * 2);
                p.stroke(r, g, b, 180 + en * 75);
                p.line(cx + wobble, pad + 10, cx - wobble * 0.85, pad + h - 10);

                p.fill(r, g, b, 25 + en * 90);
                p.noStroke();
                p.ellipse(cx, pad + h * 0.5, 10 + en * 22, 10 + en * 22);
            }

        };
        p.windowResized = () => {
            p.resizeCanvas(Math.max(300, host.clientWidth), 260);
        };
    }, host);
}

function refreshToggleVisual() {
    for (let i = 0; i < 5; i++) {
        const btn = rootEl?.querySelector(`[data-omx-ch="${i}"]`);
        if (!btn) continue;
        const on = channelOn[i];
        btn.classList.toggle('omx-toggle--on', on);
        btn.classList.toggle('omx-toggle--off', !on);
    }
}

function wireUi() {
    rootEl?.querySelector('#omx-side-toggle')?.addEventListener('click', () => {
        const compact = rootEl?.classList.toggle('omx-compact');
        const btn = rootEl?.querySelector('#omx-side-toggle');
        if (btn) btn.textContent = compact ? '展開' : '側邊';
    });

    for (let i = 0; i < 5; i++) {
        rootEl?.querySelector(`[data-omx-ch="${i}"]`)?.addEventListener('click', async () => {
            await resumeAudio();
            channelOn[i] = !channelOn[i];
            if (channelOn[i]) lastAdc[i] = null;
            refreshToggleVisual();
            refreshHzLabels();
            syncChannelMutes();
        });
    }

    rootEl?.querySelector('#omx-enable')?.addEventListener('click', () => resumeAudio().catch(console.warn));
    rootEl?.querySelector('#omx-style')?.addEventListener('change', () => {
        refreshCustomInputs();
        applyOscTypeFromStyle();
        vizP5?.redraw();
    });
    rootEl?.querySelector('#omx-fmin')?.addEventListener('input', () => vizP5?.redraw());
    rootEl?.querySelector('#omx-fmax')?.addEventListener('input', () => vizP5?.redraw());
    rootEl?.querySelector('#omx-volume')?.addEventListener('input', (e) => {
        const v = Number(e.target?.value);
        volumeValue = Number.isFinite(v) ? v : 0.42;
        const label = rootEl?.querySelector('#omx-volume-label');
        if (label) label.textContent = `${Math.round(volumeValue * 100)}%`;
        applyMasterGain();
    });
}

async function applyPreset() {
    if (!ble.getRxChar()) return;
    omni.channelMode = [...PRESET_MODES];
    omni.activeMask = PRESET_ACTIVE & 0x01ff;
    omni.pullupMask = PRESET_PULLUP & 0x01ff;
    await applyDeviceConfig({
        freq: omni.lastFreq,
        res: omni.lastRes,
        activeMask: omni.activeMask,
        pullupMask: omni.pullupMask,
        touchMask: computeTouchModeMask()
    });
    const si = document.getElementById('syncIndicator');
    if (si) si.innerText = '⚡ Omni混音機：預設僅 G2 · 可自選其他腳位';
}

function buildDom(root) {
    const toggles = CHANS.map((_, idx) => {
        const on = channelOn[idx];
        const cls = on ? 'omx-toggle omx-toggle--on' : 'omx-toggle omx-toggle--off';
        return `
<button type="button" class="${cls}" data-omx-ch="${idx}">
  <span class="omx-toggle-title">GPIO ${idx}</span>
  <span class="omx-toggle-hz" id="omx-hz-${idx}">—</span>
</button>`;
    }).join('');

    root.innerHTML = `
<div class="omx-root">
  <div class="omx-hero">
    <div class="omx-title-wrap">
      <div class="omx-title">Omni混音機</div>
      <button id="omx-side-toggle" type="button" class="omx-side-btn">側邊</button>
    </div>
    <p class="omx-sub">五軌即時感測合成器 · 多音同時輸出 · 教室友善音色</p>
  </div>

  <div class="omx-grid">
    <div class="omx-card omx-controls-card">
      <h3>音色與混音</h3>
      <div class="omx-row">
        <label for="omx-style">音色風格</label>
        <select id="omx-style" class="omx-select">
          <option value="piano" selected>鋼琴（音階 · 有變化才發聲）</option>
          <option value="elegant">優美（220–660 Hz）</option>
          <option value="magical">魔幻（880–3500 Hz）</option>
          <option value="custom">自訂</option>
        </select>
      </div>

      <div id="omx-custom-wrap" class="omx-custom hidden">
        <div class="omx-row">
          <label for="omx-fmin">下限頻率 (Hz)</label>
          <input id="omx-fmin" class="omx-input" type="number" value="220" min="20" step="1" />
        </div>
        <div class="omx-row">
          <label for="omx-fmax">上限頻率 (Hz)</label>
          <input id="omx-fmax" class="omx-input" type="number" value="1200" min="21" step="1" />
        </div>
      </div>

      <div class="omx-row">
        <label for="omx-volume">主音量</label>
        <div class="omx-volume">
          <input id="omx-volume" type="range" min="0" max="1" step="0.02" value="${volumeValue}" />
          <span id="omx-volume-label">${Math.round(volumeValue * 100)}%</span>
        </div>
      </div>

      <div class="omx-toggles">${toggles}</div>
      <button id="omx-enable" type="button" class="omx-enable">點擊啟用音訊（瀏覽器限制）</button>
    </div>

    <div class="omx-card">
      <div id="omx-canvas" class="omx-viz omx-viz--pickup"></div>
    </div>
  </div>
</div>`;
}

export async function mount(root) {
    rootEl = root;
    omni.currentViewId = 'sense-synth';
    injectCss();
    buildDom(root);
    wireUi();
    refreshCustomInputs();
    refreshToggleVisual();
    refreshHzLabels();
    await loadP5();
    const host = root.querySelector('#omx-canvas');
    if (host) mountP5(host);
    dataHandler = (ev) => onData(ev);
    window.addEventListener('omnisense:data', dataHandler);
}

export async function onConnected() {
    await applyPreset();
}

async function teardown() {
    window.removeEventListener('omnisense:data', dataHandler);
    dataHandler = null;

    if (vizP5) {
        vizP5.remove();
        vizP5 = null;
    }

    for (const v of voices) {
        try {
            v.osc.stop();
            v.osc.disconnect();
            v.gain.disconnect();
        } catch {
            /* ignore */
        }
    }
    voices = [];

    if (masterGain) {
        try {
            masterGain.disconnect();
        } catch {
            /* ignore */
        }
        masterGain = null;
    }

    if (audioCtx) {
        try {
            await audioCtx.close();
        } catch {
            /* ignore */
        }
        audioCtx = null;
    }
    isAudioReady = false;

    if (rootEl) {
        rootEl.innerHTML = '';
        rootEl = null;
    }
}

export async function cleanup() {
    await teardown();
}

export async function unmount() {
    await cleanup();
}
