import { DiceTable } from './dice3d.js';
import * as snd from './sound.js';

const tg = window.Telegram?.WebApp;
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

const BARREL_SHORT = { none: 'без бочки', points: 'бочка 880', open: 'открытая бочка' };
const BARREL_DESC = {
  none: 'Побеждает тот, кто первым наберёт 1000 и больше.',
  points: 'С 880 садишься на бочку и за 3 своих хода должен набрать до 1000 за один ход. Не вышло — падение −100, третье падение — счёт 0.',
  open: 'Нужно набрать ровно 1000. Перебор — ход сгорает и ставится точка; 6 точек = −100, третий такой штраф — счёт 0.',
};
const MINI_PIPS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };

let ws = null;
let me = null;
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

// ---------- Telegram ----------
if (tg) {
  tg.ready();
  tg.expand();
  tg.disableVerticalSwipes?.();
  try {
    tg.setHeaderColor?.('#0d1712');
    tg.setBackgroundColor?.('#0d1712');
  } catch (e) { /* старые клиенты */ }
}

const table = new DiceTable($('table3d'), {
  onThrow: () => snd.shake(),
  onImpact: (strength, i) => {
    if (strength > 0.3 || i % 2 === 0) snd.knock(strength);
    if (strength === 1 && i === 0) snd.haptic.impact('light');
  },
});

// ---------- связь ----------
function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => {
    reconnectDelay = 500;
    fresh = true;
    $('conn').classList.add('hidden');
    send({
      type: 'hello',
      initData: tg?.initData || '',
      room: roomId,
      dev_uid: params.get('dev_uid'),
      dev_name: params.get('dev_name'),
    });
  };
  ws.onmessage = (e) => onMessage(JSON.parse(e.data));
  ws.onclose = () => {
    $('conn').classList.remove('hidden');
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 8000);
  };
}

function onMessage(m) {
  switch (m.type) {
    case 'hello_ok':
      me = m.uid;
      roomId = m.room;
      break;
    case 'state':
      clockOffset = m.state.server_now - Date.now();
      queue.push(m.state);
      if (!busy) pump();
      break;
    case 'no_room':
      me = m.uid;
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
    case 'left':
      showError('Ты вышел из игры');
      break;
    case 'kicked':
      showError('Создатель исключил тебя из игры');
      break;
  }
}

