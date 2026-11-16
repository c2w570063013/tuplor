/**
 * Schema-aware SQL completion, hover and signature help for Monaco.
 * Providers are registered once for PG_LANG; each editor model is bound to a (connection, db)
 * via `bindModel()` so the right catalog is used.
 */
import type { CatalogColumn, CatalogFunction, CatalogRelation } from '@shared/completion';
import { monaco, PG_KEYWORDS, PG_LANG } from '@/lib/monaco';
import { quoteIdent } from '@/lib/format';
import { getCachedCatalog, loadCatalog, type CatalogIndex } from './catalog';
import { analyze, enclosingCall, type TableRef } from './sqlContext';
import { maskSql } from './sqlText';
import { format as formatSql } from 'sql-formatter';
import { toast } from '@/components/ui';

type Model = monaco.editor.ITextModel;
const bindings = new Map<string, { connId: string; db: string }>();

export function bindModel(model: Model, connId: string, db: string) {
  bindings.set(model.uri.toString(), { connId, db });
  void loadCatalog(connId, db);
}
export function unbindModel(model: Model) {
  bindings.delete(model.uri.toString());
}

async function catalogFor(model: Model): Promise<CatalogIndex | undefined> {
  const b = bindings.get(model.uri.toString());
  if (!b) return undefined;
  return getCachedCatalog(b.connId, b.db) ?? (await loadCatalog(b.connId, b.db));
}

/** Statement around the cursor using top-level `;` in masked text. */
function statementAround(model: Model, position: monaco.Position) {
  const text = model.getValue();
  const offset = model.getOffsetAt(position);
  const masked = maskSql(text);
  const start = masked.lastIndexOf(';', offset - 1) + 1;
  let end = masked.indexOf(';', offset);
  if (end < 0) end = text.length;
  return { stmt: text.slice(start, end), rel: offset - start, start };
}

// ---------------------------------------------------------------- resolution helpers

const eqName = (actual: string, v: string) => actual === v || actual.toLowerCase() === v;

export function resolveRelation(idx: CatalogIndex, schema: string | undefined, name: string): CatalogRelation | undefined {
  if (schema) return idx.relBySchema.get(schema.toLowerCase())?.find((r) => eqName(r.n, name) && eqName(r.s, schema));
  const cands = idx.relByName.get(name.toLowerCase())?.filter((r) => eqName(r.n, name));
  if (!cands?.length) return undefined;
  for (const sp of idx.searchPath) {
    const hit = cands.find((r) => r.s === sp);
    if (hit) return hit;
  }
  return cands[0];
}

interface ResolvedRef {
  ref: TableRef;
  rel?: CatalogRelation;
  columns: CatalogColumn[];
  /** the name to qualify columns with */
  qual: string;
}

function resolveRefs(idx: CatalogIndex, refs: TableRef[]): ResolvedRef[] {
  return refs.map((ref) => {
    const rel = ref.virtual ? undefined : resolveRelation(idx, ref.schema, ref.name);
    const columns = rel?.cols ?? (ref.columns ?? []).map((n) => ({ n, t: '' }));
    return { ref, rel, columns, qual: ref.alias ?? ref.name };
  });
}

function findQualifier(idx: CatalogIndex, resolved: ResolvedRef[], q: string): ResolvedRef | undefined {
  return (
    resolved.find((r) => r.ref.alias && eqName(r.ref.alias, q)) ??
    resolved.find((r) => !r.ref.alias && eqName(r.ref.name, q)) ??
    resolved.find((r) => eqName(r.ref.name, q))
  );
}

const relKindLabel: Record<string, string> = { r: 'table', p: 'partitioned table', v: 'view', m: 'materialized view', f: 'foreign table' };
const relIcon = (k: string) =>
  k === 'v' || k === 'm' ? monaco.languages.CompletionItemKind.Interface : monaco.languages.CompletionItemKind.Struct;

function relInsert(idx: CatalogIndex, r: CatalogRelation, schemaGiven: boolean) {
  if (schemaGiven || idx.searchPath.includes(r.s)) return quoteIdent(r.n);
  return `${quoteIdent(r.s)}.${quoteIdent(r.n)}`;
}

function aliasFor(name: string, taken: Set<string>) {
  const parts = name.toLowerCase().split(/_+/).filter(Boolean);
  let base = parts.map((p) => p[0]).join('') || 't';
  if (/^\d/.test(base)) base = 't' + base;
  const reserved = new Set(['as', 'at', 'by', 'do', 'if', 'in', 'is', 'of', 'on', 'or', 'to', 'and', 'all', 'any', 'asc', 'end', 'for', 'not', 'off', 'set']);
  let a = base;
  let n = 2;
  while (taken.has(a) || reserved.has(a)) a = base + n++;
  return a;
}

