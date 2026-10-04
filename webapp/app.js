import { DiceTable, faceCanvas } from './dice3d.js';
import { MAP_ICONS } from './maps.js';
import * as snd from './sound.js';

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
const FORCE_PRESETS = [
  ['5 единиц', '1 1 1 1 1'], ['Большой стрит', '2 3 4 5 6'], ['Малый стрит', '1 2 3 4 5'],
  ['Три единицы', '1 1 1 2 3'], ['Пусто', '2 3 4 6 6'], ['Пятёрка', '5 2 3 3 6'],
];

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
let pmDice = [0, 0, 0, 0, 0];
// категориальная палитра графика итогов (dataviz: порядок фиксирован, отдельно для тёмной и светлой темы)
const SERIES = {
  dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
  light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'],
};

// ---------- Telegram ----------
if (tg) {
  tg.ready();
  tg.expand();
  tg.disableVerticalSwipes?.();
}

// Звуки карт: событие → звук (sound.js). Фон и стук кубиков о поверхность — в sound.js по id карты.
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
    case 'admin_ok':
      showInfo(m.text);
      break;
    case 'profile':
      renderSkins(m);
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
}

function showMessage(title, text) {
  snd.setAmbient(null);
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
  const map = s.settings.map || 'felt';
  table.setMap(map);
  // смена карты в лобби — все слышат её фирменный звук
  if (prevMap !== null && prevMap !== map && s.status === 'lobby') mapSfx('preview');
  prevMap = map;
  snd.setAmbient(s.status === 'cancelled' ? null : map);
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
  if (!$('adminModal').classList.contains('hidden')) renderAdminGame(s);
  if (!$('playerModal').classList.contains('hidden')) renderPlayerSheet(s);
}

function canEditRules(s) {
  return (me === s.owner && s.status === 'lobby') || isAdmin;
}

function renderLobby(s) {
  const isOwner = me === s.owner;
  const editable = canEditRules(s);
  const isMember = s.members.some((p) => p.uid === me);
  $('lobbyCount').textContent = `${s.members.length}/${s.max_players}`;
  const ul = $('lobbyPlayers');
  ul.innerHTML = '';
  for (const p of s.members) {
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = 'online-dot' + (s.online.includes(p.uid) ? ' on' : '');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = crowned(s, p.uid, p.name) + (p.uid === me ? ' (ты)' : '');
    const bot = p.uid < 0;
    li.append(avatar(p.uid, p.name), name);
    if (!bot) {
      const chips = document.createElement('span');
      chips.className = 'chips-count';
      chips.textContent = `🪙 ${s.chips?.[p.uid] ?? ''}`;
      li.append(chips, dot);
    }
    if (p.uid === s.owner) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = 'создатель';
      li.appendChild(tag);
    } else if (isOwner) {
      const k = document.createElement('button');
      k.className = 'kick';
      k.textContent = 'убрать';
      k.onclick = () => confirmThen(`Убрать ${p.name} из игры?`, () => send({ type: 'kick', uid: p.uid }));
      li.appendChild(k);
    }
    ul.appendChild(li);
  }
  $('joinBtn').classList.toggle('hidden', isMember || s.members.length >= s.max_players);
  const bots = $('botBtns');
  bots.classList.toggle('hidden', !isOwner || s.members.length >= s.max_players);
  if (isOwner && !bots.childElementCount) {
    for (const [style, title] of Object.entries(s.bot_styles || {})) {
      const b = document.createElement('button');
      b.className = 'btn tiny ghost';
      b.textContent = '+ ' + title;
      b.onclick = () => send({ type: 'add_bot', style });
      bots.appendChild(b);
    }
  }

  const maps = $('mapList');
  maps.innerHTML = '';
  for (const [id, title] of Object.entries(s.maps || {})) {
    const b = document.createElement('button');
    b.className = 'chip' + (id === s.settings.map ? ' on' : '');
    b.textContent = `${MAP_ICONS[id] || ''} ${title}`;
    b.disabled = !editable;
    b.onclick = () => send({ type: 'settings', map: id });
    maps.appendChild(b);
  }
  const hasBots = Object.keys(s.bots || {}).length > 0;
  $('segStake').classList.toggle('locked', !editable || hasBots);
  $('segStake').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === String(s.settings.stake)));
  $('stakeNote').textContent = hasBots ? 'С ботами играем без ставок.'
    : s.settings.stake ? `Каждый вносит ${s.settings.stake} 🪙, победитель забирает банк. При отмене взносы возвращаются.`
      : 'Фишки: у каждого 1000 🪙 на старте, раз в сутки +100, если осталось меньше 200.';

  // пресеты
  $('presetName').textContent = s.preset;
  const list = $('presetList');
  list.innerHTML = '';
  const presets = myPresets.length ? myPresets : [{ id: 'classic', name: 'Классика' }, { id: 'v2', name: 'Вариант 2' }];
  for (const p of presets) {
    const b = document.createElement('button');
    b.className = 'chip' + (p.name === s.preset ? ' on' : '');
    b.textContent = p.name;
    b.disabled = !editable;
    b.onclick = () => send({ type: 'preset', id: p.id });
    list.appendChild(b);
  }
  if (s.preset === 'Свои') {
    const c = document.createElement('span');
    c.className = 'chip on static';
    c.textContent = 'Свои';
    list.appendChild(c);
  }

  for (const [seg, val] of [['segBarrel', s.rules.barrel], ['segTimer', s.settings.timer]]) {
    const el = $(seg);
    el.classList.toggle('locked', !editable);
    el.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === String(val)));
  }
  const sum = $('rulesSummary');
  sum.innerHTML = '';
  for (const [head, text] of s.rules_text) {
    if (head === 'Очки за бросок' || head === 'Ход') continue;
    const li = document.createElement('li');
    li.innerHTML = '<b></b> <span></span>';
    li.querySelector('b').textContent = head + ':';
    li.querySelector('span').textContent = text;
    sum.appendChild(li);
  }
  $('editRulesBtn').textContent = editable ? '⚙️ Настроить' : '📖 Все правила';
  const owner = s.members.find((p) => p.uid === s.owner);
  $('ownerNote').textContent = isOwner
    ? 'Ты создатель: выбери правила и жми «Начать», когда все соберутся.'
    : `Правила выбирает и игру запускает ${owner?.name || 'создатель'}.`;
  $('startBtn').classList.toggle('hidden', !isOwner);
  $('startBtn').textContent = s.members.length < 2 ? 'Начать (одному)' : `Начать игру (${s.members.length})`;
  $('leaveLobbyBtn').classList.toggle('hidden', !isMember);
}

