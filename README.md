# CWMS Watch｜五縣市放流水監控

每 30 分鐘自動檢查 **台中、彰化、雲林、苗栗、南投** 的 CWMS（水質水量自動監測連線傳輸）公開即時監測資料，整理成一個網頁，並在特定狀況發 Discord 通知。

- 網頁：GitHub Pages（純靜態，`index.html`）
- 背景監控：GitHub Actions 排程（`.github/workflows/monitor.yml`），結果寫回 `data/*.json`
- 不需要伺服器、不需要資料庫、不需要安裝任何套件

## 通知規則

| 狀況 | Discord | 網頁 |
|---|---|---|
| 校正值、單元故障 | ✅ | ✅ |
| No data（查無監測資料） | ✅ | ✅ |
| 監測時間落後目前時間超過 3 小時 | ✅ | ✅ |
| 超限值、無效值 | – | ✅ |
| 來源網站讀取失敗 | – | ✅ |

同一個狀況只通知一次，狀況解除時會發一則「已恢復」。

## 第一次設定（約 5 分鐘）

1. **建立 repo**：在 GitHub（例如 `cwms-team` 組織）建立一個 **Public** repo，名稱建議 `cwms-watch`，把這個資料夾的所有檔案上傳（包含 `.github` 資料夾）。
   > 網頁上「Add file → Upload files」拖曳時，`.github` 這種點開頭的資料夾可能會被略過。若上傳後看不到 `.github/workflows/monitor.yml`，請用「Add file → Create new file」，檔名輸入 `.github/workflows/monitor.yml`，把內容貼上。
2. **設定 Discord**：repo → Settings → Secrets and variables → Actions → New repository secret
   名稱 `DISCORD_WEBHOOK_URL`，值貼上 Discord 頻道的 Webhook 網址。（不設也可以，只是不會發通知。）
3. **允許 Actions 寫入**：Settings → Actions → General → Workflow permissions → 選 **Read and write permissions** → Save。
4. **開啟網頁**：Settings → Pages → Source 選 **Deploy from a branch**，Branch 選 `main` / `(root)` → Save。
   幾分鐘後網址會是 `https://<帳號或組織>.github.io/cwms-watch/`。
5. **跑第一次**：Actions → CWMS 監控 → Run workflow。完成後網頁就會有資料，之後每 30 分鐘自動執行。

## 修改監控名單

打開網頁最下方「監控設定」，勾選要監控的業者 → 按 **在 GitHub 更新**（會自動複製新名單並開啟 GitHub 編輯頁）→ 全選貼上 → Commit changes。
存檔後系統會立刻用新名單跑一次。也可以直接編輯 `config/watchlist.json`。

## 檔案說明

```
index.html                     網頁
config/watchlist.json          要監控的業者（管制編號，依縣市分組）
data/catalog.json              各縣市公開頁上的全部業者（每次執行自動更新）
data/status.json               最新監控結果（自動產生）
data/runs.json                 最近 96 次執行紀錄（自動產生）
data/notify-state.json         已通知過的狀況，用來避免重複通知（自動產生）
scripts/check.mjs              監控主程式
scripts/cwms-source.mjs        讀取縣市 CWMS 公開頁（含自動翻頁）
scripts/regions.mjs            五縣市來源網址
.github/workflows/monitor.yml  排程設定
```

## 常見問題

- **網頁顯示「背景監控可能停止了」**：到 Actions 頁看最近一次是否失敗。GitHub 若因 repo 長時間沒有活動而暫停排程，會在 Actions 頁上方顯示提示，按啟用即可。
- **某縣市一直「來源讀取失敗」**：可能是該縣市網站維護，或擋了 GitHub（海外）的連線。若長期如此，可以改用公司電腦當 self-hosted runner：Settings → Actions → Runners → New self-hosted runner，照步驟安裝後把 `monitor.yml` 的 `runs-on: ubuntu-latest` 改成 `runs-on: self-hosted`。
- **想改延遲門檻**：修改 `monitor.yml` 裡的 `DELAY_MINUTES`（分鐘）。
- **本機測試**：安裝 Node.js 20 以上，執行 `node scripts/check.mjs`。

資料來源為各縣市環保局 CWMS 公開即時監測頁；實際數值與狀態以原始系統為準。
