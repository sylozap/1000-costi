import { send } from './connection.js';
import { clearToasts, toast } from './effects.js';
import { openProfile } from './profile.js';
import { session } from './session.js';
import * as snd from './sound.js';
import { $, TEAM_COLORS, avatar, crowned, el, onTap } from './ui.js';
import { renderMatchReview } from './views.js';

let finishAch = [];
let finishBank = null;

export function onAchievement(m) {
  const mine = m.uid === session.me;
  toast(m.emoji, `${mine ? 'Ты получил(а)' : m.name + ':'} «${m.title}»`, 2400, 'toast-ach');
  snd.play('hot');
  if (mine) snd.haptic.notify('success');
  finishAch.push(m);
}

export function showFinish(s) {
  clearToasts();
  const g = s.game;
  const winners = g.winners?.length ? g.winners : [g.winner_uid];
  const iWon = winners.includes(session.me);
  const wnames = g.players.filter((p) => winners.includes(p.uid)).map((p) => p.name).join(' и ');
  $('finishTitle').textContent = g.winner_uid == null ? 'Игра окончена' : iWon ? 'Ты победил(а)! 🏆' : `Победа: ${wnames}`;
  const box = $('ranking');
  box.innerHTML = '';
  if (g.teams) {
    const teams = {};
    for (const p of g.players) (teams[p.team] ||= []).push(p);
    const ranked = Object.entries(teams).sort(([, a], [, b]) => winners.includes(b[0].uid) - winners.includes(a[0].uid) || b[0].score - a[0].score);
    ranked.forEach(([t, ms], i) => {
      const row = el('div', 'row' + (winners.includes(ms[0].uid) ? ' win' : ''));
      const dot = el('span', 'team-dot');
      dot.style.background = TEAM_COLORS[t];
      row.append(el('span', 'place', winners.includes(ms[0].uid) ? '🏆' : String(i + 1)), dot,
        el('span', 'row-label', ms.map((p) => p.name).join(' и ')), el('span', 'score', String(ms[0].score)));
      box.appendChild(row);
    });
  } else {
    const ranked = [...g.players].sort((a, b) => winners.includes(b.uid) - winners.includes(a.uid) || b.score - a.score);
    ranked.forEach((p, i) => {
      const row = el(p.uid >= 0 ? 'button' : 'div', 'row' + (winners.includes(p.uid) ? ' win' : ''));
      row.append(el('span', 'place', winners.includes(p.uid) ? '🏆' : String(i + 1)), avatar(p.uid, p.name),
        el('span', 'row-label', crowned(s, p.uid, p.name)), el('span', 'score', String(p.score)));
      if (p.uid >= 0) row.onclick = () => openProfile(p.uid);
      box.appendChild(row);
    });
  }
  const bankEl = $('finishBank');
  bankEl.classList.toggle('hidden', !finishBank);
  if (finishBank) bankEl.textContent = `💰 ${finishBank.name}: банк ${finishBank.amount} 🪙`;
  renderSummary(s);
  const ach = $('finishAch');
  ach.innerHTML = '';
  for (const a of finishAch) ach.appendChild(el('div', null, `${a.emoji} ${a.name}: «${a.title}»`));
  $('rematchBtn').classList.toggle('hidden', session.me !== s.owner);
  $('finishModal').classList.remove('hidden');
}

function renderSummary(s) {
  const g = s.game;
  const sum = g.summary;
  const hl = $('finishHighlights');
  hl.replaceChildren();
  for (const t of sum?.highlights || []) hl.appendChild(el('li', null, t));
  renderMatchReview($('finishReview'), {
    players: g.players.map((p) => ({ ...p, ...sum?.rows.find((row) => row.uid === p.uid) })),
    history: sum?.history, winprob: s.winprob_hist, winners: g.winners || [],
    teams: g.teams, turns: sum?.turns ?? 0, duration: s.duration, comeback: sum?.comeback,
  });
}

export function onBank(m) {
  finishBank = m;
  snd.play('chips');
  toast('💰', `${m.uid === session.me ? 'Ты забираешь' : m.name + ' забирает'} банк: ${m.amount} 🪙`, 2400);
}

export function resetResults() {
  $('finishModal').classList.add('hidden');
  finishAch = [];
  finishBank = null;
}

export function bindFinishControls() {
  onTap('rematchBtn', () => {
    $('finishModal').classList.add('hidden');
    send({ type: 'rematch' });
  });
  onTap('closeFinishBtn', () => $('finishModal').classList.add('hidden'));
}
