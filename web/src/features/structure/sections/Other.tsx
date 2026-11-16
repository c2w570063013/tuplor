import { useQuery } from '@tanstack/react-query';
import { Check, Copy, FileCode2, FunctionSquare, Plus, RefreshCw, ShieldCheck, Trash2, Unlink, Zap } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { GrantDetail, PartitionDetail, TableDetails, TriggerDetail } from '@shared/schema';
import { SqlBlock } from '@/components/SqlBlock';
import { Badge, Button, Checkbox, Dialog, Field, Input, Select, Switch, Tooltip } from '@/components/ui';
import { runSql } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatBytes, formatCount } from '@/lib/format';
import { useWorkspace } from '@/stores/workspace';
import { confirmWithOptions, dropObject, maintenance, openData, openObjectTab, openStructure } from '../../explorer/actions';
import { runDdl, schemaApi, schemaKeys } from '../api';
import { fq, qi } from '../sqlgen';
import { Card, CodeView, CopyButton, DataTable, EmptyBlock, ErrorState, KeyValue, Loading, Mono, SectionToolbar, StatCard, relTime, type Col } from '../ui';

// ------------------------------------------------------------------ triggers

export function TriggersSection({ t, connId, db }: { t: TableDetails; connId: string; db: string }) {
  const tref = fq(t.schema, t.name);
  const toggle = (tr: TriggerDetail) =>
    runDdl({ connId, db, title: '', skipConfirm: true, statements: [`ALTER TABLE ${tref} ${tr.enabled === 'D' ? 'ENABLE' : 'DISABLE'} TRIGGER ${qi(tr.name)}`], success: `Trigger ${tr.name} ${tr.enabled === 'D' ? 'enabled' : 'disabled'}` });
  const drop = (tr: TriggerDetail) =>
    runDdl({ connId, db, title: `Drop trigger ${tr.name}?`, danger: true, confirmLabel: 'Drop', statements: [`DROP TRIGGER ${qi(tr.name)} ON ${tref}`], success: `Dropped ${tr.name}` });
  const newTrigger = () =>
    useWorkspace.getState().newQuery({
      connId, database: db, title: 'New trigger',
      sql: `CREATE OR REPLACE FUNCTION ${qi(t.schema)}.${qi(t.name + '_trg')}()\nRETURNS trigger\nLANGUAGE plpgsql\nAS $$\nBEGIN\n  -- NEW / OLD are available here\n  RETURN NEW;\nEND;\n$$;\n\nCREATE TRIGGER ${qi(t.name + '_trg')}\n  BEFORE INSERT OR UPDATE ON ${tref}\n  FOR EACH ROW\n  EXECUTE FUNCTION ${qi(t.schema)}.${qi(t.name + '_trg')}();\n`,
    });
  const cols: Col<TriggerDetail>[] = [
    {
      key: 'en', header: 'Enabled', width: 70, render: (tr) => (
        <Switch checked={tr.enabled !== 'D'} onCheckedChange={() => toggle(tr)} disabled={tr.isInherited} />
      ),
    },
    { key: 'name', header: 'Name', render: (tr) => <span className={cn('font-medium', tr.enabled === 'D' ? 'text-subtle' : 'text-fg')}>{tr.name}</span> },
    {
      key: 'when', header: 'When', render: (tr) => (
        <span className="flex flex-wrap items-center gap-1">
          <Badge tone="accent">{tr.timing}</Badge>
          {tr.events.map((e) => <Badge key={e}>{e}</Badge>)}
          <span className="text-[11px] text-subtle">for each {tr.level.toLowerCase()}</span>
        </span>
      ),
    },
    {
      key: 'fn', header: 'Function', render: (tr) => (
        <button className="inline-flex items-center gap-1 text-info hover:underline" onClick={() => openObjectTab(connId, db, { schema: tr.functionSchema, name: tr.functionName, kind: 'function', oid: tr.functionOid })}>
          <FunctionSquare size={12} /> {tr.functionSchema}.{tr.functionName}()
        </button>
      ),
    },
    { key: 'flags', header: '', render: (tr) => <span className="flex gap-1">{tr.isInherited && <Badge>inherited</Badge>}{tr.isConstraint && <Badge>constraint</Badge>}{tr.enabled === 'R' && <Badge>replica</Badge>}{tr.enabled === 'A' && <Badge>always</Badge>}</span> },
    { key: 'act', header: '', width: 40, render: (tr) => !tr.isInherited && <button aria-label="Drop trigger" className="rounded p-1 text-muted opacity-0 group-hover:opacity-100 hover:text-danger" onClick={() => drop(tr)}><Trash2 size={13} /></button> },
  ];
  return (
    <>
      <SectionToolbar title="Triggers" count={t.triggers.length}>
        <Button size="sm" variant="outline" icon={<Plus size={13} />} onClick={newTrigger}>New trigger</Button>
      </SectionToolbar>
      <DataTable
        className="min-h-0 flex-1"
        columns={cols}
        rows={t.triggers}
        rowKey={(tr) => String(tr.oid)}
        rowMenu={(tr) => [
          { label: 'Open function', icon: <FunctionSquare size={14} />, onSelect: () => openObjectTab(connId, db, { schema: tr.functionSchema, name: tr.functionName, kind: 'function', oid: tr.functionOid }) },
          { label: tr.enabled === 'D' ? 'Enable' : 'Disable', icon: <Zap size={14} />, onSelect: () => toggle(tr) },
          { label: 'Copy definition', icon: <Copy size={14} />, onSelect: () => navigator.clipboard.writeText(tr.definition + ';') },
          'separator',
          { label: 'Drop trigger…', icon: <Trash2 size={14} />, danger: true, disabled: tr.isInherited, onSelect: () => drop(tr) },
        ]}
        empty={<EmptyBlock icon={<Zap size={24} />} title="No triggers" description="Triggers run a function automatically when rows are inserted, updated or deleted." />}
      />
      {t.triggers.length > 0 && (
        <div className="shrink-0 border-t border-border p-3">
          <SqlBlock sql={t.triggers.map((tr) => tr.definition + ';').join('\n')} className="max-h-40" />
        </div>
      )}
    </>
  );
}

