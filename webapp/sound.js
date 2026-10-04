// Звуки синтезируются WebAudio — без файлов. Вибрация через Telegram HapticFeedback.
//
// Почему звук мог пропадать: браузер разрешает звук только после жеста пользователя, а после
// сворачивания Telegram контекст засыпает (на iOS — в состояние «interrupted»). Поэтому:
//  - контекст будится любым касанием экрана, а не только отдельными кнопками;
//  - при возврате в приложение контекст пробуем разбудить сразу, а если система не дала —
//    пересоздаём его при следующем касании;
//  - пока приложение свёрнуто, контекст усыпляем сами, чтобы не было «хвостов» звука;
//  - выбор «звук вкл/выкл» хранится и на устройстве, и в облаке Telegram.
const tg = window.Telegram?.WebApp;
const AC = window.AudioContext || window.webkitAudioContext;
let ctx = null;
let primed = false; // в контексте уже проигран беззвучный буфер (нужно iOS внутри жеста)
let stale = false; // система не дала разбудить контекст — пересоздать при следующем касании
let enabled = true;
let ambOn = true; // фоновый звук карты (кнопка 🎵)
let touched = false; // игрок сам переключил звук — облачное значение больше не применяем
let ambTouched = false;
const listeners = new Set();

try { enabled = localStorage.getItem('sound') !== 'off'; } catch (e) { /* без localStorage */ }
try { ambOn = localStorage.getItem('ambient') !== 'off'; } catch (e) { /* без localStorage */ }
const cloud = tg?.isVersionAtLeast?.('6.9') ? tg.CloudStorage : null;
try {
  cloud?.getItem('sound', (err, v) => {
    if (!err && !touched && (v === 'on' || v === 'off')) apply(v === 'on', false);
  });
  cloud?.getItem('ambient', (err, v) => {
    if (!err && !ambTouched && (v === 'on' || v === 'off')) applyAmb(v === 'on', false);
  });
} catch (e) { /* старый клиент Telegram */ }

// iPhone: играть и в беззвучном режиме (выключается кнопкой 🔊 в игре)
try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) { /* нет API */ }

function apply(v, persist) {
  enabled = v;
  if (persist) {
    try { localStorage.setItem('sound', v ? 'on' : 'off'); } catch (e) { /* без localStorage */ }
    try { cloud?.setItem('sound', v ? 'on' : 'off'); } catch (e) { /* старый клиент Telegram */ }
  }
  listeners.forEach((fn) => fn(v));
  syncAmbient();
}

function applyAmb(v, persist) {
  ambOn = v;
  if (persist) {
    try { localStorage.setItem('ambient', v ? 'on' : 'off'); } catch (e) { /* без localStorage */ }
    try { cloud?.setItem('ambient', v ? 'on' : 'off'); } catch (e) { /* старый клиент Telegram */ }
  }
  listeners.forEach((fn) => fn(enabled));
  syncAmbient();
}

export function isAmbientEnabled() { return ambOn; }
export function setAmbientEnabled(v) {
  ambTouched = true;
  if (v) unlock();
  applyAmb(!!v, true);
}

export function isEnabled() { return enabled; }
/** Подписка на смену настройки (кнопка 🔊 должна показывать актуальное состояние). */
export function onChange(fn) { listeners.add(fn); }
export function setEnabled(v) {
  touched = true;
  apply(!!v, true);
  if (v) {
    unlock();
    play('pop'); // слышно сразу, что звук включился
  }
}
/** Какой фон играет сейчас (для отладки). */
export function ambientId() { return amb ? amb.id : null; }
/** Состояние для отладки: none | running | suspended | interrupted | closed. */
export function state() { return ctx ? ctx.state : 'none'; }

/** Будит звук. Вызывается из любого касания экрана (см. ниже), повторные вызовы безопасны. */
export function unlock() {
  if (!AC) return;
  if (ctx && (ctx.state === 'closed' || (stale && ctx.state !== 'running'))) {
    try { ctx.close(); } catch (e) { /* уже закрыт */ }
    ctx = null;
  }
  if (!ctx) {
    try { ctx = new AC(); } catch (e) { return; }
    primed = false;
    stale = false;
    ctx.onstatechange = syncAmbient;
  }
  if (ctx.state !== 'running') ctx.resume?.().catch(() => {});
  if (!primed) {
    primed = true;
    const src = ctx.createBufferSource();
    src.buffer = ctx.createBuffer(1, 1, 22050);
    src.connect(ctx.destination);
    src.start(0);
  }
  syncAmbient();
}

