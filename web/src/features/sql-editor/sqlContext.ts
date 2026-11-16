/**
 * Pure SQL context analysis for autocomplete / hover / signature help.
 * Works on a single statement: extracts table references (with aliases and CTE names)
 * and classifies what is expected at the cursor.
 */
import { maskSql } from './sqlText';

export interface Token {
  /** w = word, q = "quoted ident", p = punctuation, o = operator, n = number */
  t: 'w' | 'q' | 'p' | 'o' | 'n';
  /** identifier value (unquoted / case-folded for plain words) */
  v: string;
  /** uppercase raw text for keyword matching */
  u: string;
  start: number;
  end: number;
}

export function tokenize(masked: string): Token[] {
  const out: Token[] = [];
  const re = /("(?:[^"]|"")*"?)|([A-Za-z_\u00C0-\uFFFF][\w$\u00C0-\uFFFF]*)|(\d+(?:\.\d+)?)|(::|[(),.;[\]])|([<>=!%&|~^#@?+\-*/:]+)|('[^']*'?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked))) {
    const [raw, q, w, n, p, o, str] = m;
    if (q) out.push({ t: 'q', v: q.slice(1, q.endsWith('"') && q.length > 1 ? -1 : undefined).replace(/""/g, '"'), u: q, start: m.index, end: m.index + raw.length });
    else if (w) out.push({ t: 'w', v: w.toLowerCase(), u: w.toUpperCase(), start: m.index, end: m.index + raw.length });
    else if (n) out.push({ t: 'n', v: n, u: n, start: m.index, end: m.index + raw.length });
    else if (p) out.push({ t: 'p', v: p, u: p, start: m.index, end: m.index + raw.length });
    else if (o) out.push({ t: 'o', v: o, u: o, start: m.index, end: m.index + raw.length });
    else if (str) out.push({ t: 'n', v: "''", u: "''", start: m.index, end: m.index + raw.length });
  }
  return out;
}

/** Words that can never be a table alias. */
const NOT_ALIAS = new Set(
  ('WHERE JOIN ON LEFT RIGHT INNER OUTER FULL CROSS NATURAL GROUP ORDER LIMIT SET USING VALUES SELECT UNION RETURNING HAVING WINDOW ' +
    'OFFSET FETCH FOR DEFAULT EXCEPT INTERSECT TABLESAMPLE WITH DO AS AND OR NOT LATERAL ONLY INTO FROM WHEN THEN ELSE END ' +
    'OVERRIDING QUALIFY CASE IS IN LIKE ILIKE BETWEEN ASC DESC NULLS PARTITION').split(' '),
);

export interface TableRef {
  schema?: string;
  name: string;
  alias?: string;
  /** a CTE or subquery alias (no catalog relation) */
  virtual?: boolean;
  /** inside FROM/JOIN position index (for JOIN suggestions) */
  pos: number;
  /** derived columns for CTEs / subqueries when they can be determined */
  columns?: string[];
}

export interface StatementScope {
  refs: TableRef[];
  ctes: Map<string, string[] | undefined>;
}

const isIdent = (t?: Token) => !!t && (t.t === 'q' || (t.t === 'w' && !NOT_ALIAS.has(t.u)));

