// Random N-player draft simulator: drives content.js with BGA-shaped notifs as seen
// by player P0, then checks every claim in the panel against ground truth.
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(process.argv[2] || path.join(__dirname, '..', 'src', 'content.js'), 'utf8');

function runOnce({ n, dir, K, pick, T, seed, playRate = 0 }) {
  let rnd = seed; const rand = () => ((rnd = (rnd * 1103515245 + 12345) % 2147483648) / 2147483648);
  let handler; const store = {};
  const mk = () => ({ style: {}, classList: { toggle() {}, contains() { return false; } }, addEventListener() {}, querySelector: () => mk(), innerHTML: '' });
  const body = mk(); const wrap = mk(); wrap.querySelector = (s) => (s === '.body' ? body : mk());
  const window = { addEventListener: (t, h) => { if (t === 'message') handler = h; }, postMessage() {}, location: { origin: 'x' }, innerWidth: 1000, innerHeight: 800 };
  const document = { createElement: () => ({ attachShadow: () => ({ set innerHTML(v) {}, querySelector: (s) => (s === '.wrap' ? wrap : mk()), querySelectorAll: () => [] }) }), body: { appendChild() {} } };
  const chrome = { storage: { local: { get: async (k) => ({ [k]: store[k] }), set: async (o) => Object.assign(store, o) } } };
  globalThis.chrome = chrome; new Function('window', 'document', 'chrome', 'localStorage', src)(window, document, chrome, { getItem: () => null, setItem() {} });
  const msgs = [];
  const send = (kind, payload) => msgs.push({ source: window, data: { source: 'agr-rec', kind, payload } });

  const order = Array.from({ length: n }, (_, i) => 'P' + i);
  const ME = 'P0';
  let cid = 0;
  const card = (pid) => { cid++; return { id: `A${cid}_C${cid}`, name: `A${cid}_C${cid}`, type: cid % 2 ? 'occupation' : 'minor', numbering: 'A' + cid, pId: pid, location: 'draft' }; };
  let piles = order.map((p) => Array.from({ length: K }, () => card(p)));
  const holder = {};
  const actualRound = {};
  const N = (type, args) => send('notif', { type, args });
  send('snapshot', { tableId: 't', myId: ME, isSpectator: false, isReplay: false, isBeginner: false, playerOrder: order,
    players: Object.fromEntries(order.map((p) => [p, { id: p, name: p, color: '123456' }])), playerCards: [], hand: piles[0], draft: [], draftTurn: 1, draftTotal: T, draftQuota: { occupation: 1, minor: 1 } });
  for (let t = 1; t <= T; t++) {
    piles = piles.map((pile, i) => {
      const left = [...pile];
      for (const ty of ['occupation', 'minor']) {
        const pool = left.filter((c) => c.type === ty);
        if (!pool.length) continue;
        const c = pool[Math.floor(rand() * pool.length)];
        left.splice(left.indexOf(c), 1);
        holder[c.id] = order[i];
        actualRound[c.id] = t;
        if (i === 0) { N('addCardToDraftSelection', { cardId: c.id, pos: 0 }); N('confirmDraftSelection', { player_id: ME, card: { ...c, location: 'selection' } }); }
      }
      return left;
    });
    if (t === 1) N('draftWaiting', { predecessorId: order[(((0 - dir) % n) + n) % n] });
    if (t === T) break;
    // pile at seat i moves to seat i+dir
    const next = Array(n);
    piles.forEach((p, i) => { next[(((i + dir) % n) + n) % n] = p; });
    piles = next;
    N('newDraftPile', { player_id: ME, cards: piles[0].map((c) => ({ ...c, pId: ME })), turn: t + 1, type: { occupation: 1, minor: 1 } });
  }
  N('draftIsOver', {});
  // Game phase: opponents play some of their cards.
  const cardsById = {};
  for (let k = 1; k <= cid; k++) cardsById[`A${k}_C${k}`] = { id: `A${k}_C${k}`, name: `A${k}_C${k}`, type: k % 2 ? 'occupation' : 'minor', numbering: 'A' + k };
  for (const [id, h] of Object.entries(holder)) {
    if (h !== ME && rand() < playRate) N('buyCard', { player_id: h, card: { ...cardsById[id], pId: h, location: 'inPlay' } });
  }

  return (async () => {
    for (const m of msgs) handler(m);
    await new Promise((r) => setTimeout(r, 350));
    const html = body.innerHTML;
    const s = store['agr:t:' + ME];
    const r = require('./check-panel')(html, holder, s, actualRound);
    const errors = r.errors;
    const mineOk = s.mine.every((id) => holder[id] === ME) && Object.keys(holder).filter((id) => holder[id] === ME).every((id) => s.mine.includes(id));
    if (!mineOk) errors.push('mine mismatch');
    return { errors, claims: r.claims, certain: r.certain, tagged: r.playedTagged || 0 };
  })();
}

(async () => {
  const configs = [
    { n: 2, K: 14, pick: 2, T: 4 },
    { n: 2, K: 14, pick: 2, T: 7 },
    { n: 3, K: 14, pick: 2, T: 5 },
    { n: 4, K: 14, pick: 2, T: 4 },
    { n: 4, K: 14, pick: 2, T: 7 },
    { n: 4, K: 14, pick: 2, T: 7, playRate: 0.5 },
    { n: 3, K: 14, pick: 2, T: 5, playRate: 0.5 },
    { n: 2, K: 14, pick: 2, T: 4, playRate: 0.5 },
  ];
  let fails = 0;
  for (const c of configs) for (const dir of [1, -1]) {
    let claims = 0, certain = 0, tagged = 0, errs = [];
    for (let seed = 1; seed <= 10; seed++) {
      const r = await runOnce({ ...c, dir, seed });
      claims += r.claims; certain += r.certain; tagged += r.tagged; errs.push(...r.errors);
    }
    fails += errs.length;
    console.log(`n=${c.n} T=${c.T} play=${c.playRate||0} dir=${dir}: claims ${claims}, certain ${certain}, played tags ${tagged}, errors ${errs.length}${errs.length ? ' e.g. ' + errs[0] : ''}`);
  }
  console.log(fails ? 'FAIL' : 'ALL OK');
  process.exitCode = fails ? 1 : 0;
})();