// ---------- очередь состояний и анимации ----------
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
        table.showStatic(roll.dice, roll.scoring, roll.seed, roll);
      }
      render(s);
      continue;
    }
    if (roll && roll.id !== lastRollId) {
      lastRollId = roll.id;
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

function toast(emoji, text, ms = 1500) {
  toastQueue.push({ emoji, text, ms, at: Date.now() });
  if (!toastBusy) nextToast();
}

function nextToast() {
  // устаревшие объявления (например, после быстрой серии событий) пропускаем
  while (toastQueue.length && Date.now() - toastQueue[0].at > 3000) toastQueue.shift();
  const t = toastQueue.shift();
  if (!t) {
    toastBusy = false;
    return;
  }
  toastBusy = true;
  const el = $('toast');
  $('toastEmoji').textContent = t.emoji;
  $('toastText').textContent = t.text;
  el.classList.remove('hidden', 'out');
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

function flashChip(uid) {
  const el = document.querySelector(`.pchip[data-uid="${uid}"]`);
  if (!el) return;
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
}

async function processEvents(s) {
  const g = s.game;
  if (!g) return;
  for (const e of g.log) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    const mine = e.uid === me;
    switch (e.kind) {
      case 'roll':
        snd.play(g.last_roll?.points ? 'score' : 'zero');
        if (mine && !g.last_roll?.points) snd.haptic.notify('error');
        break;
      case 'hot':
        snd.play('hot');
        toast('🔥', 'Все кубики сыграли! Бросай все 5');
        break;
      case 'commit':
        snd.play('commit');
        if (mine) snd.haptic.notify('success');
        break;
      case 'bolt':
        snd.play('bolt');
        flashChip(e.uid);
        if (mine) snd.haptic.notify('warning');
        break;
      case 'bolt_penalty':
        snd.play('bolt');
        flashChip(e.uid);
        toast('🔩', `${nameOf(s, e.uid)}: третий болт, −100`);
        if (mine) snd.haptic.notify('error');
        break;
      case 'samosval':
        snd.play('samosval');
        flashChip(e.uid);
        toast('🚛', `Самосвал! ${nameOf(s, e.uid)} → 0`, 2200);
        snd.haptic.notify('error');
        break;
      case 'overtake':
        snd.play('overtake');
        flashChip(e.uid);
        toast('🏎', `${nameOf(s, e.by)} обогнал(а) ${nameOf(s, e.uid)}: −50`);
        if (mine) snd.haptic.notify('warning');
        break;
      case 'barrel_sit':
        snd.play('barrel');
        toast('🛢', `${nameOf(s, e.uid)} на бочке!`);
        break;
      case 'barrel_attempt':
        snd.play('zero');
        break;
      case 'barrel_fall':
      case 'barrel_off':
        snd.play('fall');
        flashChip(e.uid);
        toast('💥', `${nameOf(s, e.uid)} упал(а) с бочки`);
        break;
      case 'barrel_zero':
        snd.play('fall');
        flashChip(e.uid);
        toast('💥', `${nameOf(s, e.uid)}: третье падение — счёт 0!`, 2200);
        break;
      case 'dot':
        snd.play('zero');
        toast('•', `Перебор! Точка ${nameOf(s, e.uid)}`, 1100);
        break;
      case 'dot_penalty':
      case 'dot_zero':
        snd.play('fall');
        flashChip(e.uid);
        toast('•', e.kind === 'dot_zero' ? `${nameOf(s, e.uid)}: счёт обнулён!` : `${nameOf(s, e.uid)}: 6 точек, −100`, 2000);
        break;
      case 'order_done':
        toast('🎲', 'Очерёдность определена!');
        break;
      case 'timeout':
        showError(e.text);
        break;
      case 'win':
        snd.play('win');
        snd.haptic.notify('success');
        break;
    }
  }
}

// ---------- отрисовка ----------
function showScreen(id) {
  for (const sid of ['screenMsg', 'screenLobby', 'screenGame']) $(sid).classList.toggle('hidden', sid !== id);
}

function showMessage(title, text) {
  $('msgTitle').textContent = title;
  $('msgText').textContent = text;
  showScreen('screenMsg');
}

let errTimer = null;
function showError(text) {
  const el = $('errorToast');
  el.textContent = text;
  el.classList.remove('hidden');
  clearTimeout(errTimer);
  errTimer = setTimeout(() => el.classList.add('hidden'), 2600);
}

function avatar(uid, name) {
  const el = document.createElement('div');
  el.className = 'avatar';
  el.style.background = `hsl(${(uid * 47) % 360} 65% 62%)`;
  el.textContent = (name || '?').trim().charAt(0).toUpperCase();
  return el;
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

function render(s) {
  state = s;
  $('modeChip').textContent = BARREL_SHORT[s.settings.barrel] + (s.settings.timer ? ` · ⏱${s.settings.timer}с` : '');
  if (s.status === 'cancelled') {
    showMessage('Игра отменена', 'Создай новую командой /newgame в группе.');
    return;
  }
  if (s.status === 'lobby') {
    $('finishModal').classList.add('hidden');
    renderLobby(s);
    showScreen('screenLobby');
    return;
  }
  renderGame(s);
  showScreen('screenGame');
}

function renderLobby(s) {
  const isOwner = me === s.owner;
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
    name.textContent = p.name + (p.uid === me ? ' (ты)' : '');
    li.append(avatar(p.uid, p.name), name, dot);
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
  for (const [seg, key] of [['segBarrel', 'barrel'], ['segTimer', 'timer']]) {
    const el = $(seg);
    el.classList.toggle('locked', !isOwner);
    el.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === String(s.settings[key])));
  }
  $('barrelDesc').textContent = BARREL_DESC[s.settings.barrel];
  const owner = s.members.find((p) => p.uid === s.owner);
  $('ownerNote').textContent = isOwner
    ? 'Ты создатель: выбери режим и жми «Начать», когда все соберутся.'
    : `Режим выбирает и игру запускает ${owner?.name || 'создатель'}.`;
  $('startBtn').classList.toggle('hidden', !isOwner);
  $('startBtn').textContent = s.members.length < 2 ? 'Начать (одному)' : `Начать игру (${s.members.length})`;
  $('leaveLobbyBtn').classList.toggle('hidden', !isMember);
}

