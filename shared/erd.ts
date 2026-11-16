/** ER diagram API contract. GET /api/c/:connId/db/:db/erd?schemas=a,b&views=1 */

export type ErdTableKind = 'table' | 'partitioned_table' | 'view' | 'materialized_view' | 'foreign_table';

export interface ErdColumn {
  name: string;
  /** format_type() output, e.g. "character varying(80)". */
  type: string;
  nullable: boolean;
  pk: boolean;
  /** Part of at least one foreign key. */
  fk: boolean;
  /** Covered by a single-column unique constraint / unique index. */
  unique: boolean;
  default: string | null;
  comment: string | null;
}

export interface ErdTable {
  /** "schema.name" — stable id used for nodes and positions. */
  id: string;
  schema: string;
  name: string;
  kind: ErdTableKind;
  comment: string | null;
  estRows: number | null;
  columns: ErdColumn[];
}

export interface ErdRelation {
  /** "schema.table.constraint" */
  id: string;
  name: string;
  /** Referencing (child) table id + columns. */
  source: string;
  sourceColumns: string[];
  /** Referenced (parent) table id + columns. */
  target: string;
  targetColumns: string[];
  onUpdate: string;
  onDelete: string;
  /** Child columns are unique → 1:1 instead of N:1. */
  oneToOne: boolean;
  /** Any child column nullable → relationship is optional (0..1 on the parent side). */
  optional: boolean;
}

export interface ErdResponse {
  /** All non-system schemas with their table counts (for the filter UI). */
  schemas: { name: string; tables: number }[];
  /** Schemas actually included in this response. */
  included: string[];
  tables: ErdTable[];
  relations: ErdRelation[];
  /** FKs pointing from an included table to a table outside the included schemas. */
  externalRelations: number;
}
