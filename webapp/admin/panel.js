import { send } from '../connection.js';
import { openProfile } from '../profile.js';
import { openEditor } from '../rules.js';
import { session } from '../session.js';
import { $, confirmThen, onTap } from '../ui.js';
import { bindDiceControls, onDiceAdmin, renderPmCustom } from './dice.js';
import { bindAdminGameFilters } from './games.js';

let pmUid = null; // игрок, открытый в админском окне

function adminTab(name) {
  document.querySelectorAll('#adminTabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  document.querySelectorAll('#adminModal .tab').forEach((t) => t.classList.toggle('hidden', t.dataset.tab !== name));
  if (name === 'rooms') send({ type: 'admin', op: 'rooms' });
  if (name === 'log') send({ type: 'admin', op: 'audit' });
  if (name === 'games') send({ type: 'admin', op: 'games' });
  if (name === 'dice') send({ type: 'admin', op: 'dice_list' });
}

function openAdmin() {
  $('adminModal').classList.remove('hidden');
  if (!session.state) {
    adminTab('rooms');
    return;
  }
  renderAdminGame(session.state);
  const me_ = session.state.cosmetics;
  $('admGold').checked = !!me_?.gold?.includes(session.me);
  $('admBadge').checked = !!me_?.badge?.includes(session.me);
}

export function renderAdminGame(s) {
  const g = s.game;
  $('admPauseBtn').textContent = s.paused ? '▶️ Продолжить' : '⏸ Пауза';
  const box = $('admPlayers');
  box.innerHTML = '';
  if (!g) {
    box.textContent = 'Игра ещё не началась.';
    return;
  }
  for (const p of g.players) {
    const row = document.createElement('button');
    row.className = 'adm-player';
    row.innerHTML = '<b></b><span></span><span class="chev">›</span>';
    row.querySelector('b').textContent = p.name;
    row.querySelector('span').textContent = p.score;
    row.onclick = () => openPlayerSheet(p.uid);
    box.appendChild(row);
  }
}

// ---------- админ: окно игрока ----------
export function openPlayerSheet(uid) {
  const p = session.state?.game?.players.find((x) => x.uid === uid);
  if (!p) return;
  pmUid = uid;
  $('pmChips').value = session.state.chips?.[uid] ?? '';
  $('playerModal').classList.remove('hidden');
  renderPlayerSheet(session.state);
  renderPmCustom(pmUid);
  send({ type: 'admin', op: 'dice_list' });
}

export function renderPlayerSheet(s) {
  const p = s.game?.players.find((x) => x.uid === pmUid);
  if (!p) {
    $('playerModal').classList.add('hidden');
    return;
  }
  $('pmName').textContent = `${p.name} · ${p.score}`;
  $('pmHuman').classList.toggle('hidden', pmUid < 0);
}

export function renderAudit(list) {
  const ul = $('admLog');
  ul.innerHTML = '';
  for (const a of [...list].reverse()) {
    const li = document.createElement('li');
    const t = new Date(a.t * 1000).toLocaleTimeString('ru-RU');
    li.textContent = `${t} ${a.name}: ${a.action}${a.detail ? ' — ' + a.detail : ''}`;
    ul.appendChild(li);
  }
  if (!list.length) ul.textContent = 'Пусто';
}

export function renderAdminRooms(list, openRoom) {
  const box = $('admRooms');
  box.innerHTML = '';
  if (!list.length) box.textContent = 'Комнат нет.';
  const STATUS = { lobby: 'лобби', game: 'идёт', finished: 'окончена', cancelled: 'отменена' };
  for (const r of list) {
    const el = document.createElement('div');
    el.className = 'adm-room' + (r.id === session.state?.id ? ' current' : '');
    el.innerHTML = '<div><b></b> <span class="muted"></span><div class="small"></div></div><button class="btn tiny">👀 Открыть</button>';
    el.querySelector('b').textContent = r.id;
    el.querySelector('.muted').textContent = (r.paused ? 'пауза' : STATUS[r.status]) + ' · ' + r.rules;
    el.querySelector('.small').textContent = r.players.join(', ');
    el.querySelector('button').onclick = () => {
      $('adminModal').classList.add('hidden');
      openRoom(r.id, true);
    };
    box.appendChild(el);
  }
}

export function updateAdminDice(m) {
  onDiceAdmin(m, pmUid);
}

export function bindAdminControls() {
  bindAdminGameFilters();
  bindDiceControls();
  onTap('pmProfileBtn', () => {
    $('playerModal').classList.add('hidden');
    if (pmUid >= 0) openProfile(pmUid);
  });
  onTap('adminBtn', openAdmin);
  onTap('msgAdminBtn', openAdmin);
  onTap('adminCloseBtn', () => $('adminModal').classList.add('hidden'));
  document.querySelectorAll('#adminTabs button').forEach((b) => b.addEventListener('click', () => adminTab(b.dataset.tab)));
  onTap('admPauseBtn', () => send({ type: 'admin', op: session.state?.paused ? 'resume' : 'pause' }));
  onTap('admEndBtn', () => confirmThen('Завершить игру для всех?', () => send({ type: 'admin', op: 'end' })));
  onTap('admRulesBtn', () => {
    $('adminModal').classList.add('hidden');
    openEditor();
  });
  onTap('pmCloseBtn', () => $('playerModal').classList.add('hidden'));
  onTap('pmKickBtn', () => confirmThen('Исключить игрока?', () => {
    send({ type: 'admin', op: 'kick', uid: pmUid });
    $('playerModal').classList.add('hidden');
  }));
  onTap('pmChipsBtn', () => send({ type: 'admin', op: 'chips', uid: pmUid, value: Number($('pmChips').value) || 0 }));
  document.querySelectorAll('#playerModal [data-grant], #playerModal [data-revoke]').forEach((b) => b.addEventListener('click', () => {
    const skin = b.dataset.grant || b.dataset.revoke;
    send({ type: 'admin', op: 'grant_skin', uid: pmUid, skin, on: !!b.dataset.grant });
  }));
  onTap('admRoomsRefresh', () => send({ type: 'admin', op: 'rooms' }));
  onTap('admLogRefresh', () => send({ type: 'admin', op: 'audit' }));
  $('admGold').addEventListener('change', (e) => send({ type: 'admin', op: 'cosmetics', gold: e.target.checked }));
  $('admBadge').addEventListener('change', (e) => send({ type: 'admin', op: 'cosmetics', badge: e.target.checked }));
  onTap('admAnnounceBtn', () => {
    const text = $('admAnnounce').value.trim();
    if (!text) return;
    send({ type: 'admin', op: 'announce', text });
    $('admAnnounce').value = '';
  });
}
