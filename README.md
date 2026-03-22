# eClass 自動播放助手 — Chrome Extension

自動播放 [eclass.yuntech.edu.tw](https://eclass.yuntech.edu.tw) 課程影片的 Chrome 擴充功能。

## 功能特色

- 🎬 自動尋找並播放未完成的課程影片
- ⚡ 支援自訂播放速度（1x – 4x）
- 📄 自動翻頁，掃描所有課程頁面
- 🔒 自動跳過已完成或鎖定的影片
- 📺 支援 eClass 原生播放器（Video.js / MVP）與 YouTube 嵌入影片
- 🔁 頁面重載後自動繼續
- 🛑 提供停止按鈕，隨時中斷

---

## 安裝方法（開發者模式）

1. 下載或 Clone 此專案至本機資料夾（例如 `eclass_video_autoplay_extension`）。
2. 開啟 Chrome，在網址列輸入：
   ```
   chrome://extensions/
   ```
3. 開啟右上角的「**開發者模式**」開關。
4. 點擊「**載入未封裝項目**」，選擇 `eclass_video_autoplay_extension` 資料夾。
5. 擴充功能圖示會出現在 Chrome 工具列。

---

## 使用方法

1. **登入 eClass**，進入課程的 Courseware 頁面（URL 形如 `https://eclass.yuntech.edu.tw/course/<id>/courseware#/`）。
2. 點擊工具列中的擴充功能圖示，開啟 Popup。
3. 調整 **播放速度**（預設 2.0x）。
4. 點擊「**開始自動播放**」。
5. 擴充功能會自動：
   - 掃描頁面上的未完成影片
   - 點擊並播放影片
   - 顯示進度日誌
   - 翻頁繼續尋找
   - 所有影片完成後顯示「所有課程已完成」
6. 若需中斷，點擊「**停止**」按鈕。

---

## 檔案結構

```
eclass_video_autoplay_extension/
├── manifest.json       # MV3 擴充功能設定
├── background.js       # Service Worker（訊息中繼）
├── content.js          # 主要自動化邏輯（注入頁面）
├── popup.html          # 擴充功能 Popup UI
├── popup.css           # Popup 樣式
├── popup.js            # Popup 邏輯
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## 注意事項

- **YouTube 跨域限制**：YouTube iframe 受瀏覽器同源限制，擴充功能使用 `postMessage` / YouTube IFrame API 控制播放。若 eClass 的 YouTube 嵌入未啟用 `enablejsapi=1`，腳本會自動加入此參數並重載 iframe。
- 擴充功能僅在 `eclass.yuntech.edu.tw` 域名下啟用。
- 若播放速度在播放中被重置，腳本每 5 秒會自動重新套用。
- 建議使用前確認已登入 eClass，否則無法正常工作。

---

## 除錯

開啟 Chrome DevTools（`F12`）→「Console」分頁，可看到所有 `[eClass AutoPlay]` 標記的日誌訊息。