// ------------------------------------------------------------------ partitions

function boundTemplate(key: string | null): string {
  const k = (key ?? '').toUpperCase();
  if (k.startsWith('RANGE')) return "FROM ('2027-01-01') TO ('2027-07-01')";
  if (k.startsWith('LIST')) return "IN ('value')";
  if (k.startsWith('HASH')) return 'WITH (MODULUS 4, REMAINDER 0)';
  return '';
}

export function PartitionsSection({ t, connId, db }: { t: TableDetails; connId: string; db: string }) {
  const [adding, setAdding] = useState(false);
  const total = t.partitions.reduce((s, p) => s + p.sizeBytes, 0) || 1;
  const detach = async (p: PartitionDetail) => {
    const stmts = await confirmWithOptions({
      title: `Detach partition “${p.name}”?`,
      description: 'The partition becomes a standalone table; its rows are no longer visible through the parent.',
      options: [{ key: 'concurrently', label: 'Concurrently', hint: 'Avoid blocking queries on the parent (PostgreSQL 14+)' }],
      confirmLabel: 'Detach',
      build: (o) => [`ALTER TABLE ${fq(t.schema, t.name)} DETACH PARTITION ${fq(p.schema, p.name)}${o.concurrently ? ' CONCURRENTLY' : ''}`],
    });
    if (stmts) await runDdl({ connId, db, title: '', skipConfirm: true, statements: stmts, transaction: !stmts[0].endsWith('CONCURRENTLY'), success: `Detached ${p.name}` });
  };
  const cols: Col<PartitionDetail>[] = [
    { key: 'name', header: 'Partition', render: (p) => <button className="font-medium text-fg hover:text-accent hover:underline" onClick={() => openStructure(connId, db, p.schema, p.name, p.kind)}>{p.schema === t.schema ? p.name : `${p.schema}.${p.name}`}</button> },
    { key: 'bound', header: 'Bound', render: (p) => <Mono className="text-syntax-string">{p.bound}</Mono> },
    { key: 'kind', header: '', width: 100, render: (p) => p.kind === 'partitioned_table' && <Badge tone="accent">sub-partitioned</Badge> },
    { key: 'rows', header: 'Rows (est.)', width: 110, align: 'right', render: (p) => formatCount(p.estRows) },
    {
      key: 'size', header: 'Size', width: 160, align: 'right', render: (p) => (
        <span className="flex items-center justify-end gap-2">
          <span className="h-1.5 w-16 overflow-hidden rounded-full bg-active"><span className="block h-full rounded-full bg-accent" style={{ width: `${Math.max(2, (p.sizeBytes / total) * 100)}%` }} /></span>
          <span className="w-16">{formatBytes(p.sizeBytes)}</span>
        </span>
      ),
    },
  ];
  return (
    <>
      <SectionToolbar title="Partitions" count={t.partitions.length} description={t.partitionKey ? <>Partitioned by <Mono className="text-fg">{t.partitionKey}</Mono></> : undefined}>
        {t.partitionKey && <Button size="sm" variant="outline" icon={<Plus size={13} />} onClick={() => setAdding(true)}>New partition</Button>}
      </SectionToolbar>
      {t.partitionOf && (
        <div className="mx-4 mb-3 flex items-center gap-2 rounded-md border border-border bg-panel px-3 py-2 text-[12.5px]">
          This table is a partition of
          <button className="font-medium text-accent hover:underline" onClick={() => openStructure(connId, db, t.partitionOf!.schema, t.partitionOf!.name)}>{t.partitionOf.schema}.{t.partitionOf.name}</button>
          <Mono className="text-syntax-string">{t.partitionOf.bound}</Mono>
        </div>
      )}
      <DataTable
        className="min-h-0 flex-1"
        columns={cols}
        rows={t.partitions}
        rowKey={(p) => String(p.oid)}
        onRowDoubleClick={(p) => openStructure(connId, db, p.schema, p.name, p.kind)}
        rowMenu={(p) => [
          { label: 'Open data', onSelect: () => openData(connId, db, { schema: p.schema, name: p.name, kind: p.kind }) },
          { label: 'Structure', onSelect: () => openStructure(connId, db, p.schema, p.name, p.kind) },
          'separator',
          { label: 'Detach…', icon: <Unlink size={14} />, onSelect: () => detach(p) },
          { label: 'Drop partition…', icon: <Trash2 size={14} />, danger: true, onSelect: () => dropObject(connId, db, 'table', p.schema, p.name) },
        ]}
        empty={t.partitionKey ? <EmptyBlock title="No partitions yet" description="Rows can only be inserted once a matching partition exists." action={<Button size="sm" variant="primary" icon={<Plus size={13} />} onClick={() => setAdding(true)}>New partition</Button>} /> : <EmptyBlock title="Not partitioned" />}
      />
      {adding && <PartitionDialog t={t} connId={connId} db={db} onClose={() => setAdding(false)} />}
    </>
  );
}

