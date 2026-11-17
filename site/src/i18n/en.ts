// English copy. `{name}` is replaced with SITE.name from src/config.ts.
// Feature facts come from the project README — don't add features here that the app doesn't have.

const en = {
  langName: 'English',
  meta: {
    title: '{name} — free PostgreSQL GUI for macOS',
    description:
      '{name} is a free, open-source (MIT) PostgreSQL GUI: schema-aware SQL autocomplete, editable data grid, visual EXPLAIN, ER diagrams, live server dashboard, backup & restore. Runs locally on your Mac.',
  },
  nav: {
    screenshots: 'Screenshots',
    features: 'Features',
    install: 'Install',
    faq: 'FAQ',
    github: 'GitHub',
    theme: 'Toggle light / dark theme',
    language: 'Language',
    skip: 'Skip to content',
  },
  hero: {
    badge: 'Free & open source · {license}',
    titleLead: 'The PostgreSQL GUI',
    titleAccent: 'that stays out of your way.',
    download: 'Download for macOS',
    downloadSub: 'Apple Silicon · v{version} · .dmg',
    star: 'Star on GitHub',
    otherPlatforms: 'Intel, Windows and Linux builds are coming later.',
    fromSource: 'Run from source today',
    pgVersions: 'PostgreSQL 12–18',
  },
  screens: {
    title: 'Real screenshots, real database',
    lead: 'Every image below is the actual app connected to a demo database with 60,000 orders.',
    tabsLabel: 'Choose a screenshot',
    items: {
      editor: {
        tab: 'SQL editor',
        title: 'Autocomplete that knows your schema',
        body: 'Columns, aliases, CTEs and JOINs suggested from foreign keys. Errors are underlined exactly where they happen.',
      },
      grid: {
        tab: 'Data grid',
        title: 'Edit data like a spreadsheet, commit like a DBA',
        body: 'Changes are staged, you review the generated SQL, then everything is applied in one transaction (⌘S).',
      },
      explain: {
        tab: 'EXPLAIN',
        title: 'Query plans you can actually read',
        body: 'EXPLAIN ANALYZE as a tree with heat bars on the slowest nodes, row-estimate warnings and buffer stats.',
      },
      erd: {
        tab: 'ER diagram',
        title: 'See how everything connects',
        body: 'Auto-layout, crow’s-foot notation, foreign keys drawn to the exact columns, minimap, export to PNG / SVG.',
      },
      dashboard: {
        tab: 'Dashboard',
        title: 'A live view of your server',
        body: 'TPS, connections, cache hit ratio, locks and blocking tree, bloat estimates and slow queries.',
      },
      connection: {
        tab: 'Connections',
        title: 'Paste a URL and you’re in',
        body: 'postgres:// URLs are parsed into the form. SSL modes, color tags, groups and a read-only mode.',
      },
    },
  },
  features: {
    title: 'Everything you reach for, every day',
    lead: 'Built from scratch as a complete PostgreSQL workbench — not a thin query window.',
    items: [
      {
        icon: 'plug',
        title: 'Connection manager',
        body: 'Paste a postgres:// URL to fill the form, test before saving, SSL modes, color tags, groups and read-only connections.',
      },
      {
        icon: 'tree',
        title: 'Object explorer',
        body: 'Databases, schemas, tables, views, functions, sequences and types, with columns, indexes, constraints, triggers and partitions. Instant search and a context menu on every object.',
      },
      {
        icon: 'code',
        title: 'SQL editor',
        body: 'Schema-aware autocomplete, run the statement at the cursor, a selection or the whole script, multiple result tabs, transactions with Commit / Rollback, history and snippets.',
      },
      {
        icon: 'plan',
        title: 'Visual EXPLAIN',
        body: 'EXPLAIN and EXPLAIN ANALYZE as an interactive tree with heat bars and misestimate warnings. ANALYZE on data-changing statements is rolled back automatically.',
      },
      {
        icon: 'grid',
        title: 'Editable data grid',
        body: 'Virtual scrolling that stays smooth at 100k rows × 200 columns, filters or raw WHERE, multi-column sort, JSON / text / image viewers, export to CSV, TSV, JSON, SQL and Markdown.',
      },
      {
        icon: 'upload',
        title: 'CSV import',
        body: 'Detects delimiter and encoding (including Big5, GBK and Shift_JIS), maps columns, previews, and imports in a single transaction that points at the exact failing row.',
      },
      {
        icon: 'table',
        title: 'Table structure',
        body: 'Columns with null % and distinct stats, indexes, constraints, incoming and outgoing foreign keys, triggers, storage, privileges and full DDL. Edit, preview the SQL, apply.',
      },
      {
        icon: 'pencil',
        title: 'Table designer',
        body: 'Create tables in a column grid with type suggestions (enums and domains included), primary keys, unique, identity and foreign keys, with a live SQL preview.',
      },
      {
        icon: 'activity',
        title: 'Server dashboard',
        body: 'Live KPIs and charts, sessions with cancel / terminate, a lock and blocking tree, bloat estimates, unused and duplicate indexes, pg_stat_statements and settings.',
      },
      {
        icon: 'users',
        title: 'Roles & privileges',
        body: 'Create and edit roles and memberships, see privileges per object, GRANT / REVOKE. Passwords are hashed to SCRAM locally and never sent in plain text.',
      },
      {
        icon: 'diagram',
        title: 'ER diagrams',
        body: 'Automatic layout, foreign keys connected to the right columns, hover to highlight relations, search, minimap, remembered positions, PNG / SVG export.',
      },
      {
        icon: 'archive',
        title: 'Backup & restore',
        body: 'Finds pg_dump, pg_restore and psql and checks their versions. Custom, SQL, directory and tar formats, pick schemas or tables, live log, progress and cancel.',
      },
    ],
  },
  keyboard: {
    title: 'Keyboard-first',
    lead: 'Everything important is one shortcut away, and ⌘K finds the rest — tables, commands and connections.',
    shortcuts: [
      { keys: ['⌘', 'K'], label: 'Command palette' },
      { keys: ['⌘', '↵'], label: 'Run current statement' },
      { keys: ['⇧', '⌘', '↵'], label: 'Run whole script' },
      { keys: ['⌘', 'E'], label: 'Explain' },
      { keys: ['⇧', '⌘', 'E'], label: 'Explain Analyze' },
      { keys: ['⌘', '.'], label: 'Cancel running query' },
      { keys: ['⇧', '⌥', 'F'], label: 'Format SQL' },
      { keys: ['⌘', 'S'], label: 'Commit grid edits / save .sql' },
      { keys: ['⌘', 'T'], label: 'New query' },
      { keys: ['⌘', 'B'], label: 'Toggle sidebar' },
    ],
  },
  privacy: {
    title: 'Runs locally. Your data never leaves your machine.',
    lead: '{name} talks straight from your Mac to your database. There is no cloud service in between, no account to create and no telemetry. The only other request it makes is a once-a-day check of GitHub Releases for a newer version.',
    points: [
      { title: 'Local only', body: 'The app’s engine runs on your computer and only listens on 127.0.0.1.' },
      { title: 'Encrypted secrets', body: 'Saved passwords are encrypted with AES-256-GCM in ~/.tuplor.' },
      { title: 'Safe by default', body: 'Dangerous statements need confirmation, and connections can be marked read-only.' },
      { title: 'Open source', body: 'Every line is on GitHub under the {license} license. Read it, build it, fork it.' },
    ],
  },
  install: {
    title: 'Install in under a minute',
    steps: [
      { title: 'Download', body: 'Get the latest .dmg for Apple Silicon (M1 or newer) from GitHub Releases.' },
      { title: 'Drag to Applications', body: 'Open the .dmg and drag {name} into your Applications folder.' },
      { title: 'Launch', body: 'Open {name} from Applications or Spotlight. Releases are signed and notarized by Apple, so a normal double-click works.' },
    ],
    fallbackTitle: 'Seeing “cannot be opened”?',
    fallbackBody:
      'Only builds that are not notarized (for example ones you built yourself) trigger this. Open System Settings → Privacy & Security, scroll down and click “Open Anyway”.',
    otherTitle: 'Intel Mac, Windows or Linux?',
    otherBody:
      'Native builds for other platforms are coming later. Until then you can run {name} from source — it opens in your browser:',
    otherNote: 'Needs Node.js and npm. The app then runs at http://localhost:5555.',
    allReleases: 'All releases',
  },
  faq: {
    title: 'Frequently asked questions',
    items: [
      {
        q: 'Which PostgreSQL versions are supported?',
        a: 'PostgreSQL 12 through 18. It connects over TCP or a Unix socket (e.g. host /tmp for a local Homebrew server).',
      },
      {
        q: 'Where is my data stored?',
        a: 'Saved connections and settings live in ~/.tuplor on your Mac, with passwords encrypted (AES-256-GCM). Set the TUPLOR_HOME environment variable to use a different folder. Your connections and query data are never sent anywhere; the only outside request is a daily update check against GitHub Releases.',
      },
      {
        q: 'Is it really free?',
        a: 'Yes. {name} is open source under the {license} license. No paid tier, no account, no trial.',
      },
      {
        q: 'Does it run on Intel Macs, Windows or Linux?',
        a: 'The downloadable app is Apple Silicon only for now; other platforms are coming later. Meanwhile you can run it from source on any platform with Node.js and use it in your browser.',
      },
      {
        q: 'How do I report a bug or request a feature?',
        a: 'Open an issue on GitHub Issues. Please include the app version, your PostgreSQL version and the steps to reproduce.',
        link: 'issues',
      },
      {
        q: 'How do I build it from source?',
        a: 'Clone the repository, run npm install, then npm run app to start it in your browser, or npm run desktop:build to package the macOS app yourself.',
        code: 'git clone https://github.com/{owner}/{repo}.git\ncd {repo}\nnpm install\nnpm run app',
      },
      {
        q: 'Does it update itself?',
        a: 'Not yet. Watch the GitHub repository for releases and download the new .dmg when one comes out.',
      },
      {
        q: 'Any known limitations?',
        a: 'Tables without a primary key (or a non-null unique index) can only get new rows, not edits or deletes. The table designer supports single-column foreign keys (add multi-column ones in Table structure). The backup job list is cleared when the app restarts (the backup files stay). With an input method (e.g. Chinese), press Enter or double-click a cell before typing.',
      },
    ],
  },
  footer: {
    tagline: 'Free, open-source PostgreSQL GUI.',
    license: '{license} License',
    github: 'GitHub',
    releases: 'Releases',
    changelog: 'Changelog',
    issues: 'Report a bug',
    disclaimer: 'PostgreSQL is a trademark of the PostgreSQL Community Association of Canada. {name} is an independent project and is not affiliated with or endorsed by it.',
  },
  copy: 'Copy',
  copied: 'Copied',
};

export default en;
export type Dict = typeof en;
