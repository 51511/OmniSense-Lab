/**
 * ForceFlow 4.5: 魔法弓箭 - 音畫完整版
 * 整合：封面渲染、循環配樂、5s自動校準、等級系統
 */

const SCRIPT_URL = import.meta.url;
const ASSETS_BASE = SCRIPT_URL.substring(0, SCRIPT_URL.lastIndexOf('/')) + '/force-flow-assets/';

const ASSET_FILES = {
    cover: ASSETS_BASE + 'gamestart.png',      // 遊戲封面圖
    bg: ASSETS_BASE + 'bg.png',
    apple: ASSETS_BASE + 'note-light.png',
    watermelon: ASSETS_BASE + 'note-heavy.png',
    appleSplat: ASSETS_BASE + 'note-light-splat.png',
    watermelonSplat: ASSETS_BASE + 'note-heavy-splat.png',
    bgm: ASSETS_BASE + 'bgm.mp3'              // 遊戲配樂
};

const images = {};
let audioBuffer = null;
let bgmSource = null;
let assetsLoaded = false;

// --- 遊戲狀態 ---
let gameState = 'INTRO'; // INTRO, CALIBRATING, PLAYING
let minRaw = 4095, maxRaw = 0;
let currentPressureRaw = 0;
let normalizedPressure = 0;
const notes = [];
const particles = [];
const labels = [];
let score = 0, combo = 0, currentLevel = 1;
let shakeIntensity = 0;
let animationId = 0;
let audioCtx = null;
let bgmGainNode = null;
let lastSpawnFrame = 0;

const SELECTED_ADC_ID = 2; // 預設使用 GPIO 2

export async function mount(root) {
    // 1. 預載資源 (包含解碼音訊)
    await loadAllAssets();

    root.innerHTML = `
        <div id="ff-root" style="position:absolute; inset:0; background:#000; color:white; font-family:sans-serif; overflow:hidden; user-select:none;">
            <canvas id="ff-canvas" style="display:block; width:100%; height:100%;"></canvas>
            
            <div id="ff-hud" style="position:absolute; top:20px; left:20px; right:20px; display:flex; justify-content:space-between; pointer-events:none; z-index:5;">
                <div>
                    <div style="font-size:1.8rem; font-weight:900; color:#facc15; text-shadow:2px 2px 4px #000;">SCORE: <span id="ff-score">0</span></div>
                    <div style="font-size:1.2rem; font-weight:700; color:#4ade80;">LV. <span id="ff-level">1</span></div>
                </div>
                <div style="font-size:1.8rem; font-weight:900; color:#facc15; text-shadow:2px 2px 4px #000;">COMBO: <span id="ff-combo">0</span></div>
            </div>

            <div id="ff-overlay" style="position:absolute; inset:0; background:rgba(0,0,0,0.6); display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; z-index:20; transition: background 0.5s;">
                <div id="ff-timer" style="font-size:6rem; color:#facc15; font-weight:900; text-shadow:0 0 20px #000;"></div>
                <p id="ff-msg" style="color:white; font-size:1.4rem; font-weight:bold; margin-bottom:20px; text-shadow:0 2px 4px #000;">
                    準備進入魔法果園...<br>
                    <span style="font-size:1rem; font-weight:normal; opacity:0.8;">請確保弓箭感測器接在 GPIO 2</span>
                </p>
                <button id="ff-btn" style="padding:15px 60px; font-size:1.6rem; background:#4ecca3; border:none; border-radius:40px; cursor:pointer; font-weight:bold; color:#0f172a; box-shadow:0 4px 15px rgba(0,0,0,0.3);">進入遊戲與校準</button>
            </div>
        </div>
    `;

    const canvas = root.querySelector('#ff-canvas');
    const ctx = canvas.getContext('2d');
    const btn = root.querySelector('#ff-btn');
    const timerEl = root.querySelector('#ff-timer');
    const overlay = root.querySelector('#ff-overlay');

    const resize = () => { canvas.width = root.clientWidth; canvas.height = root.clientHeight; };
    window.addEventListener('resize', resize);
    resize();

    // 監聽數據
    const onData = (ev) => {
        const ch = ev.detail.channels[SELECTED_ADC_ID];
        if (ch) {
            currentPressureRaw = ch.filtered;
            if (gameState === 'CALIBRATING') {
                minRaw = Math.min(minRaw, currentPressureRaw);
                maxRaw = Math.max(maxRaw, currentPressureRaw);
            }
            if (gameState === 'PLAYING') {
                normalizedPressure = Math.max(0, Math.min(1, (currentPressureRaw - minRaw) / (maxRaw - minRaw)));
            }
        }
    };
    window.addEventListener('omnisense:data', onData);
    window.__ffOnData = onData;

    btn.onclick = async () => {
        // 初始化音訊
        startAudio();
        playBGM();

        gameState = 'CALIBRATING';
        btn.style.display = 'none';
        overlay.style.background = 'rgba(0,0,0,0.2)';
        minRaw = 4095; maxRaw = 0;
        
        let count = 5;
        timerEl.innerText = count;
        const timer = setInterval(() => {
            count--;
            timerEl.innerText = count > 0 ? count : "";
            if (count <= 0) {
                clearInterval(timer);
                if (maxRaw - minRaw > 200) {
                    gameState = 'PLAYING';
                    overlay.style.display = 'none';
                } else {
                    gameState = 'INTRO';
                    btn.style.display = 'block';
                    btn.innerText = "重試校準";
                    overlay.style.background = 'rgba(0,0,0,0.8)';
                }
            }
        }, 1000);
    };

    const loop = (t) => {
        update(canvas, t);
        draw(ctx, canvas);
        animationId = requestAnimationFrame(loop);
    };
    animationId = requestAnimationFrame(loop);
}

