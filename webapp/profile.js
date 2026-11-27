import { send } from './connection.js';
import { session } from './session.js';
import * as snd from './sound.js';
import { registerCustom, swatch } from './table.js';
import { $, avatar, mapName, onTap, openSheet } from './ui.js';
import { renderGameDetail, renderProfile, renderRecords } from './views.js';

export function openProfile(uid, filters) {
  send({ type: 'profile_full', uid, filters });
}

const viewCtx = {
  get me() { return session.me; },
  avatar: (uid, name) => avatar(uid, name),
  skinSrc: (id) => swatch(id),
  mapName: (id) => mapName(id),
  openGame: (id) => send({ type: 'game_detail', id }),
  openProfile,
};

export function renderAchievements(list) {
  const box = $('achList');
  box.innerHTML = '';
  const got = list.filter((a) => a.got).length;
  $('achCount').textContent = `${got}/${list.length}`;
  for (const a of [...list].sort((x, y) => y.got - x.got)) {
    const el = document.createElement('div');
    el.className = 'ach' + (a.got ? ' got' : '');
    el.innerHTML = '<div class="ach-emoji"></div><div><b></b><small></small></div>';
    el.querySelector('.ach-emoji').textContent = a.got ? a.emoji : '🔒';
    el.querySelector('b').textContent = a.title;
    el.querySelector('small').textContent = a.desc;
    box.appendChild(el);
  }
  $('achModal').classList.remove('hidden');
}

function renderSkins(m) {
  $('chipsBalance').textContent = `Фишки: ${m.chips} 🪙`;
  const grid = $('skinGrid');
  grid.innerHTML = '';
  for (const sk of m.skins) {
    const b = document.createElement('button');
    b.className = 'skin' + (sk.id === m.skin ? ' on' : '');
    b.innerHTML = '<img alt=""><span></span>';
    b.querySelector('img').src = swatch(sk.id);
    b.querySelector('span').textContent = (sk.personal ? '✨ ' : '') + sk.name;
    b.onclick = () => {
      snd.haptic.select();
      send({ type: 'skin', id: sk.id });
    };
    grid.appendChild(b);
  }
}

export function showSkins(m) {
  registerCustom(m.custom_dice);
  renderSkins(m);
}

export function showProfile(m) {
  registerCustom(m.custom_dice);
  renderProfile($('profileBody'), m, viewCtx);
  if ($('profileModal').classList.contains('hidden')) openSheet('profileModal');
}

export function showRecords(m) {
  renderRecords($('recordsBody'), m, viewCtx);
  openSheet('recordsModal');
}

export function showGameDetail(m) {
  renderGameDetail($('gameBody'), m.game, viewCtx);
  openSheet('gameModal');
}

export function bindProfileControls() {
  onTap('achCloseBtn', () => $('achModal').classList.add('hidden'));
  onTap('skinCloseBtn', () => $('skinModal').classList.add('hidden'));
}
