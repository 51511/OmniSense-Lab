/**
 * App Shell嚗??撠汗嚗蜓?批嚗祕撽?獢??芾ˊ撠?嚗撣嗅???頛???賡望? teardown?? * 摰璅∠?嚗mport ../experiments/{id}/app.js
 * ?芾ˊ撠?嚗oadExternalModule(url) ???? import嚗?蝡舫? CORS嚗?啁 blob URL嚗? */

import { pushBlePacket, clearBleQueue, startEventLoop } from './core/events.js';
import * as ble from './core/ble.js';
import { omni } from './core/state.js';
import { applyHardwarePreset } from './hardwarePreset.js';

let activeModule = null;
let activeId = null;
let cachedProjects = null;
/** 撌脩 Shell 憟 projects/config ??hardwarePreset ? true嚗?撖阡? onConnected ?仿??批遣 PRESET */
let lastShellPresetApplied = false;

/** @type {'console' | 'projects' | 'custom'} */
let shellNav = 'console';
/** @type {null | { type: 'official', id: string } | { type: 'external', url: string } | { type: 'local', name: string }} */
let experimentRun = null;

/** ?祆?鞈?憭曉?交???session base path嚗? teardown 皜?敹怠?嚗?*/
let localBundleBasePath = null;
const LOCAL_BUNDLE_PREFIX = '/__omni_local__/';
const LOCAL_BUNDLE_CACHE = 'omnisense-local-bundles-v1';