function wake() {
  if (!ctx || ctx.state === 'running' || ctx.state === 'closed') return;
  ctx.resume?.().catch(() => {});
  // если система не разбудила контекст за полсекунды, при следующем касании создаём новый
  setTimeout(() => { if (ctx && ctx.state !== 'running') stale = true; }, 500);
}

function sleep() {
  if (ctx && ctx.state === 'running') ctx.suspend?.().catch(() => {});
}

for (const ev of ['pointerdown', 'touchend', 'click', 'keydown']) {
  document.addEventListener(ev, () => { if (!ctx || ctx.state !== 'running') unlock(); }, { capture: true, passive: true });
}
document.addEventListener('visibilitychange', () => (document.hidden ? sleep() : wake()));
window.addEventListener('pageshow', wake);
window.addEventListener('focus', wake);
try {
  tg?.onEvent?.('activated', wake);
  tg?.onEvent?.('deactivated', sleep);
} catch (e) { /* старый клиент Telegram */ }

function ready() { return enabled && ctx && ctx.state === 'running'; }

function noiseBuffer(dur) {
  const len = Math.floor(ctx.sampleRate * dur);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
  return buf;
}

function tone(freq, start, dur, { type = 'sine', gain = 0.2, slide = 0, out = null } = {}) {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, start);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), start + dur);
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(gain, start + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  o.connect(g).connect(out || ctx.destination);
  o.start(start);
  o.stop(start + dur + 0.02);
}

/** Стук кубика о стол; strength 0..1. Звук зависит от поверхности текущей карты. */
export function knock(strength = 1) {
  if (!ready()) return;
  const t = ctx.currentTime;
  const k = strength;
  switch (surface) {
    case 'octagon': // глухо о мат
      noise(t, 0.09, { type: 'lowpass', freq: 380, q: 0.8, gain: 0.7 * k });
      tone(85 + Math.random() * 20, t, 0.1, { gain: 0.3 * k, slide: -25 });
      break;
    case 'ring': // пружинящий настил: удар и короткий «отзвук» досок
      noise(t, 0.08, { type: 'lowpass', freq: 520, q: 1, gain: 0.6 * k });
      tone(120, t, 0.18, { type: 'triangle', gain: 0.22 * k, slide: -50 });
      tone(95, t + 0.07, 0.12, { type: 'triangle', gain: 0.08 * k });
      break;
    case 'bar': // дерево: «ток»
      noise(t, 0.05, { type: 'bandpass', freq: 1100 + Math.random() * 400, q: 5, gain: 0.8 * k });
      tone(420 + Math.random() * 80, t, 0.07, { type: 'triangle', gain: 0.18 * k });
      break;
    case 'casino': // плотное сукно стола
      noise(t, 0.06, { type: 'bandpass', freq: 900 + Math.random() * 500, q: 1.6, gain: 0.5 * k });
      tone(140, t, 0.06, { type: 'triangle', gain: 0.12 * k });
      break;
    case 'space': // стекло и эхо
      [0, 0.13, 0.26].forEach((d, i) => {
        const g = 0.07 * k / (i + 1);
        tone(2300 + Math.random() * 300, t + d, 0.22, { gain: g });
        tone(3500 + Math.random() * 300, t + d, 0.15, { gain: g * 0.6 });
      });
      break;
    case 'beach': // мягкий шлепок в песок
      noise(t, 0.16, { type: 'lowpass', freq: 650, q: 0.5, gain: 0.45 * k, attack: 0.01 });
      noise(t + 0.02, 0.12, { type: 'highpass', freq: 3000, q: 0.5, gain: 0.08 * k });
      break;
    case 'snow': // хруст
      for (let i = 0; i < 5; i++) noise(t + i * 0.014 + Math.random() * 0.01, 0.03, { type: 'highpass', freq: 1400 + Math.random() * 1500, q: 0.7, gain: 0.3 * k });
      break;
    default: { // сукно
      const src = ctx.createBufferSource();
      src.buffer = noiseBuffer(0.07);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1500 + Math.random() * 1200;
      bp.Q.value = 2.5;
      const g = ctx.createGain();
      g.gain.value = 0.5 * k;
      src.connect(bp).connect(g).connect(ctx.destination);
      src.start(t);
      tone(170 + Math.random() * 50, t, 0.06, { type: 'triangle', gain: 0.12 * k });
    }
  }
}

