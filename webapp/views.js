// Экраны аналитики: профиль игрока, рекорды чата, разбор партии из истории.
// Данные приходят с сервера (game/history.py); здесь только отрисовка.
import { barChart, lineChart, seriesColor } from './charts.js';

function h(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

const date = (t) => new Date(t * 1000).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
const dur = (s) => {
  const m = Math.max(1, Math.round(s / 60));
  return m >= 60 ? `${Math.floor(m / 60)} ч ${m % 60} мин` : `${m} мин`;
};
const pct = (v) => (v == null ? '—' : `${v}%`);
const PLACE = ['', '🥇', '🥈', '🥉'];

function tile(k, v, s) {
  const t = h('div', 'tile');
  t.append(h('div', 'k', k), h('div', /^[\d—%. ]+$/.test(v) ? 'v' : 'v text', v));
  if (s) t.appendChild(h('div', 's', s));
  return t;
}

function section(parent, title) {
  parent.appendChild(h('div', 'field-label', title));
}

function luckText(v) {
  if (v == null) return 'мало бросков';
  if (v >= 110) return 'заметно везёт';
  if (v >= 103) return 'везёт чуть больше среднего';
  if (v >= 97) return 'ровно как по теории';
  if (v >= 90) return 'чуть не везёт';
  return 'кубики против тебя';
}

function honestyBlock(parent, hon, who) {
  if (!hon?.n) return;
  const box = h('div', 'chart-box');
  parent.appendChild(box);
  barChart(box, hon.share, {
    labels: ['1', '2', '3', '4', '5', '6'], ref: 16.7, fmt: (v) => `${v}%`,
    label: `Как часто выпадала каждая грань ${who}`,
  });
  const verdict = { true: ['ok', 'Кубики честные: отклонения в пределах случайности'],
    false: ['bad', 'Распределение неровное — больше, чем объясняется случайностью'],
    null: ['', 'Нужно больше бросков, чтобы делать вывод'] }[String(hon.fair)];
  parent.appendChild(h('div', `verdict ${verdict[0]}`, `${verdict[1]} · бросков кубика: ${hon.n}`));
}

/** Профиль игрока. ctx: { me, avatar, skinSrc, mapName, openGame, openProfile } */
export function renderProfile(root, p, ctx) {
  root.innerHTML = '';
  root.appendChild(h('div', 'grabber'));
  const head = h('div', 'prof-head');
  const info = h('div');
  info.append(h('h2', null, p.name), h('div', 'sub', `🪙 ${p.chips} · партий в истории: ${p.games}`));
  head.append(ctx.avatar(p.uid, p.name), info);
  if (p.skin) {
    const img = document.createElement('img');
    img.src = ctx.skinSrc(p.skin);
    img.alt = '';
    head.appendChild(img);
  }
  root.appendChild(head);

  if (p.vs_viewer) {
    const v = p.vs_viewer;
    const c = h('div', 'callout');
    c.innerHTML = '<b></b>';
    c.querySelector('b').textContent = `Личные встречи: ${p.name} ${v.wins} — ${v.losses} ты`;
    c.appendChild(document.createTextNode(` · партий вместе: ${v.games}`));
    root.appendChild(c);
  }

  if (!p.games) {
    const career = p.career;
    root.appendChild(h('div', 'empty', career
      ? `Всего партий: ${career.games}, побед: ${career.wins}. Подробная аналитика появится после следующей партии.`
      : 'Пока нет сыгранных партий. Аналитика появится после первой игры.'));
    achievementsLine(root, p);
    return;
  }

  const tiles = h('div', 'tiles');
  tiles.append(
    tile('Победы', pct(p.win_rate), `${p.wins} из ${p.games}`),
    tile('Серия побед', String(p.streak), `лучшая: ${p.best_streak}`),
    tile('Лучший ход', String(p.best_turn), p.avg_turn ? `средний: ${p.avg_turn}` : null),
    tile('Самосвалы', String(p.samosvals), `обгонов: ${p.overtakes}`),
  );
  root.appendChild(tiles);

  section(root, 'Стиль игры');
  const st = h('div', 'tiles');
  const luck = tile('Удача', p.luck == null ? '—' : String(p.luck), luckText(p.luck));
  st.append(
    luck,
    tile('Стиль', p.style || '—', p.risky_rate == null ? 'мало данных' : `бросает при 1–2 кубиках в ${p.risky_rate}%`),
    tile('Решения', pct(p.decisions), p.decisions_n ? `совпадают с математикой (${p.decisions_n})` : 'мало данных'),
    tile('Сгорает', pct(p.burned_rate), `ходов; всего −${p.burned_pts}`),
  );
  root.appendChild(st);
  root.appendChild(h('div', 'note', 'Удача 100 — ровно столько очков, сколько в среднем даёт теория вероятностей. '
    + 'Решения сравниваются с выгодой ещё одного броска.'));

  section(root, 'Честность кубиков');
  honestyBlock(root, p.honesty, 'у игрока');

  if (p.rivals.length) {
    section(root, 'Соперники');
    if (p.nemesis) {
      root.appendChild(h('div', 'callout', `😈 Немезида: ${p.nemesis.name} — обыграл(а) ${p.nemesis.losses} раз из ${p.nemesis.games}`));
    }
    if (p.victim) {
      root.appendChild(h('div', 'callout', `🎯 Любимая жертва: ${p.victim.name} — обгонов и обнулений: ${p.victim.hits}`));
    }
    const list = h('div', 'list card flat');
    for (const r of p.rivals) {
      const row = h('button', 'row');
      row.append(ctx.avatar(r.uid, r.name), h('span', 'row-label', r.name), h('span', 'row-value', `${r.wins} — ${r.losses} · ${r.games} парт.`));
      row.onclick = () => ctx.openProfile(r.uid);
      list.appendChild(row);
    }
    root.appendChild(list);
  }

  if (p.maps.length) {
    section(root, 'Карты');
    const chips = h('div', 'chips');
    for (const [id, n] of p.maps) chips.appendChild(h('span', 'chip', `${ctx.mapName(id)} · ${n}`));
    root.appendChild(chips);
  }

  section(root, 'Последние партии');
  const list = h('div', 'list card flat');
  for (const g of p.recent) {
    const row = h('button', 'row');
    row.append(h('span', 'row-icon', PLACE[g.place] || `${g.place}`), h('span', 'row-label', `${g.score} очков${g.teams ? ' · команды' : ''}`),
      h('span', 'row-value', `${date(g.t)} · ${ctx.mapName(g.map)}`), h('span', 'chev', '›'));
    row.onclick = () => ctx.openGame(g.id);
    list.appendChild(row);
  }
  root.appendChild(list);
  achievementsLine(root, p);
}

function achievementsLine(root, p) {
  section(root, `Ачивки · ${p.achievements.length} из ${p.achievements_total}`);
  if (p.achievements.length) {
    const line = h('div', 'chips');
    for (const a of p.achievements) {
      const c = h('span', 'chip', `${a.emoji} ${a.title}`);
      c.title = a.desc;
      line.appendChild(c);
    }
    root.appendChild(line);
  }
}

const RECORDS = [
  ['best_turn', '💥', 'Лучший ход', (v) => `${v}`],
  ['comeback', '🔄', 'Камбэк', (v) => `отставал(а) на ${v}`],
  ['fastest', '⚡', 'Быстрая победа', (v) => `${v} ходов`],
  ['quickest', '⏱', 'Самая короткая партия', dur],
  ['longest', '🐢', 'Самая долгая партия', dur],
  ['samosvals', '🚛', 'Самосвалов за партию', (v) => `${v}`],
  ['overtakes', '🏎', 'Обгонов за партию', (v) => `${v}`],
];

/** Рекорды чата и последние партии. */
export function renderRecords(root, data, ctx) {
  root.innerHTML = '';
  root.appendChild(h('div', 'grabber'));
  root.appendChild(h('h2', null, 'Рекорды чата'));
  if (!data.games) {
    root.appendChild(h('div', 'empty', 'Рекордов пока нет: история копится с партий, сыгранных после обновления.'));
    return;
  }
  root.appendChild(h('div', 'note center', `Партий в истории: ${data.games}`));
  const list = h('div', 'list card flat');
  for (const [key, icon, title, fmt] of RECORDS) {
    const r = data.records[key];
    if (!r) continue;
    const row = h('button', 'row');
    const lab = h('span', 'row-label');
    lab.append(document.createTextNode(title), h('span', 'sub', r.name));
    row.append(h('span', 'row-icon', icon), lab, h('span', 'row-value', fmt(r.value)), h('span', 'chev', '›'));
    row.onclick = () => ctx.openGame(r.id);
    list.appendChild(row);
  }
  root.appendChild(list);

  section(root, 'Честность кубиков в чате');
  honestyBlock(root, data.honesty, 'в чате');

  section(root, 'Последние партии');
  const games = h('div', 'list card flat');
  for (const g of data.recent) {
    const row = h('button', 'row');
    const win = g.players.filter((p) => p.won).map((p) => p.name).join(' и ');
    const rest = g.players.filter((p) => !p.won).map((p) => `${p.name} ${p.score}`).join(', ');
    const lab = h('span', 'row-label', `🏆 ${win || '—'}`);
    lab.appendChild(h('span', 'sub', rest));
    row.append(lab, h('span', 'row-value', `${date(g.t)} · ${dur(g.duration)}`), h('span', 'chev', '›'));
    row.onclick = () => ctx.openGame(g.id);
    games.appendChild(row);
  }
  root.appendChild(games);
}

/** Разбор одной партии из истории: итог, график счёта и шансов. */
export function renderGameDetail(root, g, ctx) {
  root.innerHTML = '';
  root.appendChild(h('div', 'grabber'));
  root.appendChild(h('h2', null, `Партия ${date(g.t1)}`));
  root.appendChild(h('div', 'note center', `${ctx.mapName(g.map)} · ${g.preset} · ${g.turns} ходов · ${dur(g.t1 - g.t0)}`));
  const players = [...g.players].sort((a, b) => g.winners.includes(b.uid) - g.winners.includes(a.uid) || b.score - a.score);
  const list = h('div', 'list card flat ranking');
  players.forEach((p, i) => {
    const row = h('button', 'row' + (g.winners.includes(p.uid) ? ' win' : ''));
    row.append(h('span', 'place', g.winners.includes(p.uid) ? '🏆' : String(i + 1)), h('span', 'row-label', p.name), h('span', 'score', String(p.score)));
    if (!p.bot) row.onclick = () => ctx.openProfile(p.uid);
    list.appendChild(row);
  });
  root.appendChild(list);
  const order = g.players.map((p) => p.uid);
  if (g.history?.length > 1) {
    section(root, 'Счёт по ходам');
    const box = h('div', 'chart-box');
    root.appendChild(box);
    lineChart(box, g.players.map((p, i) => ({
      name: p.name, color: seriesColor(i), bold: g.winners.includes(p.uid),
      values: g.history.map((x) => x.scores[p.uid] ?? 0),
    })), { yMax: Math.max(1000, ...g.history.flatMap((x) => Object.values(x.scores))), ticks: [0, 500, 1000], label: 'Счёт игроков по ходам' });
  }
  if (g.winprob?.length > 1) {
    section(root, 'Шансы на победу');
    const box = h('div', 'chart-box');
    root.appendChild(box);
    lineChart(box, g.players.map((p) => ({
      name: p.name, color: seriesColor(order.indexOf(p.uid)), bold: g.winners.includes(p.uid),
      values: g.winprob.map((x) => Math.round(100 * (x.p[p.uid] ?? 0))),
    })), { yMax: 100, ticks: [0, 50, 100], fmt: (v) => `${v}%`, label: 'Шансы на победу по ходам' });
  }
}
