// scripts/pack-sentinel.mjs and scripts/test-sentinel-package.mjs against a throwaway workspace
// with a stand-in Sentinel package in the real package's manifest shape (one envelope kind,
// compiled by tsc). The real package's contracts are its own; CI smokes the real tarball.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync, readFileSync, readdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

const write = (root, path, text) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
const node = (root, script, ...args) => spawnSync(process.execPath, [join(root, 'scripts', script), ...args], { cwd: root, encoding: 'utf8', timeout: 180_000 });
const tsc = (root) => spawnSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '-p', join(root, 'packages/sentinel/tsconfig.json')], { encoding: 'utf8' });
const json = (value) => JSON.stringify(value, null, 2);

const MANIFEST = {
  name: '@farsight/sentinel', version: '0.0.0-draft.1', private: true, description: 'draft contracts only',
  type: 'module', engines: { node: '>=24' }, main: './dist/index.js', types: './dist/index.d.ts',
  bin: { 'farsight-sentinel': './dist/cli.js' },
  exports: {
    '.': { types: './dist/index.d.ts', import: './dist/index.js' },
    './contracts': { types: './dist/contracts/index.d.ts', import: './dist/contracts/index.js' },
    './store': { types: './dist/store/index.d.ts', import: './dist/store/index.js' },
    './schemas/*': './schemas/*', './package.json': './package.json',
  },
  dependencies: { '@farsight/core': 'workspace:*' },
};

