/**
 * The store pass: which data store each `table` node lives in (docs/proposals/data-stores.md §3.1).
 *
 * Runs once in `ingestRepo`, over every adapter's tables at once. The rules apply in order and the
 * first that names a store wins; a rule that cannot name exactly one store names none and says so
 * in `meta.stores.notes` — nothing is guessed.
 *
 * 1. `factory`    — set by the TS/JS adapter itself on a `pgTable` / `mysqlTable` / `sqliteTable` node.
 * 2. `sdk`        — the SQL driver packages the TS/JS code imports (`fragment.meta.stores.drivers`):
 *                   drivers of exactly one store → every non-Java table lives there; two stores → nothing.
 * 3. `datasource` — `schema.prisma` → `datasource { provider = "postgresql" }`, for non-Java tables.
 * 4. `jpa`        — `spring.datasource.url` in `application.properties` / `application.yml`, engine from the
 *                   jdbc prefix, for Java (`lang: 'java'`) tables.
 * 5. `config`     — `farsight.config.json → stores[]`: with `tables` it names those, without it every
 *                   table the code left unnamed. Config never overrides what code found (principle 2).
 *                   A nested config's declarations reach only the tables under its folder (`loc.path`;
 *                   a table with no location is under a folder when every piece of code that reads or
 *                   writes it is). For one table a `tables` list beats a catch-all, then the nearer
 *                   file wins; two files listing the same table under different stores is a conflict.
 */
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import type { GraphFragment, GraphNode, StoreRef, StoreVia, StoresMeta, StoreDecl } from '@farsight/core';
import type { ScopedStoreDecl } from './shared/config-files.js';
import type { IngestOptions } from './types.js';
import { collectFiles } from './shared/files.js';
import { SQL_DRIVERS } from './tsjs.js';

type Store = Omit<StoreRef, 'via' | 'ref'>;

/** Prisma `datasource { provider }` values → the store. */
const PRISMA_PROVIDERS: Record<string, Store> = {
  postgresql: { name: 'Postgres', kind: 'sql', engine: 'postgres' },
  postgres: { name: 'Postgres', kind: 'sql', engine: 'postgres' },
  mysql: { name: 'MySQL', kind: 'sql', engine: 'mysql' },
  sqlite: { name: 'SQLite', kind: 'sql', engine: 'sqlite' },
  sqlserver: { name: 'SQL Server', kind: 'sql', engine: 'mssql' },
  mongodb: { name: 'MongoDB', kind: 'document', engine: 'mongodb' },
  cockroachdb: { name: 'CockroachDB', kind: 'sql' },
};

/** `jdbc:<sub>:` prefixes → the store. */
const JDBC_PREFIXES: Record<string, Store> = {
  postgresql: { name: 'Postgres', kind: 'sql', engine: 'postgres' },
  mysql: { name: 'MySQL', kind: 'sql', engine: 'mysql' },
  mariadb: { name: 'MariaDB', kind: 'sql', engine: 'mysql' },
  sqlserver: { name: 'SQL Server', kind: 'sql', engine: 'mssql' },
  sqlite: { name: 'SQLite', kind: 'sql', engine: 'sqlite' },
  oracle: { name: 'Oracle', kind: 'sql' },
  h2: { name: 'H2', kind: 'sql' },
};

const STORE_FILES = new Set(['schema.prisma', 'application.properties', 'application.yml', 'application.yaml']);

/** The one store a set of findings names, or the distinct names when there are several (a note, not a pick). */
function single(found: { store: Store; ref: string }[]): { store: Store; ref: string } | { names: string[] } | undefined {
  if (!found.length) return undefined;
  const names = [...new Set(found.map((f) => f.store.name))].sort();
  if (names.length > 1) return { names };
  const refs = [...new Set(found.map((f) => f.ref))].sort();
  return { store: found[0]!.store, ref: refs.join(', ') };
}

/** `datasource <name> { provider = "postgresql" … }` blocks of one schema.prisma. */
export function prismaProviders(text: string): { provider?: string; raw: string }[] {
  const out: { provider?: string; raw: string }[] = [];
  for (const block of text.matchAll(/datasource\s+\w+\s*\{([^}]*)\}/g)) {
    const m = /provider\s*=\s*(\S+)/.exec(block[1]!);
    if (!m) continue;
    const lit = /^"([^"]+)"$/.exec(m[1]!);
    out.push({ ...(lit ? { provider: lit[1]! } : {}), raw: m[1]! });
  }
  return out;
}

