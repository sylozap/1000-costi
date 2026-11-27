import { DiceTable, faceCanvas } from './dice3d.js';
import { session } from './session.js';
import * as snd from './sound.js';
import { $ } from './ui.js';

const customDice = {}; // скин «c_…» → { faces: [адреса граней], name, ver }

// Звуки карт: событие → звук (sound.js). Стук кубиков о поверхность — в sound.js по id карты.
const MAP_SFX = {
  felt: { preview: 'commit' },
  octagon: { preview: 'gong', start: 'gong', turn: 'gong', big: 'crowd', bolt: 'boo', wall: 'rattle', samosval: 'crowd', win: 'crowd' },
  ring: { preview: 'bell', start: 'bell', turn: 'bell', big: 'crowd', bolt: 'count', wall: 'rope', samosval: 'crowd', win: 'crowd' },
  bar: { preview: 'cheers', commit: 'cheers', big: 'clink', samosval: 'glassBreak', win: 'hooray' },
  casino: { preview: 'jackpot', commit: 'chips', big: 'jackpot', wall: 'rubber', win: 'jackpot' },
  space: { preview: 'whoosh', throw: 'whoosh', commit: 'laser', zero: 'powerDown', samosval: 'powerDown', win: 'warp' },
  beach: { preview: 'seagull', zero: 'waveWash', big: 'seagull', win: 'seagull' },
  snow: { preview: 'sleigh', commit: 'sleigh', zero: 'creak', win: 'sleigh' },
  football: { preview: 'referee', start: 'referee', big: 'goalRoar', win: 'goalRoar', zero: 'missedGoal' },
  basketball: { preview: 'dribble', start: 'courtBuzzer', big: 'swish', commit: 'swish', win: 'courtBuzzer' },
  zen: { preview: 'bamboo', start: 'bamboo', big: 'gardenChime', commit: 'bamboo', win: 'gardenChime' },
  pirate: { preview: 'shipBell', start: 'shipBell', big: 'pirateCoins', zero: 'shipCreak', wall: 'shipCreak', win: 'pirateCoins' },
};
const mapId = () => session.state?.settings?.map || 'felt';
export const isFightMap = () => mapId() === 'octagon' || mapId() === 'ring';
/** Звук карты для события; true — у карты есть свой звук. */
export function mapSfx(kind) {
  const name = MAP_SFX[mapId()]?.[kind];
  if (name) snd.play(name);
  return !!name;
}

export let table;

export function initTable() {
  table = new DiceTable($('table3d'), {
    onThrow: () => {
      snd.shake();
      mapSfx('throw');
    },
    onWall: (i) => {
      if (i < 2) mapSfx('wall');
    },
    onImpact: (strength, i) => {
      if (strength > 0.3 || i % 2 === 0) snd.knock(strength);
      if (strength === 1 && i === 0) snd.haptic.impact('light');
    },
  });
}

/** Запомнить описания кубиков и заранее загрузить их текстуры для стола. */
export function registerCustom(map) {
  for (const v of Object.values(map || {})) {
    customDice[v.skin] = v;
    table.defineCustomSkin(v);
  }
}

const swatches = {};
export function swatch(id) {
  if (id?.startsWith('c_')) return customDice[id]?.faces[0] || '';
  if (!swatches[id]) swatches[id] = faceCanvas(5, id).toDataURL();
  return swatches[id];
}
