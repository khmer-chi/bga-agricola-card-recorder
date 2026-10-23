// Replays a real 4-player BGA draft (all players' private channels) through content.js,
// feeding it only what player 0 would receive, and checks the panel against ground truth.
const fs = require('fs');
const path = require('path');
const CONTENT = process.argv[2] || path.join(__dirname, '..', 'src', 'content.js');
const FIXTURE = process.argv[3] || path.join(__dirname, 'fixtures', 'replay-933562596.json');
const src = fs.readFileSync(CONTENT, 'utf8');
const D = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

let handler; const store = {};
const mk = () => ({ style: {}, classList: { toggle() {}, contains() { return false; } }, addEventListener() {}, querySelector: () => mk(), innerHTML: '' });
const body = mk(); const wrap = mk(); wrap.querySelector = (s) => (s === '.body' ? body : mk());
const window = { addEventListener: (t, h) => { if (t === 'message') handler = h; }, postMessage() {}, location: { origin: 'x' }, innerWidth: 1000, innerHeight: 800 };
const document = { createElement: () => ({ attachShadow: () => ({ set innerHTML(v) {}, querySelector: (s) => (s === '.wrap' ? wrap : mk()), querySelectorAll: () => [] }) }), body: { appendChild() {} } };
const chrome = { storage: { local: { get: async (k) => ({ [k]: store[k] }), set: async (o) => Object.assign(store, o) } } };
globalThis.chrome = chrome; new Function('window', 'document', 'chrome', 'localStorage', src)(window, document, chrome, { getItem: () => null, setItem() {} });

const order = D.order; const ME = order[D.me];
const typeOf = {};
const card = (code, extra = {}) => {
  const t = code.slice(-1); const pre = code.slice(0, -1);
  if (t === 'o' || t === 'm') typeOf[`${pre}_x`] = t === 'o' ? 'occupation' : 'minor';
  return { id: `${pre}_x`, name: pre, numbering: pre, type: t === 'o' ? 'occupation' : t === 'm' ? 'minor' : 'major', ...extra };
};
const msgs = []; const send = (kind, payload) => msgs.push({ source: window, data: { source: 'agr-rec', kind, payload } });
send('snapshot', { tableId: 'r', myId: ME, isSpectator: false, isReplay: false, isBeginner: false, playerOrder: order,
  players: Object.fromEntries(order.map((p) => [p, { id: p, name: p, color: '123456' }])), playerCards: [],
  hand: D.hand.map((h) => card(h.split('@')[0], { pId: ME, location: 'draft' })), draft: [], draftTurn: 1, draftTotal: D.total, draftQuota: D.quota });

const holder = {}; const everSeen = new Set(); let pendingMine = 0; const timing = [];
const actualRound = {}; const confirms = {};
for (const [ch, type, ...a] of D.ev) {
  if (type === 'C') {
    holder[card(a[0]).id] = order[ch];
    confirms[ch] = (confirms[ch] || 0) + 1;
    actualRound[card(a[0]).id] = Math.ceil(confirms[ch] / 2);
  }
  if (type === 'P') a[1].split(',').forEach((c) => everSeen.add(card(c).id));
  if (ch === D.me) {
    if (type === 'A') pendingMine++;
    if (type === 'C') pendingMine--;
    if (type === 'P') timing.push(`t${a[0]}:pending=${pendingMine}`);
  }
  if (ch !== D.me && ch !== -1) continue; // only what I would receive live
  const N = (t, args) => send('notif', { type: t, args });
  switch (type) {
    case 'A': N('addCardToDraftSelection', { cardId: card(a[0] + 'o').id, pos: 0 }); break;
    case 'R': N('removeCardFromDraftSelection', { cardId: card(a[0] + 'o').id, pos: 0 }); break;
    case 'C': N('confirmDraftSelection', { player_id: ME, card: card(a[0], { location: 'selection', pId: ME }) }); break;
    case 'W': N('draftWaiting', { predecessorId: order[a[0]] }); break;
    case 'P': N('newDraftPile', { player_id: ME, turn: a[0], type: D.quota, cards: a[1].split(',').map((c) => card(c, { pId: ME, location: 'draft' })) }); break;
    case 'O':
      N('draftIsOver', {});
      // GUESS="A5m:2,E64m:1" -> guess card A5 is order[2]'s, E64 is order[1]'s
      for (const g of (process.env.GUESS || '').split(',').filter(Boolean)) {
        const [code, idx] = g.split(':');
        send('guess', { id: card(code).id, pid: order[Number(idx)] });
      }
      break;
    case 'B': if (!a[1].startsWith('Major')) N('buyCard', { player_id: order[a[0]], card: card(a[1], { pId: order[a[0]], location: 'inPlay' }) }); break;
    case 'X': N('buyAndPassCard', { player_id: order[a[0]], player_id2: order[a[2]], card: card(a[1], { pId: order[a[0]], location: 'hand' }) }); break;
  }
}
console.log('my pile arrivals vs unconfirmed picks:', timing.join(' '));
// Travelling-card scenario: a card I saw is played by its drafter, passed on, and played again by the receiver.
if (process.env.TRAVEL) {
  const [code, by] = process.env.TRAVEL.split(':'); // e.g. C51m:0 -> card C51 held by order[0]
  const drafter = order[Number(by)], next = order[(Number(by) + 1) % order.length];
  send('notif', { type: 'buyAndPassCard', args: { player_id: drafter, player_id2: next, card: card(code, { pId: next, location: 'hand' }) } });
  send('notif', { type: 'buyCard', args: { player_id: next, card: card(code, { pId: next, location: 'inPlay' }) } });
  console.log(`travel: ${code} drafted by ${drafter}, passed to and replayed by ${next}`);
}

