import { processEvents, showRollBadge } from './effects.js';
import { session } from './session.js';
import { table } from './table.js';

export function createPlayback({ render, renderActions }) {
  let queue = [];
  let busy = false;
  let animating = false;
  let lastRollId = null;
  let seen = new Set();
  let fresh = true; // следующее состояние — первое после подключения: без анимаций и звуков

  function skinFor(s, roll) {
    return s.cosmetics?.skins?.[roll.uid] || (s.cosmetics?.gold?.includes(roll.uid) ? 'gold' : 'ivory');
  }

  async function pump() {
    busy = true;
    while (queue.length) {
      const s = queue.shift();
      const g = s.game;
      const roll = g?.last_roll || null;
      if (!g) {
        seen = new Set();
        lastRollId = null;
      }
      if (fresh) {
        fresh = false;
        g?.log.forEach((e) => seen.add(e.id));
        if (roll) {
          lastRollId = roll.id;
          table.setSkin(skinFor(s, roll));
          table.showStatic(roll.dice, roll.scoring, roll.seed, roll);
        }
        render(s, locked());
        continue;
      }
      if (roll && roll.id !== lastRollId) {
        lastRollId = roll.id;
        table.setSkin(skinFor(s, roll));
        const newerRoll = queue.some((q) => q.game?.last_roll && q.game.last_roll.id !== roll.id);
        if (newerRoll) {
          table.showStatic(roll.dice, roll.scoring, roll.seed, roll);
        } else {
          animating = true;
          if (session.state) renderActions(session.state, locked());
          await table.throwDice(roll);
          animating = false;
          showRollBadge(roll, s);
        }
      }
      render(s, locked());
      await processEvents(s, seen);
    }
    busy = false;
  }

  function locked() {
    return animating || queue.length > 0;
  }

  function enqueue(s) {
    session.clockOffset = s.server_now - Date.now();
    queue.push(s);
    if (!busy) pump();
  }

  function onConnect() {
    fresh = true;
  }

  function resetRoom() {
    queue = [];
    fresh = true;
    seen = new Set();
    lastRollId = null;
  }

  function renderCurrent() {
    if (session.state) render(session.state, locked());
  }

  return { enqueue, onConnect, resetRoom, renderCurrent };
}
