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

/** Линейный график. xs задаёт номера ходов, null оставляет разрыв в линии. */
export function lineChart(box, series, opts = {}) {
  box.replaceChildren();
  const n = Math.max(0, ...series.map((s) => s.values.length));
  if (n < 2) return;
  const xs = opts.xs || Array.from({ length: n }, (_, i) => i);
  const start = opts.xMin ?? xs[0], end = opts.xMax ?? xs[n - 1];
  const fmt = opts.fmt || String;
  const W = 320, H = 170, L = 34, R = 10, T = 13, B = 24;
  const yMax = opts.yMax ?? Math.max(1, ...series.flatMap((s) => s.values));
  const x = (v) => L + (W - L - R) * (v - start) / Math.max(1, end - start);
  const y = (v) => T + (H - T - B) * (1 - v / yMax);
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': opts.label || '' }, box);
  for (const v of opts.ticks || [0, yMax / 2, yMax]) {
    el('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: 'grid' }, svg);
    el('text', { x: L - 6, y: y(v) + 3, class: 'axis', 'text-anchor': 'end' }, svg).textContent = fmt(v);
  }
  const ticks = [...new Set([start, Math.round((start + end) / 2), end])];
  ticks.forEach((v, i) => {
    el('text', { x: x(v), y: H - 5, class: 'axis', 'text-anchor': i === 0 ? 'start' : i === ticks.length - 1 ? 'end' : 'middle' },
      svg).textContent = opts.xs && i === ticks.length - 1 && opts.turns ? `Ход ${v}` : v;
  });
  const paths = series.map((s) => {
    let path = '', previous = null;
    s.values.forEach((v, i) => {
      if (v == null) { previous = null; return; }
      const px = x(xs[i]), py = y(v);
      if (previous == null) path += `M${px},${py}h0.01`;
      else if (opts.step) path += `H${px}V${py}`;
      else path += `L${px},${py}`;
      previous = v;
    });
    return el('path', { d: path, fill: 'none', stroke: s.color, 'stroke-width': s.bold ? 2.5 : 2,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
  });
  const cross = el('line', { y1: T, y2: H - B, class: 'cross', visibility: 'hidden' }, svg);
  const tip = document.createElement('div');
  tip.className = 'chart-tip hidden';
  box.appendChild(tip);
  const visible = new Set(series.map((_, i) => i));
  let selected = null;
  function show(i) {
    selected = i;
    cross.setAttribute('x1', x(xs[i]));
    cross.setAttribute('x2', x(xs[i]));
    cross.setAttribute('visibility', 'visible');
    const head = document.createElement('b');
    head.textContent = opts.xTitle?.(i) ?? `Ход ${xs[i]}`;
    tip.replaceChildren(head);
    const rows = series.filter((s, j) => visible.has(j) && s.values[i] != null);
    for (const s of rows.sort((a, b) => b.values[i] - a.values[i])) {
      const d = document.createElement('div');
      const sw = document.createElement('i'); sw.style.background = s.color;
      const name = document.createElement('span'); name.textContent = s.name;
      const v = document.createElement('em'); v.textContent = fmt(s.values[i]);
      d.append(sw, name, v); tip.appendChild(d);
    }
    if (!rows.length) tip.append('Нет данных');
    tip.classList.remove('hidden');
    tip.style.left = `${Math.min(62, Math.max(0, x(xs[i]) / W * 100 - 18))}%`;
    opts.onSelect?.(i);
  }
  const hit = el('rect', { x: L, y: 0, width: W - L - R, height: H - B, fill: 'transparent' }, svg);
  function move(ev) {
    const r = svg.getBoundingClientRect();
    const px = (ev.clientX - r.left) / r.width * W;
    const i = xs.reduce((best, v, j) => Math.abs(x(v) - px) < Math.abs(x(xs[best]) - px) ? j : best, 0);
    show(i);
  }
  hit.addEventListener('pointermove', (ev) => { if (ev.pointerType === 'mouse') move(ev); });
  hit.addEventListener('pointerdown', move);
  if (opts.interactive) {
    svg.setAttribute('tabindex', '0');
    svg.addEventListener('keydown', (ev) => {
      const shift = { ArrowLeft: -1, ArrowRight: 1 }[ev.key];
      if (!shift) return;
      ev.preventDefault();
      show(Math.min(n - 1, Math.max(0, (selected ?? 0) + shift)));
    });
  } else {
    hit.addEventListener('pointerleave', () => {
      cross.setAttribute('visibility', 'hidden');
      tip.classList.add('hidden');
    });
  }
  for (const [i, label] of opts.markers || []) {
    const marker = el('circle', { cx: x(xs[i]), cy: T - 5, r: 4, class: 'chart-marker',
      tabindex: 0, role: 'button', 'aria-label': label }, svg);
    marker.addEventListener('click', () => show(i));
    marker.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); show(i); }
    });
  }
  if (series.length > 1) {
    const legend = document.createElement('div');
    legend.className = 'legend';
    series.forEach((s, i) => {
      const item = document.createElement(opts.interactive ? 'button' : 'span');
      const swatch = document.createElement('i'); swatch.style.background = s.color;
      item.append(swatch, document.createTextNode(s.name));
      if (opts.interactive) {
        item.type = 'button'; item.setAttribute('aria-pressed', 'true');
        item.onclick = () => {
          if (visible.has(i)) {
            if (visible.size === 1) return;
            visible.delete(i);
          } else visible.add(i);
          item.setAttribute('aria-pressed', String(visible.has(i)));
          paths[i].setAttribute('visibility', visible.has(i) ? 'visible' : 'hidden');
          if (selected != null) show(selected);
        };
      }
      legend.appendChild(item);
    });
    box.appendChild(legend);
  }
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
