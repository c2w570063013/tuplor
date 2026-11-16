import { create } from 'zustand';
import type { Catalog, CatalogFunction, CatalogRelation } from '@shared/completion';
import { dbUrl, http } from '@/lib/api';

/** Catalog + lookup indexes for fast completion. */
export interface CatalogIndex {
  catalog: Catalog;
  /** lower(name) -> relations with that name (any schema) */
  relByName: Map<string, CatalogRelation[]>;
  /** lower(schema) -> relations */
  relBySchema: Map<string, CatalogRelation[]>;
  /** lower(name) -> functions (user + builtin) */
  funcByName: Map<string, CatalogFunction[]>;
  schemaSet: Set<string>;
  searchPath: string[];
}

function buildIndex(catalog: Catalog): CatalogIndex {
  const relByName = new Map<string, CatalogRelation[]>();
  const relBySchema = new Map<string, CatalogRelation[]>();
  for (const r of catalog.relations) {
    const k = r.n.toLowerCase();
    (relByName.get(k) ?? relByName.set(k, []).get(k)!).push(r);
    const s = r.s.toLowerCase();
    (relBySchema.get(s) ?? relBySchema.set(s, []).get(s)!).push(r);
  }
  const funcByName = new Map<string, CatalogFunction[]>();
  for (const f of [...catalog.functions, ...catalog.builtins]) {
    const k = f.n.toLowerCase();
    (funcByName.get(k) ?? funcByName.set(k, []).get(k)!).push(f);
  }
  return {
    catalog,
    relByName,
    relBySchema,
    funcByName,
    schemaSet: new Set(catalog.schemas.map((s) => s.toLowerCase())),
    searchPath: catalog.searchPath.length ? catalog.searchPath : ['public'],
  };
}

interface Entry {
  index?: CatalogIndex;
  loading: boolean;
  error?: string;
  promise?: Promise<CatalogIndex | undefined>;
}

/** Per (connection, database) catalog cache. Components can subscribe for status display. */
export const useCatalogStore = create<{ entries: Record<string, Entry> }>(() => ({ entries: {} }));

const key = (connId: string, db: string) => `${connId}\u0000${db}`;

/** Get (and lazily load) the catalog for a database. Resolves undefined on failure. */
export function loadCatalog(connId: string, db: string, force = false): Promise<CatalogIndex | undefined> {
  const k = key(connId, db);
  const cur = useCatalogStore.getState().entries[k];
  if (!force && cur?.index) return Promise.resolve(cur.index);
  if (!force && cur?.promise) return cur.promise;
  const promise = http
    .get<Catalog>(`${dbUrl(connId, db)}/completion/catalog`)
    .then((c) => {
      const index = buildIndex(c);
      setEntry(k, { index, loading: false });
      return index;
    })
    .catch((e) => {
      setEntry(k, { index: cur?.index, loading: false, error: e?.message ?? String(e) });
      return cur?.index;
    });
  setEntry(k, { index: cur?.index, loading: true, promise });
  return promise;
}

export function getCachedCatalog(connId: string, db: string): CatalogIndex | undefined {
  return useCatalogStore.getState().entries[key(connId, db)]?.index;
}

export function useCatalogEntry(connId?: string, db?: string): Entry | undefined {
  return useCatalogStore((s) => (connId && db ? s.entries[key(connId, db)] : undefined));
}

function setEntry(k: string, e: Entry) {
  useCatalogStore.setState((s) => ({ entries: { ...s.entries, [k]: e } }));
}
