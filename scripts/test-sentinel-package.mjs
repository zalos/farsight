#!/usr/bin/env node
// Installs the packed Sentinel tarball into a clean npm consumer and checks that it stands
// alone: the bin answers --help; every export imports and its public types compile in a
// strict TypeScript consumer that uses the contracts; the installed schemas are exactly the
// source set, one per envelope; the package's valid fixtures validate through the installed
// package and a changed version is refused; the draft store (`farsight-sentinel/store`) opens, publishes
// verified evidence in one process and reads it back in another; and no Farsight application package
// arrives; the pattern rule pack and worker ship with exact digests and rights. No scanner, container, model or
// network service is started, except that with SENTINEL_ISOLATION=1 the shipped pattern worker and pack run once in
// the pinned engine image through the workspace's isolated execution service (never pulled; this checks the installed
// assets, not an installed runtime); npm may fetch Sentinel's declared third-party dependencies.
//
//   pnpm test:sentinel:package        # builds Sentinel's closure, packs, then runs this
//   node scripts/test-sentinel-package.mjs [build/sentinel/farsight-sentinel-<v>.tgz]
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { npmConsumer } from './npm-consumer.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = join(root, 'packages', 'sentinel');
const artifact = resolve(process.argv[2] ?? (() => {
  const source = JSON.parse(readFileSync(join(sourceDir, 'package.json'), 'utf8'));
  return join(root, 'build', 'sentinel', `farsight-sentinel-${source.version}.tgz`);
})());
const jsonFiles = (dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith('.json')).sort() : []);
const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
if (!existsSync(artifact)) {
  console.error(`test-sentinel-package: ${artifact} is missing. Run \`pnpm pack:sentinel\` first.`);
  process.exit(1);
}