function renderGame(s) {
  const g = s.game;
  if (!g) return;
  const r = s.rules;
  const inGame = g.players.some((p) => p.uid === me);
  $('specBanner').classList.toggle('hidden', inGame || g.phase === 'finished');
  $('pauseOverlay').classList.toggle('hidden', !s.paused);

  const box = $('players');
  box.classList.toggle('solo', g.players.length === 1);
  box.innerHTML = '';
  for (const p of g.players) {
    const chip = document.createElement('div');
    chip.className = 'pchip' + (p.uid === g.current_uid ? ' current' : '') + (p.uid === me ? ' me' : '')
      + (isAdmin ? ' tappable' : '');
    chip.dataset.uid = p.uid;
    if (isAdmin) chip.onclick = () => openPlayerSheet(p.uid);
    const row = document.createElement('div');
    row.className = 'prow';
    const dot = document.createElement('span');
    dot.className = 'online-dot' + (s.online.includes(p.uid) ? ' on' : '');
    const name = document.createElement('span');
    name.className = 'pname';
    name.textContent = crowned(s, p.uid, p.name);
    const score = document.createElement('span');
    score.className = 'pscore';
    score.textContent = p.score;
    if (prevScores.has(p.uid) && prevScores.get(p.uid) !== p.score) score.classList.add('bump');
    prevScores.set(p.uid, p.score);
    row.append(dot, name, score);
    const badges = document.createElement('div');
    badges.className = 'badges';
    const add = (text, cls = '') => {
      const b = document.createElement('span');
      b.className = 'badge ' + cls;
      b.textContent = text;
      badges.appendChild(b);
    };
    if (isAdmin && s.rigs?.[p.uid]) add(`🎯 ${s.rigs[p.uid]}`, 'rig');
    if (g.phase === 'order') {
      add(p.order_rolls.length ? `🎲 ${p.order_rolls.join(' → ')}` : '🎲 ждём', p.order_pending ? 'warn' : '');
    } else {
      if (!p.opened && r.open_min) add('не открыт');
      if (p.debt) add(`долг ${p.debt}`, 'bad');
      if (p.in_pit) add('🕳 яма', 'warn');
      if (p.on_barrel) add(`🛢 ${p.barrel_attempts}/${r.barrel_attempts}`, 'warn swing');
      if (p.barrel_falls) add(`💥${p.barrel_falls}`, 'bad');
      if (p.bolts) add(`🔩${'●'.repeat(p.bolts)}`, 'bad');
      if (p.dots) add(`точки ${p.dots}/${r.dots_limit}`, 'bad');
      if (p.dot_penalties) add(`штраф ${p.dot_penalties}/${r.dot_penalties_limit}`, 'bad');
    }
    chip.append(row, badges);
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
    $('turnWho').textContent = cur.uid === me ? '🎯 Твой ход' : `Ходит: ${crowned(s, cur.uid, cur.name)}`;
    $('turnPoints').parentElement.classList.remove('hidden');
    $('turnPoints').textContent = g.turn_points;
    if (g.kept.length) {
      const lbl = document.createElement('span');
      lbl.textContent = 'отложено:';
      keptRow.appendChild(lbl);
      g.kept.forEach((v) => keptRow.appendChild(miniDie(v)));
    }
    const left = document.createElement('span');
    left.textContent = g.rolls_in_turn ? ` · в руке ${g.dice_left}` : `${cur.name}: ${cur.score} очков`;
    keptRow.appendChild(left);
    $('hint').textContent = g.hint;
  } else {
    const w = g.players.find((p) => p.uid === g.winner_uid);
    $('turnWho').textContent = w ? `🏆 Победил(а) ${w.name}` : 'Игра окончена';
    $('turnPoints').parentElement.classList.add('hidden');
    $('hint').textContent = '';
  }
  renderActions(s);

  // журнал
  const ul = $('logList');
  ul.innerHTML = '';
  for (const e of g.log) {
    const li = document.createElement('li');
    li.textContent = e.text;
    if (e.notable) li.className = 'notable';
    ul.prepend(li);
  }
  $('logLast').textContent = g.log.length ? '· ' + g.log[g.log.length - 1].text : '';

  // реакции и стикеры
  const bar = $('reactBar');
  if (!bar.childElementCount) {
    for (const em of s.reactions) {
      const b = document.createElement('button');
      b.textContent = em;
      b.onclick = () => {
        snd.unlock();
        send({ type: 'react', emoji: em });
      };
      bar.appendChild(b);
    }
    const st = document.createElement('button');
    st.className = 'sticker-btn';
    st.textContent = '🗯';
    st.onclick = () => $('stickerTray').classList.toggle('hidden');
    bar.appendChild(st);
    const tray = $('stickerTray');
    for (const [id, [emoji, text]] of Object.entries(s.stickers)) {
      const b = document.createElement('button');
      b.innerHTML = '<span></span><small></small>';
      b.querySelector('span').textContent = emoji;
      b.querySelector('small').textContent = text;
      b.onclick = () => {
        snd.unlock();
        send({ type: 'sticker', id });
        tray.classList.add('hidden');
      };
      tray.appendChild(b);
    }
  }

  $('leaveGameBtn').classList.toggle('hidden', !inGame || g.phase === 'finished');
  $('endBtn').classList.toggle('hidden', me !== s.owner || g.phase === 'finished');

  // смена хода
  if (g.current_uid !== prevCurrent) {
    const was = prevCurrent;
    prevCurrent = g.current_uid;
    if (was !== null && g.phase === 'play') mapSfx('turn');
    if (g.current_uid === me && g.phase === 'play') {
      snd.play('turn');
      snd.haptic.notify('success');
    }
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
  el.textContent = `${mineTurn ? 'Риск сгореть' : 'Риск пустого броска'} при броске ${n} куб.: ${p}%`;
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
  const w = g.players.find((p) => p.uid === g.winner_uid);
  $('finishTitle').textContent = w ? (w.uid === me ? 'Ты победил(а)!' : `Победил(а) ${w.name}`) : 'Игра окончена';
  const ol = $('ranking');
  ol.innerHTML = '';
  const ranked = [...g.players].sort((a, b) => (b.uid === g.winner_uid) - (a.uid === g.winner_uid) || b.score - a.score);
  for (const p of ranked) {
    const li = document.createElement('li');
    li.textContent = crowned(s, p.uid, p.name);
    const sc = document.createElement('span');
    sc.textContent = p.score;
    li.appendChild(sc);
    ol.appendChild(li);
  }
  const bankEl = $('finishBank');
  bankEl.classList.toggle('hidden', !finishBank);
  if (finishBank) bankEl.textContent = `💰 ${finishBank.name} забирает банк: ${finishBank.amount} 🪙`;
  renderSummary(g);
  const ach = $('finishAch');
  ach.innerHTML = '';
  for (const a of finishAch) {
    const d = document.createElement('div');
    d.textContent = `${a.emoji} ${a.name}: «${a.title}»`;
    ach.appendChild(d);
  }
  $('rematchBtn').classList.toggle('hidden', me !== s.owner);
  $('finishModal').classList.remove('hidden');
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
    row.innerHTML = '<b></b><span></span><span class="rig"></span>';
    row.querySelector('b').textContent = p.name;
    row.querySelector('span').textContent = p.score;
    row.querySelector('.rig').textContent = s.rigs?.[p.uid] ? `🎯 ${s.rigs[p.uid]}` : '⚙️';
    row.onclick = () => openPlayerSheet(p.uid);
    box.appendChild(row);
  }
}

