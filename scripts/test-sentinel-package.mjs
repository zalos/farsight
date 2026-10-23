#!/usr/bin/env node
// Installs the packed Sentinel tarball into a clean npm consumer and checks that it stands
// alone: the bin answers --help; every export imports and its public types compile in a
// strict TypeScript consumer that uses the contracts; the installed schemas are exactly the
// source set, one per envelope; the package's valid fixtures validate through the installed
// package and a changed version is refused; the draft store (`farsight-sentinel/store`) opens, publishes
// verified evidence in one process and reads it back in another; and no Farsight application package
// arrives; the pattern rule pack and worker ship with exact digests and rights. No scanner, container, model or
// network service is started, except that with SENTINEL_ISOLATION=1 the shipped Pattern, OSV, Trivy and zizmor workers run once in
// the pinned engine image through the workspace's isolated execution service (never pulled; this checks the installed
// assets, not an installed runtime). SENTINEL_PACKAGE_ENGINE=pattern|osv|iac limits execution to the engine provisioned
// by an individual native qualification job; asset validation still covers all four. With no selector all four engines run.
// npm may fetch Sentinel's declared third-party dependencies.
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
const selectedEngine = process.env.SENTINEL_PACKAGE_ENGINE;
assert.ok(selectedEngine === undefined || ['pattern', 'osv', 'iac'].includes(selectedEngine), 'SENTINEL_PACKAGE_ENGINE must be pattern, osv or iac');
const runEngine = (engine) => process.env.SENTINEL_ISOLATION === '1' && (selectedEngine === undefined || selectedEngine === engine);
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
  const controlsDriver = join(installed, 'dist', 'frameworks', 'controls', 'driver.mjs');
  assert.ok(existsSync(controlsDriver), 'the descriptor driver is a fixed internal dist entry');
  assert.ok(!Object.hasOwn(pkg.sentinel.assets, 'frameworks/controls/driver'), 'the fixed driver is pinned by the dist closure, not the started-asset inventory');
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
  const analysisExported = Object.hasOwn(sourceExports, './analysis');
  assert.equal(subpaths.includes('./analysis'), analysisExported, 'the installed ./analysis export matches the source package');
  const springExported = Object.hasOwn(sourceExports, './frameworks/spring');
  assert.equal(subpaths.includes('./frameworks/spring'), springExported, 'the installed ./frameworks/spring export matches the source package');

  const expressExported = Object.hasOwn(sourceExports, './frameworks/express');
  assert.equal(subpaths.includes('./frameworks/express'), expressExported, 'the installed ./frameworks/express export matches the source package');

  const nextExported = Object.hasOwn(sourceExports, './frameworks/next');
  assert.equal(subpaths.includes('./frameworks/next'), nextExported, 'the installed Next export matches the source package');
  const providersExported = Object.hasOwn(sourceExports, './review/providers');
  assert.equal(subpaths.includes('./review/providers'), providersExported, 'the installed provider export matches the source package');

  // The Nest pack (ADR 32), when the source package exports it: the installed API analyses a tiny synthetic tree from
  // memory, loading the pinned oxc-parser from the consumer's own install. No store and no target code are involved.
  const nestExported = Object.hasOwn(sourceExports, './frameworks/nest');
  assert.equal(subpaths.includes('./frameworks/nest'), nestExported, 'the installed ./frameworks/nest export matches the source package');
  if (nestExported) {
    const nest = JSON.parse(await evalModule(`
      import { createHash } from 'node:crypto';
      const { analyzeNest, NEST_PACK } = await import('farsight-sentinel/frameworks/nest');
      const files = {
        'package.json': JSON.stringify({ dependencies: { '@nestjs/common': '10.4.15', '@nestjs/core': '10.4.15', 'class-validator': '0.14.1' } }),
        'tsconfig.json': JSON.stringify({ compilerOptions: { experimentalDecorators: true, emitDecoratorMetadata: true } }),
        'main.ts': "import { NestFactory } from '@nestjs/core';\\nimport { AppModule } from './app.module';\\nasync function boot() {\\n  const app = await NestFactory.create(AppModule);\\n  await app.listen(3000);\\n}\\nboot();\\n",
        'app.module.ts': "import { Module } from '@nestjs/common';\\nimport { NotesController } from './notes.controller';\\n@Module({ controllers: [NotesController] })\\nexport class AppModule {}\\n",
        'notes.controller.ts': "import { Body, Controller, Post, UsePipes, ValidationPipe } from '@nestjs/common';\\nimport { IsString } from 'class-validator';\\nexport class NoteDto {\\n  @IsString()\\n  text!: string;\\n}\\n@Controller('notes')\\nexport class NotesController {\\n  @Post()\\n  @UsePipes(new ValidationPipe())\\n  create(@Body() dto: NoteDto) {\\n    return dto;\\n  }\\n}\\n",
      };
      const bytes = new Map(), entries = [];
      for (const [relativePath, text] of Object.entries(files)) {
        const b = Buffer.from(text, 'utf8'), content = 'sha256:' + createHash('sha256').update(b).digest('hex');
        bytes.set(content, b);
        entries.push({ sourceId: 'app', relativePath, kind: 'file', disposition: 'included', content, bytes: b.length });
      }
      const graph = { repo: 'app', nodes: [{ id: 'app::route::POST /notes', kind: 'route' }], edges: [{ kind: 'calls', from: 'app::route::POST /notes', to: 'app::notes.controller.ts::NotesController.create' }] };
      const a = await analyzeNest({ snapshot: { id: 'snap-smoke', entries }, sourceId: 'app', graph, readArtifact: async id => bytes.get(id) });
      console.log(JSON.stringify({ version: a.controls.framework.version, pack: NEST_PACK.versions['@nestjs/common'], facts: a.controls.facts.map(f => f.property + ':' + f.verdict) }));
    `));
    assert.equal(nest.version, nest.pack, 'the installed pack resolves the exact pinned Nest version');
    assert.deepEqual(nest.facts.sort(), ['authentication:does-not-apply', 'authorization:does-not-apply', 'input-validation:applies'], 'the installed pack analyses through its own oxc-parser');
  }

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
    ...(analysisExported ? [
      "import { boundedCallPaths, importDeepAnalysis, DEEP_ANALYSIS_SUPPORT, PATH_REASON_CODES, type PathRequest, type DeepImportResult, type PathReason } from 'farsight-sentinel/analysis';",
      'export async function analysisFields(request: PathRequest): Promise<unknown[]> {',
      '  const env: PathEvidenceEnvelope = await boundedCallPaths(request);',
      '  const reason: PathReason = PATH_REASON_CODES[0];',
      "  const r: DeepImportResult = await importDeepAnalysis({ document: '{}', snapshot: { id: 'x', entries: [] }, authorization: null, readContent: async () => new Uint8Array(), importedAt: '2026-10-22T10:00:00Z' });",
      '  const doc: DeepImportEnvelope | undefined = undefined;',
      "  return [env.establishes, env.results[0]?.outcome, reason, r.status, DEEP_ANALYSIS_SUPPORT.engine, doc];",
      '}',
    ] : []),
    ...(springExported ? [
      "import { analyzeSpring, SPRING_PACK, SPRING_ORDER, SPRING_SUPPORT, SPRING_REASON_CODES, matchTemplate, type SpringPackInput, type SpringReason } from 'farsight-sentinel/frameworks/spring';",
      'export function springFields(input: SpringPackInput): unknown[] {',
      '  const reason: SpringReason = SPRING_REASON_CODES[0];',
      '  const profiles: readonly string[] | null = input.environment.activeProfiles;',
      "  return [SPRING_PACK.version, SPRING_ORDER.chain, SPRING_SUPPORT.stack, reason, profiles, matchTemplate('/a', '/a/**'), typeof analyzeSpring];",
      '}',
    ] : []),
    ...(nextExported ? [
      "import { analyzeNext, NEXT_PACK_REVISION, type NextPackInput, type NextPackResult } from 'farsight-sentinel/frameworks/next';",
      'export const nextRevision: number = NEXT_PACK_REVISION;',
      'export const nextCheck = (input: NextPackInput): Promise<NextPackResult> => analyzeNext(input);',
    ] : []),
    ...(providersExported ? [
      "import { BudgetLedger, toNanos, type EnvelopeTotals } from 'farsight-sentinel/review/providers';",
      'export async function providerFields(path: string): Promise<EnvelopeTotals> {',
      '  const ledger: BudgetLedger = await BudgetLedger.open(path);',
      "  try { const cost: bigint | null = toNanos('0.125'); void cost; return ledger.totals('fixture'); } finally { ledger.close(); }",
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
    if (analysisExported) storeDemo += await analysisDemo();
    if (springExported) storeDemo += await springDemo();
    if (expressExported) storeDemo += await expressDemo();
    if (nextExported) storeDemo += await nextDemo();
    if (providersExported) storeDemo += await providersDemo();
  } else {
    const refused = await node('store-write.mjs').then(() => null, (error) => `${error.stderr}`);
    assert.match(refused ?? '', /sentinel\.store\.(platformUnqualified|runtimeUnqualified)/, `an unqualified pair (${host}, SQLite ${process.versions.sqlite}) is refused`);
    assert.ok(!existsSync(storePath), 'no store folder was created on an unqualified host');
    storeDemo = `store refused on unqualified ${host} (not qualification evidence)`;
  }

  // The installed report library, run for real: one synthetic observation, private and shareable reports in every
  // format, each document valid, and SARIF checked against the official schema when SENTINEL_SARIF_SCHEMA names a copy.
  const reportsExported = subpaths.includes('./reports');
  let reportDemo = '';
  if (reportsExported) {
    writeFileSync(join(consumer.dir, 'report-demo.mjs'), `
      import assert from 'node:assert/strict';
      import { createHash } from 'node:crypto';
      import { readFileSync } from 'node:fs';
      import { generateReport } from 'farsight-sentinel/reports';
      import { validateEnvelope } from 'farsight-sentinel';
      const bytes = Buffer.from('export function synthetic() { return unsafe(input); }\\n');
      const content = 'sha256:' + createHash('sha256').update(bytes).digest('hex');
      const o = { schema: 'sentinel-observation/draft-1', id: 'obs-1', snapshotId: 'snap-1',
        producer: { kind: 'scanner', adapterId: 'synthetic-scanner', adapterDigest: content, attemptId: 'att-1' }, producerRuleId: 'rule',
        rule: { familyId: 'sentinel.synthetic.rule', revisionDigest: content }, originalSeverity: 'high', message: 'quoted: unsafe(input)',
        evidence: [{ snapshotId: 'snap-1', sourceId: 'app', relativePath: 'src/synthetic.ts', content, span: { startByte: 0, endByte: bytes.length } }],
        limitationKeys: [], observedAt: '2026-10-22T10:00:00Z' };
      const coverage = { schema: 'sentinel-coverage/draft-1', id: 'cov-1', runId: 'run-1', checkId: 'check-1', workId: 'work-1', workRevision: 1, status: 'complete',
        granularity: 'per-file-per-rule', assessedScopeArtifact: content, limitationsArtifact: content, basis: { kind: 'executed', attemptId: 'att-1' }, skipped: [], recordedAt: '2026-10-22T10:00:00Z' };
      let official;
      if (process.env.SENTINEL_SARIF_SCHEMA) {
        const { Ajv } = await import('ajv');
        official = new Ajv({ strict: false, validateFormats: false, unicodeRegExp: false }).compile(JSON.parse(readFileSync(process.env.SENTINEL_SARIF_SCHEMA, 'utf8')));
      }
      for (const disclosure of ['private', 'shareable']) {
        const out = await generateReport({ id: 'rep-' + disclosure, run: { id: 'run-1', snapshotId: 'snap-1', planRevision: 1 }, ledgerSequence: 1,
          evaluatedAt: '2026-10-22T11:00:00Z', catalogVersion: 'draft-1', disclosure, observations: [o], coverage: [coverage],
          plannedChecks: [{ checkId: 'check-1', sourceId: 'app', files: ['src/synthetic.ts'] }],
          inventory: { included: 1, seenByNoStage: 0, unknownScopeBoundaries: 0 }, readContent: async () => bytes });
        assert.equal(validateEnvelope('report', JSON.parse(out.json)).ok, true);
        assert.equal(out.document.findings[0].evidence[0].state, disclosure === 'private' ? 'embedded' : 'withheld');
        if (disclosure === 'shareable') for (const text of [out.json, out.html, out.markdown, JSON.stringify(out.sarif)]) assert.ok(!text.includes('unsafe(input)'));
        assert.ok(!/<script/i.test(out.html));
        if (official) assert.equal(official(out.sarif), true, JSON.stringify(official.errors));
      }
      console.log(official ? 'official' : 'subset');
    `);
    const kind = (await consumer.exec(process.execPath, ['report-demo.mjs'])).stdout.trim();
    reportDemo = `, generateReport ran installed (private and shareable; SARIF ${kind === 'official' ? 'valid against the official schema' : 'not checked against the official schema: SENTINEL_SARIF_SCHEMA unset'})`;
  }

  /**
   * The installed analysis API, run for real: an original two-file fixture is captured and parsed through the installed
   * package alone; a bounded call path is found across the files and a deep import is refused without the owner's
   * spent receipt. Nothing in the fixture is built or run, and no analyzer exists or is invoked.
   */
  async function analysisDemo() {
    const appDir = join(storeRoot, 'paths-app');
    const files = {
      'src/a.ts': "import { b } from './b.js';\n\nexport function a(input: string) {\n  return b(input);\n}\n",
      'src/b.ts': 'export function b(value: string) {\n  return value.length;\n}\n',
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
    const workDir = join(storeRoot, 'paths-work');
    mkdirSync(workDir, { mode: 0o700 });
    writeFileSync(join(consumer.dir, 'analysis-demo.mjs'), `
      import { createHash } from 'node:crypto';
      import { openStore } from 'farsight-sentinel/store';
      import { captureSnapshot } from 'farsight-sentinel/snapshot';
      import { parseSnapshot } from 'farsight-sentinel/parser';
      import { boundedCallPaths, importDeepAnalysis, deepImportIntent, DEEP_ANALYSIS_SUPPORT } from 'farsight-sentinel/analysis';
      const store = await openStore(${JSON.stringify(join(storeRoot, 'paths-store'))});
      try {
        const { snapshot } = await captureSnapshot(store, { mode: 'working-copy', sources: [{ sourceId: 'app', repositoryId: 'example/smoke', root: ${JSON.stringify(appDir)} }] });
        const parsed = await parseSnapshot(store, { snapshotId: snapshot.id, workDir: ${JSON.stringify(workDir)},
          selection: { gitignore: true, testFiles: 'include' },
          limits: { maxFiles: 100, maxFileBytes: 1 << 20, maxTotalBytes: 1 << 24, maxEntries: 1000, maxDurationMs: 60000 } });
        const readContent = id => store.readArtifact(id);
        const paths = await boundedCallPaths({ snapshot, analysis: parsed.sources[0], readContent,
          queries: [{ from: 'app::src/a.ts::a', to: 'app::src/b.ts::b' }] });
        const file = p => snapshot.entries.find(e => e.relativePath === p);
        const terms = 'sha256:' + createHash('sha256').update('terms').digest('hex');
        const doc = JSON.stringify({ schema: 'sentinel-deep-import/draft-1',
          tool: { name: 'example-analyzer', version: '1.0.0', distributionDigest: 'sha256:' + 'a'.repeat(64) },
          attestation: { license: { identifier: 'LicenseRef-example', termsDigest: terms, acceptedBy: 'owner@example.com', acceptedAt: '2026-10-22T09:00:00Z' },
            provenance: { obtainedFrom: 'mirror', attestedBy: 'team@example.com', attestedAt: '2026-10-22T09:00:00Z' } },
          binding: { snapshotId: snapshot.id, sourceId: 'app', files: ['src/a.ts', 'src/b.ts'].map(p => ({ relativePath: p, content: file(p).content })),
            configurationDigest: 'sha256:' + 'c'.repeat(64), mode: 'source-only', buildPerformed: false },
          flows: [{ toolRuleId: 'example/flow', message: 'input reaches b', originalSeverity: 'low',
            source: { relativePath: 'src/a.ts', content: file('src/a.ts').content, span: { startByte: 40, endByte: 45 } }, steps: [],
            sink: { relativePath: 'src/b.ts', content: file('src/b.ts').content, span: { startByte: 0, endByte: 10 } } }] });
        // Without the owner's spent receipt for exactly this document, nothing is imported; the attester it names is
        // just text. (Receipts are issued only by the owner's local CLI flow, which the package does not export.)
        const refused = await importDeepAnalysis({ document: doc, snapshot, readContent, importedAt: '2026-10-22T10:00:00Z', authorization: null });
        const intent = deepImportIntent(doc, snapshot.id);
        console.log(JSON.stringify({ outcome: paths.results[0].outcome, establishes: paths.establishes, steps: paths.results[0].paths[0]?.steps.length,
          refused: refused.status, reason: refused.reasonCode, intent: intent?.action, engine: DEEP_ANALYSIS_SUPPORT.engine }));
      } finally { store.close(); }
    `);
    const result = JSON.parse((await node('analysis-demo.mjs')).stdout.trim());
    assert.deepEqual(result, { outcome: 'reached', establishes: 'call-reachability', steps: 1, refused: 'untrusted', reason: 'sentinel.deep.notOwnerConfirmed', intent: 'evidence.import', engine: null },
      'a bounded call path, and an import refused without the owner\'s receipt, from the installed package alone');
    return ', analysis API ran installed (call path, import refused without owner receipt)';
  }

  /**
   * The installed Express pack, run for real: an original fixture with a route registered before its check, one after
   * it and one behind a conditional registration in a second application is captured, parsed and analysed through the
   * installed package alone. git builds the fixture's repository only; nothing in it is installed or run.
   */

  // Original Next fixtures, now exercised by the installed package only. The lock is inert fixture data, not a
  // fetched dependency. Every parse and analysis happens after that fixture's checkout has been removed.
  async function nextDemo() {
    const lock = "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n\nimporters:\n\n  .:\n    dependencies:\n      next:\n        specifier: 14.2.25\n        version: 14.2.25(react-dom@18.3.1(react@18.3.1))(react@18.3.1)\n      react:\n        specifier: 18.3.1\n        version: 18.3.1\n      react-dom:\n        specifier: 18.3.1\n        version: 18.3.1(react@18.3.1)\n\npackages:\n\n  next@14.2.25:\n    resolution: {integrity: sha512-N5M7xMc4wSb4IkPvEV5X2BRRXUmhVHNyaXwEM86+voXthSZz8ZiRyQW4p9mwAoAPIm6OzuVZtn7idgEJeAJN3Q==}\n\n  react-dom@18.3.1:\n    resolution: {integrity: sha512-5m4nQKp+rZRb09LNH59GM4BxTh9251/ylbKIbpe7TpGxfJ+9kv6BLkLBXIjjspbgbnIBNqlI23tRnTWT0snUIw==}\n\n  react@18.3.1:\n    resolution: {integrity: sha512-wS+hAgJShR0KhEvPJArfuPVN1+Hz1t0Y6n5jLrGQbkb4urgPE/0Rve+1kMB1v/oWgHgm4WIcV+i7F2pTVj+2iQ==}\n";
    const patch = 'patchedDependencies:\n# Original inert column-zero comment\n    next@14.2.25:\n        path: patches/next.patch\n        hash: fixture\n\n';
    const cases = [
      { label: 'peer-positive', lock, supported: true },
      { label: 'tagged-patch', lock: lock.replace('importers:', '!!str ' + patch + 'importers:'), supported: false },
      { label: 'comment-patch', lock: lock.replace('importers:', patch + 'importers:'), supported: false },
      { label: 'quoted-patch', lock: lock.replace('  next@14.2.25:\n', '  next@14.2.25:\n    "patched": true\n'), supported: false },
      { label: 'dynamic', lock, supported: true, dynamic: true },
    ];
    writeFileSync(join(consumer.dir, 'next-demo.mjs'), `
      import assert from 'node:assert/strict';
      import { mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
      import { join } from 'node:path';
      import { execFileSync } from 'node:child_process';
      import { openStore } from 'farsight-sentinel/store';
      import { captureSnapshot } from 'farsight-sentinel/snapshot';
      import { parseSnapshot } from 'farsight-sentinel/parser';
      import { analyzeNext } from 'farsight-sentinel/frameworks/next';
      assert.ok(!readdirSync('node_modules').includes('@farsight'), 'no workspace packages in this consumer');
      const root = ${JSON.stringify(join(storeRoot, 'next'))};
      for (const c of ${JSON.stringify(cases)}) {
        const dir = join(root, c.label), repo = join(dir, 'repo'), work = join(dir, 'work');
        mkdirSync(repo, { recursive: true }); mkdirSync(work);
        const files = {
          'package.json': JSON.stringify({ name: 'original-next-fixture', private: true, dependencies: { next: '14.2.25', react: '18.3.1', 'react-dom': '18.3.1' } }),
          'pnpm-lock.yaml': c.lock,
          'middleware.ts': c.dynamic ? "const matcher = process.env.ROUTES; export function middleware() {}\\nexport const config = { matcher };\\n" : "export function middleware() {}\\nexport const config = { matcher: '/private/:path*' };\\n",
          'app/private/route.ts': 'export function GET() { return new Response(null); }\\n',
          'app/public/route.ts': 'export function GET() { return new Response(null); }\\n',
          'patches/next.patch': '# Original inert patch\\n',
        };
        for (const [path, text] of Object.entries(files)) { mkdirSync(join(repo, path, '..'), { recursive: true }); writeFileSync(join(repo, path), text); }
        const env = { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'dev@example.com' };
        for (const args of [['init', '--quiet'], ['add', '--all'], ['commit', '--quiet', '-m', 'fixture']]) execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: repo, env, stdio: 'ignore' });
        const store = await openStore(join(dir, 'store'));
        try {
          const { snapshot } = await captureSnapshot(store, { mode: 'working-copy', sources: [{ sourceId: 'web', repositoryId: 'example/web', root: repo }] });
          rmSync(repo, { recursive: true, force: true });
          const analysis = await parseSnapshot(store, { snapshotId: snapshot.id, workDir: work, selection: { gitignore: true, testFiles: 'include' },
            limits: { maxFiles: 100, maxFileBytes: 65536, maxTotalBytes: 1048576, maxEntries: 1000, maxDurationMs: 60000 } });
          const result = await analyzeNext({ snapshot, analysis: analysis.sources[0], read: id => store.readArtifact(id) });
          assert.equal(result.projects[0].supported, c.supported, c.label);
          const facts = result.envelopes[0].facts.filter(f => f.surfaceId === 'web::route::GET /public');
          assert.ok(facts.length > 0, c.label);
          assert.ok(facts.every(f => f.verdict === (c.supported && !c.dynamic ? 'does-not-apply' : 'unknown')), c.label);
        } finally { store.close(); }
      }
      console.log('Next peer-positive, modified identity and dynamic matcher after checkout removal');
    `);
    const r = await node('next-demo.mjs');
    assert.match(r.stdout, /Next peer-positive, modified identity and dynamic matcher after checkout removal/);
    return ', Next retained-byte peer/patch/dynamic checks';
  }

  // The provider library's offline budget seam only: no provider profile, credential, endpoint or request exists.
  // Direct ledger calls here are a trusted fixture, not a claim that an imported digest grants owner authority.
  async function providersDemo() {
    const path = join(storeRoot, 'provider-budget.db');
    writeFileSync(join(consumer.dir, 'provider-demo.mjs'), `
      import assert from 'node:assert/strict';
      import { BudgetLedger, toNanos } from 'farsight-sentinel/review/providers';
      assert.equal(toNanos('0.125'), 125000000n);
      const path = ${JSON.stringify(path)}, at = '2026-10-22T12:00:00.000000000Z';
      const ledger = await BudgetLedger.open(path);
      try {
        ledger.createEnvelope({ id: 'fixture', runId: 'fixture-run', bindingDigest: 'sha256:' + '1'.repeat(64), admissionDigest: 'sha256:' + '2'.repeat(64), receiptDigest: null,
          maxTokens: 10, maxCostNanos: 0n, currency: 'USD', createdAt: at });
        const held = ledger.reserve({ envelopeId: 'fixture', operationId: 'first', tokens: 6, costNanos: 0n, epoch: 'fixture-epoch', at });
        assert.equal(ledger.reserve({ envelopeId: 'fixture', operationId: 'first', tokens: 6, costNanos: 0n, epoch: 'fixture-epoch', at }).id, held.id);
        assert.throws(() => ledger.reserve({ envelopeId: 'fixture', operationId: 'overspend', tokens: 5, costNanos: 0n, epoch: 'fixture-epoch', at }), e => e.code === 'sentinel.provider.budgetExhausted');
        assert.equal(ledger.totals('fixture').chargedTokens, 6);
      } finally { ledger.close(); }
    `);
    await node('provider-demo.mjs');
    writeFileSync(join(consumer.dir, 'provider-reopen.mjs'), `
      import assert from 'node:assert/strict';
      import { BudgetLedger } from 'farsight-sentinel/review/providers';
      const ledger = await BudgetLedger.open(${JSON.stringify(path)});
      try { assert.equal(ledger.totals('fixture').chargedTokens, 6); assert.equal(ledger.totals('fixture').byState.held, 1); }
      finally { ledger.close(); }
      console.log('provider offline budget reservation, overspend refusal and cross-process reopen');
    `);
    assert.match((await node('provider-reopen.mjs')).stdout, /provider offline budget reservation, overspend refusal and cross-process reopen/);
    return ', provider offline budget checks';
  }

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
      'app::route::GET /late': '0:sentinel.express.refusalUnproven',
      'app::route::GET /maybe': '0:sentinel.express.registrationDynamic',
    }, 'a route before its check, one after it and a conditional registration, from the installed package alone');
    return ', Express pack analysed an installed fixture (before, after, conditional)';
  }

  /**
   * The installed Spring pack, run for real: an original fixture with a deliberately open route (the earlier, narrower
   * chain), a protected one and one no chain matches is captured, parsed and analysed through the installed package
   * alone, so the bundled parser, its native binding and the Java grammar all resolve from the consumer's own install.
   * git builds the fixture's repository only; nothing from the checkout or pnpm is used.
   */
  async function springDemo() {
    const appDir = join(storeRoot, 'spring-app');
    const files = {
      'pom.xml': `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>3.4.3</version>
    <relativePath/>
  </parent>
  <groupId>example</groupId>
  <artifactId>smoke</artifactId>
  <version>0.0.0</version>
  <dependencies>
    <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency>
    <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-security</artifactId></dependency>
  </dependencies>
</project>
`,
      'src/main/java/app/App.java': 'package app;\n\n@org.springframework.boot.autoconfigure.SpringBootApplication\npublic class App {}\n',
      'src/main/java/app/SecurityConfig.java': `package app;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.annotation.Order;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.web.SecurityFilterChain;

@Configuration
public class SecurityConfig {
  @Bean
  @Order(1)
  public SecurityFilterChain open(HttpSecurity http) throws Exception {
    http.securityMatcher("/api/public/**").authorizeHttpRequests(auth -> auth.anyRequest().permitAll());
    return http.build();
  }

  @Bean
  @Order(2)
  public SecurityFilterChain secure(HttpSecurity http) throws Exception {
    http.securityMatcher("/api/**").authorizeHttpRequests(auth -> auth.anyRequest().authenticated());
    return http.build();
  }
}
`,
      'src/main/java/app/Routes.java': `package app;

import org.springframework.web.bind.annotation.*;

@RestController
public class Routes {
  @GetMapping("/api/public/info")
  public String open() { return "open"; }

  @GetMapping("/api/data")
  public String secure() { return "secure"; }

  @GetMapping("/other")
  public String other() { return "other"; }
}
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
    const workDir = join(storeRoot, 'spring-work');
    mkdirSync(workDir, { mode: 0o700 });
    writeFileSync(join(consumer.dir, 'spring-demo.mjs'), `
      import { openStore } from 'farsight-sentinel/store';
      import { captureSnapshot } from 'farsight-sentinel/snapshot';
      import { parseSnapshot } from 'farsight-sentinel/parser';
      import { analyzeSpring, SPRING_ORDER } from 'farsight-sentinel/frameworks/spring';
      const store = await openStore(${JSON.stringify(join(storeRoot, 'spring-store'))});
      try {
        const { snapshot } = await captureSnapshot(store, { mode: 'working-copy', sources: [{ sourceId: 'app', repositoryId: 'example/smoke', root: ${JSON.stringify(appDir)} }] });
        const parsed = await parseSnapshot(store, { snapshotId: snapshot.id, workDir: ${JSON.stringify(workDir)},
          selection: { gitignore: true, testFiles: 'include' },
          limits: { maxFiles: 100, maxFileBytes: 1 << 20, maxTotalBytes: 1 << 24, maxEntries: 1000, maxDurationMs: 60000 } });
        const facts = await analyzeSpring({ snapshot, sourceId: 'app', analysis: parsed.sources[0], readContent: id => store.readArtifact(id),
          environment: { activeProfiles: [] } });
        const out = {};
        for (const f of facts.facts) if (f.property === 'authentication' && f.order === SPRING_ORDER.chain) out[f.surfaceId] = f.verdict === 'unknown' ? f.reasonCode : f.verdict;
        console.log(JSON.stringify({ version: facts.framework.version, out }));
      } finally { store.close(); }
    `);
    const result = JSON.parse((await node('spring-demo.mjs')).stdout.trim());
    assert.equal(result.version, 'boot-3.4.3+security-6.4.3');
    assert.deepEqual(result.out, {
      'app::route::GET /api/public/info': 'does-not-apply',
      'app::route::GET /api/data': 'applies',
      'app::route::GET /other': 'sentinel.spring.noChainMatches',
    }, 'open, protected and unmatched routes, from the installed package alone');
    return ', Spring pack analysed an installed fixture (open, protected, unknown)';
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
    if (runEngine('pattern')) {
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

  // Production rule packs are data, with no scanner activation, engine, database or permission bundled.
  if (existsSync(join(sourceDir, 'scripts', 'package-assets-drivers.mjs'))) {
    const manifest = JSON.parse(readFileSync(join(installed, 'assets', 'drivers', 'manifest.json'), 'utf8'));
    assert.equal(manifest.schema, 'sentinel-driver-assets/draft-1');
    assert.equal(manifest.registered, false);
    assert.deepEqual(manifest.packs.map(p => p.path).sort(), ['rules/advisories', 'rules/ci', 'rules/infrastructure']);
    for (const pack of manifest.packs) {
      assert.deepEqual(pack.rights, { spdx: 'MIT', origin: 'sentinel-original' });
      for (const file of pack.files) {
        const bytes = readFileSync(join(installed, pack.path, file.path));
        assert.equal(bytes.length, file.size);
        assert.equal(`sha256:${createHash('sha256').update(bytes).digest('hex')}`, file.digest);
        assert.equal(digest(join(installed, pack.path, file.path)), digest(join(sourceDir, pack.path, file.path)));
      }
      const validated = JSON.parse(await evalModule(`
        import { createRequire } from 'node:module';
        import { dirname } from 'node:path';
        import { readPackDirectory, validatePack } from 'farsight-sentinel/rules';
        const r = createRequire(process.cwd() + '/');
        const dir = dirname(r.resolve(${JSON.stringify('farsight-sentinel/' + pack.path + '/sentinel-pack.json')}));
        const p = validatePack(readPackDirectory(dir));
        console.log(JSON.stringify({packId: p.entry.packId, packDigest: p.entry.packDigest, rules: p.entry.rules}));
      `));
      assert.deepEqual(validated, {packId: pack.packId, packDigest: pack.packDigest, rules: pack.rules});
    }
  }

  // OSV assets: the in-container worker ships with its exact digest and rights; no advisory database ships.
  let osvDemo = '';
  if (existsSync(join(sourceDir, 'scripts', 'package-assets-osv.mjs'))) {
    const manifestPath = join(installed, 'assets', 'osv', 'manifest.json');
    assert.ok(existsSync(manifestPath), 'the OSV asset manifest is packaged');
    const resolved = await evalModule(`import { createRequire } from 'node:module'; const r = createRequire(process.cwd() + '/'); console.log(r.resolve('farsight-sentinel/assets/osv/manifest.json'));`);
    assert.ok(resolved.trim().endsWith('assets/osv/manifest.json'), 'OSV assets resolve through the exports map');
    const osv = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const worker = readFileSync(join(installed, osv.worker.path));
    assert.equal(`sha256:${createHash('sha256').update(worker).digest('hex')}`, osv.worker.digest, 'the OSV worker matches its digest');
    assert.equal(osv.adapter.command.at(-1), `/input/${osv.worker.digest.slice(7)}`, 'the fixed command names the shipped worker');
    assert.match(osv.adapter.image, /^ghcr\.io\/google\/osv-scanner@sha256:[0-9a-f]{64}$/);
    assert.equal(osv.registered, false);
    assert.ok(!readdirSync(installed, { recursive: true }).map(String).some((f) => /\.zip$|all\.zip|advisories\/SENTINEL/.test(f)), 'no advisory database or fixture ships');
    osvDemo = `osv assets (worker ${osv.worker.digest.slice(7, 19)}, no database), `;
    // With SENTINEL_ISOLATION=1 and the pinned image installed, the shipped worker bytes run in the real engine through
    // the WORKSPACE's isolated execution service, against a synthetic snapshot. This checks the installed asset, not an
    // installed runtime: nothing exported invokes the adapter until the PR 09 command.
    if (runEngine('osv')) {
      const imp = (p) => import(new URL(`file://${join(sourceDir, 'dist', p)}`).href);
      const { OSV_ADAPTER, OSV_WORKER_DIGEST, runOsvAttempt } = await imp('adapters/osv/index.js');
      assert.deepEqual(osv.adapter.command, [...OSV_ADAPTER.command], 'the shipped adapter is the workspace adapter');
      assert.equal(osv.worker.digest, OSV_WORKER_DIGEST);
      const { createAdapterRegistry } = await imp('execution/registry.js');
      const { createExecutionService } = await imp('execution/service.js');
      const { openStore } = await imp('store/index.js');
      const helpers = await import(new URL(`file://${join(sourceDir, 'test', 'osv-helpers.ts')}`).href);
      const scratch = realpathSync(consumer.dir);
      const work = join(scratch, 'osv-work');
      mkdirSync(work, { mode: 0o700 });
      const store = await openStore(join(scratch, 'osv-store'));
      try {
        const service = await createExecutionService(store, { scratchRoot: work, registry: createAdapterRegistry([OSV_ADAPTER]), containers: true });
        const snapshots = [helpers.syntheticSnapshot(join(scratch, 'osv-db'), 'npm', [1], '2026-10-21T00:00:00.000000000Z')];
        const qualify = process.env.SENTINEL_OSV_QUALIFY?.replace(/^linux\//, '');
        const r = await runOsvAttempt(service, {
          attemptId: 'att-package-osv', work: { id: 'work-package', revision: 1 }, scratch,
          targets: helpers.capturedTree(join(scratch, 'osv-tree'), { 'web/package-lock.json': 'package-lock-json.fixture' }),
          snapshots, policy: { now: new Date(), maxDatabaseAgeMs: 3650 * 86_400_000 }, ...(qualify ? { qualifyingArchitecture: qualify } : {}),
        });
        assert.equal(r.attempt, 'succeeded');
        assert.deepEqual(r.findings.map((f) => f.name), ['sentinel-fixture-alpha']);
        osvDemo += `installed osv worker run by the workspace service: ${r.findings.length} finding (${r.platform.architecture} ${r.platform.state}; installed-runtime acceptance open), `;
      } finally {
        await store.close();
      }
    }
  }

  // Trivy assets: the in-container worker ships with its exact digest and rights; no checks bundle or fixture ships.
  let trivyDemo = '';
  if (existsSync(join(sourceDir, 'scripts', 'package-assets-trivy.mjs'))) {
    const manifestPath = join(installed, 'assets', 'trivy', 'manifest.json');
    assert.ok(existsSync(manifestPath), 'the Trivy asset manifest is packaged');
    const resolved = await evalModule(`import { createRequire } from 'node:module'; const r = createRequire(process.cwd() + '/'); console.log(r.resolve('farsight-sentinel/assets/trivy/manifest.json'));`);
    assert.ok(resolved.trim().endsWith('assets/trivy/manifest.json'), 'Trivy assets resolve through the exports map');
    const trivy = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const worker = readFileSync(join(installed, trivy.worker.path));
    assert.equal(`sha256:${createHash('sha256').update(worker).digest('hex')}`, trivy.worker.digest, 'the Trivy worker matches its digest');
    assert.equal(trivy.adapter.command.at(-1), `/input/${trivy.worker.digest.slice(7)}`, 'the fixed command names the shipped worker');
    assert.match(trivy.adapter.image, /^ghcr\.io\/aquasecurity\/trivy@sha256:[0-9a-f]{64}$/);
    assert.equal(trivy.checks.shipped, false);
    assert.equal(trivy.registered, false);
    assert.ok(!readdirSync(installed, { recursive: true }).map(String).some((f) => /\.tar\.gz$|fixtures\/iac/.test(f)), 'no checks bundle or fixture ships');
    trivyDemo = `trivy assets (worker ${trivy.worker.digest.slice(7, 19)}, no bundle), `;
    // With SENTINEL_ISOLATION=1, the pinned image installed and SENTINEL_TRIVY_CHECKS_DIR naming the owner-acquired
    // bundle, the shipped worker bytes run in the real engine through the WORKSPACE's isolated execution service. This
    // checks the installed asset, not an installed runtime: nothing exported invokes the adapter until the PR 09 command.
    if (runEngine('iac')) {
      const imp = (p) => import(new URL(`file://${join(sourceDir, 'dist', p)}`).href);
      const { TRIVY_ADAPTER, TRIVY_WORKER_DIGEST, loadChecksBundle, runTrivyAttempt } = await imp('adapters/trivy/index.js');
      assert.deepEqual(trivy.adapter.command, [...TRIVY_ADAPTER.command], 'the shipped adapter is the workspace adapter');
      assert.equal(trivy.worker.digest, TRIVY_WORKER_DIGEST);
      assert.ok(process.env.SENTINEL_TRIVY_CHECKS_DIR, 'SENTINEL_TRIVY_CHECKS_DIR names the owner-acquired bundle');
      const bundle = loadChecksBundle(join(process.env.SENTINEL_TRIVY_CHECKS_DIR, 'checks'));
      assert.ok(bundle, 'the pinned checks bundle has been acquired');
      const { createAdapterRegistry } = await imp('execution/registry.js');
      const { createExecutionService } = await imp('execution/service.js');
      const { openStore } = await imp('store/index.js');
      const helpers = await import(new URL(`file://${join(sourceDir, 'test', 'iac-helpers.ts')}`).href);
      const scratch = realpathSync(consumer.dir);
      const work = join(scratch, 'trivy-work');
      mkdirSync(work, { mode: 0o700 });
      const store = await openStore(join(scratch, 'trivy-store'));
      try {
        const service = await createExecutionService(store, { scratchRoot: work, registry: createAdapterRegistry([TRIVY_ADAPTER]), containers: true });
        const qualify = process.env.SENTINEL_IAC_QUALIFY?.replace(/^linux\//, '');
        const r = await runTrivyAttempt(service, {
          attemptId: 'att-package-trivy', work: { id: 'work-package', revision: 1 }, scratch, bundle,
          targets: helpers.capturedTree(join(scratch, 'trivy-tree'), { 'services/api/Dockerfile': 'trivy/dockerfile-root.fixture' }),
          ...(qualify ? { qualifyingArchitecture: qualify } : {}),
        });
        assert.equal(r.attempt, 'succeeded');
        assert.ok(r.findings.some((f) => f.checkId === 'DS-0002'));
        trivyDemo += `installed trivy worker run by the workspace service: ${r.findings.length} findings (${r.platform.architecture} ${r.platform.state}; installed-runtime acceptance open), `;
      } finally {
        await store.close();
      }
    }
  }

  // zizmor assets: the in-container worker ships with its exact digest and rights; no fixture ships.
  let zizmorDemo = '';
  if (existsSync(join(sourceDir, 'scripts', 'package-assets-zizmor.mjs'))) {
    const manifestPath = join(installed, 'assets', 'zizmor', 'manifest.json');
    assert.ok(existsSync(manifestPath), 'the zizmor asset manifest is packaged');
    const zizmor = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const worker = readFileSync(join(installed, zizmor.worker.path));
    assert.equal(`sha256:${createHash('sha256').update(worker).digest('hex')}`, zizmor.worker.digest, 'the zizmor worker matches its digest');
    assert.equal(zizmor.adapter.command.at(-1), `/input/${zizmor.worker.digest.slice(7)}`, 'the fixed command names the shipped worker');
    assert.match(zizmor.adapter.image, /^ghcr\.io\/zizmorcore\/zizmor@sha256:[0-9a-f]{64}$/);
    assert.ok(zizmor.adapter.engineArgs.includes('--offline') && zizmor.adapter.engineArgs.includes('--no-ignores'));
    assert.equal(zizmor.registered, false);
    zizmorDemo = `zizmor assets (worker ${zizmor.worker.digest.slice(7, 19)}), `;
    if (runEngine('iac')) {
      const imp = (p) => import(new URL(`file://${join(sourceDir, 'dist', p)}`).href);
      const { ZIZMOR_ADAPTER, ZIZMOR_WORKER_DIGEST, runZizmorAttempt } = await imp('adapters/zizmor/index.js');
      assert.deepEqual(zizmor.adapter.command, [...ZIZMOR_ADAPTER.command], 'the shipped adapter is the workspace adapter');
      assert.equal(zizmor.worker.digest, ZIZMOR_WORKER_DIGEST);
      const { createAdapterRegistry } = await imp('execution/registry.js');
      const { createExecutionService } = await imp('execution/service.js');
      const { openStore } = await imp('store/index.js');
      const helpers = await import(new URL(`file://${join(sourceDir, 'test', 'iac-helpers.ts')}`).href);
      const scratch = realpathSync(consumer.dir);
      const work = join(scratch, 'zizmor-work');
      mkdirSync(work, { mode: 0o700 });
      const store = await openStore(join(scratch, 'zizmor-store'));
      try {
        const service = await createExecutionService(store, { scratchRoot: work, registry: createAdapterRegistry([ZIZMOR_ADAPTER]), containers: true });
        const qualify = process.env.SENTINEL_IAC_QUALIFY?.replace(/^linux\//, '');
        const r = await runZizmorAttempt(service, {
          attemptId: 'att-package-zizmor', work: { id: 'work-package', revision: 1 }, scratch,
          targets: helpers.capturedTree(join(scratch, 'zizmor-tree'), { '.github/workflows/triage.yml': 'zizmor/workflow-injection.fixture' }),
          ...(qualify ? { qualifyingArchitecture: qualify } : {}),
        });
        assert.equal(r.attempt, 'succeeded');
        assert.ok(r.findings.some((f) => f.audit === 'template-injection'));
        zizmorDemo += `installed zizmor worker run by the workspace service: ${r.findings.length} findings (${r.platform.architecture} ${r.platform.state}; installed-runtime acceptance open), `;
      } finally {
        await store.close();
      }
    }
  }

  // Gitleaks assets: the in-container worker ships with its exact digest and rights; no image, binary or report ships.
  let gitleaksDemo = '';
  if (existsSync(join(sourceDir, 'scripts', 'package-assets-gitleaks.mjs'))) {
    const manifestPath = join(installed, 'assets', 'gitleaks', 'manifest.json');
    assert.ok(existsSync(manifestPath), 'the Gitleaks asset manifest is packaged');
    const resolved = await evalModule(`import { createRequire } from 'node:module'; const r = createRequire(process.cwd() + '/'); console.log(r.resolve('farsight-sentinel/assets/gitleaks/manifest.json'));`);
    assert.ok(resolved.trim().endsWith('assets/gitleaks/manifest.json'), 'Gitleaks assets resolve through the exports map');
    const gitleaks = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const worker = readFileSync(join(installed, gitleaks.worker.path));
    assert.equal(`sha256:${createHash('sha256').update(worker).digest('hex')}`, gitleaks.worker.digest, 'the Gitleaks worker matches its digest');
    assert.equal(gitleaks.adapter.command.at(-1), `/input/${gitleaks.worker.digest.slice(7)}`, 'the fixed command names the shipped worker');
    assert.match(gitleaks.adapter.image, /^ghcr\.io\/gitleaks\/gitleaks@sha256:[0-9a-f]{64}$/);
    assert.equal(gitleaks.registered, true);
    assert.deepEqual(readdirSync(join(installed, 'assets', 'gitleaks')).sort(), ['manifest.json', 'worker.sh'], 'only the worker and its manifest ship');
    assert.ok(!readdirSync(installed, { recursive: true }).map(String).some((f) => /\.tar$|secrets-helpers|secrets-conformance|report\.txt$/.test(f)), 'no image, report or test helper ships');
    gitleaksDemo = `gitleaks assets (worker ${gitleaks.worker.digest.slice(7, 19)}, no image), `;
  }

  console.log(`sentinel package ok: ${bins.join(', ')} --help, ${subpaths.length} typed exports (${contracts.length} contract types compiled), ${schemaCount} schemas, ${validated} fixtures, ${storeDemo}${reportDemo}${parserExported ? ', parser types compiled' : ''}${analysisExported ? ', analysis types compiled' : ''}${springExported ? ', Spring pack types compiled' : ''}${expressExported ? ', Express pack types compiled' : ''}${nestExported ? ', Nest pack analysed' : ''}${nextExported ? ', Next types compiled' : ''}${providersExported ? ', provider types compiled' : ''}, ${patternDemo ? `${patternDemo}, ` : ''}${osvDemo}${trivyDemo}${zizmorDemo}${gitleaksDemo}npm consumer`);
} finally {
  consumer.cleanup();
}
