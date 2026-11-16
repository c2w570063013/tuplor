/** SQL helpers shared by all server modules. */

export function quoteIdent(name: string): string {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

/** schema.name, both quoted. */
export function qualified(schema: string, name: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(name)}`;
}

export function quoteLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  const s = typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (s.includes('\\')) return "E'" + s.replace(/\\/g, '\\\\').replace(/'/g, "''") + "'";
  return "'" + s.replace(/'/g, "''") + "'";
}

export interface SplitStatement {
  text: string;
  /** 0-based offset of `text` in the original SQL. */
  start: number;
}

/**
 * Split a SQL script into statements on top-level semicolons.
 * Understands '...' strings, E'...' escapes, "idents", $tag$ dollar quotes $tag$,
 * -- line comments, nested /* block comments *\/ and BEGIN ATOMIC ... END bodies.
 * Empty / comment-only statements are dropped.
 */
export function splitStatements(sql: string): SplitStatement[] {
  const out: SplitStatement[] = [];
  let i = 0;
  let start = 0;
  const n = sql.length;
  let atomicDepth = 0;
  let lastWords: string[] = [];

  const push = (end: number) => {
    const raw = sql.slice(start, end);
    if (hasCode(raw)) {
      const lead = raw.length - raw.trimStart().length;
      out.push({ text: raw.trim(), start: start + lead });
    }
  };

  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === '-' && next === '-') {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? n : nl + 1;
      continue;
    }
    if (c === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') { depth++; i += 2; }
        else if (sql[i] === '*' && sql[i + 1] === '/') { depth--; i += 2; }
        else i++;
      }
      continue;
    }
    if (c === "'") {
      const isE = i > 0 && /[eE]/.test(sql[i - 1]) && (i < 2 || !/[\w$]/.test(sql[i - 2]));
      i++;
      while (i < n) {
        if (isE && sql[i] === '\\') { i += 2; continue; }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { i += 2; continue; }
          break;
        }
        i++;
      }
      i++;
      continue;
    }
    if (c === '"') {
      i++;
      while (i < n) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') { i += 2; continue; }
          break;
        }
        i++;
      }
      i++;
      continue;
    }
    if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64));
      if (m && !(i > 0 && /[\w$]/.test(sql[i - 1]))) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        i = end === -1 ? n : end + tag.length;
        continue;
      }
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$]/.test(sql[j])) j++;
      const w = sql.slice(i, j).toUpperCase();
      lastWords.push(w);
      if (lastWords.length > 2) lastWords.shift();
      if (w === 'ATOMIC' && lastWords[0] === 'BEGIN') atomicDepth++;
      else if (w === 'END' && atomicDepth > 0) {
        // END / END IF / END LOOP / END CASE inside atomic block: only plain END closes it
        let k = j;
        while (k < n && /\s/.test(sql[k])) k++;
        const nextWord = /^[A-Za-z]+/.exec(sql.slice(k))?.[0]?.toUpperCase();
        if (!nextWord || !['IF', 'LOOP', 'CASE'].includes(nextWord)) atomicDepth--;
      } else if (w === 'CASE' && atomicDepth > 0) {
        // CASE ... END inside atomic body would otherwise close it
        atomicDepth++;
      }
      i = j;
      continue;
    }
    if (c === ';' && atomicDepth === 0) {
      push(i);
      start = i + 1;
    }
    i++;
  }
  push(n);
  return out;
}

function hasCode(s: string): boolean {
  // strip comments then check for non-space
  const stripped = s.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  return stripped.trim().length > 0;
}
