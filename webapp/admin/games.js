import { send } from '../connection.js';
import { $, confirmThen, showInfo } from '../ui.js';

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

export function updateAdminGames(m) {
  admGames = m;
  renderAdminGames();
  if (m.text) showInfo(m.text);
}

export function bindAdminGameFilters() {
  $('admGamesFilter').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    admGamesFilter = b.dataset.f;
    $('admGamesFilter').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    renderAdminGames();
  }));
}
