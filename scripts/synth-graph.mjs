#!/usr/bin/env node
// `node scripts/synth-graph.mjs [--preset full|small] [--out graph.json] [--seed N] [--sources N]
//   [--projects N] [--nodes N] [--flows N] [--manifests N] [--settings dir]`
//
// A synthetic workspace graph for performance work: seeded and deterministic (the same flags write the
// same bytes), in the current schema (packages/core/src/graph.ts), shaped the way `farsight ingest` writes
// an NX monorepo — copied from what examples/nx-workspace and examples/invoice-app ingest to, scaled up.
// It is never ingested from code and never written over a checkout's graph.json: write it into a
// scratchpad or build/ (both gitignored) and serve it with the real `farsight serve`.
//
// The shape it makes (per source, `src00` … `srcNN`; the numbers are the full preset's):
//   - projects (`meta.projects[repo]`, tool `nx`): `projects / sources` per source — 4 web applications
//     (`<repo>-web-<k>`), one API application (`<repo>-api`), one e2e project per web app pair, and
//     libraries in layers: feature → ui · data-access → util, each tagged `scope:<domain>` and
//     `type:app|feature|ui|data-access|util|e2e` (tag dimensions domain · type · platform, `tagValues` words),
//     with project → project `imports` counted from the module import edges below and NX `dependencies`
//   - every code node carries `project` (name, root, type, tags) like the ingest's projects pass
//   - modules (`<repo>::module::<path>`): one per file, `imports` edges to the workspace packages of the
//     libraries the project depends on and to third-party packages
//   - functions (with snippet, signature, sometimes docs and a business label), components in ui / feature /
//     app projects, a few classes, rules (`validates`), guards (`guards` on routes), tables in data-access
//     libraries (`store` Postgres), store-like externals (ERP, files) reached by `http` edges
//   - `calls` inside a project and into the libraries it depends on; `renders` component → component;
//     function → package `imports` (meta.use) for a share of functions
//   - the API application's routes (`<repo>::route::<METHOD> <path>`, contract status `both`, an `api`
//     node that `contains` them), handlers called from the route, client functions in feature libraries
//     with `http` edges (meta.method/path) to the routes, data-access functions that `reads` / `writes` tables
//   - pages (`<repo>::page::/<app>/<screen>`) rendering an app component, under design manifests
//     (`design` nodes, `contains` their pages and flows); `flows / sources` flows per source across
//     `manifests / sources` manifests, each a `flow` node that `renders` 3–7 screens in order (meta.line),
//     with persona, group, order and position; `meta.journeys[repo]` declares the personas and groups
//   - tests: unit cases in every library (`covers` static edges to the functions they import, a run on most
//     of them), e2e cases in the e2e projects (`covers` declared to flows and static to pages);
//     `meta.tests[repo]` with a results report per source
//   - work items (`work::jira-perf::PERF-<n>`) with `tracks` edges to functions
// Full preset: 20 sources · 1,000 projects · ≈250k nodes · ≈400k edges · 300 flows in 40 manifests.
// Small preset (CI): 4 sources · 52 projects · ≈20k nodes · 40 flows in 8 manifests.
//
// `--settings <dir>` also writes `<dir>/.farsight/settings.json` naming every source (local, enabled, the map
// flag on), so a server started with that cwd has the scope menu a real workspace would have.
import { closeSync, mkdirSync, openSync, writeSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const PRESETS = {
  full: { sources: 20, projects: 1000, nodes: 250_000, flows: 300, manifests: 40 },
  small: { sources: 4, projects: 52, nodes: 20_000, flows: 40, manifests: 8 },
};

export function parseArgs(argv) {
  const opts = { preset: 'full', out: 'graph.json', seed: 1 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => argv[++i];
    if (a === '--preset') opts.preset = v();
    else if (a === '--out') opts.out = v();
    else if (a === '--seed') opts.seed = Number(v());
    else if (a === '--settings') opts.settings = v();
    else if (['--sources', '--projects', '--nodes', '--flows', '--manifests'].includes(a)) opts[a.slice(2)] = Number(v());
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`unknown flag ${a}`);
  }
  const base = PRESETS[opts.preset];
  if (!base) throw new Error(`unknown preset ${opts.preset} — full or small`);
  return { ...base, ...Object.fromEntries(Object.entries(opts).filter(([, x]) => x !== undefined)) };
}

