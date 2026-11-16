import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Activity, Database, FileCode2, MoreHorizontal, Plus, RefreshCw, Search, Trash2 } from 'lucide-react';
import type { CreateDatabaseRequest, DatabaseRow } from '@shared/monitor';
import { Badge, Button, Checkbox, Dialog, DropdownMenu, Field, IconButton, Input, Select, toast } from '@/components/ui';
import { SqlBlock } from '@/components/SqlBlock';
import { cn } from '@/lib/cn';
import { formatBytes, formatCount } from '@/lib/format';
import { queryClient } from '@/lib/queryClient';
import { useConnections } from '@/stores/connections';
import { confirmSql } from '@/stores/dialogs';
import { useWorkspace } from '@/stores/workspace';
import { monitorApi, mk } from './api';
import { DataTable, ErrorState, errorMessage, formatPct, LoadingState, MiniBar, type Column } from './common';
import type { SectionProps } from './types';

export function DatabasesView({ connId, database }: SectionProps) {
  const q = useQuery({ queryKey: mk.databases(connId), queryFn: () => monitorApi.databases(connId) });
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [dropping, setDropping] = useState<DatabaseRow | null>(null);
  const rows = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (q.data ?? []).filter((d) => !s || d.name.toLowerCase().includes(s) || d.owner.toLowerCase().includes(s));
  }, [q.data, search]);

  if (q.isLoading) return <LoadingState />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const all = q.data ?? [];
  const maxSize = Math.max(1, ...all.map((d) => d.sizeBytes ?? 0));
  const ws = useWorkspace.getState();
  const connName = useConnections.getState().get(connId)?.name ?? '';

  const columns: Column<DatabaseRow>[] = [
    {
      id: 'name', header: 'Database', sort: (d) => d.name,
      cell: (d) => (
        <div className="min-w-[180px]">
          <div className="flex items-center gap-1.5">
            <Database size={13} className="shrink-0 text-subtle" />
            <span className="truncate font-medium text-fg">{d.name}</span>
            {d.name === database && <Badge tone="accent">current</Badge>}
            {d.isTemplate && <Badge>template</Badge>}
            {!d.allowConn && <Badge tone="warning">no connections</Badge>}
          </div>
          {d.comment && <div className="truncate pl-5 text-[11px] text-subtle">{d.comment}</div>}
        </div>
      ),
    },
    {
      id: 'size', header: 'Size', align: 'right', width: 150, sort: (d) => d.sizeBytes ?? -1,
      cell: (d) => (
        <div className="ml-auto flex w-[120px] flex-col items-end gap-1">
          <span className="font-medium">{formatBytes(d.sizeBytes)}</span>
          {d.sizeBytes != null && <MiniBar value={d.sizeBytes} max={maxSize} />}
        </div>
      ),
    },
    {
      id: 'conns', header: 'Connections', align: 'right', sort: (d) => d.connections,
      cell: (d) => <span className={d.connections ? 'font-medium text-fg' : 'text-subtle'}>{d.connections}{d.connLimit >= 0 && <span className="text-subtle"> / {d.connLimit}</span>}</span>,
    },
    { id: 'owner', header: 'Owner', sort: (d) => d.owner, cell: (d) => d.owner },
    { id: 'enc', header: 'Encoding', sort: (d) => d.encoding, cell: (d) => <span className="text-muted">{d.encoding}</span> },
    { id: 'coll', header: 'Collation', sort: (d) => d.collate, cell: (d) => <span className="text-muted">{d.collate ?? '—'}</span> },
    { id: 'hit', header: 'Cache hit', align: 'right', sort: (d) => d.cacheHitPct ?? -1, cell: (d) => <span className={d.cacheHitPct != null && d.cacheHitPct < 90 ? 'text-warning' : 'text-muted'}>{formatPct(d.cacheHitPct)}</span> },
    { id: 'tx', header: 'Commits', align: 'right', sort: (d) => d.xactCommit, cell: (d) => <span className="text-muted">{formatCount(d.xactCommit)}</span> },
    {
      id: 'rb', header: 'Rollbacks', align: 'right', sort: (d) => d.xactRollback,
      cell: (d) => <span className={d.xactRollback > d.xactCommit * 0.05 && d.xactRollback > 10 ? 'text-warning' : 'text-muted'}>{formatCount(d.xactRollback)}</span>,
    },
    {
      id: 'act', header: '', width: 44, align: 'right',
      cell: (d) => (
        <DropdownMenu
          align="end"
          trigger={<IconButton size="xs" label="Database actions"><MoreHorizontal size={14} /></IconButton>}
          items={[
            { label: 'New query', icon: <FileCode2 size={13} />, disabled: !d.allowConn, onSelect: () => ws.newQuery({ connId, database: d.name }) },
            { label: 'Use as current database', icon: <Activity size={13} />, disabled: !d.allowConn, onSelect: () => ws.setActiveDb(connId, d.name) },
            'separator',
            { label: 'Drop database…', icon: <Trash2 size={13} />, danger: true, disabled: d.isTemplate, onSelect: () => setDropping(d) },
          ]}
        />
      ),
    },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-4 py-2">
        <Input size="sm" icon={<Search size={13} />} placeholder="Filter databases…" value={search} onChange={(e) => setSearch(e.target.value)} className="w-60" />
        <span className="text-[11.5px] text-muted">
          {all.filter((d) => !d.isTemplate).length} databases · {formatBytes(all.reduce((a, d) => a + (d.sizeBytes ?? 0), 0))} · {all.reduce((a, d) => a + d.connections, 0)} connections
        </span>
        <div className="flex-1" />
        <IconButton label="Refresh" onClick={() => q.refetch()}><RefreshCw size={14} className={cn(q.isFetching && 'animate-spin')} /></IconButton>
        <Button size="sm" variant="primary" icon={<Plus size={13} />} onClick={() => setCreating(true)}>New database</Button>
      </div>
      <DataTable
        className="flex-1"
        rows={rows}
        columns={columns}
        rowKey={(d) => d.name}
        defaultSort={{ id: 'size', desc: true }}
        empty={<div className="py-14 text-center text-xs text-muted">No databases match.</div>}
      />
      {creating && <CreateDatabaseDialog connId={connId} onClose={() => setCreating(false)} />}
      {dropping && <DropDatabaseDialog connId={connId} db={dropping} connName={connName} onClose={() => setDropping(null)} />}
    </div>
  );
}

