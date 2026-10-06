import { lineChart, seriesColor } from './charts.js';
import { customFaceCanvas, DiceTable, faceCanvas } from './dice3d.js';
import { MAP_ICONS } from './maps.js';
import * as snd from './sound.js';
import { renderGameDetail, renderProfile, renderRecords } from './views.js';

const tg = window.Telegram?.WebApp;
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

const BARREL_DESC = {
  none: 'Побеждает тот, кто первым наберёт 1000 и больше.',
  points: 'С бочки нужно за один ход добрать до 1000; на бочке могут сидеть несколько.',
  open: 'Нужно набрать ровно 1000, перебор — точка.',
  knock: 'На бочке только один: кто залез, сбрасывает сидящего вниз.',
};
const MINI_PIPS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };

let ws = null;
let me = null;
let isAdmin = false;
let spectate = params.get('spectate') === '1';
let roomId = params.get('room') || tg?.initDataUnsafe?.start_param || null;
let state = null;
let queue = [];
let busy = false;
let animating = false;
let lastRollId = null;
let seen = new Set();
let fresh = true; // следующее состояние — первое после подключения: без анимаций и звуков
let reconnectDelay = 500;
let clockOffset = 0;
let finishShownFor = null;
let prevCurrent = null;
const prevScores = new Map();
let myPresets = [];
let finishAch = [];
let finishBank = null;
let prevMap = null;
let pmUid = null; // игрок, открытый в админском окне
const customDice = {}; // скин «c_…» → { faces: [адреса граней], name, ver }
let diceAdmin = null; // последний список кубиков с картинками (админ)
let de = null; // редактор кубика: { id, name, faces: [{ src, st: 'new'|'keep'|'none' }] }
// ---------- Telegram ----------
if (tg) {
  tg.ready();
  tg.expand();
  tg.disableVerticalSwipes?.();
}

// Звуки карт: событие → звук (sound.js). Стук кубиков о поверхность — в sound.js по id карты.
const MAP_SFX = {
  felt: { preview: 'commit' },
  octagon: { preview: 'gong', start: 'gong', turn: 'gong', big: 'crowd', bolt: 'boo', wall: 'rattle', samosval: 'crowd', win: 'crowd' },
  ring: { preview: 'bell', start: 'bell', turn: 'bell', big: 'crowd', bolt: 'count', wall: 'rope', samosval: 'crowd', win: 'crowd' },
  bar: { preview: 'cheers', commit: 'cheers', big: 'clink', samosval: 'glassBreak', win: 'hooray' },
  casino: { preview: 'jackpot', commit: 'chips', big: 'jackpot', wall: 'rubber', win: 'jackpot' },
  space: { preview: 'whoosh', throw: 'whoosh', commit: 'laser', zero: 'powerDown', samosval: 'powerDown', win: 'warp' },
  beach: { preview: 'seagull', zero: 'waveWash', big: 'seagull', win: 'seagull' },
  snow: { preview: 'sleigh', commit: 'sleigh', zero: 'creak', win: 'sleigh' },
};
const mapId = () => state?.settings?.map || 'felt';
const isFightMap = () => mapId() === 'octagon' || mapId() === 'ring';
/** Звук карты для события; true — у карты есть свой звук. */
function mapSfx(kind) {
  const name = MAP_SFX[mapId()]?.[kind];
  if (name) snd.play(name);
  return !!name;
}

const table = new DiceTable($('table3d'), {
  onThrow: () => {
    snd.shake();
    mapSfx('throw');
  },
  onWall: (i) => {
    if (i < 2) mapSfx('wall');
  },
  onImpact: (strength, i) => {
    if (strength > 0.3 || i % 2 === 0) snd.knock(strength);
    if (strength === 1 && i === 0) snd.haptic.impact('light');
  },
});

// ---------- связь ----------
function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function hello() {
  send({
    type: 'hello',
    initData: tg?.initData || '',
    room: roomId,
    spectate,
    dev_uid: params.get('dev_uid'),
    dev_name: params.get('dev_name'),
  });
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => {
    reconnectDelay = 500;
    fresh = true;
    $('conn').classList.add('hidden');
    hello();
  };
  ws.onmessage = (e) => onMessage(JSON.parse(e.data));
  ws.onclose = () => {
    $('conn').classList.remove('hidden');
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 8000);
  };
}

/** Переход в другую комнату (админ: наблюдение за любой игрой). */
function openRoom(id, asSpectator) {
  roomId = id;
  spectate = asSpectator;
  queue = [];
  fresh = true;
  seen = new Set();
  lastRollId = null;
  prevScores.clear();
  finishShownFor = null;
  hello();
}

function setAdmin(v) {
  isAdmin = !!v;
  $('adminBtn').classList.toggle('hidden', !isAdmin);
  $('msgAdminBtn').classList.toggle('hidden', !isAdmin);
}

function onMessage(m) {
  switch (m.type) {
    case 'hello_ok':
      me = m.uid;
      roomId = m.room;
      setAdmin(m.is_admin);
      break;
    case 'state':
      clockOffset = m.state.server_now - Date.now();
      queue.push(m.state);
      if (!busy) pump();
      break;
    case 'no_room':
      me = m.uid;
      setAdmin(m.is_admin);
      showMessage('Нет активной игры', 'Напиши /newgame в группе с друзьями — бот пришлёт кнопку «Играть».');
      break;
    case 'error':
      if (m.code === 'auth') showMessage('Нужен Telegram', m.message);
      else showError(m.message);
      if (state) render(state);
      break;
    case 'reaction':
      showReaction(m);
      break;
    case 'sticker':
      showSticker(m);
      break;
    case 'announce':
      showAnnounce(m.text);
      break;
    case 'achievement':
      onAchievement(m);
      break;
    case 'achievements':
      renderAchievements(m.list);
      break;
    case 'presets':
      myPresets = m.list;
      if (state?.status === 'lobby') renderLobby(state);
      break;
    case 'preset_saved':
      onPresetSaved(m);
      break;
    case 'admin_audit':
      renderAudit(m.list);
      break;
    case 'admin_rooms':
      renderAdminRooms(m.list);
      break;
    case 'admin_games':
      admGames = m;
      renderAdminGames();
      if (m.text) showInfo(m.text);
      break;
    case 'admin_ok':
      showInfo(m.text);
      break;
    case 'profile':
      registerCustom(m.custom_dice);
      renderSkins(m);
      break;
    case 'admin_dice':
      onDiceAdmin(m);
      break;
    case 'profile_full':
      registerCustom(m.custom_dice);
      renderProfile($('profileBody'), m, viewCtx);
      openSheet('profileModal');
      break;
    case 'records':
      renderRecords($('recordsBody'), m, viewCtx);
      openSheet('recordsModal');
      break;
    case 'game_detail':
      renderGameDetail($('gameBody'), m.game, viewCtx);
      openSheet('gameModal');
      break;
    case 'bank':
      finishBank = m;
      snd.play('chips');
      toast('💰', `${m.uid === me ? 'Ты забираешь' : m.name + ' забирает'} банк: ${m.amount} 🪙`, 2400);
      break;
    case 'left':
      showError('Ты вышел из игры');
      break;
    case 'kicked':
      showError('Тебя исключили из игры');
      break;
  }
}

// ---------- очередь состояний и анимации ----------
function skinFor(s, roll) {
  return s.cosmetics?.skins?.[roll.uid] || (s.cosmetics?.gold?.includes(roll.uid) ? 'gold' : 'ivory');
}

async function pump() {
  busy = true;
  while (queue.length) {
    const s = queue.shift();
    const g = s.game;
    const roll = g?.last_roll || null;
    if (!g) {
      seen = new Set();
      lastRollId = null;
    }
    if (fresh) {
      fresh = false;
      g?.log.forEach((e) => seen.add(e.id));
      if (roll) {
        lastRollId = roll.id;
        table.setSkin(skinFor(s, roll));
        table.showStatic(roll.dice, roll.scoring, roll.seed, roll);
      }
      render(s);
      continue;
    }
    if (roll && roll.id !== lastRollId) {
      lastRollId = roll.id;
      table.setSkin(skinFor(s, roll));
      const newerRoll = queue.some((q) => q.game?.last_roll && q.game.last_roll.id !== roll.id);
      if (newerRoll) {
        table.showStatic(roll.dice, roll.scoring, roll.seed, roll);
      } else {
        animating = true;
        if (state) renderActions(state);
        await table.throwDice(roll);
        animating = false;
        showRollBadge(roll, s);
      }
    }
    render(s);
    await processEvents(s);
  }
  busy = false;
}

const toastQueue = [];
let toastBusy = false;

function toast(emoji, text, ms = 1500, cls = '') {
  toastQueue.push({ emoji, text, ms, cls, at: Date.now() });
  if (!toastBusy) nextToast();
}

function nextToast() {
  // устаревшие объявления (например, после быстрой серии событий) пропускаем
  while (toastQueue.length && Date.now() - toastQueue[0].at > 3500) toastQueue.shift();
  const t = toastQueue.shift();
  if (!t) {
    toastBusy = false;
    return;
  }
  toastBusy = true;
  const el = $('toast');
  $('toastEmoji').textContent = t.emoji;
  $('toastText').textContent = t.text;
  el.className = 'toast ' + t.cls;
  void el.offsetWidth; // перезапуск анимации
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => {
      el.classList.add('hidden');
      nextToast();
    }, 330);
  }, t.ms);
}

function nameOf(s, uid) {
  return s.game?.players.find((p) => p.uid === uid)?.name || s.members.find((p) => p.uid === uid)?.name || '';
}

function chipEl(uid) {
  return document.querySelector(`.pchip[data-uid="${uid}"]`);
}

function flashChip(uid) {
  const el = chipEl(uid);
  if (!el) return;
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
}