/** The jdbc sub-protocol `spring.datasource.url` names in a properties or YAML file, if a literal one is there. */
export function springDatasourceJdbc(text: string, yaml: boolean): string | undefined {
  if (!yaml) {
    const m = /^\s*spring\.datasource\.url\s*[=:]\s*jdbc:([a-z0-9]+):/im.exec(text);
    return m?.[1]?.toLowerCase();
  }
  const flat = /^\s*spring\.datasource\.url\s*:\s*["']?jdbc:([a-z0-9]+):/im.exec(text);
  if (flat) return flat[1]!.toLowerCase();
  // spring:\n  datasource:\n    url: jdbc:…  — the url key indented under a datasource key
  const nested = /^(\s*)datasource:\s*\n((?:\1\s+.*\n?)*)/m.exec(text);
  if (!nested) return undefined;
  const url = /^\s+url\s*:\s*["']?jdbc:([a-z0-9]+):/m.exec(nested[2]!);
  return url?.[1]?.toLowerCase();
}

/**
 * Put a `store` on every table node a rule can name, and the pass's evidence on `fragment.meta.stores`.
 * `drivers` are the TS/JS adapter's driver imports (read before the spec and design passes rebuild meta).
 */
export function applyStores(
  fragment: GraphFragment,
  repoRoot: string,
  options: IngestOptions,
  stores: (StoreDecl | ScopedStoreDecl)[] | undefined,
  drivers: { spec: string; files: number }[],
  /** two files list the same table under different stores: the table, the files, the one kept */
  onConflict?: (key: string, files: string[], kept: string) => void,
): StoresMeta {
  const tables = fragment.nodes.filter((n) => n.kind === 'table');
  const notes: string[] = [];
  const named: Partial<Record<StoreVia, number>> = {};
  const give = (n: GraphNode, store: Store, via: StoreVia, ref: string) => {
    if (n.store) return;
    n.store = { ...store, via, ref };
    named[via] = (named[via] ?? 0) + 1;
  };
  for (const n of tables) if (n.store) named[n.store.via] = (named[n.store.via] ?? 0) + 1;
  const isJava = (n: GraphNode) => n.lang === 'java';

  // sdk — the driver imports
  const bySdk = single(drivers.filter((d) => SQL_DRIVERS[d.spec]).map((d) => ({ store: SQL_DRIVERS[d.spec]!, ref: d.spec })));
  if (bySdk && 'names' in bySdk) notes.push(`The code imports SQL drivers for more than one store (${bySdk.names.join(', ')}), so the driver names no store for its tables.`);
  else if (bySdk) for (const n of tables) if (!isJava(n)) give(n, bySdk.store, 'sdk', bySdk.ref);

  // datasource + jpa — the few files that declare a connection, read only when a table is still unnamed
  if (tables.some((n) => !n.store)) {
    const files = collectFiles(repoRoot, [...STORE_FILES], options, (base) => !STORE_FILES.has(base)).sort();
    const prisma: { store: Store; ref: string }[] = [];
    const jpa: { store: Store; ref: string }[] = [];
    for (const abs of files) {
      const rel = relative(repoRoot, abs);
      let text: string;
      try { text = readFileSync(abs, 'utf8'); } catch { continue; }
      if (rel.endsWith('schema.prisma')) {
        for (const p of prismaProviders(text)) {
          const store = p.provider ? PRISMA_PROVIDERS[p.provider.toLowerCase()] : undefined;
          if (store) prisma.push({ store, ref: rel });
          else notes.push(`${rel} names its datasource provider as ${p.raw}, which is not a provider this pass knows, so it names no store.`);
        }
      } else {
        const sub = springDatasourceJdbc(text, !rel.endsWith('.properties'));
        if (!sub) continue;
        const store = JDBC_PREFIXES[sub];
        if (store) jpa.push({ store, ref: `${rel} spring.datasource.url` });
        else notes.push(`${rel} names a jdbc:${sub} datasource, which this pass does not know, so it names no store.`);
      }
    }
    const byPrisma = single(prisma);
    if (byPrisma && 'names' in byPrisma) notes.push(`The schema.prisma files name more than one datasource (${byPrisma.names.join(', ')}), so they name no store.`);
    else if (byPrisma) for (const n of tables) if (!isJava(n)) give(n, byPrisma.store, 'datasource', byPrisma.ref);
    const byJpa = single(jpa);
    if (byJpa && 'names' in byJpa) notes.push(`The Spring settings name more than one datasource (${byJpa.names.join(', ')}), so they name no store.`);
    else if (byJpa) for (const n of tables) if (isJava(n)) give(n, byJpa.store, 'jpa', byJpa.ref);
  }

  // config — for each table still unnamed: a declaration that lists it beats a catch-all, then the
  // nearer file (deeper folder) wins; a nested file reaches only the tables under its folder
  const decls = (stores ?? []).map((d, order) => ({
    d, order, dir: 'dir' in d ? d.dir : '.', from: 'from' in d ? d.from : 'farsight.config.json',
  }));
  if (decls.length) {
    const folders = tableFolders(fragment);
    const under = (n: GraphNode, dir: string) => dir === '.' || (folders.get(n.id) ?? []).length > 0
      && folders.get(n.id)!.every((p) => p.startsWith(`${dir}/`));
    const nearest = <T extends { dir: string; order: number }>(xs: T[]) =>
      [...xs].sort((a, b) => depthOf(b.dir) - depthOf(a.dir) || a.order - b.order)[0];
    const refOf = (x: { d: StoreDecl; from: string; dir: string }) =>
      `${x.dir === '.' ? 'farsight.config.json' : x.from} stores: ${x.d.name}`;
    for (const n of tables) {
      if (n.store) continue;
      const listing = decls.filter((x) => x.d.tables?.includes(n.name) && under(n, x.dir));
      const pick = listing.length
        ? nearest(listing)
        // each file's first catch-all is its catch-all, as for the root before nested files
        : nearest(decls.filter((x) => !x.d.tables && under(n, x.dir) && decls.find((y) => y.from === x.from && !y.d.tables) === x));
      if (!pick) continue;
      give(n, storeOfDecl(pick.d), 'config', refOf(pick));
      const others = listing.filter((x) => x.from !== pick.from && x.d.name !== pick.d.name);
      if (others.length && onConflict) {
        onConflict(n.loc?.path ? `${n.name} (${n.loc.path})` : n.name, [...new Set([pick.from, ...others.map((x) => x.from)])], pick.from);
      }
    }
    // a nested file that lists a table outside its folder: said, not applied
    for (const x of decls) {
      if (x.dir === '.' || !x.d.tables) continue;
      for (const name of x.d.tables) {
        const named = tables.filter((n) => n.name === name);
        if (named.length && !named.some((n) => under(n, x.dir))) {
          notes.push(`${x.from} lists the table ${name} under the store ${x.d.name}, but that table is not under ${x.dir}/, so this file does not name its store.`);
        }
      }
    }
  }

  const unnamed = tables.filter((n) => !n.store).length;
  return {
    ...(drivers.length ? { drivers } : {}),
    ...(Object.keys(named).length ? { named } : {}),
    ...(tables.length ? { unnamed } : {}),
    ...(notes.length ? { notes } : {}),
  };
}

function storeOfDecl(d: StoreDecl): Store {
  return { name: d.name, kind: d.kind, ...(d.engine ? { engine: d.engine } : {}) };
}

const depthOf = (dir: string) => (dir === '.' ? 0 : dir.split('/').length);

/**
 * The files each table sits in, for scoping a nested config's stores: the table's own `loc.path`
 * when it has one, else the files of the code that reads or writes it.
 */
function tableFolders(fragment: GraphFragment): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const byId = new Map(fragment.nodes.map((n) => [n.id, n]));
  for (const n of fragment.nodes) if (n.kind === 'table' && n.loc?.path) out.set(n.id, [n.loc.path]);
  for (const e of fragment.edges) {
    if (e.kind !== 'reads' && e.kind !== 'writes') continue;
    const t = byId.get(e.to);
    if (t?.kind !== 'table' || t.loc?.path) continue;
    const p = byId.get(e.from)?.loc?.path;
    if (!p) continue;
    const had = out.get(t.id) ?? [];
    if (!had.includes(p)) had.push(p);
    out.set(t.id, had);
  }
  return out;
}