function PartitionDialog({ t, connId, db, onClose }: { t: TableDetails; connId: string; db: string; onClose: () => void }) {
  const [name, setName] = useState(`${t.name}_p${t.partitions.length + 1}`);
  const [bound, setBound] = useState(boundTemplate(t.partitionKey));
  const [isDefault, setIsDefault] = useState(false);
  const [busy, setBusy] = useState(false);
  const sql = `CREATE TABLE ${fq(t.schema, name)} PARTITION OF ${fq(t.schema, t.name)}\n  ${isDefault ? 'DEFAULT' : `FOR VALUES ${bound}`}`;
  const submit = async () => {
    setBusy(true);
    const ok = await runDdl({ connId, db, title: '', skipConfirm: true, statements: [sql], success: `Partition ${name} created` });
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="New partition" description={`of ${t.schema}.${t.name} · ${t.partitionKey}`} width={560}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!name.trim() || (!isDefault && !bound.trim())} onClick={submit}>Create partition</Button></>}>
      <div className="flex flex-col gap-4">
        <Field label="Name"><Input mono value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
        <Field label="Bound (FOR VALUES …)" hint={t.partitions.length ? `Existing: ${t.partitions.slice(-2).map((p) => p.bound).join('  ·  ')}` : undefined}>
          <Input mono value={bound} disabled={isDefault} onChange={(e) => setBound(e.target.value)} />
        </Field>
        <label className="flex items-center gap-2 text-[12.5px]"><Checkbox checked={isDefault} onCheckedChange={setIsDefault} /> Default partition <span className="text-subtle">(catches rows matching no other partition)</span></label>
        <SqlBlock sql={sql + ';'} />
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------ storage & stats

