import { useMutation, useQuery } from '@tanstack/react-query';
import {
  AlertCircle, Bookmark, BookmarkPlus, Clock, Copy, CornerDownLeft, History, Pencil, Play, Replace, Search, Trash2, X,
} from 'lucide-react';
import { useDeferredValue, useState } from 'react';
import type { HistoryEntry, Snippet } from '@shared/completion';
import { Button, EmptyState, IconButton, Input, Segmented, Spinner, Switch, toast } from '@/components/ui';
import { highlightSql } from '@/components/SqlBlock';
import { cn } from '@/lib/cn';
import { formatDuration } from '@/lib/format';
import { queryClient } from '@/lib/queryClient';
import { confirm, prompt } from '@/stores/dialogs';
import { editorApi } from './editorApi';

export type SidePanelKind = 'history' | 'snippets';

interface Props {
  kind: SidePanelKind;
  onKindChange: (k: SidePanelKind) => void;
  onClose: () => void;
  connId: string;
  db: string;
  onInsert: (sql: string) => void;
  onReplace: (sql: string) => void;
  onRun: (sql: string) => void;
  getCurrentSql: () => string;
}

export function SidePanel(p: Props) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-panel">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
        <Segmented
          size="xs"
          value={p.kind}
          onChange={p.onKindChange}
          options={[
            { value: 'history', label: 'History', icon: <History size={11} /> },
            { value: 'snippets', label: 'Snippets', icon: <Bookmark size={11} /> },
          ]}
        />
        <div className="flex-1" />
        <IconButton size="xs" label="Close panel" onClick={p.onClose}><X size={13} /></IconButton>
      </div>
      {p.kind === 'history' ? <HistoryList {...p} /> : <SnippetList {...p} />}
    </div>
  );
}