function workspace({ build = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'farsight-pack-sentinel-'));
  for (const file of ['pack-sentinel.mjs', 'pack-preflight.mjs', 'npm-consumer.mjs', 'test-sentinel-package.mjs']) {
    write(root, `scripts/${file}`, readFileSync(resolve('scripts', file), 'utf8'));
  }
  symlinkSync(resolve('node_modules'), join(root, 'node_modules'), 'dir');
  write(root, 'package.json', JSON.stringify({ version: '0.0.0-test', type: 'module', engines: { node: '>=24' } }));
  write(root, 'packages/core/package.json', JSON.stringify({ name: '@farsight/core', main: 'dist/index.js' }));
  write(root, 'packages/core/dist/index.js', '');
  write(root, 'packages/sentinel/package.json', json(MANIFEST));
  write(root, 'packages/sentinel/tsconfig.json', json({ compilerOptions: {
    target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, declaration: true,
    sourceMap: true, declarationMap: true, rootDir: 'src', outDir: 'dist', types: [],
  }, include: ['src'] }));
  const KINDS = { report: 'ReportEnvelope', run: 'RunEnvelope', work: 'WorkEnvelope', attempt: 'AttemptEnvelope' };
  write(root, 'packages/sentinel/src/contracts/index.ts', [
    ...Object.entries(KINDS).map(([kind, type]) => `export interface ${type} { schema: 'sentinel-${kind}/draft-1'; id: string }`),
    'export const ENVELOPES = {',
    ...Object.entries(KINDS).map(([kind, type]) => `  ${kind}: { schema: 'sentinel-${kind}/draft-1', type: '${type}' },`),
    '} as const;',
    'export type EnvelopeKind = keyof typeof ENVELOPES;', '',
  ].join('\n'));
  // A stand-in for the draft store with the real facade's public surface, just enough for the package smoke:
  // a JSON file in a private store folder, a new epoch per open, staged and verified receipts, stale-epoch
  // refusal and reads from a second process. It has no SQLite and no lock; the real store is smoked by CI.
  // It reaches node: builtins at run time only, so the stand-in needs no @types/node to compile.
  write(root, 'packages/sentinel/src/store/index.ts', `
declare global { interface Buffer extends Uint8Array { toString(encoding?: string): string } }
type Fs = { existsSync(p: string): boolean; mkdirSync(p: string, o?: object): void; readFileSync(p: string, e: string): string;
  writeFileSync(p: string, d: string, o?: object): void; statSync(p: string): { mode: number } };
type Crypto = { createHash(a: string): { update(b: Uint8Array): { digest(e: string): string } } };
type BufferCtor = { from(text: string, encoding: string): Buffer };
const builtin = <T>(name: string): T => (globalThis as any).process.getBuiltinModule(name) as T;
// A synthetic, test-only qualification admitting exactly the host and SQLite running this test; it is a fixture,
// not product policy. The real policy lives in packages/sentinel/src/store/runtime.ts.
export const SQLITE_RELEASE_POLICY = Object.freeze({
  qualified: Object.freeze([Object.freeze({ host: ${JSON.stringify(process.platform + '-' + process.arch)},
    sqlite: ${JSON.stringify(process.versions.sqlite)}, status: 'candidate' as const,
    evidence: 'synthetic packer-test fixture: admits only the host and SQLite running this test' })]),
});
export function qualificationFor(policy: typeof SQLITE_RELEASE_POLICY, host: string, sqlite: string) {
  return policy.qualified.find(q => q.host === host && q.sqlite === sqlite);
}
export const STORAGE_ERROR_CODES = {
  ledger: ['sentinel.store.staleEpoch', 'sentinel.store.notFound', 'sentinel.store.objectMissing'],
  store: ['sentinel.store.pathNotAbsolute', 'sentinel.store.permissions', 'sentinel.store.platformUnqualified',
    'sentinel.store.runtimeUnqualified'],
  objects: ['sentinel.store.objectMissing'],
} as const;
export class StoreError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'StoreError'; this.code = code; }
}
export class LedgerError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'LedgerError'; this.code = code; }
}
export class ObjectStoreError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'ObjectStoreError'; this.code = code; }
}
export interface WorkRef { id: string; revision: number }
export interface StoredObject { id: string; codec: 'identity'; storedDigest: string; rawSize: number; storedSize: number }
export interface PublicationReceipt { work: WorkRef; attemptId: string; sequence: number }
export interface ReachabilityReport { ok: boolean; missing: string[] }
interface Recorded { id: string; coordinatorEpoch: string; influenceManifest?: string; invocation?: string }
interface State { opens: number; runs: string[]; staged: Record<string, string[]>; objects: Record<string, string>;
  publications: Record<string, { attemptId: string; outputs: { id: string }[] }> }
export interface SentinelStore {
  readonly epoch: string;
  readonly ledger: {
    createRun(run: Recorded): void;
    createWork(work: Recorded): void;
    startAttempt(attempt: Recorded): void;
    registerStaging(stageId: string, artifacts: { id: string; schema: string; privacy: string }[], forAttempt?: { work: WorkRef; attemptId: string }): void;
    publish(input: { work: WorkRef; attemptId: string; stageId: string; receipts: StoredObject[]; outputs: string[]; endedAt: string }): PublicationReceipt;
    getPublication(work: WorkRef): { attemptId: string; outputs: { id: string }[] } | null;
  };
  readonly objects: {
    identify(bytes: Uint8Array): { id: string };
    put(bytes: Uint8Array, options: { expect: { id: string } }): Promise<StoredObject>;
    identifyCanonicalJson(value: unknown): { id: string };
    putCanonicalJson(value: unknown, options: { expect: { id: string } }): Promise<StoredObject>;
  };
  readArtifact(id: string): Promise<Buffer>;
  inspect(): Promise<ReachabilityReport>;
  checkIntegrity(): { integrity: string };
  close(): void;
}
export async function openStore(path: string, options: { waitMs?: number } = {}): Promise<SentinelStore> {
  void options;
  const fs = builtin<Fs>('node:fs');
  if (!path.startsWith('/') || path.split('/').some((s) => s === '.' || s === '..')) throw new StoreError('sentinel.store.pathNotAbsolute');
  const proc = (globalThis as any).process as { platform: string; arch: string; versions: { sqlite?: string } };
  const host = proc.platform + '-' + proc.arch;
  if (!SQLITE_RELEASE_POLICY.qualified.some((q) => q.host === host)) throw new StoreError('sentinel.store.platformUnqualified');
  if (!SQLITE_RELEASE_POLICY.qualified.some((q) => q.host === host && q.sqlite === proc.versions.sqlite)) {
    throw new StoreError('sentinel.store.runtimeUnqualified');
  }
  if (!fs.existsSync(path)) fs.mkdirSync(path, { mode: 0o700 });
  if ((fs.statSync(path).mode & 0o077) !== 0) throw new StoreError('sentinel.store.permissions');
  const file = path + '/store.json';
  const state: State = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8'))
    : { opens: 0, runs: [], staged: {}, objects: {}, publications: {} };
  state.opens += 1;
  const epoch = 'epoch-' + state.opens;
  const save = () => fs.writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
  save();
  const sha = (bytes: Uint8Array) => 'sha256:' + builtin<Crypto>('node:crypto').createHash('sha256').update(bytes).digest('hex');
  const bytesOf = (id: string): Buffer => {
    const text = state.objects[id];
    if (text === undefined) throw new ObjectStoreError('sentinel.store.objectMissing');
    return builtin<{ Buffer: BufferCtor }>('node:buffer').Buffer.from(text, 'base64');
  };
  const current = (r: Recorded) => { if (r.coordinatorEpoch !== epoch) throw new LedgerError('sentinel.store.staleEpoch'); };
  // A manifest or invocation the work or attempt names must be stored bytes, as the real ledger roots them.
  const stored = (id: string | undefined) => { if (id !== undefined && !(id in state.objects)) throw new LedgerError('sentinel.store.objectMissing'); };
  const canonical = (v: unknown): string => Array.isArray(v) ? '[' + v.map(canonical).join(',') + ']'
    : v !== null && typeof v === 'object' ? '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical((v as Record<string, unknown>)[k])).join(',') + '}'
    : JSON.stringify(v);
  const utf8 = (v: unknown) => new TextEncoder().encode(canonical(v));
  const key = (w: WorkRef) => w.id + '@' + w.revision;
  return {
    epoch,
    ledger: {
      createRun(run) { current(run); state.runs.push(run.id); save(); },
      createWork(work) { current(work); stored(work.influenceManifest); },
      startAttempt(attempt) { current(attempt); stored(attempt.invocation); },
      registerStaging(stageId, artifacts) { state.staged[stageId] = artifacts.map((a) => a.id); save(); },
      publish(input) {
        const staged = state.staged[input.stageId];
        if (!staged) throw new LedgerError('sentinel.store.notFound');
        for (const r of input.receipts) if (!staged.includes(r.id) || sha(bytesOf(r.id)) !== r.id) throw new LedgerError('sentinel.store.objectMissing');
        state.publications[key(input.work)] = { attemptId: input.attemptId, outputs: input.outputs.map((id) => ({ id })) };
        delete state.staged[input.stageId];
        save();
        return { work: input.work, attemptId: input.attemptId, sequence: Object.keys(state.publications).length };
      },
      getPublication(work) { return state.publications[key(work)] ?? null; },
    },
    objects: {
      identify(bytes) { return { id: sha(bytes) }; },
      async put(bytes, options) {
        const id = sha(bytes);
        if (id !== options.expect.id) throw new ObjectStoreError('sentinel.store.objectMissing');
        let binary = '';
        for (const b of bytes) binary += String.fromCharCode(b);
        state.objects[id] = (globalThis as any).btoa(binary);
        save();
        return { id, codec: 'identity', storedDigest: id, rawSize: bytes.length, storedSize: bytes.length };
      },
      identifyCanonicalJson(value) { return this.identify(utf8(value)); },
      putCanonicalJson(value, options) { return this.put(utf8(value), options); },
    },
    async readArtifact(id) { return bytesOf(id); },
    async inspect() {
      const missing = Object.values(state.publications).flatMap((p) => p.outputs.map((o) => o.id)).filter((id) => !(id in state.objects));
      return { ok: missing.length === 0, missing };
    },
    checkIntegrity() { return { integrity: 'ok' }; },
    close() { save(); },
  };
}
`);
  write(root, 'packages/sentinel/src/index.ts', [
    "export { StoreError, LedgerError, ObjectStoreError, openStore, SQLITE_RELEASE_POLICY, qualificationFor } from './store/index.js';",
    "import { ENVELOPES, type EnvelopeKind, type ReportEnvelope, type RunEnvelope, type WorkEnvelope, type AttemptEnvelope } from './contracts/index.js';",
    "export * from './contracts/index.js';",
    'export interface EnvelopeTypes { report: ReportEnvelope; run: RunEnvelope; work: WorkEnvelope; attempt: AttemptEnvelope }',
    'export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: { code: string; path: string }[] };',
    'export function validateEnvelope<K extends EnvelopeKind>(kind: K, value: unknown): ValidationResult<EnvelopeTypes[K]> {',
    '  const v = value as { schema?: unknown; id?: unknown };',
    "  if (v?.schema !== ENVELOPES[kind].schema) return { ok: false, errors: [{ code: 'unsupportedVersion', path: '/schema' }] };",
    "  if (typeof v.id !== 'string') return { ok: false, errors: [{ code: 'invalid', path: '/id' }] };",
    '  return { ok: true, value: value as EnvelopeTypes[K] };',
    '}', '',
  ].join('\n'));
  write(root, 'packages/sentinel/src/cli.ts', "console.log('farsight-sentinel (draft): no scanner is available yet');\nexport {};\n");
  for (const kind of Object.keys(KINDS)) {
    write(root, `packages/sentinel/schemas/sentinel-${kind}.draft-1.schema.json`, JSON.stringify({ $id: `sentinel-${kind}/draft-1`, type: 'object' }));
  }
  // The store smoke reads run-active, work-idle and attempt-running; every fixture is named <kind>[-case].json.
  for (const [file, kind, id] of [['report', 'report', 'r1'], ['run-active', 'run', 'run-1'], ['work-idle', 'work', 'work-capture'], ['attempt-running', 'attempt', 'att-1']]) {
    write(root, `packages/sentinel/test/contracts/valid/${file}.json`, JSON.stringify({ schema: `sentinel-${kind}/draft-1`, id }));
  }
  write(root, 'build/sentinel/keep.txt', 'prior artifact');
  if (build) { const built = tsc(root); assert.equal(built.status, 0, built.stdout); }
  return root;
}
const tarball = (root) => join(root, 'build/sentinel/farsight-sentinel-0.0.0-draft.1.tgz');
const packedManifest = (root) => JSON.parse(readFileSync(join(root, 'build/sentinel/package/package.json'), 'utf8'));