async function afterChange(connId: string) {
  queryClient.invalidateQueries({ queryKey: mk.databases(connId) });
  await useConnections.getState().refresh(connId).catch(() => {});
}

// ------------------------------------------------------------------ create

function CreateDatabaseDialog({ connId, onClose }: { connId: string; onClose: () => void }) {
  const meta = useQuery({ queryKey: mk.databaseMeta(connId), queryFn: () => monitorApi.databaseMeta(connId) });
  const [f, setF] = useState<CreateDatabaseRequest>({ name: '', owner: '', encoding: 'UTF8', template: '', locale: '', tablespace: '', comment: '' });
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<CreateDatabaseRequest>) => setF((x) => ({ ...x, ...p }));
  useEffect(() => {
    if (meta.data && !f.owner) set({ owner: meta.data.currentUser });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta.data]);

  const valid = f.name.trim().length > 0 && f.name.length <= 63;
  const submit = async () => {
    const req: CreateDatabaseRequest = {
      name: f.name.trim(),
      owner: f.owner || undefined,
      encoding: f.encoding || undefined,
      template: f.template || undefined,
      locale: f.locale?.trim() || undefined,
      tablespace: f.tablespace || undefined,
      connLimit: f.connLimit,
      comment: f.comment?.trim() || undefined,
    };
    try {
      const { sql } = await monitorApi.createDatabase(connId, { ...req, dryRun: true });
      if (!(await confirmSql({ title: `Create database ${req.name}`, sql, confirmLabel: 'Create database' }))) return;
      setBusy(true);
      await monitorApi.createDatabase(connId, req);
      toast.success(`Database ${req.name} created`);
      await afterChange(connId);
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const opt = (xs: string[] | undefined, def: string) => [{ value: '', label: def }, ...(xs ?? []).map((x) => ({ value: x, label: x }))];

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="New database"
      description="CREATE DATABASE — you'll review the SQL before it runs."
      width={560}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!valid} loading={busy} onClick={submit}>Review & create</Button>
        </>
      }
    >
      <form className="grid grid-cols-2 gap-3" onSubmit={(e) => { e.preventDefault(); if (valid) void submit(); }}>
        <Field label="Name" className="col-span-2">
          <Input autoFocus value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder="my_database" mono />
        </Field>
        <Field label="Owner">
          <Select value={f.owner} onChange={(e) => set({ owner: e.target.value })} options={opt(meta.data?.roles, '(current user)')} />
        </Field>
        <Field label="Encoding">
          <Select value={f.encoding} onChange={(e) => set({ encoding: e.target.value })} options={opt(meta.data?.encodings, '(template default)')} />
        </Field>
        <Field label="Template" hint={f.encoding && f.encoding !== 'UTF8' && !f.template ? 'A non-default encoding usually needs template0.' : undefined}>
          <Select value={f.template} onChange={(e) => set({ template: e.target.value })} options={opt(meta.data?.templates, 'template1 (default)')} />
        </Field>
        <Field label="Tablespace">
          <Select value={f.tablespace} onChange={(e) => set({ tablespace: e.target.value })} options={opt(meta.data?.tablespaces, '(default)')} />
        </Field>
        <Field label="Locale" hint="Optional, e.g. en_US.UTF-8 or C. Leave empty to inherit.">
          <Input value={f.locale} onChange={(e) => set({ locale: e.target.value })} placeholder="inherit" />
        </Field>
        <Field label="Connection limit" hint="Empty = unlimited">
          <Input
            type="number"
            min={-1}
            value={f.connLimit ?? ''}
            onChange={(e) => set({ connLimit: e.target.value === '' ? undefined : Math.trunc(Number(e.target.value)) })}
            placeholder="unlimited"
          />
        </Field>
        <Field label="Comment" className="col-span-2">
          <Input value={f.comment} onChange={(e) => set({ comment: e.target.value })} placeholder="Optional description" />
        </Field>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