function fnSignature(f: CatalogFunction) {
  return `${f.n}(${f.args})${f.ret ? ' → ' + f.ret : ''}`;
}

function relDoc(r: CatalogRelation): monaco.IMarkdownString {
  const head = `**${r.s}.${r.n}** · ${relKindLabel[r.k] ?? 'relation'}${r.est != null && r.est >= 0 ? ` · ~${r.est.toLocaleString()} rows` : ''}`;
  const cols = r.cols.slice(0, 40).map((c) => `| ${c.pk ? '🔑 ' : ''}\`${c.n}\` | ${c.t}${c.nn ? ' · not null' : ''} |`).join('\n');
  return {
    value: `${head}${r.c ? `\n\n${r.c}` : ''}\n\n| column | type |\n|---|---|\n${cols}${r.cols.length > 40 ? `\n\n…and ${r.cols.length - 40} more` : ''}`,
  };
}

// ---------------------------------------------------------------- keyword sets

const STARTERS: { label: string; insert: string; doc?: string }[] = [
  { label: 'SELECT', insert: 'SELECT ' },
  { label: 'SELECT * FROM', insert: 'SELECT *\nFROM ${1}\nLIMIT ${2:100};', doc: 'Select all columns' },
  { label: 'INSERT INTO', insert: 'INSERT INTO ${1:table} (${2:columns})\nVALUES (${3});' },
  { label: 'UPDATE', insert: 'UPDATE ${1:table}\nSET ${2:column} = ${3:value}\nWHERE ${4:condition};' },
  { label: 'DELETE FROM', insert: 'DELETE FROM ${1:table}\nWHERE ${2:condition};' },
  { label: 'WITH', insert: 'WITH ${1:cte} AS (\n  ${2:SELECT 1}\n)\nSELECT * FROM ${1:cte};' },
  { label: 'CREATE TABLE', insert: 'CREATE TABLE ${1:name} (\n  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,\n  ${2}\n);' },
  { label: 'CREATE INDEX', insert: 'CREATE INDEX ${1:name} ON ${2:table} (${3:column});' },
  { label: 'ALTER TABLE', insert: 'ALTER TABLE ${1:table} ' },
  { label: 'EXPLAIN ANALYZE', insert: 'EXPLAIN (ANALYZE, BUFFERS) ' },
  { label: 'BEGIN', insert: 'BEGIN;' },
  { label: 'COMMIT', insert: 'COMMIT;' },
  { label: 'ROLLBACK', insert: 'ROLLBACK;' },
  { label: 'DO block', insert: 'DO $$\nBEGIN\n  ${1}\nEND\n$$;' },
  { label: 'CREATE FUNCTION', insert: "CREATE OR REPLACE FUNCTION ${1:name}(${2})\nRETURNS ${3:void}\nLANGUAGE plpgsql AS $$\nBEGIN\n  ${4}\nEND;\n$$;" },
];

