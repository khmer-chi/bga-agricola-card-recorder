// Runs in the page's MAIN world. Reads BGA's `gameui`, hooks notifications,
// and forwards a minimal, serializable view to content.js via postMessage.
(() => {
  if (window.__agrRecInjected) return;
  window.__agrRecInjected = true;

  const SOURCE = 'agr-rec';
  const TRACKED = new Set([
    'newDraftPile',
    'addCardToDraftSelection',
    'removeCardFromDraftSelection',
    'confirmDraftSelection',
    'clearDraftPools',
    'draftIsOver',
    'draftWaiting', // args.predecessorId: who passes to me -> pass direction
    'draftProgress',
    'buyCard',
    'buyAndPassCard',
    'buyAndDestroyCard',
    'refreshHand',
    'livingHandOfferCreated',
    'livingHandPicked',
    'livingHandPassDecision',
  ]);
  const CARD_ID = /^[A-E]\d+_/;

  // Raw log of tracked notifs, inspectable from DevTools for debugging.
  window.__agrRecLog = [];

  const post = (kind, payload) => window.postMessage({ source: SOURCE, kind, payload }, window.location.origin);

  const tr = (s) => {
    try {
      return typeof window._ === 'function' ? window._(s) : s;
    } catch (e) {
      return s;
    }
  };

  const slimCard = (c) =>
    c && typeof c === 'object' && c.id
      ? {
          id: c.id,
          name: tr(c.name || c.id),
          type: c.type || null,
          deck: c.deck || null,
          numbering: c.numbering || null,
          pId: c.pId != null ? String(c.pId) : null,
          location: c.location || null,
        }
      : null;

  // Collect every card-like object (id like "C75_Firewood") anywhere inside a value.
  const findCards = (val, out = [], depth = 0) => {
    if (!val || typeof val !== 'object' || depth > 5) return out;
    if (typeof val.id === 'string' && CARD_ID.test(val.id)) {
      out.push(slimCard(val));
      return out;
    }
    for (const v of Array.isArray(val) ? val : Object.values(val)) findCards(v, out, depth + 1);
    return out;
  };

  const snapshot = (g) => {
    const d = g.gamedatas;
    const players = {};
    for (const p of Object.values(d.players || {})) {
      players[String(p.id)] = { id: String(p.id), name: p.name, color: p.color, no: Number(p.no) };
    }
    const me = String(g.player_id);
    return {
      tableId: String(g.table_id),
      myId: me,
      isSpectator: !!g.isSpectator,
      isReplay: /\/archive\/replay\//.test(window.location.pathname) || !!g.instantaneousMode,
      isBeginner: !!d.isBeginner,
      playerOrder: (d.playerorder || []).map(String),
      players,
      playerCards: (d.playerCards || []).map(slimCard).filter((c) => c && CARD_ID.test(c.id)),
      hand: findCards(d.players && d.players[me] && d.players[me].hand),
      draft: findCards(d.draft),
      draftTurn: d.draftPlayerTurns && d.draftPlayerTurns[me] != null ? Number(d.draftPlayerTurns[me]) : null,
      draftTotal: d.draftTotalTurns != null ? Number(d.draftTotalTurns) : null,
      // e.g. { occupation: 1, minor: 1 }: how many of each type a player takes per draft turn
      draftQuota: (d.gamestate && d.gamestate.args && d.gamestate.args.type) || null,
    };
  };

  const slimArgs = (args) => {
    const out = {};
    for (const [k, v] of Object.entries(args || {})) {
      if (k === 'card') out.card = slimCard(v);
      else if (k === 'cards' || k === 'hand') out[k] = findCards(v);
      else if (k === 'type' && v && typeof v === 'object') out.type = { ...v }; // newDraftPile pick quota
      else if (v == null || ['string', 'number', 'boolean'].includes(typeof v)) out[k] = v;
    }
    if (out.player_id != null) out.player_id = String(out.player_id);
    return out;
  };

  const hook = (g) => {
    const q = g.notifqueue;
    const orig = q.dispatchNotification;
    q.dispatchNotification = function (notif) {
      try {
        if (notif && TRACKED.has(notif.type)) {
          window.__agrRecLog.push(notif);
          post('notif', { type: notif.type, args: slimArgs(notif.args), uid: notif.uid || null });
        }
      } catch (e) {
        console.warn('[agr-rec] notif hook error', e);
      }
      return orig.apply(this, arguments);
    };
  };

  let tries = 0;
  const timer = setInterval(() => {
    const g = window.gameui;
    if (g && g.game_name && g.game_name !== 'agricola') return clearInterval(timer);
    if (g && g.gamedatas && g.notifqueue && g.player_id) {
      clearInterval(timer);
      hook(g);
      post('snapshot', snapshot(g));
      // Let content.js ask for a fresh snapshot (e.g. after a manual resync).
      window.addEventListener('message', (e) => {
        if (e.source === window && e.data && e.data.source === SOURCE && e.data.kind === 'requestSnapshot') {
          post('snapshot', snapshot(g));
        }
      });
      console.log('[agr-rec] hooked table', g.table_id);
    } else if (++tries > 240) {
      clearInterval(timer); // not a game page
    }
  }, 500);
})();
