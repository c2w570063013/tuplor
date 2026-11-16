/**
 * SQL generation for the Explorer & Structure features. Pure functions, no React.
 * Identifiers are quoted only when needed (quoteIdent from lib/format).
 */
import type { ColumnInfo } from '@shared/types';
import type { ColumnDetail } from '@shared/schema';
import { quoteIdent, quoteLiteral } from '@/lib/format';

/** Always schema-qualified name (safer than relying on search_path in DDL). */
export const fq = (schema: string, name: string) => `${quoteIdent(schema)}.${quoteIdent(name)}`;
export const qi = quoteIdent;
export const lit = (s: string) => quoteLiteral(s);
const commentLit = (s: string | null | undefined) => (s && s.trim() ? lit(s) : 'NULL');

// ------------------------------------------------------------------ DML templates

type Col = Pick<ColumnInfo, 'name' | 'dataType' | 'isPrimaryKey' | 'isIdentity' | 'isGenerated' | 'default' | 'nullable'>;

export function selectTemplate(schema: string, table: string, cols: Col[], limit = 100): string {
  const list = cols.length ? cols.map((c) => qi(c.name)).join(',\n       ') : '*';
  return `SELECT ${list}\n  FROM ${fq(schema, table)}\n LIMIT ${limit};\n`;
}

function placeholder(c: Col): string {
  const t = c.dataType.toLowerCase();
  if (/int|numeric|real|double|serial|decimal|money/.test(t)) return '0';
  if (t === 'boolean') return 'false';
  if (/jsonb?$/.test(t)) return `'{}'`;
  if (t.endsWith('[]')) return `'{}'`;
  if (/timestamp|date|time/.test(t)) return 'now()';
  if (t === 'uuid') return 'gen_random_uuid()';
  return `''`;
}

export function insertTemplate(schema: string, table: string, cols: Col[]): string {
  const ins = cols.filter((c) => !c.isGenerated && !c.isIdentity);
  const width = Math.max(...ins.map((c) => placeholder(c).length), 4);
  const values = ins.map((c, i) => `    ${(placeholder(c) + (i < ins.length - 1 ? ',' : '')).padEnd(width + 2)}-- ${c.name} ${c.dataType}${c.nullable ? '' : ' NOT NULL'}${c.default ? ` DEFAULT ${c.default}` : ''}`);
  return `INSERT INTO ${fq(schema, table)} (${ins.map((c) => qi(c.name)).join(', ')})\nVALUES (\n${values.join('\n')}\n)\nRETURNING *;\n`;
}

function whereClause(cols: Col[]): string {
  const keys = cols.filter((c) => c.isPrimaryKey);
  const use = keys.length ? keys : cols.slice(0, 1);
  return use.map((c) => `${qi(c.name)} = ${placeholder(c)}`).join('\n   AND ');
}

export function updateTemplate(schema: string, table: string, cols: Col[]): string {
  const set = cols.filter((c) => !c.isPrimaryKey && !c.isGenerated && c.isIdentity !== true);
  return `UPDATE ${fq(schema, table)}\n   SET ${set.map((c) => `${qi(c.name)} = ${placeholder(c)}`).join(',\n       ')}\n WHERE ${whereClause(cols)};\n`;
}

export function deleteTemplate(schema: string, table: string, cols: Col[]): string {
  return `DELETE FROM ${fq(schema, table)}\n WHERE ${whereClause(cols)};\n`;
}

// ------------------------------------------------------------------ column editing

export interface ColumnDraft {
  key: string;
  /** Existing column (undefined = new column). */
  orig?: ColumnDetail;
  name: string;
  type: string;
  nullable: boolean;
  default: string;
  comment: string;
  drop?: boolean;
  /** New columns only */
  identity?: '' | 'a' | 'd';
  pk?: boolean;
  unique?: boolean;
}

export function draftFromColumn(c: ColumnDetail): ColumnDraft {
  return {
    key: `c${c.attnum}`,
    orig: c,
    name: c.name,
    type: c.dataType,
    nullable: c.nullable,
    default: c.default ?? '',
    comment: c.comment ?? '',
  };
}

const normType = (t: string) => t.trim().replace(/\s+/g, ' ').toLowerCase();

export type DraftField = 'name' | 'type' | 'nullable' | 'default' | 'comment';
export function changedFields(d: ColumnDraft): Set<DraftField> {
  const s = new Set<DraftField>();
  const o = d.orig;
  if (!o) return s;
  if (d.name.trim() !== o.name) s.add('name');
  if (normType(d.type) !== normType(o.dataType)) s.add('type');
  if (d.nullable !== o.nullable) s.add('nullable');
  if (d.default.trim() !== (o.default ?? '').trim()) s.add('default');
  if (d.comment.trim() !== (o.comment ?? '').trim()) s.add('comment');
  return s;
}