const AFTER_TABLE = ['WHERE', 'JOIN', 'LEFT JOIN', 'INNER JOIN', 'RIGHT JOIN', 'FULL JOIN', 'CROSS JOIN', 'ON', 'USING', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET', 'AS', 'SET', 'VALUES', 'RETURNING', 'UNION', 'UNION ALL', 'WINDOW', 'FOR UPDATE', 'ADD COLUMN', 'DROP COLUMN', 'ALTER COLUMN', 'RENAME TO', 'OWNER TO', 'DEFAULT VALUES', 'SELECT', 'ON CONFLICT'];
const EXPR_KEYWORDS = ['AND', 'OR', 'NOT', 'IS NULL', 'IS NOT NULL', 'IN', 'LIKE', 'ILIKE', 'BETWEEN', 'EXISTS', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'AS', 'DISTINCT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'ASC', 'DESC', 'NULLS LAST', 'NULLS FIRST', 'TRUE', 'FALSE', 'NULL', 'CAST', 'OVER', 'PARTITION BY', 'FILTER', 'INTERVAL', 'CURRENT_DATE', 'CURRENT_TIMESTAMP', 'NOW()'];

// ---------------------------------------------------------------- completion

let registered = false;

export function registerSqlProviders() {
  if (registered) return;
  registered = true;
  registerFormatter();
  const K = monaco.languages.CompletionItemKind;

  monaco.languages.registerCompletionItemProvider(PG_LANG, {
    triggerCharacters: ['.', '"', ' ', ':'],
    async provideCompletionItems(model, position, context) {
      const { stmt, rel } = statementAround(model, position);
      const { ctx, scope } = analyze(stmt, rel);

      // only react to space / colon triggers in useful spots
      if (context.triggerKind === monaco.languages.CompletionTriggerKind.TriggerCharacter) {
        const ch = context.triggerCharacter;
        if (ch === ' ' && !(ctx.kind === 'relation' || (ctx.kind === 'column' && ctx.afterOn))) return { suggestions: [] };
        if (ch === ':' && ctx.kind !== 'type') return { suggestions: [] };
      }

      const idx = await catalogFor(model);
      const quoted = model.getValueInRange({ startLineNumber: position.lineNumber, startColumn: Math.max(1, position.column - ctx.prefix.length - 1), endLineNumber: position.lineNumber, endColumn: position.column - ctx.prefix.length }) === '"';
      const word = model.getWordUntilPosition(position);
      const startCol = position.column - ctx.prefix.length - (quoted ? 1 : 0);
      const range = new monaco.Range(position.lineNumber, startCol, position.lineNumber, Math.max(word.endColumn, position.column));
      const lower = ctx.prefix.length > 0 && ctx.prefix === ctx.prefix.toLowerCase();
      const kw = (s: string) => (lower ? s.toLowerCase() : s);
      const out: monaco.languages.CompletionItem[] = [];
      const add = (item: Omit<monaco.languages.CompletionItem, 'range'> & { range?: monaco.IRange }) => out.push({ range, ...item } as monaco.languages.CompletionItem);

      const addKeywords = (list: string[], rank: string) => {
        for (const k of list) add({ label: kw(k), kind: K.Keyword, insertText: kw(k) + (k.endsWith(')') ? '' : ' '), sortText: rank + k, command: k.endsWith('JOIN') || k === 'FROM' ? { id: 'editor.action.triggerSuggest', title: '' } : undefined });
      };
      const addFunctions = (rank: string, filter?: (f: CatalogFunction) => boolean, schemaGiven = false) => {
        if (!idx) return;
        const seen = new Set<string>();
        for (const f of [...idx.catalog.functions, ...idx.catalog.builtins]) {
          if (filter && !filter(f)) continue;
          const id = f.s + '.' + f.n;
          const sig = fnSignature(f);
          if (seen.has(id)) continue;
          seen.add(id);
          const overloads = idx.funcByName.get(f.n.toLowerCase())?.filter((g) => g.s === f.s).length ?? 1;
          const qualify = !schemaGiven && f.s !== 'pg_catalog' && !idx.searchPath.includes(f.s);
          const name = (qualify ? quoteIdent(f.s) + '.' : '') + quoteIdent(f.n);
          add({
            label: { label: f.n, detail: `(${f.args})`, description: f.ret || (f.k === 'p' ? 'procedure' : '') },
            kind: K.Function,
            insertText: f.args ? `${name}($0)` : `${name}()`,
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            filterText: f.n,
            detail: overloads > 1 ? `${sig}  (+${overloads - 1} overloads)` : sig,
            documentation: f.c ? { value: f.c } : undefined,
            sortText: rank + (f.s === 'pg_catalog' ? '1' : '0') + f.n,
            command: f.args ? { id: 'editor.action.triggerParameterHints', title: '' } : undefined,
          });
        }
      };
      const addRelations = (rank: string, rels: CatalogRelation[], schemaGiven: boolean) => {
        if (!idx) return;
        for (const r of rels) {
          const ins = relInsert(idx, r, schemaGiven);
          add({
            label: { label: r.n, description: `${r.s} · ${relKindLabel[r.k]}` },
            kind: relIcon(r.k),
            insertText: ins,
            filterText: schemaGiven ? r.n : `${r.n} ${r.s}.${r.n}`,
            documentation: relDoc(r),
            sortText: rank + (idx.searchPath.includes(r.s) ? '0' : '1') + r.n,
          });
        }
      };
      const addColumns = (rank: string, rr: ResolvedRef[], qualifyAlways = false) => {
        const counts = new Map<string, number>();
        for (const r of rr) for (const c of r.columns) counts.set(c.n, (counts.get(c.n) ?? 0) + 1);
        for (const r of rr) {
          for (const [ci, c] of r.columns.entries()) {
            const ambiguous = (counts.get(c.n) ?? 0) > 1 && rr.length > 1;
            const ins = qualifyAlways || ambiguous ? `${quoteIdent(r.qual)}.${quoteIdent(c.n)}` : quoteIdent(c.n);
            add({
              label: { label: c.n, detail: c.t ? ` ${c.t}` : '', description: rr.length > 1 || r.ref.alias ? r.qual : r.rel ? `${r.rel.s}.${r.rel.n}` : '' },
              kind: K.Field,
              insertText: ins,
              filterText: ambiguous ? `${c.n} ${r.qual}.${c.n}` : c.n,
              detail: `${c.pk ? 'PK · ' : ''}${c.t}${c.nn ? ' NOT NULL' : ''}`,
              documentation: c.c ? { value: c.c } : r.rel ? { value: `Column of **${r.rel.s}.${r.rel.n}**` } : undefined,
              sortText: rank + String(r.ref.pos).padStart(2, '0') + (c.pk ? '0' : '1') + String(ci).padStart(4, '0'),
            });
          }
        }
      };

      switch (ctx.kind) {
        case 'qualified': {
          if (!idx) break;
          const rr = resolveRefs(idx, scope.refs);
          const [a, b] = ctx.parts;
          if (ctx.parts.length === 1) {
            const q = findQualifier(idx, rr, a);
            if (q) { addColumns('0', [{ ...q, ref: { ...q.ref, alias: undefined } }]); add({ label: '*', kind: K.Operator, insertText: '*', sortText: '00' }); break; }
            const sch = idx.catalog.schemas.find((s) => eqName(s, a));
            if (sch) {
              addRelations('0', idx.relBySchema.get(sch.toLowerCase()) ?? [], true);
              addFunctions('2', (f) => f.s === sch, true);
              break;
            }
            const rel = resolveRelation(idx, undefined, a);
            if (rel) addColumns('0', [{ ref: { name: rel.n, pos: 0 }, rel, columns: rel.cols, qual: rel.n }]);
          } else {
            const rel = resolveRelation(idx, a, b);
            if (rel) addColumns('0', [{ ref: { name: rel.n, pos: 0 }, rel, columns: rel.cols, qual: rel.n }]);
          }
          break;
        }
        case 'relation': {
          if (idx) {
            const rr = resolveRefs(idx, scope.refs);
            if (ctx.afterJoin && rr.length) {
              // FK-based join suggestions: "order_items oi ON oi.order_id = o.id"
              const taken = new Set(rr.map((r) => r.qual.toLowerCase()));
              const seen = new Set<string>();
              for (const left of rr) {
                if (!left.rel) continue;
                const pairs: { target: CatalogRelation; cond: (al: string) => string }[] = [];
                for (const fk of left.rel.fks ?? []) {
                  const target = resolveRelation(idx, fk.rs, fk.rn);
                  if (target) pairs.push({ target, cond: (al) => fk.cols.map((c, i) => `${quoteIdent(al)}.${quoteIdent(fk.rcols[i])} = ${quoteIdent(left.qual)}.${quoteIdent(c)}`).join(' AND ') });
                }
                for (const r of idx.catalog.relations) {
                  for (const fk of r.fks ?? []) {
                    if (fk.rs === left.rel.s && fk.rn === left.rel.n) {
                      pairs.push({ target: r, cond: (al) => fk.cols.map((c, i) => `${quoteIdent(al)}.${quoteIdent(c)} = ${quoteIdent(left.qual)}.${quoteIdent(fk.rcols[i])}`).join(' AND ') });
                    }
                  }
                }
                for (const p of pairs) {
                  const al = aliasFor(p.target.n, taken);
                  const text = `${relInsert(idx, p.target, false)} ${al} ON ${p.cond(al)}`;
                  if (seen.has(text)) continue;
                  seen.add(text);
                  add({
                    label: { label: `${p.target.n} ${al} ON …`, description: 'join on foreign key' },
                    kind: K.Reference,
                    insertText: text,
                    filterText: p.target.n,
                    detail: text,
                    sortText: '0' + p.target.n,
                  });
                }
              }
            }
            addRelations('1', idx.catalog.relations, false);
            for (const s of idx.catalog.schemas) add({ label: s, kind: K.Module, insertText: quoteIdent(s) + '.', detail: 'schema', sortText: '3' + s, command: { id: 'editor.action.triggerSuggest', title: '' } });
          }
          for (const [name, cols] of scope.ctes) add({ label: { label: name, description: 'CTE' }, kind: K.Struct, insertText: quoteIdent(name), detail: cols ? `(${cols.join(', ')})` : 'common table expression', sortText: '0' + name });
          if (ctx.afterJoin === false && !ctx.prefix) addKeywords(['LATERAL', 'ONLY'], '9');
          break;
        }
        case 'column': {
          if (idx) {
            if (ctx.insertColumnsOf) {
              const rr = resolveRefs(idx, [ctx.insertColumnsOf]);
              addColumns('0', [{ ...rr[0], ref: { ...rr[0].ref, alias: undefined } }]);
              break;
            }
            const rr = resolveRefs(idx, scope.refs);
            if (ctx.afterOn && rr.length >= 2) {
              const last = rr[rr.length - 1];
              for (const other of rr.slice(0, -1)) {
                if (!last.rel || !other.rel) continue;
                const conds: string[] = [];
                for (const fk of last.rel.fks ?? []) if (fk.rs === other.rel.s && fk.rn === other.rel.n) conds.push(fk.cols.map((c, i) => `${quoteIdent(last.qual)}.${quoteIdent(c)} = ${quoteIdent(other.qual)}.${quoteIdent(fk.rcols[i])}`).join(' AND '));
                for (const fk of other.rel.fks ?? []) if (fk.rs === last.rel.s && fk.rn === last.rel.n) conds.push(fk.cols.map((c, i) => `${quoteIdent(other.qual)}.${quoteIdent(c)} = ${quoteIdent(last.qual)}.${quoteIdent(fk.rcols[i])}`).join(' AND '));
                for (const c of conds) add({ label: { label: c, description: 'foreign key' }, kind: K.Reference, insertText: c, sortText: '00' });
              }
            }
            addColumns('1', rr);
            for (const r of rr) if (r.qual) add({ label: { label: r.qual, description: r.rel ? `${r.rel.s}.${r.rel.n}` : r.ref.virtual ? 'subquery / CTE' : '' }, kind: K.Variable, insertText: quoteIdent(r.qual), sortText: '2' + r.qual, command: undefined });
            if (!rr.length) addRelations('5', idx.catalog.relations, false);
            addFunctions('3');
          }
          addKeywords(EXPR_KEYWORDS, '4');
          break;
        }
        case 'type': {
          const types = idx?.catalog.types ?? [];
          for (const t of types) add({ label: t, kind: K.TypeParameter, insertText: t, sortText: (t.includes('.') ? '1' : '0') + t });
          break;
        }
        case 'routine': {
          addFunctions('0', (f) => f.s !== 'pg_catalog' || f.k === 'f');
          break;
        }
        case 'keyword': {
          if (ctx.first) {
            for (const s of STARTERS) add({ label: s.label, kind: K.Snippet, insertText: s.insert, insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, detail: s.doc ?? 'statement', sortText: '0' + s.label });
            addKeywords(PG_KEYWORDS, '5');
          } else if (ctx.afterTable) {
            addKeywords(AFTER_TABLE, '0');
          } else addKeywords(PG_KEYWORDS, '5');
          break;
        }
      }
      return { suggestions: out, incomplete: !idx };
    },
  });

  monaco.languages.registerHoverProvider(PG_LANG, {
    async provideHover(model, position) {
      const word = model.getWordAtPosition(position);
      if (!word) return null;
      const idx = await catalogFor(model);
      if (!idx) return null;
      const { stmt, start } = statementAround(model, position);
      const wordStartOffset = model.getOffsetAt({ lineNumber: position.lineNumber, column: word.startColumn }) - start;
      const { scope, ctx } = analyze(stmt, wordStartOffset);
      const rr = resolveRefs(idx, scope.refs);
      const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
      const w = word.word;
      const lw = w.toLowerCase();
      const colHover = (c: CatalogColumn, owner: string) => ({
        range,
        contents: [{ value: `**${c.n}** \`${c.t}\`${c.pk ? ' · primary key' : ''}${c.nn ? ' · not null' : ''}\n\n${owner}${c.c ? `\n\n${c.c}` : ''}` }],
      });
      if (ctx.kind === 'qualified') {
        const parts = ctx.parts;
        if (parts.length === 1) {
          const q = findQualifier(idx, rr, parts[0]);
          const col = q?.columns.find((c) => eqName(c.n, lw));
          if (q && col) return colHover(col, q.rel ? `${q.rel.s}.${q.rel.n}` : q.qual);
          const rel = resolveRelation(idx, parts[0], lw);
          if (rel) return { range, contents: [relDoc(rel)] };
          const rel2 = resolveRelation(idx, undefined, parts[0]);
          const col2 = rel2?.cols.find((c) => eqName(c.n, lw));
          if (rel2 && col2) return colHover(col2, `${rel2.s}.${rel2.n}`);
          const fn = idx.funcByName.get(lw)?.filter((f) => eqName(f.s, parts[0]));
          if (fn?.length) return { range, contents: fn.slice(0, 6).map((f) => ({ value: '```sql\n' + `${f.s}.${fnSignature(f)}` + '\n```' + (f.c ? `\n${f.c}` : '') })) };
        } else {
          const rel = resolveRelation(idx, parts[parts.length - 2], parts[parts.length - 1]);
          const col = rel?.cols.find((c) => eqName(c.n, lw));
          if (rel && col) return colHover(col, `${rel.s}.${rel.n}`);
        }
        return null;
      }
      const ref = findQualifier(idx, rr, lw);
      if (ref?.rel) return { range, contents: [relDoc(ref.rel)] };
      const after = model.getValueInRange({ startLineNumber: position.lineNumber, startColumn: word.endColumn, endLineNumber: position.lineNumber, endColumn: word.endColumn + 1 });
      if (after === '(') {
        const fns = idx.funcByName.get(lw);
        if (fns?.length) return { range, contents: [{ value: '```sql\n' + fns.slice(0, 8).map(fnSignature).join('\n') + '\n```' + (fns.length > 8 ? `\n…${fns.length - 8} more overloads` : '') + (fns[0].c ? `\n\n${fns[0].c}` : '') }] };
      }
      for (const r of rr) {
        const col = r.columns.find((c) => eqName(c.n, lw));
        if (col) return colHover(col, r.rel ? `${r.rel.s}.${r.rel.n}${r.ref.alias ? ` (${r.ref.alias})` : ''}` : r.qual);
      }
      const rel = resolveRelation(idx, undefined, lw);
      if (rel) return { range, contents: [relDoc(rel)] };
      return null;
    },
  });

  monaco.languages.registerSignatureHelpProvider(PG_LANG, {
    signatureHelpTriggerCharacters: ['(', ','],
    signatureHelpRetriggerCharacters: [','],
    async provideSignatureHelp(model, position) {
      const { stmt, rel } = statementAround(model, position);
      const call = enclosingCall(stmt, rel);
      if (!call) return null;
      const idx = await catalogFor(model);
      const fns = idx?.funcByName.get(call.name.toLowerCase())?.filter((f) => !call.schema || eqName(f.s, call.schema));
      if (!fns?.length) return null;
      const signatures = fns.slice(0, 20).map((f) => {
        const params = splitArgs(f.args);
        return {
          label: `${f.n}(${params.join(', ')})${f.ret ? ' → ' + f.ret : ''}`,
          documentation: f.c,
          parameters: params.map((p) => ({ label: p })),
        };
      });
      let active = signatures.findIndex((s) => s.parameters.length > call.argIndex);
      if (active < 0) active = 0;
      return {
        value: { signatures, activeSignature: active, activeParameter: call.argIndex },
        dispose() {},
      };
    },
  });
}

function formatPg(text: string, tabSize: number): string | null {
  try {
    return formatSql(text, {
      language: 'postgresql',
      keywordCase: 'upper',
      dataTypeCase: 'preserve',
      functionCase: 'preserve',
      identifierCase: 'preserve',
      tabWidth: tabSize,
      linesBetweenQueries: 1,
    });
  } catch (e: any) {
    toast.error('Could not format SQL', { description: String(e?.message ?? e).split('\n')[0] });
    return null;
  }
}

function registerFormatter() {
  monaco.languages.registerDocumentFormattingEditProvider(PG_LANG, {
    provideDocumentFormattingEdits(model, options) {
      const text = model.getValue();
      if (!text.trim()) return [];
      const out = formatPg(text, options.tabSize);
      if (out == null || out === text) return [];
      return [{ range: model.getFullModelRange(), text: out + (text.endsWith('\n') ? '\n' : '') }];
    },
  });
  monaco.languages.registerDocumentRangeFormattingEditProvider(PG_LANG, {
    provideDocumentRangeFormattingEdits(model, range, options) {
      const text = model.getValueInRange(range);
      if (!text.trim()) return [];
      const out = formatPg(text, options.tabSize);
      return out == null ? [] : [{ range, text: out }];
    },
  });
}

function splitArgs(args: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of args) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