function skipParens(tokens: Token[], i: number): number {
  // tokens[i] is '('; returns index after matching ')'
  let depth = 0;
  for (; i < tokens.length; i++) {
    if (tokens[i].v === '(') depth++;
    else if (tokens[i].v === ')') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return i;
}

/** Best-effort output column names of a SELECT list inside tokens[a..b). */
function selectListColumns(tokens: Token[], a: number, b: number): string[] | undefined {
  let i = a;
  while (i < b && tokens[i].u !== 'SELECT') i++;
  if (i >= b) return undefined;
  i++;
  if (tokens[i]?.u === 'DISTINCT') i++;
  const cols: string[] = [];
  let depth = 0;
  let last: Token | undefined;
  let prev: Token | undefined;
  for (; i < b; i++) {
    const t = tokens[i];
    if (t.v === '(') depth++;
    else if (t.v === ')') depth--;
    if (depth === 0 && (t.v === ',' || t.u === 'FROM' || t.u === 'INTO')) {
      if (last && last.v !== '*') cols.push(last.v);
      last = undefined;
      prev = undefined;
      if (t.u === 'FROM' || t.u === 'INTO') return cols;
      continue;
    }
    if (depth === 0 && (t.t === 'w' || t.t === 'q')) {
      if (prev?.u === 'AS' || !prev || prev.v === '.' || isIdent(t)) last = t;
    } else if (depth === 0 && t.v === '*') last = t;
    prev = t;
  }
  if (last && last.v !== '*') cols.push(last.v);
  return cols;
}

/** Extract table references and CTEs from a (masked, keepIdents) statement. */
export function extractScope(tokens: Token[]): StatementScope {
  const refs: TableRef[] = [];
  const ctes = new Map<string, string[] | undefined>();
  let pos = 0;

  // CTEs: WITH [RECURSIVE] name [(cols)] AS [NOT] [MATERIALIZED] ( ... ) [, ...]
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].u !== 'WITH') continue;
    let j = i + 1;
    if (tokens[j]?.u === 'RECURSIVE') j++;
    while (j < tokens.length && isIdent(tokens[j])) {
      const name = tokens[j].v;
      j++;
      let cols: string[] | undefined;
      if (tokens[j]?.v === '(') {
        const e = skipParens(tokens, j);
        cols = tokens.slice(j + 1, e - 1).filter((t) => t.t === 'w' || t.t === 'q').map((t) => t.v);
        j = e;
      }
      if (tokens[j]?.u !== 'AS') break;
      j++;
      if (tokens[j]?.u === 'NOT') j++;
      if (tokens[j]?.u === 'MATERIALIZED') j++;
      if (tokens[j]?.v !== '(') { ctes.set(name, cols); break; }
      const e = skipParens(tokens, j);
      ctes.set(name, cols ?? selectListColumns(tokens, j + 1, e - 1));
      j = e;
      if (tokens[j]?.v === ',') j++;
      else break;
    }
  }

  const parseRef = (i: number, isInto = false): number => {
    while (tokens[i] && (tokens[i].u === 'ONLY' || tokens[i].u === 'LATERAL')) i++;
    const t = tokens[i];
    if (!t) return i;
    let ref: TableRef | undefined;
    if (t.v === '(') {
      const e = skipParens(tokens, i);
      ref = { name: '', virtual: true, pos: pos++, columns: selectListColumns(tokens, i + 1, e - 1) };
      i = e;
    } else if (t.t === 'w' || t.t === 'q') {
      if (t.t === 'w' && NOT_ALIAS.has(t.u)) return i;
      const parts = [t.v];
      i++;
      while (tokens[i]?.v === '.' && (tokens[i + 1]?.t === 'w' || tokens[i + 1]?.t === 'q')) {
        parts.push(tokens[i + 1].v);
        i += 2;
      }
      if (tokens[i]?.v === '(' && !isInto) {
        // set-returning function in FROM: generate_series(...) g
        i = skipParens(tokens, i);
        ref = { name: parts[parts.length - 1], virtual: true, pos: pos++ };
      } else {
        const name = parts[parts.length - 1];
        const schema = parts.length > 1 ? parts[parts.length - 2] : undefined;
        ref = { schema, name, pos: pos++ };
        if (!schema && ctes.has(name)) { ref.virtual = true; ref.columns = ctes.get(name); }
      }
    } else return i;
    if (tokens[i]?.u === 'AS') i++;
    if (isIdent(tokens[i]) && tokens[i].t !== 'p') {
      ref.alias = tokens[i].v;
      i++;
      if (tokens[i]?.v === '(') {
        const e = skipParens(tokens, i);
        ref.columns = tokens.slice(i + 1, e - 1).filter((x) => x.t === 'w' || x.t === 'q').map((x) => x.v);
        i = e;
      }
    }
    if (ref.name || ref.alias) refs.push(ref);
    return i;
  };

  for (let i = 0; i < tokens.length; i++) {
    const u = tokens[i].u;
    const prevU = tokens[i - 1]?.u;
    if (u === 'FROM' || u === 'JOIN' || (u === 'UPDATE' && prevU !== 'FOR' && prevU !== 'DO' && prevU !== 'KEY') || u === 'INTO' || (u === 'USING' && tokens[i + 1]?.v !== '(') || (u === 'TABLE' && prevU === 'TRUNCATE') || (u === 'TRUNCATE' && tokens[i + 1]?.u !== 'TABLE')) {
      if (u === 'FROM' && prevU === 'DISTINCT') continue; // IS DISTINCT FROM
      let j = parseRef(i + 1, u === 'INTO');
      if (u === 'FROM' || u === 'USING' || u === 'TRUNCATE' || u === 'TABLE') {
        while (tokens[j]?.v === ',') j = parseRef(j + 1);
      }
      i = Math.max(i, j - 1);
    }
  }
  return { refs, ctes };
}

