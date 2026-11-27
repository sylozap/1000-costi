import { openPlayerSheet } from './admin/panel.js';
import { send } from './connection.js';
import { renderPhraseTray } from './effects.js';
import { showFinish } from './finish.js';
import { openProfile } from './profile.js';
import { session } from './session.js';
import * as snd from './sound.js';
import { mapSfx } from './table.js';
import { $, TEAM_COLORS, chipEl, confirmThen, crowned, el, isBarrelMode, miniDie, onTap, openSheet } from './ui.js';

let finishShownFor = null;
let prevCurrent = null;
const prevScores = new Map();

export function resetGameScreen() {
  prevScores.clear();
  finishShownFor = null;
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

export function renderGame(s, locked) {
  const g = s.game;
  if (!g) return;
  const r = s.rules;
  const inGame = g.players.some((p) => p.uid === session.me);
  const canJoin = !inGame && s.status === 'game' && !g.teams && g.players.length < s.max_players;
  $('specBanner').classList.toggle('hidden', inGame || g.phase === 'finished');
  $('specBanner').textContent = g.teams ? '👀 Ты зритель · вступление в команды — в лобби' : '👀 Ты зритель';
  $('joinGameBtn').classList.toggle('hidden', !canJoin);
  $('joinGameBtn').textContent = 'Вступить с 0 очками' + (s.settings.stake ? ` · взнос ${s.settings.stake} 🪙` : '');
  $('pauseOverlay').classList.toggle('hidden', !s.paused);

  const box = $('players');
  box.innerHTML = '';
  for (const p of stripOrder(g)) {
    const chip = el('div', 'pchip tappable' + (p.uid === g.current_uid ? ' current' : '') + (p.uid === session.me ? ' me' : ''));
    chip.dataset.uid = p.uid;
    chip.onclick = () => (session.isAdmin ? openPlayerSheet(p.uid) : p.uid >= 0 && openProfile(p.uid));
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
    $('turnWho').textContent = cur.uid === session.me ? 'Твой ход' : `Ходит ${crowned(s, cur.uid, cur.name)}`;
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
  renderActions(s, locked);

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
    renderPhraseTray(s);
  }

  $('leaveGameBtn').classList.toggle('hidden', !inGame || g.phase === 'finished');
  $('endBtn').classList.toggle('hidden', session.me !== s.owner || g.phase === 'finished');
  $('moreBtn').classList.toggle('hidden', (!inGame && session.me !== s.owner) || g.phase === 'finished');

  // смена хода
  if (g.current_uid !== prevCurrent) {
    const was = prevCurrent;
    prevCurrent = g.current_uid;
    if (was !== null && g.phase === 'play') mapSfx('turn');
    if (g.current_uid === session.me && g.phase === 'play') {
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

export function renderActions(s, locked) {
  const g = s.game;
  const roll = $('rollBtn');
  const stop = $('stopBtn');
  const actions = $('actions');
  if (!g) return;
  const lock = locked || s.paused;
  actions.classList.remove('hidden');
  if (g.phase === 'order') {
    $('riskLine').classList.add('hidden');
    const mePending = g.players.find((p) => p.uid === session.me)?.order_pending;
    const othersPending = g.players.some((p) => p.uid !== session.me && p.order_pending);
    roll.textContent = mePending ? '🎲 Бросить' : 'Ждём остальных…';
    roll.disabled = !mePending || lock;
    const ownerHelp = session.me === s.owner && othersPending;
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
  const myTurn = g.current_uid === session.me;
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
  const me_ = g.players.find((p) => p.uid === session.me);
  const onBarrel = isBarrelMode(s.rules) && me_?.on_barrel;
  stop.classList.toggle('hidden', onBarrel);
  actions.classList.toggle('single', onBarrel);
  stop.textContent = g.turn_points ? `✍️ Записать +${g.turn_points}` : '✍️ Записать';
  stop.disabled = lock || !g.can_stop;
}

export function bindGameControls() {
  onTap('rollBtn', () => {
    const g = session.state?.game;
    if (!g) return;
    $('rollBtn').disabled = true;
    $('stopBtn').disabled = true;
    send({ type: g.phase === 'order' ? 'order_roll' : 'roll' });
  });
  onTap('stopBtn', () => {
    const g = session.state?.game;
    if (!g) return;
    $('rollBtn').disabled = true;
    $('stopBtn').disabled = true;
    send({ type: g.phase === 'order' ? 'order_roll_all' : 'stop' });
  });
  onTap('joinGameBtn', () => send({ type: 'join' }));
  onTap('leaveGameBtn', () => {
    $('moreSheet').classList.add('hidden');
    confirmThen('Выйти из игры? Вернуться будет нельзя.', () => send({ type: 'leave' }));
  });
  onTap('endBtn', () => {
    $('moreSheet').classList.add('hidden');
    confirmThen('Завершить игру для всех?', () => send({ type: 'end' }));
  });
  // игра: панель инструментов
  onTap('reactBtn', () => openSheet('reactSheet'));
  onTap('logBtn', () => openSheet('logSheet'));
  onTap('moreBtn', () => openSheet('moreSheet'));

  // ---------- таймер ----------
  setInterval(() => {
    const s = session.state;
    const bar = $('timerBar');
    if (!s || !s.deadline || s.status !== 'game' || s.paused) {
      bar.classList.add('hidden');
      return;
    }
    const total = s.settings.timer * 1000 + 2500;
    const left = s.deadline - (Date.now() + session.clockOffset);
    bar.classList.remove('hidden');
    const fill = $('timerFill');
    fill.style.width = `${Math.max(0, Math.min(100, (left / total) * 100))}%`;
    fill.classList.toggle('low', left < 10000);
  }, 250);
}
