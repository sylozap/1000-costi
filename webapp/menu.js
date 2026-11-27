import { send } from './connection.js';
import { openProfile } from './profile.js';
import { renderRules } from './rules.js';
import { session } from './session.js';
import * as snd from './sound.js';
import { $, onTap, openSheet } from './ui.js';

export function bindMenuControls() {
  // меню ☰
  onTap('menuBtn', () => {
    syncThemeBtn();
    openSheet('menuModal');
  });
  document.querySelectorAll('#menuModal [data-menu]').forEach((b) => b.addEventListener('click', () => {
    snd.haptic.select();
    const what = b.dataset.menu;
    if (what === 'theme') {
      window.appTheme?.toggle();
      return;
    }
    $('menuModal').classList.add('hidden');
    if (what === 'profile') openProfile(session.me);
    else if (what === 'skins') {
      openSheet('skinModal');
      send({ type: 'my_profile' });
    } else if (what === 'ach') send({ type: 'my_achievements' });
    else if (what === 'records') send({ type: 'records' });
    else if (what === 'rules') {
      renderRules();
      openSheet('rulesModal');
    }
  }));

  // лист закрывается касанием по затемнённому фону
  document.querySelectorAll('.modal').forEach((m) => m.addEventListener('click', (e) => {
    if (e.target === m && m.id !== 'editModal') m.classList.add('hidden');
  }));
  function syncSoundBtn() { $('soundBtn').textContent = snd.isEnabled() ? '🔊' : '🔇'; }
  onTap('soundBtn', () => snd.setEnabled(!snd.isEnabled()));
  snd.onChange(syncSoundBtn);
  syncSoundBtn();
  function syncThemeBtn() { $('themeValue').textContent = window.appTheme?.get() === 'light' ? 'светлая' : 'тёмная'; }
  document.addEventListener('themechange', syncThemeBtn);
  syncThemeBtn();
}
