import { send } from './connection.js';
import { canEditRules, session } from './session.js';
import { $, isBarrelMode, onTap, showError, showInfo, tg } from './ui.js';

export function renderRules() {
  const s = session.state;
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

export function openEditor() {
  const s = session.state;
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
  $('shareName').value = session.state && session.state.preset !== 'Свои' && session.state.preset !== 'Классика' && session.state.preset !== 'Вариант 2' ? session.state.preset : '';
  $('shareModal').classList.remove('hidden');
}

let sharedLink = '';
export function onPresetSaved(m) {
  sharedLink = m.link || '';
  $('shareCode').textContent = m.id;
  $('shareLink').textContent = sharedLink || `Код для группы: /newgame ${m.id}`;
  $('shareSendBtn').classList.toggle('hidden', !sharedLink);
  $('shareCopyBtn').classList.toggle('hidden', !sharedLink);
  $('shareResult').classList.remove('hidden');
  send({ type: 'my_presets' });
}

export function bindRuleControls() {
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
}
