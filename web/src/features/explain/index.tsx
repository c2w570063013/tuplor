import { Check, ChevronDown, ChevronRight, Database, Play, Workflow } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { QueryError } from '@shared/types';
import { Badge, Button, DropdownMenu, EmptyState, Spinner, Toolbar, ToolbarDivider, type MenuItem } from '@/components/ui';
import { SqlBlock } from '@/components/SqlBlock';
import { confirm } from '@/stores/dialogs';
import { useWorkspace } from '@/stores/workspace';
import { isDataModifying } from '@/features/sql-editor/sqlText';
import { ErrorCard } from '@/features/sql-editor/Results';
import type { TabProps } from '../common/TabProps';
import { parseExplain, type ExplainResult } from './plan';
import { PlanView } from './PlanView';
import { defaultExplainOptions, runExplain, stripExplain, type ExplainOptions } from './runExplain';

/**
 * Query plan tab (kind `explain`): params { sql, plan?: JSON string | object, analyze?: boolean, explainOpts? }.
 * Opened from the SQL editor ("open plan in tab") or by other features that want to explain a query.
 */
export default function ExplainTab({ tab }: TabProps) {
  const sql: string = tab.params.sql ?? '';
  const opts: ExplainOptions = { ...defaultExplainOptions, ...(tab.params.explainOpts ?? {}) };
  const initial = useMemo<ExplainResult | null>(() => {
    if (!tab.params.plan) return null;
    try { return parseExplain(tab.params.plan); } catch { return null; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [result, setResult] = useState<ExplainResult | null>(initial);
  const [error, setError] = useState<QueryError | null>(null);
  const [running, setRunning] = useState(false);
  const [showSql, setShowSql] = useState(false);
  const started = useRef(false);

  const run = async (analyze: boolean) => {
    if (!tab.connId || !tab.database || !sql.trim()) return;
    if (analyze && isDataModifying(stripExplain(sql)) && !(await confirm({
      title: 'Run EXPLAIN ANALYZE on a data-modifying statement?',
      message: 'The statement is executed inside a transaction and rolled back afterwards.',
      confirmLabel: 'Execute & roll back',
      danger: true,
    }))) return;
    setRunning(true);
    setError(null);
    const r = await runExplain({ connId: tab.connId, db: tab.database, sql, options: { ...opts, analyze } });
    setRunning(false);
    if (r.error) setError(r.error);
    else if (r.result) {
      setResult(r.result);
      useWorkspace.getState().updateParams(tab.id, { analyze, plan: JSON.stringify(r.result.raw) });
    }
  };

  useEffect(() => {
    if (!initial && !started.current && sql) {
      started.current = true;
      void run(!!tab.params.analyze);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setOpt = (k: keyof ExplainOptions) => useWorkspace.getState().updateParams(tab.id, { explainOpts: { ...opts, [k]: !opts[k] } });
  const optItems: MenuItem[] = [
    { heading: 'EXPLAIN options' },
    { label: 'BUFFERS', icon: opts.buffers ? <Check size={13} /> : null, onSelect: () => setOpt('buffers') },
    { label: 'VERBOSE', icon: opts.verbose ? <Check size={13} /> : null, onSelect: () => setOpt('verbose') },
    { label: 'SETTINGS', icon: opts.settings ? <Check size={13} /> : null, onSelect: () => setOpt('settings') },
  ];

  return (
    <div className="flex h-full flex-col">
      <Toolbar>
        <Workflow size={14} className="ml-1 text-accent" />
        <span className="mr-1 text-xs font-medium text-fg">Query plan</span>
        {result && <Badge tone={result.analyzed ? 'success' : 'neutral'}>{result.analyzed ? 'ANALYZE' : 'estimate'}</Badge>}
        <ToolbarDivider />
        <Button size="sm" variant="ghost" icon={<Workflow size={13} />} disabled={running || !tab.connId} onClick={() => run(false)}>Explain</Button>
        <Button size="sm" variant="ghost" icon={<Play size={12} />} disabled={running || !tab.connId} onClick={() => run(true)}>Explain analyze</Button>
        <DropdownMenu items={optItems} trigger={<Button size="sm" variant="ghost">Options <ChevronDown size={12} /></Button>} />
        <div className="flex-1" />
        {tab.database && <span className="flex items-center gap-1 text-xs text-muted"><Database size={12} />{tab.database}</span>}
      </Toolbar>
      {sql && (
        <div className="shrink-0 border-b border-border">
          <button className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-xs text-muted hover:text-fg" onClick={() => setShowSql((s) => !s)}>
            {showSql ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <span className="truncate font-mono">{sql.replace(/\s+/g, ' ').slice(0, 200)}</span>
          </button>
          {showSql && <div className="px-3 pb-2"><SqlBlock sql={sql} className="max-h-48" /></div>}
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        {error ? (
          <div className="p-3"><ErrorCard error={error} /></div>
        ) : result ? (
          <PlanView result={result} onRerun={() => run(result.analyzed)} />
        ) : running ? null : (
          <EmptyState icon={<Workflow size={22} />} title="No plan" description={sql ? 'Run Explain to see the query plan.' : 'Open a plan from the SQL editor (Explain → open in tab).'} />
        )}
        {running && (
          <div className="absolute inset-0 flex items-center justify-center bg-bg/60"><Spinner size={18} /></div>
        )}
      </div>
    </div>
  );
}
