import { MAP_ICONS } from './maps.js';
import { session } from './session.js';
import * as snd from './sound.js';

export const tg = window.Telegram?.WebApp;
export const $ = (id) => document.getElementById(id);

const MINI_PIPS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };

export function nameOf(s, uid) {
  return s.game?.players.find((p) => p.uid === uid)?.name || s.members.find((p) => p.uid === uid)?.name || '';
}

export function chipEl(uid) {
  return document.querySelector(`.pchip[data-uid="${uid}"]`);
}

export function showScreen(id) {
  for (const sid of ['screenMsg', 'screenLobby', 'screenGame']) $(sid).classList.toggle('hidden', sid !== id);
  $('app').classList.toggle('playing', id === 'screenGame');
}

export function openSheet(id) {
  $(id).classList.remove('hidden');
  $(id).querySelector('.modal-card').scrollTop = 0;
}

export function showMessage(title, text) {
  $('msgTitle').textContent = title;
  $('msgText').textContent = text;
  showScreen('screenMsg');
}

let errTimer = null;
export function showError(text, cls = '') {
  const el = $('errorToast');
  el.textContent = text;
  el.className = 'error-toast ' + cls;
  clearTimeout(errTimer);
  errTimer = setTimeout(() => el.classList.add('hidden'), 2600);
}
export const showInfo = (text) => showError(text, 'info');

export function avatar(uid, name) {
  const el = document.createElement('div');
  el.className = 'avatar';
  el.style.background = `hsl(${(uid * 47) % 360} 65% 62%)`;
  el.textContent = ([...(name || '?').trim()][0] || '?').toUpperCase();
  return el;
}

export function crowned(s, uid, name) {
  return (s.cosmetics?.badge?.includes(uid) ? '👑 ' : '') + name;
}

export function miniDie(v) {
  const d = document.createElement('div');
  d.className = 'mini-die' + (v === 1 ? ' one' : '');
  for (let i = 0; i < 9; i++) {
    const p = document.createElement('i');
    if (MINI_PIPS[v].includes(i)) p.className = 'on';
    d.appendChild(p);
  }
  return d;
}

export const isBarrelMode = (r) => r.barrel === 'points' || r.barrel === 'knock';

export const TEAM_COLORS = ['#e5484d', '#3e7bfa', '#2fb67c', '#e8b10e'];
export const MAP_NAMES = { felt: 'Сукно', octagon: 'Октагон MMA', ring: 'Ринг', bar: 'Барная стойка', casino: 'Казино', space: 'Космос', beach: 'Пляж', snow: 'Снег', football: 'Футбольный стадион', basketball: 'Баскетбольная площадка', zen: 'Японский сад', pirate: 'Пиратская палуба' };
export const mapName = (id) => `${MAP_ICONS[id || 'felt'] || ''} ${session.state?.maps?.[id] || MAP_NAMES[id] || MAP_NAMES.felt}`.trim();
export const mapImg = (id) => `/static/img/maps/${id || 'felt'}.jpg`;

export function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

export function confirmThen(text, fn) {
  if (tg?.showConfirm && tg.isVersionAtLeast?.('6.2')) tg.showConfirm(text, (ok) => ok && fn());
  else if (window.confirm(text)) fn();
}

export function onTap(id, fn) {
  $(id).addEventListener('click', () => {
    snd.unlock();
    snd.haptic.impact('light');
    fn();
  });
}
