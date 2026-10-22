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
    /* zoomOnCard() clones the card as "<id>_animated": show the zoomed copy at full strength. */
    .agr-ghost[id$="_animated"] .player-card-resizable { opacity: 1; filter: none; }
    .agr-ghost.agr-possible { outline: 2px dashed #8a7a5c; outline-offset: -2px; border-radius: 8px; }
    .agr-ghost.agr-certain { outline: 2px solid #b03a2e; outline-offset: -2px; border-radius: 8px; }
    .agr-badge { position: absolute; top: -6px; right: -6px; z-index: 5; width: 22px; height: 22px; border-radius: 50%;
      color: #fff; font: bold 14px/22px sans-serif; text-align: center; box-shadow: 0 1px 3px rgba(0,0,0,.4); pointer-events: none; }
    .agr-round { position: absolute; top: -6px; left: -6px; z-index: 5; padding: 0 5px; border-radius: 8px; background: #6b4f2a;
      color: #fff; font: bold 11px/16px sans-serif; white-space: nowrap; box-shadow: 0 1px 3px rgba(0,0,0,.4); pointer-events: none; }
    .agr-played-host { position: relative; }
    .agr-round.agr-played-round { background: #2f5d8a; }
    .agr-round.agr-first-pick { background: #c9952b; color: #2b1d05; }
    .agr-ghost.agr-guessed { outline: 3px solid #7b4bb3; outline-offset: -2px; border-radius: 8px; }
    .agr-ghost.agr-by-guess { outline: 2px dashed #7b4bb3; outline-offset: -2px; border-radius: 8px; }
    .agr-ghost.agr-by-guess .agr-badge, .agr-badge.b-guessed { background: #7b4bb3; }
    .agr-guess-btn { position: absolute; bottom: 4px; right: 4px; z-index: 6; display: none; padding: 1px 7px; border-radius: 10px;
      background: #7b4bb3; color: #fff; font: bold 12px/18px sans-serif; cursor: pointer; white-space: nowrap;
      box-shadow: 0 1px 3px rgba(0,0,0,.4); }
    .agr-ghost:hover .agr-guess-btn, .agr-ghost.agr-guessed .agr-guess-btn { display: block; }
    .agr-guess-menu { position: absolute; bottom: 26px; right: 4px; z-index: 7; padding: 4px; border-radius: 8px; background: #fbf6ea;
      border: 1px solid #7b4bb3; box-shadow: 0 2px 8px rgba(0,0,0,.35); font: 12px sans-serif; color: #2b2116; }
    .agr-guess-menu div { padding: 3px 8px; border-radius: 5px; cursor: pointer; white-space: nowrap; }
    .agr-guess-menu div:hover { background: #e8dcf5; }
    .agr-guess-menu .agr-guess-menu-title { cursor: default; font-weight: bold; color: #7b4bb3; }
    .agr-guess-menu .agr-guess-menu-title:hover { background: none; }
    #agr-pool .agr-pool-cards .agr-guess-btn, #agr-pool .agr-pool-cards .agr-guess-menu { zoom: 1.667; }
    .agr-badge.b-certain { background: #b03a2e; }
    .agr-badge.b-possible { background: #8a7a5c; }
    .agr-ghost-tip { font-weight: bold; margin-bottom: 4px; }
    #agr-pool { clear: both; margin: 8px 6px 12px; padding: 8px 10px 10px; border: 2px dashed #8a7a5c; border-radius: 10px;
      background: rgba(251, 246, 234, .55); }
    #agr-pool .agr-pool-title { font: bold 14px sans-serif; color: #4a3720; margin-bottom: 10px; }
    #agr-pool .agr-pool-cards { display: flex; flex-wrap: wrap; gap: 14px 8px; }
    /* Shrunk: these say least about any one opponent; hovering still shows the full card. */
    #agr-pool .agr-pool-cards .player-card { zoom: .6; }
    /* ...but keep the round tag and badge readable (zoom multiplies: .6 x 1.667 = 1). */
    #agr-pool .agr-pool-cards .agr-round, #agr-pool .agr-pool-cards .agr-badge { zoom: 1.667; }
  `;
  const GHOST_BADGE = { certain: '★', possible: '?', guessed: '✎' };
  let guessLabels = { guess: '✎', unguess: '✕', pick: '' };

  const sendGuess = (id, pid) => window.postMessage({ source: SOURCE, kind: 'guess', payload: { id, pid } }, window.location.origin);

  // The ✎ button: on a player's board it guesses that player; in the shared pool it opens a
  // menu of the candidates; on a guessed card it clears the guess.
  const addGuessButton = (el, { id, status, cands }, pid) => {
    const btn = document.createElement('div');
    btn.className = 'agr-guess-btn';
    btn.textContent = status === 'guessed' ? guessLabels.unguess : guessLabels.guess;
    btn.addEventListener('click', (evt) => {
      evt.stopPropagation(); // don't zoom the card
      if (status === 'guessed') return sendGuess(id, null);
      if (pid) return sendGuess(id, pid);
      const old = el.querySelector('.agr-guess-menu');
      if (old) return old.remove();
      const menu = document.createElement('div');
      menu.className = 'agr-guess-menu';
      menu.innerHTML = `<div class="agr-guess-menu-title">${esc(guessLabels.pick)}</div>`;
      for (const c of cands || []) {
        const row = document.createElement('div');
        row.textContent = c.name;
        row.addEventListener('click', (e2) => {
          e2.stopPropagation();
          sendGuess(id, c.pid);
        });
        menu.appendChild(row);
      }
      el.appendChild(menu);
    });
    el.appendChild(btn);
  };

  let ghostSpec = {}; // pid -> [{ id, status, tip, round, card }]
  let poolSpec = []; // [{ id, status, tip, card }]: cards any opponent may hold
  let poolTitle = '';
  let playedTags = {}; // card id -> round label for real cards opponents have played

  // Tags BGA's real played cards with the draft round they were taken in. BGA may create
  // the card element after our message (slide animation), so this is re-run periodically.
  const applyPlayedTags = () => {
    for (const tag of document.querySelectorAll('.agr-played-round')) {
      const host = tag.parentElement;
      if (!host || playedTags[host.id] !== tag.textContent) tag.remove();
    }
    for (const [id, label] of Object.entries(playedTags)) {
      const el = document.getElementById(id);
      if (!el || !el.closest('[id^="cards-wrapper-"], [id^="action-cards-group-"], #hand-container')) continue;
      if (el.querySelector(':scope > .agr-played-round')) continue;
      el.classList.add('agr-played-host');
      const tag = document.createElement('div');
      tag.className = 'agr-round agr-played-round' + (label === FIRST_PICK[0] || label === FIRST_PICK[1] ? ' agr-first-pick' : '');
      tag.textContent = label;
      el.appendChild(tag);
    }
  };
  const FIRST_PICK = ['首選', '首选'];

  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const removeGhosts = (g) => {
    for (const el of document.querySelectorAll('.agr-ghost')) {
      try {
        if (g.removeTooltip) g.removeTooltip(el.id);
      } catch (e) {}
      el.remove();
    }
    const pool = document.getElementById('agr-pool');
    if (pool) pool.remove();
  };

  // Appends one inferred card, drawn with BGA's own template, to `container`.
  const addGhost = (g, container, item, pid = null) => {
    const { id, status, tip, round, card, byGuess } = item;
    if (document.getElementById(id)) return; // BGA already shows the real card
    try {
      const c = { ...card, mini: true, location: 'inPlay' };
      const tmp = document.createElement('div');
      tmp.innerHTML = g.tplPlayerCard(c).trim();
      const el = tmp.firstElementChild;
      el.id = 'agr-ghost-' + id;
      el.dataset.id = 'agr-ghost-' + id;
      el.classList.add('agr-ghost', 'agr-' + status, 'mini');
      if (byGuess) el.classList.add('agr-by-guess');
      const badge = document.createElement('div');
      badge.className = 'agr-badge b-' + status;
      badge.textContent = GHOST_BADGE[status] || '';
      el.appendChild(badge);
      if (round) {
        // The draft turn in which this player would have taken the card.
        const tag = document.createElement('div');
        tag.className = 'agr-round';
        tag.textContent = round;
        el.appendChild(tag);
      }
      if (status === 'possible' || status === 'guessed') addGuessButton(el, item, pid);
      container.appendChild(el);
      // Same hover tooltip and click-to-zoom as BGA wires up for real cards in addCard().
      const tooltip = `<div class="agr-ghost-tip">${esc(tip)}</div>` + g.tplPlayerCard({ ...card }, true);
      if (g.addCustomTooltip) g.addCustomTooltip(el.id, tooltip);
      else if (g.addTooltipHtml) g.addTooltipHtml(el.id, tooltip);
      if (g.zoomOnCard) {
        el.dataset.zoomWired = '1';
        el.style.cursor = 'zoom-in';
        el.addEventListener('click', (evt) => {
          evt.stopPropagation();
          g.zoomOnCard(el.id);
        });
      }
    } catch (e) {
      console.warn('[agr-rec] ghost render failed', id, e);
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
      for (const item of items) addGhost(g, wrapper, item, pid);
    }
    // Cards any opponent may hold: one shared block under the central action board.
    const column = document.getElementById('player-boards-left-column');
    if (column && poolSpec.length) {
      const pool = document.createElement('div');
      pool.id = 'agr-pool';
      pool.innerHTML = `<div class="agr-pool-title">? ${esc(poolTitle)}</div><div class="agr-pool-cards"></div>`;
      column.appendChild(pool);
      const cards = pool.querySelector('.agr-pool-cards');
      for (const item of poolSpec) addGhost(g, cards, item);
    }
    // Player boards have a JS-computed fixed height; recompute it so extra cards push the
    // next row down instead of overlapping it.
    try {
      if (g.updatePlayerBoardScale) g.updatePlayerBoardScale();
    } catch (e) {}
  };

  // BGA sometimes rebuilds the player boards; put the ghosts back if they disappear.
  const ghostCount = () => Object.values(ghostSpec).reduce((n, items) => n + items.length, 0) + poolSpec.length;
  const keepGhosts = (g) =>
    setInterval(() => {
      if (ghostCount() && document.querySelectorAll('.agr-ghost').length === 0) renderGhosts(g);
      applyPlayedTags();
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
          const next = { byPlayer: e.data.payload.byPlayer || {}, pool: e.data.payload.pool || [], title: e.data.payload.poolTitle || '' };
          const unchanged = JSON.stringify(next) === JSON.stringify({ byPlayer: ghostSpec, pool: poolSpec, title: poolTitle });
          ghostSpec = next.byPlayer;
          poolSpec = next.pool;
          poolTitle = next.title;
          playedTags = e.data.payload.playedTags || {};
          if (e.data.payload.guessLabels) guessLabels = e.data.payload.guessLabels;
          applyPlayedTags();
          if (!unchanged || document.querySelectorAll('.agr-ghost').length !== ghostCount()) renderGhosts(g);
        }
      });
      console.log('[agr-rec] hooked table', g.table_id);
    } else if (++tries > 240) {
      clearInterval(timer); // not a game page
    }
  }, 500);
})();
