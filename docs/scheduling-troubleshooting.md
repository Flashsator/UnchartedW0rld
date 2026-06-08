# 排程與觸發 — 疑難排解筆記（2026-06-08 調查）

這份筆記記錄一次排程異常的調查：**為什麼週日（非發布日）也跑了 pipeline，
而且看起來「Shorts 也發了」**。給未來的自己/agent 參考。

## 排程架構（先搞懂這個）

```
Cloudflare Worker (uncharted-daily-trigger)
  └─ cron 觸發 → 對 GitHub 發 workflow_dispatch → 跑 daily.yml 完整 pipeline
GitHub 內建 cron（備援）
  └─ Mon/Wed/Fri 15:30 UTC，只在 CF 沒觸發時補（靠 upload lock 早退）
```

- **主排程是 Cloudflare Worker**，不是 GitHub cron。
- Worker 的 `scheduled()` 是**無條件** dispatch — 它沒有任何「星期判斷」，
  哪天觸發完全由 `cloudflare-trigger/wrangler.toml` 的 cron 決定。
- Worker 的 `fetch()`（訪問 Worker URL）**也會觸發一次 dispatch，且無驗證** —
  次要風險，但不是整點觸發，可從時間戳記區分。
- pipeline **本身沒有「非發布日就不發」的 gate**。`seriesForToday()` 在沒有
  對應星期時會走 fallback（用日期輪一個 series），所以**只要 workflow 被觸發，
  不管哪天它都會發片**。

## 這次的兩個發現

### 1. 線上 Worker 的 cron 跟 repo 不同步（會週末誤觸）

`wrangler.toml` 設定是 `crons = ["0 13 * * 1,3,5"]`（只有 Mon/Wed/Fri），
但觸發紀錄顯示 **2026-06-07（週日）13:00:09 UTC** 有一次「整點 + 數秒 jitter」
的 cron 觸發 —— 這是 Cloudflare cron 的特徵，週日不該發生。

→ **結論：線上部署的是舊版 cron（含週末），從沒被重新部署同步成 repo 的設定。**
這就是週日多跑一支計畫外影片（`4bFajUx2ydM`, Beast Codex/animals）的根因。

> 補充：`CLOUDFLARE_API_TOKEN` 在調查時已驗證失效（`Invalid API Token`），
> 所以無法用 API 直接讀線上 cron，只能靠觸發紀錄反推。

### 2. 「Shorts 也發了」其實是正常設計

`planShortsForToday()` 的設計是：長片 run 當天「產生」Short，但**排程公開在
後續的 off-day**：

```
Mon 長片 → Tue 發 short
Wed 長片 → Thu 發 short
Fri 長片 → Sat + Sun 發 short（兩支）
其他天 → 不發
```

所以在 06-07 看到的那支 Short（`aVToU-9aNos`）是 **06-06 的 run 排到隔天的**，
**不是** 06-07 的 run 發的 —— 06-07 run 的 log 明寫「Shorts: nothing scheduled
for today.」。這不是 bug。

## 修復步驟

### A. 重新部署 Worker，把 cron 同步成 Mon/Wed/Fri

> ⚠️ 先確認 `wrangler.toml` 的 `crons` 真的是你要的發布日（目前是 Mon/Wed/Fri，
> 跟 `CLAUDE.md` 一致）。deploy 會用它覆蓋線上的舊 cron。

需要先用「有效的」憑證。兩種擇一：

```powershell
# 方式一：互動式登入（會開瀏覽器，必須你自己在終端機跑）
#   在 Claude Code 的輸入框打：  ! npx wrangler login
# 登入後：
cd cloudflare-trigger
npx wrangler deploy
```

```powershell
# 方式二：用新的 API token（見 B 段產生），不需開瀏覽器
$env:CLOUDFLARE_API_TOKEN = "<新的 token>"
cd cloudflare-trigger
npx wrangler deploy
```

- `wrangler deploy` **只更新 code + cron**，**不會動到 `GH_PAT` secret**
  （那是 `wrangler secret put` 設的），所以部署後觸發功能照常。
- 若 wrangler 問要用哪個 account，選對應 `uncharted-daily-trigger` 的那個。

### B. 重新產生失效的 `CLOUDFLARE_API_TOKEN`

1. 到 Cloudflare Dashboard → My Profile → **API Tokens** → Create Token。
2. 權限至少需要：**Account › Workers Scripts › Edit**
   （要讀 cron schedules 再加 **Account › Workers Scripts › Read**）。
3. 產生後，更新專案根目錄 `.env` 的 `CLOUDFLARE_API_TOKEN=`（`.env` 不進 git）。
4. 驗證：
   ```bash
   curl -s https://api.cloudflare.com/client/v4/user/tokens/verify \
     -H "Authorization: Bearer <新 token>"
   # 期望 "success": true, "status": "active"
   ```

