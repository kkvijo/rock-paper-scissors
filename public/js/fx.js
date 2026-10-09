/* =========================================================
   Effects — Web Audio blips + confetti (no asset files)
   ========================================================= */

let audioCtx = null;
let muted = false;
function ac() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function tone(freq, at, dur, type = 'sine', peak = 0.16) {
  const ctx = ac();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  osc.connect(gain);
  gain.connect(ctx.destination);
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(peak, at + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.001, at + dur);
  osc.start(at);
  osc.stop(at + dur + 0.02);
}

const SOUNDS = {
  win:   (t) => { tone(523.25, t, .18, 'triangle'); tone(659.25, t + .1, .18, 'triangle'); tone(783.99, t + .2, .32, 'triangle'); },
  lose:  (t) => { tone(220, t, .22, 'sawtooth', .08); tone(164.8, t + .15, .34, 'sawtooth', .08); },
  draw:  (t) => { tone(392, t, .14, 'sine', .12); tone(392, t + .16, .14, 'sine', .12); },
  lock:  (t) => { tone(880, t, .08, 'square', .05); tone(1320, t + .05, .1, 'square', .04); },
  tick:  (t) => { tone(1000, t, .05, 'square', .04); },
  found: (t) => { tone(440, t, .12, 'triangle'); tone(660, t + .1, .12, 'triangle'); tone(880, t + .2, .25, 'triangle'); },
  invite:(t) => { tone(740, t, .12, 'sine', .14); tone(988, t + .14, .2, 'sine', .14); },
  victory:(t) => { [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(f, t + i * .11, .35, 'triangle', .14)); },
  defeat:(t) => { [392, 329.6, 261.6].forEach((f, i) => tone(f, t + i * .16, .4, 'sine', .12)); }
};

export function play(name) {
  if (muted || !SOUNDS[name]) return;
  try { SOUNDS[name](ac().currentTime); } catch { /* audio unavailable */ }
}

// ---------- Confetti ----------
const canvas = document.getElementById('confetti');
const ctx = canvas.getContext('2d');
let pieces = [];
let running = false;

function resize() {
  canvas.width = innerWidth * devicePixelRatio;
  canvas.height = innerHeight * devicePixelRatio;
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
}
addEventListener('resize', resize);
resize();

export function confetti(amount = 120) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const colors = ['#ffdd94', '#e3b04b', '#4fe08f', '#6fc8ec', '#ff7b5c', '#8b7cff'];
  for (let i = 0; i < amount; i++) {
    const fromLeft = i % 2 === 0;
    pieces.push({
      x: fromLeft ? -10 : innerWidth + 10,
      y: innerHeight * (0.55 + Math.random() * 0.3),
      vx: (fromLeft ? 1 : -1) * (6 + Math.random() * 9),
      vy: -(10 + Math.random() * 12),
      w: 6 + Math.random() * 6,
      h: 9 + Math.random() * 9,
      r: Math.random() * Math.PI,
      vr: -0.25 + Math.random() * 0.5,
      color: colors[(Math.random() * colors.length) | 0],
      life: 0
    });
  }
  if (!running) { running = true; requestAnimationFrame(frame); }
}

function frame() {
  ctx.clearRect(0, 0, innerWidth, innerHeight);
  for (const p of pieces) {
    p.vy += 0.42;
    p.vx *= 0.985;
    p.x += p.vx;
    p.y += p.vy;
    p.r += p.vr;
    p.life++;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.r);
    ctx.scale(1, Math.cos(p.life * 0.15));
    ctx.fillStyle = p.color;
    ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
    ctx.restore();
  }
  pieces = pieces.filter(p => p.y < innerHeight + 40 && p.life < 400);
  if (pieces.length) requestAnimationFrame(frame);
  else { running = false; ctx.clearRect(0, 0, innerWidth, innerHeight); }
}