export function isDraftDirty(d: ColumnDraft): boolean {
  return !d.orig || !!d.drop || changedFields(d).size > 0;
}

export function newColumnDef(d: ColumnDraft, inline = true): string {
  let s = `${qi(d.name.trim())} ${d.type.trim()}`;
  if (d.identity) s += ` GENERATED ${d.identity === 'a' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY`;
  else if (d.default.trim()) s += ` DEFAULT ${d.default.trim()}`;
  if (!d.nullable && !d.pk) s += ' NOT NULL';
  if (inline && d.pk) s += ' PRIMARY KEY';
  if (inline && d.unique && !d.pk) s += ' UNIQUE';
  return s;
}

/** ALTER statements for a list of column drafts against an existing table. */
export function columnChanges(schema: string, table: string, drafts: ColumnDraft[], tableComment?: { from: string | null; to: string }): string[] {
  const t = fq(schema, table);
  const out: string[] = [];
  for (const d of drafts) {
    const o = d.orig;
    if (o && d.drop) {
      out.push(`ALTER TABLE ${t} DROP COLUMN ${qi(o.name)}`);
      continue;
    }
    if (!o) {
      if (d.drop || !d.name.trim() || !d.type.trim()) continue;
      out.push(`ALTER TABLE ${t} ADD COLUMN ${newColumnDef(d)}`);
      if (d.comment.trim()) out.push(`COMMENT ON COLUMN ${t}.${qi(d.name.trim())} IS ${commentLit(d.comment)}`);
      continue;
    }
    const ch = changedFields(d);
    let name = o.name;
    if (ch.has('name') && d.name.trim()) {
      out.push(`ALTER TABLE ${t} RENAME COLUMN ${qi(o.name)} TO ${qi(d.name.trim())}`);
      name = d.name.trim();
    }
    const col = `ALTER TABLE ${t} ALTER COLUMN ${qi(name)}`;
    if (ch.has('type')) out.push(`${col} TYPE ${d.type.trim()} USING ${qi(name)}::${d.type.trim()}`);
    if (ch.has('nullable')) out.push(`${col} ${d.nullable ? 'DROP' : 'SET'} NOT NULL`);
    if (ch.has('default')) out.push(d.default.trim() ? `${col} SET DEFAULT ${d.default.trim()}` : `${col} DROP DEFAULT`);
    if (ch.has('comment')) out.push(`COMMENT ON COLUMN ${t}.${qi(name)} IS ${commentLit(d.comment)}`);
  }
  if (tableComment && (tableComment.to.trim() !== (tableComment.from ?? '').trim())) {
    out.push(`COMMENT ON TABLE ${t} IS ${commentLit(tableComment.to)}`);
  }
  return out;
}

// ------------------------------------------------------------------ create table

export interface NewForeignKey {
  key: string;
  name: string;
  columns: string[];
  refSchema: string;
  refTable: string;
  refColumns: string[];
  onDelete: string;
  onUpdate: string;
}

export const FK_ACTIONS = ['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT'];

export function fkClause(fk: Pick<NewForeignKey, 'columns' | 'refSchema' | 'refTable' | 'refColumns' | 'onDelete' | 'onUpdate'>): string {
  let s = `FOREIGN KEY (${fk.columns.map(qi).join(', ')}) REFERENCES ${fq(fk.refSchema, fk.refTable)} (${fk.refColumns.map(qi).join(', ')})`;
  if (fk.onDelete && fk.onDelete !== 'NO ACTION') s += ` ON DELETE ${fk.onDelete}`;
  if (fk.onUpdate && fk.onUpdate !== 'NO ACTION') s += ` ON UPDATE ${fk.onUpdate}`;
  return s;
}

export interface CreateTableSpec {
  schema: string;
  name: string;
  columns: ColumnDraft[];
  foreignKeys: NewForeignKey[];
  comment: string;
  unlogged?: boolean;
  ifNotExists?: boolean;
}