export function StatsSection({ t, connId, db }: { t: TableDetails; connId: string; db: string }) {
  const s = t.stats;
  const parts = [
    { label: 'Table', v: s.tableBytes, cls: 'bg-accent' },
    { label: 'Indexes', v: s.indexBytes, cls: 'bg-info' },
    { label: 'TOAST', v: s.toastBytes, cls: 'bg-syntax-keyword' },
  ];
  const sum = Math.max(1, parts.reduce((a, p) => a + p.v, 0));
  const deadPct = s.liveTuples != null && s.deadTuples != null && s.liveTuples + s.deadTuples > 0 ? s.deadTuples / (s.liveTuples + s.deadTuples) : 0;
  const idxPct = s.seqScan != null && s.idxScan != null && s.seqScan + s.idxScan > 0 ? s.idxScan / (s.seqScan + s.idxScan) : null;
  const maint = (op: Parameters<typeof maintenance>[4]) => maintenance(connId, db, t.schema, t.name, op);
  return (
    <div className="min-h-0 flex-1 overflow-auto p-4">
      <div className="mx-auto flex max-w-5xl flex-col gap-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatCard label="Total size" value={formatBytes(s.totalBytes)} sub={`${formatCount(s.pages)} pages`} />
          <StatCard label="Rows (estimate)" value={formatCount(s.estRows)} sub={s.liveTuples != null ? `${s.liveTuples.toLocaleString()} live tuples` : undefined} />
          <StatCard label="Dead tuples" value={formatCount(s.deadTuples ?? 0)} sub={`${(deadPct * 100).toFixed(1)}% of tuples`} tone={deadPct > 0.2 ? 'danger' : deadPct > 0.05 ? 'warning' : undefined} />
          <StatCard label="Index usage" value={idxPct == null ? '—' : `${Math.round(idxPct * 100)}%`} sub={`${formatCount(s.idxScan ?? 0)} index · ${formatCount(s.seqScan ?? 0)} seq scans`} tone={idxPct != null && idxPct < 0.5 && (s.seqScan ?? 0) > 100 ? 'warning' : undefined} />
        </div>

        <Card title="Disk usage">
          <div className="flex h-3 overflow-hidden rounded-full bg-active">
            {parts.map((p) => p.v > 0 && <Tooltip key={p.label} content={`${p.label}: ${formatBytes(p.v)}`}><div className={cn('h-full', p.cls)} style={{ width: `${(p.v / sum) * 100}%` }} /></Tooltip>)}
          </div>
          <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-[12.5px]">
            {parts.map((p) => (
              <span key={p.label} className="flex items-center gap-2"><span className={cn('h-2.5 w-2.5 rounded-sm', p.cls)} /> {p.label} <span className="font-medium text-fg tabular-nums">{formatBytes(p.v)}</span><span className="text-subtle">{Math.round((p.v / sum) * 100)}%</span></span>
            ))}
          </div>
          {t.indexes.length > 0 && (
            <div className="mt-4 flex flex-col gap-1.5">
              {[...t.indexes].sort((a, b) => b.sizeBytes - a.sizeBytes).map((i) => (
                <div key={i.oid} className="flex items-center gap-3 text-[12px]">
                  <span className="w-56 truncate text-muted" title={i.name}>{i.name}</span>
                  <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-active"><span className="block h-full rounded-full bg-info" style={{ width: `${Math.max(1, (i.sizeBytes / Math.max(1, s.indexBytes)) * 100)}%` }} /></span>
                  <span className="w-16 text-right tabular-nums">{formatBytes(i.sizeBytes)}</span>
                  <span className="w-24 text-right text-subtle tabular-nums">{i.scans == null ? '' : `${formatCount(i.scans)} scans`}</span>
                </div>
              ))}
            </div>
          )}
        </Card>

        <div className="grid gap-4 md:grid-cols-2">
          <Card title="Activity" actions={<span className="text-[11px] text-subtle">since stats reset</span>}>
            <KeyValue items={[
              ['Inserted', (s.inserts ?? 0).toLocaleString()],
              ['Updated', <>{(s.updates ?? 0).toLocaleString()} <span className="text-subtle">({(s.hotUpdates ?? 0).toLocaleString()} HOT)</span></>],
              ['Deleted', (s.deletes ?? 0).toLocaleString()],
              ['Sequential scans', <>{(s.seqScan ?? 0).toLocaleString()} <span className="text-subtle">· {formatCount(s.seqTupRead ?? 0)} rows read</span></>],
              ['Index scans', <>{(s.idxScan ?? 0).toLocaleString()} <span className="text-subtle">· {formatCount(s.idxTupFetch ?? 0)} rows fetched</span></>],
              ['Modified since analyze', (s.modsSinceAnalyze ?? 0).toLocaleString()],
            ]} />
          </Card>
          <Card title="Maintenance" actions={
            <div className="flex gap-1">
              <Button size="xs" variant="outline" onClick={() => maint('VACUUM ANALYZE')}>Vacuum analyze</Button>
              <Button size="xs" variant="outline" onClick={() => maint('ANALYZE')}>Analyze</Button>
              <Button size="xs" variant="outline" onClick={() => maint('REINDEX')}>Reindex</Button>
            </div>
          }>
            <KeyValue items={[
              ['Last vacuum', <Ts v={s.lastVacuum} n={s.vacuumCount} />],
              ['Last autovacuum', <Ts v={s.lastAutovacuum} n={s.autovacuumCount} />],
              ['Last analyze', <Ts v={s.lastAnalyze} n={s.analyzeCount} />],
              ['Last autoanalyze', <Ts v={s.lastAutoanalyze} n={s.autoanalyzeCount} />],
            ]} />
            <div className="mt-3 flex justify-end">
              <Button size="xs" variant="ghost" className="text-danger" onClick={() => maint('VACUUM FULL')}>Vacuum full…</Button>
            </div>
          </Card>
        </div>

        <Card title="Storage">
          <KeyValue items={[
            ['Owner', t.owner],
            ['Persistence', t.persistence === 'u' ? 'Unlogged' : t.persistence === 't' ? 'Temporary' : 'Permanent'],
            ['Access method', t.accessMethod],
            ['Tablespace', t.tablespace ?? 'default'],
            ['Storage options', t.options.length ? <Mono>{t.options.join(', ')}</Mono> : null],
            ['Row level security', t.rlsEnabled ? (t.rlsForced ? 'Enabled (forced)' : 'Enabled') : 'Disabled'],
            ['OID', <Mono>{t.oid}</Mono>],
          ]} />
        </Card>
      </div>
    </div>
  );
}

