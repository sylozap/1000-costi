import { send } from './connection.js';
import { MAP_ICONS } from './maps.js';
import { openProfile } from './profile.js';
import { renderRules } from './rules.js';
import { canEditRules, session } from './session.js';
import * as snd from './sound.js';
import { $, MAP_NAMES, TEAM_COLORS, avatar, confirmThen, crowned, el, mapImg, mapName, onTap, openSheet } from './ui.js';

let myPresets = [];

/** Строка игрока в лобби: аватар, имя, фишки/бот, кнопки создателя. */
function lobbyRow(s, p) {
  const isOwner = session.me === s.owner;
  const bot = p.uid < 0;
  const row = el('div', 'player-row' + (bot ? '' : ' tappable'));
  const name = el('span', 'name', crowned(s, p.uid, p.name) + (p.uid === session.me ? ' (ты)' : ''));
  name.appendChild(el('span', 'sub', bot ? 'бот' : `🪙 ${s.chips?.[p.uid] ?? ''}`));
  row.append(avatar(p.uid, p.name), name);
  if (p.uid === s.owner) row.appendChild(el('span', 'tag', 'создатель'));
  if (!bot) {
    const dot = el('span', 'online-dot' + (s.online.includes(p.uid) ? ' on' : ''));
    row.appendChild(dot);
    row.onclick = () => openProfile(p.uid);
  }
  if (isOwner && p.uid !== s.owner) {
    const k = el('button', 'kick', '✕');
    k.setAttribute('aria-label', `Убрать ${p.name}`);
    k.onclick = (e) => {
      e.stopPropagation();
      confirmThen(`Убрать ${p.name} из игры?`, () => send({ type: 'kick', uid: p.uid }));
    };
    row.appendChild(k);
  }
  return row;
}