async function processEvents(s) {
  const g = s.game;
  if (!g) return;
  const r = s.rules;
  for (const e of g.log) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    const mine = e.uid === me;
    const fight = isFightMap();
    switch (e.kind) {
      case 'roll':
        snd.play(g.last_roll?.points ? 'score' : 'zero');
        if (g.last_roll?.points >= 100) mapSfx('big');
        if (!g.last_roll?.points) mapSfx('zero');
        if (mine && !g.last_roll?.points) snd.haptic.notify('error');
        break;
      case 'hot':
        snd.play('hot');
        toast('🔥', r.hot_dice === 'free' ? 'Все кубики сыграли!' : 'Все кубики сыграли! Подтверди броском');
        break;
      case 'hot_saved':
        snd.play('commit');
        toast('🛟', 'Подтверждение пустое, но очки записаны');
        break;
      case 'commit':
      case 'debt':
        snd.play('commit');
        if (e.kind === 'commit') mapSfx('commit');
        if (mine) snd.haptic.notify('success');
        break;
      case 'limit':
        toast('✋', 'Лимит бросков');
        break;
      case 'bolt':
        snd.play('bolt');
        mapSfx('bolt');
        flashChip(e.uid);
        if (mine) snd.haptic.notify('warning');
        break;
      case 'bolt_penalty':
        snd.play('bolt');
        flashChip(e.uid);
        flyPenalty(e.uid, `−${r.bolt_penalty}`);
        toast('🔩', `${nameOf(s, e.uid)}: болты — штраф`);
        if (mine) snd.haptic.notify('error');
        break;
      case 'samosval':
        snd.play('samosval');
        mapSfx('samosval');
        if (fight) caption('KO!', 'ko');
        fxTruck();
        flashChip(e.uid);
        toast('🚛', `Самосвал! ${nameOf(s, e.uid)} → 0`, 2200);
        snd.haptic.notify('error');
        break;
      case 'overtake':
        snd.play('overtake');
        flyPenalty(e.uid, `−${e.amount ?? r.overtake_penalty}`);
        toast('🏎', `${nameOf(s, e.by)} обогнал(а) ${nameOf(s, e.uid)}`);
        if (mine) snd.haptic.notify('warning');
        break;
      case 'tie_zero':
        snd.play('fall');
        flyPenalty(e.uid, '→ 0');
        toast('🎯', `${nameOf(s, e.by)} ровно сравнялся — ${nameOf(s, e.uid)} обнуляется!`, 2200);
        if (mine) snd.haptic.notify('error');
        break;
      case 'pit_enter':
        snd.play('fall');
        fxPit();
        break;
      case 'pit_fail':
        fxPit(true);
        break;
      case 'barrel_sit':
        snd.play('barrel');
        if (fight) caption('ROUND 2');
        fxBarrel();
        toast('🛢', `${nameOf(s, e.uid)} на бочке!`);
        break;
      case 'barrel_attempt':
        snd.play('zero');
        fxBarrel(true);
        break;
      case 'barrel_knock':
        snd.play('fall');
        fxBarrel();
        flyPenalty(e.uid, '🛢↓');
        toast('🛢💥', `${nameOf(s, e.by)} сбросил(а) ${nameOf(s, e.uid)} с бочки`);
        break;
      case 'barrel_fall':
      case 'barrel_off':
        snd.play('fall');
        flashChip(e.uid);
        if (e.kind === 'barrel_fall') flyPenalty(e.uid, `−${r.barrel_penalty}`);
        toast('💥', `${nameOf(s, e.uid)} упал(а) с бочки`);
        break;
      case 'barrel_zero':
        snd.play('fall');
        flashChip(e.uid);
        flyPenalty(e.uid, '→ 0');
        toast('💥', `${nameOf(s, e.uid)}: последнее падение — счёт 0!`, 2200);
        break;
      case 'dot':
        snd.play('zero');
        toast('•', `Перебор! Точка ${nameOf(s, e.uid)}`, 1100);
        break;
      case 'dot_penalty':
      case 'dot_zero':
        snd.play('fall');
        flashChip(e.uid);
        flyPenalty(e.uid, e.kind === 'dot_zero' ? '→ 0' : `−${r.dot_penalty}`);
        toast('•', e.kind === 'dot_zero' ? `${nameOf(s, e.uid)}: счёт обнулён!` : `${nameOf(s, e.uid)}: точки — штраф`, 2000);
        break;
      case 'order_done':
        toast('🎲', 'Очерёдность определена!');
        mapSfx('start');
        if (fight) caption('FIGHT!');
        break;
      case 'timeout':
        showError(e.text);
        break;
      case 'win':
        snd.play('win');
        mapSfx('win');
        if (fight) {
          const others = g.players.filter((p) => p.uid !== e.uid);
          caption(others.length && others.every((p) => p.score < 300) ? 'FLAWLESS VICTORY' : 'WINNER!', 'win');
        }
        snd.haptic.notify('success');
        break;
    }
  }
}

// ---------- анимации событий ----------
function fxAdd(cls, html, ms) {
  const el = document.createElement('div');
  el.className = 'fx ' + cls;
  el.innerHTML = html;
  $('fxLayer').appendChild(el);
  setTimeout(() => el.remove(), ms);
  return el;
}

/** Крупная надпись в стиле файтинга поверх стола. */
function caption(text, cls = '') {
  const el = $('fightCaption');
  el.textContent = text;
  el.className = 'fight-caption ' + cls;
  void el.offsetWidth;
  el.classList.add('show');
  clearTimeout(caption.t);
  caption.t = setTimeout(() => el.classList.add('hidden'), 1800);
}

function fxTruck() {
  fxAdd('fx-truck', '<span class="truck">🚛</span><span class="dust">💨</span>', 2600);
}

function fxPit(stay = false) {
  fxAdd('fx-pit' + (stay ? ' small' : ''), '<span class="hole">🕳</span><span class="shovel">🪏</span>', 1900);
}

function fxBarrel(small = false) {
  fxAdd('fx-barrel' + (small ? ' small' : ''), '<span class="barrel">🛢</span>', 1800);
}

