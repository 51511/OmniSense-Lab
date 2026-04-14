<!--
  OmniSense Lab — 專案說明（作者：小威老師 · 授權見 LICENSE）
-->

# 使用 AI 自製專案（置頂詳細教學）

以下步驟可讓您用生成式 AI 產出 **單一 `.js` 模組**，再於 OmniSense Lab 的 **「自製專案」** 以 **匯入本地端 JS 檔** 執行（無須改韌體）。完整規格仍以 [docs/CUSTOM_MODULE.md](docs/CUSTOM_MODULE.md) 為準。

1. **下載檔案**  
   - ：[docs/CUSTOM_MODULE.md](docs/CUSTOM_MODULE.md)
   - ：[docs/PROTOCOL.md](docs/PROTOCOL.md)- ：[docs/WIRING_GUIDE.md](docs/WIRING_GUIDE.md)  


2. **複製以下提示詞**  
   ```
   請在單一 JavaScript 檔案中，實作 OmniSense Lab 的「外部實驗模組」（ES module），並遵守下列約束：

   - 必須 export：async function mount(root) — 在 root 內建立 UI；不可只 export init 而沒有 mount。
   - 建議 export：async function cleanup() 或 unmount()，並在內部移除對 omnisense:data 的監聽、停止動畫等。
   - 僅透過 window.addEventListener('omnisense:data', …) 讀取 event.detail（含 channels、mask 等）；語意與數值定義必須符合我一併提供的 PROTOCOL.md；邏輯通道與腳位對照依 WIRING_GUIDE.md。
   - 不要在模組內使用 Web Bluetooth API；不要 import 本專案儲庫內的相對路徑 web/core/...。
   - 請只輸出完整可執行的單一 .js 檔案內容，不要省略，並在開頭簡短註解說明此實驗用途。
   ```

3. **將第 1～2 步交給生成式 AI 並取得 `.js` 檔**  
   開啟 **Gemini**、**ChatGPT**、...等生成式 AI，在對話中：  
   - 先貼上第 1 步的文件
   - 再貼上第 2 步的提示詞
   - 最後補充您想要的專案設計（例如：即時波形、計數器、簡易儀表、互動遊戲...）越詳細越好。(也可先請AI生成，再修改)。
   請 AI **只產出單一** `.js` 檔（ES module）。將回覆中的程式碼存成 **一個** `.js` 檔，放在本機（電腦或手機上瀏覽器可選取的位置，例如「下載」資料夾）。
   **注意**：自製專案「匯入本地端 JS 檔」模式適合 **無額外相對路徑 `import` 其它檔案** 的單檔模組；若需多檔或套件，請改為將模組託管在 **HTTPS** 網址，並在 Lab 內改以 **貼上網址** 載入（見 [CUSTOM_MODULE.md](docs/CUSTOM_MODULE.md)）。