function makeLocalBundleSessionId() {
    return `bundle-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeRelativePath(p) {
    const raw = String(p || '').split('\\').join('/').replace(/^\/+/, '').replace(/^\.\//, '');
    const parts = [];
    for (const seg of raw.split('/')) {
        if (seg === '' || seg === '.') continue;
        if (seg === '..') throw new Error('鞈?憭曉?思??迂?楝敺?..嚗?);
        parts.push(seg);
    }
    return parts.join('/');
}

/**
 * 敺??冗?扳???.js 頝臬???亙瑼??踹? FileList ?????亙瑼?洵銝???? * @param {string[]} jsRelPaths
 * @returns {string}
 */
function pickLocalBundleEntryRel(jsRelPaths) {
    const paths = [...new Set(jsRelPaths)].filter(Boolean);
    if (!paths.length) {
        throw new Error('鞈?憭曉?曆???.js ?亙瑼?撱箄降?賢? app.js ??index.js嚗?);
    }
    const lower = (s) => s.toLowerCase();
    const tail = (s) => s.split('/').pop() || s;
    const priority = ['app.js', 'index.js', 'main.js', 'main.mjs'];
    for (const name of priority) {
        const hit = paths.find((p) => lower(tail(p)) === name);
        if (hit) return hit;
    }
    if (paths.length === 1) return paths[0];
    paths.sort((a, b) => {
        const da = a.split('/').length;
        const db = b.split('/').length;
        if (da !== db) return da - db;
        return lower(a).localeCompare(lower(b));
    });
    return paths[0];
}

/**
 * ?祆?鞈?憭暹芋蝯?鞈?SW ? /__omni_local__/嚗?撠鋡?SW ?亦恣嚗mport ???404?? */
async function ensureServiceWorkerForLocalBundle() {
    if (!('serviceWorker' in navigator)) {
        throw new Error('甇斤汗?其??舀 Service Worker嚗瘜蝙?具?交?啗??冗??隢?刻票銝?HTTPS 蝬脣?嚗??芸?亙銝 JS??);
    }
    if (window.location.protocol === 'file:') {
        throw new Error('隢?冽?獢蜇蝞∠?仿???HTML嚗???localhost ??HTTPS ??嚗? README ??Web 雿輻?孵?嚗??血??⊥?頛?祆?鞈?憭暹芋蝯?);
    }
    const swUrl = new URL('./sw.js', import.meta.url);
    const scopeUrl = new URL('./', import.meta.url);
    await navigator.serviceWorker.register(swUrl.href, { scope: scopeUrl.href });
    await navigator.serviceWorker.ready;
    for (let i = 0; i < 40 && !navigator.serviceWorker.controller; i++) {
        await new Promise((r) => setTimeout(r, 50));
    }
    if (!navigator.serviceWorker.controller) {
        await new Promise((resolve) => {
            const done = () => resolve();
            const t = setTimeout(done, 2500);
            navigator.serviceWorker.addEventListener(
                'controllerchange',
                () => {
                    clearTimeout(t);
                    done();
                },
                { once: true }
            );
        });
    }
    if (!navigator.serviceWorker.controller) {
        throw new Error(
            'Service Worker 撠?亦恣?祇??ｇ??⊥?頛?祆?鞈?憭整???Ctrl+F5 撘瑕??渡?敺?閰虫?甈∴????極????Application ??Service Workers 蝣箄?撌脣??具?
        );
    }
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
        console.warn('皜?祆? bundle 敹怠?憭望?', e);
    }
}

async function stageLocalBundleFiles(files) {
    if (!files || !files.length) throw new Error('?芷?遙雿?獢?);
    await ensureServiceWorkerForLocalBundle();
    const sessionId = makeLocalBundleSessionId();
    const basePath = `${LOCAL_BUNDLE_PREFIX}${sessionId}/`;
    const baseUrl = new URL(`.${basePath}`, window.location.href);
    const cache = await caches.open(LOCAL_BUNDLE_CACHE);
    const jsRelPaths = [];

    for (const f of files) {
        const rel = normalizeRelativePath(f.webkitRelativePath || f.name);
        if (!rel) continue;
        if (/\.m?js$/i.test(rel)) jsRelPaths.push(rel);
        const reqUrl = new URL(rel, baseUrl).href;
        const ct = guessContentType(rel);
        await cache.put(reqUrl, new Response(f, { headers: { 'Content-Type': ct, 'Cache-Control': 'no-store' } }));
    }
    const entryRel = pickLocalBundleEntryRel(jsRelPaths);
    return { entryUrl: new URL(entryRel, baseUrl).href, basePath };
}

async function getProjects() {
    if (cachedProjects) return cachedProjects;
    let r = await fetch(new URL('./projects.json', import.meta.url));
    if (!r.ok) r = await fetch(new URL('../projects.json', import.meta.url));
    if (!r.ok) throw new Error('projects.json 頛憭望?');
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
    if (localBundleBasePath) {
        await clearLocalBundleCacheByPrefix(localBundleBasePath);
        localBundleBasePath = null;
    }
    if (!activeModule) return;
    try {
        if (typeof activeModule.cleanup === 'function') await activeModule.cleanup();
        else if (typeof activeModule.unmount === 'function') await activeModule.unmount();
    } catch (e) {
        console.warn('撖阡? teardown', e);
    }
    activeModule = null;
    activeId = null;
}

/**
 * ?芾ˊ撠??∪葆嚗誑?? import 頛 ES 璅∠?嚗ttp(s) ? CORS嚗lob: ?箸璈?伐??? * @param {string} url
 * @returns {Promise<object>}
 */
export async function loadExternalModule(url) {
    let u;
    try {
        u = new URL(url, window.location.href);
    } catch {
        throw new Error('?⊥???URL');
    }
    const ok = /^https?:$/i.test(u.protocol) || /^blob:$/i.test(u.protocol);
    if (!ok) {
        throw new Error('???http(s) ?璈?伐?blob嚗芋蝯??');
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
        /* ??config ?舐 */
    }
    return { ...base, ...extra };
}

async function maybeHardwarePresetPrompt(meta) {
    lastShellPresetApplied = false;
    const preset = meta?.hardwarePreset;
    if (!preset || typeof preset !== 'object') return;
    const msg =
        preset.message ||
        '甇文祕撽遣霅啣??券?閮剛雿??見閮剖???西??甇亥鋆蔭嚗?;
    if (!window.confirm(msg)) return;
    if (!ble.isConnected()) {
        window.alert('撠???嚗歇?仿?銝?????敺銝餅?唳????具?);
        return;
    }
    try {
        await applyHardwarePreset(preset);
        lastShellPresetApplied = true;
        const si = document.getElementById('syncIndicator');
        if (si) si.innerText = '??撌脣??典祕撽遣霅啗身摰?;
    } catch (e) {
        console.warn(e);
        window.alert('憟閮剖?憭望?嚗??潔蜓?批??隤踵??);
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
            銝餅?啗??亙仃??隢???渡??嚗trl+F5嚗?br>
            <span class="text-rose-300/90">?航炊嚗?{String(e?.message || e)}</span>
          </div>`;
    }
}