function renderGame(s) {
  const g = s.game;
  if (!g) return;
  const box = $('players');
  box.classList.toggle('solo', g.players.length === 1);
  box.innerHTML = '';
  for (const p of g.players) {
    const chip = document.createElement('div');
    chip.className = 'pchip' + (p.uid === g.current_uid ? ' current' : '') + (p.uid === me ? ' me' : '');
    chip.dataset.uid = p.uid;
    const row = document.createElement('div');
    row.className = 'prow';
    const dot = document.createElement('span');
    dot.className = 'online-dot' + (s.online.includes(p.uid) ? ' on' : '');
    const name = document.createElement('span');
    name.className = 'pname';
    name.textContent = p.name;
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
    if (g.phase === 'order') {
      add(p.order_rolls.length ? `🎲 ${p.order_rolls.join(' → ')}` : '🎲 ждём', p.order_pending ? 'warn' : '');
    } else {
      if (!p.opened) add('не открыт');
      if (p.in_pit) add('яма', 'warn');
      if (p.on_barrel) add(`🛢 ${p.barrel_attempts}/3`, 'warn');
      if (p.barrel_falls) add(`💥${p.barrel_falls}`, 'bad');
      if (p.bolts) add(`🔩${'●'.repeat(p.bolts)}`, 'bad');
      if (p.dots) add(`точки ${p.dots}/6`, 'bad');
      if (p.dot_penalties) add(`штраф ${p.dot_penalties}/3`, 'bad');
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
    $('turnWho').textContent = cur.uid === me ? '🎯 Твой ход' : `Ходит: ${cur.name}`;
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

  // реакции
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
  }

  const inGame = g.players.some((p) => p.uid === me);
  $('leaveGameBtn').classList.toggle('hidden', !inGame || g.phase === 'finished');
  $('endBtn').classList.toggle('hidden', me !== s.owner || g.phase === 'finished');

  // смена хода
  if (g.current_uid !== prevCurrent) {
    prevCurrent = g.current_uid;
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

function renderActions(s) {
  const g = s.game;
  const roll = $('rollBtn');
  const stop = $('stopBtn');
  const actions = $('actions');
  if (!g) return;
  const lock = animating || queue.length > 0;
  actions.classList.remove('hidden');
  if (g.phase === 'order') {
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
    return;
  }
  const myTurn = g.current_uid === me;
  if (!myTurn) {
    const cur = g.players.find((p) => p.uid === g.current_uid);
    roll.textContent = `Ходит ${cur?.name || ''}…`;
    roll.disabled = true;
    stop.classList.add('hidden');
    actions.classList.add('single');
    return;
  }
  roll.textContent = `🎲 Бросить ${g.dice_left}`;
  roll.disabled = lock;
  const me_ = g.players.find((p) => p.uid === me);
  const onBarrel = s.settings.barrel === 'points' && me_?.on_barrel;
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
    li.textContent = p.name;
    const sc = document.createElement('span');
    sc.textContent = p.score;
    li.appendChild(sc);
    ol.appendChild(li);
  }
  $('rematchBtn').classList.toggle('hidden', me !== s.owner);
  $('finishModal').classList.remove('hidden');
}

// ---------- таймер ----------
setInterval(() => {
  const s = state;
  const bar = $('timerBar');
  if (!s || !s.deadline || s.status !== 'game') {
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

// ---------- правила ----------
function renderRules() {
  const mode = state?.settings.barrel || 'none';
  const m = (k) => (k === mode ? ' class="active-mode"' : '');
  $('rulesBody').innerHTML = `
    <p>5 кубиков, цель — 1000 очков.</p>
    <h3>Очки за бросок</h3>
    <ul>
      <li>1 = 10, 5 = 5</li>
      <li>три одинаковых = номинал × 10 (три единицы = 100)</li>
      <li>четыре = × 20 (четыре единицы = 200)</li>
      <li>пять = × 100 (пять единиц = 1000)</li>
      <li>стрит 1-2-3-4-5 = 125, стрит 2-3-4-5-6 = 250</li>
    </ul>
    <p>Комбинации считаются только внутри одного броска. Очковые кубики откладываются сами.</p>
    <h3>Ход</h3>
    <p>Бросай оставшиеся кубики или запиши набранное. Пустой бросок — очки хода сгорают.
    Если все 5 кубиков сыграли — обязательно бросаешь все 5 заново.</p>
    <h3>Открытие, ямы, штрафы</h3>
    <ul>
      <li><b>Открытие:</b> первая запись — минимум 50 за ход.</li>
      <li><b>Ямы</b> 200–299 и 600–699: стоять в яме можно, но выбраться нужно за один ход (до 300 / 700), иначе очки хода сгорают.</li>
      <li><b>Обгон:</b> обогнал — у обогнанного −50 (у кого 0 — не штрафуют).</li>
      <li><b>Болты:</b> пустой бросок = болт, 3 болта = −100. Не считаются до открытия, в яме и на бочке.</li>
      <li><b>Самосвал:</b> ровно 555 любым путём — счёт обнуляется.</li>
    </ul>
    <h3>Бочка</h3>
    <ul>
      <li${m('none')}><b>Без бочки:</b> ${BARREL_DESC.none}</li>
      <li${m('points')}><b>По очкам:</b> ${BARREL_DESC.points} Перебор мимо бочки — садишься на 880. На бочке могут сидеть несколько.</li>
      <li${m('open')}><b>Открытая:</b> ${BARREL_DESC.open}</li>
    </ul>
    <p class="muted">Очерёдность ходов разыгрывается бросками. Таймер (если включён) даёт время на каждое действие; по истечении очки записываются, если это можно, иначе ход пропускается.</p>`;
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
for (const [seg, key] of [['segBarrel', 'barrel'], ['segTimer', 'timer']]) {
  $(seg).querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    snd.haptic.select();
    send({ type: 'settings', [key]: key === 'timer' ? Number(b.dataset.v) : b.dataset.v });
  }));
}
function syncSoundBtn() { $('soundBtn').textContent = snd.isEnabled() ? '🔊' : '🔇'; }
onTap('soundBtn', () => {
  snd.setEnabled(!snd.isEnabled());
  syncSoundBtn();
});
syncSoundBtn();

connect();