/** mulberry32 — a small seeded PRNG, so the same seed writes the same graph. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DOMAINS = ['billing', 'payments', 'ledger', 'orders', 'catalog', 'inventory', 'shipping', 'customers', 'vendors', 'contracts',
  'reports', 'audit', 'identity', 'notices', 'tax', 'refunds', 'scheduling', 'documents', 'claims', 'quotes', 'budgets', 'assets', 'search', 'support'];
const NOUNS = ['Invoice', 'Customer', 'Payment', 'Ledger', 'Shipment', 'Order', 'Item', 'Stock', 'Vendor', 'Contract', 'Report', 'Entry',
  'Session', 'Account', 'Rate', 'Refund', 'Slot', 'Notice', 'Approval', 'Document', 'Claim', 'Quote', 'Budget', 'Asset', 'Address', 'Note'];
const VERBS = ['list', 'get', 'create', 'update', 'remove', 'approve', 'submit', 'validate', 'format', 'compute', 'load', 'save', 'sync',
  'parse', 'build', 'resolve', 'check', 'export', 'import', 'merge', 'split', 'archive', 'restore', 'notify'];
const QUALS = ['', 'ById', 'ForUser', 'Draft', 'Batch', 'Summary', 'Totals', 'Lines', 'Status', 'History', 'Preview', 'Options'];
const THIRD = ['react', 'react-dom', 'zod', 'date-fns', 'lodash', 'rxjs', '@tanstack/react-query', 'axios', 'clsx', 'immer',
  'pg', 'drizzle-orm', 'express', 'uuid', 'decimal.js', 'i18next', 'zustand', 'yup', 'nanoid', 'luxon', '@azure/storage-blob',
  'dayjs', 'msw', 'ramda', 'qs', 'chart.js', 'd3', 'marked', 'dompurify', 'superjson'];
const PERSONAS = [['finance', 'Finance'], ['ops', 'Operations'], ['customer', 'Customer'], ['admin', 'Administrator']];
const GROUPS = [['start', 'Getting started'], ['daily', 'Daily work'], ['month-end', 'Month end'], ['review', 'Review and approve'], ['setup', 'Setup']];
const METHODS = ['GET', 'GET', 'GET', 'POST', 'PATCH', 'DELETE', 'PUT'];
const AT = '2026-10-01T09:00:00.000Z';

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const kebab = (s) => s.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
const hex = (n, len = 12) => (n >>> 0).toString(16).padStart(8, '0').repeat(2).slice(0, len);

export function synthesize(o) {
  const r = rng(o.seed || 1);
  const pick = (arr) => arr[Math.floor(r() * arr.length)];
  const int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
  const nodes = [];
  const edges = [];
  const edgeIds = new Set();
  const edge = (kind, from, to, meta, resolution) => {
    const id = `${kind}|${from}|${to}`;
    if (from === to || edgeIds.has(id)) return;
    edgeIds.add(id);
    edges.push({ id, kind, from, to, ...(meta ? { meta } : {}), ...(resolution ? { resolution } : {}) });
  };
  const RES = {
    imp: { status: 'resolved', technique: 'static-import', confidence: 'HIGH', note: 'the import resolved on disk' },
    same: { status: 'resolved', technique: 'same-file', confidence: 'HIGH', note: 'declared in the same file' },
    jsx: { status: 'resolved', technique: 'jsx-render', confidence: 'HIGH' },
    scan: { status: 'resolved', technique: 'annotation-scan', confidence: 'HIGH' },
    db: { status: 'resolved', technique: 'db-builder', confidence: 'HIGH', note: 'a builder chain names the table' },
    fetch: { status: 'resolved', technique: 'fetch→route', confidence: 'HIGH' },
    pkg: { status: 'resolved', technique: 'static-import', confidence: 'HIGH', note: 'the import names the package' },
    test: { status: 'resolved', technique: 'import-resolution', confidence: 'HIGH', note: 'the test imports and calls it' },
    route: { status: 'resolved', technique: 'route-literal', confidence: 'MEDIUM', note: 'a URL literal in the test' },
    sdk: { status: 'heuristic', technique: 'sdk-import', confidence: 'MEDIUM' },
    work: { status: 'heuristic', technique: 'work-key', confidence: 'MEDIUM' },
  };

  const meta = { tests: {}, stores: {}, projects: {}, journeys: {}, repos: {}, packages: {} };
  const perSource = Math.round(o.projects / o.sources);
  // the node budget per code project, after the per-source nodes (pages, packages, flows, routes…) are set aside
  const codeBudget = Math.max(40, Math.round((o.nodes * 1.0) / o.projects));
  const flowsPer = Math.round(o.flows / o.sources);
  const manifestsPer = Math.max(1, Math.round(o.manifests / o.sources));
  let workN = 0;

  for (let s = 0; s < o.sources; s++) {
    const repo = `src${String(s).padStart(2, '0')}`;
    const domains = Array.from({ length: 6 }, (_, k) => DOMAINS[(s * 5 + k) % DOMAINS.length]);
    const P = []; // projects
    const webApps = 4;
    for (let k = 0; k < webApps; k++) {
      const d = domains[k % domains.length];
      P.push({ name: `${repo}-web-${d}`, root: `apps/web-${d}`, type: 'application', layer: 'app', domain: d, tags: [`scope:${d}`, 'type:app', 'platform:web'] });
    }
    P.push({ name: `${repo}-api`, root: 'apps/api', type: 'application', layer: 'api', domain: domains[0], tags: [`scope:${domains[0]}`, 'type:app', 'platform:node'] });
    for (let k = 0; k < webApps / 2; k++) {
      const app = P[k * 2];
      P.push({ name: `${app.name}-e2e`, root: `apps/web-${app.domain}-e2e`, type: 'e2e', layer: 'e2e', domain: app.domain, tags: [`scope:${app.domain}`, 'type:e2e'], implicitDependencies: [app.name] });
    }
    const layers = ['feature', 'ui', 'data-access', 'util'];
    for (let k = 0; P.length < perSource; k++) {
      const layer = layers[k % layers.length];
      const d = domains[Math.floor(k / layers.length) % domains.length];
      const n = Math.floor(k / (layers.length * domains.length));
      const name = `${repo}-${d}-${layer}${n ? '-' + n : ''}`;
      P.push({ name, root: `libs/${d}/${layer}${n ? '-' + n : ''}`, type: 'library', layer, domain: d, tags: [`scope:${d}`, `type:${layer}`] });
    }
    const byLayer = (l) => P.filter((p) => p.layer === l);
    const libsOf = (layer, domain) => byLayer(layer).filter((p) => p.domain === domain || p.domain === domains[domains.length - 1]);
    // the project graph: who may import whom, layered the way NX module boundaries usually are
    for (const p of P) {
      p.deps = [];
      const add = (q) => { if (q && q !== p && !p.deps.includes(q)) p.deps.push(q); };
      if (p.layer === 'app') { for (const q of libsOf('feature', p.domain).slice(0, 4)) add(q); add(pick(byLayer('ui'))); add(pick(byLayer('util'))); }
      if (p.layer === 'api') { for (const q of byLayer('data-access').slice(0, 6)) add(q); add(pick(byLayer('util'))); }
      if (p.layer === 'feature') { add(pick(libsOf('ui', p.domain))); add(pick(libsOf('data-access', p.domain))); add(pick(byLayer('util'))); if (r() < 0.4) add(pick(byLayer('feature'))); }
      if (p.layer === 'ui') { add(pick(byLayer('util'))); }
      if (p.layer === 'data-access') { add(pick(byLayer('util'))); }
      if (p.layer === 'util' && r() < 0.3) { const u = byLayer('util'); const i = u.indexOf(p); if (i > 0) add(u[i - 1]); }
      if (p.layer === 'e2e') { add(P.find((q) => q.name === p.implicitDependencies[0])); }
      p.deps = p.deps.filter((q) => q.layer !== 'e2e' && q.layer !== 'app' || p.layer === 'e2e');
    }
    const projRef = (p) => ({ name: p.name, root: p.root, type: p.type, tags: p.tags });
    const imports = new Map(); // "from|to" → { imports, files:Set, top: Map }
    const countImport = (from, to, path) => {
      const k = from.name + '|' + to.name;
      let row = imports.get(k);
      if (!row) imports.set(k, (row = { from: from.name, to: to.name, imports: 0, files: new Set(), top: new Map() }));
      row.imports++; row.files.add(path); row.top.set(path, (row.top.get(path) || 0) + 1);
    };

    // ── packages: third-party per source, one workspace package per library ──
    const third = THIRD.map((name) => ({ id: `${repo}::package::${name}`, name }));
    for (const t of third) {
      nodes.push({ id: t.id, kind: 'package', name: t.name, tags: [], package: { scope: 'third-party', version: `^${int(1, 9)}.${int(0, 20)}.${int(0, 9)}`, declaredIn: ['package.json'] } });
    }
    for (const p of P) {
      if (p.type !== 'library') continue;
      p.pkgId = `${repo}::package::@${repo}/${p.root.slice(5)}`;
      nodes.push({ id: p.pkgId, kind: 'package', name: `@${repo}/${p.root.slice(5)}`, tags: [], package: { scope: 'workspace', project: p.name, root: p.root + '/src' } });
    }

    // ── tables and externals ──
    const tables = [];
    for (const p of byLayer('data-access')) {
      for (let k = 0; k < 3; k++) {
        const noun = NOUNS[(tables.length * 7 + s) % NOUNS.length].toLowerCase();
        const t = { id: `${repo}::table::${noun}_${tables.length}`, name: `${noun}_${tables.length}`, p };
        tables.push(t);
        nodes.push({ id: t.id, kind: 'table', name: t.name, tags: [p.domain, 'data'], store: { name: 'Postgres', kind: 'sql', engine: 'postgres', via: 'sdk', ref: 'pg' }, project: projRef(p) });
      }
    }
    const externals = [
      { id: `${repo}::external::Business Central`, name: 'Business Central', external: { kind: 'erp', source: 'config', store: true }, store: { name: 'Business Central', kind: 'erp', via: 'config' }, tags: ['external', 'erp'] },
      { id: `${repo}::external::Blob Storage`, name: 'Blob Storage', external: { kind: 'files', source: 'sdk', ref: '@azure/storage-blob', store: true }, store: { name: 'Azure Blob Storage', kind: 'files', via: 'sdk' }, tags: ['external', 'files'] },
      { id: `${repo}::external::Mail`, name: 'Mail', external: { kind: 'email', source: 'host', ref: 'MAIL_HOST' }, tags: ['external', 'email'] },
    ];
    for (const x of externals) nodes.push({ kind: 'external', ...x });

    // ── code: modules, functions, components, classes, rules, tests per project ──
    let fileCount = 0;
    let testCases = 0; let testRuns = 0; let testFiles = 0; const covers = { declared: 0, static: 0, observed: 0 };
    for (const p of P) {
      p.fns = []; p.comps = []; p.clients = []; p.handlers = []; p.dataFns = []; p.modules = [];
      const budget = p.layer === 'e2e' ? Math.round(codeBudget * 0.4) : codeBudget;
      const hasUi = p.layer === 'ui' || p.layer === 'feature' || p.layer === 'app';
      const testShare = p.layer === 'e2e' ? 0.9 : 0.3;
      const nTests = Math.round(budget * testShare);
      const nCode = budget - nTests;
      const perFile = 8;
      const files = Math.max(1, Math.round(nCode / (perFile + 1)));
      const srcBase = p.root + '/src/lib';
      let made = 0;
      for (let f = 0; f < files && p.layer !== 'e2e'; f++) {
        const noun = NOUNS[(f * 3 + s + p.name.length) % NOUNS.length];
        const path = `${srcBase}/${kebab(noun)}-${f}.${hasUi && f % 3 === 0 ? 'tsx' : 'ts'}`;
        const modId = `${repo}::module::${path}`;
        nodes.push({ id: modId, kind: 'module', name: path, loc: { repo, path, line: 1 }, tags: [], project: projRef(p) });
        p.modules.push({ id: modId, path });
        fileCount++;
        // imports: the libraries this project depends on, and a few third-party packages
        for (const q of p.deps) {
          if (q.pkgId && r() < 0.55) { edge('imports', modId, q.pkgId, { specifier: q.pkgId.split('::package::')[1], line: int(1, 6), form: 'import', names: `${pick(VERBS)}${pick(NOUNS)}` }, RES.pkg); countImport(p, q, path); }
        }
        for (let k = 0; k < 2; k++) { const t = pick(third); edge('imports', modId, t.id, { specifier: t.name, line: int(1, 8), form: 'import' }, RES.pkg); }
        const fileFns = [];
        for (let k = 0; k < perFile && made < nCode; k++, made++) {
          const isComp = hasUi && path.endsWith('.tsx') && k < 4;
          const verb = VERBS[(k * 5 + f) % VERBS.length];
          const qual = QUALS[(k + f * 7) % QUALS.length];
          const fname = isComp ? `${noun}${['Panel', 'Card', 'Table', 'Form', 'Dialog', 'Row'][k % 6]}${f}` : `${verb}${noun}${qual}${k}`;
          const kind = isComp ? 'component' : (k === perFile - 1 && f % 9 === 0 ? 'class' : 'function');
          const id = `${repo}::${path}::${fname}`;
          const line = 3 + k * 14;
          const node = {
            id, kind, name: fname, lang: 'ts', loc: { repo, path, line, endLine: line + 11 },
            snippet: isComp
              ? `function ${fname}({ ${noun.toLowerCase()}, onChange }: ${fname}Props) {\n  const [state, setState] = useState(initial${noun});\n  const rows = useMemo(() => select${noun}Rows(state), [state]);\n  return (\n    <Section title="${noun} ${['details', 'summary', 'lines'][k % 3]}">\n      {rows.map((row) => <${noun}Line key={row.id} row={row} onChange={onChange} />)}\n    </Section>\n  );\n}`
              : `export ${kind === 'class' ? 'class' : 'async function'} ${fname}(input: ${noun}Input, ctx: RequestContext): Promise<${noun}Result> {\n  const parsed = ${noun.toLowerCase()}Schema.parse(input);\n  const existing = await ctx.repo.find${noun}(parsed.id);\n  if (!existing) throw new NotFoundError('${noun.toLowerCase()} ' + parsed.id);\n  const next = { ...existing, ...parsed, updatedAt: ctx.clock.now() };\n  await ctx.repo.save${noun}(next);\n  return to${noun}Result(next);\n}`,
            signature: isComp ? `(${noun.toLowerCase()}: ${noun}, onChange: (next: ${noun}) => void)` : `(input: ${noun}Input, ctx: RequestContext) => Promise<${noun}Result>`,
            tags: [p.domain, ...(isComp ? ['ux'] : [])],
            project: projRef(p),
          };
          if ((k + f) % 4 === 0) node.docs = `${cap(verb)}s the ${noun.toLowerCase()} for the ${p.domain} team and records who changed it, so the next screen shows the current state.`;
          if ((k + f) % 6 === 0) node.facets = { business: { label: `${cap(verb)} ${noun.toLowerCase()}${qual ? ' ' + kebab(qual).replace(/-/g, ' ') : ''}`, description: `The ${p.domain} ${noun.toLowerCase()} as the team reads it.` } };
          nodes.push(node);
          fileFns.push(node);
          if (isComp) p.comps.push(node); else p.fns.push(node);
          if (!isComp && p.layer === 'feature' && k === 1) p.clients.push(node);
          if (!isComp && p.layer === 'data-access') p.dataFns.push(node);
          if (!isComp && p.layer === 'api') p.handlers.push(node);
        }
        // calls inside the file, then a use of an imported package now and then
        for (let k = 1; k < fileFns.length; k++) {
          if (fileFns[k].kind !== 'component') edge('calls', fileFns[k - 1].id, fileFns[k].id, { line: fileFns[k - 1].loc.line + 4 }, RES.same);
          if (r() < 0.25) { const t = pick(third); edge('imports', fileFns[k].id, t.id, { specifier: t.name, line: fileFns[k].loc.line + 2, use: true }, RES.pkg); }
        }
        if (made >= nCode) break;
      }
      // rules and guards
      if (p.layer === 'data-access' || p.layer === 'api') {
        for (let k = 0; k < 3 && p.fns.length; k++) {
          const target = pick(p.fns);
          const id = `${repo}::${target.loc.path}::${target.name}Schema`;
          nodes.push({ id, kind: 'rule', name: `${target.name}Schema`, lang: 'ts', loc: { repo, path: target.loc.path, line: 1, endLine: 1 }, tags: ['validation'], signature: 'z.object({ id: z.string(), amount: z.number() })', project: projRef(p) });
          edge('validates', id, target.id, undefined, RES.same);
        }
      }
      // tests: unit cases beside the code, e2e cases in the e2e projects
      const testPerFile = 6;
      for (let k = 0; k < nTests; k++) {
        const fi = Math.floor(k / testPerFile);
        const e2e = p.layer === 'e2e';
        const path = e2e ? `${p.root}/src/${kebab(NOUNS[fi % NOUNS.length])}-${fi}.spec.ts` : `${p.root}/src/lib/${kebab(NOUNS[fi % NOUNS.length])}-${fi}.spec.ts`;
        if (k % testPerFile === 0) testFiles++;
        const title = `${pick(VERBS)}s the ${pick(NOUNS).toLowerCase()} ${['when it is a draft', 'for a new customer', 'and keeps the totals', 'and refuses an empty one', 'in the right order'][k % 5]} #${k}`;
        const id = `${repo}::test::${path}::${title}`;
        const status = r() < 0.92 ? 'passed' : r() < 0.6 ? 'failed' : 'flaky';
        const run = k % 5 !== 4 ? { id: hex(s * 977 + 13), at: AT, sourceDigest: hex(s * 31 + 7), freshness: 'unchanged', stale: false, report: e2e ? 'e2e/results.json' : 'coverage/results.json', status, durationMs: int(2, e2e ? 4000 : 120), join: 'exact' } : undefined;
        nodes.push({
          id, kind: 'test', name: title, lang: 'ts', loc: { repo, path, line: 3 + (k % testPerFile) * 9, endLine: 10 + (k % testPerFile) * 9 }, group: path,
          tags: ['test', e2e ? 'test:e2e' : 'test:unit', e2e ? 'runner:playwright' : 'runner:vitest'],
          test: { level: e2e ? 'e2e' : 'unit', runner: e2e ? 'playwright' : 'vitest', suite: [cap(p.domain)], file: path, ...(run ? { run, runs: [run] } : {}) },
          project: projRef(p),
        });
        testCases++; if (run) testRuns++;
        if (!e2e && p.fns.length) {
          const a = p.fns[(k * 7) % p.fns.length];
          edge('covers', id, a.id, { evidence: 'static', signal: 'import+call', line: 5 }, RES.test); covers.static++;
          if (k % 3 === 0) { const b = p.fns[(k * 11 + 3) % p.fns.length]; edge('covers', id, b.id, { evidence: 'observed', match: 'name+line', hits: int(1, 40) }, { status: 'resolved', technique: 'coverage-report', confidence: 'HIGH' }); covers.observed++; }
        }
        p.e2eTests = p.e2eTests || []; if (e2e) p.e2eTests.push(id);
      }
    }

    // ── cross-project calls and renders, along the project graph ──
    for (const p of P) {
      for (const q of p.deps) {
        const n = Math.min(40, Math.round(p.fns.length * 0.4 / Math.max(1, p.deps.length)));
        for (let k = 0; k < n && p.fns.length && q.fns.length; k++) edge('calls', p.fns[(k * 13) % p.fns.length].id, q.fns[(k * 17) % q.fns.length].id, { line: int(4, 60) }, RES.imp);
        const c = Math.min(20, p.comps.length);
        for (let k = 0; k < c && q.comps.length; k++) edge('renders', p.comps[k].id, q.comps[(k * 5) % q.comps.length].id, { line: int(4, 30) }, RES.jsx);
      }
      for (let k = 1; k < p.comps.length; k++) if (r() < 0.6) edge('renders', p.comps[k - 1].id, p.comps[k].id, { line: int(4, 30) }, RES.jsx);
      for (let k = 0; k < p.comps.length; k++) if (p.fns.length && r() < 0.7) edge('calls', p.comps[k].id, p.fns[(k * 3) % p.fns.length].id, { line: int(4, 30) }, RES.same);
    }

    // ── the API application: routes, the api node, handlers, client calls, data access ──
    const api = P.find((p) => p.layer === 'api');
    const apiId = `${repo}::api::openapi.yaml`;
    nodes.push({ id: apiId, kind: 'api', name: `${cap(domains[0])} API`, tags: ['api'], docs: `Every operation the ${repo} services answer.`, signature: 'openapi 3.1.0 · version 1.0.0', loc: { repo, path: 'openapi.yaml', line: 1 }, facets: { business: { label: `${cap(domains[0])} API` } }, project: projRef(api) });
    const routes = [];
    const nRoutes = Math.max(10, Math.round(perSource * 0.8));
    for (let k = 0; k < nRoutes; k++) {
      const noun = NOUNS[(k + s) % NOUNS.length].toLowerCase();
      const method = METHODS[k % METHODS.length];
      const path = `/api/${noun}s${k % 3 ? '/:id' : ''}${k >= NOUNS.length ? '/' + VERBS[k % VERBS.length] + '-' + k : ''}`;
      const id = `${repo}::route::${method} ${path}`;
      if (routes.some((x) => x.id === id)) continue;
      const opId = `${VERBS[k % VERBS.length]}${cap(noun)}${k}`;
      routes.push({ id, method, path, opId });
      nodes.push({
        id, kind: 'route', name: `${method} ${path}`, lang: 'ts', loc: { repo, path: 'apps/api/src/routes.ts', line: 10 + k * 4 }, tags: [domains[k % domains.length], `api:${noun}`],
        contract: { status: 'both', apiId, spec: { path: 'openapi.yaml', line: 20 + k * 12, operationId: opId }, summary: `${cap(VERBS[k % VERBS.length])} a ${noun}.`, tags: [cap(noun)], responses: [{ status: '200', description: 'OK' }], security: ['bearer'] },
        project: projRef(api),
      });
      edge('contains', apiId, id, undefined, RES.scan);
      if (api.handlers.length) edge('calls', id, api.handlers[k % api.handlers.length].id, { line: 11 + k * 4 }, RES.imp);
    }
    // guards on routes
    for (let k = 0; k < 4; k++) {
      const id = `${repo}::guard::requireScope(${domains[k]}:write)`;
      nodes.push({ id, kind: 'guard', name: `requireScope(${domains[k]}:write)`, tags: ['auth'], loc: { repo, path: 'apps/api/src/auth.ts', line: 4 + k * 6 }, project: projRef(api) });
      for (let j = k; j < routes.length; j += 4) edge('guards', id, routes[j].id, undefined, { status: 'heuristic', technique: 'detected', confidence: 'MEDIUM' });
    }
    // handlers reach data access, data access reaches tables and externals
    const dataFns = byLayer('data-access').flatMap((p) => p.dataFns);
    for (let k = 0; k < api.handlers.length && dataFns.length; k++) edge('calls', api.handlers[k].id, dataFns[(k * 7) % dataFns.length].id, { line: int(4, 40) }, RES.imp);
    for (let k = 0; k < dataFns.length && tables.length; k++) {
      const t = tables[k % tables.length];
      edge(k % 3 === 0 ? 'writes' : 'reads', dataFns[k].id, t.id, { op: k % 3 === 0 ? 'insert' : 'findMany', line: dataFns[k].loc.line + 3 }, RES.db);
      if (k % 25 === 0) edge('http', dataFns[k].id, externals[k % 2].id, { method: k % 2 ? 'POST' : 'GET', line: dataFns[k].loc.line + 5 }, RES.sdk);
    }
    // client functions in feature libraries call routes
    const clients = byLayer('feature').flatMap((p) => p.fns.slice(0, 6));
    for (let k = 0; k < clients.length && routes.length; k++) {
      const rt = routes[(k * 5) % routes.length];
      edge('http', clients[k].id, rt.id, { method: rt.method, path: rt.path, line: clients[k].loc.line + 2 }, RES.fetch);
    }

    // ── pages, design manifests, flows ──
    const apps = byLayer('app');
    const pagesByApp = new Map();
    for (const a of apps) {
      const list = [];
      const nPages = Math.max(4, Math.round(flowsPer * 1.6 / apps.length) + 3);
      for (let k = 0; k < nPages; k++) {
        const noun = NOUNS[(k * 3 + s) % NOUNS.length];
        const route = `/${a.domain}/${kebab(noun)}${k >= NOUNS.length ? '-' + k : ''}${k % 4 === 1 ? '/:id' : ''}`;
        const id = `${repo}::page::${route}`;
        if (list.some((x) => x.id === id)) continue;
        const comp = a.comps[k % Math.max(1, a.comps.length)];
        const built = k % 17 !== 16;
        list.push({ id, route, noun, comp, built, k });
      }
      pagesByApp.set(a, list);
    }
    const sourcePersonas = PERSONAS.slice(0, 3);
    const sourceGroups = GROUPS;
    const manifests = [];
    for (let m = 0; m < manifestsPer; m++) {
      const path = m === 0 ? 'docs/design/screens.json' : `apps/web-${apps[m % apps.length].domain}/docs/design/screens.json`;
      manifests.push({ id: `${repo}::design::${path}`, path, apps: apps.filter((_, i) => i % manifestsPer === m || manifestsPer === 1), flows: [] });
    }
    let screenNo = 0;
    for (const man of manifests) {
      const screens = man.apps.flatMap((a) => pagesByApp.get(a).map((pg) => ({ ...pg, app: a })));
      nodes.push({ id: man.id, kind: 'design', name: `${cap(man.apps[0]?.domain || repo)} — screens`, tags: ['design'], signature: `${screens.length} screens · modified ${AT} (manifest)`, loc: { repo, path: man.path, line: 1 }, facets: { business: { label: `${cap(man.apps[0]?.domain || repo)} — screens` } } });
      for (const pg of screens) {
        screenNo++;
        const sid = `${repo.toUpperCase()}-${String(screenNo).padStart(3, '0')}`;
        const node = {
          id: pg.id, kind: 'page', name: pg.route, lang: 'ts', tags: ['ux', `design:${sid.toLowerCase()}`],
          design: { status: pg.built ? 'both' : 'design-only', origin: 'manifest', designId: man.id, id: sid, name: `${pg.noun} ${['list', 'detail', 'editor', 'review'][pg.k % 4]}`, lastModified: AT, freshness: 'manifest', operations: routes.slice(pg.k % routes.length, (pg.k % routes.length) + 2).map((x) => x.opId) },
          facets: { business: { label: `${pg.noun} ${['list', 'detail', 'editor', 'review'][pg.k % 4]}`, description: `Where the ${pg.app.domain} team works with ${pg.noun.toLowerCase()}s.` } },
          project: projRef(pg.app),
        };
        if (pg.built) node.loc = { repo, path: `${pg.app.root}/src/main.tsx`, line: 5 + pg.k };
        nodes.push(node);
        edge('contains', man.id, pg.id, undefined, RES.scan);
        if (pg.built && pg.comp) edge('renders', pg.id, pg.comp.id, { line: 5 + pg.k });
      }
      man.screens = screens;
    }
    const sourceFlows = [];
    for (let f = 0; f < flowsPer; f++) {
      const man = manifests[f % manifests.length];
      if (!man.screens.length) continue;
      const fid = `${repo}-flow-${f}`;
      const id = `${repo}::flow::${fid}`;
      const persona = sourcePersonas[f % sourcePersonas.length][0];
      const group = sourceGroups[(f >> 1) % sourceGroups.length][0];
      const noun = NOUNS[(f + s) % NOUNS.length].toLowerCase();
      const name = `${cap(VERBS[f % VERBS.length])} a ${noun} ${['from the start', 'for review', 'at month end', 'and send it', 'with a correction'][f % 5]}`;
      const n = int(3, 7);
      const start = int(0, man.screens.length - 1);
      const steps = Array.from({ length: n }, (_, k) => man.screens[(start + k) % man.screens.length]);
      sourceFlows.push({ id, fid, steps });
      nodes.push({
        id, kind: 'flow', name, tags: ['entrypoint', 'flow', `design:${fid}`],
        docs: `A ${persona} user ${VERBS[f % VERBS.length]}s a ${noun} and checks it before it goes out.`,
        design: { status: steps.every((x) => x.built) ? 'both' : 'design-only', origin: 'manifest', designId: man.id, id: fid, name, persona, group, order: (f % 4) + 1, position: man.flows.length, lastModified: AT, freshness: 'manifest',
          ...(f > 0 && f % 5 === 0 ? { requires: [`${repo}-flow-${f - 1}`] } : {}), ...(f % 7 === 0 && f + 1 < flowsPer ? { leadsTo: [`${repo}-flow-${f + 1}`] } : {}) },
        facets: { business: { label: name, description: `A ${persona} user ${VERBS[f % VERBS.length]}s a ${noun} and checks it before it goes out.` } },
      });
      man.flows.push(id);
      edge('contains', man.id, id, undefined, RES.scan);
      steps.forEach((pg, k) => edge('renders', id, pg.id, { line: k + 1 }, RES.scan));
    }
    // e2e cases declare flows and reach pages
    for (const p of byLayer('e2e')) {
      (p.e2eTests || []).forEach((tid, k) => {
        const fl = sourceFlows[k % Math.max(1, sourceFlows.length)];
        if (!fl) return;
        if (k % 2 === 0) { edge('covers', tid, fl.id, { evidence: 'declared', declared: fl.fid }, { status: 'resolved', technique: 'annotation-scan', confidence: 'HIGH', note: `@covers ${fl.fid}` }); covers.declared++; }
        const pg = fl.steps[k % fl.steps.length];
        if (pg.built) { edge('covers', tid, pg.id, { evidence: 'static', signal: 'goto', line: 4 }, RES.route); covers.static++; }
      });
    }

    // ── work items ──
    for (let k = 0; k < Math.max(5, Math.round(perSource / 4)); k++) {
      workN++;
      const id = `work::jira-perf::PERF-${workN}`;
      nodes.push({ id, kind: 'work', name: `PERF-${workN} ${cap(pick(VERBS))} the ${pick(NOUNS).toLowerCase()} screen`, tags: ['work', 'story'] });
      const p = P[(k * 3) % P.length];
      for (let j = 0; j < 3 && p.fns.length; j++) edge('tracks', id, p.fns[(k + j * 5) % p.fns.length].id, { via: 'commit' }, RES.work);
    }

    // ── per-source meta ──
    meta.projects[repo] = {
      tool: 'nx',
      projects: P.map((p) => ({ name: p.name, root: p.root, type: p.type, tags: p.tags, ...(p.implicitDependencies ? { implicitDependencies: p.implicitDependencies } : {}), sourceRoot: p.root + '/src', via: 'project.json' })),
      tagDimensions: [{ key: 'domain', prefix: 'scope:', label: 'Domain' }, { key: 'type', prefix: 'type:', label: 'Type' }, { key: 'platform', prefix: 'platform:', label: 'Platform' }],
      tagValues: { type: { app: 'Application', feature: 'Feature', ui: 'UI', util: 'Utility', 'data-access': 'Data access', e2e: 'End-to-end' } },
      imports: [...imports.values()].sort((a, b) => (a.from + a.to).localeCompare(b.from + b.to)).map((x) => ({
        from: x.from, to: x.to, imports: x.imports, files: x.files.size,
        top: [...x.top.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5).map(([path, n]) => ({ path, imports: n })),
      })),
      dependencies: P.flatMap((p) => p.deps.map((q) => ({ from: p.name, to: q.name, type: p.layer === 'e2e' ? 'implicit' : 'static', via: 'nx-graph' }))),
      graphFile: { path: '.nx/workspace-data/project-graph.json', projects: P.length, dependencies: P.reduce((n, p) => n + p.deps.length, 0) },
    };
    meta.journeys[repo] = {
      personas: sourcePersonas.map(([id, name]) => ({ id, name, description: `The ${name.toLowerCase()} people who use the ${repo} screens.`, declared: true, from: 'docs/design/screens.json' })),
      groups: sourceGroups.map(([id, name]) => ({ id, name, description: `${name}.`, declared: true, from: 'docs/design/screens.json' })),
      flows: {}, notes: [],
    };
    meta.tests[repo] = {
      files: testFiles, cases: testCases, edges: covers, runs: testRuns,
      reports: [{ path: 'coverage/results.json', kind: 'results', runner: 'vitest', level: 'unit', mtime: AT, runId: hex(s * 977 + 13), freshness: 'unchanged', glob: 'coverage/results.json', matched: 1, reason: 'ok', joined: testRuns, rows: testRuns, unjoined: 0 }],
      gaps: [], blindSpots: [], sourceDigest: hex(s * 31 + 7),
    };
    meta.stores[repo] = { drivers: [{ spec: 'pg', files: 12 }], named: { sdk: tables.length }, unnamed: 0 };
    meta.packages[repo] = { builtins: [{ spec: 'node:fs', files: 3 }] };
    meta.repos[repo] = { files: fileCount, sourceHash: hex(s * 17 + 1), sourceDigest: hex(s * 31 + 7) };
  }

  const repos = Object.keys(meta.repos);
  const graph = {
    meta: {
      ...meta,
      files: repos.reduce((n, k) => n + meta.repos[k].files, 0),
      sourceHash: hex(o.seed * 101 + 5), sourceDigest: hex(o.seed * 103 + 9),
      workspace: 'nx', sync: 1, digest: hex(o.seed * 107 + 3), tz: 'UTC', generatedAt: AT,
      farsight: { version: 'synthetic', built: AT, commit: 'synthetic', source: 'workspace' },
      synthetic: { preset: o.preset, seed: o.seed, sources: o.sources, projects: o.projects, flows: o.flows, manifests: o.manifests },
    },
    roots: {},
    nodes, edges,
  };
  return graph;
}

/** Write the graph without building one giant string (a full-preset graph is larger than V8's string limit allows comfortably). */
export function writeGraph(graph, out) {
  mkdirSync(dirname(resolve(out)), { recursive: true });
  const fd = openSync(out, 'w');
  let bytes = 0;
  const put = (s) => { bytes += writeSync(fd, s); };
  put('{"meta":' + JSON.stringify(graph.meta) + ',"roots":' + JSON.stringify(graph.roots) + ',"nodes":[');
  const batch = (arr) => {
    for (let i = 0; i < arr.length; i += 2000) put((i ? ',' : '') + arr.slice(i, i + 2000).map((x) => JSON.stringify(x)).join(','));
  };
  batch(graph.nodes);
  put('],"edges":[');
  batch(graph.edges);
  put(']}');
  closeSync(fd);
  return bytes;
}

