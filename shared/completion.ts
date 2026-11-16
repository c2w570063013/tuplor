/**
 * SQL Editor & Explain — API contract (owned by the SQL Editor team).
 *
 *   GET    /api/c/:connId/db/:db/completion/catalog       -> Catalog
 *   GET    /api/history?q=&connId=&db=&limit=&errors=      -> HistoryEntry[] (newest first)
 *   POST   /api/history                                    <- HistoryInput  -> HistoryEntry
 *   DELETE /api/history[/:id]                              -> { ok }
 *   GET    /api/snippets                                   -> Snippet[]
 *   POST   /api/snippets                                   <- Snippet (id optional) -> Snippet
 *   DELETE /api/snippets/:id                               -> { ok }
 */

/** Relation kinds in the compact catalog: r table, p partitioned, v view, m matview, f foreign. */
export type CatalogRelKind = 'r' | 'p' | 'v' | 'm' | 'f';

export interface CatalogColumn {
  /** column name */
  n: string;
  /** formatted data type */
  t: string;
  /** nullable */
  nn?: boolean;
  /** part of primary key */
  pk?: boolean;
  /** comment */
  c?: string;
}

export interface CatalogRelation {
  s: string;
  n: string;
  k: CatalogRelKind;
  cols: CatalogColumn[];
  c?: string;
  /** estimated rows */
  est?: number;
  /** outgoing foreign keys (used for JOIN … ON suggestions) */
  fks?: CatalogForeignKey[];
}

export interface CatalogForeignKey {
  cols: string[];
  /** referenced relation schema / name */
  rs: string;
  rn: string;
  rcols: string[];
}

export interface CatalogFunction {
  s: string;
  n: string;
  /** argument list as in pg_get_function_arguments */
  args: string;
  /** result type */
  ret: string;
  /** f function, p procedure, a aggregate, w window */
  k: 'f' | 'p' | 'a' | 'w';
  c?: string;
}

export interface Catalog {
  /** current_schemas(false) — the effective search_path */
  searchPath: string[];
  schemas: string[];
  relations: CatalogRelation[];
  /** user-defined functions (non-system schemas) */
  functions: CatalogFunction[];
  /** frequently used built-in functions from pg_catalog (name + signature) */
  builtins: CatalogFunction[];
  /** type names (built-in + user types, schema-qualified when not in pg_catalog) */
  types: string[];
  generatedAt: string;
}

export interface HistoryEntry {
  id: string;
  sql: string;
  connId: string;
  connName?: string;
  database: string;
  /** ISO timestamp */
  at: string;
  durationMs: number;
  /** rows returned/affected by the last statement */
  rows: number | null;
  error?: string;
  /** number of statements in the run */
  statements?: number;
}

export type HistoryInput = Omit<HistoryEntry, 'id' | 'at'>;

export interface Snippet {
  id: string;
  name: string;
  sql: string;
  description?: string;
  createdAt?: string;
  updatedAt?: string;
}