/** «−50» вылетает из центра стола и прилетает в карточку игрока. */
function flyPenalty(uid, text) {
  const target = chipEl(uid);
  const from = $('tableWrap').getBoundingClientRect();
  if (!target) return;
  const to = target.getBoundingClientRect();
  const el = document.createElement('div');
  el.className = 'fly';
  el.textContent = text;
  el.style.left = `${from.left + from.width / 2}px`;
  el.style.top = `${from.top + from.height / 2}px`;
  $('flyLayer').appendChild(el);
  const dx = to.left + to.width * 0.75 - (from.left + from.width / 2);
  const dy = to.top + to.height / 2 - (from.top + from.height / 2);
  el.animate([
    { transform: 'translate(-50%, -50%) scale(.6)', opacity: 0 },
    { transform: 'translate(-50%, -50%) scale(1.5)', opacity: 1, offset: 0.25 },
    { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(.9)`, opacity: 1 },
  ], { duration: 1100, easing: 'cubic-bezier(.3,.7,.4,1)' }).onfinish = () => {
    el.remove();
    flashChip(uid);
    target.classList.add('hit');
    setTimeout(() => target.classList.remove('hit'), 500);
  };
}

function showSticker(m) {
  const el = document.createElement('div');
  el.className = 'sticker-pop';
  el.style.left = `${15 + Math.random() * 50}%`;
  el.style.top = `${10 + Math.random() * 40}%`;
  el.innerHTML = `<div class="st-emoji"></div><div class="st-text"></div><small></small>`;
  el.querySelector('.st-emoji').textContent = m.emoji;
  el.querySelector('.st-text').textContent = m.text;
  el.querySelector('small').textContent = m.name;
  $('reactionsLayer').appendChild(el);
  snd.play('pop');
  setTimeout(() => el.remove(), 2600);
}

function showAnnounce(text) {
  const el = $('announce');
  el.textContent = '📢 ' + text;
  el.classList.remove('hidden');
  void el.offsetWidth;
  el.classList.add('show');
  snd.play('turn');
  clearTimeout(showAnnounce.t);
  showAnnounce.t = setTimeout(() => {
    el.classList.remove('show');
    el.classList.add('hidden');
  }, 6000);
}

function onAchievement(m) {
  const mine = m.uid === me;
  toast(m.emoji, `${mine ? 'Ты получил(а)' : m.name + ':'} «${m.title}»`, 2400, 'toast-ach');
  snd.play('hot');
  if (mine) snd.haptic.notify('success');
  finishAch.push(m);
}

// ---------- отрисовка ----------
function showScreen(id) {
  for (const sid of ['screenMsg', 'screenLobby', 'screenGame']) $(sid).classList.toggle('hidden', sid !== id);
  $('app').classList.toggle('playing', id === 'screenGame');
}

// ---------- листы, меню, профиль ----------
function openSheet(id) {
  $(id).classList.remove('hidden');
  $(id).querySelector('.modal-card').scrollTop = 0;
}

function openProfile(uid) {
  send({ type: 'profile_full', uid });
}

const viewCtx = {
  get me() { return me; },
  avatar: (uid, name) => avatar(uid, name),
  skinSrc: (id) => swatch(id),
  mapName: (id) => mapName(id),
  openGame: (id) => send({ type: 'game_detail', id }),
  openProfile: (uid) => openProfile(uid),
};

function showMessage(title, text) {
  $('msgTitle').textContent = title;
  $('msgText').textContent = text;
  showScreen('screenMsg');
}

let errTimer = null;
function showError(text, cls = '') {
  const el = $('errorToast');
  el.textContent = text;
  el.className = 'error-toast ' + cls;
  clearTimeout(errTimer);
  errTimer = setTimeout(() => el.classList.add('hidden'), 2600);
}
const showInfo = (text) => showError(text, 'info');

function avatar(uid, name) {
  const el = document.createElement('div');
  el.className = 'avatar';
  el.style.background = `hsl(${(uid * 47) % 360} 65% 62%)`;
  el.textContent = ([...(name || '?').trim()][0] || '?').toUpperCase();
  return el;
}

function crowned(s, uid, name) {
  return (s.cosmetics?.badge?.includes(uid) ? '👑 ' : '') + name;
}

function miniDie(v) {
  const d = document.createElement('div');
  d.className = 'mini-die' + (v === 1 ? ' one' : '');
  for (let i = 0; i < 9; i++) {
    const p = document.createElement('i');
    if (MINI_PIPS[v].includes(i)) p.className = 'on';
    d.appendChild(p);
  }
  return d;
}

const isBarrelMode = (r) => r.barrel === 'points' || r.barrel === 'knock';

function render(s) {
  state = s;
  const spect = s.spectators ? ` · 👀 ${s.spectators}` : '';
  const bank = s.bank ? ` · 🏦 ${s.bank}` : '';
  $('modeChip').textContent = `${s.preset} · ${s.rules_title}` + (s.settings.timer ? ` · ⏱${s.settings.timer}с` : '') + bank + spect;
  registerCustom(s.custom_dice);
  const map = s.settings.map || 'felt';
  table.setMap(map);
  // смена карты в лобби — все слышат её фирменный звук
  if (prevMap !== null && prevMap !== map && s.status === 'lobby') mapSfx('preview');
  prevMap = map;
  snd.setSurface(map);
  if (s.status === 'cancelled') {
    showMessage('Игра отменена', 'Создай новую командой /newgame в группе.');
    return;
  }
  if (s.status === 'lobby') {
    $('finishModal').classList.add('hidden');
    finishAch = [];
    finishBank = null;
    renderLobby(s);
    showScreen('screenLobby');
    return;
  }
  renderGame(s);
  showScreen('screenGame');
  if (!$('finishModal').classList.contains('hidden') && s.status === 'finished') renderSummary(s);
  if (!$('adminModal').classList.contains('hidden')) renderAdminGame(s);
  if (!$('playerModal').classList.contains('hidden')) renderPlayerSheet(s);
}

function canEditRules(s) {
  return (me === s.owner && s.status === 'lobby') || isAdmin;
}

const TEAM_COLORS = ['#e5484d', '#3e7bfa', '#2fb67c', '#e8b10e'];
const MAP_NAMES = { felt: 'Сукно', octagon: 'Октагон MMA', ring: 'Ринг', bar: 'Барная стойка', casino: 'Казино', space: 'Космос', beach: 'Пляж', snow: 'Снег' };
const mapName = (id) => `${MAP_ICONS[id || 'felt'] || ''} ${state?.maps?.[id] || MAP_NAMES[id] || MAP_NAMES.felt}`.trim();
const mapImg = (id) => `/static/img/maps/${id || 'felt'}.jpg`;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/** Строка игрока в лобби: аватар, имя, фишки/бот, кнопки создателя. */
function lobbyRow(s, p) {
  const isOwner = me === s.owner;
  const bot = p.uid < 0;
  const row = el('div', 'player-row' + (bot ? '' : ' tappable'));
  const name = el('span', 'name', crowned(s, p.uid, p.name) + (p.uid === me ? ' (ты)' : ''));
  name.appendChild(el('span', 'sub', bot ? 'бот' : `🪙 ${s.chips?.[p.uid] ?? ''}`));
  row.append(avatar(p.uid, p.name), name);
  if (p.uid === s.owner) row.appendChild(el('span', 'tag', 'создатель'));
  if (!bot) {
    const dot = el('span', 'online-dot' + (s.online.includes(p.uid) ? ' on' : ''));
    row.appendChild(dot);
    row.onclick = () => openProfile(p.uid);
  }
  if (isOwner && p.uid !== s.owner) {
    const k = el('button', 'kick', '✕');
    k.setAttribute('aria-label', `Убрать ${p.name}`);
    k.onclick = (e) => {
      e.stopPropagation();
      confirmThen(`Убрать ${p.name} из игры?`, () => send({ type: 'kick', uid: p.uid }));
    };
    row.appendChild(k);
  }
  return row;
}

function renderLobby(s) {
  const isOwner = me === s.owner;
  const editable = canEditRules(s);
  const isMember = s.members.some((p) => p.uid === me);
  const teams = !!s.settings.teams;
  $('lobbyCount').textContent = `${s.members.length}/${s.max_players}`;
  const box = $('lobbyPlayers');
  box.innerHTML = '';
  if (teams) {
    const of = s.team_of || {};
    const used = new Set(Object.values(of));
    const count = Math.min(4, Math.max(2, Math.ceil(s.members.length / 2), ...[...used].map((t) => t + 1)));
    for (let t = 0; t < count; t++) {
      const block = el('div', 'team-block');
      const members = s.members.filter((p) => of[p.uid] === t);
      const head = el('div', 'team-head');
      const dot = el('span', 'team-dot');
      dot.style.background = TEAM_COLORS[t];
      head.append(dot, el('span', null, `${s.team_names[t].replace(/^\S+\s/, '')} · ${members.length}/2`));
      if (isMember && of[me] !== t && members.length < 2) {
        const join = el('button', 'link-btn join', 'Сюда');
        join.onclick = () => send({ type: 'team', team: t });
        head.appendChild(join);
      }
      block.appendChild(head);
      for (const p of members) {
        const row = lobbyRow(s, p);
        if (isOwner && p.uid < 0) { // бота переставляет создатель
          const mv = el('button', 'kick', '⇄');
          mv.onclick = (e) => {
            e.stopPropagation();
            const next = [1, 2, 3, 4].map((d) => (t + d) % count).find((x) => s.members.filter((q) => of[q.uid] === x).length < 2);
            if (next != null) send({ type: 'team', uid: p.uid, team: next });
          };
          row.insertBefore(mv, row.lastChild);
        }
        block.appendChild(row);
      }
      for (let i = members.length; i < 2; i++) block.appendChild(el('div', 'empty-slot', 'свободно'));
      box.appendChild(block);
    }
  } else {
    for (const p of s.members) box.appendChild(lobbyRow(s, p));
  }
  $('joinBtn').classList.toggle('hidden', isMember || s.members.length >= s.max_players);
  $('addBotBtn').classList.toggle('hidden', !isOwner || s.members.length >= s.max_players);
  $('shuffleBtn').classList.toggle('hidden', !isOwner || !teams);

  // строки настроек
  $('presetName').textContent = s.preset;
  $('mapValue').textContent = mapName(s.settings.map);
  $('mapThumb').src = mapImg(s.settings.map);
  $('timerValue').textContent = s.settings.timer ? `${s.settings.timer} с` : 'выкл';
  $('stakeValue').textContent = s.settings.stake ? `${s.settings.stake} 🪙` : 'без ставок';
  $('teamsToggle').checked = teams;
  $('teamsToggle').disabled = !editable;
  document.querySelector('.settings').classList.toggle('locked', !editable);

  // лист «Правила»
  const list = $('presetList');
  list.innerHTML = '';
  const presets = myPresets.length ? myPresets : [{ id: 'classic', name: 'Классика' }, { id: 'v2', name: 'Вариант 2' }];
  for (const pr of presets) {
    const b = el('button', 'chip' + (pr.name === s.preset ? ' on' : ''), pr.name);
    b.disabled = !editable;
    b.onclick = () => send({ type: 'preset', id: pr.id });
    list.appendChild(b);
  }
  if (s.preset === 'Свои') list.appendChild(el('span', 'chip on', 'Свои'));
  for (const [seg, val] of [['segBarrel', s.rules.barrel], ['segTimer', s.settings.timer], ['segStake', s.settings.stake]]) {
    const sg = $(seg);
    sg.classList.toggle('locked', !editable);
    sg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === String(val)));
  }
  const hasBots = Object.keys(s.bots || {}).length > 0;
  if (hasBots) $('segStake').classList.add('locked');
  const sum = $('rulesSummary');
  sum.innerHTML = '';
  for (const [head, text] of s.rules_text) {
    if (head === 'Очки за бросок' || head === 'Ход') continue;
    const li = el('li');
    li.append(el('b', null, head + ': '), document.createTextNode(text));
    sum.appendChild(li);
  }
  $('editRulesBtn').textContent = editable ? '⚙️ Настроить' : '📖 Все правила';
  $('stakeNote').textContent = hasBots ? 'С ботами играем без ставок.'
    : s.settings.stake ? `Каждый вносит ${s.settings.stake} 🪙, победитель забирает банк (в командах — делят). При отмене взносы возвращаются.`
      : 'У каждого 1000 🪙 на старте, раз в сутки +100, если осталось меньше 200.';

  // лист «Карта»
  const maps = $('mapList');
  maps.innerHTML = '';
  for (const [id, title] of Object.entries(s.maps || MAP_NAMES)) {
    const b = el('button', 'map-tile' + (id === s.settings.map ? ' on' : ''));
    const img = document.createElement('img');
    img.src = mapImg(id);
    img.alt = '';
    img.loading = 'lazy';
    b.append(img, el('span', null, `${MAP_ICONS[id] || ''} ${title}`));
    b.disabled = !editable;
    b.onclick = () => {
      send({ type: 'settings', map: id });
      $('mapSheet').classList.add('hidden');
    };
    maps.appendChild(b);
  }

  // лист «Боты»
  const bots = $('botBtns');
  if (!bots.childElementCount) {
    const desc = { careful: 'осторожный, бережёт очки', balanced: 'играет по математике', risky: 'рискует до последнего' };
    for (const [style, title] of Object.entries(s.bot_styles || {})) {
      const b = el('button', 'row');
      b.append(el('span', 'row-icon', '🤖'), el('span', 'row-label', title.replace('🤖 ', '')), el('span', 'row-value', desc[style] || ''));
      b.onclick = () => {
        send({ type: 'add_bot', style });
        $('botSheet').classList.add('hidden');
      };
      bots.appendChild(b);
    }
  }

  const owner = s.members.find((p) => p.uid === s.owner);
  $('ownerNote').textContent = isOwner
    ? (teams ? 'Команды по двое: в каждой ровно два игрока, команд от двух.' : '')
    : `Правила выбирает и игру запускает ${owner?.name || 'создатель'}.`;
  $('startBtn').classList.toggle('hidden', !isOwner);
  $('startBtn').textContent = s.members.length < 2 ? 'Начать одному' : `Начать игру · ${s.members.length}`;
  $('leaveLobbyBtn').classList.toggle('hidden', !isMember);
  $('leaveLobbyBtn').classList.toggle('grow', !isOwner);
}

/** Порядок карточек на полосе: по очереди ходов (команды — вместе). */
function stripOrder(g) {
  if (g.phase !== 'play' || !g.order?.length) return g.players;
  const seen = new Set();
  const ids = g.order.filter((u) => !seen.has(u) && seen.add(u));
  const list = ids.map((u) => g.players.find((p) => p.uid === u)).filter(Boolean);
  if (g.teams) list.sort((a, b) => (a.team ?? 0) - (b.team ?? 0));
  return list;
}

function renderGame(s) {
  const g = s.game;
  if (!g) return;
  const r = s.rules;
  const inGame = g.players.some((p) => p.uid === me);
  $('specBanner').classList.toggle('hidden', inGame || g.phase === 'finished');
  $('pauseOverlay').classList.toggle('hidden', !s.paused);

  const box = $('players');
  box.innerHTML = '';
  for (const p of stripOrder(g)) {
    const chip = el('div', 'pchip tappable' + (p.uid === g.current_uid ? ' current' : '') + (p.uid === me ? ' me' : ''));
    chip.dataset.uid = p.uid;
    chip.onclick = () => (isAdmin ? openPlayerSheet(p.uid) : p.uid >= 0 && openProfile(p.uid));
    if (g.teams && p.team != null) {
      const stripe = el('div', 'team-stripe');
      stripe.style.background = TEAM_COLORS[p.team];
      chip.appendChild(stripe);
    }
    const row = el('div', 'prow');
    row.append(el('span', 'online-dot' + (s.online.includes(p.uid) || p.uid < 0 ? ' on' : '')), el('span', 'pname', crowned(s, p.uid, p.name)));
    const score = el('div', 'pscore', String(p.score));
    if (prevScores.has(p.uid) && prevScores.get(p.uid) !== p.score) score.classList.add('bump');
    prevScores.set(p.uid, p.score);
    const bar = el('div', 'progress');
    const fill = el('i');
    fill.style.width = `${Math.min(100, Math.max(0, p.score / 10))}%`;
    bar.appendChild(fill);
    const meta = el('div', 'pmeta');
    const badges = el('div', 'badges');
    const add = (text, cls = '') => badges.appendChild(el('span', 'badge ' + cls, text));
    if (g.phase === 'order') {
      add(p.order_rolls.length ? `🎲 ${p.order_rolls.join(' → ')}` : '🎲 ждём', p.order_pending ? 'warn' : '');
    } else {
      if (!p.opened && r.open_min) add('не открыт');
      if (p.debt) add(`долг ${p.debt}`, 'bad');
      if (p.in_pit) add('🕳', 'warn');
      if (p.on_barrel) add(`🛢 ${p.barrel_attempts}/${r.barrel_attempts}`, 'warn swing');
      if (p.barrel_falls) add(`💥${p.barrel_falls}`, 'bad');
      if (p.bolts) add(`🔩${'●'.repeat(p.bolts)}`, 'bad');
      if (p.dots) add(`• ${p.dots}/${r.dots_limit}`, 'bad');
    }
    meta.appendChild(badges);
    const chance = s.winprob?.[p.uid];
    if (chance != null && g.phase === 'play') {
      const c = el('span', 'chance', 'шанс ');
      c.appendChild(el('b', null, `${Math.round(chance * 100)}%`));
      meta.appendChild(c);
    }
    chip.append(row, score, bar, meta);
    box.appendChild(chip);
  }

  // панель хода
  const cur = g.players.find((p) => p.uid === g.current_uid);
  const keptRow = $('keptRow');
  keptRow.innerHTML = '';
  if (g.phase === 'order') {
    $('turnWho').textContent = 'Розыгрыш очерёдности';
    $('turnPoints').parentElement.classList.add('hidden');
    $('hint').textContent = 'Все бросают 5 кубиков — у кого сумма больше, тот ходит первым.';
  } else if (g.phase === 'play') {
    $('turnWho').textContent = cur.uid === me ? 'Твой ход' : `Ходит ${crowned(s, cur.uid, cur.name)}`;
    $('turnPoints').parentElement.classList.remove('hidden');
    $('turnPoints').textContent = g.turn_points;
    g.kept.forEach((v) => keptRow.appendChild(miniDie(v)));
    keptRow.appendChild(el('span', null, g.rolls_in_turn ? `в руке ${g.dice_left}` : `счёт ${cur.score}`));
    $('hint').textContent = g.hint;
  } else {
    const ws = g.players.filter((p) => (g.winners?.length ? g.winners : [g.winner_uid]).includes(p.uid));
    $('turnWho').textContent = ws.length ? `🏆 Победа: ${ws.map((p) => p.name).join(' и ')}` : 'Игра окончена';
    $('turnPoints').parentElement.classList.add('hidden');
    $('hint').textContent = '';
  }
  renderActions(s);

  // журнал
  const ul = $('logList');
  ul.innerHTML = '';
  for (const e of g.log) {
    const li = el('li', e.notable ? 'notable' : '', e.text);
    ul.prepend(li);
  }

  // реакции и стикеры (собираются один раз)
  const bar = $('reactBar');
  if (!bar.childElementCount) {
    for (const em of s.reactions) {
      const b = el('button', null, em);
      b.onclick = () => {
        snd.unlock();
        send({ type: 'react', emoji: em });
        $('reactSheet').classList.add('hidden');
      };
      bar.appendChild(b);
    }
    const tray = $('stickerTray');
    for (const [id, [emoji, text]] of Object.entries(s.stickers)) {
      const b = el('button');
      b.append(el('span', null, emoji), el('small', null, text));
      b.onclick = () => {
        snd.unlock();
        send({ type: 'sticker', id });
        $('reactSheet').classList.add('hidden');
      };
      tray.appendChild(b);
    }
  }

  $('leaveGameBtn').classList.toggle('hidden', !inGame || g.phase === 'finished');
  $('endBtn').classList.toggle('hidden', me !== s.owner || g.phase === 'finished');
  $('moreBtn').classList.toggle('hidden', (!inGame && me !== s.owner) || g.phase === 'finished');

  // смена хода
  if (g.current_uid !== prevCurrent) {
    const was = prevCurrent;
    prevCurrent = g.current_uid;
    if (was !== null && g.phase === 'play') mapSfx('turn');
    if (g.current_uid === me && g.phase === 'play') {
      snd.play('turn');
      snd.haptic.notify('success');
    }
    chipEl(g.current_uid)?.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'smooth' });
  }

  // итоги
  if (s.status === 'finished') {
    const key = `${s.id}:${g.winner_uid}:${g.log.length ? g.log[g.log.length - 1].id : 0}`;
    if (finishShownFor !== key) {
      finishShownFor = key;
      setTimeout(() => showFinish(s), 900);
    }
  }
}

function renderRisk(s, mineTurn) {
  const g = s.game;
  const el = $('riskLine');
  if (!g || g.phase !== 'play' || !g.risk) {
    el.classList.add('hidden');
    return;
  }
  const n = g.dice_left;
  const p = Math.round(g.risk[n - 1] * 100);
  el.className = 'risk ' + (p >= 50 ? 'high' : p >= 25 ? 'mid' : 'low');
  el.textContent = `риск ${p}%`;
  el.title = `${mineTurn ? 'Риск сгореть' : 'Риск пустого броска'} при броске ${n} куб.`;
}

function renderActions(s) {
  const g = s.game;
  const roll = $('rollBtn');
  const stop = $('stopBtn');
  const actions = $('actions');
  if (!g) return;
  const lock = animating || queue.length > 0 || s.paused;
  actions.classList.remove('hidden');
  if (g.phase === 'order') {
    $('riskLine').classList.add('hidden');
    const mePending = g.players.find((p) => p.uid === me)?.order_pending;
    const othersPending = g.players.some((p) => p.uid !== me && p.order_pending);
    roll.textContent = mePending ? '🎲 Бросить' : 'Ждём остальных…';
    roll.disabled = !mePending || lock;
    const ownerHelp = me === s.owner && othersPending;
    stop.classList.toggle('hidden', !ownerHelp);
    stop.textContent = 'Бросить за всех';
    stop.disabled = lock;
    actions.classList.toggle('single', !ownerHelp);
    return;
  }
  if (g.phase !== 'play') {
    actions.classList.add('hidden');
    $('riskLine').classList.add('hidden');
    return;
  }
  const myTurn = g.current_uid === me;
  renderRisk(s, myTurn);
  if (!myTurn) {
    const cur = g.players.find((p) => p.uid === g.current_uid);
    roll.textContent = s.paused ? '⏸ Пауза' : `Ходит ${cur?.name || ''}…`;
    roll.disabled = true;
    stop.classList.add('hidden');
    actions.classList.add('single');
    return;
  }
  roll.textContent = s.paused ? '⏸ Пауза' : `🎲 Бросить ${g.dice_left}`;
  roll.disabled = lock;
  const me_ = g.players.find((p) => p.uid === me);
  const onBarrel = isBarrelMode(s.rules) && me_?.on_barrel;
  stop.classList.toggle('hidden', onBarrel);
  actions.classList.toggle('single', onBarrel);
  stop.textContent = g.turn_points ? `✍️ Записать +${g.turn_points}` : '✍️ Записать';
  stop.disabled = lock || !g.can_stop;
}

function showRollBadge(roll, s) {
  const el = $('rollBadge');
  const who = nameOf(s, roll.uid);
  el.className = 'roll-badge';
  if (roll.kind === 'order') {
    el.textContent = `${who}: ${roll.points}`;
  } else if (roll.points) {
    el.textContent = `+${roll.points}`;
    el.classList.add('good');
  } else {
    el.textContent = 'Пусто!';
    el.classList.add('zero');
  }
  clearTimeout(showRollBadge.t);
  showRollBadge.t = setTimeout(() => el.classList.add('hidden'), 2200);
}

function showReaction(r) {
  const layer = $('reactionsLayer');
  const el = document.createElement('div');
  el.className = 'reaction';
  el.style.left = `${10 + Math.random() * 75}%`;
  el.textContent = r.emoji;
  const n = document.createElement('small');
  n.textContent = r.name;
  el.appendChild(n);
  layer.appendChild(el);
  snd.play('pop');
  setTimeout(() => el.remove(), 2500);
}

function showFinish(s) {
  toastQueue.length = 0;
  $('toast').classList.add('hidden');
  const g = s.game;
  const winners = g.winners?.length ? g.winners : [g.winner_uid];
  const iWon = winners.includes(me);
  const wnames = g.players.filter((p) => winners.includes(p.uid)).map((p) => p.name).join(' и ');
  $('finishTitle').textContent = g.winner_uid == null ? 'Игра окончена' : iWon ? 'Ты победил(а)! 🏆' : `Победа: ${wnames}`;
  const box = $('ranking');
  box.innerHTML = '';
  if (g.teams) {
    const teams = {};
    for (const p of g.players) (teams[p.team] ||= []).push(p);
    const ranked = Object.entries(teams).sort(([, a], [, b]) => winners.includes(b[0].uid) - winners.includes(a[0].uid) || b[0].score - a[0].score);
    ranked.forEach(([t, ms], i) => {
      const row = el('div', 'row' + (winners.includes(ms[0].uid) ? ' win' : ''));
      const dot = el('span', 'team-dot');
      dot.style.background = TEAM_COLORS[t];
      row.append(el('span', 'place', winners.includes(ms[0].uid) ? '🏆' : String(i + 1)), dot,
        el('span', 'row-label', ms.map((p) => p.name).join(' и ')), el('span', 'score', String(ms[0].score)));
      box.appendChild(row);
    });
  } else {
    const ranked = [...g.players].sort((a, b) => winners.includes(b.uid) - winners.includes(a.uid) || b.score - a.score);
    ranked.forEach((p, i) => {
      const row = el(p.uid >= 0 ? 'button' : 'div', 'row' + (winners.includes(p.uid) ? ' win' : ''));
      row.append(el('span', 'place', winners.includes(p.uid) ? '🏆' : String(i + 1)), avatar(p.uid, p.name),
        el('span', 'row-label', crowned(s, p.uid, p.name)), el('span', 'score', String(p.score)));
      if (p.uid >= 0) row.onclick = () => openProfile(p.uid);
      box.appendChild(row);
    });
  }
  const bankEl = $('finishBank');
  bankEl.classList.toggle('hidden', !finishBank);
  if (finishBank) bankEl.textContent = `💰 ${finishBank.name}: банк ${finishBank.amount} 🪙`;
  renderSummary(s);
  const ach = $('finishAch');
  ach.innerHTML = '';
  for (const a of finishAch) ach.appendChild(el('div', null, `${a.emoji} ${a.name}: «${a.title}»`));
  $('rematchBtn').classList.toggle('hidden', me !== s.owner);
  $('finishModal').classList.remove('hidden');
}

/** Графики итогов: счёт по ходам и шансы на победу (цвет закреплён за игроком, не за местом). */
function renderSummary(s) {
  const g = s.game;
  const sum = g.summary;
  const hl = $('finishHighlights');
  hl.innerHTML = '';
  for (const t of sum?.highlights || []) hl.appendChild(el('li', null, t));
  const players = g.players;
  const winners = g.winners?.length ? g.winners : [g.winner_uid];
  const hist = sum?.history || [];
  lineChart($('summaryChart'), players.map((p, i) => ({
    name: p.name, color: seriesColor(i), bold: winners.includes(p.uid),
    values: hist.map((h) => h.scores[p.uid] ?? 0),
  })), { yMax: Math.max(1000, ...hist.flatMap((h) => Object.values(h.scores))), ticks: [0, 500, 1000], label: 'Счёт игроков по ходам' });
  const wp = s.winprob_hist || [];
  $('winprobLabel').classList.toggle('hidden', wp.length < 2);
  lineChart($('winprobChart'), players.map((p, i) => ({
    name: p.name, color: seriesColor(i), bold: winners.includes(p.uid),
    values: wp.map((h) => Math.round(100 * (h.p[p.uid] ?? 0))),
  })), { yMax: 100, ticks: [0, 50, 100], fmt: (v) => `${v}%`, label: 'Шансы на победу по ходам' });
}

// ---------- таймер ----------
setInterval(() => {
  const s = state;
  const bar = $('timerBar');
  if (!s || !s.deadline || s.status !== 'game' || s.paused) {
    bar.classList.add('hidden');
    return;
  }
  const total = s.settings.timer * 1000 + 2500;
  const left = s.deadline - (Date.now() + clockOffset);
  bar.classList.remove('hidden');
  const fill = $('timerFill');
  fill.style.width = `${Math.max(0, Math.min(100, (left / total) * 100))}%`;
  fill.classList.toggle('low', left < 10000);
}, 250);

// ---------- правила: просмотр ----------
function renderRules() {
  const s = state;
  const body = $('rulesBody');
  body.innerHTML = '';
  if (!s) return;
  $('rulesPreset').textContent = `${s.preset} · ${s.rules_title}`;
  const intro = document.createElement('p');
  intro.textContent = '5 кубиков, цель — 1000 очков.';
  body.appendChild(intro);
  for (const [head, text] of s.rules_text) {
    const h = document.createElement('h3');
    h.textContent = head;
    const p = document.createElement('p');
    p.textContent = text;
    body.append(h, p);
  }
  const risk = document.createElement('p');
  risk.className = 'muted';
  const rk = s.game?.risk;
  if (rk) risk.textContent = 'Шанс пустого броска: ' + rk.map((x, i) => `${i + 1} куб. — ${Math.round(x * 100)}%`).join(', ') + '.';
  body.appendChild(risk);
}

// ---------- правила: редактор ----------
const SEG = 'seg';
const RULE_FORM = [
  { title: 'Открытие игры', fields: [
    { k: 'open_min', type: SEG, label: 'Порог открытия за ход', opts: [[0, 'нет'], [50, '50'], [75, '75'], [100, '100']] },
    { k: 'bolts_before_open', type: 'bool', label: 'Болты и до открытия (штраф копится долгом)' },
  ] },
  { title: 'Ямы', fields: [
    { k: 'pits_on', type: 'bool', label: 'Ямы включены' },
    { k: 'pits', type: 'pits', show: (r) => r.pits_on },
  ] },
  { title: 'Обгон', fields: [
    { k: 'overtake_penalty', type: 'num', label: 'Штраф обогнанному (0 — нет)', step: 5 },
    { k: 'tie_rule', type: SEG, label: 'Если ровно сравнялся', opts: [['none', 'ничего'], ['penalty', 'штраф'], ['zero', 'соперник → 0']] },
  ] },
  { title: 'Самосвал', fields: [
    { k: 'samosval_on', type: 'bool', label: 'Самосвал включён' },
    { k: 'samosval', type: 'num', label: 'Число самосвала', step: 5, show: (r) => r.samosval_on },
  ] },
  { title: 'Болты', fields: [
    { k: 'bolts_on', type: 'bool', label: 'Болты включены' },
    { k: 'bolts_limit', type: 'num', label: 'Болтов до штрафа', step: 1, show: (r) => r.bolts_on },
    { k: 'bolt_penalty', type: 'num', label: 'Штраф', step: 5, show: (r) => r.bolts_on },
    { k: 'bolts_in_pit', type: 'bool', label: 'Считать в яме', show: (r) => r.bolts_on },
    { k: 'bolts_on_barrel', type: 'bool', label: 'Считать на бочке', show: (r) => r.bolts_on },
    { k: 'bolts_reset_on_commit', type: 'bool', label: 'Запись очков сбрасывает болты', show: (r) => r.bolts_on },
  ] },
  { title: 'Бочка', fields: [
    { k: 'barrel', type: SEG, label: 'Вариант', opts: [['none', 'нет'], ['points', 'по очкам'], ['open', 'открытая'], ['knock', 'со сбросом']] },
    { k: 'barrel_start', type: 'num', label: 'Бочка с', step: 5, show: isBarrelMode },
    { k: 'barrel_attempts', type: 'num', label: 'Попыток (ходов) на бочке', step: 1, show: isBarrelMode },
    { k: 'barrel_penalty', type: 'num', label: 'Штраф за падение', step: 5, show: isBarrelMode },
    { k: 'barrel_falls', type: 'num', label: 'Падений до обнуления', step: 1, show: isBarrelMode },
    { k: 'knock_drop', type: 'num', label: 'Сброшенный падает на', step: 5, show: (r) => r.barrel === 'knock', hint: (r) => `→ ${r.barrel_start - r.knock_drop}` },
    { k: 'dots_limit', type: 'num', label: 'Точек до штрафа', step: 1, show: (r) => r.barrel === 'open' },
    { k: 'dot_penalty', type: 'num', label: 'Штраф за точки', step: 5, show: (r) => r.barrel === 'open' },
    { k: 'dot_penalties_limit', type: 'num', label: 'Штрафов до обнуления', step: 1, show: (r) => r.barrel === 'open' },
  ] },
  { title: 'Подтверждающий бросок', fields: [
    { k: 'hot_dice', type: SEG, label: 'Когда сыграли все 5 кубиков', opts: [['strict', 'обязателен'], ['safe', 'со страховкой'], ['free', 'не нужен']],
      hint: (r) => ({
        strict: 'Обязан бросить все 5 снова; пустой бросок сжигает весь ход.',
        safe: 'Обязан бросить все 5 снова; если пусто — набранное всё равно записывается.',
        free: 'Можно сразу записать или рискнуть и бросать все 5 дальше.',
      })[r.hot_dice] },
  ] },
  { title: 'Таблица очков', fields: [
    { k: 'scoring.one', type: 'num', label: 'Одна единица', step: 5 },
    { k: 'scoring.five', type: 'num', label: 'Одна пятёрка', step: 5 },
    { k: 'scoring.mult3', type: 'num', label: 'Три одинаковых: номинал ×', step: 1, hint: (r) => `три шестёрки = ${6 * r.scoring.mult3}` },
    { k: 'scoring.mult4', type: 'num', label: 'Четыре: номинал ×', step: 1, hint: (r) => `четыре шестёрки = ${6 * r.scoring.mult4}` },
    { k: 'scoring.mult5', type: 'num', label: 'Пять: номинал ×', step: 1, hint: (r) => `пять шестёрок = ${6 * r.scoring.mult5}` },
    { k: 'scoring.small_straight', type: 'num', label: 'Стрит 1-2-3-4-5', step: 5 },
    { k: 'scoring.large_straight', type: 'num', label: 'Стрит 2-3-4-5-6', step: 5 },
    { k: 'scoring.five_ones', type: SEG, label: 'Пять единиц = победа', opts: [['none', 'нет'], ['first', 'первым броском'], ['any', 'любым']] },
  ] },
  { title: 'Дворовые правила', fields: [
    { k: 'roll_limit', type: SEG, label: 'Лимит бросков за ход', opts: [[0, 'нет'], [2, '2'], [3, '3'], [4, '4'], [5, '5']],
      hint: (r) => (r.roll_limit ? 'После последнего броска очки записываются сами (если можно), иначе сгорают.' : '') },
    { k: 'tie_rule', type: SEG, label: '«Ровно сравнял — соперник обнуляется»', opts: [['none', 'выкл'], ['zero', 'вкл']] },
  ] },
];

let draft = null;

const getK = (r, k) => k.split('.').reduce((o, x) => o[x], r);
function setK(r, k, v) {
  const parts = k.split('.');
  const last = parts.pop();
  parts.reduce((o, x) => o[x], r)[last] = v;
}

function openEditor() {
  const s = state;
  if (!s) return;
  if (!canEditRules(s)) {
    renderRules();
    $('rulesModal').classList.remove('hidden');
    return;
  }
  draft = JSON.parse(JSON.stringify(s.rules));
  $('editNote').textContent = s.status === 'lobby' ? 'Изменения увидят все в лобби.' : 'Правила поменяются посреди партии.';
  renderEditor();
  $('editModal').classList.remove('hidden');
}

function renderEditor() {
  const form = $('rulesForm');
  const scroll = form.parentElement.scrollTop;
  form.innerHTML = '';
  for (const sec of RULE_FORM) {
    const box = document.createElement('fieldset');
    const lg = document.createElement('legend');
    lg.textContent = sec.title;
    box.appendChild(lg);
    for (const f of sec.fields) {
      if (f.show && !f.show(draft)) continue;
      box.appendChild(fieldEl(f));
    }
    form.appendChild(box);
  }
  form.parentElement.scrollTop = scroll;
}

function fieldEl(f) {
  const wrap = document.createElement('div');
  wrap.className = 'ff ff-' + f.type;
  const val = getK(draft, f.k);
  const label = document.createElement('div');
  label.className = 'ff-label';
  label.textContent = f.label || '';
  if (f.type === 'bool') {
    const l = document.createElement('label');
    l.className = 'toggle';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!val;
    cb.onchange = () => {
      setK(draft, f.k, cb.checked);
      renderEditor();
    };
    l.append(cb, document.createTextNode(' ' + f.label));
    wrap.appendChild(l);
  } else if (f.type === SEG) {
    wrap.appendChild(label);
    const seg = document.createElement('div');
    seg.className = 'segmented';
    for (const [v, t] of f.opts) {
      const b = document.createElement('button');
      b.textContent = t;
      b.classList.toggle('on', v === val);
      b.onclick = () => {
        setK(draft, f.k, v);
        if (f.k === 'barrel' && v === 'knock' && draft.barrel_start === 880) draft.barrel_start = 850;
        if (f.k === 'barrel' && v === 'points' && draft.barrel_start === 850) draft.barrel_start = 880;
        renderEditor();
      };
      seg.appendChild(b);
    }
    wrap.appendChild(seg);
  } else if (f.type === 'num') {
    const row = document.createElement('div');
    row.className = 'num-row';
    const minus = document.createElement('button');
    minus.textContent = '−';
    const inp = document.createElement('input');
    inp.type = 'number';
    inp.inputMode = 'numeric';
    inp.value = val;
    inp.step = f.step;
    const plus = document.createElement('button');
    plus.textContent = '+';
    const apply = (v) => {
      setK(draft, f.k, Math.max(0, Number(v) || 0));
      renderEditor();
    };
    minus.onclick = () => apply(val - f.step);
    plus.onclick = () => apply(val + f.step);
    inp.onchange = () => apply(inp.value);
    row.append(minus, inp, plus);
    wrap.append(label, row);
  } else if (f.type === 'pits') {
    draft.pits.forEach((p, i) => {
      const row = document.createElement('div');
      row.className = 'pit-row';
      row.innerHTML = '<span>от</span><input type="number" step="5"><span>до</span><input type="number" step="5"><button>✕</button>';
      const [a, b] = row.querySelectorAll('input');
      a.value = p[0];
      b.value = p[1];
      a.onchange = () => { draft.pits[i][0] = Number(a.value) || 0; renderEditor(); };
      b.onchange = () => { draft.pits[i][1] = Number(b.value) || 0; renderEditor(); };
      row.querySelector('button').onclick = () => { draft.pits.splice(i, 1); renderEditor(); };
      wrap.appendChild(row);
    });
    if (draft.pits.length < 3) {
      const add = document.createElement('button');
      add.className = 'btn tiny ghost';
      add.textContent = '+ яма';
      add.onclick = () => {
        const last = draft.pits[draft.pits.length - 1];
        const lo = last ? Math.min(last[1] + 100, 900) : 200;
        draft.pits.push([lo, lo + 100]);
        renderEditor();
      };
      wrap.appendChild(add);
    }
    const note = document.createElement('div');
    note.className = 'ff-hint';
    note.textContent = 'На верхней границе игрок уже выбрался (яма 200–300 = от 200 до 299).';
    wrap.appendChild(note);
  }
  if (f.hint) {
    const h = document.createElement('div');
    h.className = 'ff-hint';
    h.textContent = f.hint(draft);
    if (h.textContent) wrap.appendChild(h);
  }
  return wrap;
}

// ---------- пресеты: поделиться ----------
function openShare() {
  $('shareResult').classList.add('hidden');
  $('shareName').value = state && state.preset !== 'Свои' && state.preset !== 'Классика' && state.preset !== 'Вариант 2' ? state.preset : '';
  $('shareModal').classList.remove('hidden');
}

let sharedLink = '';
function onPresetSaved(m) {
  sharedLink = m.link || '';
  $('shareCode').textContent = m.id;
  $('shareLink').textContent = sharedLink || `Код для группы: /newgame ${m.id}`;
  $('shareSendBtn').classList.toggle('hidden', !sharedLink);
  $('shareCopyBtn').classList.toggle('hidden', !sharedLink);
  $('shareResult').classList.remove('hidden');
  send({ type: 'my_presets' });
}

// ---------- ачивки ----------
function renderAchievements(list) {
  const box = $('achList');
  box.innerHTML = '';
  const got = list.filter((a) => a.got).length;
  $('achCount').textContent = `${got}/${list.length}`;
  for (const a of [...list].sort((x, y) => y.got - x.got)) {
    const el = document.createElement('div');
    el.className = 'ach' + (a.got ? ' got' : '');
    el.innerHTML = '<div class="ach-emoji"></div><div><b></b><small></small></div>';
    el.querySelector('.ach-emoji').textContent = a.got ? a.emoji : '🔒';
    el.querySelector('b').textContent = a.title;
    el.querySelector('small').textContent = a.desc;
    box.appendChild(el);
  }
  $('achModal').classList.remove('hidden');
}

// ---------- админ-панель ----------
function adminTab(name) {
  document.querySelectorAll('#adminTabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  document.querySelectorAll('#adminModal .tab').forEach((t) => t.classList.toggle('hidden', t.dataset.tab !== name));
  if (name === 'rooms') send({ type: 'admin', op: 'rooms' });
  if (name === 'log') send({ type: 'admin', op: 'audit' });
  if (name === 'games') send({ type: 'admin', op: 'games' });
  if (name === 'dice') send({ type: 'admin', op: 'dice_list' });
}

function openAdmin() {
  $('adminModal').classList.remove('hidden');
  if (!state) {
    adminTab('rooms');
    return;
  }
  renderAdminGame(state);
  const me_ = state.cosmetics;
  $('admGold').checked = !!me_?.gold?.includes(me);
  $('admBadge').checked = !!me_?.badge?.includes(me);
}

function renderAdminGame(s) {
  const g = s.game;
  $('admPauseBtn').textContent = s.paused ? '▶️ Продолжить' : '⏸ Пауза';
  const box = $('admPlayers');
  box.innerHTML = '';
  if (!g) {
    box.textContent = 'Игра ещё не началась.';
    return;
  }
  for (const p of g.players) {
    const row = document.createElement('button');
    row.className = 'adm-player';
    row.innerHTML = '<b></b><span></span><span class="chev">›</span>';
    row.querySelector('b').textContent = p.name;
    row.querySelector('span').textContent = p.score;
    row.onclick = () => openPlayerSheet(p.uid);
    box.appendChild(row);
  }
}

// ---------- админ: окно игрока ----------
function openPlayerSheet(uid) {
  const p = state?.game?.players.find((x) => x.uid === uid);
  if (!p) return;
  pmUid = uid;
  $('pmChips').value = state.chips?.[uid] ?? '';
  $('playerModal').classList.remove('hidden');
  renderPlayerSheet(state);
  renderPmCustom();
  send({ type: 'admin', op: 'dice_list' });
}

function renderPlayerSheet(s) {
  const p = s.game?.players.find((x) => x.uid === pmUid);
  if (!p) {
    $('playerModal').classList.add('hidden');
    return;
  }
  $('pmName').textContent = `${p.name} · ${p.score}`;
  $('pmHuman').classList.toggle('hidden', pmUid < 0);
}

// ---------- кубики с картинками ----------
/** Запомнить описания кубиков и заранее загрузить их текстуры для стола. */
function registerCustom(map) {
  for (const v of Object.values(map || {})) {
    customDice[v.skin] = v;
    table.defineCustomSkin(v);
  }
}

const imgCache = {};
function loadImg(src) {
  imgCache[src] ||= new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
  return imgCache[src];
}

/** Фото с телефона → квадрат 384×384 (обрезка по центру) → JPEG до ~380 КБ. */
async function fileToFace(file) {
  const url = URL.createObjectURL(file);
  const img = await loadImg(url);
  URL.revokeObjectURL(url);
  if (!img) throw new Error('не удалось открыть картинку');
  const S = 384;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const k = Math.max(S / img.naturalWidth, S / img.naturalHeight);
  const w = img.naturalWidth * k, h = img.naturalHeight * k;
  g.drawImage(img, (S - w) / 2, (S - h) / 2, w, h);
  let q = 0.86;
  let out = c.toDataURL('image/jpeg', q);
  while (out.length > 500000 && q > 0.4) {
    q -= 0.12;
    out = c.toDataURL('image/jpeg', q);
  }
  return out;
}

function onDiceAdmin(m) {
  diceAdmin = m;
  registerCustom(Object.fromEntries(m.list.map((v) => [v.skin, v])));
  renderDiceAdmin();
  renderPmCustom();
  if (de && m.saved && !de.id) de.id = m.saved;
  if (de?.id && !$('diceModal').classList.contains('hidden')) {
    const v = m.list.find((x) => x.id === de.id);
    if (v && m.saved === de.id) openDiceEditor(v, true); // после сохранения — показываем то, что на сервере
    else renderDiceOwners();
  }
}

function renderDiceAdmin() {
  const box = $('admDiceList');
  box.innerHTML = '';
  if (!diceAdmin?.list.length) {
    box.appendChild(el('div', 'empty', 'Кубиков с картинками пока нет'));
    return;
  }
  for (const v of diceAdmin.list) {
    const row = el('button', 'row');
    const img = el('img', 'dice-thumb');
    img.src = v.faces[0];
    img.alt = '';
    const lab = el('span', 'row-label', v.name);
    lab.appendChild(el('span', 'sub', v.owners.length ? `у ${v.owners.map((o) => o.name).join(', ')}` : 'ни у кого'));
    row.append(img, lab, el('span', 'chev', '›'));
    row.onclick = () => openDiceEditor(v);
    box.appendChild(row);
  }
}

function openDiceEditor(v, keepOpen = false) {
  de = {
    id: v?.id || null,
    name: v?.name || '',
    faces: [0, 1, 2, 3, 4, 5].map((i) => (v?.own[i] ? { src: v.faces[i], st: 'keep' } : { src: null, st: 'none' })),
  };
  $('deName').value = de.name;
  $('deSearch').value = '';
  renderDiceEditor();
  if (!keepOpen) openSheet('diceModal');
}

/** Картинка, которую реально покажет грань v: своя или первая заполненная. */
function effectiveFace(v) {
  return de.faces[v - 1].src || de.faces.find((f) => f.src)?.src || null;
}

async function faceDataUrl(v) {
  const src = effectiveFace(v);
  return customFaceCanvas(src ? await loadImg(src) : null, v).toDataURL('image/jpeg', 0.8);
}

function renderDiceEditor() {
  $('deTitle').textContent = de.id ? 'Кубик с картинками' : 'Новый кубик';
  $('deDelete').classList.toggle('hidden', !de.id);
  $('deOwnersBox').classList.toggle('hidden', !de.id);
  const grid = $('deFaces');
  grid.innerHTML = '';
  const any = de.faces.some((f) => f.src);
  de.faces.forEach((f, i) => {
    const v = i + 1;
    const slot = el('button', 'face-slot' + (f.src ? '' : any ? ' inherited' : ' empty'));
    slot.setAttribute('aria-label', `Грань ${v}`);
    if (any) {
      const img = el('img');
      img.alt = '';
      faceDataUrl(v).then((u) => { img.src = u; });
      slot.appendChild(img);
    }
    slot.appendChild(el('span', 'label', String(v)));
    if (f.src) {
      const x = el('span', 'clear', '✕');
      x.onclick = (e) => {
        e.stopPropagation();
        de.faces[i] = { src: null, st: 'none' };
        renderDiceEditor();
      };
      slot.appendChild(x);
    }
    slot.onclick = () => {
      de.pick = v;
      $('deFile').value = '';
      $('deFile').click();
    };
    grid.appendChild(slot);
  });
  // куб для предпросмотра: как у настоящего кубика, противоположные грани в сумме дают 7
  const cube = $('deCube');
  cube.innerHTML = '';
  for (const v of [1, 2, 6, 5, 3, 4]) {
    const side = el('div');
    if (any) {
      const img = el('img');
      img.alt = '';
      faceDataUrl(v).then((u) => { img.src = u; });
      side.appendChild(img);
    }
    cube.appendChild(side);
  }
  renderDiceOwners();
}

function renderDiceOwners() {
  if (!de?.id || !diceAdmin) return;
  const v = diceAdmin.list.find((x) => x.id === de.id);
  if (!v) return;
  const owners = new Set(v.owners.map((o) => o.uid));
  const q = $('deSearch').value.trim().toLowerCase();
  const people = diceAdmin.people
    .filter((p) => !q || p.name.toLowerCase().includes(q) || String(p.uid).includes(q))
    .sort((a, b) => owners.has(b.uid) - owners.has(a.uid))
    .slice(0, 60);
  const box = $('deOwners');
  box.innerHTML = '';
  for (const p of people) {
    const row = el('label', 'row');
    const sw = el('input', 'switch');
    sw.type = 'checkbox';
    sw.checked = owners.has(p.uid);
    sw.onchange = () => send({ type: 'admin', op: 'grant_skin', uid: p.uid, skin: v.skin, on: sw.checked });
    row.append(avatar(p.uid, p.name), el('span', 'row-label', p.name), sw);
    box.appendChild(row);
  }
  if (!people.length) box.appendChild(el('div', 'empty', 'Никого не найдено'));
}

/** В карточке игрока (админ): выдать или забрать кубики с картинками. */
function renderPmCustom() {
  const box = $('pmCustom');
  box.innerHTML = '';
  if (!diceAdmin?.list.length) {
    box.appendChild(el('div', 'empty', 'Кубиков с картинками нет — создай в 🛠 → Кубики'));
    return;
  }
  for (const v of diceAdmin.list) {
    const row = el('label', 'row');
    const img = el('img', 'dice-thumb');
    img.src = v.faces[0];
    img.alt = '';
    const sw = el('input', 'switch');
    sw.type = 'checkbox';
    sw.checked = v.owners.some((o) => o.uid === pmUid);
    sw.onchange = () => send({ type: 'admin', op: 'grant_skin', uid: pmUid, skin: v.skin, on: sw.checked });
    row.append(img, el('span', 'row-label', v.name), sw);
    box.appendChild(row);
  }
}

// ---------- мои кубики ----------
const swatches = {};
function swatch(id) {
  if (id?.startsWith('c_')) return customDice[id]?.faces[0] || '';
  if (!swatches[id]) swatches[id] = faceCanvas(5, id).toDataURL();
  return swatches[id];
}

function renderSkins(m) {
  $('chipsBalance').textContent = `Фишки: ${m.chips} 🪙`;
  const grid = $('skinGrid');
  grid.innerHTML = '';
  for (const sk of m.skins) {
    const b = document.createElement('button');
    b.className = 'skin' + (sk.id === m.skin ? ' on' : '');
    b.innerHTML = '<img alt=""><span></span>';
    b.querySelector('img').src = swatch(sk.id);
    b.querySelector('span').textContent = (sk.personal ? '✨ ' : '') + sk.name;
    b.onclick = () => {
      snd.haptic.select();
      send({ type: 'skin', id: sk.id });
    };
    grid.appendChild(b);
  }
}

function renderAudit(list) {
  const ul = $('admLog');
  ul.innerHTML = '';
  for (const a of [...list].reverse()) {
    const li = document.createElement('li');
    const t = new Date(a.t * 1000).toLocaleTimeString('ru-RU');
    li.textContent = `${t} ${a.name}: ${a.action}${a.detail ? ' — ' + a.detail : ''}`;
    ul.appendChild(li);
  }
  if (!list.length) ul.textContent = 'Пусто';
}

function renderAdminRooms(list) {
  const box = $('admRooms');
  box.innerHTML = '';
  if (!list.length) box.textContent = 'Комнат нет.';
  const STATUS = { lobby: 'лобби', game: 'идёт', finished: 'окончена', cancelled: 'отменена' };
  for (const r of list) {
    const el = document.createElement('div');
    el.className = 'adm-room' + (r.id === state?.id ? ' current' : '');
    el.innerHTML = '<div><b></b> <span class="muted"></span><div class="small"></div></div><button class="btn tiny">👀 Открыть</button>';
    el.querySelector('b').textContent = r.id;
    el.querySelector('.muted').textContent = (r.paused ? 'пауза' : STATUS[r.status]) + ' · ' + r.rules;
    el.querySelector('.small').textContent = r.players.join(', ');
    el.querySelector('button').onclick = () => {
      $('adminModal').classList.add('hidden');
      openRoom(r.id, true);
    };
    box.appendChild(el);
  }
}

// партии: исключённые (корзина) не учитываются нигде — ни в статистике, ни в ачивках, ни в банке
let admGames = { list: [], here: null };
let admGamesFilter = 'here';
let admGameOpen = null;

function turnsWord(n) {
  const d = n % 10, h = n % 100;
  return `${n} ${d === 1 && h !== 11 ? 'ход' : d >= 2 && d <= 4 && (h < 12 || h > 14) ? 'хода' : 'ходов'}`;
}

function fmtDuration(sec) {
  const m = Math.round(sec / 60);
  return m < 60 ? `${m} мин` : `${Math.floor(m / 60)} ч ${m % 60} мин`;
}

function renderAdminGames() {
  const box = $('admGames');
  box.innerHTML = '';
  const all = admGames.list;
  const list = all.filter((g) => (admGamesFilter === 'off' ? g.off
    : !g.off && (admGamesFilter === 'all' || g.chat === admGames.here)));
  const offN = all.filter((g) => g.off).length;
  $('admGamesFilter').querySelector('[data-f="off"]').textContent = offN ? `Корзина · ${offN}` : 'Корзина';
  $('admGamesNote').textContent = admGamesFilter === 'off'
    ? 'Эти партии не учитываются: статистика, рекорды, ачивки и банк откатаны. Их можно вернуть.'
    : `Партий: ${list.length}. 🎯 — ты менял правила посреди партии.`;
  if (!list.length) box.innerHTML = '<p class="note">Пусто.</p>';
  for (const g of list) {
    const el = document.createElement('div');
    el.className = 'adm-game' + (g.off ? ' off' : '') + (admGameOpen === g.id ? ' open' : '');
    const when = new Date(g.t * 1000).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const head = document.createElement('button');
    head.className = 'adm-game-head';
    head.innerHTML = '<div class="adm-game-top"><b></b><span class="muted"></span></div><div class="small"></div>';
    head.querySelector('b').textContent = (g.rigged ? '🎯 ' : '') + when;
    head.querySelector('.muted').textContent = admGamesFilter === 'here' ? turnsWord(g.turns)
      : (g.chat_title || (g.chat == null ? 'без чата' : `чат ${g.chat}`));
    head.querySelector('.small').textContent = g.players.map((p) => `${p.won ? '🏆 ' : ''}${p.name} ${p.score}`).join(' · ');
    head.onclick = () => {
      admGameOpen = admGameOpen === g.id ? null : g.id;
      renderAdminGames();
    };
    el.appendChild(head);
    if (admGameOpen === g.id) el.appendChild(adminGameBody(g));
    box.appendChild(el);
  }
}

function adminGameBody(g) {
  const body = document.createElement('div');
  body.className = 'adm-game-body';
  const facts = [turnsWord(g.turns), fmtDuration(g.duration)];
  if (g.teams) facts.push('командная');
  if (g.bank) facts.push(`банк ${g.bank} 🪙`);
  if (g.ach) facts.push(`ачивок ${g.ach}`);
  const p = document.createElement('p');
  p.className = 'note';
  p.textContent = facts.join(' · ');
  body.appendChild(p);
  const table = document.createElement('div');
  table.className = 'adm-game-players';
  for (const pl of g.players) {
    const row = document.createElement('div');
    row.innerHTML = '<span></span><span class="muted"></span><b></b>';
    row.children[0].textContent = (pl.won ? '🏆 ' : '') + pl.name + (pl.bot ? ' 🤖' : '');
    row.children[1].textContent = pl.best_turn ? `лучший ход ${pl.best_turn}` : '';
    row.children[2].textContent = pl.score;
    table.appendChild(row);
  }
  body.appendChild(table);
  const btns = document.createElement('div');
  btns.className = 'row-btns';
  const mk = (cls, text, fn) => {
    const b = document.createElement('button');
    b.className = 'btn ' + cls;
    b.textContent = text;
    b.onclick = fn;
    btns.appendChild(b);
  };
  const op = (name) => send({ type: 'admin', op: name, id: g.id });
  if (g.off) {
    mk('primary', '↩️ Вернуть', () => op('game_on'));
    mk('danger', '🗑 Навсегда', () => confirmThen('Удалить партию навсегда? Вернуть её будет нельзя.', () => op('game_purge')));
  } else {
    mk('danger', '🚫 Не учитывать', () => confirmThen(
      'Партия перестанет учитываться: откатятся победы, рекорды, ачивки этой партии и банк. Её можно будет вернуть из корзины.',
      () => op('game_off')));
  }
  body.appendChild(btns);
  return body;
}

$('admGamesFilter').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
  admGamesFilter = b.dataset.f;
  $('admGamesFilter').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
  renderAdminGames();
}));

// ---------- кнопки ----------
function confirmThen(text, fn) {
  if (tg?.showConfirm && tg.isVersionAtLeast?.('6.2')) tg.showConfirm(text, (ok) => ok && fn());
  else if (window.confirm(text)) fn();
}

function onTap(id, fn) {
  $(id).addEventListener('click', () => {
    snd.unlock();
    snd.haptic.impact('light');
    fn();
  });
}

onTap('rollBtn', () => {
  const g = state?.game;
  if (!g) return;
  $('rollBtn').disabled = true;
  $('stopBtn').disabled = true;
  send({ type: g.phase === 'order' ? 'order_roll' : 'roll' });
});
onTap('stopBtn', () => {
  const g = state?.game;
  if (!g) return;
  $('rollBtn').disabled = true;
  $('stopBtn').disabled = true;
  send({ type: g.phase === 'order' ? 'order_roll_all' : 'stop' });
});
onTap('startBtn', () => send({ type: 'start' }));
onTap('joinBtn', () => send({ type: 'join' }));
onTap('leaveLobbyBtn', () => confirmThen('Выйти из лобби?', () => send({ type: 'leave' })));
onTap('leaveGameBtn', () => {
  $('moreSheet').classList.add('hidden');
  confirmThen('Выйти из игры? Вернуться будет нельзя.', () => send({ type: 'leave' }));
});
onTap('endBtn', () => {
  $('moreSheet').classList.add('hidden');
  confirmThen('Завершить игру для всех?', () => send({ type: 'end' }));
});
onTap('rematchBtn', () => {
  $('finishModal').classList.add('hidden');
  send({ type: 'rematch' });
});
onTap('closeFinishBtn', () => $('finishModal').classList.add('hidden'));
onTap('closeRulesBtn', () => $('rulesModal').classList.add('hidden'));

// меню ☰
onTap('menuBtn', () => {
  syncThemeBtn();
  openSheet('menuModal');
});
document.querySelectorAll('#menuModal [data-menu]').forEach((b) => b.addEventListener('click', () => {
  snd.haptic.select();
  const what = b.dataset.menu;
  if (what === 'theme') {
    window.appTheme?.toggle();
    return;
  }
  $('menuModal').classList.add('hidden');
  if (what === 'profile') openProfile(me);
  else if (what === 'skins') {
    openSheet('skinModal');
    send({ type: 'my_profile' });
  } else if (what === 'ach') send({ type: 'my_achievements' });
  else if (what === 'records') send({ type: 'records' });
  else if (what === 'rules') {
    renderRules();
    openSheet('rulesModal');
  }
}));

// лобби: строки настроек открывают листы
const lobbyEditable = () => state && canEditRules(state);
onTap('rowRules', () => {
  if (lobbyEditable()) openSheet('rulesSheet');
  else {
    renderRules();
    openSheet('rulesModal');
  }
});
onTap('rowMap', () => openSheet('mapSheet'));
onTap('rowTimer', () => lobbyEditable() && openSheet('timerSheet'));
onTap('rowStake', () => lobbyEditable() && openSheet('stakeSheet'));
$('teamsToggle').addEventListener('change', (e) => {
  snd.haptic.select();
  send({ type: 'settings', teams: e.target.checked });
});
onTap('shuffleBtn', () => send({ type: 'shuffle_teams' }));
onTap('addBotBtn', () => openSheet('botSheet'));

// игра: панель инструментов
onTap('reactBtn', () => openSheet('reactSheet'));
onTap('logBtn', () => openSheet('logSheet'));
onTap('moreBtn', () => openSheet('moreSheet'));
onTap('pmProfileBtn', () => {
  $('playerModal').classList.add('hidden');
  if (pmUid >= 0) openProfile(pmUid);
});

// лист закрывается касанием по затемнённому фону
document.querySelectorAll('.modal').forEach((m) => m.addEventListener('click', (e) => {
  if (e.target === m && m.id !== 'editModal') m.classList.add('hidden');
}));
onTap('editRulesBtn', openEditor);
onTap('editCancelBtn', () => $('editModal').classList.add('hidden'));
onTap('editSaveBtn', () => {
  send({ type: 'rules', rules: draft });
  $('editModal').classList.add('hidden');
});
onTap('shareRulesBtn', openShare);
onTap('shareSaveBtn', () => send({ type: 'save_preset', name: $('shareName').value }));
onTap('shareSendBtn', () => {
  const url = `https://t.me/share/url?url=${encodeURIComponent(sharedLink)}&text=${encodeURIComponent('Наши правила для «1000» 🎲')}`;
  if (tg?.openTelegramLink) tg.openTelegramLink(url);
  else window.open(url, '_blank');
});
onTap('shareCopyBtn', () => {
  navigator.clipboard?.writeText(sharedLink).then(() => showInfo('Ссылка скопирована'), () => showError('Не удалось скопировать'));
});
onTap('shareCloseBtn', () => $('shareModal').classList.add('hidden'));
onTap('achCloseBtn', () => $('achModal').classList.add('hidden'));
for (const [seg, key] of [['segBarrel', 'barrel'], ['segTimer', 'timer'], ['segStake', 'stake']]) {
  $(seg).querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    snd.haptic.select();
    send({ type: 'settings', [key]: key === 'barrel' ? b.dataset.v : Number(b.dataset.v) });
    if (key !== 'barrel') $(seg).closest('.modal').classList.add('hidden');
  }));
}

