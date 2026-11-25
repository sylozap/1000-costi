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
  if (s < 60) return `${Math.max(0, Math.round(s))} с`;
  const m = Math.floor(s / 60);
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
  const verdict = { true: ['ok', 'Тест не выявил отклонения от равномерного распределения'],
    false: ['bad', 'Тест выявил статистически значимое отклонение'],
    null: ['', 'Для проверки нужно больше выпавших граней'] }[String(hon.fair)];
  parent.appendChild(h('div', `verdict ${verdict[0]}`, `${verdict[1]} · бросков кубика: ${hon.n}`));
}

const LOSS_LABELS = {
  zero: 'Пустой бросок', over: 'Перебор', samosval: 'Самосвал', overtake: 'Обгон',
  tie: 'Обнуление при равенстве', bolt: 'Болты', barrel: 'Бочка', timeout: 'Таймер', limit: 'Лимит бросков',
};

function profileFilters(root, p, ctx) {
  const fields = [
    ['period', 'Период', [['all', 'Всё время'], ['30', '30 дней'], ['90', '90 дней']]],
    ['mode', 'Режим', [['all', 'Все режимы'], ['solo', 'Одиночные'], ['teams', 'Командные']]],
    ['opponents', 'Состав', [['all', 'Любой состав'], ['human', 'Только люди'], ['bot', 'С ботами']]],
    ['preset', 'Правила', [['', 'Все пресеты'], ...p.presets.map((preset) => [preset, preset])]],
  ];
  if (p.chat_filter) fields.splice(1, 0, ['chat', 'Чат', [['all', 'Все чаты'], ['current', 'Текущий чат']]]);
  const form = h('form', 'stats-filters');
  for (const [key, label, options] of fields) {
    const field = h('label', null, label);
    const select = h('select', 'input');
    select.name = key;
    for (const [value, title] of options) {
      const option = h('option', null, title); option.value = value; select.appendChild(option);
    }
    select.value = p.filters[key];
    field.appendChild(select); form.appendChild(field);
  }
  form.addEventListener('change', () => ctx.openProfile(p.uid, Object.fromEntries(new FormData(form))));
  form.addEventListener('submit', (ev) => ev.preventDefault());
  root.appendChild(form);
}

function profileForm(root, p) {
  if (p.form.length < 2) return;
  section(root, `Форма за последние ${p.form.length} партий`);
  const tiles = h('div', 'tiles');
  const available = p.form.filter((g) => g.form_turn != null);
  const rates = p.form.filter((g) => g.form_success != null);
  tiles.append(
    tile('Победы', String(p.form.filter((g) => g.won).length), `из ${p.form.length}`),
    tile('Среднее место', (p.form.reduce((n, g) => n + g.place, 0) / p.form.length).toFixed(1)),
    tile('Очки за ход', available.length ? (available.reduce((n, g) => n + g.form_turn, 0) / available.length).toFixed(1) : '—',
      available.length ? `партий с данными: ${available.length}` : null),
    tile('Ходы с записью', rates.length ? `${Math.round(rates.reduce((n, g) => n + g.form_success, 0) / rates.length)}%` : '—',
      rates.length ? `партий с данными: ${rates.length}` : null),
  );
  root.appendChild(tiles);
  const box = h('div', 'chart-box'); root.appendChild(box);
  lineChart(box, [{ name: 'Место', color: seriesColor(0), values: p.form.map((g) => g.place) }],
    { xs: p.form.map((_, i) => i + 1), ticks: [1, Math.max(...p.form.map((g) => g.place))].filter((v, i, a) => a.indexOf(v) === i),
      xTitle: (i) => `${date(p.form[i].t)} · ${p.form[i].won ? 'победа' : 'место'}`,
      yMax: Math.max(2, ...p.form.map((g) => g.place)), label: 'Места по партиям' });
}

function lossList(parent, title, values) {
  const rows = Object.entries(values).sort((a, b) => b[1] - a[1]);
  const group = h('div', 'note');
  group.appendChild(h('b', null, title));
  group.appendChild(h('div', null, rows.map(([key, n]) => `${LOSS_LABELS[key] || key} −${n}`).join(' · ') || '0 очков'));
  parent.appendChild(group);
}