/** Шорох кубиков в руке перед броском */
export function shake() {
  if (!ready()) return;
  duck();
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
  // ринг: рефери считает «раз-два-три»
  count() {
    const t = ctx.currentTime;
    [0, 0.45, 0.9].forEach((d) => {
      tone(210, t + d, 0.22, { type: 'sawtooth', gain: 0.07, slide: -40 });
      noise(t + d, 0.18, { type: 'bandpass', freq: 800, q: 3, gain: 0.18 });
    });
  },
  // бар
  cheers() {
    const t = ctx.currentTime;
    [[2637, 0], [3136, 0.015], [2794, 0.03]].forEach(([f, d]) => tone(f, t + d, 0.7, { gain: 0.06 }));
    noise(t, 0.04, { type: 'highpass', freq: 4000, q: 0.7, gain: 0.25 });
  },
  glassBreak() {
    const t = ctx.currentTime;
    noise(t, 0.35, { type: 'highpass', freq: 2500, q: 0.5, gain: 0.55 });
    for (let i = 0; i < 14; i++) tone(2500 + Math.random() * 4000, t + Math.random() * 0.45, 0.12 + Math.random() * 0.2, { gain: 0.035 });
  },
  hooray() {
    const t = ctx.currentTime;
    noise(t, 1.6, { type: 'bandpass', freq: 900, q: 0.7, gain: 0.45, attack: 0.15 });
    [196, 247, 294].forEach((f) => tone(f, t, 1.1, { type: 'sawtooth', gain: 0.03, slide: f * 0.35 }));
  },
  // казино
  jackpot() {
    const t = ctx.currentTime;
    [523, 659, 784, 1047, 1319, 1568].forEach((f, i) => tone(f, t + i * 0.06, 0.12, { type: 'square', gain: 0.05 }));
    [0.45, 0.6, 0.75].forEach((d) => tone(2093, t + d, 0.3, { gain: 0.08 }));
    for (let i = 0; i < 10; i++) noise(t + 0.4 + i * 0.05, 0.04, { type: 'bandpass', freq: 3000 + Math.random() * 1500, q: 5, gain: 0.25 });
  },
  rubber() { const t = ctx.currentTime; tone(150, t, 0.12, { type: 'triangle', gain: 0.2, slide: -60 }); noise(t, 0.05, { type: 'lowpass', freq: 600, gain: 0.3 }); },
  // космос
  whoosh() { const t = ctx.currentTime; noise(t, 0.6, { type: 'bandpass', freq: 600, q: 2, gain: 0.35, attack: 0.25 }); tone(300, t, 0.5, { gain: 0.05, slide: 900 }); },
  laser() { const t = ctx.currentTime; tone(1600, t, 0.22, { type: 'square', gain: 0.05, slide: -1300 }); tone(2400, t + 0.08, 0.18, { type: 'sawtooth', gain: 0.03, slide: -2000 }); },
  powerDown() { const t = ctx.currentTime; tone(520, t, 0.9, { type: 'sawtooth', gain: 0.06, slide: -460 }); tone(260, t, 0.9, { gain: 0.08, slide: -220 }); },
  warp() {
    const t = ctx.currentTime;
    tone(200, t, 1.4, { type: 'sawtooth', gain: 0.05, slide: 2200 });
    noise(t, 1.4, { type: 'bandpass', freq: 1500, q: 1.5, gain: 0.3, attack: 0.9 });
  },
  // пляж
  waveWash() { const t = ctx.currentTime; noise(t, 1.8, { type: 'lowpass', freq: 900, q: 0.6, gain: 0.55, attack: 0.6 }); noise(t + 0.6, 1.2, { type: 'highpass', freq: 3500, q: 0.5, gain: 0.08, attack: 0.3 }); },
  seagull() { seagull(ctx.currentTime, 0.09); },
  // снег
  sleigh() { sleigh(ctx.currentTime, 0.06); },
  creak() {
    const t = ctx.currentTime;
    for (let i = 0; i < 12; i++) tone(170 + Math.random() * 60, t + i * 0.04, 0.05, { type: 'sawtooth', gain: 0.05 });
  },
};

function seagull(t, gain, out = null) {
  [0, 0.32].forEach((d, i) => {
    tone(1700 - i * 150, t + d, 0.28, { type: 'triangle', gain, slide: -600, out });
    tone(2550 - i * 200, t + d, 0.2, { gain: gain * 0.35, slide: -800, out });
  });
}

function sleigh(t, gain, out = null) {
  for (let i = 0; i < 9; i++) {
    const d = i * 0.07 + Math.random() * 0.03;
    const f = 3200 + Math.random() * 2400;
    tone(f, t + d, 0.25, { gain, out });
    tone(f * 1.5, t + d, 0.15, { gain: gain * 0.4, out });
  }
}