function timeAgo(iso: string) {
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 45) return 'just now';
  if (d < 3600) return `${Math.round(d / 60)}m ago`;
  if (d < 86400) return `${Math.round(d / 3600)}h ago`;
  if (d < 86400 * 7) return `${Math.round(d / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

function SqlPreview({ sql, lines = 4 }: { sql: string; lines?: number }) {
  const text = sql.trim().split('\n').slice(0, lines).join('\n');
  return (
    <pre className="overflow-hidden font-mono text-[11px] leading-[1.45] whitespace-pre-wrap text-muted [overflow-wrap:anywhere]" style={{ maxHeight: `${lines * 1.45}em` }}>
      {highlightSql(text)}
    </pre>
  );
}

function HistoryList(p: Props) {
  const [q, setQ] = useState('');
  const [thisDb, setThisDb] = useState(true);
  const [errorsOnly, setErrorsOnly] = useState(false);
  const dq = useDeferredValue(q);
  const { data, isLoading, error } = useQuery({
    queryKey: ['sql-history', dq, thisDb ? p.connId : '', thisDb ? p.db : '', errorsOnly],
    queryFn: () => editorApi.history({ q: dq, connId: thisDb ? p.connId : undefined, db: thisDb ? p.db : undefined, errors: errorsOnly ? 'only' : undefined }),
    staleTime: 0,
  });
  const del = useMutation({
    mutationFn: (id: string) => editorApi.deleteHistory(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['sql-history'] }),
  });

  return (
    <>
      <div className="flex shrink-0 flex-col gap-1.5 border-b border-border p-2">
        <Input size="sm" icon={<Search size={12} />} placeholder="Search history…" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="flex items-center gap-3 text-[11px] text-muted">
          <label className="flex items-center gap-1.5"><Switch checked={thisDb} onCheckedChange={setThisDb} /> This database</label>
          <label className="flex items-center gap-1.5"><Switch checked={errorsOnly} onCheckedChange={setErrorsOnly} /> Errors</label>
          <div className="flex-1" />
          <button
            className="text-subtle hover:text-danger"
            onClick={async () => {
              if (await confirm({ title: 'Clear query history?', message: 'All recorded queries (for every connection) will be removed.', danger: true, confirmLabel: 'Clear' })) {
                await editorApi.clearHistory();
                queryClient.invalidateQueries({ queryKey: ['sql-history'] });
              }
            }}
          >
            Clear
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {isLoading ? (
          <div className="flex justify-center p-6"><Spinner /></div>
        ) : error ? (
          <div className="p-3 text-xs text-danger">{(error as Error).message}</div>
        ) : !data?.length ? (
          <EmptyState icon={<Clock size={20} />} title={q ? 'No matches' : 'No history yet'} description={q ? 'Try a different search.' : 'Queries you run are recorded here.'} />
        ) : (
          data.map((h) => <HistoryItem key={h.id} h={h} p={p} onDelete={() => del.mutate(h.id)} />)
        )}
      </div>
    </>
  );
}

function HistoryItem({ h, p, onDelete }: { h: HistoryEntry; p: Props; onDelete: () => void }) {
  return (
    <div
      className="group relative cursor-default border-b border-border px-2.5 py-2 hover:bg-hover"
      onDoubleClick={() => p.onInsert(h.sql)}
      title="Double-click to insert at cursor"
    >
      <SqlPreview sql={h.sql} />
      <div className="mt-1 flex items-center gap-1.5 text-[10.5px] text-subtle">
        {h.error ? <AlertCircle size={11} className="text-danger" /> : null}
        <span>{timeAgo(h.at)}</span>
        <span>·</span>
        <span className="tabular-nums">{formatDuration(h.durationMs)}</span>
        {h.rows != null && !h.error && <><span>·</span><span className="tabular-nums">{h.rows.toLocaleString()} rows</span></>}
        {(h.database !== p.db || h.connId !== p.connId) && <><span>·</span><span className="truncate">{h.connName ? `${h.connName}/` : ''}{h.database}</span></>}
      </div>
      {h.error && <div className="mt-0.5 truncate text-[10.5px] text-danger" title={h.error}>{h.error}</div>}
      <ItemActions
        onInsert={() => p.onInsert(h.sql)}
        onReplace={() => p.onReplace(h.sql)}
        onRun={() => p.onRun(h.sql)}
        onCopy={() => { navigator.clipboard.writeText(h.sql); toast.success('Copied'); }}
        onDelete={onDelete}
      />
    </div>
  );
}

function ItemActions(a: { onInsert: () => void; onReplace: () => void; onRun: () => void; onCopy: () => void; onEdit?: () => void; onDelete: () => void }) {
  return (
    <div className="absolute top-1.5 right-1.5 hidden items-center gap-0.5 rounded-md border border-border bg-elevated p-0.5 shadow-pop group-hover:flex">
      <IconButton size="xs" label="Insert at cursor" onClick={a.onInsert}><CornerDownLeft size={12} /></IconButton>
      <IconButton size="xs" label="Replace editor content" onClick={a.onReplace}><Replace size={12} /></IconButton>
      <IconButton size="xs" label="Run" onClick={a.onRun}><Play size={12} /></IconButton>
      <IconButton size="xs" label="Copy" onClick={a.onCopy}><Copy size={12} /></IconButton>
      {a.onEdit && <IconButton size="xs" label="Rename" onClick={a.onEdit}><Pencil size={12} /></IconButton>}
      <IconButton size="xs" label="Delete" onClick={a.onDelete} className="hover:text-danger"><Trash2 size={12} /></IconButton>
    </div>
  );
}

export async function saveSnippetFlow(sql: string, existing?: Snippet) {
  if (!sql.trim()) {
    toast.error('Nothing to save — the editor is empty');
    return;
  }
  const name = await prompt({ title: existing ? 'Rename snippet' : 'Save as snippet', placeholder: 'e.g. Top customers by revenue', defaultValue: existing?.name ?? firstLineName(sql), confirmLabel: 'Save' });
  if (!name?.trim()) return;
  try {
    await editorApi.saveSnippet({ id: existing?.id, name: name.trim(), sql: existing ? existing.sql : sql });
    queryClient.invalidateQueries({ queryKey: ['sql-snippets'] });
    toast.success(existing ? 'Snippet renamed' : `Saved snippet “${name.trim()}”`);
  } catch (e: any) {
    toast.error(e.message);
  }
}

function firstLineName(sql: string) {
  const l = sql.trim().split('\n')[0].replace(/^--\s*/, '');
  return l.length > 48 ? l.slice(0, 48) + '…' : l;
}

function SnippetList(p: Props) {
  const [q, setQ] = useState('');
  const { data, isLoading } = useQuery({ queryKey: ['sql-snippets'], queryFn: editorApi.snippets });
  const list = (data ?? [])
    .filter((s) => !q || (s.name + ' ' + s.sql).toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name));
  return (
    <>
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border p-2">
        <Input size="sm" className="flex-1" icon={<Search size={12} />} placeholder="Search snippets…" value={q} onChange={(e) => setQ(e.target.value)} />
        <Button size="sm" variant="outline" icon={<BookmarkPlus size={12} />} onClick={() => saveSnippetFlow(p.getCurrentSql())}>Save</Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {isLoading ? (
          <div className="flex justify-center p-6"><Spinner /></div>
        ) : !list.length ? (
          <EmptyState
            icon={<Bookmark size={20} />}
            title={q ? 'No matches' : 'No snippets yet'}
            description={q ? undefined : 'Save frequently used queries (or the current selection) as named snippets.'}
          />
        ) : (
          list.map((s) => (
            <div key={s.id} className={cn('group relative cursor-default border-b border-border px-2.5 py-2 hover:bg-hover')} onDoubleClick={() => p.onInsert(s.sql)}>
              <div className="mb-0.5 flex items-center gap-1.5 text-xs font-medium text-fg"><Bookmark size={11} className="text-accent" />{s.name}</div>
              <SqlPreview sql={s.sql} lines={3} />
              <ItemActions
                onInsert={() => p.onInsert(s.sql)}
                onReplace={() => p.onReplace(s.sql)}
                onRun={() => p.onRun(s.sql)}
                onCopy={() => { navigator.clipboard.writeText(s.sql); toast.success('Copied'); }}
                onEdit={() => saveSnippetFlow(s.sql, s)}
                onDelete={async () => {
                  if (await confirm({ title: `Delete snippet “${s.name}”?`, danger: true, confirmLabel: 'Delete' })) {
                    await editorApi.deleteSnippet(s.id);
                    queryClient.invalidateQueries({ queryKey: ['sql-snippets'] });
                  }
                }}
              />
            </div>
          ))
        )}
      </div>
    </>
  );
}