export function createTableSql(spec: CreateTableSpec): string[] {
  const t = fq(spec.schema, spec.name.trim() || 'new_table');
  const cols = spec.columns.filter((c) => c.name.trim() && c.type.trim());
  const pk = cols.filter((c) => c.pk);
  const lines = cols.map((c) => '    ' + newColumnDef({ ...c, pk: pk.length === 1 && c.pk }, true));
  if (pk.length > 1) lines.push(`    PRIMARY KEY (${pk.map((c) => qi(c.name.trim())).join(', ')})`);
  for (const fk of spec.foreignKeys) {
    if (!fk.columns.length || !fk.refTable || fk.refColumns.length !== fk.columns.length) continue;
    lines.push(`    ${fk.name.trim() ? `CONSTRAINT ${qi(fk.name.trim())} ` : ''}${fkClause(fk)}`);
  }
  const out = [`CREATE ${spec.unlogged ? 'UNLOGGED ' : ''}TABLE ${spec.ifNotExists ? 'IF NOT EXISTS ' : ''}${t} (\n${lines.join(',\n')}\n)`];
  if (spec.comment.trim()) out.push(`COMMENT ON TABLE ${t} IS ${lit(spec.comment.trim())}`);
  for (const c of cols) if (c.comment.trim()) out.push(`COMMENT ON COLUMN ${t}.${qi(c.name.trim())} IS ${lit(c.comment.trim())}`);
  return out;
}

// ------------------------------------------------------------------ indexes & constraints

export interface IndexSpec {
  schema: string;
  table: string;
  name: string;
  method: string;
  unique: boolean;
  columns: { expr: string; desc?: boolean }[];
  include: string[];
  where: string;
  concurrently: boolean;
  ifNotExists?: boolean;
}

export const INDEX_METHODS = ['btree', 'hash', 'gin', 'gist', 'spgist', 'brin'];

export function createIndexSql(s: IndexSpec): string {
  const cols = s.columns.filter((c) => c.expr.trim()).map((c) => {
    const e = c.expr.trim();
    const expr = /^[a-z_][a-z0-9_$]*$/i.test(e) && !e.includes('(') ? qi(e) : e.startsWith('(') || /\w\(/.test(e) ? e : `(${e})`;
    return expr + (c.desc ? ' DESC' : '');
  });
  let sql = `CREATE ${s.unique ? 'UNIQUE ' : ''}INDEX ${s.concurrently ? 'CONCURRENTLY ' : ''}${s.ifNotExists ? 'IF NOT EXISTS ' : ''}${s.name.trim() ? qi(s.name.trim()) + ' ' : ''}ON ${fq(s.schema, s.table)}`;
  if (s.method && s.method !== 'btree') sql += ` USING ${s.method}`;
  sql += ` (${cols.join(', ')})`;
  if (s.include.length) sql += ` INCLUDE (${s.include.map(qi).join(', ')})`;
  if (s.where.trim()) sql += ` WHERE ${s.where.trim()}`;
  return sql;
}

export function suggestIndexName(table: string, cols: string[], unique: boolean): string {
  const parts = cols.map((c) => c.replace(/[^a-z0-9_]+/gi, '_').replace(/^_|_$/g, '').toLowerCase()).filter(Boolean);
  return `${table}_${parts.join('_') || 'expr'}_${unique ? 'key' : 'idx'}`.slice(0, 63);
}

// ------------------------------------------------------------------ drop helpers

export type DropKind =
  | 'table' | 'partitioned_table' | 'view' | 'materialized_view' | 'foreign_table' | 'sequence'
  | 'function' | 'procedure' | 'aggregate' | 'type' | 'enum' | 'domain' | 'schema' | 'index' | 'extension';

export const DROP_KEYWORD: Record<DropKind, string> = {
  table: 'TABLE', partitioned_table: 'TABLE', view: 'VIEW', materialized_view: 'MATERIALIZED VIEW', foreign_table: 'FOREIGN TABLE',
  sequence: 'SEQUENCE', function: 'FUNCTION', procedure: 'PROCEDURE', aggregate: 'AGGREGATE', type: 'TYPE', enum: 'TYPE', domain: 'DOMAIN',
  schema: 'SCHEMA', index: 'INDEX', extension: 'EXTENSION',
};

/** Object reference used in DROP/ALTER/COMMENT: schema-qualified, with (args) for routines. */
export function objectRef(kind: string, schema: string, name: string, args?: string): string {
  if (kind === 'schema') return qi(name);
  if (kind === 'extension') return qi(name);
  const base = fq(schema, name);
  return ['function', 'procedure', 'aggregate'].includes(kind) ? `${base}(${args ?? ''})` : base;
}

/** ALTER keyword for rename etc. */
export function alterKeyword(kind: string): string {
  return DROP_KEYWORD[kind as DropKind] ?? 'TABLE';
}
