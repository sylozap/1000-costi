import { send } from './connection.js';
import * as snd from './sound.js';
import { isFightMap, mapSfx } from './table.js';
import { $, chipEl, el, nameOf, showError } from './ui.js';
import { showDumpTruck } from './truck.js';
import { session } from './session.js';

const toastQueue = [];
let toastBusy = false;

export function toast(emoji, text, ms = 1500, cls = '') {
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

function flashChip(uid) {
  const el = chipEl(uid);
  if (!el) return;
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
}

export async function processEvents(s, seen) {
  const g = s.game;
  if (!g) return;
  const r = s.rules;
  for (const e of g.log) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    const mine = e.uid === session.me;
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
      case 'join':
        toast('👋', e.text, 1800);
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
        showDumpTruck($('fxLayer'), nameOf(s, e.uid), r.samosval);
        flashChip(e.uid);
        flyPenalty(e.uid, '→ 0');
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

/** Каталог реплик: темы и поиск, сервер проверяет id и ограничивает частоту отправки. */
export function renderPhraseTray(s) {
  const root = $('stickerTray');
  const search = el('input', 'input');
  search.type = 'search'; search.placeholder = 'Найти фразу…';
  search.setAttribute('aria-label', 'Поиск коротких фраз');
  const tabs = el('div', 'phrase-tabs');
  const grid = el('div', 'phrase-grid');
  let active = 'all';
  const buttons = [];
  const groups = s.sticker_groups || {};
  function filter() {
    const query = search.value.trim().toLocaleLowerCase('ru');
    const ids = active === 'all' ? null : groups[active].ids;
    let count = 0;
    for (const [id, b, text] of buttons) {
      const visible = (!ids || ids.includes(id)) && text.toLocaleLowerCase('ru').includes(query);
      b.classList.toggle('hidden', !visible); count += visible;
    }
    empty.classList.toggle('hidden', count > 0);
    for (const b of tabs.children) b.classList.toggle('on', b.dataset.group === active);
  }
  for (const [id, title] of [['all', 'Все'], ...Object.entries(groups).map(([id, g]) => [id, g.title])]) {
    const b = el('button', 'chip', title); b.dataset.group = id;
    b.onclick = () => { active = id; filter(); };
    tabs.appendChild(b);
  }
  for (const [id, [emoji, text]] of Object.entries(s.stickers)) {
    const b = el('button'); b.append(el('span', null, emoji), el('small', null, text));
    b.onclick = () => {
      snd.unlock(); send({ type: 'sticker', id }); $('reactSheet').classList.add('hidden');
    };
    grid.appendChild(b); buttons.push([id, b, text]);
  }
  const empty = el('p', 'note hidden', 'Таких фраз пока нет. Попробуй другое слово.');
  search.oninput = filter;
  root.replaceChildren(search, tabs, grid, empty); filter();
}

export function showSticker(m) {
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

export function showAnnounce(text) {
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

export function showRollBadge(roll, s) {
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

export function showReaction(r) {
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

export function clearToasts() {
  toastQueue.length = 0;
  $('toast').classList.add('hidden');
}
