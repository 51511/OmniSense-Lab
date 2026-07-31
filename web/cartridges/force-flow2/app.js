/**
 * ForceFlow 6.0: 魔法弓箭 - Boss 覺醒版
 * 整合：Boss 戰系統、血條機制、反彈傷害邏輯、動態視覺強化
 */

import { applyDeviceConfig } from '../../core/configApply.js';
import { omni } from '../../core/state.js';
import { computeTouchModeMask } from '../../core/touchMask.js';

const SCRIPT_URL = import.meta.url;
const ASSETS_BASE = SCRIPT_URL.substring(0, SCRIPT_URL.lastIndexOf('/')) + '/force-flow-assets/';

const ASSET_FILES = {
    cover: ASSETS_BASE + 'gamestart.png',
    bg: ASSETS_BASE + 'bg.png',
    apple: ASSETS_BASE + 'note-light.png',
    watermelon: ASSETS_BASE + 'note-heavy.png',
    appleSplat: ASSETS_BASE + 'note-light-splat.png',
    watermelonSplat: ASSETS_BASE + 'note-heavy-splat.png',
    bgm: ASSETS_BASE + 'bgm.mp3'
};

const images = {};
let audioBuffer = null, bgmSource = null, audioCtx = null, bgmGainNode = null;
let tensionOsc = null, tensionGain = null;

// --- 遊戲狀態 ---
let gameState = 'INTRO'; 
let minRaw = 4095, maxRaw = 0, currentPressureRaw = 0, normalizedPressure = 0;
const notes = [], particles = [], labels = [];
let score = 0, combo = 0, currentLevel = 1, shakeIntensity = 0, flashOpacity = 0;
let animationId = 0, lastSpawnFrame = 0;

// --- Boss 系統變數 ---
let boss = {
    active: false,
    hp: 0,
    maxHp: 5000,
    x: 0,
    y: -200,
    targetY: 120,
    vx: 2,
    size: 180,
    phase: 0 // 0: 降臨, 1: 戰鬥
};

const SELECTED_ADC_ID = 2; 
const FF_ACTIVE_MASK = (1 << 0) | (1 << 2); 
const FF_PULLUP_MASK = 1 << 0; 