function renderProjectGrid() {
    const wrap = document.getElementById('view-projects');
    if (!wrap) return;
    getProjects().then((projects) => {
        const list = catalogExperiments(projects);
        wrap.innerHTML = `
            <div class="mb-3">
                <h2 class="text-base font-bold text-slate-100 tracking-tight">撖阡?撠?</h2>
                <p class="text-[11px] text-slate-500 mt-0.5">暺?∪葆隞亙?????<code class="text-cyan-500/90">experiments/&lt;id&gt;/app.js</code>??/p>
            </div>
            <div id="project-grid-inner" class="grid sm:grid-cols-2 xl:grid-cols-3 gap-3"></div>`;
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
        window.alert('隢撓?交??? http(s) 蝬脣?');
        return;
    }
    if (!/^https?:$/i.test(u.protocol)) {
        window.alert('???http ??https 璅∠?雿?');
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
            throw new Error('璅∠?敹? export async function mount(root)');
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
            '?⊥?頛璅∠?嚗虜閬???CORS?? ES module??蝬脣??航炊嚗n' + String(e.message || e)
        );
    }
}

/**
 * ?芾ˊ撠?嚗?交璈??冗嚗S + ???冗鞈?嚗蒂? SW ?航??楝敺? * @param {FileList | File[]} files
 */
async function launchLocalCustomBundle(files) {
    await teardownActiveModule();
    shellNav = 'custom';
    const all = Array.from(files || []);
    const firstName = all[0]?.webkitRelativePath?.split('/')[0] || all[0]?.name || 'local-bundle';
    experimentRun = { type: 'local', name: `${firstName}嚗??冗嚗 };
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
            throw new Error('璅∠?敹? export async function mount(root)');
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
            '?⊥?頛?祆?鞈?憭暹芋蝯????亙 .js嚗? export mount嚗n' + String(e.message || e)
        );
    }
}

/**
 * 優先使用 File System Access API（通常不會顯示「上傳到網站」措辭），
 * 不支援時再回退到 <input webkitdirectory>。
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
                /* 某些瀏覽器不允許覆寫此屬性 */
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
        if (si) si.innerText = '??鋆蔭撌脣停蝺?;
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
    if (si) si.innerText = '撌脫????;
}

async function init() {
    const projects = await getProjects();
    buildShellNav();

    document.getElementById('experimentBackBtn')?.addEventListener('click', () => onExperimentBack().catch(console.error));
    document.getElementById('customLaunchBtn')?.addEventListener('click', () => {
        const input = document.getElementById('customModuleUrl');
        const v = input?.value?.trim();
        if (!v) {
            window.alert('隢票銝芋蝯?摰 URL');
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
        if (!files.length) {
            window.alert('?芷?遙雿?獢?汗?冽閰Ｗ??臬撠??冗銝?唳蝬脩?嚗?暺??喋誑蝜潛???);
            return;
        }
        launchLocalCustomBundle(files).catch(console.error);
    });

    document.getElementById('connectBtn')?.addEventListener('click', onConnectClick);
    document.getElementById('disconnectBtn')?.addEventListener('click', onDisconnectClick);
    window.addEventListener('omnisense:ble-disconnected', onDisconnectClick);

    /** 撘?閰衣?蝑芋蝯???敺?瘙???銝???孵祕撽??身?駁??撣恬? */
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