const consumer = await npmConsumer('sentinel-package-', [artifact]);
try {
  assert.ok(consumer.manifest().dependencies?.['farsight-sentinel'], 'npm recorded the dependency');
  const installed = join(consumer.dir, 'node_modules', 'farsight-sentinel');
  const pkg = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
  assert.ok(artifact.endsWith(`farsight-sentinel-${pkg.version}.tgz`), 'the tarball name carries the packaged version');
  // truthful runtime metadata: a floor this Node satisfies, and no workspace-only protocol leaking out
  const floor = /^>=(\d+)/.exec(pkg.engines?.node ?? '');
  assert.ok(floor && Number(process.versions.node.split('.')[0]) >= Number(floor[1]), `engines.node ${pkg.engines?.node}`);
  assert.ok(Object.values(pkg.dependencies ?? {}).every((spec) => !String(spec).startsWith('workspace:')), 'no workspace: dependency');

  const bins = Object.keys(pkg.bin ?? {});
  assert.ok(bins.length, 'the package declares a bin');
  for (const name of bins) {
    const help = await consumer.exec(consumer.bin(name), ['--help']);
    assert.match(help.stdout + help.stderr, /sentinel/i, `${name} --help names Sentinel`);
  }

  // The launch gate ships as its own file, and enforces its authorization from the installed tarball: without the
  // exact line the adapter never loads; with it, it does (src/execution/launch-gate.ts).
  const gate = join(installed, 'dist', 'execution', 'launch-gate.mjs');
  // Required whenever the source package can start built-in workers (it has the supervisor).
  const startsWorkers = existsSync(join(sourceDir, 'src', 'execution', 'supervisor.ts'));
  if (startsWorkers) assert.ok(existsSync(gate), 'the launch gate is shipped as dist/execution/launch-gate.mjs');
  if (startsWorkers) {
    const token = '11111111-2222-4333-8444-555555555555';
    const marker = join(consumer.dir, 'gate-adapter-ran');
    const adapter = join(consumer.dir, 'gate-adapter.mjs');
    writeFileSync(adapter, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'ran');\n`);
    const launch = (input) => spawnSync(process.execPath, ['--import', pathToFileURL(gate).href, adapter, `--sentinel-token=${token}`], { input, env: {}, timeout: 20_000 });
    assert.equal(launch('').status, 78, 'refused without its authorization');
    assert.equal(existsSync(marker), false, 'the adapter never loaded');
    assert.equal(launch(`sentinel-launch ${token}\n`).status, 0, 'the installed gate admits its exact authorization');
    assert.ok(existsSync(marker), 'the adapter loaded through the installed gate');
  }

  const evalModule = async (code) => (await consumer.exec(process.execPath, ['--input-type=module', '-e', code])).stdout;
  const subpaths = Object.keys(pkg.exports ?? {}).filter((key) => key !== './package.json' && !key.includes('*'));
  const specifierOf = (subpath) => (subpath === '.' ? 'farsight-sentinel' : `farsight-sentinel/${subpath.slice(2)}`);
  const runtimeKeys = {};
  for (const subpath of subpaths) {
    const entry = pkg.exports[subpath];
    assert.ok(typeof entry === 'object' && entry.types && existsSync(join(installed, entry.types)), `${subpath} ships its declaration`);
    runtimeKeys[subpath] = JSON.parse(await evalModule(`const m = await import(${JSON.stringify(specifierOf(subpath))}); console.log(JSON.stringify(Object.keys(m)));`));
    assert.ok(runtimeKeys[subpath].length > 0, `${specifierOf(subpath)} exposes named exports`);
  }
  assert.ok(subpaths.includes('.') && subpaths.includes('./contracts') && subpaths.includes('./store'), 'the root, ./contracts and ./store exports');
  // Parser evidence (ADR 22): required whenever the source package exports it.
  const sourceExports = JSON.parse(readFileSync(join(sourceDir, 'package.json'), 'utf8')).exports ?? {};
  const parserExported = Object.hasOwn(sourceExports, './parser');
  assert.equal(subpaths.includes('./parser'), parserExported, 'the installed ./parser export matches the source package');
  const expressExported = Object.hasOwn(sourceExports, './frameworks/express');
  assert.equal(subpaths.includes('./frameworks/express'), expressExported, 'the installed ./frameworks/express export matches the source package');

  // The envelope registry, as the installed package reports it.
  const registry = JSON.parse(await evalModule("const { ENVELOPES } = await import('farsight-sentinel'); console.log(JSON.stringify(ENVELOPES));"));
  const kinds = Object.keys(registry);
  assert.ok(kinds.length > 0, 'ENVELOPES names at least one envelope');

  // Schemas: exactly the source set, byte for byte, with one per envelope version.
  const expected = jsonFiles(join(sourceDir, 'schemas'));
  assert.ok(expected.length > 0, 'packages/sentinel/schemas holds the expected schemas');
  const installedSchemas = jsonFiles(join(installed, 'schemas'));
  assert.deepEqual(installedSchemas, expected, 'the installed schema set is the source set');
  for (const file of expected) {
    assert.equal(digest(join(installed, 'schemas', file)), digest(join(sourceDir, 'schemas', file)), `${file} is unchanged`);
    assert.equal(typeof JSON.parse(readFileSync(join(installed, 'schemas', file), 'utf8')), 'object', file);
  }
  for (const kind of kinds) {
    const file = `${registry[kind].schema.replace('/', '.')}.schema.json`;
    assert.ok(installedSchemas.includes(file), `${kind}: ${file} is packaged`);
    const viaExport = await evalModule(`import { createRequire } from 'node:module'; const r = createRequire(process.cwd() + '/'); console.log(r.resolve(${JSON.stringify(`farsight-sentinel/schemas/${file}`)}));`);
    assert.ok(viaExport.trim().endsWith(file), `farsight-sentinel/schemas/${file} resolves through the exports map`);
  }
  const schemaCount = installedSchemas.length;

  // Public types: a strict consumer that names every runtime export and uses each contract type.
  const contracts = [...new Set(kinds.map((kind) => registry[kind].type))];
  const lines = [
    "import * as root from 'farsight-sentinel';",
    "import * as contractValues from 'farsight-sentinel/contracts';",
    "import { ENVELOPES, validateEnvelope, type EnvelopeKind, type EnvelopeTypes, type ValidationResult } from 'farsight-sentinel';",
    `import type { ${contracts.join(', ')} } from 'farsight-sentinel/contracts';`,
    `export const rootKeys: Array<keyof typeof root> = ${JSON.stringify(runtimeKeys['.'])};`,
    `export const contractKeys: Array<keyof typeof contractValues> = ${JSON.stringify(runtimeKeys['./contracts'])};`,
    'const kinds: EnvelopeKind[] = Object.keys(ENVELOPES) as EnvelopeKind[];',
    ...kinds.map((kind, i) => [
      `const r${i}: ValidationResult<EnvelopeTypes[${JSON.stringify(kind)}]> = validateEnvelope(${JSON.stringify(kind)}, {} as unknown);`,
      `if (r${i}.ok) { const value: ${registry[kind].type} = r${i}.value; const back: EnvelopeTypes[${JSON.stringify(kind)}] = value; void back; }`,
      `else { const code: string = r${i}.errors[0]?.code ?? ''; const path: string = r${i}.errors[0]?.path ?? ''; void code; void path; }`,
    ].join('\n')),
    'void kinds;',
    // The store facade's public types: opening, staging, a typed receipt, publication and inspection.
    "import { openStore, STORAGE_ERROR_CODES, type SentinelStore, type StoredObject, type PublicationReceipt, type ReachabilityReport } from 'farsight-sentinel/store';",
    "import { openStore as rootOpenStore } from 'farsight-sentinel';",
    'export async function storeDemo(path: string, work: { id: string; revision: number }, attemptId: string): Promise<[PublicationReceipt, ReachabilityReport]> {',
    '  const store: SentinelStore = await openStore(path, { waitMs: 0 });',
    '  try {',
    "    const bytes = new TextEncoder().encode('evidence');",
    '    const id = store.objects.identify(bytes);',
    "    store.ledger.registerStaging('stage-1', [{ id: id.id, schema: 'text/plain', privacy: 'source' }], { work, attemptId });",
    '    const receipt: StoredObject = await store.objects.put(bytes, { expect: id });',
    "    const accepted = store.ledger.publish({ work, attemptId, stageId: 'stage-1', receipts: [receipt], outputs: [id.id], endedAt: '2026-10-21T12:01:00Z' });",
    '    const buffer: Buffer = await store.readArtifact(id.id);',
    '    void buffer;',
    '    return [accepted, await store.inspect()];',
    '  } finally { store.close(); }',
    '}',
    'const codes: readonly string[] = STORAGE_ERROR_CODES.ledger; void codes; void rootOpenStore;',
    // The parser's own portable types arrive whole (vendored declarations), with Sentinel's result and index around them.
    ...(parserExported ? [
      "import { parseSnapshot, retainSnapshotAnalysis, PARSER_LIMIT_CEILINGS, type AnalysisArtifact, type InputFingerprint, type ParserLimits, type ParserIndex, type ParserResult, type SpanUnavailableReason } from 'farsight-sentinel/parser';",
      'export function parserFields(a: AnalysisArtifact, r: ParserResult, i: ParserIndex): unknown[] {',
      '  const node = a.graph.nodes[0]!;',
      '  const edge = a.graph.edges[0]!;',
      '  const site = edge.occurrences?.[0];',
      '  const input: InputFingerprint | undefined = a.analysis.inputs[0];',
      '  const limits: Required<ParserLimits> = PARSER_LIMIT_CEILINGS;',
      '  const reason: SpanUnavailableReason | undefined = i.nodes[0]?.spanUnavailable;',
      '  return [node.loc?.path, node.loc?.endLine, edge.resolution?.status, site?.conditions, site?.span?.start, a.graph.meta?.files,',
      '    a.analysis.complete, input?.kind, limits.maxDurationMs, r.parserComplete, r.clearsChecks, r.counts.parsed,',
      '    r.counts.unknownScopeDescendants, r.inputs[0]?.outcome, r.entries[0]?.class, r.tree.before, i.occurrences[0]?.byteSpan?.startByte,',
      '    i.spanUnavailable.invalidUtf8, i.unplaced.count, i.omitted, reason, typeof parseSnapshot, typeof retainSnapshotAnalysis];',
      '}',
    ] : []),
    ...(expressExported ? [
      "import { analyzeExpress, EXPRESS_PACK, EXPRESS_SUPPORT, EXPRESS_REASON_CODES, matchPath, type ExpressPackInput, type ExpressReason } from 'farsight-sentinel/frameworks/express';",
      'export async function expressFields(input: ExpressPackInput): Promise<unknown[]> {',
      '  const reason: ExpressReason = EXPRESS_REASON_CODES[0];',
      '  const envelope: ControlFactsEnvelope = await analyzeExpress(input);',
      "  return [EXPRESS_PACK.version, EXPRESS_SUPPORT.dispatch, reason, matchPath('/a/b', '/a', true), envelope.facts[0]?.order];",
      '}',
    ] : []),
  ];
  writeFileSync(join(consumer.dir, 'consumer.mts'), lines.join('\n') + '\n');
  await consumer.exec(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit', '--strict',
    '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'consumer.mts']).catch((error) => {
    throw new Error(`the installed types do not compile:\n${error.stdout}${error.stderr}`);
  });

  // Runtime contracts: the package's own valid fixtures pass through the installed package; a
  // fixture whose version is changed is refused, never coerced.
  const fixtures = join(sourceDir, 'test', 'contracts', 'valid');
  const cases = jsonFiles(fixtures).map((file) => ({ file, kind: kinds.find((kind) => file === `${kind}.json` || file.startsWith(`${kind}-`)) }));
  const unmatched = cases.filter((c) => !c.kind).map((c) => c.file);
  assert.deepEqual(unmatched, [], 'every valid fixture is named <kind>[-case].json');
  for (const kind of kinds) assert.ok(cases.some((c) => c.kind === kind), `a valid ${kind} fixture exists`);
  writeFileSync(join(consumer.dir, 'fixtures.mjs'), `
    import assert from 'node:assert/strict';
    import { readFileSync } from 'node:fs';
    import { validateEnvelope } from 'farsight-sentinel';
    for (const { file, kind } of ${JSON.stringify(cases.map((c) => ({ ...c, file: join(fixtures, c.file) })))}) {
      const value = JSON.parse(readFileSync(file, 'utf8'));
      const ok = validateEnvelope(kind, value);
      assert.equal(ok.ok, true, file + ' ' + JSON.stringify(ok.errors));
      const field = ['schema', 'protocol'].find((f) => typeof value[f] === 'string' && value[f].startsWith('sentinel-'));
      assert.ok(field, file + ' names its version');
      const changed = validateEnvelope(kind, { ...value, [field]: value[field].replace(/\\/.*$/, '/v999') });
      assert.equal(changed.ok, false, file + ' with an unknown version is refused');
    }
    console.log(${cases.length});
  `);
  const validated = Number((await consumer.exec(process.execPath, ['fixtures.mjs'])).stdout);
  assert.equal(validated, cases.length);

  // One store facade, whichever export it is reached through: the root and ./store give the same openStore and the
  // same error classes, so an error from one is an instance of the other's class.
  const identity = JSON.parse(await evalModule(`
    const root = await import('farsight-sentinel');
    const store = await import('farsight-sentinel/store');
    let error;
    try { await root.openStore('relative/store'); } catch (e) { error = e; }
    console.log(JSON.stringify({
      openStore: root.openStore === store.openStore,
      StoreError: root.StoreError === store.StoreError,
      LedgerError: root.LedgerError === store.LedgerError,
      ObjectStoreError: root.ObjectStoreError === store.ObjectStoreError,
      code: error?.code ?? null,
      crossInstance: error instanceof store.StoreError,
    }));
  `));
  assert.deepEqual(identity, {
    openStore: true, StoreError: true, LedgerError: true, ObjectStoreError: true,
    code: 'sentinel.store.pathNotAbsolute', crossInstance: true,
  }, 'the root and ./store exports share one facade and one set of error classes');

  // The store, as a consumer uses it: one process opens a new store and publishes verified evidence; a
  // fresh process reopens it under a new epoch, reads the artifact back and is refused a record from the
  // earlier epoch. The store lives in a canonical, private folder of the consumer's scratch directory.
  const storeRoot = join(realpathSync.native(consumer.scratch), 'store-demo');
  mkdirSync(storeRoot, { mode: 0o700 });
  const storePath = join(storeRoot, 'store');
  const load = (name) => JSON.parse(readFileSync(join(fixtures, `${name}.json`), 'utf8'));
  const work = { id: 'work-pattern-api', revision: 1 };
  writeFileSync(join(consumer.dir, 'store-write.mjs'), `
    import { openStore } from 'farsight-sentinel/store';
    const store = await openStore(${JSON.stringify(storePath)});
    try {
      const e = store.epoch;
      // The manifest and invocation the ledger keeps as roots are real, staged and stored bytes.
      const inputs = [{ kind: 'synthetic-influence-manifest' }, { kind: 'synthetic-invocation' }];
      const [manifest, invocation] = inputs.map((v) => store.objects.identifyCanonicalJson(v));
      store.ledger.registerStaging('stage-inputs', [manifest, invocation].map((i) => ({ id: i.id, schema: 'application/json', privacy: 'metadata' })));
      await store.objects.putCanonicalJson(inputs[0], { expect: manifest });
      await store.objects.putCanonicalJson(inputs[1], { expect: invocation });
      store.ledger.createRun({ ...${JSON.stringify(load('run-active'))}, coordinatorEpoch: e });
      store.ledger.createWork({ ...${JSON.stringify(load('work-idle'))}, coordinatorEpoch: e, id: ${JSON.stringify(work.id)}, state: 'ready', dependencies: [], influenceManifest: manifest.id });
      store.ledger.startAttempt({ ...${JSON.stringify(load('attempt-running'))}, coordinatorEpoch: e, id: 'att-1', ordinal: 1, work: ${JSON.stringify(work)}, invocation: invocation.id,
        worker: { kind: 'owned-child', pid: 4242, processStartedAt: '2026-10-21T12:00:00Z' } });
      const bytes = Buffer.from('evidence written by the first process');
      const id = store.objects.identify(bytes);
      store.ledger.registerStaging('stage-1', [{ id: id.id, schema: 'text/plain', privacy: 'source' }], { work: ${JSON.stringify(work)}, attemptId: 'att-1' });
      const receipt = await store.objects.put(bytes, { expect: id });
      store.ledger.publish({ work: ${JSON.stringify(work)}, attemptId: 'att-1', stageId: 'stage-1', receipts: [receipt], outputs: [id.id], endedAt: '2026-10-21T12:01:00Z' });
      console.log(JSON.stringify({ epoch: e, id: id.id }));
    } finally { store.close(); }
  `);
  writeFileSync(join(consumer.dir, 'store-read.mjs'), `
    import { openStore } from 'farsight-sentinel';
    const [epoch] = process.argv.slice(2);
    const store = await openStore(${JSON.stringify(storePath)});
    try {
      const pub = store.ledger.getPublication(${JSON.stringify(work)});
      const text = (await store.readArtifact(pub.outputs[0].id)).toString('utf8');
      let stale = null;
      try { store.ledger.createRun({ ...${JSON.stringify(load('run-active'))}, id: 'run-old', coordinatorEpoch: epoch }); } catch (e) { stale = e.code; }
      const report = await store.inspect();
      console.log(JSON.stringify({ epoch: store.epoch, text, stale, ok: report.ok, integrity: store.checkIntegrity().integrity }));
    } finally { store.close(); }
  `);
  const node = (file, args = []) => consumer.exec(process.execPath, ['--disable-warning=ExperimentalWarning', file, ...args]);
  // Only a qualified host and SQLite release opens a store; elsewhere the installed package must refuse cleanly.
  // The installed package's own answer for this exact host and SQLite pair.
  const host = `${process.platform}-${process.arch}`;
  const pair = JSON.parse(await evalModule(`const { SQLITE_RELEASE_POLICY, qualificationFor } = await import('farsight-sentinel/store');
    console.log(JSON.stringify(qualificationFor(SQLITE_RELEASE_POLICY, ${JSON.stringify(host)}, process.versions.sqlite) ?? null));`));
  let storeDemo;
  // On CI nothing falls back to the refusal branch: an unqualified CI host fails here, loudly.
  if (pair || process.env.CI) {
    const written = JSON.parse((await node('store-write.mjs')).stdout.trim());
    const read = JSON.parse((await node('store-read.mjs', [written.epoch])).stdout.trim());
    assert.notEqual(read.epoch, written.epoch, 'a new process owns the store under a new epoch');
    assert.equal(read.text, 'evidence written by the first process', 'the artifact reads back in a new process');
    assert.equal(read.stale, 'sentinel.store.staleEpoch', 'a record from the earlier epoch is refused');
    assert.ok(read.ok && read.integrity === 'ok', 'reachability and SQLite integrity hold after the reopen');
    storeDemo = `store reopened across processes (${host} SQLite ${process.versions.sqlite}, ${pair?.status ?? 'unqualified on CI'})`;
    if (expressExported) storeDemo += await expressDemo();
  } else {
    const refused = await node('store-write.mjs').then(() => null, (error) => `${error.stderr}`);
    assert.match(refused ?? '', /sentinel\.store\.(platformUnqualified|runtimeUnqualified)/, `an unqualified pair (${host}, SQLite ${process.versions.sqlite}) is refused`);
    assert.ok(!existsSync(storePath), 'no store folder was created on an unqualified host');
    storeDemo = `store refused on unqualified ${host} (not qualification evidence)`;
  }

  /**
   * The installed Express pack, run for real: an original fixture with a route registered before its check, one after
   * it and one behind a conditional registration in a second application is captured, parsed and analysed through the
   * installed package alone. git builds the fixture's repository only; nothing in it is installed or run.
   */
  async function expressDemo() {
    const appDir = join(storeRoot, 'express-app');
    const files = {
      'package.json': '{ "name": "smoke", "private": true, "type": "module", "dependencies": { "express": "4.21.2" } }\n',
      'src/auth.ts': `export function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'sign in' });
  next();
}
`,
      'src/app.ts': `import express from 'express';