export async function mount(root) {
    await loadAllAssets();

    root.innerHTML = `
        <div id="ff-root" style="position:absolute; inset:0; background:#000; color:white; font-family:sans-serif; overflow:hidden; user-select:none;">
            <canvas id="ff-canvas" style="display:block; width:100%; height:100%;"></canvas>
            
            <div id="ff-hud" style="position:absolute; top:20px; left:20px; right:20px; display:flex; justify-content:space-between; pointer-events:none; z-index:5;">
                <div>
                    <div style="font-size:1.8rem; font-weight:900; color:#facc15; text-shadow:2px 2px 4px #000;">SCORE: <span id="ff-score">0</span></div>
                    <div id="lv-tag" style="font-size:1.2rem; font-weight:700; color:#4ade80;">LV. <span id="ff-level">1</span></div>
                </div>
                <div style="font-size:1.8rem; font-weight:900; color:#facc15; text-shadow:2px 2px 4px #000;">COMBO: <span id="ff-combo">0</span></div>
            </div>

            <div id="ff-overlay" style="position:absolute; inset:0; background:rgba(0,0,0,0.7); display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; z-index:20;">
                <div id="ff-timer" style="font-size:6rem; color:#facc15; font-weight:900;"></div>
                <p id="ff-msg" style="color:white; font-size:1.4rem; font-weight:bold; margin-bottom:20px;">
                    魔法果園：魔王降臨<br>
                    <span style="font-size:1rem; opacity:0.8;">請準備好你的物理弓箭 (GPIO 2)</span>
                </p>
                <div id="ff-calib-data" style="display:none; margin-bottom:20px; font-family:monospace; color:#4ade80; background:rgba(0,0,0,0.5); padding:10px; border-radius:8px;">
                    RAW: <span id="raw-val">0</span> | RANGE: <span id="range-val">0</span>
                </div>
                <button id="ff-btn" style="padding:15px 60px; font-size:1.6rem; background:#4ecca3; border:none; border-radius:40px; cursor:pointer; font-weight:bold;">開始校準</button>
            </div>
        </div>
    `;

    const canvas = root.querySelector('#ff-canvas');
    const ctx = canvas.getContext('2d');
    const btn = root.querySelector('#ff-btn');
    const timerEl = root.querySelector('#ff-timer');
    const overlay = root.querySelector('#ff-overlay');
    const calibBox = root.querySelector('#ff-calib-data');

    const resize = () => { canvas.width = root.clientWidth; canvas.height = root.clientHeight; };
    window.addEventListener('resize', resize);
    resize();

    const onData = (ev) => {
        const ch = ev.detail.channels[SELECTED_ADC_ID];
        if (ch) {
            currentPressureRaw = ch.filtered;
            if (gameState === 'CALIBRATING') {
                minRaw = Math.min(minRaw, currentPressureRaw);
                maxRaw = Math.max(maxRaw, currentPressureRaw);
                root.querySelector('#raw-val').innerText = currentPressureRaw;
                root.querySelector('#range-val').innerText = maxRaw - minRaw;
            }
            if (gameState === 'PLAYING') {
                normalizedPressure = Math.max(0, Math.min(1, (currentPressureRaw - minRaw) / (maxRaw - minRaw)));
                updateTensionSound(normalizedPressure);
            }
        }
    };
    window.addEventListener('omnisense:data', onData);
    window.__ffOnData = onData;

    btn.onclick = async () => {
        startAudio(); playBGM();
        gameState = 'CALIBRATING';
        btn.style.display = 'none';
        calibBox.style.display = 'block';
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
                    initTensionSound();
                } else {
                    gameState = 'INTRO'; btn.style.display = 'block';
                    btn.innerText = "重新校準"; calibBox.style.display = 'none';
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

// --- Boss 控制邏輯 ---
function triggerBossFight(canvas) {
    boss.active = true;
    boss.maxHp = 3000 + (currentLevel * 2000);
    boss.hp = boss.maxHp;
    boss.x = canvas.width / 2;
    boss.y = -200;
    boss.phase = 0;
    addLabel(canvas.width / 2, canvas.height / 2, "WARNING: BOSS APPROACHING!", "#ff4444");
    shakeIntensity = 30;
}

function updateBoss(canvas, t) {
    if (!boss.active) return;

    if (boss.phase === 0) {
        boss.y += (boss.targetY - boss.y) * 0.05;
        if (Math.abs(boss.y - boss.targetY) < 1) boss.phase = 1;
    } else {
        // Boss 左右移動
        boss.x += boss.vx;
        if (boss.x > canvas.width - 100 || boss.x < 100) boss.vx *= -1;

        // Boss 攻擊：從 Boss 位置發射水果
        const spawnRate = 0.08 + (currentLevel * 0.02);
        if (Math.random() < spawnRate && t - lastSpawnFrame > 40) {
            notes.push({
                x: boss.x + (Math.random() - 0.5) * 50,
                y: boss.y + 50,
                type: Math.random() > 0.3 ? 'APPLE' : 'WATERMELON',
                state: 'FALLING',
                vx: (Math.random() - 0.5) * 4,
                vy: 5 + (currentLevel * 0.5),
                rot: 0, seed: Math.random()
            });
            lastSpawnFrame = t;
        }
    }

    if (boss.hp <= 0) {
        boss.active = false;
        score += 5000;
        addLabel(canvas.width / 2, canvas.height / 2, "BOSS DEFEATED!", "#facc15");
        shakeIntensity = 50;
        flashOpacity = 0.8;
        playLevelUpSound();
    }
}

// --- 核心邏輯與渲染 ---
function update(canvas, t) {
    if (gameState !== 'PLAYING') return;
    if (shakeIntensity > 0) shakeIntensity *= 0.85;
    if (flashOpacity > 0) flashOpacity -= 0.05;

    // 檢查是否該出 Boss (每 3000 分一次)
    if (!boss.active && score > 0 && score % 4000 < 100 && score > currentLevel * 3000) {
        currentLevel++;
        triggerBossFight(canvas);
    }

    if (boss.active) updateBoss(canvas, t);

    // 一般水果生成（非 Boss 戰時）
    if (!boss.active) {
        const minFrameGap = Math.max(30, 80 - (currentLevel * 5));
        if (t - lastSpawnFrame > minFrameGap && Math.random() < 0.06) {
            notes.push({
                x: Math.random() * (canvas.width - 100) + 50, y: -60, 
                type: Math.random() > 0.4 ? 'APPLE' : 'WATERMELON',
                state: 'FALLING', vx: 0, vy: 4 + (currentLevel * 0.4), rot: 0, seed: Math.random()
            });
            lastSpawnFrame = t;
        }
    }

    const judgeY = canvas.height * 0.82;
    for (let i = notes.length - 1; i >= 0; i--) {
        const n = notes[i];
        if (n.state === 'FALLING') {
            n.y += n.vy; n.x += n.vx;
            if (Math.abs(n.y - judgeY) < 50) {
                const isH = n.type === 'WATERMELON';
                const targetMin = isH ? 0.75 : 0.20;
                const targetMax = isH ? 1.10 : 0.65;

                if (normalizedPressure >= targetMin && normalizedPressure <= targetMax) {
                    n.state = 'EXPLODED'; n.timer = 18;
                    const damage = isH ? 300 : 150;
                    score += damage;
                    if (boss.active) boss.hp -= damage; // 傷害 Boss
                    combo++;
                    shakeIntensity = isH ? 12 : 6;
                    createParticles(n.x, n.y, isH ? '#4ade80' : '#f87171');
                    addLabel(n.x, n.y - 60, "HIT!", isH ? "#4ade80" : "#f87171");
                    playHitSound(isH ? 400 : 700);
                }
            }
            if (n.y > judgeY + 60) {
                n.state = 'BOUNCING'; n.vx = (n.seed - 0.5) * 10; n.vy = 2;
                combo = 0; flashOpacity = 0.2;
            }
        } else if (n.state === 'BOUNCING') {
            n.x += n.vx; n.y += n.vy; n.vy += 0.5; n.rot += 0.1;
        } else if (n.state === 'EXPLODED') {
            n.timer--; if (n.timer <= 0) notes.splice(i, 1); continue;
        }
        if (n.y > canvas.height + 100) notes.splice(i, 1);
    }

    particles.forEach((p, i) => { p.update(); if (p.life <= 0) particles.splice(i, 1); });
    labels.forEach((l, i) => { l.y -= 1.5; l.life -= 0.02; if (l.life <= 0) labels.splice(i, 1); });
}

function draw(ctx, canvas) {
    ctx.save();
    if (shakeIntensity > 1) ctx.translate((Math.random() - 0.5) * shakeIntensity, (Math.random() - 0.5) * shakeIntensity);

    if (gameState === 'INTRO' || gameState === 'CALIBRATING') {
        if (images.cover) ctx.drawImage(images.cover, 0, 0, canvas.width, canvas.height);
        else { ctx.fillStyle = "#0f172a"; ctx.fillRect(0, 0, canvas.width, canvas.height); }
    } else {
        if (images.bg) ctx.drawImage(images.bg, 0, 0, canvas.width, canvas.height);
        else ctx.clearRect(0, 0, canvas.width, canvas.height);
        
        const judgeY = canvas.height * 0.82;
        
        // 繪製 Boss
        if (boss.active) {
            drawBoss(ctx);
            drawBossHealth(ctx, canvas);
        }

        drawBow(ctx, canvas, judgeY);
        drawPressureBar(ctx, canvas, judgeY);

        notes.forEach(n => {
            const img = n.type === 'APPLE' ? images.apple : images.watermelon;
            const splat = n.type === 'APPLE' ? images.appleSplat : images.watermelonSplat;
            const size = (n.type === 'APPLE' ? 70 : 110);
            if (n.state === 'EXPLODED') {
                ctx.globalAlpha = n.timer / 18;
                ctx.drawImage(splat, n.x - size, n.y - size, size * 2, size * 2);
                ctx.globalAlpha = 1;
            } else {
                ctx.save(); ctx.translate(n.x, n.y); if (n.state === 'BOUNCING') ctx.rotate(n.rot);
                ctx.drawImage(img, -size / 2, -size / 2, size, size); ctx.restore();
            }
        });

        particles.forEach(p => p.draw(ctx));
        labels.forEach(l => {
            ctx.globalAlpha = l.life; ctx.fillStyle = l.color;
            ctx.font = `bold ${28 + l.life * 20}px sans-serif`; ctx.textAlign = 'center';
            ctx.fillText(l.text, l.x, l.y); ctx.globalAlpha = 1;
        });

        if (flashOpacity > 0) {
            ctx.fillStyle = `rgba(255, 0, 0, ${flashOpacity})`;
            ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
    }
    ctx.restore();
    document.getElementById('ff-score').innerText = score;
    document.getElementById('ff-combo').innerText = combo;
    document.getElementById('ff-level').innerText = boss.active ? "BOSS" : currentLevel;
}

function drawBoss(ctx) {
    const time = Date.now() * 0.005;
    const hover = Math.sin(time) * 10;
    
    // 繪製一個發光的魔王核心 (替代圖片)
    ctx.save();
    ctx.translate(boss.x, boss.y + hover);
    
    // 外發光
    const grad = ctx.createRadialGradient(0, 0, 10, 0, 0, boss.size / 2);
    grad.addColorStop(0, '#ff4444');
    grad.addColorStop(1, 'transparent');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(0, 0, boss.size / 2 + Math.sin(time*2)*10, 0, Math.PI*2);
    ctx.fill();

    // 核心
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(0, 0, 30, 0, Math.PI*2);
    ctx.fill();
    
    ctx.restore();
}

function drawBossHealth(ctx, canvas) {
    const bw = 400, bh = 15, bx = (canvas.width - bw) / 2, by = 40;
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(bx, by, bw, bh);
    const hpWidth = (boss.hp / boss.maxHp) * bw;
    ctx.fillStyle = '#ff4444';
    ctx.fillRect(bx, by, hpWidth, bh);
    ctx.strokeStyle = '#fff';
    ctx.strokeRect(bx, by, bw, bh);
    
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 14px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText("BOSS HP", canvas.width / 2, by - 10);
}

function drawBow(ctx, canvas, judgeY) {
    const bowX = canvas.width / 2;
    const pull = normalizedPressure * 120;
    ctx.strokeStyle = boss.active ? '#ff4444' : '#facc15'; 
    ctx.lineWidth = 8; ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(bowX - 150, judgeY - 20);
    ctx.quadraticCurveTo(bowX, judgeY - 80 + pull/2, bowX + 150, judgeY - 20);
    ctx.stroke();
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(bowX - 150, judgeY - 20);
    ctx.lineTo(bowX, judgeY + pull); ctx.lineTo(bowX + 150, judgeY - 20);
    ctx.stroke();
    if (normalizedPressure > 0.1) {
        ctx.fillStyle = boss.active ? '#ff4444' : '#4ade80';
        ctx.fillRect(bowX - 2, judgeY - 40 + pull, 4, -60);
    }
}

function drawPressureBar(ctx, canvas, judgeY) {
    const w = 20, h = 200, x = 30, y = judgeY - h / 2;
    ctx.fillStyle = 'rgba(255,255,255,0.2)'; ctx.fillRect(x, y, w, h);
    ctx.fillStyle = 'rgba(74, 222, 128, 0.4)'; ctx.fillRect(x, y + h * (1 - 0.6), w, h * 0.4);
    ctx.fillStyle = 'rgba(250, 204, 21, 0.4)'; ctx.fillRect(x, y + h * (1 - 1.0), w, h * 0.25);
    ctx.fillStyle = boss.active ? '#ff4444' : '#facc15'; 
    ctx.fillRect(x, y + h - (normalizedPressure * h), w, normalizedPressure * h);
    ctx.strokeStyle = '#fff'; ctx.strokeRect(x, y, w, h);
}

// --- 音效與資源 ---
function initTensionSound() {
    tensionOsc = audioCtx.createOscillator();
    tensionGain = audioCtx.createGain();
    tensionOsc.type = 'sawtooth'; tensionOsc.frequency.value = 50;
    tensionGain.gain.value = 0;
    tensionOsc.connect(tensionGain); tensionGain.connect(audioCtx.destination);
    tensionOsc.start();
}

function updateTensionSound(press) {
    if (!tensionGain) return;
    tensionGain.gain.setTargetAtTime(press * 0.1, audioCtx.currentTime, 0.1);
    tensionOsc.frequency.setTargetAtTime(50 + press * 200, audioCtx.currentTime, 0.1);
}

function playLevelUpSound() {
    const freqs = [523.25, 659.25, 783.99, 1046.50];
    freqs.forEach((f, i) => {
        const o = audioCtx.createOscillator(); const g = audioCtx.createGain();
        o.connect(g); g.connect(audioCtx.destination);
        o.frequency.setValueAtTime(f, audioCtx.currentTime + i * 0.1);
        g.gain.setValueAtTime(0.3, audioCtx.currentTime + i * 0.1);
        g.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + i * 0.1 + 0.4);
        o.start(audioCtx.currentTime + i * 0.1); o.stop(audioCtx.currentTime + i * 0.1 + 0.4);
    });
}

function playHitSound(freq) {
    if (!audioCtx) return;
    const o = audioCtx.createOscillator(); const g = audioCtx.createGain();
    o.connect(g); g.connect(audioCtx.destination);
    o.frequency.setValueAtTime(freq, audioCtx.currentTime);
    g.gain.setValueAtTime(0.6, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.2);
    o.start(); o.stop(audioCtx.currentTime + 0.2);
}

async function loadAllAssets() {
    const loadImg = (src) => new Promise(res => {
        const img = new Image(); img.crossOrigin = "anonymous"; img.src = src;
        img.onload = () => res(img); img.onerror = () => res(null);
    });
    const loadAudio = async (src) => {
        try { const resp = await fetch(src); return await resp.arrayBuffer(); } catch { return null; }
    };
    const tasks = [];
    for (let k in ASSET_FILES) {
        if (k === 'bgm') tasks.push(loadAudio(ASSET_FILES[k]).then(buf => audioBuffer = buf));
        else tasks.push(loadImg(ASSET_FILES[k]).then(img => images[k] = img));
    }
    await Promise.all(tasks);
}

function startAudio() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
}

async function playBGM() {
    if (!audioBuffer || !audioCtx || bgmSource) return;
    const decodedBuf = await audioCtx.decodeAudioData(audioBuffer.slice(0));
    bgmSource = audioCtx.createBufferSource();
    bgmSource.buffer = decodedBuf; bgmSource.loop = true;
    bgmGainNode = audioCtx.createGain(); bgmGainNode.gain.value = 0.3;
    bgmSource.connect(bgmGainNode); bgmGainNode.connect(audioCtx.destination);
    bgmSource.start(0);
}

function addLabel(x, y, text, color) { labels.push({ x, y, text, color, life: 1.0 }); }
class Particle {
    constructor(x, y, color) {
        this.x = x; this.y = y; this.color = color;
        this.vx = (Math.random() - 0.5) * 15; this.vy = (Math.random() - 0.5) * 15; this.life = 1.0;
    }
    update() { this.x += this.vx; this.y += this.vy; this.vy += 0.4; this.life -= 0.03; }
    draw(ctx) {
        ctx.globalAlpha = this.life; ctx.fillStyle = this.color;
        ctx.beginPath(); ctx.arc(this.x, this.y, 4, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 1;
    }
}
function createParticles(x, y, c) { for (let i = 0; i < 20; i++) particles.push(new Particle(x, y, c)); }

export async function onConnected() {
    omni.channelMode = omni.channelMode.map((_, idx) => (idx === 0 ? 'touch' : (idx < 5 ? 'adc' : 'dig')));
    omni.activeMask = FF_ACTIVE_MASK; omni.pullupMask = FF_PULLUP_MASK;
    await applyDeviceConfig({
        freq: omni.lastFreq || 100, res: omni.lastRes || 1,
        activeMask: omni.activeMask, pullupMask: omni.pullupMask,
        touchMask: computeTouchModeMask()
    });
}

export async function unmount() {
    window.removeEventListener('resize', null);
    window.removeEventListener('omnisense:data', window.__ffOnData);
    cancelAnimationFrame(animationId);
    if (bgmSource) { bgmSource.stop(); bgmSource = null; }
    if (tensionOsc) { tensionOsc.stop(); tensionOsc = null; }
    await audioCtx?.close();
}