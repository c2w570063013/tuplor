import '@/lib/monaco';
import { Editor, type OnMount } from '@monaco-editor/react';
import { Play, Square, AlertCircle, CheckCircle2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import type { QueryResponse } from '@shared/types';
import { Button, Toolbar } from '@/components/ui';
import { DataGrid } from '@/components/grid';
import { api } from '@/lib/api';
import { formatDuration, modKey, uid } from '@/lib/format';
import { monacoTheme } from '@/lib/monaco';
import { useResolvedTheme, useSettings } from '@/stores/settings';
import { useWorkspace } from '@/stores/workspace';
import type { TabProps } from '../common/TabProps';

/** Basic SQL editor (owned by the SQL Editor team, who will extend it). */
export default function SqlEditorTab({ tab }: TabProps) {
  const theme = useResolvedTheme();
  const fontSize = useSettings((s) => s.editorFontSize);
  const maxRows = useSettings((s) => s.editorMaxRows);
  const [res, setRes] = useState<QueryResponse | null>(null);
  const [running, setRunning] = useState(false);
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const queryId = useRef<string | null>(null);
  const sessionId = useRef(tab.params.sessionId ?? uid('s'));

  const run = async () => {
    const ed = editorRef.current;
    if (!ed || !tab.connId || !tab.database) return;
    const sel = ed.getSelection();
    const text = sel && !sel.isEmpty() ? ed.getModel()!.getValueInRange(sel) : ed.getValue();
    if (!text.trim()) return;
    setRunning(true);
    queryId.current = uid('q');
    try {
      setRes(await api.query(tab.connId, tab.database, { sql: text, maxRows, queryId: queryId.current, sessionId: sessionId.current }));
    } catch (e: any) {
      setRes({ results: [], notices: [], error: { message: e.message }, totalDurationMs: 0 });
    } finally {
      setRunning(false);
    }
  };

  const last = res?.results[res.results.length - 1];
  return (
    <div className="flex h-full flex-col">
      <Toolbar>
        {running ? (
          <Button variant="danger" size="sm" icon={<Square size={12} />} onClick={() => queryId.current && api.cancel(tab.connId!, queryId.current)}>Cancel</Button>
        ) : (
          <Button variant="primary" size="sm" icon={<Play size={12} />} onClick={run}>Run <span className="opacity-60">{modKey}↵</span></Button>
        )}
        <span className="ml-2 text-xs text-subtle">{tab.database}</span>
      </Toolbar>
      <Group orientation="vertical" className="min-h-0 flex-1">
        <Panel defaultSize="45%" minSize="10%">
          <Editor
            defaultLanguage="sql"
            defaultValue={tab.params.sql ?? ''}
            theme={monacoTheme(theme)}
            onChange={(v) => useWorkspace.getState().updateParams(tab.id, { sql: v ?? '' })}
            onMount={(ed, monaco) => {
              editorRef.current = ed;
              ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => run());
              ed.focus();
            }}
            options={{ fontSize, minimap: { enabled: false }, scrollBeyondLastLine: false, fontFamily: 'JetBrains Mono, SF Mono, Menlo, monospace', padding: { top: 8 }, automaticLayout: true }}
          />
        </Panel>
        <Separator />
        <Panel minSize="10%">
          <div className="flex h-full flex-col">
            {res?.error ? (
              <div className="m-3 flex gap-2 rounded-lg bg-danger-soft p-3 text-xs text-danger">
                <AlertCircle size={15} className="shrink-0" />
                <div><div className="font-medium">{res.error.message}</div>{res.error.detail && <div className="mt-1 opacity-80">{res.error.detail}</div>}</div>
              </div>
            ) : null}
            {last && last.fields.length > 0 ? (
              <DataGrid columns={last.fields.map((f) => ({ name: f.name, typeName: f.typeName }))} rows={last.rows} className="min-h-0 flex-1" />
            ) : last ? (
              <div className="flex items-center gap-2 p-4 text-xs text-success"><CheckCircle2 size={14} /> {last.command} {last.rowCount ?? ''}</div>
            ) : !res ? (
              <div className="flex h-full items-center justify-center text-xs text-subtle">Run a query to see results</div>
            ) : null}
            {res && <div className="flex h-6 shrink-0 items-center border-t border-border px-3 text-[11px] text-subtle">{last ? `${last.rows.length} rows` : ''} · {formatDuration(res.totalDurationMs)}</div>}
          </div>
        </Panel>
      </Group>
    </div>
  );
}
