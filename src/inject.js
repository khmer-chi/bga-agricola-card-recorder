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

  // Full card objects (with desc, costs, ...) so the board overlay can render cards that
  // BGA no longer has cached after a reload. `description` is derived HTML; tplPlayerCard
  // rebuilds it from `desc`.
  const fullCards = (val) => {
    const out = [];
    const walk = (v, depth) => {
      if (!v || typeof v !== 'object' || depth > 5) return;
      if (typeof v.id === 'string' && CARD_ID.test(v.id)) {
        if (v.desc) {
          const c = JSON.parse(JSON.stringify(v));
          delete c.description;
          out.push(c);
        }
        return;
      }
      for (const x of Array.isArray(v) ? v : Object.values(v)) walk(x, depth + 1);
    };
    walk(val, 0);
    return out;
  };
  const postCardData = (val) => {
    const cards = fullCards(val);
    if (cards.length) post('cardData', { cards });
  };

  const hook = (g) => {
    const q = g.notifqueue;
    const orig = q.dispatchNotification;
    q.dispatchNotification = function (notif) {
      try {
        if (notif && TRACKED.has(notif.type)) {
          window.__agrRecLog.push(notif);
          postCardData(notif.args);
          post('notif', { type: notif.type, args: slimArgs(notif.args), uid: notif.uid || null });
        }
      } catch (e) {
        console.warn('[agr-rec] notif hook error', e);
      }
      return orig.apply(this, arguments);
    };
  };

  // ---------- board overlay ----------
  // Draws the cards each opponent certainly / possibly holds next to their played cards,
  // using BGA's own card template, with a status badge in the top-right corner.

  const GHOST_STYLE = `
    .agr-ghost { position: relative; }
    .agr-ghost.agr-possible .player-card-resizable { opacity: .55; filter: saturate(.6); }
    .agr-ghost.agr-possible { outline: 2px dashed #8a7a5c; outline-offset: -2px; border-radius: 8px; }
    .agr-ghost.agr-certain { outline: 2px solid #b03a2e; outline-offset: -2px; border-radius: 8px; }
    .agr-badge { position: absolute; top: -6px; right: -6px; z-index: 5; width: 22px; height: 22px; border-radius: 50%;
      color: #fff; font: bold 14px/22px sans-serif; text-align: center; box-shadow: 0 1px 3px rgba(0,0,0,.4); pointer-events: none; }
    .agr-badge.b-certain { background: #b03a2e; }
    .agr-badge.b-possible { background: #8a7a5c; }
    .agr-ghost-tip { font-weight: bold; margin-bottom: 4px; }
  `;
  const GHOST_BADGE = { certain: '★', possible: '?' };

  let ghostSpec = {}; // pid -> [{ id, status, tip, card }]

  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const removeGhosts = (g) => {
    for (const el of document.querySelectorAll('.agr-ghost')) {
      try {
        if (g.removeTooltip) g.removeTooltip(el.id);
      } catch (e) {}
      el.remove();
    }
  };

  const renderGhosts = (g) => {
    if (!document.getElementById('agr-ghost-style')) {
      const st = document.createElement('style');
      st.id = 'agr-ghost-style';
      st.textContent = GHOST_STYLE;
      document.head.appendChild(st);
    }
    removeGhosts(g);
    for (const [pid, items] of Object.entries(ghostSpec)) {
      const wrapper = document.getElementById('cards-wrapper-' + pid);
      if (!wrapper) continue;
      for (const { id, status, tip, card } of items) {
        if (document.getElementById(id)) continue; // BGA already shows the real card
        try {
          const c = { ...card, mini: true, location: 'inPlay' };
          const tmp = document.createElement('div');
          tmp.innerHTML = g.tplPlayerCard(c).trim();
          const el = tmp.firstElementChild;
          el.id = 'agr-ghost-' + id;
          el.dataset.id = 'agr-ghost-' + id;
          el.classList.add('agr-ghost', 'agr-' + status, 'mini');
          const badge = document.createElement('div');
          badge.className = 'agr-badge b-' + status;
          badge.textContent = GHOST_BADGE[status] || '';
          el.appendChild(badge);
          wrapper.appendChild(el);
          if (g.addTooltipHtml) g.addTooltipHtml(el.id, `<div class="agr-ghost-tip">${esc(tip)}</div>` + g.tplPlayerCard({ ...card }, true));
        } catch (e) {
          console.warn('[agr-rec] ghost render failed', id, e);
        }
      }
    }
    // Player boards have a JS-computed fixed height; recompute it so extra cards push the
    // next row down instead of overlapping it.
    try {
      if (g.updatePlayerBoardScale) g.updatePlayerBoardScale();
    } catch (e) {}
  };

  // BGA sometimes rebuilds the player boards; put the ghosts back if they disappear.
  const ghostCount = () => Object.values(ghostSpec).reduce((n, items) => n + items.length, 0);
  const keepGhosts = (g) =>
    setInterval(() => {
      if (ghostCount() && document.querySelectorAll('.agr-ghost').length === 0) renderGhosts(g);
    }, 2000);

  let tries = 0;
  const timer = setInterval(() => {
    const g = window.gameui;
    if (g && g.game_name && g.game_name !== 'agricola') return clearInterval(timer);
    if (g && g.gamedatas && g.notifqueue && g.player_id) {
      clearInterval(timer);
      hook(g);
      post('snapshot', snapshot(g));
      postCardData([g.gamedatas.playerCards, g.gamedatas.players[g.player_id] && g.gamedatas.players[g.player_id].hand, g.gamedatas.draft]);
      keepGhosts(g);
      window.addEventListener('message', (e) => {
        if (e.source !== window || !e.data || e.data.source !== SOURCE) return;
        // Let content.js ask for a fresh snapshot (e.g. after a manual resync).
        if (e.data.kind === 'requestSnapshot') post('snapshot', snapshot(g));
        if (e.data.kind === 'ghosts') {
          const next = e.data.payload.byPlayer || {};
          const unchanged = JSON.stringify(next) === JSON.stringify(ghostSpec);
          ghostSpec = next;
          if (!unchanged || document.querySelectorAll('.agr-ghost').length !== ghostCount()) renderGhosts(g);
        }
      });
      console.log('[agr-rec] hooked table', g.table_id);
    } else if (++tries > 240) {
      clearInterval(timer); // not a game page
    }
  }, 500);
})();