export function renderLobby(s) {
  const isOwner = session.me === s.owner;
  const editable = canEditRules(s);
  const isMember = s.members.some((p) => p.uid === session.me);
  const teams = !!s.settings.teams;
  $('lobbyCount').textContent = `${s.members.length}/${s.max_players}`;
  const box = $('lobbyPlayers');
  box.innerHTML = '';
  if (teams) {
    const of = s.team_of || {};
    const used = new Set(Object.values(of));
    const count = Math.min(4, Math.max(2, Math.ceil(s.members.length / 2), ...[...used].map((t) => t + 1)));
    for (let t = 0; t < count; t++) {
      const block = el('div', 'team-block');
      const members = s.members.filter((p) => of[p.uid] === t);
      const head = el('div', 'team-head');
      const dot = el('span', 'team-dot');
      dot.style.background = TEAM_COLORS[t];
      head.append(dot, el('span', null, `${s.team_names[t].replace(/^\S+\s/, '')} · ${members.length}/2`));
      if (isMember && of[session.me] !== t && members.length < 2) {
        const join = el('button', 'link-btn join', 'Сюда');
        join.onclick = () => send({ type: 'team', team: t });
        head.appendChild(join);
      }
      block.appendChild(head);
      for (const p of members) {
        const row = lobbyRow(s, p);
        if (isOwner && p.uid < 0) { // бота переставляет создатель
          const mv = el('button', 'kick', '⇄');
          mv.onclick = (e) => {
            e.stopPropagation();
            const next = [1, 2, 3, 4].map((d) => (t + d) % count).find((x) => s.members.filter((q) => of[q.uid] === x).length < 2);
            if (next != null) send({ type: 'team', uid: p.uid, team: next });
          };
          row.insertBefore(mv, row.lastChild);
        }
        block.appendChild(row);
      }
      for (let i = members.length; i < 2; i++) block.appendChild(el('div', 'empty-slot', 'свободно'));
      box.appendChild(block);
    }
  } else {
    for (const p of s.members) box.appendChild(lobbyRow(s, p));
  }
  $('joinBtn').classList.toggle('hidden', isMember || s.members.length >= s.max_players);
  $('addBotBtn').classList.toggle('hidden', !isOwner || s.members.length >= s.max_players);
  $('shuffleBtn').classList.toggle('hidden', !isOwner || !teams);

  // строки настроек
  $('presetName').textContent = s.preset;
  $('mapValue').textContent = mapName(s.settings.map);
  $('mapThumb').src = mapImg(s.settings.map);
  $('timerValue').textContent = s.settings.timer ? `${s.settings.timer} с` : 'выкл';
  $('stakeValue').textContent = s.settings.stake ? `${s.settings.stake} 🪙` : 'без ставок';
  $('teamsToggle').checked = teams;
  $('teamsToggle').disabled = !editable;
  document.querySelector('.settings').classList.toggle('locked', !editable);

  // лист «Правила»
  const list = $('presetList');
  list.innerHTML = '';
  const presets = myPresets.length ? myPresets : [{ id: 'classic', name: 'Классика' }, { id: 'v2', name: 'Вариант 2' }];
  for (const pr of presets) {
    const b = el('button', 'chip' + (pr.name === s.preset ? ' on' : ''), pr.name);
    b.disabled = !editable;
    b.onclick = () => send({ type: 'preset', id: pr.id });
    list.appendChild(b);
  }
  if (s.preset === 'Свои') list.appendChild(el('span', 'chip on', 'Свои'));
  for (const [seg, val] of [['segBarrel', s.rules.barrel], ['segTimer', s.settings.timer], ['segStake', s.settings.stake]]) {
    const sg = $(seg);
    sg.classList.toggle('locked', !editable);
    sg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === String(val)));
  }
  const hasBots = Object.keys(s.bots || {}).length > 0;
  if (hasBots) $('segStake').classList.add('locked');
  const sum = $('rulesSummary');
  sum.innerHTML = '';
  for (const [head, text] of s.rules_text) {
    if (head === 'Очки за бросок' || head === 'Ход') continue;
    const li = el('li');
    li.append(el('b', null, head + ': '), document.createTextNode(text));
    sum.appendChild(li);
  }
  $('editRulesBtn').textContent = editable ? '⚙️ Настроить' : '📖 Все правила';
  $('stakeNote').textContent = hasBots ? 'С ботами играем без ставок.'
    : s.settings.stake ? `Каждый вносит ${s.settings.stake} 🪙, победитель забирает банк (в командах — делят). При отмене взносы возвращаются.`
      : 'У каждого 1000 🪙 на старте, раз в сутки +100, если осталось меньше 200.';

  // лист «Карта»
  const maps = $('mapList');
  maps.innerHTML = '';
  for (const [id, title] of Object.entries(s.maps || MAP_NAMES)) {
    const b = el('button', 'map-tile' + (id === s.settings.map ? ' on' : ''));
    const img = document.createElement('img');
    img.src = mapImg(id);
    img.alt = '';
    img.loading = 'lazy';
    b.append(img, el('span', null, `${MAP_ICONS[id] || ''} ${title}`));
    b.disabled = !editable;
    b.onclick = () => {
      send({ type: 'settings', map: id });
      $('mapSheet').classList.add('hidden');
    };
    maps.appendChild(b);
  }

  // лист «Боты»
  const bots = $('botBtns');
  if (!bots.childElementCount) {
    const desc = { careful: 'осторожный, бережёт очки', balanced: 'играет по математике', risky: 'рискует до последнего' };
    for (const [style, title] of Object.entries(s.bot_styles || {})) {
      const b = el('button', 'row');
      b.append(el('span', 'row-icon', '🤖'), el('span', 'row-label', title.replace('🤖 ', '')), el('span', 'row-value', desc[style] || ''));
      b.onclick = () => {
        send({ type: 'add_bot', style });
        $('botSheet').classList.add('hidden');
      };
      bots.appendChild(b);
    }
  }

  const owner = s.members.find((p) => p.uid === s.owner);
  $('ownerNote').textContent = isOwner
    ? (teams ? 'Команды по двое: в каждой ровно два игрока, команд от двух.' : '')
    : `Правила выбирает и игру запускает ${owner?.name || 'создатель'}.`;
  $('startBtn').classList.toggle('hidden', !isOwner);
  $('startBtn').textContent = s.members.length < 2 ? 'Начать одному' : `Начать игру · ${s.members.length}`;
  $('leaveLobbyBtn').classList.toggle('hidden', !isMember);
  $('leaveLobbyBtn').classList.toggle('grow', !isOwner);
}

export function updatePresets(list) {
  myPresets = list;
  if (session.state?.status === 'lobby') renderLobby(session.state);
}

export function bindLobbyControls() {
  onTap('startBtn', () => send({ type: 'start' }));
  onTap('joinBtn', () => send({ type: 'join' }));
  onTap('leaveLobbyBtn', () => confirmThen('Выйти из лобби?', () => send({ type: 'leave' })));
  const lobbyEditable = () => session.state && canEditRules(session.state);
  onTap('rowRules', () => {
    if (lobbyEditable()) openSheet('rulesSheet');
    else {
      renderRules();
      openSheet('rulesModal');
    }
  });
  onTap('rowMap', () => openSheet('mapSheet'));
  onTap('rowTimer', () => lobbyEditable() && openSheet('timerSheet'));
  onTap('rowStake', () => lobbyEditable() && openSheet('stakeSheet'));
  $('teamsToggle').addEventListener('change', (e) => {
    snd.haptic.select();
    send({ type: 'settings', teams: e.target.checked });
  });
  onTap('shuffleBtn', () => send({ type: 'shuffle_teams' }));
  onTap('addBotBtn', () => openSheet('botSheet'));
  for (const [seg, key] of [['segBarrel', 'barrel'], ['segTimer', 'timer'], ['segStake', 'stake']]) {
    $(seg).querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      snd.haptic.select();
      send({ type: 'settings', [key]: key === 'barrel' ? b.dataset.v : Number(b.dataset.v) });
      if (key !== 'barrel') $(seg).closest('.modal').classList.add('hidden');
    }));
  }
}
