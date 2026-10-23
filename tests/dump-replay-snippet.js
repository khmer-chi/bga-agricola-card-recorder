// Paste into the DevTools console of a BGA Agricola *replay* page
// (https://boardgamearena.com/archive/replay/...&player=<your id>) to export a test fixture.
// Replays contain every player's private draft channel, so the result has the full truth
// of who drafted what. Copies the JSON to the clipboard (DevTools `copy`); save it as
// tests/fixtures/<name>.json and point replay-test.js at it.
//
// Format: { order, me, total, quota, hand, ev }
//   order: last 4 digits of player ids in playerorder; me: index of the viewing player
//   hand:  the viewer's turn-1 pile, "A157o@draft" (o = occupation, m = minor, M = major)
//   ev:    [channel, type, ...args], channel = index into order (-1 = public table channel)
//     P turn cards   newDraftPile        A code  addCardToDraftSelection
//     R code         remove...Selection  C card  confirmDraftSelection
//     W pred         draftWaiting        O       draftIsOver
//     B by card -1   buyCard             X by card to   buyAndPassCard   D by card -1  buyAndDestroyCard
(() => {
  const order = gameui.gamedatas.playerorder.map(String);
  const idx = (x) => order.indexOf(String(x));
  const ty = (c) => ({ occupation: 'o', minor: 'm', major: 'M' })[c && c.type] || '?';
  const cid = (c) => c.id.split('_')[0] + ty(c);
  const ev = [];
  for (const p of g_gamelogs) {
    const m = (p.channel || '').match(/\/player\/p(\d+)/);
    const ch = m ? idx(m[1]) : -1;
    for (const d of p.data || []) {
      const a = d.args || {};
      switch (d.type) {
        case 'newDraftPile': ev.push([ch, 'P', a.turn, a.cards.map(cid).join(',')]); break;
        case 'addCardToDraftSelection': ev.push([ch, 'A', a.cardId.split('_')[0]]); break;
        case 'removeCardFromDraftSelection': ev.push([ch, 'R', a.cardId.split('_')[0]]); break;
        case 'confirmDraftSelection': ev.push([ch, 'C', cid(a.card)]); break;
        case 'draftWaiting': ev.push([ch, 'W', idx(a.predecessorId)]); break;
        case 'draftIsOver': ev.push([ch, 'O']); break;
        case 'buyCard': case 'buyAndPassCard': case 'buyAndDestroyCard':
          ev.push([ch, { buyCard: 'B', buyAndPassCard: 'X', buyAndDestroyCard: 'D' }[d.type], idx(a.player_id), cid(a.card), a.player_id2 != null ? idx(a.player_id2) : -1]);
          break;
      }
    }
  }
  const me = String(gameui.player_id);
  const hand = Object.values(gameui.gamedatas.players[me].hand).map((c) => cid(c) + '@' + c.location);
  const out = JSON.stringify({
    order: order.map((x) => x.slice(-4)),
    me: idx(me),
    total: gameui.gamedatas.draftTotalTurns,
    quota: (gameui.gamedatas.gamestate.args && gameui.gamedatas.gamestate.args.type) || null,
    hand,
    ev,
  });
  copy(out);
  console.log(`fixture copied: ${ev.length} events, ${out.length} chars (load the replay at move 1 so "hand" is the turn-1 pile)`);
})();