// ---------- админ: окно игрока (подкрутка и действия) ----------
function openPlayerSheet(uid) {
  const p = state?.game?.players.find((x) => x.uid === uid);
  if (!p) return;
  pmUid = uid;
  pmDice = [0, 0, 0, 0, 0];
  $('pmScore').value = p.score;
  $('pmChips').value = state.chips?.[uid] ?? '';
  $('playerModal').classList.remove('hidden');
  renderPlayerSheet(state);
}

function renderPlayerSheet(s) {
  const p = s.game?.players.find((x) => x.uid === pmUid);
  if (!p) {
    $('playerModal').classList.add('hidden');
    return;
  }
  $('pmName').textContent = `${p.name} · ${p.score}`;
  const rig = s.rigs?.[pmUid];
  $('pmRig').textContent = rig ? `🎯 Подкручено: ${rig}` : 'Подкрутки нет — бросает честно';
  $('pmRig').classList.toggle('on', !!rig);
  $('pmUnrigBtn').classList.toggle('hidden', !rig);
  $('pmPitBtn').disabled = !p.in_pit;
  $('pmHuman').classList.toggle('hidden', pmUid < 0);
  const box = $('pmDice');
  box.innerHTML = '';
  pmDice.forEach((v, i) => {
    const b = document.createElement('button');
    b.className = 'pm-die' + (v ? '' : ' any');
    if (v) b.appendChild(miniDie(v));
    else b.textContent = '?';
    b.onclick = () => {
      pmDice[i] = (pmDice[i] + 1) % 7;
      snd.haptic.select();
      renderPlayerSheet(state);
    };
    box.appendChild(b);
  });
}