export type CursorContext =
  | { kind: 'qualified'; parts: string[]; prefix: string }
  | { kind: 'relation'; prefix: string; afterJoin: boolean }
  | { kind: 'column'; prefix: string; clause: string; insertColumnsOf?: TableRef; afterOn?: boolean }
  | { kind: 'type'; prefix: string }
  | { kind: 'routine'; prefix: string }
  | { kind: 'keyword'; prefix: string; afterTable: boolean; first: boolean };

const RELATION_KW = new Set(['FROM', 'JOIN', 'UPDATE', 'INTO', 'TABLE', 'TRUNCATE', 'ONLY', 'LATERAL']);
const CLAUSE_KW = new Set([
  'SELECT', 'FROM', 'JOIN', 'WHERE', 'ON', 'AND', 'OR', 'BY', 'HAVING', 'SET', 'INTO', 'UPDATE', 'TABLE', 'VALUES', 'RETURNING',
  'USING', 'TRUNCATE', 'WHEN', 'THEN', 'ELSE', 'CALL', 'NOT', 'CASE', 'DISTINCT', 'ONLY', 'LATERAL', 'IN', 'EXISTS', 'LIMIT', 'OFFSET',
  'IS', 'LIKE', 'ILIKE', 'BETWEEN', 'OVER', 'PARTITION', 'WITH', 'AS', 'INSERT', 'DELETE', 'CONFLICT', 'DO',
]);

export interface Analysis {
  ctx: CursorContext;
  scope: StatementScope;
}

/**
 * Analyse `stmt` (raw text of the statement around the cursor) with the cursor at `offset`
 * (relative to stmt).
 */
