import '@/lib/monaco';
import { Editor, type OnMount } from '@monaco-editor/react';
import {
  AlignLeft, Bookmark, BookmarkPlus, Check, ChevronDown, CircleDot, Database, FileDown, FileUp, History, Lock, MoreHorizontal, Play,
  RefreshCw, RotateCcw, Square, WrapText, Workflow, ListChecks, ScrollText, TextCursorInput, AArrowUp, AArrowDown,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Group, Panel, Separator, usePanelRef } from 'react-resizable-panels';
import type { QueryResponse, TxStatus } from '@shared/types';
import { Badge, Button, DropdownMenu, IconButton, Spinner, Switch, Tooltip, ToolbarDivider, toast, type MenuItem } from '@/components/ui';
import { downloadText } from '@/components/grid';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { modKey, uid } from '@/lib/format';
import { monaco, monacoTheme, PG_LANG } from '@/lib/monaco';
import { invalidateDb } from '@/lib/queryClient';
import { useConnections } from '@/stores/connections';
import { confirm, prompt } from '@/stores/dialogs';
import { useResolvedTheme, useSettings } from '@/stores/settings';
import { useWorkspace } from '@/stores/workspace';
import { registerCommands } from '@/shell/commands';
import { parseExplain } from '@/features/explain/plan';
import { defaultExplainOptions, runExplain, explainSql, stripExplain, type ExplainOptions } from '@/features/explain/runExplain';
import type { TabProps } from '../common/TabProps';
import { loadCatalog, useCatalogEntry } from './catalog';
import { bindModel, registerSqlProviders, unbindModel } from './completion';
import { recordHistory, watchEditorSessions } from './editorApi';
import { Elapsed, Results, type ExplainState, type RunOutcome } from './Results';
import { saveSnippetFlow, SidePanel, type SidePanelKind } from './SidePanel';
import { findDangerous, isDataModifying, isDdl, splitStatements, statementAt } from './sqlText';

registerSqlProviders();
watchEditorSessions();

type Ed = Parameters<OnMount>[0];
type RunMode = 'statement' | 'script';

/** Imperative handles of mounted editors (for command palette entries). */
const handles = new Map<string, Record<string, () => void>>();
const activeHandle = (name: string) => () => {
  const id = useWorkspace.getState().activeTabId;
  if (id) handles.get(id)?.[name]?.();
};
const isSqlActive = () => {
  const s = useWorkspace.getState();
  return s.tabs.find((t) => t.id === s.activeTabId)?.kind === 'sql';
};
registerCommands([
  { id: 'sql.run', title: 'Run statement at cursor', group: 'SQL Editor', shortcut: `${modKey}↵`, when: isSqlActive, run: activeHandle('runStatement') },
  { id: 'sql.runScript', title: 'Run whole script', group: 'SQL Editor', shortcut: `⇧${modKey}↵`, when: isSqlActive, run: activeHandle('runScript') },
  { id: 'sql.explain', title: 'Explain statement', group: 'SQL Editor', shortcut: `${modKey}E`, when: isSqlActive, run: activeHandle('explain') },
  { id: 'sql.explainAnalyze', title: 'Explain analyze statement', group: 'SQL Editor', shortcut: `⇧${modKey}E`, when: isSqlActive, run: activeHandle('explainAnalyze') },
  { id: 'sql.format', title: 'Format SQL', group: 'SQL Editor', shortcut: '⇧⌥F', when: isSqlActive, run: activeHandle('format') },
  { id: 'sql.history', title: 'Show query history', group: 'SQL Editor', keywords: ['recent', 'log'], when: isSqlActive, run: activeHandle('history') },
  { id: 'sql.snippets', title: 'Show saved snippets', group: 'SQL Editor', keywords: ['favorites'], when: isSqlActive, run: activeHandle('snippets') },
  { id: 'sql.saveSnippet', title: 'Save query as snippet', group: 'SQL Editor', when: isSqlActive, run: activeHandle('saveSnippet') },
  { id: 'sql.openFile', title: 'Open .sql file…', group: 'SQL Editor', when: isSqlActive, run: activeHandle('openFile') },
  { id: 'sql.saveFile', title: 'Save as .sql file', group: 'SQL Editor', shortcut: `${modKey}S`, when: isSqlActive, run: activeHandle('saveFile') },
  { id: 'sql.refreshCatalog', title: 'Refresh autocomplete metadata', group: 'SQL Editor', when: isSqlActive, run: activeHandle('refreshCatalog') },
]);

const TX_LABEL: Record<TxStatus, { label: string; tone: 'neutral' | 'warning' | 'danger' }> = {
  idle: { label: 'Idle', tone: 'neutral' },
  transaction: { label: 'In transaction', tone: 'warning' },
  error: { label: 'Transaction failed', tone: 'danger' },
};

