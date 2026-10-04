// Звуки синтезируются WebAudio — без файлов. Вибрация через Telegram HapticFeedback.
const tg = window.Telegram?.WebApp;
let ctx = null;
let enabled = true;
try { enabled = localStorage.getItem('sound') !== 'off'; } catch (e) { /* без localStorage */ }

export function isEnabled() { return enabled; }
export function setEnabled(v) {
  enabled = v;
  try { localStorage.setItem('sound', v ? 'on' : 'off'); } catch (e) { /* без localStorage */ }
}

/** Вызывать из обработчика нажатия: браузеры разрешают звук только после жеста. */
export function unlock() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) ctx = new AC();
  }
  if (ctx && ctx.state === 'suspended') ctx.resume();
}

function ready() { return enabled && ctx && ctx.state === 'running'; }

function noiseBuffer(dur) {
  const len = Math.floor(ctx.sampleRate * dur);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
  return buf;
}

function tone(freq, start, dur, { type = 'sine', gain = 0.2, slide = 0 } = {}) {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, start);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), start + dur);
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(gain, start + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  o.connect(g).connect(ctx.destination);
  o.start(start);
  o.stop(start + dur + 0.02);
}

/** Стук кубика о стол; strength 0..1 */
export function knock(strength = 1) {
  if (!ready()) return;
  const t = ctx.currentTime;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(0.07);
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 1800 + Math.random() * 1600;
  bp.Q.value = 2.5;
  const g = ctx.createGain();
  g.gain.value = 0.55 * strength;
  src.connect(bp).connect(g).connect(ctx.destination);
  src.start(t);
  tone(180 + Math.random() * 60, t, 0.06, { type: 'triangle', gain: 0.12 * strength });
}

/** Шорох кубиков в руке перед броском */
export function shake() {
  if (!ready()) return;
  const t = ctx.currentTime;
  for (let i = 0; i < 7; i++) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(0.04);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 2500;
    const g = ctx.createGain();
    g.gain.value = 0.18;
    src.connect(hp).connect(g).connect(ctx.destination);
    src.start(t + i * 0.035 + Math.random() * 0.015);
  }
}

const SFX = {
  score() { const t = ctx.currentTime; tone(880, t, 0.12, { gain: 0.12 }); tone(1320, t + 0.07, 0.18, { gain: 0.1 }); },
  commit() { const t = ctx.currentTime; [660, 880, 1100].forEach((f, i) => tone(f, t + i * 0.07, 0.2, { type: 'triangle', gain: 0.13 })); },
  zero() { const t = ctx.currentTime; tone(220, t, 0.35, { type: 'sawtooth', gain: 0.08, slide: -120 }); },
  bolt() { const t = ctx.currentTime; tone(160, t, 0.15, { type: 'square', gain: 0.1 }); tone(120, t + 0.12, 0.3, { type: 'square', gain: 0.1 }); },
  hot() { const t = ctx.currentTime; [523, 659, 784, 1047].forEach((f, i) => tone(f, t + i * 0.06, 0.16, { type: 'triangle', gain: 0.12 })); },
  overtake() { const t = ctx.currentTime; tone(400, t, 0.4, { type: 'sawtooth', gain: 0.06, slide: 900 }); },
  samosval() {
    const t = ctx.currentTime;
    tone(196, t, 0.45, { type: 'sawtooth', gain: 0.12 }); tone(247, t, 0.45, { type: 'sawtooth', gain: 0.1 });
    tone(196, t + 0.55, 0.7, { type: 'sawtooth', gain: 0.12 }); tone(247, t + 0.55, 0.7, { type: 'sawtooth', gain: 0.1 });
    tone(300, t + 1.1, 0.9, { type: 'sawtooth', gain: 0.08, slide: -240 });
  },
  barrel() { const t = ctx.currentTime; tone(110, t, 0.25, { type: 'sine', gain: 0.3 }); tone(90, t + 0.18, 0.3, { type: 'sine', gain: 0.25 }); },
  fall() { const t = ctx.currentTime; tone(700, t, 0.6, { type: 'triangle', gain: 0.12, slide: -600 }); tone(80, t + 0.55, 0.3, { gain: 0.35 }); },
  win() {
    const t = ctx.currentTime;
    [523, 659, 784, 1047, 784, 1047].forEach((f, i) => tone(f, t + i * 0.12, 0.3, { type: 'triangle', gain: 0.14 }));
  },
  turn() { const t = ctx.currentTime; tone(988, t, 0.12, { gain: 0.1 }); tone(1319, t + 0.1, 0.2, { gain: 0.1 }); },
  pop() { const t = ctx.currentTime; tone(600, t, 0.08, { gain: 0.08, slide: 400 }); },
  // ---- арены ----
  gong() {
    const t = ctx.currentTime;
    [[98, 0.22], [147, 0.12], [233, 0.08], [311, 0.05], [467, 0.03]].forEach(([f, g]) => tone(f, t, 2.6, { gain: g }));
    noise(t, 0.25, { type: 'bandpass', freq: 900, q: 1, gain: 0.25 });
  },
  bell() {
    const t = ctx.currentTime;
    [0, 0.32].forEach((d) => [[1250, 0.12], [2510, 0.05], [3780, 0.03]].forEach(([f, g]) => tone(f, t + d, 0.9, { gain: g })));
  },
  crowd() {
    const t = ctx.currentTime;
    noise(t, 1.8, { type: 'bandpass', freq: 700, q: 0.6, gain: 0.5, attack: 0.35 });
    noise(t + 0.1, 1.6, { type: 'bandpass', freq: 1500, q: 0.8, gain: 0.25, attack: 0.3 });
  },
  boo() {
    const t = ctx.currentTime;
    [140, 151, 163].forEach((f) => tone(f, t, 1.2, { type: 'sawtooth', gain: 0.035, slide: -30 }));
    noise(t, 1.1, { type: 'lowpass', freq: 500, q: 0.7, gain: 0.25, attack: 0.25 });
  },
  rattle() {
    const t = ctx.currentTime;
    for (let i = 0; i < 4; i++) noise(t + i * 0.03, 0.12, { type: 'bandpass', freq: 3500 + Math.random() * 2500, q: 6, gain: 0.35 });
  },
  rope() { const t = ctx.currentTime; tone(85, t, 0.25, { type: 'triangle', gain: 0.25, slide: -30 }); },
  clink() { const t = ctx.currentTime; tone(2637, t, 0.5, { gain: 0.07 }); tone(3520, t + 0.06, 0.45, { gain: 0.05 }); },
  chips() {
    const t = ctx.currentTime;
    for (let i = 0; i < 6; i++) noise(t + i * 0.045, 0.05, { type: 'bandpass', freq: 2600 + Math.random() * 900, q: 4, gain: 0.3 });
  },
};

/** Шум с фильтром: толпа, лязг, шорох. */
function noise(start, dur, { type = 'bandpass', freq = 1000, q = 1, gain = 0.3, attack = 0.005 } = {}) {
  const src = ctx.createBufferSource();
  const len = Math.floor(ctx.sampleRate * dur);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  src.buffer = buf;
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(gain, start + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  src.connect(f).connect(g).connect(ctx.destination);
  src.start(start);
}

export function play(name) {
  if (ready() && SFX[name]) SFX[name]();
}

const hf = tg?.isVersionAtLeast?.('6.1') ? tg.HapticFeedback : null;
export const haptic = {
  impact(style = 'light') { hf?.impactOccurred(style); },
  notify(type) { hf?.notificationOccurred(type); },
  select() { hf?.selectionChanged(); },
};