export function analyze(stmt: string, offset: number): Analysis {
  const masked = maskSql(stmt, { keepIdents: true });
  const tokens = tokenize(masked);
  const scope = extractScope(tokens);
  const before = masked.slice(0, offset);

  // the word being typed
  let word = /[\w$\u00C0-\uFFFF]*$/.exec(before)![0];
  let headEnd = offset - word.length;
  // inside an unterminated "quoted identifier"?
  if ((before.match(/"/g) ?? []).length % 2 === 1) {
    const q = before.lastIndexOf('"');
    word = before.slice(q + 1);
    headEnd = q;
  }
  const prefix = word;

  // qualified: a.b.<prefix>
  const qm = /((?:(?:"(?:[^"]|"")+"|[\w$\u00C0-\uFFFF]+)\s*\.\s*)+)$/.exec(masked.slice(0, headEnd));
  if (qm) {
    const parts = [...qm[1].matchAll(/"((?:[^"]|"")+)"|([\w$\u00C0-\uFFFF]+)/g)].map((m) => (m[1] ? m[1].replace(/""/g, '"') : m[2].toLowerCase()));
    return { ctx: { kind: 'qualified', parts, prefix }, scope };
  }

  const prevTokens = tokens.filter((t) => t.end <= headEnd);
  const prev = prevTokens[prevTokens.length - 1];

  if (prev?.v === '::') return { ctx: { kind: 'type', prefix }, scope };
  if (!prev) return { ctx: { kind: 'keyword', prefix, afterTable: false, first: true }, scope };

  // last clause keyword before the cursor (at any depth, but stop at parens that close)
  let clause = '';
  let clauseIdx = -1;
  for (let i = prevTokens.length - 1; i >= 0; i--) {
    const t = prevTokens[i];
    if (t.t === 'w' && CLAUSE_KW.has(t.u)) { clause = t.u; clauseIdx = i; break; }
  }

  if (prev.t === 'w' && RELATION_KW.has(prev.u)) return { ctx: { kind: 'relation', prefix, afterJoin: prev.u === 'JOIN' }, scope };
  if (prev.v === ',' && (clause === 'FROM' || clause === 'TRUNCATE' || clause === 'TABLE' || clause === 'USING')) {
    // FROM a, | -> relation (only if every token since FROM is part of the ref list at depth 0)
    const since = prevTokens.slice(clauseIdx + 1);
    if (!since.some((t) => t.v === '(')) return { ctx: { kind: 'relation', prefix, afterJoin: false }, scope };
  }
  if (prev.u === 'CALL' || (prev.u === 'EXECUTE' && prevTokens[prevTokens.length - 2]?.u !== 'FOR')) return { ctx: { kind: 'routine', prefix }, scope };
  if ((prev.u === 'FUNCTION' || prev.u === 'PROCEDURE') && ['DROP', 'ALTER', 'REPLACE', 'COMMENT', 'ON'].includes(prevTokens[prevTokens.length - 2]?.u ?? '')) return { ctx: { kind: 'routine', prefix }, scope };

  // INSERT INTO t ( | -> columns of t
  if (clause === 'INTO') {
    const open = prevTokens.slice(clauseIdx).findIndex((t) => t.v === '(');
    const nameTok = open > 0 ? prevTokens[clauseIdx + open - 1] : undefined;
    const into = nameTok && scope.refs.find((r) => r.name === nameTok.v && !r.virtual);
    const closed = prevTokens.slice(clauseIdx).some((t) => t.v === ')');
    if (open >= 0 && !closed && into) return { ctx: { kind: 'column', prefix, clause, insertColumnsOf: into }, scope };
    if (open < 0) return { ctx: { kind: 'keyword', prefix, afterTable: true, first: false }, scope };
  }

  // just after a table reference (alias position or next clause)
  if (RELATION_KW.has(clause) && clause !== 'INTO') {
    const since = prevTokens.slice(clauseIdx + 1);
    if (since.length && !since.some((t) => t.v === '(' || t.t === 'o' || t.u === 'ON' || t.u === 'SET')) {
      return { ctx: { kind: 'keyword', prefix, afterTable: true, first: false }, scope };
    }
  }

  // type position in CREATE TABLE column definitions / CAST(x AS |)
  if (prev.u === 'AS' && isInsideCall(prevTokens, 'CAST')) return { ctx: { kind: 'type', prefix }, scope };
  if (isColumnDefinition(prevTokens)) return { ctx: { kind: 'type', prefix }, scope };

  return { ctx: { kind: 'column', prefix, clause, afterOn: prev.u === 'ON' }, scope };
}

function isInsideCall(prevTokens: Token[], fn: string): boolean {
  let depth = 0;
  for (let i = prevTokens.length - 1; i >= 0; i--) {
    const t = prevTokens[i];
    if (t.v === ')') depth++;
    else if (t.v === '(') {
      if (depth === 0) return prevTokens[i - 1]?.u === fn;
      depth--;
    }
  }
  return false;
}

/** CREATE TABLE x ( col | — previous token is a column name right after '(' or ',' inside the table body. */
function isColumnDefinition(prevTokens: Token[]): boolean {
  const n = prevTokens.length;
  if (n < 4) return false;
  const last = prevTokens[n - 1];
  const before = prevTokens[n - 2];
  if (!(last.t === 'w' || last.t === 'q') || !(before.v === '(' || before.v === ',')) return false;
  // find the opening paren of this list and check it follows CREATE TABLE name
  let depth = 0;
  for (let i = n - 2; i >= 0; i--) {
    const t = prevTokens[i];
    if (t.v === ')') depth++;
    else if (t.v === '(') {
      if (depth === 0) {
        const head = prevTokens.slice(Math.max(0, i - 8), i).map((x) => x.u);
        return head.includes('TABLE') && head.includes('CREATE') && !head.includes('AS');
      }
      depth--;
    }
  }
  return false;
}

/** For signature help: the function call enclosing `offset` and the active argument index. */
export function enclosingCall(stmt: string, offset: number): { name: string; schema?: string; argIndex: number } | null {
  const masked = maskSql(stmt, { keepIdents: true }).slice(0, offset);
  const tokens = tokenize(masked);
  let depth = 0;
  let commas = 0;
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i];
    if (t.v === ')') depth++;
    else if (t.v === '(') {
      if (depth === 0) {
        const nameTok = tokens[i - 1];
        if (!nameTok || (nameTok.t !== 'w' && nameTok.t !== 'q')) return null;
        const schema = tokens[i - 2]?.v === '.' ? tokens[i - 3]?.v : undefined;
        return { name: nameTok.v, schema, argIndex: commas };
      }
      depth--;
    } else if (t.v === ',' && depth === 0) commas++;
  }
  return null;
}