4. **在 OmniSense Lab 中載入**  
   使用 **Chrome／Edge** 等支援 Web Bluetooth 的瀏覽器，依下方 [Web 使用方式](#web-使用方式) 開啟本專案頁面（**HTTPS** 或 **localhost**）。進入 **「自製專案」** 分頁後，可依需求擇一：  
   - **匯入本地端 JS 檔**：適合單一 `.js` 模組（不依賴同資料夾素材）。  
   - **匯入本地資料夾（含素材）**：適合 `app.js` / `index.js` 搭配同資料夾 `png/mp3` 等相對路徑資源。  
   與官方實驗相同：請先在 **主控台** 完成與 ESP32 的 **Web Bluetooth** 連線，資料才會透過 `omnisense:data` 傳入您的模組。

---

# OmniSense Lab

## 專案目標

在**一般教室**即可操作：師生以手機／平板／筆電透過 **Web Bluetooth** 連線 **ESP32-C3** 底座，進行多通道感測、波形與插件式實驗（主控台、電子琴、魔法弓箭等），無須專用實驗室軟體。介面分為 **主控台**、**實驗專案**（官方卡帶）與 **自製專案**（教師貼上模組網址或匯入本機 JS），教材可在**不改韌體**的前提下擴充。

## 儲存庫結構（插件式）

```
OmniSense-Lab/
├── firmware/OmniSense_Main/   # Arduino 韌體（穩定版；協定見 docs/PROTOCOL.md）
├── web/                       # PWA 殼層：index.html、shell.js、core/（BLE／解包／事件）
├── experiments/               # 實驗插件：各子資料夾一實驗 + app.js
├── projects.json              # 實驗選單索引（與 web/projects.json 同步）
├── docs/                      # PRD、PROTOCOL、CUSTOM_MODULE、WIRING、VERSIONING
├── index.html                 # 導向 web/index.html
└── LICENSE
```

- **核心與實驗解耦**：`web/core/` 負責連線與 `omnisense:data` 事件；實驗僅實作 `mount` / `unmount` / 可選 `onConnected`。
- **自製專案（卡帶）**：Shell 以動態 `import()` 載入 **https（或本機 http）上的 ES module**，或使用 **匯入本地端 JS 檔**（單一 `.js`、無需 CORS），或使用 **匯入本地資料夾（含素材）**（支援同資料夾相對路徑圖片/音樂）；教師可將模組託管於 GitHub Pages、Lovable 匯出站等，並搭配 [docs/CUSTOM_MODULE.md](docs/CUSTOM_MODULE.md) 與 AI 提示詞產生教案。
- **韌體**：請於 Arduino IDE 開啟 **`firmware/OmniSense_Main/OmniSense_Main.ino`**（若根目錄仍有舊資料夾 `OmniSense_Main`，請改以 `firmware/` 下為準並刪除重複）。

## Web 使用方式

1. 使用 **Chrome／Edge** 等支援 Web Bluetooth 的瀏覽器，頁面須在 **HTTPS** 或 **localhost**。
2. 建議在**專案根目錄**啟動靜態伺服器後開啟 **`http://localhost:埠/web/index.html`**（根目錄 `index.html` 會轉址）。

```bash
python -m http.server 8080
# 瀏覽器開啟 http://localhost:8080/web/index.html
```

## 文件

| 檔案 | 說明 |
|------|------|
| [docs/PRD.md](docs/PRD.md) | 需求與願景 |
| [docs/PROTOCOL.md](docs/PROTOCOL.md) | BLE 指令、封包、觸控數值定義 |
| [docs/CUSTOM_MODULE.md](docs/CUSTOM_MODULE.md) | **自製專案（外部卡帶）**：網址載入、本機 JS／本機資料夾（含素材）、CORS、事件介面、給 AI 的提示詞範例 |
| [docs/WIRING_GUIDE.md](docs/WIRING_GUIDE.md) | 腳位與接線建議 |
| [docs/VERSIONING.md](docs/VERSIONING.md) | 版本號與同步方式 |

## 新增實驗（擴充流程）

### 官方卡帶（收入本儲庫）

1. 在 `experiments/` 建立新資料夾（例如 `gravity-car/`）。
2. 新增 `app.js`，匯出 `mount(root)`、`unmount()`，可選 `onConnected()`；可選 `config.json` 覆寫標題等（見 `web/shell.js`）。
3. 在 **`projects.json` 與 `web/projects.json`** 各新增一筆實驗描述（兩者內容一致）。
4. 不必修改 `web/core/` 或韌體（除非協定或硬體能力變更）。

### 教師／第三方自託管（不併入儲庫）

1. 依 [docs/CUSTOM_MODULE.md](docs/CUSTOM_MODULE.md) 實作單一（或少量）ES module，並部署到 **HTTPS**（開發可用 **localhost**）。
2. 在 OmniSense Lab 的 **「自製專案」**貼上該模組的完整 URL，或使用 **匯入本地端 JS 檔**（單檔），或使用 **匯入本地資料夾（含素材）**（多檔與相對路徑素材）即可執行；適合搭配 Lovable 等工具，並將 `PROTOCOL.md` + `CUSTOM_MODULE.md` 一併餵給 AI 以產生量測儀表等互動教材。

## 授權

見根目錄 **[LICENSE](LICENSE)**。商業利用請依授權條款另行取得授權。