function Ts({ v, n }: { v: string | null; n: number | null }) {
  return (
    <span title={v ? new Date(v).toLocaleString() : undefined} className={cn(!v && 'text-subtle')}>
      {relTime(v)}{n != null && n > 0 && <span className="text-subtle"> · {n}×</span>}
    </span>
  );
}

// ------------------------------------------------------------------ permissions

const PRIVS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'];

export function PermissionsSection({ t, connId, db }: { t: TableDetails; connId: string; db: string }) {
  const [granting, setGranting] = useState(false);
  const tableGrants = t.grants.filter((g) => !g.column);
  const colGrants = t.grants.filter((g) => g.column);
  const privs = PRIVS.filter((p) => p !== 'MAINTAIN' || tableGrants.some((g) => g.privilege === 'MAINTAIN'));
  const byRole = useMemo(() => {
    const m = new Map<string, Map<string, GrantDetail>>();
    for (const g of tableGrants) {
      if (!m.has(g.grantee)) m.set(g.grantee, new Map());
      m.get(g.grantee)!.set(g.privilege, g);
    }
    return [...m.entries()];
  }, [tableGrants]);
  const tref = fq(t.schema, t.name);
  const who = (r: string) => (r === 'PUBLIC' ? 'PUBLIC' : qi(r));
  const revoke = (role: string, priv: string) => runDdl({ connId, db, title: 'Revoke privilege', statements: [`REVOKE ${priv} ON ${tref} FROM ${who(role)}`], success: `Revoked ${priv} from ${role}`, confirmLabel: 'Revoke', danger: true });
  const grant = (role: string, priv: string) => runDdl({ connId, db, title: 'Grant privilege', statements: [`GRANT ${priv} ON ${tref} TO ${who(role)}`], success: `Granted ${priv} to ${role}`, confirmLabel: 'Grant' });
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <SectionToolbar title="Privileges" count={byRole.length} description={`Owner: ${t.owner}. Click a cell to grant or revoke.`}>
        <Button size="sm" variant="outline" icon={<Plus size={13} />} onClick={() => setGranting(true)}>Grant…</Button>
      </SectionToolbar>
      <DataTable
        columns={[
          { key: 'role', header: 'Role', render: ([r]) => <span className="flex items-center gap-1.5 font-medium text-fg">{r}{r === t.owner && <Badge tone="accent">owner</Badge>}</span> },
          ...privs.map<Col<[string, Map<string, GrantDetail>]>>((p) => ({
            key: p, header: p, align: 'center', width: 92,
            render: ([r, m]) => {
              const g = m.get(p);
              return (
                <Tooltip content={g ? `Revoke ${p} from ${r}` : `Grant ${p} to ${r}`}>
                  <button onClick={() => (g ? revoke(r, p) : grant(r, p))} className={cn('inline-flex h-6 w-6 items-center justify-center rounded hover:bg-active', g ? 'text-success' : 'text-border-strong')}>
                    {g ? <Check size={14} strokeWidth={2.5} /> : <span className="h-1 w-1 rounded-full bg-current" />}
                  </button>
                </Tooltip>
              );
            },
          })),
          { key: 'go', header: 'Grant option', align: 'center', render: ([, m]) => ([...m.values()].some((g) => g.grantable) ? <ShieldCheck size={14} className="inline text-warning" /> : null) },
        ]}
        rows={byRole}
        rowKey={([r]) => r}
        empty={<EmptyBlock title="No privileges" />}
      />
      {colGrants.length > 0 && (
        <>
          <SectionToolbar title="Column privileges" count={colGrants.length} />
          <DataTable columns={[
            { key: 'r', header: 'Role', render: (g) => g.grantee },
            { key: 'c', header: 'Column', render: (g) => <Mono>{g.column}</Mono> },
            { key: 'p', header: 'Privilege', render: (g) => <Badge>{g.privilege}</Badge> },
            { key: 'b', header: 'Granted by', render: (g) => <span className="text-muted">{g.grantor}</span> },
          ]} rows={colGrants} rowKey={(g, i) => `${g.grantee}${g.column}${g.privilege}${i}`} />
        </>
      )}
      <SectionToolbar title="Row level security" description={t.rlsEnabled ? `Enabled${t.rlsForced ? ' and forced for the owner' : ''}.` : 'Disabled — all rows are visible to roles with SELECT.'}>
        <Button size="sm" variant="outline" onClick={() => runDdl({ connId, db, title: `${t.rlsEnabled ? 'Disable' : 'Enable'} row level security`, statements: [`ALTER TABLE ${tref} ${t.rlsEnabled ? 'DISABLE' : 'ENABLE'} ROW LEVEL SECURITY`], success: `RLS ${t.rlsEnabled ? 'disabled' : 'enabled'}`, confirmLabel: t.rlsEnabled ? 'Disable' : 'Enable' })}>
          {t.rlsEnabled ? 'Disable RLS' : 'Enable RLS'}
        </Button>
      </SectionToolbar>
      {t.policies.length > 0 && (
        <DataTable columns={[
          { key: 'n', header: 'Policy', render: (p) => <span className="font-medium">{p.name}</span> },
          { key: 'c', header: 'Command', render: (p) => <Badge>{p.cmd}</Badge> },
          { key: 't', header: 'Type', render: (p) => <span className="text-muted">{p.permissive.toLowerCase()}</span> },
          { key: 'r', header: 'Roles', render: (p) => p.roles.join(', ') },
          { key: 'u', header: 'Using', render: (p) => p.using && <Mono>{p.using}</Mono> },
          { key: 'k', header: 'With check', render: (p) => p.check && <Mono>{p.check}</Mono> },
        ]} rows={t.policies} rowKey={(p) => p.name}
          rowMenu={(p) => [{ label: 'Drop policy…', icon: <Trash2 size={14} />, danger: true, onSelect: () => runDdl({ connId, db, title: `Drop policy ${p.name}?`, danger: true, confirmLabel: 'Drop', statements: [`DROP POLICY ${qi(p.name)} ON ${tref}`], success: `Dropped ${p.name}` }) }]} />
      )}
      {granting && <GrantDialog t={t} connId={connId} db={db} onClose={() => setGranting(false)} />}
    </div>
  );
}

