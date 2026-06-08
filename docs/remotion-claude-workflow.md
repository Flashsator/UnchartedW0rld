# 用 Claude Code 高效開發 Remotion（本專案實況）

> 這份筆記回答一個問題：「用 Remotion 的 Claude Code toolkit 有幫助嗎？」
> 結論先講：**真正有用的部分你其實已經有了**，而且對這個 repo 來說，
> 它幫得上的是「視覺/合成」那一半，幫不上「資料/pipeline」那一半。

## 不存在一個你缺的神奇官方 toolkit

真正有幫助的只有三樣，其中兩樣你已經有了：

1. **`remotion-best-practices` 技能** — 已經在你的 ECC bundle 裡。
   這才是真正的「toolkit」：合成（composition）模式、`useCurrentFrame`/
   `interpolate` 慣用法、效能陷阱、確定性渲染（deterministic render）規則。
   **正確做法是：每次動到 `remotion/` 時就載入它**（例如數字滾動動畫、
   `OverlayLayer` 等）。

2. **Remotion Studio**（`npm run studio`）— 已經接好了。
   這是讓 Claude 寫的 composition 能被**肉眼驗證**、而不是用猜的地方。
   目前開發迴圈的真正弱點是：改了 `remotion/*.tsx` 卻看不到結果。
   Studio ＋ 截圖能補上這個缺口。

3. **單格截圖驗證（frame screenshot）** — 無頭渲染某一格再截圖，
   讓 composition 的改動是「被確認」而不是「被假設」。
   現有的 `verify` / `/run` 技能就能做到。

## 幫很大 vs. 幾乎沒幫助

| 任務 | toolkit 幫助程度 |
|------|------------------|
| 新的螢幕疊加 / 動畫 / 場景 | 🔥🔥🔥 best-practices 技能 ＋ Studio 預覽省下大量來回 |
| 版面 / 時間軸 / 視覺微調 | 🔥🔥 你必須「看到」它，截圖迴圈很重要 |
| pipeline 接線（scriptGen、stock、mux、analytics） | ❄️ 與 Remotion toolkit 無關，那是純 Node/TS |

所以：它幫得上的是 repo 的**視覺/合成**那一半，幫不上**資料/pipeline**那一半
（也就是我們最近在做的：analytics、BGM、b-roll 選取）。

## 建議做法

別去裝什麼新的外部東西。改用兩個低成本升級：

1. **下次只要動到任何 `remotion/` composition，就自動載入
   `remotion-best-practices` 技能** — 這就是 toolkit 真正的價值，免費。

2. **加一個單格截圖驗證步驟**，讓視覺改動能被確認。
   可以接一個小的 `npm run frame`（把第 N 格渲染成 PNG），
   這樣改動畫時兩邊都不用瞎猜。

> 依「不要動現在能跑的東西」原則：**這個 `frame` 截圖工具等到下次真的做
> 視覺工作時再加**比較好；現在就加屬於投機（YAGNI）。

## 一句話總結

對這個 repo，「Remotion toolkit」不是要你安裝新工具，而是
**改視覺時記得載入既有的 Remotion 技能 ＋ 用 Studio/截圖把結果看出來**。
pipeline 那半邊照常用一般 Node/TS 流程即可。
