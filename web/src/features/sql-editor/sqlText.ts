/**
 * Lightweight SQL text utilities for the editor: masking of comments/strings, statement
 * splitting with exact offsets, "statement under cursor", dangerous-statement detection.
 * The splitting rules mirror server/src/lib/sql.ts (strings, E'', "idents", $tag$, nested
 * comments, BEGIN ATOMIC … END).
 */

export interface StatementRange {
  /** trimmed text */
  text: string;
  /** 0-based offset of the first code character */
  start: number;
  /** 0-based offset right after the last code character (exclusive), before `;` */
  end: number;
  /** offset just after the terminating `;` (or end of input) */
  stop: number;
}

/**
 * Replace comments and string/quoted-identifier/dollar-quoted contents with spaces, keeping
 * offsets and newlines intact. Quotes themselves are preserved so identifiers stay recognisable
 * when `keepIdents` is set.
 */
export function maskSql(sql: string, opts: { keepIdents?: boolean } = {}): string {
  const out = sql.split('');
  const n = sql.length;
  const blank = (a: number, b: number) => {
    for (let k = a; k < b && k < n; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === '-' && next === '-') {
      const nl = sql.indexOf('\n', i);
      const e = nl === -1 ? n : nl;
      blank(i, e);
      i = e;
      continue;
    }
    if (c === '/' && next === '*') {
      const s = i;
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') { depth++; i += 2; }
        else if (sql[i] === '*' && sql[i + 1] === '/') { depth--; i += 2; }
        else i++;
      }
      blank(s, i);
      continue;
    }
    if (c === "'") {
      const isE = i > 0 && /[eE]/.test(sql[i - 1]) && (i < 2 || !/[\w$]/.test(sql[i - 2]));
      const s = i;
      i++;
      while (i < n) {
        if (isE && sql[i] === '\\') { i += 2; continue; }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { i += 2; continue; }
          break;
        }
        i++;
      }
      blank(s + 1, i);
      i++;
      continue;
    }
    if (c === '"') {
      const s = i;
      i++;
      while (i < n) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') { i += 2; continue; }
          break;
        }
        i++;
      }
      if (!opts.keepIdents) blank(s + 1, i);
      i++;
      continue;
    }
    if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64));
      if (m && !(i > 0 && /[\w$]/.test(sql[i - 1]))) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        const e = end === -1 ? n : end + tag.length;
        blank(i + tag.length, end === -1 ? n : end);
        i = e;
        continue;
      }
    }
    i++;
  }
  return out.join('');
}

/** Split into statements with offsets (operates on masked text so `;` in strings is ignored). */
export function splitStatements(sql: string): StatementRange[] {
  const masked = maskSql(sql);
  const out: StatementRange[] = [];
  const n = masked.length;
  let start = 0;
  let atomicDepth = 0;
  let prevWord = '';
  const push = (endExclusive: number, stop: number) => {
    const raw = masked.slice(start, endExclusive);
    const lead = raw.length - raw.trimStart().length;
    const trail = raw.length - raw.trimEnd().length;
    if (raw.trim().length) {
      const s = start + lead;
      const e = endExclusive - trail;
      out.push({ text: sql.slice(s, e), start: s, end: e, stop });
    }
  };
  let i = 0;
  while (i < n) {
    const c = masked[i];
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$]/.test(masked[j])) j++;
      const w = masked.slice(i, j).toUpperCase();
      if (w === 'ATOMIC' && prevWord === 'BEGIN') atomicDepth++;
      else if (atomicDepth > 0 && w === 'CASE') atomicDepth++;
      else if (atomicDepth > 0 && w === 'END') {
        const nextWord = /^\s*([A-Za-z]+)/.exec(masked.slice(j, j + 20))?.[1]?.toUpperCase();
        if (!nextWord || !['IF', 'LOOP', 'CASE'].includes(nextWord)) atomicDepth--;
      }
      prevWord = w;
      i = j;
      continue;
    }
    if (c === ';' && atomicDepth === 0) {
      push(i, i + 1);
      start = i + 1;
    }
    i++;
  }
  push(n, n);
  return out;
}