import { requireUser } from './auth.js';

const app = express();
app.get('/early', (req, res) => { res.json({}); });
app.use(requireUser);
app.get('/late', (req, res) => { res.json({}); });

export default app;
`,
      'src/other.ts': `import express from 'express';
import { requireUser } from './auth.js';

const router = express.Router();
if (process.env.STRICT) router.use(requireUser);
router.get('/maybe', (req, res) => { res.json({}); });
const second = express();
second.use(router);
second.listen(3001);
`,
    };
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(appDir, path)), { recursive: true });
      writeFileSync(join(appDir, path), text);
    }
    const gitEnv = { PATH: process.env.PATH ?? '', HOME: appDir, LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'dev@example.com' };
    const gitRun = (args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'init.defaultBranch=main', ...args], { cwd: appDir, env: gitEnv, stdio: 'ignore' });
    gitRun(['init', '--quiet']);
    gitRun(['add', '--all']);
    gitRun(['commit', '--quiet', '--no-verify', '-m', 'fixture']);
    const workDir = join(storeRoot, 'express-work');
    mkdirSync(workDir, { mode: 0o700 });
    writeFileSync(join(consumer.dir, 'express-demo.mjs'), `
      import { openStore } from 'farsight-sentinel/store';
      import { captureSnapshot } from 'farsight-sentinel/snapshot';
      import { parseSnapshot } from 'farsight-sentinel/parser';
      import { analyzeExpress } from 'farsight-sentinel/frameworks/express';
      const store = await openStore(${JSON.stringify(join(storeRoot, 'express-store'))});
      try {
        const { snapshot } = await captureSnapshot(store, { mode: 'working-copy', sources: [{ sourceId: 'app', repositoryId: 'example/smoke', root: ${JSON.stringify(appDir)} }] });
        const parsed = await parseSnapshot(store, { snapshotId: snapshot.id, workDir: ${JSON.stringify(workDir)},
          selection: { gitignore: true, testFiles: 'include' },
          limits: { maxFiles: 100, maxFileBytes: 1 << 20, maxTotalBytes: 1 << 24, maxEntries: 1000, maxDurationMs: 60000 } });
        const facts = await analyzeExpress({ snapshot, sourceId: 'app', analysis: parsed.sources[0], readContent: id => store.readArtifact(id) });
        const out = {};
        for (const f of facts.facts) if (f.property === 'authentication') out[f.surfaceId] = f.order + ':' + (f.verdict === 'unknown' ? f.reasonCode : f.verdict);
        console.log(JSON.stringify({ version: facts.framework.version, out }));
      } finally { store.close(); }
    `);
    const result = JSON.parse((await node('express-demo.mjs')).stdout.trim());
    assert.equal(result.version, '4.21.2');
    assert.deepEqual(result.out, {
      'app::route::GET /early': '0:does-not-apply',
      'app::route::GET /late': '0:applies',
      'app::route::GET /maybe': '0:sentinel.express.registrationDynamic',
    }, 'a route before its check, one after it and a conditional registration, from the installed package alone');
    return ', Express pack analysed an installed fixture (before, after, conditional)';
  }

  // Standalone: everything @farsight/* is inlined, and farsight-cli is not pulled in.
  const modules = readdirSync(join(consumer.dir, 'node_modules'));
  assert.ok(!modules.includes('farsight-cli'), 'farsight-cli is not installed with Sentinel');
  assert.ok(!modules.includes('@farsight'), 'no workspace package is resolved from a registry');

  // Pattern assets: the original rule pack and the in-container worker ship with exact digests and rights, resolvable
  // through the exports map. The adapter itself stays internal and unregistered.
  let patternDemo = '';
  const assetManifest = join(installed, 'assets', 'pattern', 'manifest.json');
  if (existsSync(join(sourceDir, 'scripts', 'package-assets.mjs'))) {
    assert.ok(existsSync(assetManifest), 'the pattern asset manifest is packaged');
    const viaAssets = await evalModule(`import { createRequire } from 'node:module'; const r = createRequire(process.cwd() + '/'); console.log(r.resolve('farsight-sentinel/assets/pattern/manifest.json'));`);
    assert.ok(viaAssets.trim().endsWith('assets/pattern/manifest.json'), 'pattern assets resolve through the exports map');
    const assets = JSON.parse(readFileSync(assetManifest, 'utf8'));
    assert.equal(assets.registered, false);
    const worker = readFileSync(join(installed, assets.worker.path));
    assert.equal(`sha256:${createHash('sha256').update(worker).digest('hex')}`, assets.worker.digest, 'the worker bytes match their digest');
    assert.equal(assets.adapter.command.at(-1), `/input/${assets.worker.digest.slice(7)}`, 'the fixed command names the shipped worker');
    assert.match(assets.adapter.image, /^semgrep\/semgrep@sha256:[0-9a-f]{64}$/);
    assert.deepEqual(assets.pack.rights, { spdx: 'MIT', origin: 'sentinel-original' });
    for (const f of assets.pack.files) {
      const bytes = readFileSync(join(installed, assets.pack.path, f.path));
      assert.equal(`sha256:${createHash('sha256').update(bytes).digest('hex')}`, f.digest, f.path);
      assert.equal(bytes.length, f.size, f.path);
    }
    const sourceFiles = readdirSync(join(sourceDir, 'rules', 'pattern'), { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).length;
    assert.equal(assets.pack.files.length, sourceFiles, 'every pack file is listed');
    patternDemo = `pattern assets (${assets.pack.files.length} pack files, worker ${assets.worker.digest.slice(7, 19)})`;
    // With SENTINEL_ISOLATION=1 and the pinned image installed, the shipped worker and pack bytes run in the real engine
    // through the WORKSPACE's isolated execution service (internal by design; no host fallback). This proves the
    // installed assets, not the installed runtime: the package exposes no public way to invoke the adapter until the
    // PR 09 command, so installed-runtime acceptance remains open.
    if (process.env.SENTINEL_ISOLATION === '1') {
      const dist = join(sourceDir, 'dist');
      const imp = (p) => import(new URL(`file://${join(dist, p)}`).href);
      const { PATTERN_ADAPTER, PATTERN_WORKER_DIGEST } = await imp('adapters/pattern/adapter.js');
      assert.deepEqual(assets.adapter.command, [...PATTERN_ADAPTER.command], 'the shipped adapter is the workspace adapter');
      assert.equal(assets.worker.digest, PATTERN_WORKER_DIGEST);
      const { patternRuleOf, runPatternAttempt } = await imp('adapters/pattern/index.js');
      const { createAdapterRegistry } = await imp('execution/registry.js');
      const { createExecutionService } = await imp('execution/service.js');
      const { openStore } = await imp('store/index.js');
      const packDir = join(installed, assets.pack.path);
      const pack = JSON.parse(readFileSync(join(packDir, 'sentinel-pack.json'), 'utf8'));
      const rules = pack.rules.map((r) => patternRuleOf(r.familyId, r.revision, readFileSync(join(packDir, r.implementation.rulePath))));
      const targets = pack.rules.flatMap((r) => [...r.fixtures.positive, ...r.fixtures.negative]).filter((v, i, a) => a.indexOf(v) === i).map((p) => {
        const path = join(packDir, p);
        return { relativePath: p.replace(/^fixtures\//, '').replace(/\.fixture$/, ''), path, artifact: `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}` };
      });
      const scratch = realpathSync(consumer.dir);
      const work = join(scratch, 'pattern-work');
      mkdirSync(work, { mode: 0o700 });
      const store = await openStore(join(scratch, 'pattern-store'));
      try {
        const service = await createExecutionService(store, { scratchRoot: work, registry: createAdapterRegistry([PATTERN_ADAPTER]), containers: true });
        const qualify = process.env.SENTINEL_PATTERN_QUALIFY?.replace(/^linux\//, '');
        const result = await runPatternAttempt(service, { attemptId: 'att-package-pattern', work: { id: 'work-package', revision: 1 }, rules, targets, scratch, ...(qualify ? { qualifyingArchitecture: qualify } : {}) });
        assert.equal(result.attempt, 'succeeded');
        const positives = new Set(pack.rules.flatMap((r) => r.fixtures.positive.map((p) => `${r.familyId} ${p.replace(/^fixtures\//, '').replace(/\.fixture$/, '')}`)));
        assert.deepEqual(new Set(result.findings.map((f) => `${f.familyId} ${f.relativePath}`)), positives, 'the shipped pack finds its positives and none of its negatives');
        patternDemo += `, installed assets run by the workspace service: ${result.findings.length} findings (${result.platform.architecture} ${result.platform.state}; installed-runtime acceptance open)`;
      } finally {
        await store.close();
      }
    }
  }

  console.log(`sentinel package ok: ${bins.join(', ')} --help, ${subpaths.length} typed exports (${contracts.length} contract types compiled), ${schemaCount} schemas, ${validated} fixtures, ${storeDemo}${parserExported ? ', parser types compiled' : ''}${expressExported ? ', Express pack types compiled' : ''}, ${patternDemo ? `${patternDemo}, ` : ''}npm consumer`);
} finally {
  consumer.cleanup();
}
