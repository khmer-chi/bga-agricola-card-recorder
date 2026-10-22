// Runs in the extension's isolated world. Receives events from inject.js,
// keeps the card-tracking state per table, persists it, and renders the panel.
(() => {
  if (window.__agrRecContent) return;
  window.__agrRecContent = true;

  const SOURCE = 'agr-rec';
  const TYPE_LABEL = { occupation: '職業', minor: '小發明', major: '大發明' };

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
    draftTotal: null, // total draft turns
    direction: 1, // +1: I pass to the next player in playerOrder, -1: to the previous one
    directionKnown: false, // set once draftWaiting tells us who passes to me
    passedPiles: [], // { ids, turn } piles I passed on and haven't seen come back yet
    passInfo: {}, // id -> { turn, returned } for the last time I passed it; returned = its pile came back without it
    returnedGroups: [], // { turn, ids }: cards missing from a pile when it came back, taken one-per-type by each successor
    pickQuota: null, // { occupation: 1, minor: 1 }: cards of each type a player takes per draft turn
    played: {}, // id -> player id who played it
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
      const res = await chrome.storage.local.get(key);
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
    chrome.storage.local.set({ [storageKey]: state }).catch((e) => console.warn('[agr-rec] save failed', e));
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
    for (const id of state.pending) addUnique(state.mine, id);
    state.pending = [];
    state.currentPile = [];
  };

  const receivePile = (cards, turn) => {
    const ids = cards.map((c) => c.id);
    if (ids.length && ids.every((id) => state.currentPile.includes(id)) && ids.length === state.currentPile.length) return;
    finalizePile();
    if (turn != null) state.currentTurn = Number(turn);
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

  // Who could hold a card I passed on: the players the pile can reach before it
  // returns to me or the draft ends.
  const candidatesFor = (id) => {
    const info = state.passInfo[id];
    const succ = successors();
    if (!info) return succ;
    let hops = succ.length;
    if (!info.returned && state.draftTotal != null && info.turn != null) hops = Math.min(hops, state.draftTotal - info.turn);
    let cands = succ.slice(0, Math.max(0, hops));

    // Each player takes exactly one card of a type from a pile per turn (when the quota is 1).
    // So if someone played another same-type card from the same pile, they can't hold this one.
    const type = state.cards[id] && state.cards[id].type;
    if (state.pickQuota && state.pickQuota[type] === 1) {
      const group = state.returnedGroups.find((g) => g.ids.includes(id)) || state.passedPiles.find((p) => p.ids.includes(id));
      if (group) {
        const excluded = group.ids
          .filter((o) => o !== id && state.played[o] && state.cards[o] && state.cards[o].type === type)
          .map((o) => state.played[o]);
        cands = cands.filter((pid) => !excluded.includes(pid));
      }
    }
    return cands;
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
    .list { display: flex; flex-wrap: wrap; gap: 3px; }
    .card { padding: 1px 5px; border-radius: 4px; border: 1px solid; white-space: nowrap; }
    .card small { opacity: .6; margin-left: 2px; }
    .occupation { background: #fff3c4; border-color: #d8b84a; }
    .minor { background: #ffe1c7; border-color: #d98b4a; }
    .major { background: #e3e3e3; border-color: #999; }
    .seen { box-shadow: inset 0 0 0 1px #3a7d44; }
    .empty { color: #9b8a70; font-style: italic; }
    .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 4px; vertical-align: middle; }
  `;

  const cardChip = (id, extraClass = '') => {
    const c = state.cards[id] || { id, name: id };
    const num = c.numbering || id.split('_')[0];
    return `<span class="card ${esc(c.type || '')} ${extraClass}" title="${esc(c.name)} (${esc(num)})">${esc(c.name)}<small>${esc(num)}</small></span>`;
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

  const render = () => {
    if (!panel || !state) return;
    const body = panel.querySelector('.body');
    const mine = new Set(state.mine);
    const seen = new Set(state.seen);

    // Cards I saw in the draft, didn't keep, aren't in front of me now, and nobody has played yet.
    const inPlay = (id) => mine.has(id) || state.played[id] || state.currentPile.includes(id);
    const who = (pid) => {
      const p = state.players[pid] || { name: pid };
      return `<span class="dot" style="background:#${esc(p.color || '999')}"></span><span class="pname">${esc(p.name)}</span>`;
    };
    const names = (pids) => pids.map(who).join(' / ');

    // Group the cards I passed by what we can say about them and by who could hold them.
    const groups = { taken: new Map(), maybe: new Map(), transit: new Map() };
    for (const id of state.seen) {
      if (inPlay(id) || !state.passInfo[id]) continue;
      const status = state.passInfo[id].returned ? 'taken' : state.draftOver ? 'maybe' : 'transit';
      const cands = candidatesFor(id);
      const key = cands.join(',');
      if (!groups[status].has(key)) groups[status].set(key, { cands, ids: [] });
      groups[status].get(key).ids.push(id);
    }
    const groupHtml = (status, label) =>
      [...groups[status].values()].map(({ cands, ids }) => `<h5>${label(cands)}（${ids.length}）</h5>${byType(ids)}`).join('');
    const takenHtml = groupHtml('taken', (c) => (c.length === 1 ? `確定：${names(c)}` : `${names(c)} 其中一人`));
    const outHtml =
      groupHtml('maybe', (c) => (c.length ? `${names(c)}，或已被棄` : '已被棄（輪抽結束前沒人拿得到）')) +
      groupHtml('transit', (c) => `流通中，可能被 ${names(c)} 拿走`);

    const order = state.playerOrder.length ? state.playerOrder : Object.keys(state.players);
    const playedHtml = order
      .map((pid) => {
        const p = state.players[pid] || { name: pid };
        const ids = Object.keys(state.played).filter((id) => state.played[id] === pid);
        const chips = ids.map((id) => cardChip(id, seen.has(id) && !mine.has(id) ? 'seen' : '')).join('');
        return `<h5><span class="dot" style="background:#${esc(p.color || '999')}"></span><span class="pname">${esc(p.name)}</span>${pid === state.myId ? '（我）' : ''}（${ids.length}）</h5>
          <div class="list">${chips || '<span class="empty">尚未打出</span>'}</div>`;
      })
      .join('');

    const draftStatus = state.draftOver ? '輪抽結束' : state.seen.length ? '輪抽中' : '未記錄到輪抽';
    const notes = [];
    if (state.isBeginner) notes.push('初學者模式：沒有職業 / 小發明卡');
    if (state.isSpectator) notes.push('觀戰中：看不到輪抽和手牌');
    if (state.isReplay) notes.push('重播模式');
    if (state.playerOrder.length > 2 && state.seen.length && !state.directionKnown) notes.push('傳牌方向未確認，暫定傳給下一位');

    body.innerHTML = `
      <div class="meta">牌桌 #${esc(state.tableId)} · ${draftStatus} · 看過 ${state.seen.length} 張</div>
      ${notes.map((n) => `<div class="meta">⚠ ${esc(n)}</div>`).join('')}
      <h4>被拿走（牌堆傳回來時少了，還沒打出）</h4>
      ${takenHtml || '<div class="empty">無</div>'}
      <h4>去向未明（我傳出、還沒傳回來）</h4>
      ${outHtml || '<div class="empty">無</div>'}
      <h4>已打出（綠框 = 我在輪抽看過）</h4>
      ${playedHtml}
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
    [...'來来傳传匯汇學学張张戰战時时暫暂業业棄弃沒没無无發发確确紀纪結结給给綠绿職职觀观記记認认讀读資资輪轮這这過过還还錄录換换體体簡简']
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
    };
    localizeHeader();

    const pos = loadPos() || { left: 12, top: 80, collapsed: false };
    panel.style.left = pos.left + 'px';
    panel.style.top = pos.top + 'px';
    panel.classList.toggle('collapsed', !!pos.collapsed);

    root.querySelector('.head').addEventListener('click', (e) => {
      const act = e.target.dataset && e.target.dataset.act;
      if (act === 'toggle') {
        panel.classList.toggle('collapsed');
        savePos({ ...pos, collapsed: panel.classList.contains('collapsed') });
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
        savePos({ ...pos, collapsed: panel.classList.contains('collapsed') });
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
    devPing = setInterval(() => {
      try {
        chrome.runtime.sendMessage({ type: 'agr-dev-check' }).catch(() => {});
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
    }
    save();
    render();
  };

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.source !== SOURCE) return;
    if (e.data.kind !== 'snapshot' && e.data.kind !== 'notif') return;
    queue = queue.then(() => handle(e.data)).catch((err) => console.warn('[agr-rec] handler error', err));
  });
})();