### C.（建議）確認 GH_PAT secret 仍有效

Worker 用 `GH_PAT`（fine-grained PAT，scope：此 repo 的 Actions: write）去發
workflow_dispatch。若它過期，Worker 觸發會 500。重設方式：

```bash
cd cloudflare-trigger
npx wrangler secret put GH_PAT   # 貼上新的 PAT
```

## 一句話總結

| 你看到的 | 真相 | 要不要修 |
|---|---|---|
| 週日 GH 有跑 + 多一支長片 | 線上 CF cron 是舊版、含週末，沒同步 repo | 要：重新 `wrangler deploy` |
| 週日也有 Short | 正常設計：06-06 run 排到隔天公開的 | 不用 |
| API 查不到線上 cron | `CLOUDFLARE_API_TOKEN` 過期失效 | 要：重新產生 token |

---

## 後續：改用 Upstash QStash 當唯一觸發（2026-06-08）

CF Worker 的 token 過期後就靜默不觸發，GitHub 內建 cron 又常常遲到數小時，
兩個都不可靠。所以 2026-06-08 起：

- **移除** `daily.yml` 的 `schedule:` cron（commit `8501997`），`on:` 只剩 `workflow_dispatch:`。
- **CF Worker 排程停用**。
- **唯一觸發 = Upstash QStash**：一個 schedule（cron `0 13 * * 1,3,5` = Mon/Wed/Fri
  13:00 UTC = 台灣 21:00）對 GitHub 的 `daily.yml` 發 `workflow_dispatch`，
  轉發一顆 GitHub PAT（`Upstash-Forward-Authorization`，需此 repo 的 Actions: write）。
- 重複發片仍由 upload lock（`work/.last-upload-date`）+ `daily-video` concurrency group 擋。
- **漏觸發時手動補**：`gh workflow run "Daily video" --ref main`。

建立 schedule（token 從 `.env` 讀，不要把值貼進終端歷史/聊天）：

```bash
curl -s -X POST \
  "https://qstash.upstash.io/v2/schedules/https://api.github.com/repos/Flashsator/UnchartedW0rld/actions/workflows/daily.yml/dispatches" \
  -H "Authorization: Bearer $QSTASH_TOKEN" \
  -H "Upstash-Cron: 0 13 * * 1,3,5" \
  -H "Upstash-Method: POST" \
  -H "Upstash-Forward-Authorization: Bearer $GH_PAT" \
  -H "Upstash-Forward-Accept: application/vnd.github+json" \
  -H "Content-Type: application/json" \
  -d '{"ref":"main"}'
```

## ⚠️ QStash schedule 會洩漏轉發的 token — 絕對不要 `GET /v2/schedules`

**背景**：GitHub PAT 是放在 `Upstash-Forward-Authorization: Bearer <token>` header 裡
建立排程的。QStash 會把這個 header **原封不動、明文儲存在每一個 schedule 裡**。

**地雷**：任何「列出/讀取排程」的呼叫都會把存的 token **明文吐回來**：
- `GET https://qstash.upstash.io/v2/schedules`（列全部 → 吐出**每一個**排程的 token）
- `GET https://qstash.upstash.io/v2/schedules/{id}`（單一,也含完整 header）

只要這輸出落到任何會被保存的地方（聊天記錄、CI log、終端截圖、貼給別人），
那些 PAT 就等於外洩，必須當作已洩漏處理。**這在 2026-06-08 真的發生過**：用一個
列出全部排程的步驟「驗證」，把 `.env` 的 `GITHUB_TOKEN` 連同另一個專案共用的 PAT
一起印了出來，兩顆都得輪換。

**規則**：
1. **永遠不要**為了「檢查排程」而跑 `GET /v2/schedules`。
2. 建立排程後，只看 `POST` 回傳的 `scheduleId` 來確認成功就夠了。
3. 真要讀排程做驗證，**一定要過濾掉 header 欄位**，只取非敏感欄位：
   ```bash
   curl -s "https://qstash.upstash.io/v2/schedules/<ID>" \
     -H "Authorization: Bearer $QSTASH_TOKEN" \
   | jq '{scheduleId, cron, destination, method, body, isPaused, nextScheduleTime}'
   ```
   （`jq` 只挑安全欄位，`.header` 永遠不輸出，token 不會進到畫面/log。）

**萬一已經吐出來了**：把那顆 PAT 當作已洩漏 →
(a) 先生新 PAT；(b) **刪掉舊排程、用新 token 重建**（QStash 不能改已存的 header，
只能 delete + recreate）；(c) 排程全部重建好後，**再去 GitHub 撤銷舊 PAT**
（生新的不會讓舊的失效）。

**通則**：把任何 QStash 排程的讀取輸出當成機密。轉發 token 用最小權限的
fine-grained PAT（例如只給目標 repo 的 `Actions: write`），洩漏時影響面才最小。