function rig(body) {
  send({ type: 'admin', op: 'rig', uid: pmUid, ...body });
}

// ---------- мои кубики ----------
const swatches = {};
function swatch(id) {
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

// ---------- итоги партии: график счёта ----------
function renderSummary(g) {
  const box = $('summaryChart');
  const hl = $('finishHighlights');
  box.innerHTML = '';
  hl.innerHTML = '';
  const sum = g.summary;
  if (!sum) return;
  for (const h of sum.highlights) {
    const li = document.createElement('li');
    li.textContent = h;
    hl.appendChild(li);
  }
  const hist = sum.history;
  if (hist.length < 2) return;
  const theme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  // цвет закреплён за игроком (порядок ходов), а не за местом в итоговой таблице
  const players = g.players.map((p, i) => ({ ...p, color: SERIES[theme][i % 8] }));
  const W = 320, H = 170, L = 34, R = 10, T = 10, B = 22;
  const maxY = Math.max(1000, ...hist.flatMap((h) => Object.values(h.scores)));
  const x = (i) => L + ((W - L - R) * i) / (hist.length - 1);
  const y = (v) => T + (H - T - B) * (1 - v / maxY);
  const NS = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs, parent) => {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    parent.appendChild(e);
    return e;
  };
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img',
    'aria-label': 'Счёт игроков по ходам' }, box);
  for (const v of [0, 500, 1000]) {
    el('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: 'grid' }, svg);
    el('text', { x: L - 6, y: y(v) + 3, class: 'axis', 'text-anchor': 'end' }, svg).textContent = v;
  }
  el('text', { x: W - R, y: H - 6, class: 'axis', 'text-anchor': 'end' }, svg).textContent = `ходов: ${hist.length - 1}`;
  for (const p of players) {
    const pts = hist.map((h, i) => `${x(i).toFixed(1)},${y(h.scores[p.uid] ?? 0).toFixed(1)}`).join(' ');
    el('polyline', { points: pts, fill: 'none', stroke: p.color, 'stroke-width': p.uid === g.winner_uid ? 2.5 : 2,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
  }
  // наведение: вертикальная линия и подсказка со счётом всех
  const cross = el('line', { y1: T, y2: H - B, class: 'cross', visibility: 'hidden' }, svg);
  const tip = document.createElement('div');
  tip.className = 'chart-tip hidden';
  box.appendChild(tip);
  const hit = el('rect', { x: L, y: 0, width: W - L - R, height: H, fill: 'transparent' }, svg);
  const move = (ev) => {
    const r = svg.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * W;
    const i = Math.max(0, Math.min(hist.length - 1, Math.round(((px - L) / (W - L - R)) * (hist.length - 1))));
    cross.setAttribute('x1', x(i));
    cross.setAttribute('x2', x(i));
    cross.setAttribute('visibility', 'visible');
    const rows = [...players].sort((a, b) => (hist[i].scores[b.uid] ?? 0) - (hist[i].scores[a.uid] ?? 0));
    tip.innerHTML = `<b>Ход ${i}</b>` + rows.map((p) => `<div><i style="background:${p.color}"></i><span></span><em>${hist[i].scores[p.uid] ?? 0}</em></div>`).join('');
    tip.querySelectorAll('span').forEach((sp, k) => { sp.textContent = rows[k].name; });
    tip.classList.remove('hidden');
    tip.style.left = `${Math.min(70, Math.max(0, (x(i) / W) * 100 - 15))}%`;
  };
  hit.addEventListener('pointermove', move);
  hit.addEventListener('pointerdown', move);
  hit.addEventListener('pointerleave', () => {
    cross.setAttribute('visibility', 'hidden');
    tip.classList.add('hidden');
  });
  const legend = document.createElement('div');
  legend.className = 'legend';
  for (const p of players) {
    const it = document.createElement('span');
    it.innerHTML = '<i></i>';
    it.querySelector('i').style.background = p.color;
    it.appendChild(document.createTextNode(p.name));
    legend.appendChild(it);
  }
  box.appendChild(legend);
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
onTap('leaveGameBtn', () => confirmThen('Выйти из игры? Вернуться будет нельзя.', () => send({ type: 'leave' })));
onTap('endBtn', () => confirmThen('Завершить игру для всех?', () => send({ type: 'end' })));
onTap('rematchBtn', () => {
  $('finishModal').classList.add('hidden');
  send({ type: 'rematch' });
});
onTap('closeFinishBtn', () => $('finishModal').classList.add('hidden'));
onTap('rulesBtn', () => {
  renderRules();
  $('rulesModal').classList.remove('hidden');
});
onTap('closeRulesBtn', () => $('rulesModal').classList.add('hidden'));
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
onTap('achBtn', () => send({ type: 'my_achievements' }));
onTap('achCloseBtn', () => $('achModal').classList.add('hidden'));
for (const [seg, key] of [['segBarrel', 'barrel'], ['segTimer', 'timer'], ['segStake', 'stake']]) {
  $(seg).querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    snd.haptic.select();
    send({ type: 'settings', [key]: key === 'barrel' ? b.dataset.v : Number(b.dataset.v) });
  }));
}