function profileLosses(root, d) {
  if (!d.games) return;
  section(root, 'Потери очков');
  lossList(root, 'Сгорело в ходе', d.burned);
  lossList(root, 'Списано со счёта', d.deductions);
  const tiles = h('div', 'tiles');
  tiles.append(
    tile('Выходы из ямы', `${d.pit_exits} из ${d.pit_attempts}`, 'успешные попытки'),
    tile('Победы с бочки', `${d.barrel_wins} из ${d.barrel_entries}`, 'посадки игрока или его команды, сделанные его ходом'),
  );
  root.append(tiles, h('div', 'note', `Подробные данные по ${d.games} парт.`));
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
  profileFilters(root, p, ctx);

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
    const filtered = Object.entries(p.filters).some(([key, value]) => key === 'preset' ? Boolean(value) : value !== 'all');
    root.appendChild(h('div', 'empty', filtered ? 'По этим фильтрам партий нет.' : career
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
  const luck = tile('Удача', p.luck == null ? '—' : String(p.luck), `${luckText(p.luck)} · бросков: ${p.rolls_n}`);
  st.append(
    luck,
    tile('Стиль', p.style || '—', p.risky_rate == null ? 'мало данных' : `бросает при 1–2 кубиках в ${p.risky_rate}% · выборов: ${p.risky_n}`),
    tile('Решения', pct(p.decisions), p.decisions_n ? `совпадений с оценкой · выборов: ${p.decisions_n}` : 'мало данных'),
    tile('Пустой бросок с потерей', pct(p.burned_rate), `от всех ходов · всего −${p.burned_pts}`),
  );
  root.appendChild(st);
  root.appendChild(h('div', 'note', 'Удача 100 — ровно столько очков, сколько в среднем даёт теория вероятностей. '
    + 'Оценка решений сравнивает запись с ожидаемым результатом одного броска.'));

  profileForm(root, p);
  profileLosses(root, p.detail);
  section(root, 'Распределение граней');
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

  section(root, 'Распределение граней в чате');
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

function gameSides(players, winners, teams) {
  const groups = new Map();
  for (const p of players) {
    const key = teams ? p.team : p.uid;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  return [...groups.values()].map((members, i) => ({
    members, name: members.map((p) => p.name).join(' и '), score: members[0].score,
    color: seriesColor(i), bold: members.some((p) => winners.includes(p.uid)),
  }));
}

const MARKED = new Set(['samosval', 'tie_zero', 'barrel_sit', 'barrel_knock', 'barrel_fall',
  'barrel_zero', 'bolt_penalty', 'dot_penalty', 'dot_zero', 'overtake', 'win', 'rules_changed']);

export function renderMatchReview(root, g) {
  root.replaceChildren();
  const sides = gameSides(g.players, g.winners, g.teams);
  const hist = (g.history || []).map((row, i, a) => ({
    ...row, turn: i === 0 && row.turn === 1 && a[1]?.turn === 1 ? 0 : row.turn,
  }));
  const top = Math.max(0, ...g.players.map((p) => p.st?.best_turn ?? p.best_turn ?? 0));
  const best = g.players.find((p) => (p.st?.best_turn ?? p.best_turn) === top);
  const gap = g.comeback ?? Math.max(0, ...hist.map((row) => {
    const scores = g.winners.map((uid) => row.scores[uid]).filter((v) => v != null);
    return scores.length ? Math.max(...Object.values(row.scores)) - Math.max(...scores) : 0;
  }));
  const facts = [`${g.turns} ходов`];
  if (g.duration != null) facts.unshift(dur(g.duration));
  if (best && top) facts.push(`Лучший ход +${top} · ${best.name}`);
  if (gap) facts.push(`Отставание победителя до ${gap}`);
  root.appendChild(h('div', 'note match-facts', facts.join(' · ')));

  const first = hist[0]?.turn ?? 0;
  const last = g.turns;
  const xOpts = { xMin: first, xMax: last, turns: true, interactive: true };
  if (hist.length > 1) {
    section(root, 'Счёт по ходам');
    const chart = h('div', 'chart-box');
    const detail = h('div', 'turn-detail note', 'Нажми на график, чтобы разобрать ход.');
    detail.setAttribute('aria-live', 'polite');
    root.append(chart, detail);
    const markers = hist.flatMap((row, i) => {
      const events = (row.events || []).filter((e) => MARKED.has(e.kind)).map((e) => e.text);
      if (top && row.result?.recorded === top) events.unshift(`Лучший ход: +${top}`);
      return events.length ? [[i, `Ход ${row.turn}. ${events.join('. ')}`]] : [];
    });
    const lookup = (side, row) => side.members.map((p) => row.scores[p.uid]).find((v) => v != null) ?? null;
    lineChart(chart, sides.map((side) => ({ ...side, values: hist.map((row) => lookup(side, row)) })), {
      ...xOpts, xs: hist.map((row) => row.turn), step: true, markers,
      yMax: Math.max(1000, ...hist.flatMap((row) => Object.values(row.scores))), ticks: [0, 500, 1000],
      label: 'Счёт по ходам', xTitle: (i) => hist[i].turn ? `Ход ${hist[i].turn}` : 'Начало партии',
      onSelect(i) {
        const row = hist[i];
        if (!row.turn) { detail.textContent = 'Начало партии'; return; }
        const who = g.players.find((p) => p.uid === row.uid);
        detail.replaceChildren(h('b', null, `Ход ${row.turn}${who ? ` · ${who.name}` : ''}`));
        const result = row.result;
        if (result?.recorded != null) detail.appendChild(h('div', null, `В счёт +${result.gain} · набрано за ход ${result.recorded}`));
        else if (result?.reason) detail.appendChild(h('div', null,
          `${LOSS_LABELS[result.reason] || result.reason} · сгорело ${result.burned}`));
        for (const e of row.events || []) detail.appendChild(h('div', null, e.text));
        if (!result && !row.events?.length) detail.appendChild(h('div', null, 'Сохранён счёт после хода.'));
      },
    });
  }

  if (g.winprob?.length > 1) {
    section(root, 'Шансы на победу');
    root.appendChild(h('div', 'note', 'Оценка симуляции с одинаковой стратегией для всех. Точки показывают шанс перед следующим ходом, последняя — итог.'));
    const chart = h('div', 'chart-box'); root.appendChild(chart);
    const probabilities = new Map();
    g.winprob.forEach((row, i) => {
      const final = row.final || (i === g.winprob.length - 1 && row.turn === last);
      probabilities.set(final ? row.turn : row.turn - 1, row.p);
    });
    const xs = Array.from({ length: last - first + 1 }, (_, i) => i + first);
    lineChart(chart, sides.map((side) => ({ ...side, values: xs.map((x) => {
      const p = side.members.map((member) => probabilities.get(x)?.[member.uid]).find((v) => v != null);
      return p == null ? null : Math.round(p * 100);
    }) })), { ...xOpts, xs, yMax: 100, ticks: [0, 50, 100], fmt: (v) => `${v}%`, label: 'Шансы на победу по ходам' });
  }

  if (g.players.some((p) => p.detail || p.an?.detail)) {
    section(root, 'Итоги по игрокам');
    const wrap = h('div', 'match-table');
    const table = h('table');
    const headers = h('tr');
    for (const label of ['Игрок', 'Ходы', 'В счёт', 'Сгорело', 'Списано', 'Лучший', 'Обгоны', 'Штрафы']) {
      const th = h('th', null, label); th.scope = 'col'; headers.appendChild(th);
    }
    const thead = h('thead'); thead.appendChild(headers); table.appendChild(thead);
    const body = h('tbody');
    const total = (obj) => Object.values(obj).reduce((a, b) => a + b, 0);
    for (const p of g.players) {
      const d = p.detail || p.an?.detail;
      const st = p.st || p;
      const tr = h('tr');
      const name = h('th', null, p.name); name.scope = 'row'; tr.appendChild(name);
      for (const value of [
        d?.turns, d?.recorded, d && total(d.burned), d && total(d.deductions),
        st.best_turn, st.overtakes, d && total(Object.fromEntries(Object.entries(d.deductions).filter(([key]) =>
          ['bolt', 'barrel', 'over'].includes(key)))),
      ]) tr.appendChild(h('td', null, String(value ?? '—')));
      body.appendChild(tr);
    }
    table.appendChild(body); wrap.appendChild(table); root.appendChild(wrap);
    root.appendChild(h('div', 'note', 'Списано и штрафы показаны в очках. В командной игре изменение общего счёта относится к игроку, указанному в событии.'));
  }
}

/** Разбор партии из истории. */
export function renderGameDetail(root, g, ctx) {
  root.replaceChildren(h('div', 'grabber'), h('h2', null, `Партия ${date(g.t1)}`),
    h('div', 'note center', `${ctx.mapName(g.map)} · ${g.preset}`));
  const list = h('div', 'list card flat ranking');
  const sides = gameSides(g.players, g.winners, g.teams);
  sides.sort((a, b) => Number(b.bold) - Number(a.bold) || b.score - a.score);
  sides.forEach((side, i) => {
    const humans = side.members.filter((p) => !p.bot);
    const solo = side.members.length === 1 && humans.length === 1;
    const row = h(solo ? 'button' : 'div', 'row' + (side.bold ? ' win' : ''));
    row.append(h('span', 'place', side.bold ? '🏆' : String(i + 1)),
      h('span', 'row-label', side.name), h('span', 'score', String(side.score)));
    if (solo) row.onclick = () => ctx.openProfile(side.members[0].uid);
    list.appendChild(row);
    if (side.members.length > 1 && humans.length) {
      const links = h('div', 'legend team-profile-links');
      for (const p of humans) {
        const link = h('button', null, p.name);
        link.type = 'button'; link.onclick = () => ctx.openProfile(p.uid);
        links.appendChild(link);
      }
      list.appendChild(links);
    }
  });
  const review = h('div');
  root.append(list, review);
  renderMatchReview(review, { ...g, duration: g.t1 - g.t0 });
}