test('pack-sentinel refuses an unbuilt or absent Sentinel before touching build/sentinel', () => {
  const root = workspace({ build: false });
  try {
    rmSync(join(root, 'packages/core/dist'), { recursive: true });
    const run = node(root, 'pack-sentinel.mjs');
    assert.equal(run.status, 1);
    assert.match(run.stderr, /pnpm --filter @farsight\/sentinel\.\.\. build/);
    assert.match(run.stderr, /missing: packages\/core\/dist\/index\.js/);
    assert.match(run.stderr, /missing: packages\/sentinel\/dist\/index\.js/);
    assert.equal(existsSync(join(root, 'build/sentinel/keep.txt')), true);
    rmSync(join(root, 'packages/sentinel'), { recursive: true });
    assert.match(node(root, 'pack-sentinel.mjs').stderr, /no Sentinel package to pack/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the tarball carries typed exports, declarations, its own metadata and the schemas', () => {
  const root = workspace();
  try {
    const packed = node(root, 'pack-sentinel.mjs');
    assert.equal(packed.status, 0, packed.stderr);
    assert.ok(existsSync(tarball(root)));
    const manifest = packedManifest(root);
    assert.deepEqual(manifest.exports, {
      '.': { types: './dist/index.d.ts', import: './dist/index.mjs' },
      './contracts': { types: './dist/contracts/index.d.ts', import: './dist/contracts/index.mjs' },
      './store': { types: './dist/store/index.d.ts', import: './dist/store/index.mjs' },
      './package.json': './package.json', './schemas/*': './schemas/*',
    });
    assert.equal(manifest.types, './dist/index.d.ts');
    assert.equal(manifest.version, '0.0.0-draft.1', "Sentinel's own version, not the app's");
    assert.equal(manifest.private, true);
    assert.equal(manifest.description, 'draft contracts only');
    assert.equal(manifest.engines.node, '>=24');
    assert.deepEqual(manifest.files, ['dist', 'schemas']);
    assert.equal(manifest.dependencies, undefined, 'workspace dependencies are inlined, never declared');
    const out = join(root, 'build/sentinel/package/dist');
    assert.match(readFileSync(join(out, 'cli.mjs'), 'utf8'), /^#!\/usr\/bin\/env node\n/);
    assert.doesNotMatch(readFileSync(join(out, 'index.d.ts'), 'utf8'), /sourceMappingURL/);
    assert.ok(existsSync(join(out, 'contracts/index.d.ts')));
    assert.ok(!existsSync(join(out, 'index.js.map')) && !existsSync(join(out, 'index.d.ts.map')), 'no maps into absent sources');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a clean npm consumer imports, type-checks and validates through the installed package', () => {
  const root = workspace();
  try {
    assert.equal(node(root, 'pack-sentinel.mjs').status, 0);
    const smoke = node(root, 'test-sentinel-package.mjs');
    assert.equal(smoke.status, 0, smoke.stderr + smoke.stdout);
    assert.match(smoke.stdout, /sentinel package ok: farsight-sentinel --help, 3 typed exports \(4 contract types compiled\), 4 schemas, 4 fixtures, store reopened across processes \([a-z0-9-]+ SQLite [0-9.]+, candidate\), npm consumer/);
    // the installed schema set must be the source set
    write(root, 'packages/sentinel/schemas/sentinel-extra.draft-1.schema.json', '{}');
    const stale = node(root, 'test-sentinel-package.mjs');
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /the installed schema set is the source set/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the smoke fails when a contract type is missing, and the pack when the schemas are', () => {
  const root = workspace();
  try {
    write(root, 'packages/sentinel/src/contracts/index.ts', readFileSync(join(root, 'packages/sentinel/src/contracts/index.ts'), 'utf8')
      .replace("type: 'ReportEnvelope'", "type: 'MissingEnvelope'"));
    assert.equal(tsc(root).status, 0);
    assert.equal(node(root, 'pack-sentinel.mjs').status, 0);
    const untypedContract = node(root, 'test-sentinel-package.mjs');
    assert.equal(untypedContract.status, 1);
    assert.match(untypedContract.stderr, /the installed types do not compile[\s\S]*MissingEnvelope/);

    rmSync(join(root, 'packages/sentinel/schemas'), { recursive: true });
    const run = node(root, 'pack-sentinel.mjs');
    assert.equal(run.status, 1);
    assert.match(run.stderr, /exports \.\/schemas\/\* but packages\/sentinel\/schemas has no JSON schema/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an untyped export or a declaration a consumer cannot resolve is refused', () => {
  const root = workspace();
  try {
    write(root, 'packages/sentinel/package.json', json({ ...MANIFEST, exports: { ...MANIFEST.exports, './contracts': './dist/contracts/index.js' } }));
    const untyped = node(root, 'pack-sentinel.mjs');
    assert.equal(untyped.status, 1);
    assert.match(untyped.stderr, /untyped: \.\/contracts/);

    write(root, 'packages/sentinel/package.json', json(MANIFEST));
    write(root, 'packages/sentinel/dist/index.d.ts', readFileSync(join(root, 'packages/sentinel/dist/index.d.ts'), 'utf8') +
      "\nexport type { Counted } from '@farsight/core';\nexport type { Stats } from 'node:fs';\n");
    const leaky = node(root, 'pack-sentinel.mjs');
    assert.equal(leaky.status, 1);
    assert.match(leaky.stderr, /import: @farsight\/core/);
    assert.match(leaky.stderr, /import: node:fs/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("third-party dependencies of Sentinel's closure stay external and are declared once", () => {
  const root = workspace();
  try {
    write(root, 'packages/core/package.json', JSON.stringify({ name: '@farsight/core', main: 'dist/index.js', dependencies: { yaml: '^2.0.0' } }));
    write(root, 'packages/sentinel/package.json', json({ ...MANIFEST, dependencies: { ...MANIFEST.dependencies, ajv: '8.20.0' } }));
    write(root, 'packages/sentinel/src/index.ts', readFileSync(join(root, 'packages/sentinel/src/index.ts'), 'utf8') +
      "// @ts-ignore the stand-in has no ajv installed; esbuild keeps it external\nimport Ajv from 'ajv';\nexport const validator = () => new Ajv();\n");
    const packed = node(root, 'pack-sentinel.mjs');
    assert.equal(packed.status, 0, packed.stderr);
    assert.deepEqual(packedManifest(root).dependencies, { ajv: '8.20.0', yaml: '^2.0.0' });
    assert.match(readFileSync(join(root, 'build/sentinel/package/dist/index.mjs'), 'utf8'), /from "ajv"/);
    write(root, 'packages/core/package.json', JSON.stringify({ name: '@farsight/core', main: 'dist/index.js', dependencies: { ajv: '^8.0.0' } }));
    const conflict = node(root, 'pack-sentinel.mjs');
    assert.equal(conflict.status, 1);
    assert.match(conflict.stderr, /ajv is required as both/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a missing transitive compiled module or sibling declaration fails before build/sentinel is replaced', () => {
  const root = workspace();
  try {
    write(root, 'build/sentinel/farsight-sentinel-prior.tgz', 'prior');
    // core's main exists, but re-exports a module that was never compiled: only a real bundle sees it
    write(root, 'packages/core/dist/index.js', "export * from './counts.js';\n");
    write(root, 'packages/sentinel/src/index.ts', readFileSync(join(root, 'packages/sentinel/src/index.ts'), 'utf8') +
      "export * as core from '../../core/dist/index.js';\n");
    const bundle = node(root, 'pack-sentinel.mjs');
    assert.equal(bundle.status, 1);
    assert.match(bundle.stderr, /prior artifacts in build\/ are unchanged[\s\S]*counts\.js/);
    assert.equal(existsSync(join(root, 'build/sentinel/farsight-sentinel-prior.tgz')), true);
    assert.equal(existsSync(join(root, 'build/sentinel/keep.txt')), true);

    write(root, 'packages/core/dist/index.js', '');
    write(root, 'packages/sentinel/dist/index.d.ts', readFileSync(join(root, 'packages/sentinel/dist/index.d.ts'), 'utf8') +
      "\nexport type { Gone } from './gone.js';\n");
    const decl = node(root, 'pack-sentinel.mjs');
    assert.equal(decl.status, 1);
    assert.match(decl.stderr, /sibling declaration that is not built[\s\S]*index\.d\.ts: \.\/gone\.js/);
    assert.equal(existsSync(join(root, 'build/sentinel/farsight-sentinel-prior.tgz')), true);
    assert.deepEqual(readdirSync(join(root, 'build')).filter((n) => n.startsWith('.stage-')), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a successful Sentinel pack replaces build/sentinel only', () => {
  const root = workspace();
  try {
    write(root, 'build/farsight-cli-0.0.0.tgz', 'cli');
    write(root, 'build/echo/farsight-echo-0.0.0.tgz', 'echo');
    const run = node(root, 'pack-sentinel.mjs');
    assert.equal(run.status, 0, run.stderr);
    assert.equal(existsSync(tarball(root)), true);
    assert.equal(existsSync(join(root, 'build/sentinel/keep.txt')), false, 'its own prior output is replaced');
    assert.equal(existsSync(join(root, 'build/farsight-cli-0.0.0.tgz')), true);
    assert.equal(existsSync(join(root, 'build/echo/farsight-echo-0.0.0.tgz')), true);
    assert.deepEqual(readdirSync(join(root, 'build')).filter((n) => n.startsWith('.stage-')), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('npm pack exiting 0 without a tarball keeps build/sentinel; an inherited dry run is switched off', () => {
  const root = workspace();
  try {
    write(root, 'build/sentinel/farsight-sentinel-prior.tgz', 'prior');
    write(root, 'fake-bin/npm', '#!/bin/sh\nexit 0\n');
    chmodSync(join(root, 'fake-bin/npm'), 0o755);
    const env = (extra) => ({ cwd: root, encoding: 'utf8', timeout: 180_000, env: { ...process.env, ...extra } });
    const silent = spawnSync(process.execPath, [join(root, 'scripts/pack-sentinel.mjs')], env({ PATH: `${join(root, 'fake-bin')}:${process.env.PATH}` }));
    assert.equal(silent.status, 1);
    assert.match(silent.stderr, /prior artifacts in build\/ are unchanged[\s\S]*wrote no farsight-sentinel-0\.0\.0-draft\.1\.tgz/);
    assert.equal(readFileSync(join(root, 'build/sentinel/farsight-sentinel-prior.tgz'), 'utf8'), 'prior');
    assert.equal(existsSync(join(root, 'build/sentinel/keep.txt')), true);
    assert.deepEqual(readdirSync(join(root, 'build')).filter((n) => n.startsWith('.stage-')), []);

    const dry = spawnSync(process.execPath, [join(root, 'scripts/pack-sentinel.mjs')], env({ npm_config_dry_run: 'true' }));
    assert.equal(dry.status, 0, dry.stderr);
    assert.ok(existsSync(tarball(root)));
    assert.equal(existsSync(join(root, 'build/sentinel/farsight-sentinel-prior.tgz')), false, 'replaced by the real output');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the root export and a subpath share one module instance in the installed tarball', () => {
  const root = workspace();
  const consumer = mkdtempSync(join(tmpdir(), 'farsight-sentinel-identity-'));
  try {
    const packed = node(root, 'pack-sentinel.mjs');
    assert.equal(packed.status, 0, packed.stderr);
    assert.ok(readdirSync(join(root, 'build/sentinel/package/dist/chunks')).length > 0, 'shared modules are emitted once, as chunks');
    write(consumer, 'package.json', JSON.stringify({ name: 'consumer', private: true, type: 'module' }));
    const installed = spawnSync('npm', ['install', '--offline', '--no-audit', '--no-fund', tarball(root)],
      { cwd: consumer, encoding: 'utf8', timeout: 180_000 });
    assert.equal(installed.status, 0, installed.stderr);
    write(consumer, 'check.mjs', [
      "import * as root from 'farsight-sentinel';",
      "import * as store from 'farsight-sentinel/store';",
      'let thrown;',
      "try { await store.openStore('relative/path'); } catch (e) { thrown = e; }",
      'console.log(JSON.stringify({ open: root.openStore === store.openStore, error: root.StoreError === store.StoreError,',
      '  instanceofRoot: thrown instanceof root.StoreError, instanceofStore: thrown instanceof store.StoreError }));', '',
    ].join('\n'));
    const ran = spawnSync(process.execPath, ['check.mjs'], { cwd: consumer, encoding: 'utf8' });
    assert.equal(ran.status, 0, ran.stderr);
    assert.deepEqual(JSON.parse(ran.stdout), { open: true, error: true, instanceofRoot: true, instanceofStore: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(consumer, { recursive: true, force: true });
  }
});

test("a publishable workspace library's declarations are vendored; a string literal never reads as an import", () => {
  const root = workspace();
  try {
    write(root, 'packages/lib/package.json', JSON.stringify({ name: '@farsight/lib', version: '0.1.0', main: 'dist/index.js', types: './dist/index.d.ts',
      publishConfig: { access: 'public' }, exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } } }));
    write(root, 'packages/lib/dist/index.js', 'export {};\n');
    write(root, 'packages/lib/dist/index.d.ts', "export * from './shape.js';\n");
    // A type whose string literal is 'from': an import scanner that ignores strings would read it as `from '...'`.
    write(root, 'packages/lib/dist/shape.d.ts', "export interface Edge { kind: string; from: string; to: string }\nexport type Ends = Pick<Edge, 'kind' | 'from' | 'to'>;\n");
    write(root, 'packages/sentinel/package.json', json({ ...MANIFEST, dependencies: { ...MANIFEST.dependencies, '@farsight/lib': 'workspace:*' } }));
    write(root, 'packages/sentinel/dist/index.d.ts', readFileSync(join(root, 'packages/sentinel/dist/index.d.ts'), 'utf8') +
      "\nexport type { Edge, Ends } from '@farsight/lib';\n");
    const packed = node(root, 'pack-sentinel.mjs');
    assert.equal(packed.status, 0, packed.stderr);
    const out = join(root, 'build/sentinel/package/dist');
    assert.match(readFileSync(join(out, 'index.d.ts'), 'utf8'), /from '\.\/vendor\/lib\/index\.js'/);
    assert.ok(existsSync(join(out, 'vendor/lib/index.d.ts')) && existsSync(join(out, 'vendor/lib/shape.d.ts')));
    assert.equal(packedManifest(root).dependencies?.['@farsight/lib'], undefined, 'a vendored library is never a dependency');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

