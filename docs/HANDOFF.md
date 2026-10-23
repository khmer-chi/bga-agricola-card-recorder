# 交接文件

給接手這個專案的人（或新的 Claude Code 對話）：讀完這份就能接著開發。使用者看的說明在 [README.md](../README.md)。

## 這是什麼

BGA（Board Game Arena）農家樂的瀏覽器擴充功能（Chrome MV3，另有 Firefox 版）。它在**競技場**輪抽時記下看過、傳出的牌，推論每張牌在哪位對手手上，並畫在對手農場下方。使用者偏好：

- 介面與說明用**繁體中文**，另有簡體版（面板依瀏覽器語言自動切換，README 另有 `README.zh-CN.md`）。
- 卡牌叫法用 BGA 正式名稱：**職業卡、次要發展卡、主要發展卡**（不要用「小發明」）。
- 輪次標籤**以玩家（我）的角度**寫：「我第5輪傳出 4選1」「我第N輪選」「首選」「我沒看過」。
- 只有遊戲中**真正打出的卡**是正常亮度，所有推測的牌（★ / ? / ✎）都調暗。
- 改完功能要**用重播實際驗證**，沒問題才推上 GitHub。

## 檔案

| 檔案 | 說明 |
|---|---|
| `manifest.json` | Chrome 版 |
| `manifest.firefox.json` | Firefox 版（128+，`world: "MAIN"`），`scripts/build-firefox.sh` 組到 `dist/` 並打包 |
| `src/inject.js` | 頁面 MAIN world：讀 `gameui`、攔截通知、傳完整卡牌資料、在農場上畫推測牌 / 輪次標籤 / ✎ 按鈕 |
| `src/content.js` | isolated world：記牌狀態、推論、存檔（`chrome.storage.local`）、浮動面板（shadow DOM）、簡繁轉換 |
| `src/background.js` | 只在 Chrome「載入未封裝項目」時有用：偵測檔案變動，自動重新載入擴充功能並重整 BGA 分頁 |
| `tests/` | 離線測試，見下方 |

兩支腳本用 `window.postMessage`（`source: 'agr-rec'`）溝通：inject → content 送 `snapshot`、`notif`、`cardData`、`guess`；content → inject 送 `ghosts`（農場推測牌、中央區塊、輪次標籤、按鈕文字）和 `requestSnapshot`。

## BGA 內部（實測過）

- 進行中的牌桌（`/tableview?table=N`）遊戲在 `iframe#gameIframe` 裡，`gameui` 在 iframe；重播（`/archive/replay/...`）的 `gameui` 在最上層。所以腳本都設 `all_frames`。
- `gameui.gamedatas.playerCards[]`：id 像 `C75_Firewood`，`type` 是 occupation / minor / major。輪抽中眼前的牌堆在 `players[me].hand`，location 是 `draft`。**`gamedatas` 不會隨輪抽更新**，一定要靠通知。
- 通知格式：
  - `newDraftPile` = `{cards, turn, type: {occupation:1, minor:1}}`
  - `addCardToDraftSelection` / `removeCardFromDraftSelection` = `{cardId, pos}`（沒有 card 物件）
  - `confirmDraftSelection` = `{card, player_id}`
  - `draftWaiting` = `{predecessorId}`（傳牌給我的人，用來判斷方向）
  - `draftProgress` = `{allTurns, total}`
  - `buyAndPassCard`：`args.player_id` 是打出的人、`player_id2` 是收到的人，`card.pId` 不可靠
  - 買**主要發展卡**也會送 `buyCard`，不能當成輪抽來的牌
- 競技場 4 人局：開局一疊 18 張（9 職業卡 + 9 次要發展卡），7 輪，每輪各拿 1 張，最後每疊剩 4 張被棄。傳牌方向整場固定（傳給 `playerorder` 下一位）。新牌堆一定在我確認選牌之後才送到。
- 卡牌畫面：`gameui.tplPlayerCard(card)` 產生 BGA 的卡牌 HTML；`gameui._cardStorage` 是完整卡牌資料的快取，但**重新整理後只剩場上和自己手上的牌**，所以 extension 自己存 `cardData`。放大用 `zoomOnCard(id)`，懸停提示用 `addCustomTooltip(id, html)`。
- 玩家區塊高度是 JS 算的固定值，加了卡要呼叫 `gameui.updatePlayerBoardScale()`，不然會蓋到下一列。
- `#player-boards`、`#player-boards-left-column` 是 `pointer-events: none`，放在裡面的東西要自己設回 `auto`。
- 重播的 `window.g_gamelogs` 有**所有玩家的私人頻道**（`/player/p<id>`），可以當輪抽的正確答案。

