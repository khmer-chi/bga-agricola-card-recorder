// Checks every claim the panel makes against ground truth.
// holder: card id -> player id who drafted it (absent = discarded).
// Returns { errors, claims, certain, possible, discarded }.
// opts.skipByGuess: ignore results derived from my guesses (for wrong-guess scenarios).
module.exports = function checkPanel(html, holder, s, actualRound, opts = {}) {
  const errors = [];
  const stats = { claims: 0, certain: 0, possible: 0, discarded: 0 };
  const chipRe = /<span class="card ([^"]*)" data-id="([^"]+)" data-status="([^"]*)"(?: data-cands="([^"]*)")?(?: data-round="[^"]*")? title="([^"]*)"/g;
  const listed = new Set();
  for (const section of html.split('<h4>').slice(1)) {
    const isDiscarded = /^已被[棄弃]/.test(section);
    for (const m of section.matchAll(chipRe)) {
      const [, cls, id, status, candsStr, title] = m;
      if (status === 'guessed') { listed.add(id); continue; }
      if (opts.skipByGuess && /\bby-guess\b/.test(cls)) { listed.add(id); continue; }
      const cands = candsStr ? candsStr.split(',') : [];
      const h = holder[id];
      if (status === 'certain' || status === 'possible' || isDiscarded) {
        listed.add(id);
        stats.claims++;
      }
      if (status === 'certain') {
        stats.certain++;
        if (cands.length !== 1 || h !== cands[0]) errors.push(`${id} certain [${cands}] but truth=${h || 'discarded'}`);
      } else if (status === 'possible') {
        stats.possible++;
        const mayBeDiscarded = /被[棄弃]/.test(title);
        if (!(h ? cands.includes(h) : mayBeDiscarded)) errors.push(`${id} possible [${cands}]${mayBeDiscarded ? '+discard' : ''} but truth=${h || 'discarded'}`);
      } else if (isDiscarded) {
        stats.discarded++;
        if (h) errors.push(`${id} shown as discarded but truth=${h}`);
      }
    }
  }
  // Every card I passed on and nobody has played must be accounted for.
  for (const id of s.seen) {
    if (s.mine.includes(id) || s.played[id]) continue;
    if (!listed.has(id)) errors.push('not listed: ' + id);
  }
  // Round tags on opponents' played cards, when the true draft rounds are known.
  if (actualRound) {
    stats.playedTagged = 0;
    for (const m of html.matchAll(/data-id="([^"]+)" data-status="played"(?: data-cands="[^"]*")?(?: data-round="([^"]*)")? title/g)) {
      const [, id, label] = m;
      if (!label) continue;
      stats.playedTagged++;
      const truth = actualRound[id];
      const ok = require('./tag-checks').playedOk(s, label, s.played[id], truth, s.seen.includes(id));
      if (!ok) errors.push(`played ${id}: tag ${label} but drafted in round ${truth}`);
    }
  }
  return { errors, ...stats };
};
