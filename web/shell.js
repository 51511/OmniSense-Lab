/**
 * App Shell：三區導覽（主控台／實驗專案／自製專案）、卡帶式動態載入、生命週期 teardown。
 * 官方模組：import ../experiments/{id}/app.js
 * 自製專案：loadExternalModule(url) → 動態 import（遠端需 CORS；本地為 blob URL）
 */

import { pushBlePacket, clearBleQueue, startEventLoop } from './core/events.js';
import * as ble from './core/ble.js';
import { omni } from './core/state.js';
import { applyHardwarePreset } from './hardwarePreset.js';

const THEME_STORAGE_KEY = 'omnisense_theme_mode';
let activeModule = null;
let activeId = null;
let cachedProjects = null;
/** 已由 Shell 套用 projects/config 的 hardwarePreset 時為 true，供實驗 onConnected 略過內建 PRESET */
let lastShellPresetApplied = false;

/** @type {'console' | 'projects' | 'custom'} */
let shellNav = 'console';
/** @type {null | { type: 'official', id: string } | { type: 'external', url: string } | { type: 'local', name: string }} */
let experimentRun = null;

/** 本機匯入 JS 時的 object URL，離開模組時須 revoke */
let localModuleBlobUrl = null;
/** 本機資料夾匯入時的 session base path（供 teardown 清理快取） */
let localBundleBasePath = null;
const LOCAL_BUNDLE_PREFIX = '/__omni_local__/';
const LOCAL_BUNDLE_CACHE = 'omnisense-local-bundles-v1';

function applyThemeMode(mode) {
    const light = mode === 'light';
    document.body.classList.toggle('theme-light', light);
    const btn = document.getElementById('themeToggleBtn');
    const icon = document.getElementById('themeToggleIcon');
    if (btn) {
        btn.setAttribute('aria-label', light ? '切換為夜間模式' : '切換為日間模式');
        btn.setAttribute('title', light ? '切換為夜間模式' : '切換為日間模式');
    }
    if (icon) {
        icon.setAttribute('data-lucide', light ? 'moon' : 'sun');
    }
    if (window.lucide) window.lucide.createIcons();
}

function initThemeToggle() {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    applyThemeMode(saved === 'light' ? 'light' : 'dark');
    document.getElementById('themeToggleBtn')?.addEventListener('click', () => {
        const isLight = document.body.classList.contains('theme-light');
        const next = isLight ? 'dark' : 'light';
        localStorage.setItem(THEME_STORAGE_KEY, next);
        applyThemeMode(next);
    });
}

function revokeLocalModuleBlobUrl() {
    if (localModuleBlobUrl) {
        URL.revokeObjectURL(localModuleBlobUrl);
        localModuleBlobUrl = null;
    }
}