// --- 資源管理 ---
async function loadAllAssets() {
    const loadImg = (src) => new Promise(res => {
        const img = new Image(); img.crossOrigin = "anonymous"; img.src = src;
        img.onload = () => res(img); img.onerror = () => res(null);
    });

    const loadAudio = async (src) => {
        try {
            const resp = await fetch(src);
            const arrayBuf = await resp.arrayBuffer();
            return arrayBuf;
        } catch { return null; }
    };

    // 並行加載
    const tasks = [];
    for (let k in ASSET_FILES) {
        if (k === 'bgm') tasks.push(loadAudio(ASSET_FILES[k]).then(buf => audioBuffer = buf));
        else tasks.push(loadImg(ASSET_FILES[k]).then(img => images[k] = img));
    }
    await Promise.all(tasks);
    assetsLoaded = true;
}

// --- 音訊邏輯 ---
function startAudio() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
}

async function playBGM() {
    if (!audioBuffer || !audioCtx) return;
    if (bgmSource) return;

    // 解碼
    const decodedBuf = await audioCtx.decodeAudioData(audioBuffer.slice(0));
    bgmSource = audioCtx.createBufferSource();
    bgmSource.buffer = decodedBuf;
    bgmSource.loop = true;

    bgmGainNode = audioCtx.createGain();
    bgmGainNode.gain.value = 0.4; // BGM 音量

    bgmSource.connect(bgmGainNode);
    bgmGainNode.connect(audioCtx.destination);
    bgmSource.start(0);
}

function playHitSound(freq) {
    if (!audioCtx) return;
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.connect(g); g.connect(audioCtx.destination);
    o.frequency.setValueAtTime(freq, audioCtx.currentTime);
    g.gain.setValueAtTime(0.7, audioCtx.currentTime); // 放大打擊音
    g.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.15);
    o.start(); o.stop(audioCtx.currentTime + 0.15);
}

// --- 渲染邏輯 ---
function draw(ctx, canvas) {
    ctx.save();
    if (shakeIntensity > 1) {
        ctx.translate((Math.random()-0.5)*shakeIntensity, (Math.random()-0.5)*shakeIntensity);
    }

    if (gameState === 'INTRO' || gameState === 'CALIBRATING') {
        // 繪製封面
        if (images.cover) {
            ctx.drawImage(images.cover, 0, 0, canvas.width, canvas.height);
        } else {
            ctx.fillStyle = "#0f172a"; ctx.fillRect(0,0,canvas.width,canvas.height);
        }
    } else {
        // 遊戲背景
        if (images.bg) ctx.drawImage(images.bg, 0, 0, canvas.width, canvas.height);
        else ctx.clearRect(0,0,canvas.width,canvas.height);
        
        const judgeY = canvas.height * 0.85;
        drawPressureBar(ctx, canvas, judgeY);

        notes.forEach(n => {
            const img = n.type === 'APPLE' ? images.apple : images.watermelon;
            const splat = n.type === 'APPLE' ? images.appleSplat : images.watermelonSplat;
            const size = (n.type === 'APPLE' ? 70 : 110) * (1 + (n.vy * 0.05));

            if (n.state === 'EXPLODED' && splat) {
                ctx.globalAlpha = n.timer / 18;
                ctx.drawImage(splat, n.x - size, n.y - size, size * 2, size * 2);
                ctx.globalAlpha = 1;
            } else if (img) {
                ctx.save();
                ctx.translate(n.x, n.y);
                if (n.state === 'BOUNCING') ctx.rotate(n.rot);
                ctx.drawImage(img, -size/2, -size/2, size, size);
                ctx.restore();
            }
        });

        particles.forEach(p => p.draw(ctx));
        labels.forEach(l => {
            ctx.globalAlpha = l.life; ctx.fillStyle = l.color;
            ctx.font = `bold ${24 + l.life*20}px sans-serif`; ctx.textAlign = 'center';
            ctx.fillText(l.text, l.x, l.y); ctx.globalAlpha = 1;
        });
    }
    ctx.restore();

    const sEl = document.getElementById('ff-score');
    if (sEl) sEl.innerText = score;
}