// админ
onTap('adminBtn', openAdmin);
onTap('msgAdminBtn', openAdmin);
onTap('adminCloseBtn', () => $('adminModal').classList.add('hidden'));
document.querySelectorAll('#adminTabs button').forEach((b) => b.addEventListener('click', () => adminTab(b.dataset.tab)));
onTap('admPauseBtn', () => send({ type: 'admin', op: state?.paused ? 'resume' : 'pause' }));
onTap('admUndoBtn', () => send({ type: 'admin', op: 'undo' }));
onTap('admEndBtn', () => confirmThen('Завершить игру для всех?', () => send({ type: 'admin', op: 'end' })));
onTap('admRulesBtn', () => {
  $('adminModal').classList.add('hidden');
  openEditor();
});
onTap('admForceBtn', () => {
  const dice = $('admForce').value.split(/[\s,]+/).filter(Boolean).map(Number);
  send({ type: 'admin', op: 'force', dice });
});
for (const [title, dice] of FORCE_PRESETS) {
  const b = document.createElement('button');
  b.className = 'chip';
  b.textContent = title;
  b.onclick = () => { $('admForce').value = dice; };
  $('admForcePresets').appendChild(b);
}
onTap('pmCloseBtn', () => $('playerModal').classList.add('hidden'));
onTap('pmExactBtn', () => {
  if (!pmDice.some(Boolean)) return showError('Задай хотя бы один кубик');
  rig({ mode: 'exact', dice: pmDice });
});
onTap('pmUnrigBtn', () => send({ type: 'admin', op: 'unrig', uid: pmUid }));
document.querySelectorAll('#playerModal [data-rig]').forEach((b) => b.addEventListener('click', () => {
  snd.haptic.impact('light');
  rig({ mode: b.dataset.rig });
}));
for (const [title, dice] of FORCE_PRESETS) {
  const b = document.createElement('button');
  b.className = 'chip';
  b.textContent = title;
  b.onclick = () => {
    pmDice = dice.split(' ').map(Number);
    renderPlayerSheet(state);
  };
  $('pmPresets').appendChild(b);
}
onTap('pmScoreBtn', () => send({ type: 'admin', op: 'set_score', uid: pmUid, score: Number($('pmScore').value) || 0 }));
onTap('pmBoltBtn', () => send({ type: 'admin', op: 'bolt', uid: pmUid }));
onTap('pmTruckBtn', () => send({ type: 'admin', op: 'samosval', uid: pmUid }));
onTap('pmKickBtn', () => confirmThen('Исключить игрока?', () => {
  send({ type: 'admin', op: 'kick', uid: pmUid });
  $('playerModal').classList.add('hidden');
}));
onTap('pmChipsBtn', () => send({ type: 'admin', op: 'chips', uid: pmUid, value: Number($('pmChips').value) || 0 }));
document.querySelectorAll('#playerModal [data-grant], #playerModal [data-revoke]').forEach((b) => b.addEventListener('click', () => {
  const skin = b.dataset.grant || b.dataset.revoke;
  send({ type: 'admin', op: 'grant_skin', uid: pmUid, skin, on: !!b.dataset.grant });
}));
onTap('skinBtn', () => {
  $('skinModal').classList.remove('hidden');
  send({ type: 'my_profile' });
});
onTap('skinCloseBtn', () => $('skinModal').classList.add('hidden'));
onTap('admRoomsRefresh', () => send({ type: 'admin', op: 'rooms' }));
onTap('admLogRefresh', () => send({ type: 'admin', op: 'audit' }));
$('admGold').addEventListener('change', (e) => send({ type: 'admin', op: 'cosmetics', gold: e.target.checked }));
$('admBadge').addEventListener('change', (e) => send({ type: 'admin', op: 'cosmetics', badge: e.target.checked }));
onTap('admAnnounceBtn', () => {
  const text = $('admAnnounce').value.trim();
  if (!text) return;
  send({ type: 'admin', op: 'announce', text });
  $('admAnnounce').value = '';
});

function syncSoundBtn() {
  $('soundBtn').textContent = snd.isEnabled() ? '🔊' : '🔇';
  const amb = $('ambientBtn');
  amb.classList.toggle('off', !snd.isAmbientEnabled() || !snd.isEnabled());
  amb.setAttribute('aria-pressed', String(snd.isAmbientEnabled()));
}
onTap('soundBtn', () => snd.setEnabled(!snd.isEnabled()));
onTap('ambientBtn', () => {
  if (!snd.isEnabled()) {
    snd.setEnabled(true);
    snd.setAmbientEnabled(true);
  } else snd.setAmbientEnabled(!snd.isAmbientEnabled());
  showInfo(snd.isAmbientEnabled() ? '🎵 Фон карты включён' : '🎵 Фон карты выключен');
});
snd.onChange(syncSoundBtn);
syncSoundBtn();
function syncThemeBtn() { $('themeBtn').textContent = window.appTheme?.get() === 'light' ? '🌙' : '☀️'; }
onTap('themeBtn', () => window.appTheme?.toggle());
document.addEventListener('themechange', syncThemeBtn);
syncThemeBtn();

connect();
// список пресетов пользователя для лобби (после подключения)
setTimeout(() => send({ type: 'my_presets' }), 1200);