// админ
onTap('adminBtn', openAdmin);
onTap('msgAdminBtn', openAdmin);
onTap('adminCloseBtn', () => $('adminModal').classList.add('hidden'));
document.querySelectorAll('#adminTabs button').forEach((b) => b.addEventListener('click', () => adminTab(b.dataset.tab)));
onTap('admPauseBtn', () => send({ type: 'admin', op: state?.paused ? 'resume' : 'pause' }));
onTap('admEndBtn', () => confirmThen('Завершить игру для всех?', () => send({ type: 'admin', op: 'end' })));
onTap('admRulesBtn', () => {
  $('adminModal').classList.add('hidden');
  openEditor();
});
onTap('pmCloseBtn', () => $('playerModal').classList.add('hidden'));
onTap('pmKickBtn', () => confirmThen('Исключить игрока?', () => {
  send({ type: 'admin', op: 'kick', uid: pmUid });
  $('playerModal').classList.add('hidden');
}));
onTap('pmChipsBtn', () => send({ type: 'admin', op: 'chips', uid: pmUid, value: Number($('pmChips').value) || 0 }));
document.querySelectorAll('#playerModal [data-grant], #playerModal [data-revoke]').forEach((b) => b.addEventListener('click', () => {
  const skin = b.dataset.grant || b.dataset.revoke;
  send({ type: 'admin', op: 'grant_skin', uid: pmUid, skin, on: !!b.dataset.grant });
}));
onTap('skinCloseBtn', () => $('skinModal').classList.add('hidden'));
onTap('admRoomsRefresh', () => send({ type: 'admin', op: 'rooms' }));
onTap('admDiceNew', () => openDiceEditor(null));
$('deFile').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file || !de?.pick) return;
  try {
    de.faces[de.pick - 1] = { src: await fileToFace(file), st: 'new' };
    renderDiceEditor();
  } catch (err) {
    showError(err.message);
  }
});
$('deSearch').addEventListener('input', renderDiceOwners);
onTap('deSave', () => {
  de.name = $('deName').value.trim();
  if (!de.name) return showError('Дай кубику название');
  if (!de.faces.some((f) => f.src)) return showError('Загрузи хотя бы одну картинку');
  send({
    type: 'admin', op: 'dice_save', id: de.id, name: de.name,
    faces: de.faces.map((f) => (f.st === 'new' ? f.src : f.st === 'keep' ? 'keep' : null)),
  });
});
onTap('deDelete', () => confirmThen(`Удалить кубик «${de.name}»? Он пропадёт у всех, кому выдан.`, () => {
  send({ type: 'admin', op: 'dice_delete', id: de.id });
  $('diceModal').classList.add('hidden');
  de = null;
}));
onTap('admLogRefresh', () => send({ type: 'admin', op: 'audit' }));
$('admGold').addEventListener('change', (e) => send({ type: 'admin', op: 'cosmetics', gold: e.target.checked }));
$('admBadge').addEventListener('change', (e) => send({ type: 'admin', op: 'cosmetics', badge: e.target.checked }));
onTap('admAnnounceBtn', () => {
  const text = $('admAnnounce').value.trim();
  if (!text) return;
  send({ type: 'admin', op: 'announce', text });
  $('admAnnounce').value = '';
});

function syncSoundBtn() { $('soundBtn').textContent = snd.isEnabled() ? '🔊' : '🔇'; }
onTap('soundBtn', () => snd.setEnabled(!snd.isEnabled()));
snd.onChange(syncSoundBtn);
syncSoundBtn();
function syncThemeBtn() { $('themeValue').textContent = window.appTheme?.get() === 'light' ? 'светлая' : 'тёмная'; }
document.addEventListener('themechange', syncThemeBtn);
syncThemeBtn();

connect();
// список пресетов пользователя для лобби (после подключения)
setTimeout(() => send({ type: 'my_presets' }), 1200);