export default function SqlEditorTab({ tab, active }: TabProps) {
  const theme = useResolvedTheme();
  const fontSize = useSettings((s) => s.editorFontSize);
  const wordWrap = useSettings((s) => s.wordWrap);
  const maxRows = useSettings((s) => s.editorMaxRows);
  const setSettings = useSettings((s) => s.set);
  const connId = tab.connId!;
  const db = tab.database!;
  const conn = useConnections((s) => s.list.find((c) => c.id === connId));
  const connState = useConnections((s) => s.state[connId]);
  const catalog = useCatalogEntry(connId, db);

  const editorRef = useRef<Ed | null>(null);
  const editorPanel = usePanelRef();
  const fileInput = useRef<HTMLInputElement>(null);
  const [sessionId] = useState(() => uid('s'));
  const [txStatus, setTxStatus] = useState<TxStatus>('idle');
  const [running, setRunning] = useState(false);
  const [startedAt, setStartedAt] = useState(0);
  const queryIdRef = useRef<string | null>(null);
  const [outcome, setOutcome] = useState<RunOutcome | null>(null);
  const [explain, setExplain] = useState<ExplainState | null>(null);
  const [version, setVersion] = useState(0);
  const [focusPlan, setFocusPlan] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [hasSelection, setHasSelection] = useState(false);

  const autoCommit: boolean = tab.params.autoCommit ?? true;
  const side: SidePanelKind | null = tab.params.side ?? null;
  const explainOpts: ExplainOptions = { ...defaultExplainOptions, ...(tab.params.explainOpts ?? {}) };
  const update = useCallback((patch: Record<string, unknown>) => useWorkspace.getState().updateParams(tab.id, patch), [tab.id]);

  // ---- session lifecycle: a fresh server session per mount; release the previous one
  const initialSession = useRef<string | undefined>(tab.params.sessionId);
  useEffect(() => {
    const old = initialSession.current;
    if (old && old !== sessionId) api.closeSession(connId, old).catch(() => {});
    update({ sessionId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (connId && (!connState || connState.status === 'idle')) useConnections.getState().connect(connId).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId]);

  useEffect(() => {
    const m = editorRef.current?.getModel();
    if (m && connId && db) bindModel(m, connId, db);
  }, [connId, db]);

  useEffect(() => {
    if (active) requestAnimationFrame(() => editorRef.current?.focus());
  }, [active]);

  // ---- autosave of content into tab params (debounced) + dirty tracking
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushSave = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    const v = editorRef.current?.getValue();
    if (v == null) return;
    const ws = useWorkspace.getState();
    const t = ws.tabs.find((x) => x.id === tab.id);
    if (!t) return;
    const saved: string = t.params.savedSql ?? '';
    const dirty = v !== saved && !(saved === '' && v.trim() === '');
    if (t.params.sql !== v) ws.updateParams(tab.id, { sql: v });
    if (!!t.dirty !== dirty) ws.updateTab(tab.id, { dirty });
  }, [tab.id]);
  useEffect(() => () => flushSave(), [flushSave]);
  useEffect(() => {
    const h = () => flushSave();
    window.addEventListener('pagehide', h);
    return () => window.removeEventListener('pagehide', h);
  }, [flushSave]);

  // ---- markers
  const clearMarkers = () => {
    const m = editorRef.current?.getModel();
    if (m) monaco.editor.setModelMarkers(m, 'pgstudio', []);
  };

  const flash = (start: number, end: number) => {
    const ed = editorRef.current;
    const m = ed?.getModel();
    if (!ed || !m) return;
    const a = m.getPositionAt(start);
    const b = m.getPositionAt(end);
    const deco = ed.createDecorationsCollection([
      { range: new monaco.Range(a.lineNumber, a.column, b.lineNumber, b.column), options: { className: 'bg-accent-soft', isWholeLine: false } },
    ]);
    setTimeout(() => deco.clear(), 450);
  };

  /** The text to run: selection, statement at cursor, or the whole script. */
  const pickSql = (mode: RunMode): { text: string; base: number } | null => {
    const ed = editorRef.current;
    const m = ed?.getModel();
    if (!ed || !m) return null;
    const sel = ed.getSelection();
    if (sel && !sel.isEmpty()) return { text: m.getValueInRange(sel), base: m.getOffsetAt(sel.getStartPosition()) };
    if (mode === 'script') return { text: m.getValue(), base: 0 };
    const pos = ed.getPosition();
    const st = statementAt(m.getValue(), pos ? m.getOffsetAt(pos) : 0);
    if (!st) return null;
    flash(st.start, st.end);
    return { text: st.text, base: st.start };
  };

  const confirmDanger = async (text: string) => {
    if (!useSettings.getState().confirmDangerous) return true;
    const found = findDangerous(text);
    if (!found.length) return true;
    return confirm({
      title: found.length === 1 ? `Run ${found[0].label}?` : `Run ${found.length} destructive statements?`,
      danger: true,
      confirmLabel: 'Run anyway',
      message: (
        <div className="flex flex-col gap-2">
          <span>This can permanently change or remove data{conn?.name ? <> on <b className="text-fg">{conn.name}</b> / <b className="text-fg">{db}</b></> : null}.</span>
          <ul className="flex flex-col gap-1">
            {found.slice(0, 6).map((f, i) => (
              <li key={i} className="rounded-md bg-sunken px-2 py-1 font-mono text-[11px] text-fg">
                <span className="mr-1.5 font-sans text-[10.5px] font-semibold text-danger">{f.label}</span>{f.statement}
              </li>
            ))}
          </ul>
          {txStatus !== 'transaction' && autoCommit && <span className="text-xs">Tip: switch to manual transactions to be able to roll back.</span>}
        </div>
      ),
    });
  };

  const ensureManualTx = async (text: string) => {
    if (autoCommit || txStatus !== 'idle') return;
    if (/^\s*(BEGIN|START\s+TRANSACTION|COMMIT|ROLLBACK|END)\b/i.test(text)) return;
    const r = await api.query(connId, db, { sql: 'BEGIN', sessionId, multi: false });
    if (r.txStatus) setTxStatus(r.txStatus);
  };

  const execute = async (text: string, base: number) => {
    if (!text.trim() || running) return;
    if (!(await confirmDanger(text))) return;
    clearMarkers();
    const qid = uid('q');
    queryIdRef.current = qid;
    setRunning(true);
    const t0 = performance.now();
    setStartedAt(t0);
    let res: QueryResponse;
    try {
      await ensureManualTx(text);
      res = await api.query(connId, db, { sql: text, maxRows, queryId: qid, sessionId });
    } catch (e: any) {
      res = { results: [], notices: [], error: e?.info ?? { message: e?.message ?? String(e) }, totalDurationMs: performance.now() - t0 };
    } finally {
      queryIdRef.current = null;
      setRunning(false);
    }
    if (res.txStatus) setTxStatus(res.txStatus);
    const statements = splitStatements(text);
    const m = editorRef.current?.getModel();
    let errorPos: RunOutcome['errorPos'];
    if (res.error && m && base >= 0 && res.error.code !== '57014') {
      const e = res.error;
      let startOff: number | undefined;
      let endOff: number | undefined;
      if (e.position != null) {
        startOff = base + e.position - 1;
        const p = m.getPositionAt(startOff);
        const w = m.getWordAtPosition(p);
        endOff = w ? m.getOffsetAt({ lineNumber: p.lineNumber, column: w.endColumn }) : startOff + 1;
      } else if (e.statementIndex != null && statements[e.statementIndex]) {
        startOff = base + statements[e.statementIndex].start;
        endOff = base + statements[e.statementIndex].end;
      }
      if (startOff != null && endOff != null) {
        const a = m.getPositionAt(startOff);
        const b = m.getPositionAt(Math.max(endOff, startOff + 1));
        errorPos = a;
        monaco.editor.setModelMarkers(m, 'pgstudio', [{
          severity: monaco.MarkerSeverity.Error,
          message: [e.message, e.detail && `DETAIL: ${e.detail}`, e.hint && `HINT: ${e.hint}`].filter(Boolean).join('\n'),
          code: e.code,
          source: 'PostgreSQL',
          startLineNumber: a.lineNumber, startColumn: a.column, endLineNumber: b.lineNumber, endColumn: b.column,
        }]);
      }
    }
    setOutcome({ res, sql: text, base, statements, finishedAt: Date.now(), errorPos });

    // a JSON EXPLAIN typed by hand gets the visual plan too
    const last = res.results[res.results.length - 1];
    let planFromResult: ExplainState | null = null;
    if (last && last.fields.length === 1 && last.fields[0].name === 'QUERY PLAN' && typeof last.rows[0]?.[0] === 'string' && /^\s*\[/.test(last.rows[0][0] as string)) {
      try {
        const result = parseExplain(last.rows[0][0] as string);
        planFromResult = { sql: stripExplain(last.statement ?? text), analyze: result.analyzed, result };
      } catch { /* not a JSON plan */ }
    }
    setExplain(planFromResult);
    setFocusPlan(!!planFromResult && !res.error);
    setVersion((v) => v + 1);

    const lastCount = last ? (last.fields.length ? last.rows.length : last.rowCount) : null;
    recordHistory({
      sql: text.trim(),
      connId,
      connName: conn?.name,
      database: db,
      durationMs: res.totalDurationMs,
      rows: lastCount ?? null,
      error: res.error?.message,
      statements: statements.length,
    });
    if (isDdl(text) && (res.results.length > 0 || !res.error)) {
      void loadCatalog(connId, db, true);
      invalidateDb(connId, db);
    }
    if (res.error && !useWorkspace.getState().tabs.find((t) => t.id === tab.id && t.id === useWorkspace.getState().activeTabId)) {
      toast.error(`Query failed in ${tab.title}`, { description: res.error.message });
    }
  };

  const run = async (mode: RunMode) => {
    const pick = pickSql(mode);
    if (!pick) return;
    await execute(pick.text, pick.base);
  };

  const runExternal = async (sql: string) => {
    // run SQL coming from history/snippets without touching the editor
    await execute(sql, -1);
  };

  const cancel = async () => {
    const q = queryIdRef.current;
    if (!q) return;
    try {
      const r = await api.cancel(connId, q);
      if (!r.ok) toast.message('Nothing to cancel — the query may have just finished');
    } catch (e: any) {
      toast.error(`Cancel failed: ${e.message}`);
    }
  };

  const doExplain = async (analyze: boolean) => {
    if (running) return;
    const pick = pickSql('statement');
    if (!pick || !pick.text.trim()) return;
    const stmt = stripExplain(pick.text);
    if (splitStatements(stmt).length > 1) {
      toast.error('Select a single statement to explain');
      return;
    }
    const modifying = analyze && isDataModifying(stmt);
    if (modifying && !(await confirm({
      title: 'Run EXPLAIN ANALYZE on a data-modifying statement?',
      message: 'EXPLAIN ANALYZE actually executes the statement to measure it. PG Studio runs it inside a transaction (or savepoint) and rolls it back afterwards, but side effects outside the database (sequences, NOTIFY, external calls) are not undone.',
      confirmLabel: 'Execute & roll back',
      danger: true,
    }))) return;
    clearMarkers();
    const opts = { ...explainOpts, analyze };
    const qid = uid('x');
    queryIdRef.current = qid;
    setExplain({ sql: stmt, analyze, running: true });
    setFocusPlan(true);
    setVersion((v) => v + 1);
    setRunning(true);
    const t0 = performance.now();
    setStartedAt(t0);
    const r = await runExplain({ connId, db, sql: pick.text, options: opts, sessionId, txStatus, queryId: qid });
    queryIdRef.current = null;
    setRunning(false);
    if (r.txStatus) setTxStatus(r.txStatus);
    setExplain({ sql: stmt, analyze, result: r.result, error: r.error });
    setVersion((v) => v + 1);
    recordHistory({ sql: explainSql(pick.text, opts), connId, connName: conn?.name, database: db, durationMs: performance.now() - t0, rows: null, error: r.error?.message, statements: 1 });
    const m = editorRef.current?.getModel();
    if (r.error?.position != null && m) {
      const full = explainSql(pick.text, opts);
      const off = r.error.position - 1 - full.indexOf(stmt) + pick.text.indexOf(stmt);
      if (off >= 0 && off <= pick.text.length) {
        const a = m.getPositionAt(pick.base + off);
        const w = m.getWordAtPosition(a);
        monaco.editor.setModelMarkers(m, 'pgstudio', [{ severity: monaco.MarkerSeverity.Error, message: r.error.message, startLineNumber: a.lineNumber, startColumn: a.column, endLineNumber: a.lineNumber, endColumn: w ? w.endColumn : a.column + 1 }]);
      }
    }
  };

  const txCommand = async (sql: 'COMMIT' | 'ROLLBACK') => {
    try {
      const r = await api.query(connId, db, { sql, sessionId, multi: false });
      if (r.error) toast.error(r.error.message);
      else toast.success(sql === 'COMMIT' ? 'Transaction committed' : 'Transaction rolled back');
      if (r.txStatus) setTxStatus(r.txStatus);
      if (sql === 'COMMIT') { void loadCatalog(connId, db, true); invalidateDb(connId, db); }
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  const switchDb = async (name: string) => {
    if (name === db) return;
    if (txStatus !== 'idle' && !(await confirm({ title: 'Switch database?', message: 'The open transaction on this tab will be rolled back.', danger: true, confirmLabel: 'Switch' }))) return;
    useWorkspace.getState().updateTab(tab.id, { database: name });
    setTxStatus('idle');
    clearMarkers();
  };

  const format = () => editorRef.current?.getAction('editor.action.formatDocument')?.run();

  const insertText = (sql: string, replace = false) => {
    const ed = editorRef.current;
    const m = ed?.getModel();
    if (!ed || !m) return;
    if (replace) {
      ed.executeEdits('pgstudio', [{ range: m.getFullModelRange(), text: sql }]);
      ed.setPosition(m.getPositionAt(sql.length));
    } else {
      const sel = ed.getSelection() ?? new monaco.Selection(1, 1, 1, 1);
      const pos = sel.getStartPosition();
      const lineText = m.getLineContent(pos.lineNumber);
      const needsBreak = !sel.isEmpty() ? false : lineText.trim().length > 0;
      const text = needsBreak ? `\n${sql}\n` : sql;
      ed.executeEdits('pgstudio', [{ range: needsBreak ? new monaco.Range(pos.lineNumber, lineText.length + 1, pos.lineNumber, lineText.length + 1) : sel, text, forceMoveMarkers: true }]);
    }
    ed.pushUndoStop();
    ed.focus();
  };

  const saveFile = async () => {
    const sql = editorRef.current?.getValue() ?? '';
    let name: string | null = tab.params.fileName ?? null;
    if (!name) {
      name = await prompt({ title: 'Save as .sql file', defaultValue: `${tab.title.replace(/[\\/:*?"<>|]/g, '_')}.sql`, confirmLabel: 'Download' });
      if (!name) return;
      if (!/\.(sql|pgsql|txt)$/i.test(name)) name += '.sql';
    }
    downloadText(name, sql, 'application/sql');
    update({ fileName: name, savedSql: sql });
    useWorkspace.getState().updateTab(tab.id, { title: name, dirty: false });
  };

  const openFile = () => fileInput.current?.click();
  const onFilePicked = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > 20 * 1024 * 1024) {
      toast.error('File is too large for the editor (max 20 MB)');
      return;
    }
    const text = await f.text();
    const current = editorRef.current?.getValue() ?? '';
    if (!current.trim()) {
      insertText(text, true);
      update({ fileName: f.name, savedSql: text, sql: text });
      useWorkspace.getState().updateTab(tab.id, { title: f.name, dirty: false });
    } else {
      const id = useWorkspace.getState().newQuery({ connId, database: db, sql: text, title: f.name });
      if (id) useWorkspace.getState().updateParams(id, { fileName: f.name, savedSql: text });
    }
  };

  const toggleSide = (k: SidePanelKind) => update({ side: side === k ? null : k });

  const toggleMaximize = () => {
    const p = editorPanel.current;
    if (!p) return;
    if (p.isCollapsed()) { p.expand(); setMaximized(false); }
    else { p.collapse(); setMaximized(true); }
  };

  // latest callbacks for Monaco actions registered once
  const fns = useRef({ run, doExplain, cancel, saveFile, format, toggleSide, toggleMaximize });
  fns.current = { run, doExplain, cancel, saveFile, format, toggleSide, toggleMaximize };

  useEffect(() => {
    handles.set(tab.id, {
      runStatement: () => fns.current.run('statement'),
      runScript: () => fns.current.run('script'),
      explain: () => fns.current.doExplain(false),
      explainAnalyze: () => fns.current.doExplain(true),
      format: () => fns.current.format(),
      history: () => fns.current.toggleSide('history'),
      snippets: () => fns.current.toggleSide('snippets'),
      saveSnippet: () => saveSnippetFlow(selectedOrAll()),
      openFile: () => fileInput.current?.click(),
      saveFile: () => fns.current.saveFile(),
      refreshCatalog: () => loadCatalog(connId, db, true),
    });
    return () => { handles.delete(tab.id); };
  });

  const selectedOrAll = () => {
    const ed = editorRef.current;
    const m = ed?.getModel();
    const sel = ed?.getSelection();
    if (m && sel && !sel.isEmpty()) return m.getValueInRange(sel);
    return ed?.getValue() ?? '';
  };

  const onMount: OnMount = (ed) => {
    editorRef.current = ed;
    if (import.meta.env.DEV) ((window as any).__pgstudioEditors ??= {})[tab.id] = ed; // dev/e2e hook
    const m = ed.getModel()!;
    bindModel(m, connId, db);
    const K = monaco.KeyMod;
    const C = monaco.KeyCode;
    const add = (id: string, label: string, keys: number[], fn: () => void, menu?: number) =>
      ed.addAction({ id, label, keybindings: keys, run: fn, contextMenuGroupId: menu != null ? '0_pgstudio' : undefined, contextMenuOrder: menu });
    add('pgstudio.run', 'Run Statement / Selection', [K.CtrlCmd | C.Enter], () => fns.current.run('statement'), 1);
    add('pgstudio.runScript', 'Run Script', [K.CtrlCmd | K.Shift | C.Enter], () => fns.current.run('script'), 2);
    add('pgstudio.explain', 'Explain', [K.CtrlCmd | C.KeyE], () => fns.current.doExplain(false), 3);
    add('pgstudio.explainAnalyze', 'Explain Analyze', [K.CtrlCmd | K.Shift | C.KeyE], () => fns.current.doExplain(true), 4);
    add('pgstudio.cancel', 'Cancel Running Query', [K.CtrlCmd | C.Period], () => fns.current.cancel());
    add('pgstudio.save', 'Save as .sql File', [K.CtrlCmd | C.KeyS], () => fns.current.saveFile());
    add('pgstudio.saveSnippet', 'Save as Snippet…', [], () => saveSnippetFlow(selectedOrAll()), 5);
    add('pgstudio.history', 'Toggle Query History', [K.CtrlCmd | K.Shift | C.KeyH], () => fns.current.toggleSide('history'));
    add('pgstudio.maximize', 'Toggle Maximized Results', [K.CtrlCmd | K.Shift | C.KeyM], () => fns.current.toggleMaximize());
    ed.onDidChangeModelContent(() => {
      if (monaco.editor.getModelMarkers({ owner: 'pgstudio', resource: m.uri }).length) monaco.editor.setModelMarkers(m, 'pgstudio', []);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(flushSave, 400);
    });
    ed.onDidChangeCursorSelection((e) => setHasSelection(!e.selection.isEmpty()));
    ed.onDidDispose(() => unbindModel(m));
    if (active) ed.focus();
  };

  const databases = useMemo(
    () => (connState?.info?.databases ?? []).filter((d) => d.allowConn && !d.isTemplate).map((d) => d.name),
    [connState?.info],
  );

  if (!connId || !db) {
    return <div className="flex h-full items-center justify-center text-sm text-muted">This editor has no connection. Open a new query from the sidebar.</div>;
  }

  const runMenu: MenuItem[] = [
    { label: hasSelection ? 'Run selection' : 'Run statement at cursor', icon: <Play size={13} />, shortcut: `${modKey}↵`, onSelect: () => run('statement') },
    { label: 'Run whole script', icon: <ListChecks size={13} />, shortcut: `⇧${modKey}↵`, onSelect: () => run('script') },
    'separator',
    { label: 'Explain', icon: <Workflow size={13} />, shortcut: `${modKey}E`, onSelect: () => doExplain(false) },
    { label: 'Explain analyze', icon: <Workflow size={13} />, shortcut: `⇧${modKey}E`, onSelect: () => doExplain(true) },
  ];
  const explainMenu: MenuItem[] = [
    { label: 'Explain (estimate only)', icon: <Workflow size={13} />, shortcut: `${modKey}E`, onSelect: () => doExplain(false) },
    { label: 'Explain analyze (executes)', icon: <Play size={13} />, shortcut: `⇧${modKey}E`, onSelect: () => doExplain(true) },
    'separator',
    { heading: 'Options' },
    { label: 'BUFFERS', icon: explainOpts.buffers ? <Check size={13} /> : null, onSelect: () => update({ explainOpts: { ...explainOpts, buffers: !explainOpts.buffers } }) },
    { label: 'VERBOSE', icon: explainOpts.verbose ? <Check size={13} /> : null, onSelect: () => update({ explainOpts: { ...explainOpts, verbose: !explainOpts.verbose } }) },
    { label: 'SETTINGS', icon: explainOpts.settings ? <Check size={13} /> : null, onSelect: () => update({ explainOpts: { ...explainOpts, settings: !explainOpts.settings } }) },
  ];
  const moreMenu: MenuItem[] = [
    { label: 'Open .sql file…', icon: <FileUp size={13} />, onSelect: openFile },
    { label: 'Save as .sql file', icon: <FileDown size={13} />, shortcut: `${modKey}S`, onSelect: saveFile },
    'separator',
    { label: 'Save as snippet…', icon: <BookmarkPlus size={13} />, onSelect: () => saveSnippetFlow(selectedOrAll()) },
    { label: 'Format SQL', icon: <AlignLeft size={13} />, shortcut: '⇧⌥F', onSelect: format },
    { label: 'Toggle comment', icon: <ScrollText size={13} />, shortcut: `${modKey}/`, onSelect: () => editorRef.current?.getAction('editor.action.commentLine')?.run() },
    'separator',
    { label: 'Word wrap', icon: wordWrap ? <Check size={13} /> : <WrapText size={13} />, onSelect: () => setSettings({ wordWrap: !wordWrap }) },
    { label: 'Larger font', icon: <AArrowUp size={13} />, onSelect: () => setSettings({ editorFontSize: Math.min(24, fontSize + 1) }) },
    { label: 'Smaller font', icon: <AArrowDown size={13} />, onSelect: () => setSettings({ editorFontSize: Math.max(10, fontSize - 1) }) },
    'separator',
    { label: 'Refresh autocomplete metadata', icon: <RefreshCw size={13} />, onSelect: () => loadCatalog(connId, db, true).then((c) => c && toast.success(`Metadata refreshed · ${c.catalog.relations.length} relations`)) },
  ];

  const tx = TX_LABEL[txStatus];
  const showTxButtons = txStatus !== 'idle' || !autoCommit;

  return (
    <div className="flex h-full flex-col">
      <input ref={fileInput} type="file" accept=".sql,.pgsql,.txt,text/plain,application/sql" className="hidden" onChange={(e) => { onFilePicked(e.target.files?.[0]); e.target.value = ''; }} />
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border bg-bg px-2">
        {/* run */}
        {running ? (
          <div className="flex items-center gap-2">
            <Button variant="danger" size="sm" icon={<Square size={11} />} onClick={cancel}>Cancel</Button>
            <Elapsed since={startedAt} className="w-12 text-xs text-muted" />
          </div>
        ) : (
          <div className="flex items-center">
            <Tooltip content={hasSelection ? 'Run selection' : 'Run statement at cursor'} shortcut={`${modKey}↵`}>
              <Button variant="primary" size="sm" icon={<Play size={12} />} className="rounded-r-none" onClick={() => run('statement')}>
                {hasSelection ? 'Run selection' : 'Run'}
              </Button>
            </Tooltip>
            <DropdownMenu
              items={runMenu}
              trigger={<Button variant="primary" size="sm" className="rounded-l-none border-l border-white/20 px-1.5" aria-label="More run options"><ChevronDown size={12} /></Button>}
            />
          </div>
        )}
        <Tooltip content="Run whole script" shortcut={`⇧${modKey}↵`}>
          <Button variant="ghost" size="sm" icon={<ListChecks size={13} />} disabled={running} onClick={() => run('script')}>Script</Button>
        </Tooltip>
        <div className="flex items-center">
          <Tooltip content="Explain statement (visual plan)" shortcut={`${modKey}E`}>
            <Button variant="ghost" size="sm" icon={<Workflow size={13} />} className="rounded-r-none pr-1.5" disabled={running} onClick={() => doExplain(false)}>Explain</Button>
          </Tooltip>
          <DropdownMenu items={explainMenu} trigger={<Button variant="ghost" size="sm" className="rounded-l-none px-1" aria-label="Explain options" disabled={running}><ChevronDown size={12} /></Button>} />
        </div>
        <IconButton label="Format SQL" shortcut="⇧⌥F" onClick={format}><AlignLeft size={14} /></IconButton>

        <ToolbarDivider />

        {/* database */}
        <DropdownMenu
          items={databases.length ? databases.map((d) => ({ label: d, icon: d === db ? <Check size={13} /> : <Database size={13} />, onSelect: () => switchDb(d) })) : [{ label: db, disabled: true }]}
          trigger={
            <button className="flex h-7 max-w-[200px] items-center gap-1.5 rounded-md px-2 text-xs text-muted hover:bg-hover hover:text-fg" title="Database for this editor">
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: conn?.color || 'var(--subtle)' }} />
              <Database size={12} className="shrink-0" />
              <span className="truncate font-medium text-fg">{db}</span>
              <ChevronDown size={11} className="shrink-0" />
            </button>
          }
        />

        <ToolbarDivider />

        {/* transaction */}
        <Tooltip content={autoCommit ? 'Auto-commit: every statement commits immediately' : 'Manual: statements run inside a transaction until you Commit or Roll back'}>
          <label className="flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-xs text-muted hover:bg-hover">
            <Switch checked={autoCommit} onCheckedChange={(v) => update({ autoCommit: v })} />
            Auto-commit
          </label>
        </Tooltip>
        <Tooltip content={`Session transaction status: ${tx.label}`}>
          <span>
            <Badge tone={tx.tone} className={cn('gap-1', txStatus !== 'idle' && 'animate-fade-in')}>
              <CircleDot size={9} className={txStatus === 'transaction' ? 'animate-pulse' : ''} />
              {tx.label}
            </Badge>
          </span>
        </Tooltip>
        {showTxButtons && (
          <>
            <Button size="xs" variant="outline" icon={<Check size={11} />} disabled={running || txStatus === 'idle'} onClick={() => txCommand('COMMIT')} className="ml-1 text-success">Commit</Button>
            <Button size="xs" variant="outline" icon={<RotateCcw size={11} />} disabled={running || txStatus === 'idle'} onClick={() => txCommand('ROLLBACK')} className="text-danger">Rollback</Button>
          </>
        )}

        <div className="flex-1" />

        {conn?.readOnly && <Badge tone="accent" className="gap-1"><Lock size={10} /> Read-only</Badge>}
        {tab.params.fileName && <span className="hidden max-w-[160px] truncate text-[11px] text-subtle lg:inline" title={tab.params.fileName}>{tab.params.fileName}{tab.dirty ? ' •' : ''}</span>}
        <Tooltip content={catalog?.loading ? 'Loading metadata for autocomplete…' : catalog?.error ? `Autocomplete metadata failed: ${catalog.error}` : catalog?.index ? `Autocomplete ready · ${catalog.index.catalog.relations.length} relations, ${catalog.index.catalog.functions.length + catalog.index.catalog.builtins.length} functions — click to refresh` : 'Autocomplete metadata'}>
          <button className="flex h-7 w-7 items-center justify-center rounded-md text-subtle hover:bg-hover hover:text-fg" onClick={() => loadCatalog(connId, db, true)} aria-label="Refresh autocomplete metadata">
            {catalog?.loading ? <Spinner size={12} /> : <TextCursorInput size={14} className={catalog?.error ? 'text-danger' : catalog?.index ? '' : 'opacity-50'} />}
          </button>
        </Tooltip>
        <IconButton label="Query history" shortcut={`⇧${modKey}H`} active={side === 'history'} onClick={() => toggleSide('history')}><History size={14} /></IconButton>
        <IconButton label="Snippets" active={side === 'snippets'} onClick={() => toggleSide('snippets')}><Bookmark size={14} /></IconButton>
        <DropdownMenu align="end" items={moreMenu} trigger={<IconButton label="More"><MoreHorizontal size={15} /></IconButton>} />
      </div>

      <Group orientation="horizontal" className="min-h-0 flex-1">
        <Panel id={`sqlmain-${tab.id}`} minSize="40%">
          <Group orientation="vertical" className="h-full">
            <Panel id={`sqledit-${tab.id}`} panelRef={editorPanel} defaultSize="48%" minSize="8%" collapsible collapsedSize={0} onResize={(s) => setMaximized(s.asPercentage < 1)}>
              <Editor
                language={PG_LANG}
                path={`pgstudio-${tab.id}.sql`}
                defaultValue={tab.params.sql ?? ''}
                theme={monacoTheme(theme)}
                onMount={onMount}
                loading={<Spinner size={16} />}
                options={{
                  fontSize,
                  fontFamily: 'JetBrains Mono, SF Mono, Menlo, Consolas, monospace',
                  fontLigatures: false,
                  lineHeight: Math.round(fontSize * 1.6),
                  minimap: { enabled: false },
                  wordWrap: wordWrap ? 'on' : 'off',
                  scrollBeyondLastLine: false,
                  padding: { top: 10, bottom: 10 },
                  automaticLayout: true,
                  fixedOverflowWidgets: true,
                  renderLineHighlight: 'line',
                  lineNumbersMinChars: 3,
                  glyphMargin: false,
                  folding: true,
                  smoothScrolling: true,
                  cursorBlinking: 'smooth',
                  cursorSmoothCaretAnimation: 'on',
                  tabSize: 2,
                  bracketPairColorization: { enabled: true },
                  guides: { bracketPairs: false, indentation: true },
                  quickSuggestions: { other: true, comments: false, strings: false },
                  suggestOnTriggerCharacters: true,
                  wordBasedSuggestions: 'off',
                  suggestSelection: 'first',
                  suggest: { showStatusBar: true, preview: false, showWords: false, localityBonus: true, filterGraceful: true },
                  acceptSuggestionOnEnter: 'on',
                  tabCompletion: 'on',
                  hover: { delay: 500 },
                  scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
                  overviewRulerBorder: false,
                  stickyScroll: { enabled: false },
                  // classic hidden-textarea input: most compatible (IMEs, automation, older Electron)
                  editContext: false,
                }}
              />
            </Panel>
            <Separator />
            <Panel id={`sqlres-${tab.id}`} minSize="10%">
              <Results
                outcome={outcome}
                explain={explain}
                running={running}
                startedAt={startedAt}
                onCancel={cancel}
                onGoToError={() => {
                  const ed = editorRef.current;
                  const p = outcome?.errorPos;
                  if (!ed || !p) return;
                  if (editorPanel.current?.isCollapsed()) toggleMaximize();
                  ed.revealPositionInCenter(p);
                  ed.setPosition(p);
                  ed.focus();
                }}
                maximized={maximized}
                onToggleMaximize={toggleMaximize}
                onOpenPlanTab={() => {
                  if (!explain?.result) return;
                  const raw = explain.result.raw;
                  useWorkspace.getState().openTab({
                    kind: 'explain',
                    title: `Plan · ${explain.sql.replace(/\s+/g, ' ').slice(0, 28)}`,
                    connId,
                    database: db,
                    params: { sql: explain.sql, plan: typeof raw === 'string' ? raw : JSON.stringify(raw), analyze: explain.analyze, explainOpts },
                  });
                }}
                onRunExplainAgain={() => explain && doExplain(explain.analyze)}
                maxRows={maxRows}
                version={version}
                focusPlan={focusPlan}
              />
            </Panel>
          </Group>
        </Panel>
        {side && (
          <>
            <Separator />
            <Panel id={`sqlside-${tab.id}`} defaultSize="26%" minSize="16%" maxSize="50%">
              <SidePanel
                kind={side}
                onKindChange={(k) => update({ side: k })}
                onClose={() => update({ side: null })}
                connId={connId}
                db={db}
                onInsert={(s) => insertText(s)}
                onReplace={(s) => insertText(s, true)}
                onRun={runExternal}
                getCurrentSql={selectedOrAll}
              />
            </Panel>
          </>
        )}
      </Group>
    </div>
  );
}
