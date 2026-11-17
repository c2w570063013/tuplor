import type { QueryError, TxStatus } from '@shared/types';
import { api } from '@/lib/api';
import { uid } from '@/lib/format';
import { isDataModifying, maskSql } from '@/features/sql-editor/sqlText';
import { parseExplain, type ExplainResult } from './plan';

export interface ExplainOptions {
  analyze: boolean;
  buffers: boolean;
  verbose: boolean;
  settings?: boolean;
}

export const defaultExplainOptions: ExplainOptions = { analyze: false, buffers: true, verbose: false, settings: false };

/** Strip a leading EXPLAIN [(...)] [ANALYZE] [VERBOSE] so users can explain an EXPLAIN statement. */
export function stripExplain(sql: string): string {
  const masked = maskSql(sql);
  const m = /^\s*EXPLAIN\b\s*(\([^)]*\))?\s*(ANALY[SZ]E\b\s*)?(VERBOSE\b\s*)?/i.exec(masked);
  return (m ? sql.slice(m[0].length) : sql).trim().replace(/;\s*$/, '');
}

export function explainSql(sql: string, o: ExplainOptions): string {
  const opts = ['FORMAT JSON'];
  if (o.analyze) opts.unshift('ANALYZE');
  if (o.buffers) opts.push('BUFFERS');
  if (o.verbose) opts.push('VERBOSE');
  if (o.settings) opts.push('SETTINGS');
  return `EXPLAIN (${opts.join(', ')})\n${stripExplain(sql)}`;
}

export interface ExplainRun {
  result?: ExplainResult;
  error?: QueryError;
  txStatus?: TxStatus;
}

/**
 * Run EXPLAIN. With ANALYZE on a data-modifying statement the work is rolled back:
 *  - on an idle session / pool: `rollback: true` (BEGIN … ROLLBACK server side)
 *  - inside an open transaction: wrapped in SAVEPOINT … ROLLBACK TO SAVEPOINT
 */
export async function runExplain(p: {
  connId: string;
  db: string;
  sql: string;
  options: ExplainOptions;
  sessionId?: string;
  txStatus?: TxStatus;
  queryId?: string;
}): Promise<ExplainRun> {
  const stmt = explainSql(p.sql, p.options);
  const modifying = p.options.analyze && isDataModifying(stripExplain(p.sql));
  const queryId = p.queryId ?? uid('x');
  let sql = stmt;
  let rollback = false;
  let multi = false;
  if (modifying) {
    if (p.sessionId && p.txStatus === 'transaction') {
      sql = `SAVEPOINT tuplor_explain;\n${stmt};\nROLLBACK TO SAVEPOINT tuplor_explain;\nRELEASE SAVEPOINT tuplor_explain`;
      multi = true;
    } else rollback = true;
  }
  if (p.sessionId && p.txStatus === 'error') {
    return { error: { message: 'The current transaction is aborted. Roll back before running EXPLAIN.' }, txStatus: 'error' };
  }
  try {
    const res = await api.query(p.connId, p.db, { sql, queryId, sessionId: p.sessionId, rollback, multi, maxRows: 0 });
    if (res.error) {
      if (multi && p.sessionId) {
        // keep the user's transaction usable
        await api.query(p.connId, p.db, { sql: 'ROLLBACK TO SAVEPOINT tuplor_explain', sessionId: p.sessionId, multi: false }).catch(() => {});
      }
      return { error: res.error, txStatus: res.txStatus };
    }
    const rs = res.results.find((r) => r.command === 'EXPLAIN' || r.fields[0]?.name === 'QUERY PLAN');
    const cell = rs?.rows[0]?.[0];
    if (cell == null) return { error: { message: 'EXPLAIN returned no plan' }, txStatus: res.txStatus };
    const result = parseExplain(typeof cell === 'string' ? cell : JSON.stringify(cell));
    result.rolledBack = modifying;
    return { result, txStatus: res.txStatus };
  } catch (e: any) {
    return { error: e?.info ?? { message: e?.message ?? String(e) } };
  }
}