(async () => {
  for (const m of msgs) handler(m);
  await new Promise((r) => setTimeout(r, 400));
  const html = body.innerHTML;
  const s = store['agr:r:' + ME];
  const r = require('./check-panel')(html, holder, s, null, { skipByGuess: !!process.env.WRONG });
  const errors = r.errors;
  // Round check: the tooltip must give the true holder's actual draft round.
  let roundChecks = 0;
  const chipRe = /data-id="([^"]+)" data-status="(certain|possible)"(?: data-cands="[^"]*")? title="([^"]*)"/g;
  for (const m of html.matchAll(chipRe)) {
    const [, id, status, title] = m; const h = holder[id];
    if (!h) continue;
    const passTurn = actualRound[id] - require('./tag-checks').kOf(s, h);
    const want = status === 'certain' ? `（我第${passTurn}輪傳出）` : `我第${passTurn}輪傳出`;
    roundChecks++;
    if (!title.includes(want)) errors.push(`round: ${id} ${status} holder ${h} actual round ${actualRound[id]} but tip "${title.replace(/\n/g, ' ')}"`);
  }
  console.log('round checks', roundChecks);
  // "K選1" check: per (player, round, type) group from the tooltips.
  const groups = {};
  for (const m of html.matchAll(/data-id="([^"]+)" data-status="possible"(?: data-cands="[^"]*")? title="([^"]*)"/g)) {
    const [, id, title] = m;
    const T = Number((title.match(/我第(\d+)輪傳出/) || [])[1]);
    const body = title.split('可能：')[1] || '';
    for (const c of body.matchAll(/(\d{4})(?:（(\d+)選1）)?/g)) {
      const round = T + require('./tag-checks').kOf(s, c[1]);
      const key = `${c[1]}|${round}|${typeOf[id]}`;
      (groups[key] = groups[key] || { k: Number(c[2] || 1), ids: new Set() }).ids.add(id);
    }
  }
  let groupChecks = 0;
  for (const [key, g] of Object.entries(groups)) {
    const [pid, round, type] = key.split('|');
    groupChecks++;
    if (g.k !== g.ids.size) errors.push(`K mismatch ${key}: label ${g.k} vs ${g.ids.size} cards`);
    const held = [...g.ids].filter((id) => holder[id] === pid);
    if (held.length > 1) errors.push(`${key}: player holds ${held.length} of the group`);
    const pick = Object.keys(holder).find((id) => holder[id] === pid && actualRound[id] === Number(round) && typeOf[id] === type);
    if (pick && !s.played[pick] && !g.ids.has(pick)) errors.push(`${key}: actual pick ${pick} missing from group`);
  }
  console.log('choice groups checked', groupChecks);
  // Played-card round tags vs the round each opponent actually drafted the card.
  const playedStats = { none: 0 };
  for (const m of html.matchAll(/data-id="([^"]+)" data-status="played"(?: data-cands="[^"]*")?(?: data-round="([^"]*)")? title/g)) {
    const [, id, label] = m;
    const by = s.played[id];
    if (by === ME) playedStats.mine = (playedStats.mine || 0) + 1;
    const truth = actualRound[id];
    if (!label) { playedStats.none++; continue; }
    const ok = require('./tag-checks').playedOk(s, label, by, truth, s.seen.includes(id));
    const kind = label === '首選' ? 'first' : /傳出/.test(label) ? 'passed' : /選$/.test(label) ? 'minePick' : 'unseen';
    playedStats[kind] = (playedStats[kind] || 0) + 1;
    if (!ok) errors.push(`played ${id} by ${by}: label ${label} but drafted in round ${truth}`);
  }
  console.log('played tags', JSON.stringify(playedStats));
  const truthMine = Object.keys(holder).filter((id) => holder[id] === ME).sort();
  if (JSON.stringify([...s.mine].sort()) !== JSON.stringify(truthMine)) errors.push('mine mismatch: ' + s.mine.length + ' vs ' + truthMine.length);
  if (process.env.GUESS) {
    const byGuess = (html.match(/class="card [^"]*by-guess/g) || []).length;
    const guessedChips = (html.match(/data-status="guessed"/g) || []).length;
    console.log('guesses left', JSON.stringify(s.guesses), '| guessed chips', guessedChips, '| by-guess chips', byGuess);
  }
  console.log('direction', s.direction, 'known', s.directionKnown, '| seen', s.seen.length, '| mine', s.mine.length, '| played tracked', Object.keys(s.played).length);
  console.log('claims', r.claims, '| certain', r.certain, '| possible (per player)', r.possible, '| discarded', r.discarded);
  console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'ALL CLAIMS CORRECT');
  process.exitCode = errors.length ? 1 : 0;
  console.log('---- panel ----');
  console.log(html.replace(/<h4>/g, '\n## ').replace(/<h5>/g, '\n  - ').replace(/<span class="card[^"]*"[^>]*>([^<]*)<small>[^<]*<\/small>(?:<i class="badge[^"]*">([^<]*)<\/i>)?<\/span>/g, '$1$2 ').replace(/<[^>]+>/g, '').replace(/\n\s*\n/g, '\n').trim());
})();