/** A workspace settings file naming every source, so the server's scope menu has the sources a real one would. */
export function writeSettings(dir, graph) {
  const sources = Object.keys(graph.meta.repos).map((name) => ({ id: name, name, type: 'local', path: name, enabled: true }));
  mkdirSync(join(dir, '.farsight'), { recursive: true });
  writeFileSync(join(dir, '.farsight', 'settings.json'), JSON.stringify({ theme: 'dark', defaultLens: 'hybrid', flags: { map: true }, sources, collections: [] }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('synth-graph.mjs')) {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) {
    console.log('node scripts/synth-graph.mjs [--preset full|small] [--out graph.json] [--seed N] [--sources N] [--projects N] [--nodes N] [--flows N] [--manifests N] [--settings dir]');
    process.exit(0);
  }
  const t0 = performance.now();
  const g = synthesize(o);
  const bytes = writeGraph(g, o.out);
  if (o.settings) writeSettings(o.settings, g);
  const flows = g.nodes.filter((n) => n.kind === 'flow').length;
  const designs = g.nodes.filter((n) => n.kind === 'design').length;
  const projects = Object.values(g.meta.projects).reduce((n, m) => n + m.projects.length, 0);
  console.log(`${o.preset}: ${Object.keys(g.meta.repos).length} sources · ${projects} projects · ${g.nodes.length} nodes · ${g.edges.length} edges · ${flows} flows in ${designs} manifests · ${(bytes / 1e6).toFixed(1)} MB → ${o.out} (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
}
