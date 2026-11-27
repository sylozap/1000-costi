import { send } from '../connection.js';
import { customFaceCanvas } from '../dice3d.js';
import { registerCustom } from '../table.js';
import { $, avatar, confirmThen, el, onTap, openSheet, showError } from '../ui.js';

let diceAdmin = null; // последний список кубиков с картинками (админ)
let de = null; // редактор кубика: { id, name, faces: [{ src, st: 'new'|'keep'|'none' }] }

const imgCache = {};
function loadImg(src) {
  imgCache[src] ||= new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
  return imgCache[src];
}

/** Фото с телефона → квадрат 384×384 (обрезка по центру) → JPEG до ~380 КБ. */
async function fileToFace(file) {
  const url = URL.createObjectURL(file);
  const img = await loadImg(url);
  URL.revokeObjectURL(url);
  if (!img) throw new Error('не удалось открыть картинку');
  const S = 384;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const k = Math.max(S / img.naturalWidth, S / img.naturalHeight);
  const w = img.naturalWidth * k, h = img.naturalHeight * k;
  g.drawImage(img, (S - w) / 2, (S - h) / 2, w, h);
  let q = 0.86;
  let out = c.toDataURL('image/jpeg', q);
  while (out.length > 500000 && q > 0.4) {
    q -= 0.12;
    out = c.toDataURL('image/jpeg', q);
  }
  return out;
}

export function onDiceAdmin(m, playerUid) {
  diceAdmin = m;
  registerCustom(Object.fromEntries(m.list.map((v) => [v.skin, v])));
  renderDiceAdmin();
  renderPmCustom(playerUid);
  if (de && m.saved && !de.id) de.id = m.saved;
  if (de?.id && !$('diceModal').classList.contains('hidden')) {
    const v = m.list.find((x) => x.id === de.id);
    if (v && m.saved === de.id) openDiceEditor(v, true); // после сохранения — показываем то, что на сервере
    else renderDiceOwners();
  }
}

function renderDiceAdmin() {
  const box = $('admDiceList');
  box.innerHTML = '';
  if (!diceAdmin?.list.length) {
    box.appendChild(el('div', 'empty', 'Кубиков с картинками пока нет'));
    return;
  }
  for (const v of diceAdmin.list) {
    const row = el('button', 'row');
    const img = el('img', 'dice-thumb');
    img.src = v.faces[0];
    img.alt = '';
    const lab = el('span', 'row-label', v.name);
    lab.appendChild(el('span', 'sub', v.owners.length ? `у ${v.owners.map((o) => o.name).join(', ')}` : 'ни у кого'));
    row.append(img, lab, el('span', 'chev', '›'));
    row.onclick = () => openDiceEditor(v);
    box.appendChild(row);
  }
}

function openDiceEditor(v, keepOpen = false) {
  de = {
    id: v?.id || null,
    name: v?.name || '',
    faces: [0, 1, 2, 3, 4, 5].map((i) => (v?.own[i] ? { src: v.faces[i], st: 'keep' } : { src: null, st: 'none' })),
  };
  $('deName').value = de.name;
  $('deSearch').value = '';
  renderDiceEditor();
  if (!keepOpen) openSheet('diceModal');
}

/** Картинка, которую реально покажет грань v: своя или первая заполненная. */
function effectiveFace(v) {
  return de.faces[v - 1].src || de.faces.find((f) => f.src)?.src || null;
}

async function faceDataUrl(v) {
  const src = effectiveFace(v);
  return customFaceCanvas(src ? await loadImg(src) : null, v).toDataURL('image/jpeg', 0.8);
}

