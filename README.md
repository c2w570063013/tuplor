# Tuplor

**免費、介面優美、功能完整的 PostgreSQL 管理工具。** 從零打造,本機執行,資料不出你的電腦。

支援 PostgreSQL 12–18,可用瀏覽器或 macOS 桌面 App 開啟,深色 / 淺色主題皆有。

---

## 快速開始

```bash
npm install
```

**方式一:一鍵啟動(自動開瀏覽器)**

```bash
npm run app
```

開啟 http://localhost:5555 。

**方式二:macOS 桌面 App**

```bash
npm run desktop:build
```

產物在 `desktop/release/`:`Tuplor.app` 與 `Tuplor-0.1.0-arm64.dmg`。
自己打包的版本沒有經過 Apple 公證:第一次開啟被擋下時,到 **系統設定 → 隱私權與安全性**,捲到下方按 **強制打開**。

**開發模式(熱重載)**

```bash
npm run dev
```

UI 在 http://localhost:5173,API 在 :5555。

### 範例資料庫

```bash
createdb tuplor_demo && psql -d tuplor_demo -f scripts/demo.sql
```

包含 `shop` / `analytics` / `public` 三個 schema:enum、domain、jsonb、陣列、bytea、分割表、view、materialized view、function、procedure、trigger、6 萬筆訂單。
本機 Homebrew 的 PostgreSQL 可用 Unix socket 連線:Host 填 `/tmp`,使用者填系統帳號,不用密碼。

---

## 功能一覽

| 模組 | 內容 |
|---|---|
| **連線管理** | 貼上 `postgres://` URL 自動解析、測試連線、SSL 模式、顏色標籤、群組、唯讀模式;密碼以 AES-256-GCM 加密存在 `~/.tuplor` |
| **物件瀏覽器** | 連線 → 資料庫 → schema → 表 / view / function / sequence / type;表可展開欄位、索引、約束、觸發器、分割;搜尋即時展開;每種物件都有右鍵選單(產生 SQL、重新命名、刪除、清空、VACUUM/ANALYZE、建立物件、安裝擴充) |
| **SQL 編輯器** | Monaco 編輯器;**依 schema 自動補全**(含別名 `o.`、CTE、依外鍵產生 JOIN);執行游標所在語句 / 選取 / 整份腳本;錯誤直接標紅在出錯位置;多結果分頁;交易狀態 + Commit/Rollback;歷史紀錄與常用片段;危險語句確認;開啟 / 儲存 .sql |
| **執行計畫** | EXPLAIN / EXPLAIN ANALYZE 視覺化樹狀圖,熱度條標出最慢節點、列數估計偏差警告、Buffers;ANALYZE 修改資料的語句會自動回滾 |
| **資料表格** | 虛擬捲動(10 萬列、200 欄依然流暢);篩選器 + 原生 WHERE;多欄排序;**直接編輯**(暫存變更 → 預覽 SQL → 一次交易提交,⌘S);新增 / 複製 / 刪除列;JSON / 長文字 / 圖片檢視器;匯出 CSV / TSV / JSON / SQL / Markdown |
| **CSV 匯入** | 自動偵測分隔符號與編碼(含 Big5、GBK、Shift_JIS)、欄位對應、預覽、進度條,整批在一個交易內,出錯精準指出第幾列 |
| **表結構** | 欄位(含 null% / 相異值統計)、索引、約束、外鍵(進 / 出)、觸發器、分割、儲存統計、權限、完整 DDL;編輯模式 → 預覽 SQL → 套用 |
| **建表設計器** | 欄位表格、型別建議(含 enum/domain)、主鍵、唯一、identity、外鍵、即時 SQL 預覽 |
| **伺服器儀表板** | 即時 KPI 與圖表(TPS、連線、快取命中率、元組、讀取 vs 命中);連線活動(取消 / 終止);**鎖與阻塞樹**;表 / 索引統計(膨脹估計、未使用與重複索引);pg_stat_statements 慢查詢;參數設定;資料庫管理 |
| **角色與權限** | 角色列表、建立 / 編輯、成員關係、各物件權限總覽、GRANT/REVOKE;密碼在本機轉成 SCRAM 雜湊,明文不會送到伺服器或日誌 |
| **ER 圖** | 自動排版、外鍵連到對應欄位、鴉爪符號、滑過高亮關聯、搜尋、小地圖、拖曳位置會記住、匯出 PNG / SVG |
| **備份 / 還原** | 自動找 pg_dump / pg_restore / psql 並檢查版本;Custom / SQL / Directory / Tar 格式;可選 schema / 表;即時日誌、進度、可取消;還原到既有或新資料庫 |

## 常用快捷鍵

| 快捷鍵 | 動作 |
|---|---|
| ⌘K | 指令面板(搜尋表、指令、連線) |
| ⌘↵ / ⇧⌘↵ | 執行目前語句 / 整份腳本 |
| ⌘E / ⇧⌘E | Explain / Explain Analyze |
| ⌘. | 取消執行中的查詢 |
| ⇧⌥F | 格式化 SQL |
| ⌘S | 提交表格編輯(表格分頁)/ 存成 .sql(編輯器) |
| Alt N | 新查詢(桌面 App:⌘T) |
| ⌘B | 切換側邊欄 |

## 架構

```
server/   Node + Fastify + pg     連線池、每個編輯器分頁一個持久 session、查詢引擎、各模組 API
web/      React 19 + Vite + Tailwind v4 + Monaco + TanStack + Radix + React Flow + Recharts
shared/   前後端共用型別
desktop/  Electron 外殼(打包 .app / .dmg)
```

詳見 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。資料目錄:`~/.tuplor`(可用 `TUPLOR_HOME` 覆寫)。

## 已知限制

- 桌面 App 目前只打包 Apple Silicon (arm64),未經 Apple 公證,沒有自動更新。
- 沒有主鍵(也沒有非空唯一索引)的表格只能新增列,不能編輯或刪除既有列。
- 建表設計器的外鍵只支援單欄,多欄外鍵請到「表結構」頁新增。
- 備份工作列表存在伺服器記憶體,重啟後清空(備份檔本身會保留)。
- 中文等輸入法:要先按 Enter 或雙擊儲存格才能開始輸入。