function GrantDialog({ t, connId, db, onClose }: { t: TableDetails; connId: string; db: string; onClose: () => void }) {
  const roles = useQuery({
    queryKey: ['roles-list', connId],
    queryFn: async () => (await runSql(connId, db, `SELECT rolname FROM pg_roles WHERE rolname !~ '^pg_' ORDER BY 1`)).rows.map((r) => String(r[0])),
  });
  const [role, setRole] = useState('PUBLIC');
  const [privs, setPrivs] = useState<string[]>(['SELECT']);
  const [withGrant, setWithGrant] = useState(false);
  const [busy, setBusy] = useState(false);
  const sql = `GRANT ${privs.length === PRIVS.length ? 'ALL' : privs.join(', ') || '…'} ON ${fq(t.schema, t.name)} TO ${role === 'PUBLIC' ? 'PUBLIC' : qi(role)}${withGrant ? ' WITH GRANT OPTION' : ''}`;
  const submit = async () => {
    setBusy(true);
    const ok = await runDdl({ connId, db, title: '', skipConfirm: true, statements: [sql], success: `Granted to ${role}` });
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Grant privileges" description={`on ${t.schema}.${t.name}`} width={520}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!privs.length} onClick={submit}>Grant</Button></>}>
      <div className="flex flex-col gap-4">
        <Field label="Role"><Select value={role} onChange={(e) => setRole(e.target.value)} options={[{ value: 'PUBLIC', label: 'PUBLIC (every role)' }, ...(roles.data ?? []).map((r) => ({ value: r, label: r }))]} /></Field>
        <Field label="Privileges">
          <div className="grid grid-cols-4 gap-2">
            {PRIVS.map((p) => (
              <label key={p} className="flex items-center gap-2 text-[12px]"><Checkbox checked={privs.includes(p)} onCheckedChange={(v) => setPrivs((l) => (v ? [...l, p] : l.filter((x) => x !== p)))} />{p}</label>
            ))}
          </div>
        </Field>
        <label className="flex items-center gap-2 text-[12.5px]"><Checkbox checked={withGrant} onCheckedChange={setWithGrant} /> With grant option</label>
        <SqlBlock sql={sql + ';'} />
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------ DDL

export function DdlSection({ t, connId, db }: { t: TableDetails; connId: string; db: string }) {
  const q = useQuery({ queryKey: schemaKeys.ddl(connId, db, t.schema, t.name), queryFn: () => schemaApi.tableDdl(connId, db, t.schema, t.name) });
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SectionToolbar title="DDL" description="Generated from the system catalog: table, constraints, indexes, triggers, comments, owner and grants.">
        <Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} onClick={() => q.refetch()}>Refresh</Button>
        {q.data && <CopyButton text={q.data} />}
        <Button size="sm" variant="outline" icon={<FileCode2 size={13} />} disabled={!q.data} onClick={() => useWorkspace.getState().newQuery({ connId, database: db, sql: q.data, title: `${t.name}.sql` })}>Open in editor</Button>
      </SectionToolbar>
      <div className="min-h-0 flex-1 border-t border-border">
        {q.isLoading ? <Loading /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : <CodeView className="h-full" value={q.data ?? ''} />}
      </div>
    </div>
  );
}
