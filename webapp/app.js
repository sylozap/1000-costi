import { updateAdminGames } from './admin/games.js';
import { bindAdminControls, renderAdminGame, renderAdminRooms, renderAudit, renderPlayerSheet, updateAdminDice } from './admin/panel.js';
import { confirmRoom, connect, selectRoom, send } from './connection.js';
import { showAnnounce, showReaction, showSticker } from './effects.js';
import { bindFinishControls, onAchievement, onBank, resetResults } from './finish.js';
import { bindGameControls, renderActions, renderGame, resetGameScreen } from './game-screen.js';
import { bindLobbyControls, renderLobby, updatePresets } from './lobby.js';
import { bindMenuControls } from './menu.js';
import { createPlayback } from './playback.js';
import { bindProfileControls, renderAchievements, showGameDetail, showProfile, showRecords, showSkins } from './profile.js';
import { bindRuleControls, onPresetSaved } from './rules.js';
import { session } from './session.js';
import * as snd from './sound.js';
import { initTable, mapSfx, registerCustom, table } from './table.js';
import { $, showError, showInfo, showMessage, showScreen, tg } from './ui.js';

let prevMap = null;

function setAdmin(v) {
  session.isAdmin = !!v;
  $('adminBtn').classList.toggle('hidden', !session.isAdmin);
  $('msgAdminBtn').classList.toggle('hidden', !session.isAdmin);
}

function onMessage(m) {
  switch (m.type) {
    case 'hello_ok':
      session.me = m.uid;
      confirmRoom(m.room);
      setAdmin(m.is_admin);
      break;
    case 'state':
      playback.enqueue(m.state);
      break;
    case 'no_room':
      session.me = m.uid;
      setAdmin(m.is_admin);
      showMessage('Нет активной игры', 'Напиши /newgame в группе с друзьями — бот пришлёт кнопку «Играть».');
      break;
    case 'error':
      if (m.code === 'auth') showMessage('Нужен Telegram', m.message);
      else showError(m.message);
      playback.renderCurrent();
      break;
    case 'reaction':
      showReaction(m);
      break;
    case 'sticker':
      showSticker(m);
      break;
    case 'announce':
      showAnnounce(m.text);
      break;
    case 'achievement':
      onAchievement(m);
      break;
    case 'achievements':
      renderAchievements(m.list);
      break;
    case 'presets':
      updatePresets(m.list);
      break;
    case 'preset_saved':
      onPresetSaved(m);
      break;
    case 'admin_audit':
      renderAudit(m.list);
      break;
    case 'admin_rooms':
      renderAdminRooms(m.list, openRoom);
      break;
    case 'admin_games':
      updateAdminGames(m);
      break;
    case 'admin_ok':
      showInfo(m.text);
      break;
    case 'profile':
      showSkins(m);
      break;
    case 'admin_dice':
      updateAdminDice(m);
      break;
    case 'profile_full':
      showProfile(m);
      break;
    case 'records':
      showRecords(m);
      break;
    case 'game_detail':
      showGameDetail(m);
      break;
    case 'bank':
      onBank(m);
      break;
    case 'left':
      showError('Ты вышел из игры');
      break;
    case 'kicked':
      showError('Тебя исключили из игры');
      break;
  }
}

function render(s, locked) {
  session.state = s;
  const spect = s.spectators ? ` · 👀 ${s.spectators}` : '';
  const bank = s.bank ? ` · 🏦 ${s.bank}` : '';
  $('modeChip').textContent = `${s.preset} · ${s.rules_title}` + (s.settings.timer ? ` · ⏱${s.settings.timer}с` : '') + bank + spect;
  registerCustom(s.custom_dice);
  const map = s.settings.map || 'felt';
  table.setMap(map);
  // смена карты в лобби — все слышат её фирменный звук
  if (prevMap !== null && prevMap !== map && s.status === 'lobby') mapSfx('preview');
  prevMap = map;
  snd.setSurface(map);
  if (s.status === 'cancelled') {
    showMessage('Игра отменена', 'Создай новую командой /newgame в группе.');
    return;
  }
  if (s.status === 'lobby') {
    resetResults();
    renderLobby(s);
    showScreen('screenLobby');
    return;
  }
  renderGame(s, locked);
  showScreen('screenGame');
  if (!$('adminModal').classList.contains('hidden')) renderAdminGame(s);
  if (!$('playerModal').classList.contains('hidden')) renderPlayerSheet(s);
}

const playback = createPlayback({ render, renderActions });

function openRoom(id, asSpectator) {
  playback.resetRoom();
  resetGameScreen();
  selectRoom(id, asSpectator);
}

// ---------- Telegram ----------
if (tg) {
  tg.ready();
  tg.expand();
  tg.disableVerticalSwipes?.();
}

initTable();
bindGameControls();
bindLobbyControls();
bindFinishControls();
bindMenuControls();
bindRuleControls();
bindAdminControls();
bindProfileControls();
connect(onMessage, playback.onConnect);
// список пресетов пользователя для лобби (после подключения)
setTimeout(() => send({ type: 'my_presets' }), 1200);