// ------------------------------------------------------------------ drop

function DropDatabaseDialog({ connId, db, connName, onClose }: { connId: string; db: DatabaseRow; connName: string; onClose: () => void }) {
  const [typed, setTyped] = useState('');
  const [force, setForce] = useState(db.connections > 0);
  const [busy, setBusy] = useState(false);
  const sql = `DROP DATABASE "${db.name.replace(/"/g, '""')}"${force ? ' WITH (FORCE)' : ''};`;
  const submit = async () => {
    setBusy(true);
    try {
      await monitorApi.dropDatabase(connId, { name: db.name, force });
      toast.success(`Database ${db.name} dropped`);
      // Close tabs opened on the dropped database.
      const ws = useWorkspace.getState();
      for (const t of ws.tabs) if (t.connId === connId && t.database === db.name && t.kind !== 'dashboard') ws.closeTab(t.id);
      if (ws.activeConnId === connId && ws.activeDb === db.name) ws.setActiveDb(connId, null);
      await afterChange(connId);
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Drop database ${db.name}?`}
      width={560}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="danger" icon={<Trash2 size={13} />} disabled={typed !== db.name} loading={busy} onClick={submit}>Drop database</Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-[12.5px]">
        <div className="rounded-md bg-danger-soft px-3 py-2 text-danger">
          This permanently deletes <b>{db.name}</b> ({formatBytes(db.sizeBytes)}) on {connName || 'this server'} and all of its data. It cannot be undone.
        </div>
        {db.connections > 0 && (
          <div className="text-muted">
            {db.connections} session{db.connections > 1 ? 's are' : ' is'} connected. Without FORCE the drop fails while anyone is connected.
          </div>
        )}
        <label className="flex items-center gap-2 text-fg">
          <Checkbox checked={force} onCheckedChange={setForce} />
          Terminate existing connections (<span className="font-mono">WITH (FORCE)</span>)
        </label>
        <SqlBlock sql={sql} />
        <Field label={<>Type <span className="font-mono text-fg">{db.name}</span> to confirm</>}>
          <Input value={typed} onChange={(e) => setTyped(e.target.value)} mono autoFocus onKeyDown={(e) => e.key === 'Enter' && typed === db.name && submit()} />
        </Field>
      </div>
    </Dialog>
  );
}
