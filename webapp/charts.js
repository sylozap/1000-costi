// Графики на SVG: линии (счёт и шансы по ходам) и столбцы (честность граней).
// Правила dataviz: тонкие линии 2px, цвета закреплены за игроком в фиксированном порядке,
// легенда при 2+ сериях, подсказка с перекрестьем при касании, сетка и оси приглушены.

const NS = 'http://www.w3.org/2000/svg';

// категориальная палитра (проверена валидатором отдельно для тёмной и светлой темы)
const SERIES = {
  dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
  light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'],
};

export function seriesColor(i) {
  const theme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  return SERIES[theme][i % 8];
}

function el(tag, attrs, parent) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  parent.appendChild(e);
  return e;
}

function legend(box, series) {
  const lg = document.createElement('div');
  lg.className = 'legend';
  for (const s of series) {
    const it = document.createElement('span');
    const i = document.createElement('i');
    i.style.background = s.color;
    it.append(i, document.createTextNode(s.name));
    lg.appendChild(it);
  }
  box.appendChild(lg);
}

/**
 * Линейный график.
 * series: [{ name, color, values: number[], bold? }], все одной длины (точка = ход).
 * opts: { yMax, ticks: number[], fmt: (v) => string, xTitle: (i) => string, label }
 */
export function lineChart(box, series, opts = {}) {
  box.innerHTML = '';
  const n = Math.max(0, ...series.map((s) => s.values.length));
  if (n < 2) return;
  const fmt = opts.fmt || ((v) => String(v));
  const W = 320, H = 170, L = 34, R = 10, T = 10, B = 20;
  const yMax = opts.yMax ?? Math.max(1, ...series.flatMap((s) => s.values));
  const x = (i) => L + ((W - L - R) * i) / (n - 1);
  const y = (v) => T + (H - T - B) * (1 - v / yMax);
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': opts.label || '' }, box);
  for (const v of opts.ticks || [0, yMax / 2, yMax]) {
    el('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: 'grid' }, svg);
    el('text', { x: L - 6, y: y(v) + 3, class: 'axis', 'text-anchor': 'end' }, svg).textContent = fmt(v);
  }
  el('text', { x: W - R, y: H - 5, class: 'axis', 'text-anchor': 'end' }, svg).textContent = `ходов: ${n - 1}`;
  for (const s of series) {
    const pts = s.values.map((v, i) => `${x(i).toFixed(1)},${y(v ?? 0).toFixed(1)}`).join(' ');
    el('polyline', { points: pts, fill: 'none', stroke: s.color, 'stroke-width': s.bold ? 2.5 : 2,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
  }
  const cross = el('line', { y1: T, y2: H - B, class: 'cross', visibility: 'hidden' }, svg);
  const tip = document.createElement('div');
  tip.className = 'chart-tip hidden';
  box.appendChild(tip);
  const hit = el('rect', { x: L, y: 0, width: W - L - R, height: H, fill: 'transparent' }, svg);
  const move = (ev) => {
    const r = svg.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * W;
    const i = Math.max(0, Math.min(n - 1, Math.round(((px - L) / (W - L - R)) * (n - 1))));
    cross.setAttribute('x1', x(i));
    cross.setAttribute('x2', x(i));
    cross.setAttribute('visibility', 'visible');
    const rows = [...series].sort((a, b) => (b.values[i] ?? 0) - (a.values[i] ?? 0));
    tip.innerHTML = '';
    const head = document.createElement('b');
    head.textContent = opts.xTitle ? opts.xTitle(i) : `Ход ${i}`;
    tip.appendChild(head);
    for (const s of rows) {
      const d = document.createElement('div');
      const sw = document.createElement('i');
      sw.style.background = s.color;
      const nm = document.createElement('span');
      nm.textContent = s.name;
      const v = document.createElement('em');
      v.textContent = fmt(s.values[i] ?? 0);
      d.append(sw, nm, v);
      tip.appendChild(d);
    }
    tip.classList.remove('hidden');
    tip.style.left = `${Math.min(62, Math.max(0, (x(i) / W) * 100 - 18))}%`;
  };
  hit.addEventListener('pointermove', move);
  hit.addEventListener('pointerdown', move);
  hit.addEventListener('pointerleave', () => {
    cross.setAttribute('visibility', 'hidden');
    tip.classList.add('hidden');
  });
  if (series.length > 1) legend(box, series);
}

/**
 * Столбчатый график одной серии (без легенды — название даёт заголовок).
 * opts: { labels, ref (опорная линия), fmt, max, hot: (i) => bool }
 */
export function barChart(box, values, opts = {}) {
  box.innerHTML = '';
  const fmt = opts.fmt || ((v) => String(v));
  const W = 320, H = 130, L = 38, R = 8, T = 10, B = 20;
  const max = opts.max ?? Math.max(1, ...values, opts.ref || 0) * 1.15;
  const n = values.length;
  const slot = (W - L - R) / n;
  const bw = Math.min(34, slot - 8);
  const y = (v) => T + (H - T - B) * (1 - v / max);
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': opts.label || '' }, box);
  el('line', { x1: L, x2: W - R, y1: y(0), y2: y(0), class: 'grid' }, svg);
  if (opts.ref != null) {
    el('line', { x1: L, x2: W - R, y1: y(opts.ref), y2: y(opts.ref), class: 'ref' }, svg);
    el('text', { x: L - 4, y: y(opts.ref) + 3, class: 'axis', 'text-anchor': 'end' }, svg).textContent = fmt(opts.ref);
  }
  const tip = document.createElement('div');
  tip.className = 'chart-tip hidden';
  box.appendChild(tip);
  values.forEach((v, i) => {
    const cx = L + slot * i + slot / 2;
    const top = y(v);
    const h = Math.max(0, y(0) - top);
    // столбец со скруглённой вершиной, основание на нуле
    const r = Math.min(4, bw / 2, h);
    const d = `M${cx - bw / 2},${y(0)} V${top + r} Q${cx - bw / 2},${top} ${cx - bw / 2 + r},${top} H${cx + bw / 2 - r} Q${cx + bw / 2},${top} ${cx + bw / 2},${top + r} V${y(0)} Z`;
    el('path', { d, class: 'bar' + (opts.hot?.(i) ? ' hot' : '') }, svg);
    el('text', { x: cx, y: H - 5, class: 'axis', 'text-anchor': 'middle' }, svg).textContent = opts.labels?.[i] ?? i + 1;
    const hit = el('rect', { x: cx - slot / 2, y: 0, width: slot, height: H, fill: 'transparent' }, svg);
    const show = () => {
      tip.textContent = `${opts.labels?.[i] ?? i + 1}: ${fmt(v)}`;
      tip.classList.remove('hidden');
      tip.style.left = `${Math.min(62, Math.max(0, (cx / W) * 100 - 18))}%`;
    };
    hit.addEventListener('pointerenter', show);
    hit.addEventListener('pointerdown', show);
    hit.addEventListener('pointerleave', () => tip.classList.add('hidden'));
  });
}
