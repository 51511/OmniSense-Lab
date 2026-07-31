<!--
  OmniSense Lab — 專案說明（作者：小威老師 · 授權見 LICENSE）
-->

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
- **自製專案（卡帶）**：Shell 以動態 `import()` 載入 **https（或本機 http）上的 ES module**，或使用 **匯入本地端 JS 檔**（單一 `.js`、無需 CORS）；教師可將模組託管於 GitHub Pages、Lovable 匯出站等，並搭配 [docs/CUSTOM_MODULE.md](docs/CUSTOM_MODULE.md) 與 AI 提示詞產生教案。
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
| [docs/CUSTOM_MODULE.md](docs/CUSTOM_MODULE.md) | **自製專案（外部卡帶）**：網址載入、本機 JS、CORS、事件介面、給 AI 的提示詞範例 |
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
2. 在 OmniSense Lab 的 **「自製專案」**貼上該模組的完整 URL，或使用 **匯入本地端 JS 檔** 即可執行；適合搭配 Lovable 等工具，並將 `PROTOCOL.md` + `CUSTOM_MODULE.md` 一併餵給 AI 以產生量測儀表等互動教材。

## 授權

見根目錄 **[LICENSE](LICENSE)**。商業利用請依授權條款另行取得授權。

https://blackdogii.github.io/OmniSense-Lab/web/index.html