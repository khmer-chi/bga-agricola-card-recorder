// Runs in the extension's isolated world. Receives events from inject.js,
// keeps the card-tracking state per table, persists it, and renders the panel.
(() => {
  if (window.__agrRecContent) return;
  window.__agrRecContent = true;

  const SOURCE = 'agr-rec';
  // Firefox exposes promise-based APIs as `browser`; Chrome as `chrome`.
  const ext = globalThis.browser || globalThis.chrome;
  const TYPE_LABEL = { occupation: '職業卡', minor: '次要發展卡', major: '主要發展卡' };

  let state = null;
  let storageKey = null;
  let panel = null;
  let queue = Promise.resolve();

  const emptyState = () => ({
    version: 2,
    tableId: null,
    myId: null,
    isSpectator: false,
    isReplay: false,
    isBeginner: false,
    players: {},
    playerOrder: [],
    cards: {}, // id -> slim card (catalog of everything we've seen)
    seen: [], // ids seen in my draft piles
    mine: [], // ids that were ever in my hand
    pending: [], // ids selected in the current draft pile but not confirmed
    currentPile: [], // ids of the draft pile currently in front of me
    currentTurn: null, // draft turn of the pile in front of me
    trackedFrom: null, // first draft turn we recorded; > 1 means we missed piles (installed mid-draft)
    draftTotal: null, // total draft turns
    direction: 1, // +1: I pass to the next player in playerOrder, -1: to the previous one
    directionKnown: false, // set once draftWaiting tells us who passes to me
    passedPiles: [], // { ids, turn } piles I passed on and haven't seen come back yet
    passInfo: {}, // id -> { turn, returned } for the last time I passed it; returned = its pile came back without it
    returnedGroups: [], // { turn, ids }: cards missing from a pile when it came back, taken one-per-type by each successor
    pickQuota: null, // { occupation: 1, minor: 1 }: cards of each type a player takes per draft turn
    played: {}, // id -> player id who played it
    cardData: {}, // id -> full BGA card object, so the board overlay can render it after a reload
    myPicks: {}, // id -> draft round in which I took it
    guesses: {}, // id -> player id I *guess* took it; used as a hypothesis, never as fact
    draftOver: false,
    updatedAt: 0,
  });

  // ---------- helpers ----------

  const addUnique = (arr, id) => {
    if (!arr.includes(id)) arr.push(id);
  };
  const remove = (arr, id) => {
    const i = arr.indexOf(id);
    if (i >= 0) arr.splice(i, 1);
  };
  const remember = (card) => {
    if (!card || !card.id) return;
    const prev = state.cards[card.id] || {};
    state.cards[card.id] = { ...prev, ...Object.fromEntries(Object.entries(card).filter(([, v]) => v != null)) };
  };
  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  // ---------- persistence ----------

  const load = async (key) => {
    try {
      const res = await ext.storage.local.get(key);
      return res[key] || null;
    } catch (e) {
      console.warn('[agr-rec] load failed', e);
      return null;
    }
  };

  let saveTimer = null;
  const flush = () => {
    clearTimeout(saveTimer);
    saveTimer = null;
    state.updatedAt = Date.now();
    ext.storage.local.set({ [storageKey]: state }).catch((e) => console.warn('[agr-rec] save failed', e));
  };
  const save = () => {
    if (!storageKey) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 300);
  };
  // Don't lose the last debounced write when the page is reloaded or closed.
  window.addEventListener('pagehide', () => {
    if (saveTimer) flush();
  });

  // ---------- state transitions ----------

  // The pile in front of me is being replaced: whatever I didn't take was passed on.
  const finalizePile = () => {
    const passed = state.currentPile.filter((id) => !state.mine.includes(id) && !state.pending.includes(id));
    for (const id of passed) state.passInfo[id] = { turn: state.currentTurn, returned: false };
    if (passed.length) state.passedPiles.push({ ids: passed, turn: state.currentTurn });
    for (const id of state.pending) {
      addUnique(state.mine, id);
      if (state.myPicks[id] == null && state.currentTurn != null) state.myPicks[id] = state.currentTurn;
    }
    state.pending = [];
    state.currentPile = [];
  };

  const receivePile = (cards, turn) => {
    const ids = cards.map((c) => c.id);
    if (ids.length && ids.every((id) => state.currentPile.includes(id)) && ids.length === state.currentPile.length) return;
    finalizePile();
    if (turn != null) state.currentTurn = Number(turn);
    if (state.trackedFrom == null && state.currentTurn != null) state.trackedFrom = state.currentTurn;
    for (const c of cards) {
      remember(c);
      addUnique(state.seen, c.id);
    }
    // A pile I passed earlier came back: whatever is missing was picked by the players it went through.
    state.passedPiles = state.passedPiles.filter((p) => {
      if (!p.ids.some((id) => ids.includes(id))) return true;
      const missing = p.ids.filter((id) => !ids.includes(id));
      for (const id of missing) state.passInfo[id] = { turn: p.turn, returned: true };
      if (missing.length) state.returnedGroups.push({ turn: p.turn, ids: missing });
      return false;
    });
    state.currentPile = ids;
  };

  // Players a pile reaches after I pass it: successors[0] is the one I pass to.
  const successors = () => {
    const order = state.playerOrder.length ? state.playerOrder : Object.keys(state.players);
    const n = order.length;
    const i = order.indexOf(state.myId);
    if (i < 0 || n < 2) return [];
    return Array.from({ length: n - 1 }, (_, j) => order[(((i + state.direction * (j + 1)) % n) + n) % n]);
  };

  // The pile a card I passed on was in, as far as the exclusion rule is concerned.
  const groupOf = (id) => state.returnedGroups.find((g) => g.ids.includes(id)) || state.passedPiles.find((p) => p.ids.includes(id));
  const typeOf = (id) => state.cards[id] && state.cards[id].type;

  // Who could hold a card I passed on: the players the pile can reach before it
  // returns to me or the draft ends. With `useGuesses`, my guesses count like plays:
  // a guessed card is with the guessed player, who is ruled out for its pile-mates.
  const candidatesFor = (id, useGuesses = true) => {
    const info = state.passInfo[id];
    const succ = successors();
    if (!info) return succ;
    let hops = succ.length;
    if (!info.returned && state.draftTotal != null && info.turn != null) hops = Math.min(hops, state.draftTotal - info.turn);
    let cands = succ.slice(0, Math.max(0, hops));

    // Each player takes exactly one card of a type from a pile per turn (when the quota is 1).
    // So if someone played another same-type card from the same pile, they can't hold this one.
    const type = typeOf(id);
    if (state.pickQuota && state.pickQuota[type] === 1) {
      const group = groupOf(id);
      if (group) {
        const holderOf = (o) => state.played[o] || (useGuesses && state.guesses[o]);
        const excluded = group.ids.filter((o) => o !== id && holderOf(o) && typeOf(o) === type).map(holderOf);
        cands = cands.filter((pid) => !excluded.includes(pid));
      }
    }
    const guess = useGuesses && state.guesses[id];
    if (guess && cands.includes(guess)) return [guess];
    return cands;
  };

  // Drop guesses that facts have since contradicted; returns a note for each one dropped.
  const pruneGuesses = () => {
    const notes = [];
    for (const [id, pid] of Object.entries(state.guesses)) {
      const name = (state.players[pid] || { name: pid }).name;
      const card = (state.cards[id] && state.cards[id].name) || id;
      if (state.played[id]) {
        if (state.played[id] !== pid) {
          const by = (state.players[state.played[id]] || { name: state.played[id] }).name;
          notes.push(conv(`猜錯了：你猜 ${name} 有「${card}」，但 ${by} 打出了它`));
        }
        delete state.guesses[id];
      } else if (state.mine.includes(id) || !candidatesFor(id, false).includes(pid)) {
        notes.push(conv(`「${card}」不可能在 ${name} 手上了，已取消這個猜測`));
        delete state.guesses[id];
      }
    }
    return notes;
  };

  // Guess that `pid` took card `id` (or clear the guess with pid = null). A player takes one
  // card of each type per pile, so guessing him for one card replaces any earlier guess of
  // him for a same-type card of the same pile.
  const setGuess = (id, pid) => {
    if (!pid) {
      delete state.guesses[id];
      return;
    }
    if (!candidatesFor(id, false).includes(pid)) return; // he can't have it
    const group = groupOf(id);
    for (const [o, p] of Object.entries(state.guesses)) {
      if (o !== id && p === pid && group && group.ids.includes(o) && typeOf(o) === typeOf(id)) delete state.guesses[o];
    }
    state.guesses[id] = pid;
  };

  // `byPlayer` comes from args.player_id: for buyAndPassCard the card object already
  // reflects the post-pass state, so card.pId/location are not reliable for "who played it".
  // Only the first play counts: that's the player who drafted the card. A travelling card
  // replayed by the player it was passed to must not move it, or the one-per-type exclusion
  // would wrongly rule that player out for the other cards of its draft pile.
  const markPlayed = (card, byPlayer) => {
    const pid = byPlayer || (card && card.pId);
    if (!card || !card.id || pid == null) return;
    remember(card);
    if (!state.played[card.id]) state.played[card.id] = String(pid);
    remove(state.pending, card.id);
  };

  const applySnapshot = (s) => {
    Object.assign(state, {
      tableId: s.tableId,
      myId: s.myId,
      isSpectator: s.isSpectator,
      isReplay: s.isReplay,
      isBeginner: s.isBeginner,
      players: s.players,
      playerOrder: s.playerOrder,
    });
    if (s.draftTotal != null) state.draftTotal = s.draftTotal;
    if (s.draftQuota) state.pickQuota = s.draftQuota;
    for (const c of s.playerCards) {
      remember(c);
      if (c.location === 'inPlay' && c.pId) state.played[c.id] = c.pId;
      if (c.location === 'hand' && c.pId === s.myId) addUnique(state.mine, c.id);
    }
    // During the draft, the pile in front of me lives in players[me].hand with location "draft".
    const pile = [...s.draft];
    for (const c of s.hand) {
      remember(c);
      if (c.location === 'draft') pile.push(c);
      else addUnique(state.mine, c.id);
    }
    if (pile.length) receivePile(pile, s.draftTurn);
  };

  const applyNotif = ({ type, args }) => {
    if (args.player_id && state.myId && args.player_id !== state.myId && /Draft|draft|refreshHand/.test(type)) return;
    switch (type) {
      case 'newDraftPile':
        if (args.type && typeof args.type === 'object') state.pickQuota = args.type;
        receivePile(args.cards || [], args.turn);
        break;
      case 'draftWaiting': {
        const order = state.playerOrder;
        const i = order.indexOf(state.myId);
        const pred = args.predecessorId != null ? String(args.predecessorId) : null;
        if (i >= 0 && pred && order.length > 2) {
          if (order[(i - 1 + order.length) % order.length] === pred) state.direction = 1;
          else if (order[(i + 1) % order.length] === pred) state.direction = -1;
        }
        if (pred) state.directionKnown = true;
        break;
      }
      case 'draftProgress':
        if (args.total != null) state.draftTotal = Number(args.total);
        break;
      // Selection notifs carry only { cardId, pos }, not a card object.
      case 'addCardToDraftSelection': {
        const id = args.cardId || (args.card && args.card.id);
        if (id) addUnique(state.pending, id);
        break;
      }
      case 'removeCardFromDraftSelection': {
        const id = args.cardId || (args.card && args.card.id);
        if (id) remove(state.pending, id);
        break;
      }
      case 'confirmDraftSelection':
        if (args.card) {
          remember(args.card);
          remove(state.pending, args.card.id);
          addUnique(state.mine, args.card.id);
          if (state.myPicks[args.card.id] == null && state.currentTurn != null) state.myPicks[args.card.id] = state.currentTurn;
        }
        break;
      case 'clearDraftPools':
        finalizePile();
        break;
      case 'draftIsOver':
        finalizePile();
        state.draftOver = true;
        break;
      case 'refreshHand':
        for (const c of args.hand || []) {
          remember(c);
          addUnique(state.mine, c.id);
        }
        break;
      case 'buyCard':
      case 'buyAndPassCard':
      case 'buyAndDestroyCard':
        markPlayed(args.card, args.player_id);
        break;
      default:
        // livingHand* etc.: keep any cards we see in the catalog for now.
        if (args.card) remember(args.card);
        for (const c of args.cards || []) remember(c);
    }
  };

  // ---------- panel ----------

  const STYLE = `
    :host { all: initial; }
    .wrap { position: fixed; z-index: 2147483000; width: 300px; max-height: 70vh; display: flex; flex-direction: column;
      font: 12px/1.4 -apple-system, "PingFang TC", "Microsoft JhengHei", sans-serif; color: #2b2116;
      background: #fbf6ea; border: 1px solid #b89b6a; border-radius: 8px; box-shadow: 0 6px 20px rgba(0,0,0,.25); }
    .head { display: flex; align-items: center; gap: 6px; padding: 6px 8px; background: #6b4f2a; color: #fff;
      border-radius: 7px 7px 0 0; cursor: move; user-select: none; }
    .head b { flex: 1; font-size: 13px; }
    .head button { all: unset; cursor: pointer; padding: 0 4px; font-size: 12px; opacity: .85; }
    .head button:hover { opacity: 1; }
    .body { overflow: auto; padding: 6px 8px 8px; }
    .collapsed .body { display: none; }
    .meta { color: #7a6548; margin-bottom: 4px; }
    h4 { margin: 8px 0 4px; font-size: 12px; color: #6b4f2a; border-bottom: 1px solid #e2d3b4; padding-bottom: 2px; }
    h5 { margin: 4px 0 2px; font-size: 11px; color: #7a6548; font-weight: 600; }
    .list { display: flex; flex-wrap: wrap; gap: 6px 4px; padding-top: 4px; }
    .card { position: relative; padding: 1px 5px; border-radius: 4px; border: 1px solid; white-space: nowrap; }
    .card small { opacity: .6; margin-left: 2px; }
    .card.possible { border-style: dashed; opacity: .85; }
    .card.certain { opacity: .85; }
    .badge { position: absolute; top: -6px; right: -6px; width: 13px; height: 13px; border-radius: 50%;
      font: bold 9px/13px -apple-system, sans-serif; font-style: normal; text-align: center; color: #fff; }
    .b-played { background: #3a7d44; }
    .b-certain { background: #b03a2e; }
    .b-possible { background: #8a7a5c; }
    .b-guessed { background: #7b4bb3; }
    .card.guessed { border-color: #7b4bb3; box-shadow: inset 0 0 0 1px #7b4bb3; opacity: .85; }
    .card.by-guess { border-color: #7b4bb3; }
    .card.by-guess .badge { background: #7b4bb3; }
    .toast { position: fixed; z-index: 2147483001; left: 50%; top: 12px; transform: translateX(-50%); max-width: 420px;
      padding: 8px 12px; border-radius: 8px; background: #4a2f70; color: #fff; font: 13px/1.4 -apple-system, "PingFang TC", sans-serif;
      box-shadow: 0 4px 14px rgba(0,0,0,.3); }
    .legend { display: flex; gap: 10px; margin: 2px 0 4px; color: #7a6548; }
    .legend .badge { position: static; display: inline-block; margin-right: 3px; vertical-align: -2px; }
    .counts { font-weight: normal; margin-left: 4px; }
    .occupation { background: #fff3c4; border-color: #d8b84a; }
    .minor { background: #ffe1c7; border-color: #d98b4a; }
    .major { background: #e3e3e3; border-color: #999; }
    .seen { box-shadow: inset 0 0 0 1px #3a7d44; }
    .empty { color: #9b8a70; font-style: italic; }
    .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 4px; vertical-align: middle; }
  `;

  // Status badges in a card's top-right corner.
  const BADGE = { played: '✓', certain: '★', possible: '?', guessed: '✎' };

  // `status` drives the badge; data-* attributes describe the claim for tests and tooling.
  const cardChip = (id, { extraClass = '', status = '', cands = null, tip = '', round = '' } = {}) => {
    const c = state.cards[id] || { id, name: id };
    const num = c.numbering || id.split('_')[0];
    const title = `${c.name} (${num})${tip ? '\n' + tip : ''}`;
    const badge = BADGE[status] ? `<i class="badge b-${status}">${BADGE[status]}</i>` : '';
    return `<span class="card ${esc(c.type || '')} ${status} ${extraClass}" data-id="${esc(id)}" data-status="${esc(status)}"${
      cands ? ` data-cands="${esc(cands.join(','))}"` : ''
    }${round ? ` data-round="${esc(round)}"` : ''} title="${esc(title)}">${esc(c.name)}<small>${esc(num)}</small>${badge}</span>`;
  };

  const byType = (ids) => {
    const groups = {};
    for (const id of ids) {
      const t = (state.cards[id] && state.cards[id].type) || 'other';
      (groups[t] = groups[t] || []).push(id);
    }
    return ['occupation', 'minor', 'major', 'other']
      .filter((t) => groups[t])
      .map((t) => `<h5>${TYPE_LABEL[t] || '其他'}（${groups[t].length}）</h5><div class="list">${groups[t].map((id) => cardChip(id)).join('')}</div>`)
      .join('');
  };

  const pname = (pid) => (state.players[pid] || { name: pid }).name;
  const typeRank = (id) => ({ occupation: 0, minor: 1, major: 2 })[state.cards[id] && state.cards[id].type] ?? 3;
  // The draft turn in which `pid` would have taken card `id`: a pile I pass on in turn t
  // reaches the k-th player after me in turn t + k.
  const roundFor = (id, pid) => {
    const info = state.passInfo[id];
    const k = successors().indexOf(pid);
    return info && info.turn != null && k >= 0 ? info.turn + k + 1 : null;
  };
  // Labels are from my point of view: which of my picks the card was passed on at.
  // e.g. "我第5輪傳出 4選1": it was in the pile I passed on at my 5th pick, and if `pid` has
  // it, he chose it among these 4 cards of its type.
  const passLabel = (id, choices = 1) => {
    const info = state.passInfo[id];
    if (!info || info.turn == null) return '';
    return conv(choices > 1 ? `我第${info.turn}輪傳出 ${choices}選1` : `我第${info.turn}輪傳出`);
  };
  const roundLabel = (id, pid, choices = 1) => (roundFor(id, pid) == null ? '' : passLabel(id, choices));
  const possibleTip = (id, cands, choiceOf = () => 1) => {
    const orDiscarded = state.passInfo[id].returned ? '' : conv('，或已被棄');
    const who = cands.map((pid) => {
      const k = choiceOf(id, pid);
      return `${pname(pid)}${k > 1 ? `（${conv(`${k}選1`)}）` : ''}`;
    });
    const from = passLabel(id);
    return `${from ? from + ' · ' : ''}${conv('可能')}：${who.join(' / ')}${orDiscarded}`;
  };
  const certainTip = (id) => `${conv('確定在他手上')}${passLabel(id) ? `（${passLabel(id)}）` : ''}`;

  // Where each card I passed on can be: certain (pile came back without it and only one
  // player could have taken it), possible (one of several players, or maybe discarded),
  // or discarded (nobody could reach it before the draft ended).
  // Results that only hold because of my guesses are flagged in `byGuess`, so they're never
  // shown like facts; `guessed` holds the guessed cards themselves.
  const computeHoldings = () => {
    const mine = new Set(state.mine);
    const certain = {};
    const possible = {};
    const guessed = {};
    const discarded = [];
    const byGuess = new Set();
    for (const id of state.seen) {
      if (mine.has(id) || state.played[id] || state.currentPile.includes(id) || !state.passInfo[id]) continue;
      const cands = candidatesFor(id);
      const g = state.guesses[id];
      if (g && cands.length === 1 && cands[0] === g) {
        (guessed[g] = guessed[g] || []).push(id);
        continue;
      }
      if (cands.join() !== candidatesFor(id, false).join()) byGuess.add(id);
      if (!cands.length) discarded.push(id);
      else if (state.passInfo[id].returned && cands.length === 1) (certain[cands[0]] = certain[cands[0]] || []).push(id);
      else for (const pid of cands) (possible[pid] = possible[pid] || []).push({ id, cands });
    }
    for (const list of Object.values(guessed)) list.sort((a, b) => typeRank(a) - typeRank(b));
    for (const list of Object.values(certain)) list.sort((a, b) => typeRank(a) - typeRank(b));
    for (const list of Object.values(possible)) list.sort((a, b) => typeRank(a.id) - typeRank(b.id));

    // A player takes exactly one card of each type from each pile, and in a given round he
    // sees exactly one of my piles. So his candidates of one type for one round are "pick 1
    // of K": count K per (player, round, type).
    const groupKey = (id, pid) => `${pid}|${roundFor(id, pid)}|${state.cards[id] && state.cards[id].type}`;
    const sizes = {};
    for (const [pid, ids] of Object.entries(certain)) for (const id of ids) sizes[groupKey(id, pid)] = (sizes[groupKey(id, pid)] || 0) + 1;
    for (const [pid, list] of Object.entries(possible)) for (const { id } of list) sizes[groupKey(id, pid)] = (sizes[groupKey(id, pid)] || 0) + 1;
    const choiceOf = (id, pid) => sizes[groupKey(id, pid)] || 1;

    return { certain, possible, guessed, discarded, byGuess, choiceOf };
  };

  const guessTip = (id) => `${conv('你猜在他手上')}${passLabel(id) ? `（${passLabel(id)}）` : ''}`;
  const BY_GUESS = () => conv('（依你的猜測）');

  // Ask inject.js to draw certain / possible cards next to each opponent's played cards.
  const loadBoardOverlay = () => {
    try {
      return localStorage.getItem('agr-rec-board') !== 'off';
    } catch (e) {
      return true;
    }
  };
  let boardOverlay = loadBoardOverlay();

  // Possible cards with more candidates than this stay in the panel only: right after a
  // 4-player draft most cards could be with any opponent, and drawing them all would
  // swamp the board without telling you anything.
  const BOARD_MAX_CANDIDATES = 2;

  // The draft round in which opponent `pid` took a card he has played.
  //  - A card I passed on: exact, from the pile's path (same as the ghosts' round).
  //  - A card I never saw: he took it before its pile reached me. A pile travels from its
  //    owner towards me, so the k-th player after me only sees piles before I do if they
  //    start at or before him: k piles, in rounds 1..k. For the player I pass to (and the
  //    opponent in a 2-player game) that's round 1 only, i.e. his first pick. My
  //    predecessor sees every pile right before me, so his unseen cards span rounds 1..n-1.
  // Only first plays count (state.played keeps the drafter), so travelling minors passed
  // on to someone else don't get mislabeled.
  const playedRound = (id, pid) => {
    // Only drafted cards: major improvements are bought from the shared board.
    const type = state.cards[id] && state.cards[id].type;
    if (type !== 'occupation' && type !== 'minor') return null;
    if (state.passInfo[id]) {
      const r = roundFor(id, pid);
      return r == null ? null : { lo: r, hi: r };
    }
    if (state.seen.includes(id) || state.trackedFrom !== 1 || !state.draftOver) return null;
    const succ = successors();
    const k = succ.indexOf(pid) + 1;
    if (k < 1) return null;
    const hi = Math.min(k, state.draftTotal || Infinity);
    return { lo: 1, hi };
  };
  const playedLabel = (id, pid) => {
    const r = playedRound(id, pid);
    if (!r) return '';
    if (r.hi === 1) return conv('首選');
    return state.passInfo[id] ? passLabel(id) : conv('我沒看過');
  };
  // My own cards: the round I confirmed each pick in is recorded exactly.
  const myLabel = (id) => {
    const r = state.myPicks[id];
    if (r == null) return '';
    return conv(r === 1 ? '首選' : `我第${r}輪選`);
  };

  const pushGhosts = (holdings) => {
    const byPlayer = {};
    if (boardOverlay) {
      for (const pid of Object.keys(state.players)) {
        if (pid === state.myId) continue;
        const flag = (id, tip) => (holdings.byGuess.has(id) ? { byGuess: true, tip: tip + BY_GUESS() } : { tip });
        const items = [
          ...(holdings.guessed[pid] || []).map((id) => ({ id, status: 'guessed', tip: guessTip(id), round: passLabel(id) })),
          ...(holdings.certain[pid] || []).map((id) => ({ id, status: 'certain', round: passLabel(id), ...flag(id, certainTip(id)) })),
          ...(holdings.possible[pid] || [])
            .filter(({ cands }) => cands.length <= BOARD_MAX_CANDIDATES)
            .map(({ id, cands }) => ({
              id,
              status: 'possible',
              round: roundLabel(id, pid, holdings.choiceOf(id, pid)),
              ...flag(id, possibleTip(id, cands, holdings.choiceOf)),
            })),
        ]
          .filter((it) => state.cardData[it.id])
          .map((it) => ({ ...it, card: state.cardData[it.id] }));
        if (items.length) byPlayer[pid] = items;
      }
    }
    // Cards too widely spread to put on one opponent's board go in a shared pool under the
    // central action board, once each, ordered by the round I passed them on.
    const pool = [];
    if (boardOverlay) {
      const seenIds = new Set();
      for (const list of Object.values(holdings.possible)) {
        for (const { id, cands } of list) {
          if (cands.length <= BOARD_MAX_CANDIDATES || seenIds.has(id) || !state.cardData[id]) continue;
          seenIds.add(id);
          const round = passLabel(id);
          pool.push({
            id,
            status: 'possible',
            tip: possibleTip(id, cands, holdings.choiceOf) + (holdings.byGuess.has(id) ? BY_GUESS() : ''),
            byGuess: holdings.byGuess.has(id),
            round,
            cands: cands.map((pid) => ({ pid, name: pname(pid) })), // for the guess menu
            card: state.cardData[id],
          });
        }
      }
      const passTurn = (id) => (state.passInfo[id] && state.passInfo[id].turn) || 0;
      pool.sort((a, b) => passTurn(a.id) - passTurn(b.id) || typeRank(a.id) - typeRank(b.id));
    }
    const poolTitle = conv(`三個對手都可能（${pool.length}）`);
    // Round tags for real cards: everyone's played cards, plus the cards in my hand.
    const playedTags = {};
    if (boardOverlay) {
      for (const [id, pid] of Object.entries(state.played)) {
        const label = pid === state.myId ? myLabel(id) : playedLabel(id, pid);
        if (label) playedTags[id] = label;
      }
      for (const id of state.mine) {
        if (!playedTags[id] && myLabel(id)) playedTags[id] = myLabel(id);
      }
    }
    const guessLabels = { guess: conv('✎ 猜是他的'), unguess: conv('取消猜測'), pick: conv('猜是誰的：'), board: conv('推測的牌') };
    window.postMessage(
      { source: SOURCE, kind: 'ghosts', payload: { byPlayer, pool, poolTitle, playedTags, guessLabels } },
      window.location.origin
    );
  };

  const render = () => {
    if (!panel || !state) return;
    const body = panel.querySelector('.body');
    const mine = new Set(state.mine);
    const seen = new Set(state.seen);
    const order = state.playerOrder.length ? state.playerOrder : Object.keys(state.players);
    const holdings = computeHoldings();
    const { certain, possible, discarded } = holdings;
    pushGhosts(holdings);

    const playersHtml = order
      .map((pid) => {
        const p = state.players[pid] || { name: pid };
        const playedIds = Object.keys(state.played).filter((id) => state.played[id] === pid).sort((a, b) => typeRank(a) - typeRank(b));
        const certainIds = certain[pid] || [];
        const possibleCards = possible[pid] || [];
        const guessedIds = holdings.guessed[pid] || [];
        const guessClass = (id) => (holdings.byGuess.has(id) ? 'by-guess' : '');
        const guessNote = (id) => (holdings.byGuess.has(id) ? BY_GUESS() : '');
        const chips = [
          ...guessedIds.map((id) => cardChip(id, { status: 'guessed', cands: [pid], tip: guessTip(id) })),
          ...playedIds.map((id) =>
            cardChip(id, {
              status: 'played',
              extraClass: seen.has(id) && !mine.has(id) ? 'seen' : '',
              tip: pid === state.myId ? myLabel(id) : playedLabel(id, pid),
              round: pid === state.myId ? myLabel(id) : playedLabel(id, pid),
            })
          ),
          ...certainIds.map((id) =>
            cardChip(id, { status: 'certain', cands: [pid], extraClass: guessClass(id), tip: certainTip(id) + guessNote(id) })
          ),
          ...possibleCards.map(({ id, cands }) =>
            cardChip(id, { status: 'possible', cands, extraClass: guessClass(id), tip: possibleTip(id, cands, holdings.choiceOf) + guessNote(id) })
          ),
        ].join('');
        const counts = [
          `${BADGE.played}${playedIds.length}`,
          pid === state.myId ? '' : `${BADGE.certain}${certainIds.length}`,
          pid === state.myId ? '' : `${BADGE.possible}${possibleCards.length}`,
          guessedIds.length ? `${BADGE.guessed}${guessedIds.length}` : '',
        ].filter(Boolean).join(' ');
        return `<h5><span class="dot" style="background:#${esc(p.color || '999')}"></span><span class="pname">${esc(p.name)}</span>${
          pid === state.myId ? '（我）' : ''
        }<span class="counts">${counts}</span></h5>
          <div class="list">${chips || '<span class="empty">無</span>'}</div>`;
      })
      .join('');

    const draftStatus = state.draftOver ? '輪抽結束' : state.seen.length ? '輪抽中' : '未記錄到輪抽';
    const notes = [];
    if (state.isBeginner) notes.push('初學者模式：沒有職業卡 / 次要發展卡');
    if (state.isSpectator) notes.push('觀戰中：看不到輪抽和手牌');
    if (state.isReplay) notes.push('重播模式');
    if (state.playerOrder.length > 2 && state.seen.length && !state.directionKnown) notes.push('傳牌方向未確認，暫定傳給下一位');

    body.innerHTML = `
      <div class="meta">牌桌 #${esc(state.tableId)} · ${draftStatus} · 看過 ${state.seen.length} 張</div>
      ${notes.map((n) => `<div class="meta">⚠ ${esc(n)}</div>`).join('')}
      <div class="legend">
        <span><i class="badge b-played">${BADGE.played}</i>已打出</span>
        <span><i class="badge b-certain">${BADGE.certain}</i>確定在手上</span>
        <span><i class="badge b-possible">${BADGE.possible}</i>可能在手上</span>
        <span><i class="badge b-guessed">${BADGE.guessed}</i>你的猜測</span>
      </div>
      <h4>玩家（滑鼠移到牌上看候選；綠框 = 我在輪抽看過）</h4>
      ${playersHtml}
      ${discarded.length ? `<h4>已被棄（${discarded.length}）</h4>${byType(discarded)}` : ''}
      <h4>我的牌（${state.mine.length}）</h4>
      ${state.mine.length ? byType(state.mine) : '<div class="empty">無</div>'}
    `;
    localizeTree(body);
  };

  const loadPos = () => {
    try {
      return JSON.parse(localStorage.getItem('agr-rec-pos')) || null;
    } catch (e) {
      return null;
    }
  };
  const savePos = (pos) => {
    try {
      localStorage.setItem('agr-rec-pos', JSON.stringify(pos));
    } catch (e) {}
  };

  // ---------- simplified / traditional ----------
  // UI strings are written in Traditional Chinese; in Simplified mode they're converted
  // character by character. Card and player names are left as BGA provides them.

  const T2S = Object.fromEntries(
    [...'來来傳传匯汇學学張张戰战時时暫暂業业棄弃沒没無无發发確确紀纪結结給给綠绿職职觀观記记認认讀读資资輪轮這这過过還还錄录換换體体簡简選选顯显隱隐測测個个對对誰谁錯错']
      .reduce((pairs, c, i, arr) => (i % 2 ? pairs : [...pairs, [c, arr[i + 1]]]), [])
  );

  const detectLang = () => {
    try {
      const saved = localStorage.getItem('agr-rec-lang');
      if (saved === 'cn' || saved === 'tw') return saved;
    } catch (e) {}
    return /^zh-(cn|sg|hans)/i.test(navigator.language || '') ? 'cn' : 'tw';
  };
  let lang = detectLang();

  // Taiwan vs mainland wording that a character mapping alone wouldn't fix.
  const PHRASES = [
    ['匯出', '导出'],
    ['紀錄', '记录'],
    ['資料', '数据'],
    ['收合', '收起'],
    ['滑鼠', '鼠标'],
  ];

  const conv = (s) => {
    if (lang !== 'cn') return s;
    for (const [tw, cn] of PHRASES) s = s.split(tw).join(cn);
    return s.replace(/[一-鿿]/g, (c) => T2S[c] || c);
  };

  const localizeTree = (root) => {
    if (lang !== 'cn') return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.parentElement.closest('.card, .pname')) n.nodeValue = conv(n.nodeValue);
    }
  };

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `agricola-${state.tableId}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const mountPanel = () => {
    if (panel) return;
    const host = document.createElement('div');
    host.id = 'agr-rec-host';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${STYLE}</style>
      <div class="wrap">
        <div class="head"><b data-tw="🌾 記牌器"></b>
          <button data-act="lang" data-tw="切換繁體 / 簡體"></button>
          <button data-act="board" data-tw="在農場上顯示 / 隱藏推測的牌">🃏</button>
          <button data-act="resync" data-tw="重新讀取牌桌資料">↻</button>
          <button data-act="export" data-tw="匯出 JSON">⤓</button>
          <button data-act="reset" data-tw="清除本桌紀錄">✕</button>
          <button data-act="toggle" data-tw="收合">▾</button>
        </div>
        <div class="body"></div>
      </div>`;
    document.body.appendChild(host);
    panel = root.querySelector('.wrap');

    const localizeHeader = () => {
      for (const el of root.querySelectorAll('[data-tw]')) {
        if (el.tagName === 'BUTTON') el.title = conv(el.dataset.tw);
        else el.textContent = conv(el.dataset.tw);
      }
      root.querySelector('[data-act="lang"]').textContent = lang === 'cn' ? '繁' : '简';
      root.querySelector('[data-act="board"]').style.opacity = boardOverlay ? '1' : '.4';
    };
    localizeHeader();

    const pos = loadPos() || { left: 12, top: 80 };
    panel.style.left = pos.left + 'px';
    panel.style.top = pos.top + 'px';

    // Collapsed by default: the board overlay is the main view. Stored on its own key so an
    // older saved "expanded" position doesn't override the new default.
    let collapsed = true;
    try {
      collapsed = localStorage.getItem('agr-rec-collapsed') !== 'no';
    } catch (err) {}
    panel.classList.toggle('collapsed', collapsed);

    root.querySelector('.head').addEventListener('click', (e) => {
      const act = e.target.dataset && e.target.dataset.act;
      if (act === 'toggle') {
        panel.classList.toggle('collapsed');
        try {
          localStorage.setItem('agr-rec-collapsed', panel.classList.contains('collapsed') ? 'yes' : 'no');
        } catch (err) {}
      } else if (act === 'board') {
        boardOverlay = !boardOverlay;
        try {
          localStorage.setItem('agr-rec-board', boardOverlay ? 'on' : 'off');
        } catch (err) {}
        localizeHeader();
        render();
      } else if (act === 'lang') {
        lang = lang === 'cn' ? 'tw' : 'cn';
        try {
          localStorage.setItem('agr-rec-lang', lang);
        } catch (err) {}
        localizeHeader();
        render();
      } else if (act === 'export') {
        exportJson();
      } else if (act === 'resync') {
        window.postMessage({ source: SOURCE, kind: 'requestSnapshot' }, window.location.origin);
      } else if (act === 'reset') {
        if (window.confirm(conv('清除這桌的記牌紀錄？'))) {
          const keep = { tableId: state.tableId, myId: state.myId };
          state = Object.assign(emptyState(), keep);
          save();
          window.postMessage({ source: SOURCE, kind: 'requestSnapshot' }, window.location.origin);
        }
      }
    });

    // Drag by the header.
    const head = root.querySelector('.head');
    head.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      const startX = e.clientX - panel.offsetLeft;
      const startY = e.clientY - panel.offsetTop;
      const move = (ev) => {
        pos.left = Math.max(0, Math.min(window.innerWidth - 60, ev.clientX - startX));
        pos.top = Math.max(0, Math.min(window.innerHeight - 30, ev.clientY - startY));
        panel.style.left = pos.left + 'px';
        panel.style.top = pos.top + 'px';
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        savePos(pos);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
  };

  // Lets background.js notice source edits (dev auto-reload). After the extension
  // reloads, this script is orphaned and sendMessage throws, so stop pinging.
  let devPing = null;
  const startDevPing = () => {
    if (devPing) return;
    // Builds without the dev background worker (e.g. Firefox) have nobody to ping.
    try {
      if (!ext.runtime.getManifest().background) return;
    } catch (e) {
      return;
    }
    devPing = setInterval(() => {
      try {
        ext.runtime.sendMessage({ type: 'agr-dev-check' }).catch(() => {});
      } catch (e) {
        clearInterval(devPing);
      }
    }, 3000);
  };

  // ---------- message pump ----------

  const handle = async ({ kind, payload }) => {
    if (kind === 'snapshot') {
      const key = `agr:${payload.tableId}:${payload.myId}`;
      if (key !== storageKey) {
        storageKey = key;
        const saved = await load(key);
        // Older saves have an incompatible draft model; start fresh rather than misreport.
        state = Object.assign(emptyState(), saved && saved.version === emptyState().version ? saved : null);
      }
      applySnapshot(payload);
      mountPanel();
      startDevPing();
    } else if (kind === 'notif') {
      if (!state) return; // snapshot always comes first; ignore strays
      applyNotif(payload);
    } else if (kind === 'cardData') {
      if (!state) return;
      for (const c of payload.cards) state.cardData[c.id] = c;
    } else if (kind === 'guess') {
      // From the ✎ buttons on the board overlay (inject.js).
      if (!state) return;
      setGuess(payload.id, payload.pid || null);
    }
    if (state) pruneGuesses().forEach(showToast);
    save();
    render();
  };

  // Short notice at the top of the page, e.g. when a play contradicts one of my guesses.
  const showToast = (text) => {
    console.log('[agr-rec]', text);
    const root = panel && panel.getRootNode && panel.getRootNode();
    if (!root || !root.appendChild) return;
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = text;
    root.appendChild(el);
    setTimeout(() => el.remove(), 7000);
  };

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.source !== SOURCE) return;
    if (!['snapshot', 'notif', 'cardData', 'guess'].includes(e.data.kind)) return;
    queue = queue.then(() => handle(e.data)).catch((err) => console.warn('[agr-rec] handler error', err));
  });
})();