## 推論規則

- **候選範圍**：我在第 t 輪傳出的牌，第 k 位下家在第 t+k 輪才會看到。候選是下家 1…k，k = min(玩家數 − 1, 總輪數 − t)。牌堆傳回來時少了的牌一定被拿走了（returned）；沒傳回來的也可能被棄。
- **排除推論**：每人每輪每種牌只拿 1 張（quota 為 1 時）。同一疊牌裡，某人打出了一張同類型的牌，他就不可能持有其他張。猜測（✎）也會用同樣規則排除，但結果標成「依你的猜測」。
- **★ 確定** = 牌堆傳回來過，且候選只剩一人。未傳回的牌堆每種最後都有牌被棄，所以只能到「只剩某人，或已被棄」。
- **K選1**：同一位玩家、同一輪、同一種牌的候選張數。
- **打出的牌的輪次**：看過的牌可以精確算出；沒看過的牌，第 k 位下家只可能是第 1…k 輪選的。所以**下家**（k=1）打出我沒看過的牌一定是首選。注意不是上家：上家每輪都比我先挑每一疊牌。
- 一張牌只記**第一個打出的人**（輪抽拿到它的人），會傳給下家的次要發展卡被收到的人再打出時不覆蓋。

## 測試

```sh
npm test            # 重播回放（含猜對 / 猜錯 / 傳下家卡的情境）＋ 隨機模擬
npm run test:panel  # 需要先 npm install（jsdom）：在真 DOM 裡跑面板與簡繁切換
```

- `tests/replay-test.js`：用 `tests/fixtures/replay-933562596.json`（一場真實 4 人競技場，含全部玩家選牌），只把「我」收得到的通知餵給 content.js，再用全部玩家的選牌比對面板上每一個判斷、輪次、K選1、打出卡的標籤。環境變數：`GUESS=A5m:2`（猜 A5 是 order[2] 的）、`WRONG=1`（猜錯時只檢查真實推論）、`TRAVEL=E25m:1`（模擬傳下家卡被收到的人再打出）。
- `tests/sim.js`：隨機產生 2 / 3 / 4 人輪抽（正反方向）與出牌，檢查所有判斷。
- 新增測試牌局：開一場標準局的重播（選你自己的視角、停在第 1 步），在 DevTools 主控台貼上 `tests/dump-replay-snippet.js`，存成 `tests/fixtures/*.json`。

## 開發與驗證的眉角

- Chrome 載入未封裝後，改檔案會自動重新載入並重整 BGA 分頁（`background.js`），不用手動。
- 在真實重播上驗證：
  - 重播分頁在背景時 Chrome 會節流計時器，一步步點「下一步」會非常慢。用 `gameui.onArchiveToEnd({preventDefault(){}})` 跳到結束，或 `gameui.archiveGoToMove(n, true)` 跳到第 n 步（瞬間模式，不受節流影響）。輪抽在這場是第 32 步結束。
  - 同一場重播重複播放時，會沿用之前的存檔（依「牌桌 + 玩家」存）。想看乾淨狀態可以換別的玩家視角（網址的 `player=`）。
  - 重播停在輪抽時，畫面上的手牌和輪抽區也有同 id 的卡片元素，測試時小心 `getElementById` 拿錯。
  - 一定要用**真的滑鼠**測點擊。程式觸發的 `.click()` 會繞過 `pointer-events` 和巢狀 `zoom` 造成的點擊錯位（中央區塊曾經因此點不到）。
- Claude 的瀏覽器工具：`javascript_tool` 的輸出大約 1000 字元就截斷，含 `=` `&` `?` 的字串會被擋，大資料要分段（≤ 900 字元）並加校驗值。

## 還沒驗證 / 待辦

- 實戰中卡片滑入動畫後，打出卡的輪次標籤是否及時出現（程式每 2 秒補貼一次）。
- 「猜錯時跳出提示」只在離線測試確認過訊息，沒在真實頁面看過提示框。
- Firefox 版還沒實際在 Firefox 跑過；手機（Firefox for Android）版面一定需要調整。
- `livingHand*` 這類輪抽方式沒有支援。
