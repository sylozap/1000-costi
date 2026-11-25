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
let touched = false; // игрок сам переключил звук — облачное значение больше не применяем
const listeners = new Set();

try { enabled = localStorage.getItem('sound') !== 'off'; } catch (e) { /* без localStorage */ }
const cloud = tg?.isVersionAtLeast?.('6.9') ? tg.CloudStorage : null;
try {
  cloud?.getItem('sound', (err, v) => {
    if (!err && !touched && (v === 'on' || v === 'off')) apply(v === 'on', false);
  });
} catch (e) { /* старый клиент Telegram */ }

function syncAudioSession() {
  try { if (navigator.audioSession) navigator.audioSession.type = enabled ? 'playback' : 'auto'; } catch (e) { /* нет API */ }
}
syncAudioSession();

function apply(v, persist) {
  enabled = v;
  syncAudioSession();
  if (!enabled && ctx) {
    try { ctx.close().catch(() => {}); } catch (e) { /* уже закрыт */ }
    ctx = null;
  }
  if (persist) {
    try { localStorage.setItem('sound', v ? 'on' : 'off'); } catch (e) { /* без localStorage */ }
    try { cloud?.setItem('sound', v ? 'on' : 'off'); } catch (e) { /* старый клиент Telegram */ }
  }
  listeners.forEach((fn) => fn(v));
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
/** Состояние для отладки: none | running | suspended | interrupted | closed. */
export function state() { return ctx ? ctx.state : 'none'; }

/** Будит звук. Вызывается из любого касания экрана (см. ниже), повторные вызовы безопасны. */
export function unlock() {
  if (!enabled || !AC) return;
  if (ctx && (ctx.state === 'closed' || (stale && ctx.state !== 'running'))) {
    try { ctx.close(); } catch (e) { /* уже закрыт */ }
    ctx = null;
  }
  if (!ctx) {
    try { ctx = new AC(); } catch (e) { return; }
    primed = false;
    stale = false;
  }
  if (ctx.state !== 'running') ctx.resume?.().catch(() => {});
  if (!primed) {
    primed = true;
    const src = ctx.createBufferSource();
    src.buffer = ctx.createBuffer(1, 1, 22050);
    src.connect(ctx.destination);
    src.start(0);
  }
}

function wake() {
  if (!enabled || !ctx || ctx.state === 'running' || ctx.state === 'closed') return;
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
    case 'basketball':
      tone(172, t, 0.10, { type: 'triangle', gain: 0.27 * k, slide: -77 });
      noise(t, 0.035, { freq: 1550, q: 3, gain: 0.37 * k });
      break;
    case 'pirate':
      tone(260, t, 0.12, { type: 'triangle', gain: 0.22 * k, slide: -75 });
      noise(t, 0.07, { freq: 730, q: 3.5, gain: 0.42 * k });
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
    case 'football':
      tone(95, t, 0.08, { gain: 0.21 * k, slide: -35 });
      noise(t, 0.085, { type: 'lowpass', freq: 490, gain: 0.38 * k });
      break;
    case 'zen':
      tone(460, t, 0.07, { type: 'triangle', gain: 0.17 * k });
      noise(t + 0.01, 0.08, { type: 'highpass', freq: 2700, gain: 0.21 * k });
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
    // Дизель, два гудка, гидравлика и россыпь очков — в ритм разгрузки.
    tone(52, t, 0.85, { type: 'sawtooth', gain: 0.075, slide: 22 });
    noise(t, 0.8, { type: 'lowpass', freq: 180, gain: 0.12 });
    for (const d of [0.15, 0.45]) {
      tone(146, t + d, 0.24, { type: 'sawtooth', gain: 0.09 });
      tone(196, t + d, 0.24, { type: 'sawtooth', gain: 0.07 });
    }
    noise(t + 1.15, 0.55, { type: 'bandpass', freq: 1200, q: 2, gain: 0.1 });
    for (let i = 0; i < 8; i++) tone(600 + (i * 137 % 900), t + 1.5 + i * 0.08, 0.13, { type: 'triangle', gain: 0.055 });
    tone(70, t + 2.25, 0.25, { gain: 0.17, slide: -30 });
    tone(65, t + 3.1, 0.6, { type: 'sawtooth', gain: 0.065, slide: 45 });
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
  referee() {
    const t = ctx.currentTime;
    for (const d of [0, 0.18]) {
      tone(2690, t + d, 0.14, { gain: 0.09, slide: -170 });
      tone(2840, t + d, 0.12, { gain: 0.04 });
    }
  },
  goalRoar() {
    const t = ctx.currentTime;
    noise(t, 1.25, { freq: 820, q: 0.7, attack: 0.14, gain: 0.39 });
    for (const d of [0.08, 0.23, 0.41]) tone(395, t + d, 0.22, { type: 'sawtooth', gain: 0.04, slide: 38 });
  },
  missedGoal() {
    noise(ctx.currentTime, 0.46, { freq: 440, q: 1.2, attack: 0.08, gain: 0.27 });
  },
  dribble() {
    const t = ctx.currentTime;
    for (const d of [0, 0.24, 0.41]) {
      tone(145, t + d, 0.13, { type: 'triangle', gain: 0.23, slide: -72 });
      noise(t + d, 0.046, { freq: 940, q: 2.2, gain: 0.3 });
    }
  },
  swish() {
    const t = ctx.currentTime;
    noise(t, 0.29, { freq: 2460, q: 0.65, attack: 0.045, gain: 0.35 });
    tone(130, t + 0.12, 0.09, { gain: 0.1, slide: -53 });
  },
  courtBuzzer() {
    const t = ctx.currentTime;
    tone(138, t, 0.58, { type: 'sawtooth', gain: 0.085 });
    tone(277, t, 0.54, { type: 'square', gain: 0.042 });
  },
  bamboo() {
    const t = ctx.currentTime;
    tone(525, t, 0.17, { type: 'triangle', gain: 0.13 });
    tone(1100, t, 0.07, { gain: 0.065 });
    noise(t + 0.08, 0.27, { type: 'lowpass', freq: 1180, gain: 0.15, attack: 0.05 });
  },
  gardenChime() {
    const t = ctx.currentTime;
    [988, 1319, 1661].forEach((f, i) => tone(f, t + i * 0.14, 0.72, { gain: 0.075 }));
  },
  shipBell() {
    const t = ctx.currentTime;
    for (const [f, gain] of [[385, 0.13], [726, 0.08], [1120, 0.05], [1694, 0.035]]) {
      tone(f, t, 1.25, { gain });
    }
    noise(t, 1, { type: 'lowpass', freq: 870, attack: 0.27, gain: 0.18 });
  },
  shipCreak() {
    const t = ctx.currentTime;
    tone(156, t, 0.33, { type: 'sawtooth', gain: 0.055, slide: -64 });
    noise(t, 0.27, { freq: 670, q: 4, gain: 0.24 });
  },
  pirateCoins() {
    const t = ctx.currentTime;
    [1870, 2320, 1720, 2620, 2110, 3080].forEach((f, i) => {
      tone(f, t + i * 0.051, 0.23, { gain: 0.075 });
      noise(t + i * 0.051, 0.032, { freq: f, q: 4, gain: 0.14 });
    });
  },
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

let surface = 'felt'; // поверхность карты для стука кубиков

/** Карта, по которой катятся кубики: от неё зависит звук стука. */
export function setSurface(id) {
  surface = id || 'felt';
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
