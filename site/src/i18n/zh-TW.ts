// 繁體中文。`{name}` 會替換成 src/config.ts 的 SITE.name。
// 功能內容以專案 README 為準,請勿加入 App 沒有的功能。
import type { Dict } from './en';

const zhTW: Dict = {
  langName: '繁體中文',
  meta: {
    title: '{name} — 免費的 macOS PostgreSQL 管理工具',
    description:
      '{name} 是免費、開源（MIT）的 PostgreSQL 圖形化管理工具：依 schema 自動補全的 SQL 編輯器、可直接編輯的資料表格、視覺化 EXPLAIN、ER 圖、即時伺服器儀表板、備份還原。在你的 Mac 本機執行。',
  },
  nav: {
    screenshots: '截圖',
    features: '功能',
    install: '安裝',
    faq: '常見問題',
    github: 'GitHub',
    theme: '切換淺色 / 深色主題',
    language: '語言',
    skip: '跳到主要內容',
  },
  hero: {
    badge: '免費開源 · {license} 授權',
    titleLead: 'PostgreSQL 管理工具，',
    titleAccent: '好看、好用、不擋路。',
    download: '下載 macOS 版',
    downloadSub: 'Apple Silicon · v{version} · .dmg',
    star: '在 GitHub 加星',
    otherPlatforms: 'Intel、Windows、Linux 版本之後推出。',
    fromSource: '現在就從原始碼執行',
    pgVersions: 'PostgreSQL 12–18',
  },
  screens: {
    title: '真實截圖，真實資料庫',
    lead: '以下每張圖都是 App 實際連上一個含 6 萬筆訂單的範例資料庫所截取。',
    tabsLabel: '選擇截圖',
    items: {
      editor: {
        tab: 'SQL 編輯器',
        title: '懂你 schema 的自動補全',
        body: '欄位、別名、CTE，還能依外鍵產生 JOIN。錯誤直接標紅在出錯的位置。',
      },
      grid: {
        tab: '資料表格',
        title: '像試算表一樣編輯，像 DBA 一樣提交',
        body: '變更先暫存，預覽產生的 SQL，再於同一個交易內一次提交（⌘S）。',
      },
      explain: {
        tab: '執行計畫',
        title: '看得懂的執行計畫',
        body: 'EXPLAIN ANALYZE 樹狀圖，熱度條標出最慢節點，列數估計偏差警告與 Buffers 統計。',
      },
      erd: {
        tab: 'ER 圖',
        title: '一眼看清資料表關聯',
        body: '自動排版、鴉爪符號、外鍵連到對應欄位、小地圖，可匯出 PNG / SVG。',
      },
      dashboard: {
        tab: '儀表板',
        title: '伺服器即時狀態',
        body: 'TPS、連線數、快取命中率、鎖與阻塞樹、膨脹估計與慢查詢。',
      },
      connection: {
        tab: '連線',
        title: '貼上 URL 就能連線',
        body: '自動解析 postgres:// URL。支援 SSL 模式、顏色標籤、群組與唯讀模式。',
      },
    },
  },
  features: {
    title: '每天會用到的，全都有',
    lead: '從零打造的完整 PostgreSQL 工作台，不只是一個查詢視窗。',
    items: [
      {
        icon: 'plug',
        title: '連線管理',
        body: '貼上 postgres:// URL 自動填表、儲存前測試連線、SSL 模式、顏色標籤、群組與唯讀連線。',
      },
      {
        icon: 'tree',
        title: '物件瀏覽器',
        body: '資料庫、schema、表、view、function、sequence、type，表可展開欄位、索引、約束、觸發器、分割。搜尋即時展開，每種物件都有右鍵選單。',
      },
      {
        icon: 'code',
        title: 'SQL 編輯器',
        body: '依 schema 自動補全；執行游標所在語句、選取範圍或整份腳本；多結果分頁；交易狀態與 Commit / Rollback；歷史紀錄與常用片段。',
      },
      {
        icon: 'plan',
        title: '視覺化執行計畫',
        body: 'EXPLAIN / EXPLAIN ANALYZE 互動式樹狀圖、熱度條、估計偏差警告。會修改資料的語句做 ANALYZE 時自動回滾。',
      },
      {
        icon: 'grid',
        title: '可編輯的資料表格',
        body: '虛擬捲動，10 萬列、200 欄依然流暢；篩選器或原生 WHERE、多欄排序、JSON / 長文字 / 圖片檢視器，匯出 CSV、TSV、JSON、SQL、Markdown。',
      },
      {
        icon: 'upload',
        title: 'CSV 匯入',
        body: '自動偵測分隔符號與編碼（含 Big5、GBK、Shift_JIS）、欄位對應、預覽，整批在一個交易內完成，出錯精準指出第幾列。',
      },
      {
        icon: 'table',
        title: '表結構',
        body: '欄位（含 null% / 相異值統計）、索引、約束、進出外鍵、觸發器、儲存統計、權限與完整 DDL。編輯 → 預覽 SQL → 套用。',
      },
      {
        icon: 'pencil',
        title: '建表設計器',
        body: '用欄位表格建表，型別建議（含 enum / domain）、主鍵、唯一、identity、外鍵，即時 SQL 預覽。',
      },
      {
        icon: 'activity',
        title: '伺服器儀表板',
        body: '即時 KPI 與圖表、連線活動（取消 / 終止）、鎖與阻塞樹、膨脹估計、未使用與重複索引、pg_stat_statements 與參數設定。',
      },
      {
        icon: 'users',
        title: '角色與權限',
        body: '建立 / 編輯角色與成員關係、各物件權限總覽、GRANT / REVOKE。密碼在本機轉成 SCRAM 雜湊，明文不會送出。',
      },
      {
        icon: 'diagram',
        title: 'ER 圖',
        body: '自動排版、外鍵連到對應欄位、滑過高亮關聯、搜尋、小地圖、記住拖曳位置，匯出 PNG / SVG。',
      },
      {
        icon: 'archive',
        title: '備份 / 還原',
        body: '自動找到 pg_dump、pg_restore、psql 並檢查版本；Custom、SQL、Directory、Tar 格式；可選 schema / 表；即時日誌、進度、可取消。',
      },
    ],
  },
  keyboard: {
    title: '鍵盤優先',
    lead: '常用操作都只差一個快捷鍵，其他的交給 ⌘K —— 表、指令、連線一搜就到。',
    shortcuts: [
      { keys: ['⌘', 'K'], label: '指令面板' },
      { keys: ['⌘', '↵'], label: '執行目前語句' },
      { keys: ['⇧', '⌘', '↵'], label: '執行整份腳本' },
      { keys: ['⌘', 'E'], label: 'Explain' },
      { keys: ['⇧', '⌘', 'E'], label: 'Explain Analyze' },
      { keys: ['⌘', '.'], label: '取消執行中的查詢' },
      { keys: ['⇧', '⌥', 'F'], label: '格式化 SQL' },
      { keys: ['⌘', 'S'], label: '提交表格編輯 / 存成 .sql' },
      { keys: ['⌘', 'T'], label: '新查詢' },
      { keys: ['⌘', 'B'], label: '切換側邊欄' },
    ],
  },
  privacy: {
    title: '本機執行，資料不出你的電腦。',
    lead: '{name} 直接從你的 Mac 連到你的資料庫，中間沒有任何雲端服務，不用註冊帳號，也沒有遙測。',
    points: [
      { title: '只在本機', body: 'App 的引擎在你的電腦上執行，只監聽 127.0.0.1。' },
      { title: '密碼加密', body: '儲存的密碼以 AES-256-GCM 加密，存放在 ~/.pgstudio。' },
      { title: '預設安全', body: '危險語句需要確認，連線也可以設為唯讀。' },
      { title: '完全開源', body: '所有程式碼都在 GitHub，以 {license} 授權。歡迎閱讀、自行建置或 fork。' },
    ],
  },
  install: {
    title: '一分鐘內完成安裝',
    steps: [
      { title: '下載', body: '從 GitHub Releases 下載最新的 Apple Silicon（M1 以上）.dmg。' },
      { title: '拖到「應用程式」', body: '打開 .dmg，把 {name} 拖進「應用程式」資料夾。' },
      { title: '開啟', body: '從「應用程式」或 Spotlight 開啟 {name}。正式版本已經過 Apple 簽章與公證，直接雙擊即可。' },
    ],
    fallbackTitle: '出現「無法打開」?',
    fallbackBody:
      '只有未經公證的版本（例如自己建置的）才會出現。請打開「系統設定」→「隱私權與安全性」，捲到下方按「強制打開」。',
    otherTitle: 'Intel Mac、Windows 或 Linux?',
    otherBody: '其他平台的版本之後推出。在那之前，可以從原始碼執行 {name}，會在瀏覽器中開啟：',
    otherNote: '需要 Node.js 與 npm。啟動後開啟 http://localhost:5555。',
    allReleases: '所有版本',
  },
  faq: {
    title: '常見問題',
    items: [
      {
        q: '支援哪些 PostgreSQL 版本?',
        a: 'PostgreSQL 12 到 18。可用 TCP 或 Unix socket 連線（例如本機 Homebrew 的 PostgreSQL,Host 填 /tmp）。',
      },
      {
        q: '我的資料存在哪裡?',
        a: '儲存的連線與設定放在你 Mac 上的 ~/.pgstudio，密碼以 AES-256-GCM 加密。可用環境變數 PGSTUDIO_HOME 改到其他資料夾。不會傳送任何資料到第三方伺服器。',
      },
      {
        q: '真的免費嗎?',
        a: '是的。{name} 以 {license} 授權開源，沒有付費版、不用帳號、沒有試用期限。',
      },
      {
        q: '可以在 Intel Mac、Windows 或 Linux 上使用嗎?',
        a: '目前可下載的 App 只支援 Apple Silicon，其他平台之後推出。在那之前，任何裝了 Node.js 的平台都可以從原始碼執行，用瀏覽器操作。',
      },
      {
        q: '要怎麼回報問題或建議功能?',
        a: '請到 GitHub Issues 開一個 issue，附上 App 版本、PostgreSQL 版本與重現步驟。',
        link: 'issues',
      },
      {
        q: '如何從原始碼建置?',
        a: 'clone 專案後執行 npm install，再用 npm run app 在瀏覽器中啟動；或用 npm run desktop:build 自行打包 macOS App。',
        code: 'git clone https://github.com/{owner}/{repo}.git\ncd {repo}\nnpm install\nnpm run app',
      },
      {
        q: '會自動更新嗎?',
        a: '目前還不會。可以在 GitHub 上 Watch 這個專案的 Releases，有新版時再下載新的 .dmg。',
      },
      {
        q: '有哪些已知限制?',
        a: '沒有主鍵（也沒有非空唯一索引）的表格只能新增列，不能編輯或刪除既有列。建表設計器的外鍵只支援單欄，多欄外鍵請到「表結構」頁新增。備份工作列表在 App 重啟後清空（備份檔本身會保留）。使用中文等輸入法時，要先按 Enter 或雙擊儲存格才能開始輸入。',
      },
    ],
  },
  footer: {
    tagline: '免費、開源的 PostgreSQL 管理工具。',
    license: '{license} 授權',
    github: 'GitHub',
    releases: '下載版本',
    changelog: '更新紀錄',
    issues: '回報問題',
    disclaimer: 'PostgreSQL 是 PostgreSQL Community Association of Canada 的商標。{name} 為獨立專案，與其無隸屬或背書關係。',
  },
  copy: '複製',
  copied: '已複製',
};

export default zhTW;