// ---------- фон карты ----------
// Каждая карта — тихая петля (шум/дрон через фильтры) плюс редкие случайные звуки.
// Громкость фона ~в 3 раза ниже эффектов; на время броска фон приглушается.

let surface = 'felt'; // поверхность для стука кубиков
let ambId = null; // карта, фон которой должен играть
let amb = null; // { id, ctx, master, level, nodes, timer }
let noiseBuf = null;

function loopNoise(brown = false) {
  if (!noiseBuf || noiseBuf.sampleRate !== ctx.sampleRate || noiseBuf.ctx !== ctx) {
    const len = ctx.sampleRate * 4;
    const white = ctx.createBuffer(1, len, ctx.sampleRate);
    const br = ctx.createBuffer(1, len, ctx.sampleRate);
    const w = white.getChannelData(0), b = br.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      w[i] = Math.random() * 2 - 1;
      last = (last + 0.02 * w[i]) / 1.02;
      b[i] = last * 3.5;
    }
    noiseBuf = { white, br, ctx, sampleRate: ctx.sampleRate };
  }
  const src = ctx.createBufferSource();
  src.buffer = brown ? noiseBuf.br : noiseBuf.white;
  src.loop = true;
  return src;
}

/** Слой фона: шум через фильтр, громкость качается медленным LFO. */
function layer(a, { brown = false, type = 'bandpass', freq = 500, q = 1, gain = 1, lfo = 0, depth = 0, sweep = 0 }) {
  const src = loopNoise(brown);
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  const g = ctx.createGain();
  g.gain.value = gain;
  src.connect(f).connect(g).connect(a.master);
  src.start();
  a.nodes.push(src);
  if (lfo) {
    const o = ctx.createOscillator();
    o.frequency.value = lfo;
    const og = ctx.createGain();
    og.gain.value = gain * depth;
    o.connect(og).connect(g.gain);
    o.start();
    a.nodes.push(o);
    if (sweep) {
      const sg = ctx.createGain();
      sg.gain.value = sweep;
      o.connect(sg).connect(f.frequency);
    }
  }
}

function drone(a, freqs, gain, cutoff) {
  const f = ctx.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.value = cutoff;
  f.connect(a.master);
  for (const [fr, type] of freqs) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = fr;
    const g = ctx.createGain();
    g.gain.value = gain;
    o.connect(g).connect(f);
    o.start();
    a.nodes.push(o);
  }
  const l = ctx.createOscillator();
  l.frequency.value = 0.07;
  const lg = ctx.createGain();
  lg.gain.value = cutoff * 0.6;
  l.connect(lg).connect(f.frequency);
  l.start();
  a.nodes.push(l);
}

