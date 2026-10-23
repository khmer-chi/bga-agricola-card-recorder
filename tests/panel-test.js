// Runs content.js in a real DOM (jsdom) against the recorded 4p replay and prints the
// panel in Traditional and Simplified, exercising the language toggle button.
const fs = require('fs');
const { JSDOM } = require('jsdom');
const path = require('path');
const contentPath = process.argv[2] || path.join(__dirname, '..', 'src', 'content.js');
const replayPath = process.argv[3] || path.join(__dirname, 'fixtures', 'replay-933562596.json');
const navLang = process.argv[4] || 'zh-TW';
const D = JSON.parse(fs.readFileSync(replayPath, 'utf8'));

const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://boardgamearena.com/tableview?table=1', runScripts: 'outside-only', pretendToBeVisual: true });
const w = dom.window;
Object.defineProperty(w.navigator, 'language', { value: navLang || 'zh-TW' });
const store = {};
w.chrome = { storage: { local: { get: async (k) => ({ [k]: store[k] }), set: async (o) => Object.assign(store, o) } }, runtime: { sendMessage: () => Promise.resolve() } };
w.eval(fs.readFileSync(contentPath, 'utf8'));

const NAMES = { A89: '蘿蔔農夫', B97: '牧師', D168: '馬夫', A5: '馬槽', E25: '五金行', E41: '品嚐', A157: '家庭教師', B160: '小馬夫', B95: '全職飼養員', D157: '燈籠小屋', C166: '石堰', D139: '啤酒攤販', D99: '同行者', E95: '開拓者', A58: '鐵鋤', A6: '傳家寶', E65: '教育基金', B4: '護壁板', C32: '滑犁', D69: '木材堆', E118: '農田看護', B125: '秋之母', D22: '酸種麵包', A71: '職人町' };
const order = D.order; const ME = order[D.me];
const card = (code, extra = {}) => {
  const t = code.slice(-1); const pre = code.slice(0, -1);
  return { id: `${pre}_x`, name: (NAMES[pre] || `卡${pre}`), numbering: pre, type: t === 'o' ? 'occupation' : t === 'm' ? 'minor' : 'major', ...extra };
};
const post = (kind, payload) => w.dispatchEvent(new w.MessageEvent('message', { source: w, data: { source: 'agr-rec', kind, payload } }));
// Player names deliberately contain Traditional-only characters to prove they're not converted.
const names = ['我們這裡', '張三', '東西', '還有'];
post('snapshot', { tableId: 'r', myId: ME, isSpectator: false, isReplay: false, isBeginner: false, playerOrder: order,
  players: Object.fromEntries(order.map((p, i) => [p, { id: p, name: names[i], color: '123456' }])), playerCards: [],
  hand: D.hand.map((h) => card(h.split('@')[0], { pId: ME, location: 'draft' })), draft: [], draftTurn: 1, draftTotal: D.total, draftQuota: D.quota });
for (const [ch, type, ...a] of D.ev) {
  if (ch !== D.me && ch !== -1) continue;
  const N = (t, args) => post('notif', { type: t, args });
  if (type === 'A') N('addCardToDraftSelection', { cardId: card(a[0] + 'o').id });
  if (type === 'C') N('confirmDraftSelection', { player_id: ME, card: card(a[0], { location: 'selection' }) });
  if (type === 'W') N('draftWaiting', { predecessorId: order[a[0]] });
  if (type === 'P') N('newDraftPile', { player_id: ME, turn: a[0], type: D.quota, cards: a[1].split(',').map((c) => card(c)) });
  if (type === 'O') N('draftIsOver', {});
  if (type === 'B' && !a[1].startsWith('Major')) N('buyCard', { player_id: order[a[0]], card: card(a[1], { pId: order[a[0]], location: 'inPlay' }) });
}

const show = (label) => {
  const root = w.document.getElementById('agr-rec-host').shadowRoot;
  const head = [...root.querySelectorAll('.head > *')].map((e) => (e.tagName === 'B' ? e.textContent : `[${e.textContent}|${e.title}]`)).join(' ');
  const text = root.querySelector('.body').innerText || root.querySelector('.body').textContent;
  console.log(`===== ${label} =====\n${head}\n${text.replace(/\s+\n/g, '\n').replace(/\n{2,}/g, '\n').trim().slice(0, 900)}\n`);
};

setTimeout(() => {
  if (process.env.DUMP) {
    const root = w.document.getElementById('agr-rec-host').shadowRoot;
    const style = root.querySelector('style').outerHTML;
    const wrap = root.querySelector('.wrap').outerHTML.replace('class="wrap', 'style="left:12px;top:12px" class="wrap');
    fs.writeFileSync(process.env.DUMP, `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#3b5d2a;min-height:100vh">${style.replace(':host', '.x')}${wrap}</body>`);
    console.log('dumped', process.env.DUMP);
    process.exit(0);
  }
  show(`navigator.language=${navLang}`);
  w.document.getElementById('agr-rec-host').shadowRoot.querySelector('[data-act="lang"]').click();
  show('after clicking lang toggle');
  console.log('saved lang:', w.localStorage.getItem('agr-rec-lang'));
  w.close();
  process.exit(0);
}, 500);