// --- 更新、粒子、標籤與壓力條邏輯 ---
function update(canvas, t) {
    if (gameState !== 'PLAYING') return;
    if (shakeIntensity > 0) shakeIntensity *= 0.85;

    const nextLv = Math.floor(score / 2000) + 1;
    if (nextLv > currentLevel) {
        currentLevel = nextLv;
        addLabel(canvas.width/2, canvas.height/2, `LEVEL UP!`, "#facc15");
        shakeIntensity = 20;
    }

    const minFrameGap = Math.max(40, 90 - (currentLevel * 5));
    if (t - lastSpawnFrame > minFrameGap && Math.random() < 0.05) {
        notes.push({
            x: canvas.width/2, y: -60, type: Math.random() > 0.4 ? 'APPLE' : 'WATERMELON',
            state: 'FALLING', vx: 0, vy: 3 + (currentLevel*0.5) + (Math.random()*3), rot: 0, seed: Math.random()
        });
        lastSpawnFrame = t;
    }

    const judgeY = canvas.height * 0.85;
    for (let i = notes.length - 1; i >= 0; i--) {
        const n = notes[i];
        if (n.state === 'FALLING') {
            n.y += n.vy;
            if (Math.abs(n.y - judgeY) < 45) {
                const isH = n.type === 'WATERMELON';
                if (normalizedPressure >= (isH ? 0.75 : 0.20) && normalizedPressure <= (isH ? 1.1 : 0.65)) {
                    n.state = 'EXPLODED'; n.timer = 18; score += (isH ? 200 : 100); combo++;
                    shakeIntensity = isH ? 15 : 6;
                    createParticles(n.x, n.y, isH ? '#4ade80' : '#f87171');
                    addLabel(n.x, n.y-60, "GREAT!", isH ? "#4ade80" : "#f87171");
                    playHitSound(isH ? 300 : 600);
                } else if (normalizedPressure > 0.1) {
                    n.state = 'BOUNCING'; n.vx = (n.seed-0.5)*12; n.vy = -10; combo = 0;
                    playHitSound(150);
                }
            }
        } else if (n.state === 'BOUNCING') {
            n.x += n.vx; n.y += n.vy; n.vy += 0.5; n.rot += 0.1;
        } else if (n.state === 'EXPLODED') {
            n.timer--; if (n.timer <= 0) notes.splice(i,1); continue;
        }
        if (n.y > canvas.height + 100 || n.y < -300) notes.splice(i,1);
    }

    particles.forEach((p,i) => { p.update(); if (p.life <= 0) particles.splice(i,1); });
    labels.forEach((l,i) => { l.y -= 1; l.life -= 0.02; if (l.life <= 0) labels.splice(i,1); });
}

function drawPressureBar(ctx, canvas, judgeY) {
    const w = 40, h = 300, x = canvas.width - 60, y = judgeY - h;
    ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(x,y,w,h);
    ctx.fillStyle = 'rgba(244,63,94,0.4)'; ctx.fillRect(x, y + h*0.35, w, h*0.4);
    ctx.fillStyle = 'rgba(34,197,94,0.4)'; ctx.fillRect(x, y, w, h*0.3);
    ctx.fillStyle = '#facc15'; ctx.fillRect(x, y + h - (normalizedPressure * h), w, normalizedPressure * h);
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.strokeRect(x,y,w,h);
}

function addLabel(x, y, text, color) { labels.push({ x, y, text, color, life: 1.0 }); }
class Particle {
    constructor(x, y, color) {
        this.x = x; this.y = y; this.color = color;
        this.vx = (Math.random()-0.5)*20; this.vy = (Math.random()-0.5)*20; this.life = 1.0;
    }
    update() { this.x += this.vx; this.y += this.vy; this.vy += 0.8; this.life -= 0.04; }
    draw(ctx) {
        ctx.globalAlpha = this.life; ctx.fillStyle = this.color;
        ctx.beginPath(); ctx.arc(this.x, this.y, 6, 0, Math.PI*2); ctx.fill();
        ctx.globalAlpha = 1;
    }
}
function createParticles(x,y,c) { for(let i=0;i<30;i++) particles.push(new Particle(x,y,c)); }

export async function unmount() {
    window.removeEventListener('resize', null);
    window.removeEventListener('omnisense:data', window.__ffOnData);
    cancelAnimationFrame(animationId);
    if (bgmSource) { bgmSource.stop(); bgmSource = null; }
    await audioCtx?.close();
}