// [уровень, построение петли, случайные звуки, интервал между ними (с)]
const AMBIENT = {
  felt: [0.06, (a) => layer(a, { brown: true, type: 'lowpass', freq: 260, q: 0.5 }), null],
  octagon: [0.1, (a) => {
    layer(a, { freq: 480, q: 0.7, lfo: 0.13, depth: 0.35 });
    layer(a, { freq: 1200, q: 1, gain: 0.4, lfo: 0.21, depth: 0.5 });
  }, (t, out) => {
    if (Math.random() < 0.6) { // выкрик из зала
      const f = 240 + Math.random() * 120;
      tone(f, t, 0.3, { type: 'sawtooth', gain: 0.05, slide: -60, out });
      noise(t, 0.25, { type: 'bandpass', freq: 900, q: 3, gain: 0.12, out });
    } else { // свист
      tone(2200, t, 0.18, { gain: 0.04, slide: 400, out });
      tone(2600, t + 0.2, 0.3, { gain: 0.04, slide: -500, out });
    }
  }, [3, 8]],
  ring: [0.08, (a) => layer(a, { freq: 420, q: 0.7, lfo: 0.1, depth: 0.3 }), (t, out) => {
    if (Math.random() < 0.5) [0, 0.18].forEach((d) => tone(1900 + d * 600, t + d, 0.16, { gain: 0.04, out })); // тренер свистит
    else for (let i = 0; i < 8; i++) noise(t + i * 0.09 + Math.random() * 0.04, 0.04, { type: 'bandpass', freq: 1500, q: 1, gain: 0.15, out }); // хлопки
  }, [4, 9]],
  bar: [0.09, (a) => {
    layer(a, { freq: 320, q: 1.2, lfo: 4.3, depth: 0.5 });
    layer(a, { freq: 750, q: 1.4, gain: 0.7, lfo: 5.7, depth: 0.6 });
    layer(a, { freq: 1600, q: 1.6, gain: 0.35, lfo: 3.1, depth: 0.7 });
  }, (t, out) => {
    tone(2637 + Math.random() * 600, t, 0.4, { gain: 0.05, out });
    if (Math.random() < 0.4) tone(3300, t + 0.08, 0.35, { gain: 0.04, out });
  }, [2, 6]],
  casino: [0.08, (a) => layer(a, { freq: 600, q: 0.8, lfo: 0.15, depth: 0.3 }), (t, out) => {
    if (Math.random() < 0.6) {
      const base = [523, 587, 659, 784, 880][Math.floor(Math.random() * 5)];
      for (let i = 0; i < 5; i++) tone(base * (1 + i * 0.25), t + i * 0.07, 0.09, { type: 'square', gain: 0.025, out });
    } else for (let i = 0; i < 5; i++) noise(t + i * 0.04, 0.04, { type: 'bandpass', freq: 2800, q: 4, gain: 0.15, out });
  }, [3, 7]],
  space: [0.1, (a) => drone(a, [[55, 'sine'], [55.6, 'sine'], [110, 'triangle'], [164.8, 'sine']], 0.25, 420), (t, out) => {
    const f = 900 + Math.random() * 1200;
    tone(f, t, 0.5, { gain: 0.03, slide: (Math.random() - 0.5) * 800, out });
  }, [5, 11]],
  beach: [0.13, (a) => {
    layer(a, { type: 'lowpass', freq: 700, q: 0.5, lfo: 0.11, depth: 0.85 });
    layer(a, { type: 'highpass', freq: 3500, q: 0.4, gain: 0.15, lfo: 0.11, depth: 0.9 });
  }, (t, out) => seagull(t, 0.05, out), [6, 13]],
  snow: [0.1, (a) => {
    layer(a, { freq: 650, q: 1.6, lfo: 0.08, depth: 0.6, sweep: 380 });
    layer(a, { type: 'highpass', freq: 2500, q: 0.5, gain: 0.12, lfo: 0.13, depth: 0.7 });
  }, (t, out) => sleigh(t, 0.03, out), [8, 15]],
};

function stopAmbient() {
  if (!amb) return;
  const a = amb;
  amb = null;
  clearTimeout(a.timer);
  try {
    const t = a.ctx.currentTime;
    a.master.gain.cancelScheduledValues(t);
    a.master.gain.setTargetAtTime(0.0001, t, 0.15);
  } catch (e) { /* контекст уже закрыт */ }
  setTimeout(() => {
    for (const n of a.nodes) try { n.stop(); } catch (e) { /* уже остановлен */ }
    try { a.master.disconnect(); } catch (e) { /* уже отключён */ }
  }, 700);
}

function startAmbient(id) {
  const def = AMBIENT[id];
  if (!def) return;
  const [level, build, event, gap] = def;
  const master = ctx.createGain();
  master.gain.value = 0.0001;
  master.connect(ctx.destination);
  const a = { id, ctx, master, level, nodes: [], timer: null };
  build(a);
  master.gain.setTargetAtTime(level, ctx.currentTime, 0.6);
  if (event) {
    const next = () => {
      a.timer = setTimeout(() => {
        if (amb !== a) return;
        if (ctx === a.ctx && ctx.state === 'running') event(ctx.currentTime, master);
        next();
      }, (gap[0] + Math.random() * (gap[1] - gap[0])) * 1000);
    };
    next();
  }
  amb = a;
}

function syncAmbient() {
  const want = enabled && ambOn && ambId && ctx && ctx.state === 'running' ? ambId : null;
  if (amb && amb.id === want && amb.ctx === ctx) return;
  stopAmbient();
  if (want) startAmbient(want);
}

/** Приглушить фон на время броска, чтобы стук кубиков был слышен чётко. */
function duck() {
  if (!amb || amb.ctx !== ctx) return;
  const g = amb.master.gain, t = ctx.currentTime;
  g.cancelScheduledValues(t);
  g.setTargetAtTime(amb.level * 0.35, t, 0.05);
  g.setTargetAtTime(amb.level, t + 1.4, 0.5);
}

/** Карта для фона и стука кубиков; null — тишина (экран без игры). */
export function setAmbient(id) {
  surface = id || 'felt';
  ambId = id;
  syncAmbient();
}

/** Шум с фильтром: толпа, лязг, шорох. */
function noise(start, dur, { type = 'bandpass', freq = 1000, q = 1, gain = 0.3, attack = 0.005, out = null } = {}) {
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
  src.connect(f).connect(g).connect(out || ctx.destination);
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