/**
 * The statement the cursor belongs to: the one containing the offset, or — when the cursor
 * sits in whitespace between statements — the one ending on the cursor line (just before it),
 * else the next one.
 */
export function statementAt(sql: string, offset: number): StatementRange | null {
  const all = splitStatements(sql);
  if (!all.length) return null;
  for (const s of all) if (offset >= s.start && offset <= s.end) return s;
  // between statements
  let prev: StatementRange | null = null;
  let next: StatementRange | null = null;
  for (const s of all) {
    if (s.end <= offset) prev = s;
    else if (!next && s.start > offset) next = s;
  }
  // cursor right after `;` on the same line -> that statement
  if (prev && !sql.slice(prev.end, offset).includes('\n')) return prev;
  // cursor on a line directly above the next statement -> next
  if (next && !/\n\s*\n/.test(sql.slice(offset, next.start))) return next;
  return prev ?? next;
}

// ---------------------------------------------------------------- danger detection

export interface DangerFinding {
  kind: 'drop' | 'truncate' | 'delete' | 'update' | 'alter-drop';
  label: string;
  statement: string;
}

/** Detect destructive statements: DROP, TRUNCATE, DELETE/UPDATE without WHERE, ALTER … DROP. */
export function findDangerous(sql: string): DangerFinding[] {
  const out: DangerFinding[] = [];
  for (const st of splitStatements(sql)) {
    const m = maskSql(st.text).replace(/\s+/g, ' ').trim().toUpperCase();
    // skip EXPLAIN without ANALYZE (it doesn't execute)
    if (/^EXPLAIN\b/.test(m) && !/^EXPLAIN\s*(\([^)]*\bANALY[SZ]E\b|ANALY[SZ]E\b)/.test(m)) continue;
    const body = m.replace(/^EXPLAIN\s*(\([^)]*\))?\s*(ANALY[SZ]E\s*)?(VERBOSE\s*)?/, '');
    const short = st.text.length > 160 ? st.text.slice(0, 157) + '…' : st.text;
    // strip leading CTEs for DML detection: WITH x AS (...) DELETE ...
    const dml = body.replace(/^WITH\b[\s\S]*?\)\s*(?=(DELETE|UPDATE|INSERT|SELECT|MERGE)\b)/, '');
    if (/^DROP\b/.test(body)) out.push({ kind: 'drop', label: body.split(' ').slice(0, 2).join(' '), statement: short });
    else if (/^TRUNCATE\b/.test(body)) out.push({ kind: 'truncate', label: 'TRUNCATE', statement: short });
    else if (/^DELETE\b/.test(dml) && !/\bWHERE\b/.test(dml)) out.push({ kind: 'delete', label: 'DELETE without WHERE', statement: short });
    else if (/^UPDATE\b/.test(dml) && !/\bWHERE\b/.test(dml)) out.push({ kind: 'update', label: 'UPDATE without WHERE', statement: short });
    else if (/^ALTER\b/.test(body) && /\bDROP\b/.test(body)) out.push({ kind: 'alter-drop', label: 'ALTER … DROP', statement: short });
  }
  return out;
}

/** Does the SQL modify data/schema (used to decide `rollback` for EXPLAIN ANALYZE, catalog refresh)? */
export function isDataModifying(sql: string): boolean {
  const m = maskSql(sql).toUpperCase();
  return /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|CREATE|ALTER|DROP|COPY|CALL|REFRESH|GRANT|REVOKE|SELECT\b[\s\S]*\bINTO|NEXTVAL|SETVAL)\b/.test(m);
}

export function isDdl(sql: string): boolean {
  const m = maskSql(sql).toUpperCase();
  return /(^|;)\s*(CREATE|ALTER|DROP|COMMENT|RENAME|TRUNCATE|IMPORT|REFRESH)\b/.test(m) || /\bSELECT\b[^;]*\bINTO\b/.test(m);
}

/** Offset → { lineNumber, column } (1-based) */
export function offsetToPos(text: string, offset: number) {
  let line = 1;
  let col = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') { line++; col = 1; } else col++;
  }
  return { lineNumber: line, column: col };
}