function renderDiceEditor() {
  $('deTitle').textContent = de.id ? 'Кубик с картинками' : 'Новый кубик';
  $('deDelete').classList.toggle('hidden', !de.id);
  $('deOwnersBox').classList.toggle('hidden', !de.id);
  const grid = $('deFaces');
  grid.innerHTML = '';
  const any = de.faces.some((f) => f.src);
  de.faces.forEach((f, i) => {
    const v = i + 1;
    const slot = el('button', 'face-slot' + (f.src ? '' : any ? ' inherited' : ' empty'));
    slot.setAttribute('aria-label', `Грань ${v}`);
    if (any) {
      const img = el('img');
      img.alt = '';
      faceDataUrl(v).then((u) => { img.src = u; });
      slot.appendChild(img);
    }
    slot.appendChild(el('span', 'label', String(v)));
    if (f.src) {
      const x = el('span', 'clear', '✕');
      x.onclick = (e) => {
        e.stopPropagation();
        de.faces[i] = { src: null, st: 'none' };
        renderDiceEditor();
      };
      slot.appendChild(x);
    }
    slot.onclick = () => {
      de.pick = v;
      $('deFile').value = '';
      $('deFile').click();
    };
    grid.appendChild(slot);
  });
  // куб для предпросмотра: как у настоящего кубика, противоположные грани в сумме дают 7
  const cube = $('deCube');
  cube.innerHTML = '';
  for (const v of [1, 2, 6, 5, 3, 4]) {
    const side = el('div');
    if (any) {
      const img = el('img');
      img.alt = '';
      faceDataUrl(v).then((u) => { img.src = u; });
      side.appendChild(img);
    }
    cube.appendChild(side);
  }
  renderDiceOwners();
}

function renderDiceOwners() {
  if (!de?.id || !diceAdmin) return;
  const v = diceAdmin.list.find((x) => x.id === de.id);
  if (!v) return;
  const owners = new Set(v.owners.map((o) => o.uid));
  const q = $('deSearch').value.trim().toLowerCase();
  const people = diceAdmin.people
    .filter((p) => !q || p.name.toLowerCase().includes(q) || String(p.uid).includes(q))
    .sort((a, b) => owners.has(b.uid) - owners.has(a.uid))
    .slice(0, 60);
  const box = $('deOwners');
  box.innerHTML = '';
  for (const p of people) {
    const row = el('label', 'row');
    const sw = el('input', 'switch');
    sw.type = 'checkbox';
    sw.checked = owners.has(p.uid);
    sw.onchange = () => send({ type: 'admin', op: 'grant_skin', uid: p.uid, skin: v.skin, on: sw.checked });
    row.append(avatar(p.uid, p.name), el('span', 'row-label', p.name), sw);
    box.appendChild(row);
  }
  if (!people.length) box.appendChild(el('div', 'empty', 'Никого не найдено'));
}

/** В карточке игрока (админ): выдать или забрать кубики с картинками. */
export function renderPmCustom(playerUid) {
  const box = $('pmCustom');
  box.innerHTML = '';
  if (!diceAdmin?.list.length) {
    box.appendChild(el('div', 'empty', 'Кубиков с картинками нет — создай в 🛠 → Кубики'));
    return;
  }
  for (const v of diceAdmin.list) {
    const row = el('label', 'row');
    const img = el('img', 'dice-thumb');
    img.src = v.faces[0];
    img.alt = '';
    const sw = el('input', 'switch');
    sw.type = 'checkbox';
    sw.checked = v.owners.some((o) => o.uid === playerUid);
    sw.onchange = () => send({ type: 'admin', op: 'grant_skin', uid: playerUid, skin: v.skin, on: sw.checked });
    row.append(img, el('span', 'row-label', v.name), sw);
    box.appendChild(row);
  }
}

export function bindDiceControls() {
  onTap('admDiceNew', () => openDiceEditor(null));
  $('deFile').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file || !de?.pick) return;
    try {
      de.faces[de.pick - 1] = { src: await fileToFace(file), st: 'new' };
      renderDiceEditor();
    } catch (err) {
      showError(err.message);
    }
  });
  $('deSearch').addEventListener('input', renderDiceOwners);
  onTap('deSave', () => {
    de.name = $('deName').value.trim();
    if (!de.name) return showError('Дай кубику название');
    if (!de.faces.some((f) => f.src)) return showError('Загрузи хотя бы одну картинку');
    send({
      type: 'admin', op: 'dice_save', id: de.id, name: de.name,
      faces: de.faces.map((f) => (f.st === 'new' ? f.src : f.st === 'keep' ? 'keep' : null)),
    });
  });
  onTap('deDelete', () => confirmThen(`Удалить кубик «${de.name}»? Он пропадёт у всех, кому выдан.`, () => {
    send({ type: 'admin', op: 'dice_delete', id: de.id });
    $('diceModal').classList.add('hidden');
    de = null;
  }));
}