function makeLocalBundleSessionId() {
    return `bundle-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeRelativePath(p) {
    return String(p || '')
        .replaceAll('\\', '/')
        .replace(/^\/+/, '')
        .replace(/^\.\//, '');
}

function guessContentType(path) {
    const p = path.toLowerCase();
    if (p.endsWith('.js') || p.endsWith('.mjs')) return 'text/javascript; charset=utf-8';
    if (p.endsWith('.json')) return 'application/json; charset=utf-8';
    if (p.endsWith('.png')) return 'image/png';
    if (p.endsWith('.jpg') || p.endsWith('.jpeg')) return 'image/jpeg';
    if (p.endsWith('.gif')) return 'image/gif';
    if (p.endsWith('.webp')) return 'image/webp';
    if (p.endsWith('.svg')) return 'image/svg+xml';
    if (p.endsWith('.mp3')) return 'audio/mpeg';
    if (p.endsWith('.wav')) return 'audio/wav';
    if (p.endsWith('.ogg')) return 'audio/ogg';
    if (p.endsWith('.css')) return 'text/css; charset=utf-8';
    if (p.endsWith('.html')) return 'text/html; charset=utf-8';
    return 'application/octet-stream';
}

async function clearLocalBundleCacheByPrefix(basePath) {
    if (!basePath) return;
    try {
        const cache = await caches.open(LOCAL_BUNDLE_CACHE);
        const keys = await cache.keys();
        await Promise.all(
            keys.map((req) => {
                const p = new URL(req.url).pathname;
                if (p.startsWith(basePath)) return cache.delete(req);
                return Promise.resolve(false);
            })
        );
    } catch (e) {
        console.warn('清除本機 bundle 快取失敗', e);
    }
}

async function stageLocalBundleFiles(files) {
    if (!files || !files.length) throw new Error('未選取任何檔案');
    const sessionId = makeLocalBundleSessionId();
    const basePath = `${LOCAL_BUNDLE_PREFIX}${sessionId}/`;
    const baseUrl = new URL(`.${basePath}`, window.location.href);
    const cache = await caches.open(LOCAL_BUNDLE_CACHE);
    let entryRel = '';

    for (const f of files) {
        const rel = normalizeRelativePath(f.webkitRelativePath || f.name);
        if (!rel) continue;
        if (!entryRel && /\.m?js$/i.test(rel)) {
            const tail = rel.split('/').pop()?.toLowerCase();
            if (tail === 'app.js' || tail === 'index.js' || !entryRel) entryRel = rel;
        }
        const reqUrl = new URL(rel, baseUrl).href;
        const ct = guessContentType(rel);
        await cache.put(reqUrl, new Response(f, { headers: { 'Content-Type': ct, 'Cache-Control': 'no-store' } }));
    }
    if (!entryRel) throw new Error('資料夾內找不到 .js 入口檔（建議命名 app.js 或 index.js）');
    return { entryUrl: new URL(entryRel, baseUrl).href, basePath };
}

async function getProjects() {
    if (cachedProjects) return cachedProjects;
    let r = await fetch(new URL('./projects.json', import.meta.url));
    if (!r.ok) r = await fetch(new URL('../projects.json', import.meta.url));
    if (!r.ok) throw new Error('projects.json 載入失敗');
    cachedProjects = await r.json();
    return cachedProjects;
}

function getContainer() {
    return document.getElementById('view-container');
}

function catalogExperiments(projects) {
    return projects.experiments.filter((e) => e.id !== 'dashboard');
}

function buildShellNav() {
    const tabs = [
        { id: 'console', label: '主控台', shortLabel: '主控台', icon: 'layout-dashboard' },
        { id: 'projects', label: '實驗專案', shortLabel: '專案', icon: 'layers' },
        { id: 'custom', label: '自製專案', shortLabel: '自製', icon: 'link-2' }
    ];
    for (const mobile of [false, true]) {
        const container = document.getElementById(mobile ? 'navMobileInner' : 'navDesktop');
        if (!container) continue;
        container.innerHTML = '';
        tabs.forEach((t) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'nav-tab';
            b.dataset.shell = t.id;
            b.setAttribute('data-nav', '');
            const label = mobile ? t.shortLabel : t.label;
            b.innerHTML = `<i data-lucide="${t.icon}" class="w-4 h-4"></i><span>${label}</span>`;
            b.addEventListener('click', () => onShellNavClick(t.id));
            container.appendChild(b);
        });
    }
    if (window.lucide) window.lucide.createIcons();
}

function setNavActive() {
    document.querySelectorAll('[data-nav]').forEach((btn) => {
        const id = btn.dataset.shell;
        btn.classList.toggle('nav-tab-active', id === shellNav);
    });
}

function refreshLayout() {
    const vp = document.getElementById('view-projects');
    const vc = document.getElementById('view-custom');
    const wrap = document.getElementById('view-experiment-wrap');
    const backBar = document.getElementById('experiment-back-bar');
    if (!vp || !vc || !wrap || !backBar) return;

    const showProjectGrid = shellNav === 'projects' && !experimentRun;
    const showCustomForm = shellNav === 'custom' && !experimentRun;
    const showExperimentArea = shellNav === 'console' || experimentRun !== null;

    vp.classList.toggle('hidden', !showProjectGrid);
    vc.classList.toggle('hidden', !showCustomForm);
    wrap.classList.toggle('hidden', !showExperimentArea);
    backBar.classList.toggle('hidden', shellNav === 'console' || !experimentRun);
}

function updateHeaderSubtitle() {
    const sub = document.getElementById('headerSubtitle');
    if (!sub) return;
    if (shellNav === 'console') {
        sub.textContent = '系統主控台';
        return;
    }
    if (shellNav === 'projects') {
        sub.textContent = experimentRun ? '執行實驗中' : '選擇實驗專案';
        return;
    }
    if (shellNav === 'custom') {
        if (!experimentRun) {
            sub.textContent = '自製專案（雲端卡帶 / 本機卡帶）';
        } else if (experimentRun.type === 'local') {
            sub.textContent = `本機卡帶 · ${experimentRun.name}`;
        } else {
            sub.textContent = '雲端卡帶';
        }
    }
}

async function teardownActiveModule() {
    revokeLocalModuleBlobUrl();
    if (localBundleBasePath) {
        await clearLocalBundleCacheByPrefix(localBundleBasePath);
        localBundleBasePath = null;
    }
    if (!activeModule) return;
    try {
        if (typeof activeModule.cleanup === 'function') await activeModule.cleanup();
        else if (typeof activeModule.unmount === 'function') await activeModule.unmount();
    } catch (e) {
        console.warn('實驗 teardown', e);
    }
    activeModule = null;
    activeId = null;
}

/**
 * 自製專案卡帶：以動態 import 載入 ES 模組（http(s) 需 CORS；blob: 為本機匯入）。
 * @param {string} url
 * @returns {Promise<object>}
 */
export async function loadExternalModule(url) {
    let u;
    try {
        u = new URL(url, window.location.href);
    } catch {
        throw new Error('無效的 URL');
    }
    const ok = /^https?:$/i.test(u.protocol) || /^blob:$/i.test(u.protocol);
    if (!ok) {
        throw new Error('僅支援 http(s) 或本機匯入（blob）模組位址');
    }
    return import(/* @vite-ignore */ u.href);
}

async function getMergedProjectMeta(id) {
    const projects = await getProjects();
    const base = projects.experiments.find((e) => e.id === id);
    let extra = {};
    try {
        const r = await fetch(new URL(`../experiments/${id}/config.json`, import.meta.url));
        if (r.ok) extra = await r.json();
    } catch {
        /* 無 config 可略 */
    }
    return { ...base, ...extra };
}

async function maybeHardwarePresetPrompt(meta) {
    lastShellPresetApplied = false;
    const preset = meta?.hardwarePreset;
    if (!preset || typeof preset !== 'object') return;
    const msg =
        preset.message ||
        '此實驗建議套用預設腳位與取樣設定。是否自動同步至裝置？';
    if (!window.confirm(msg)) return;
    if (!ble.isConnected()) {
        window.alert('尚未連線，已略過下發。請連線後於主控台手動套用。');
        return;
    }
    try {
        await applyHardwarePreset(preset);
        lastShellPresetApplied = true;
        const si = document.getElementById('syncIndicator');
        if (si) si.innerText = '⚡ 已套用實驗建議設定';
    } catch (e) {
        console.warn(e);
        window.alert('套用設定失敗，請於主控台手動調整。');
    }
}

async function mountDashboard() {
    const root = getContainer();
    if (!root) return;
    try {
        const entryUrl = new URL('../experiments/dashboard/app.js', import.meta.url);
        const mod = await import(entryUrl);
        activeModule = mod;
        activeId = 'dashboard';
        omni.currentViewId = 'dashboard';
        if (mod.mount) await mod.mount(root);
        if (ble.isConnected() && mod.onConnected) {
            try {
                await mod.onConnected();
            } catch (e) {
                console.warn(e);
            }
        }
    } catch (e) {
        console.error('Dashboard load failed', e);
        root.innerHTML = `
          <div class="rounded-xl border border-rose-500/40 bg-rose-950/20 p-4 text-sm text-rose-200">
            主控台載入失敗，請先重新整理頁面（Ctrl+F5）。<br>
            <span class="text-rose-300/90">錯誤：${String(e?.message || e)}</span>
          </div>`;
    }
}

function renderProjectGrid() {
    const wrap = document.getElementById('view-projects');
    if (!wrap) return;
    getProjects().then((projects) => {
        const list = catalogExperiments(projects);
        wrap.innerHTML = `<div id="project-grid-inner" class="grid sm:grid-cols-2 xl:grid-cols-3 gap-3"></div>`;
        const inner = document.getElementById('project-grid-inner');
        for (const ex of list) {
            const card = document.createElement('button');
            card.type = 'button';
            card.className =
                'group text-left rounded-xl border border-slate-600/40 bg-slate-800/40 hover:bg-slate-800/80 hover:border-cyan-500/35 transition-colors p-3 shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/50';
            const desc = ex.description || ex.subtitle || '';
            card.innerHTML = `
                <div class="flex items-start gap-2">
                    <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-900/80 text-cyan-400 ring-1 ring-slate-600/50 group-hover:ring-cyan-500/30">
                        <i data-lucide="${ex.icon}" class="w-4 h-4"></i>
                    </span>
                    <div class="min-w-0 flex-1">
                        <p class="text-sm font-bold text-slate-100 truncate">${ex.label}</p>
                        <p class="text-[10px] text-slate-500 mt-0.5 line-clamp-2">${desc}</p>
                    </div>
                </div>`;
            card.addEventListener('click', () => launchOfficialExperiment(ex.id));
            inner.appendChild(card);
        }
        if (window.lucide) window.lucide.createIcons();
    });
}

async function launchOfficialExperiment(id) {
    await teardownActiveModule();
    shellNav = 'projects';
    experimentRun = { type: 'official', id };
    refreshLayout();
    setNavActive();
    updateHeaderSubtitle();

    const meta = await getMergedProjectMeta(id);
    const entryUrl = new URL(`../experiments/${id}/app.js`, import.meta.url);
    const mod = await import(entryUrl);
    activeModule = mod;
    activeId = id;

    const root = getContainer();
    if (mod.mount && root) await mod.mount(root);
    await maybeHardwarePresetPrompt(meta);
    if (typeof window !== 'undefined') {
        window.__omnisenseSkipExperimentDefaultPreset = lastShellPresetApplied;
    }
    try {
        if (ble.isConnected() && mod.onConnected) await mod.onConnected();
    } catch (e) {
        console.warn(e);
    } finally {
        if (typeof window !== 'undefined') {
            delete window.__omnisenseSkipExperimentDefaultPreset;
        }
    }
}

async function launchCustomExperiment(urlString) {
    let u;
    try {
        u = new URL(urlString.trim(), window.location.href);
    } catch {
        window.alert('請輸入有效的 http(s) 網址');
        return;
    }
    if (!/^https?:$/i.test(u.protocol)) {
        window.alert('僅支援 http 或 https 模組位址');
        return;
    }

    await teardownActiveModule();
    shellNav = 'custom';
    experimentRun = { type: 'external', url: u.href };
    refreshLayout();
    setNavActive();
    updateHeaderSubtitle();

    try {
        const mod = await loadExternalModule(u.href);
        activeModule = mod;
        activeId = 'external';
        const root = getContainer();
        if (!mod.mount) {
            throw new Error('模組必須 export async function mount(root)');
        }
        await mod.mount(root);
        if (ble.isConnected() && mod.onConnected) {
            try {
                await mod.onConnected();
            } catch (e) {
                console.warn(e);
            }
        }
    } catch (e) {
        console.warn(e);
        experimentRun = null;
        refreshLayout();
        window.alert(
            '無法載入模組（常見原因：CORS、非 ES module、或網址錯誤）。\n' + String(e.message || e)
        );
    }
}

/**
 * 自製專案：從本機選取的 .js 檔建立 blob URL 後動態 import（無需 CORS）。
 * @param {File} file
 */
async function launchLocalCustomModule(file) {
    await teardownActiveModule();
    shellNav = 'custom';
    const blob = new Blob([await file.text()], { type: 'text/javascript' });
    localModuleBlobUrl = URL.createObjectURL(blob);
    experimentRun = { type: 'local', name: file.name };
    refreshLayout();
    setNavActive();
    updateHeaderSubtitle();

    try {
        const mod = await loadExternalModule(localModuleBlobUrl);
        activeModule = mod;
        activeId = 'external';
        const root = getContainer();
        if (!mod.mount) {
            throw new Error('模組必須 export async function mount(root)');
        }
        await mod.mount(root);
        if (ble.isConnected() && mod.onConnected) {
            try {
                await mod.onConnected();
            } catch (e) {
                console.warn(e);
            }
        }
    } catch (e) {
        console.warn(e);
        experimentRun = null;
        revokeLocalModuleBlobUrl();
        refreshLayout();
        window.alert('無法載入本機模組（須為 ES module，且 export mount）。\n' + String(e.message || e));
    }
}

/**
 * 自製專案：匯入本機資料夾（JS + 同資料夾資源）並掛到 SW 可讀取路徑。
 * @param {FileList | File[]} files
 */
async function launchLocalCustomBundle(files) {
    await teardownActiveModule();
    shellNav = 'custom';
    const all = Array.from(files || []);
    const firstName = all[0]?.webkitRelativePath?.split('/')[0] || all[0]?.name || 'local-bundle';
    experimentRun = { type: 'local', name: `${firstName}（資料夾）` };
    refreshLayout();
    setNavActive();
    updateHeaderSubtitle();

    try {
        const staged = await stageLocalBundleFiles(all);
        localBundleBasePath = staged.basePath;
        const mod = await loadExternalModule(staged.entryUrl);
        activeModule = mod;
        activeId = 'external';
        const root = getContainer();
        if (!mod.mount) {
            throw new Error('模組必須 export async function mount(root)');
        }
        await mod.mount(root);
        if (ble.isConnected() && mod.onConnected) {
            try {
                await mod.onConnected();
            } catch (e) {
                console.warn(e);
            }
        }
    } catch (e) {
        console.warn(e);
        experimentRun = null;
        if (localBundleBasePath) {
            await clearLocalBundleCacheByPrefix(localBundleBasePath);
            localBundleBasePath = null;
        }
        refreshLayout();
        window.alert(
            '無法載入本機資料夾模組（需包含入口 .js，且 export mount）。\n' + String(e.message || e)
        );
    }
}

/**
 * 優先使用 File System Access API，降低資料夾匯入時出現「上傳檔案」警告的機率；
 * 若瀏覽器不支援，會回退到既有的 input[webkitdirectory] 流程。
 * @returns {Promise<File[]>}
 */
async function pickLocalBundleFiles() {
    if (!('showDirectoryPicker' in window)) return [];
    const files = [];
    const walk = async (dirHandle, prefix = '') => {
        for await (const [name, handle] of dirHandle.entries()) {
            if (handle.kind === 'directory') {
                await walk(handle, `${prefix}${name}/`);
                continue;
            }
            const f = await handle.getFile();
            try {
                Object.defineProperty(f, 'webkitRelativePath', {
                    value: `${prefix}${name}`,
                    configurable: true
                });
            } catch {
                // 某些瀏覽器不允許覆寫此屬性，可略過
            }
            files.push(f);
        }
    };
    const dir = await window.showDirectoryPicker({ mode: 'read' });
    await walk(dir);
    return files;
}

async function onShellNavClick(target) {
    if (target === shellNav && experimentRun) {
        await onExperimentBack();
        return;
    }
    if (target === shellNav && !experimentRun) {
        if (target === 'projects') renderProjectGrid();
        return;
    }

    await teardownActiveModule();
    experimentRun = null;

    if (target === 'console') {
        shellNav = 'console';
        refreshLayout();
        setNavActive();
        updateHeaderSubtitle();
        await mountDashboard();
        return;
    }

    if (target === 'projects') {
        shellNav = 'projects';
        refreshLayout();
        setNavActive();
        updateHeaderSubtitle();
        renderProjectGrid();
        return;
    }

    if (target === 'custom') {
        shellNav = 'custom';
        refreshLayout();
        setNavActive();
        updateHeaderSubtitle();
    }
}

async function onExperimentBack() {
    await teardownActiveModule();
    experimentRun = null;
    refreshLayout();
    updateHeaderSubtitle();
    if (shellNav === 'projects') renderProjectGrid();
}

async function onConnectClick() {
    try {
        await ble.connectBle((copy) => pushBlePacket(copy));
        document.getElementById('connectBtn')?.classList.add('hidden');
        document.getElementById('disconnectBtn')?.classList.remove('hidden');
        const si = document.getElementById('syncIndicator');
        if (si) si.innerText = '✅ 裝置已就緒';
        if (activeModule?.onConnected) await activeModule.onConnected();
    } catch (e) {
        console.warn(e);
    }
}

function onDisconnectClick() {
    clearBleQueue();
    omni.packetHistory.length = 0;
    ble.disconnectBle();
    document.getElementById('connectBtn')?.classList.remove('hidden');
    document.getElementById('disconnectBtn')?.classList.add('hidden');
    const si = document.getElementById('syncIndicator');
    if (si) si.innerText = '已斷開藍牙';
}

async function init() {
    const projects = await getProjects();
    buildShellNav();
    initThemeToggle();

    document.getElementById('experimentBackBtn')?.addEventListener('click', () => onExperimentBack().catch(console.error));
    document.getElementById('customLaunchBtn')?.addEventListener('click', () => {
        const input = document.getElementById('customModuleUrl');
        const v = input?.value?.trim();
        if (!v) {
            window.alert('請貼上模組的完整 URL');
            return;
        }
        launchCustomExperiment(v).catch(console.error);
    });

    const customFolderInput = document.getElementById('customModuleFolder');
    document.getElementById('customImportFolderBtn')?.addEventListener('click', async () => {
        if ('showDirectoryPicker' in window) {
            try {
                const fsFiles = await pickLocalBundleFiles();
                if (fsFiles.length) {
                    launchLocalCustomBundle(fsFiles).catch(console.error);
                    return;
                }
            } catch (e) {
                if (e?.name !== 'AbortError') console.warn(e);
            }
        }
        customFolderInput?.click();
    });
    customFolderInput?.addEventListener('change', () => {
        const files = Array.from(customFolderInput.files || []);
        customFolderInput.value = '';
        if (!files.length) return;
        launchLocalCustomBundle(files).catch(console.error);
    });

    document.getElementById('connectBtn')?.addEventListener('click', onConnectClick);
    document.getElementById('disconnectBtn')?.addEventListener('click', onDisconnectClick);
    window.addEventListener('omnisense:ble-disconnected', onDisconnectClick);

    /** 弓匠試煉等模組：通關後請求切換下一個官方實驗（預設電阻鑑定師） */
    window.addEventListener('omnisense:forge-next', (ev) => {
        const id = typeof ev.detail?.nextId === 'string' && ev.detail.nextId ? ev.detail.nextId : 'analog-rocket';
        launchOfficialExperiment(id).catch(console.error);
    });

    if (window.lucide) window.lucide.createIcons();
    startEventLoop();

    shellNav = 'console';
    experimentRun = null;
    refreshLayout();
    setNavActive();
    updateHeaderSubtitle();
    await mountDashboard();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => init().catch(console.error));
} else {
    init().catch(console.error);
}
