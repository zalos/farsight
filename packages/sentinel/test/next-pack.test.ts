// PR 14: the Next pack over real evidence — synthetic original Next apps committed to Git, captured into a real store,
// parsed by the public parser from the store alone (the checkout is deleted first), then analyzed. No package is
// installed and no application code runs; manifests exist only inside the temporary captured trees.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { captureSnapshot } from '../dist/snapshot/index.js';
import { parseSnapshot } from '../dist/snapshot/parser.js';
import { validateEnvelope } from '../dist/index.js';
import { analyzeNext, NextPackError } from '../dist/frameworks/next/index.js';
import { commitRepo, needsStore, openCaptureStore, scratch, unlock } from './snapshot-helpers.ts';
import { VERSIONS, integrityOf, npmLock, pnpmLock, registryEntry } from './next-helpers.ts';

const LIMITS = { maxFiles: 500, maxFileBytes: 256 * 1024, maxTotalBytes: 8 * 1024 * 1024, maxEntries: 20_000, maxDurationMs: 60_000 };
const SELECT = { gitignore: true, testFiles: 'include' as const };
const lock = (v: Record<string, string> = VERSIONS) => npmLock(v);
const route = (name: string) => `// Synthetic Sentinel PR 14 fixture route.\nexport async function GET() {\n  return Response.json({ reached: '${name}' });\n}\n`;
const page = (name: string) => `// Synthetic Sentinel PR 14 fixture page.\nexport default function Page() {\n  return <main>${name}</main>;\n}\n`;
const MATCHER = "['/api/dashboard/:path*']";
const middleware = (config = `export const config = {\n  matcher: ${MATCHER},\n};\n`) => [
  '// Synthetic Sentinel PR 14 fixture. The matcher decides which requests this file sees; the body decides what',
  '// happens to them, and that second decision is never read as protection.',
  "import { NextResponse } from 'next/server';",
  '',
  'export function middleware(request) {',
  "  if (request.nextUrl.pathname === '/api/dashboard/open') return NextResponse.next();",
  "  return NextResponse.json({ blocked: 'middleware' }, { status: 403 });",
  '}',
  '',
  config,
].join('\n');

/** The App Router fixture: a root app with middleware, an empty next.config and a lockfile. */
const APP: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'next-fixture', private: true, version: '0.0.0', dependencies: VERSIONS }, null, 2) + '\n',
  'package-lock.json': lock(),
  'next.config.js': "/** @type {import('next').NextConfig} */\nconst nextConfig = {};\nmodule.exports = nextConfig;\n",
  'middleware.ts': middleware(),
  'app/page.tsx': page('home'),
  'app/(marketing)/about/page.tsx': page('about'),
  'app/api/dashboard/secret/route.ts': route('dashboard-secret'),
  'app/api/dashboard/open/route.ts': route('dashboard-open'),
  'app/api/dashboard/[id]/route.ts': route('dashboard-item'),
  'app/api/[section]/route.ts': route('section'),
  'app/api/info/route.ts': route('public-info'),
  'app/_lib/route.ts': route('private'),
  'app/api/hooks/route.tsx': route('tsx-route'),
};

const SURFACE = {
  home: 'web::page::/', about: 'web::page::/about', secret: 'web::route::GET /api/dashboard/secret', open: 'web::route::GET /api/dashboard/open',
  item: 'web::route::GET /api/dashboard/:param', section: 'web::route::GET /api/:param', info: 'web::route::GET /api/info',
  priv: 'web::route::GET /_lib',
};

async function analyzed(t: any, files: Record<string, string>, opts: { properties?: string[] } = {}) {
  const dir = scratch(t, 'sentinel-next-');
  const root = join(dir, 'repo');
  commitRepo(root, files);
  const fx = await openCaptureStore(t, dir);
  const { snapshot } = await captureSnapshot(fx.store, { mode: 'working-copy', sources: [{ sourceId: 'web', repositoryId: 'example/web', root }] });
  unlock(root);
  rmSync(root, { recursive: true, force: true });
  const work = join(dir, 'work');
  mkdirSync(work, { mode: 0o700 });
  const analysis = await parseSnapshot(fx.store, { snapshotId: snapshot.id, workDir: work, selection: SELECT, limits: LIMITS });
  const source = analysis.sources[0]!;
  const result = await analyzeNext({ snapshot, analysis: source, read: id => fx.store.readArtifact(id), ...(opts.properties ? { properties: opts.properties as any } : {}) });
  return { result, snapshot, source, store: fx.store };
}

const byId = (r: any) => Object.fromEntries(r.projects[0].surfaces.map((s: any) => [s.surfaceId, s]));
const facts = (r: any, surface: string) => r.envelopes[0].facts.filter((f: any) => f.surfaceId === surface);
const verdicts = (r: any, surface: string) => [...new Set(facts(r, surface).map((f: any) => f.verdict))];
const frontiers = (r: any) => r.envelopes[0].frontiers.map((f: any) => `${f.reasonCode.split('.').pop()} ${f.scopeId}`).sort();

test('a matcher includes, excludes and partly reaches App Router surfaces, from captured bytes and parser evidence', needsStore, async t => {
  const { result, snapshot } = await analyzed(t, APP);
  assert.equal(result.projects.length, 1);
  const project = result.projects[0]!;
  assert.equal(project.supported, true);
  assert.equal(project.routerBase, '');
  const s = byId(result);
  // Matched: the middleware runs; nothing about its effect is claimed — not even for the body-exempted path.
  for (const k of ['secret', 'open', 'item'] as const) {
    assert.equal(s[SURFACE[k]].applicability, 'matched', k);
    assert.deepEqual(verdicts(result, SURFACE[k]), ['unknown'], k);
    assert.ok(facts(result, SURFACE[k]).every((f: any) => f.reasonCode === 'sentinel.next.reason.effectNotEstablished'));
  }
  // Excluded: the matcher provably never reaches it, so the middleware does not apply for any property.
  for (const k of ['info', 'home', 'about'] as const) {
    assert.equal(s[SURFACE[k]].applicability, 'excluded', k);
    assert.deepEqual(verdicts(result, SURFACE[k]), ['does-not-apply'], k);
  }
  // Partial: a dynamic segment that can take the matched literal value.
  assert.equal(s[SURFACE.section].applicability, 'partial');
  assert.equal(s[SURFACE.section].reasonCode, 'sentinel.next.reason.partialMatch');
  assert.equal(s[SURFACE.section].matchedExample, '/api/dashboard');
  assert.equal(s[SURFACE.section].unmatchedExample, '/api/{segment}');
  assert.equal(s[SURFACE.section].requestPattern, '/api/[section]');
  // The parser placed a private folder as a route; Next serves no request to it, so nothing is claimed.
  assert.equal(s[SURFACE.priv].applicability, 'unknown');
  assert.equal(s[SURFACE.priv].reasonCode, 'sentinel.next.reason.notRoutable');
  // A route.tsx Next serves but the graph has no surface for is a frontier, not an invented node.
  assert.deepEqual(frontiers(result), ['surfaceNotInGraph web:app/api/hooks/route.tsx']);

  const env = result.envelopes[0]!;
  assert.ok(validateEnvelope('controls', env).ok);
  assert.equal(env.framework.version, '14.2.25');
  assert.equal(env.snapshotId, snapshot.id);
  assert.equal(env.facts.length, 8 * 7, 'one fact per surface and property');
  assert.ok(!env.facts.some((f: any) => f.verdict === 'applies'), 'nothing this pack emits is "applies"');
  // No excluded surface is ever marked protected, and every resolved verdict cites the matcher's exact bytes.
  const text = APP['middleware.ts']!;
  for (const f of env.facts.filter((x: any) => x.verdict === 'does-not-apply')) {
    assert.equal(f.evidence.length, 1);
    const e = f.evidence[0];
    assert.equal(e.relativePath, 'middleware.ts');
    assert.equal(Buffer.from(text).subarray(e.span.startByte, e.span.endByte).toString(), MATCHER);
    assert.equal(e.quoteDigest, `sha256:${createHash('sha256').update(MATCHER).digest('hex')}`);
    assert.equal(e.content, snapshot.entries.find((x: any) => x.relativePath === 'middleware.ts').content);
  }
  // Matched facts cite the handler export and the matcher; the parser's broad middleware guard is never consulted.
  const secret = facts(result, SURFACE.secret)[0];
  assert.deepEqual(secret.evidence.map((e: any) => Buffer.from(text).subarray(e.span.startByte, e.span.endByte).toString().split('\n')[0]), ['export function middleware(request) {', MATCHER]);
  assert.ok(!env.facts.some((f: any) => 'controlId' in f));
});

test('changing the matcher changes the covered surfaces, the registration digest and every influence digest it decides', needsStore, async t => {
  const before = await analyzed(t, APP);
  const after = await analyzed(t, { ...APP, 'middleware.ts': middleware("export const config = {\n  matcher: ['/api/:path*'],\n};\n") });
  const a = byId(after.result);
  const b = byId(before.result);
  assert.equal(b[SURFACE.info].applicability, 'excluded');
  assert.equal(a[SURFACE.info].applicability, 'matched', 'the public route is now reached');
  assert.equal(a[SURFACE.section].applicability, 'matched');
  assert.equal(a[SURFACE.home].applicability, 'excluded');
  assert.deepEqual(verdicts(after.result, SURFACE.info), ['unknown']);
  assert.notEqual(after.result.envelopes[0]!.registrationDigest, before.result.envelopes[0]!.registrationDigest);
  for (const id of Object.values(SURFACE)) assert.notEqual(a[id].influenceDigest, b[id].influenceDigest, id);
  assert.equal(after.result.packDigest, before.result.packDigest);
  // The same inputs give the same output; a fresh capture is another snapshot, so only its id differs.
  const again = await analyzed(t, APP);
  const strip = (r: any) => JSON.parse(JSON.stringify(r.projects[0].surfaces).replaceAll(r.snapshotId, 'SNAP'));
  assert.notEqual(again.result.snapshotId, before.result.snapshotId);
  assert.deepEqual(strip(again.result), strip(before.result));
  assert.equal(again.result.envelopes[0]!.registrationDigest, before.result.envelopes[0]!.registrationDigest);
});

test('no matcher means every path; a conditional entry decides nothing; an unsupported entry blocks only what it might reach', needsStore, async t => {
  const all = byId((await analyzed(t, { ...APP, 'middleware.ts': middleware('') })).result);
  for (const id of Object.values(SURFACE).filter(x => x !== SURFACE.priv)) assert.equal(all[id].applicability, 'matched', id);
  const cond = await analyzed(t, { ...APP, 'middleware.ts': middleware(
    "export const config = {\n  matcher: ['/api/dashboard/:path*', { source: '/api/info', has: [{ type: 'header', key: 'x-preview' }] }],\n};\n") });
  const c = byId(cond.result);
  assert.equal(c[SURFACE.info].applicability, 'partial');
  assert.equal(c[SURFACE.info].reasonCode, 'sentinel.next.reason.conditionalMatcher');
  assert.equal(c[SURFACE.secret].applicability, 'matched');
  assert.equal(c[SURFACE.home].applicability, 'excluded');
  const regex = await analyzed(t, { ...APP, 'middleware.ts': middleware(
    "export const config = {\n  matcher: ['/api/dashboard/:path*', '/((?!_next/static|favicon.ico).*)'],\n};\n") });
  const r = byId(regex.result);
  assert.equal(r[SURFACE.secret].applicability, 'matched', 'a supported entry still proves its own reach');
  assert.equal(r[SURFACE.info].applicability, 'unknown', 'the regex entry might reach it');
  assert.equal(r[SURFACE.info].reasonCode, 'sentinel.next.reason.matcherUnsupported');
  assert.ok(!regex.result.envelopes[0]!.facts.some((f: any) => f.verdict !== 'unknown'));
});

test('a dynamic matcher, another version, a missing lockfile or a non-empty next.config leaves every fact unknown', needsStore, async t => {
  const reasonOf = (r: any) => [...new Set(r.envelopes[0].facts.map((f: any) => `${f.verdict} ${f.reasonCode}`))];
  const dynamic = await analyzed(t, { ...APP, 'middleware.ts': middleware("const paths = ['/api/dashboard/:path*'];\nexport const config = { matcher: paths };\n") });
  assert.deepEqual(reasonOf(dynamic.result), ['unknown sentinel.next.reason.matcherDynamic']);
  const asConst = await analyzed(t, { ...APP, 'middleware.ts': middleware(`export const config = { matcher: ${MATCHER} as const };\n`) });
  assert.deepEqual(reasonOf(asConst.result), ['unknown sentinel.next.reason.matcherDynamic']);

  const newer = await analyzed(t, { ...APP, 'package-lock.json': lock({ ...VERSIONS, next: '14.2.26' }),
    'package.json': JSON.stringify({ name: 'next-fixture', dependencies: { ...VERSIONS, next: '14.2.26' } }) });
  assert.deepEqual(reasonOf(newer.result), ['unknown sentinel.next.reason.versionUnsupported']);
  assert.equal(newer.result.envelopes[0]!.framework.version, '14.2.26', 'the resolved version is recorded, not hidden');
  assert.equal(newer.result.projects[0]!.supported, false);

  const older = { ...VERSIONS, react: '18.2.0', 'react-dom': '18.2.0' };
  const react = await analyzed(t, { ...APP, 'package-lock.json': lock(older), 'package.json': JSON.stringify({ name: 'next-fixture', dependencies: older }) });
  assert.deepEqual(reasonOf(react.result), ['unknown sentinel.next.reason.versionUnsupported']);

  const { 'package-lock.json': _lock, ...noLock } = APP;
  void _lock;
  const declared = await analyzed(t, noLock);
  assert.deepEqual(reasonOf(declared.result), ['unknown sentinel.next.reason.versionUnknown']);
  assert.equal(declared.result.envelopes[0]!.framework.version, null, 'an exact package.json pin is a declaration, not what was installed');
  assert.equal((declared.result.projects[0]!.versions.next as any).reason, 'no-lockfile');

  const stale = await analyzed(t, { ...APP, 'package.json': JSON.stringify({ name: 'next-fixture', dependencies: { ...VERSIONS, next: '14.2.20' } }) });
  assert.deepEqual(reasonOf(stale.result), ['unknown sentinel.next.reason.versionUnknown']);

  // Review regressions over real captures: a literal null lockfile, and a local tarball claiming the supported version.
  const nullLock = await analyzed(t, { ...APP, 'package-lock.json': 'null\n' });
  assert.deepEqual(reasonOf(nullLock.result), ['unknown sentinel.next.reason.versionUnknown']);
  assert.equal((nullLock.result.projects[0]!.versions.next as any).reason, 'lockfile-invalid');
  const local = await analyzed(t, { ...APP,
    'package.json': JSON.stringify({ name: 'next-fixture', dependencies: { ...VERSIONS, next: 'file:vendor/next-custom.tgz' } }),
    'package-lock.json': npmLock(VERSIONS, { 'node_modules/next': { version: '14.2.25', resolved: 'file:vendor/next-custom.tgz' } }) });
  assert.deepEqual(reasonOf(local.result), ['unknown sentinel.next.reason.versionUnknown']);
  assert.equal(local.result.envelopes[0]!.framework.version, null, 'a local package\u2019s version string is not trusted');
  assert.equal((local.result.projects[0]!.versions.next as any).reason, 'not-registry');
  const repacked = await analyzed(t, { ...APP, 'package-lock.json': npmLock(VERSIONS, { 'node_modules/next': { ...registryEntry('next', '14.2.25'), integrity: integrityOf('next', 'repacked') } }) });
  assert.deepEqual(reasonOf(repacked.result), ['unknown sentinel.next.reason.versionUnknown']);
  assert.equal((repacked.result.projects[0]!.versions.next as any).reason, 'identity-mismatch');
  assert.equal(repacked.result.projects[0]!.supported, false);

  const based = await analyzed(t, { ...APP, 'next.config.js': "module.exports = { basePath: '/app' };\n" });
  assert.deepEqual(reasonOf(based.result), ['unknown sentinel.next.reason.nextConfigUnsupported']);
  const nodeRuntime = await analyzed(t, { ...APP, 'middleware.ts': middleware(`export const config = { matcher: ${MATCHER}, runtime: 'nodejs' };\n`) });
  assert.deepEqual(reasonOf(nodeRuntime.result), ['unknown sentinel.next.reason.runtimeUnsupported']);
  const broken = await analyzed(t, { ...APP, 'middleware.ts': 'export function middleware( {\n' });
  assert.deepEqual(reasonOf(broken.result), ['unknown sentinel.next.reason.middlewareUnresolved']);
  assert.equal((broken.result.projects[0]!.middleware!.read as any).reason, 'not-parsed', 'the parser\'s own outcome for the file is required');
});

test('middleware placement, src/ layouts, no middleware and the pages router', needsStore, async t => {
  // Middleware beside src/app is loaded; the same file at the project root is not, and is named as such.
  const src: Record<string, string> = {};
  for (const [p, v] of Object.entries(APP)) src[p.startsWith('app/') || p === 'middleware.ts' ? `src/${p}` : p] = v;
  src['middleware.js'] = 'export default function stray() {}\n';
  const s = await analyzed(t, src);
  const proj = s.result.projects[0]!;
  assert.equal(proj.routerBase, 'src');
  assert.equal(proj.middleware!.relativePath, 'src/middleware.ts');
  assert.equal(byId(s.result)[SURFACE.info].applicability, 'excluded');
  assert.ok(frontiers(s.result).includes('misplacedMiddleware web:middleware.js'));

  // Only a misplaced middleware: Next runs none, so there is no middleware fact to give.
  const { 'middleware.ts': _m, ...noMw } = APP;
  void _m;
  const none = await analyzed(t, { ...noMw, 'app/middleware.ts': middleware() });
  assert.ok(none.result.projects[0]!.surfaces.every(x => x.applicability === 'no-middleware'));
  assert.deepEqual(none.result.envelopes[0]!.facts, []);
  assert.ok(frontiers(none.result).includes('misplacedMiddleware web:app/middleware.ts'));

  const pages = await analyzed(t, { ...APP, 'pages/legacy.js': 'export default function Legacy() { return null; }\n' });
  assert.ok(frontiers(pages.result).includes('pagesRouter web:pages'));
  assert.equal(byId(pages.result)[SURFACE.info].applicability, 'excluded', 'the app router is still decided');

  const two = await analyzed(t, { ...APP, 'middleware.js': 'export default function m() {}\n' });
  assert.deepEqual([...new Set(two.result.envelopes[0]!.facts.map((f: any) => f.reasonCode))], ['sentinel.next.reason.middlewareUnresolved']);
});

test('a monorepo: each project is decided on its own versions, middleware and surfaces, through a pnpm lockfile', needsStore, async t => {
  const pnpm = pnpmLock;
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'mono', private: true }) + '\n',
    'pnpm-lock.yaml': pnpm({ 'apps/web': '14.2.25', 'apps/old': '13.5.6' }),
    'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: VERSIONS }) + '\n',
    'apps/web/middleware.ts': middleware("export const config = { matcher: '/admin/:path*' };\n"),
    'apps/web/app/admin/route.ts': route('admin'),
    'apps/web/app/shop/page.tsx': page('shop'),
    'apps/old/package.json': JSON.stringify({ name: 'old', dependencies: { ...VERSIONS, next: '13.5.6' } }) + '\n',
    'apps/old/middleware.ts': middleware(''),
    'apps/old/app/legacy/route.ts': route('legacy'),
  };
  const { result } = await analyzed(t, files);
  assert.deepEqual(result.projects.map(p => [p.projectDir, p.supported]), [['apps/old', false], ['apps/web', true]]);
  const web = result.projects.find(p => p.projectDir === 'apps/web')!;
  assert.deepEqual(Object.fromEntries(web.surfaces.map(s => [s.relativePath, s.applicability])),
    { 'apps/web/app/admin/route.ts': 'matched', 'apps/web/app/shop/page.tsx': 'excluded' });
  const old = result.projects.find(p => p.projectDir === 'apps/old')!;
  assert.deepEqual(old.surfaces.map(s => s.reasonCode), ['sentinel.next.reason.versionUnsupported']);
  assert.equal(result.envelopes.length, 2);
  for (const e of result.envelopes) assert.ok(validateEnvelope('controls', e).ok);
  assert.deepEqual(result.envelopes.map(e => e.framework.version).sort(), ['13.5.6', '14.2.25']);
});

test('properties narrow the facts; inconsistent inputs and altered bytes are refused', needsStore, async t => {
  const { result, snapshot, source, store } = await analyzed(t, APP, { properties: ['authentication', 'authorization'] });
  assert.deepEqual([...new Set(result.envelopes[0]!.facts.map((f: any) => f.property))].sort(), ['authentication', 'authorization']);
  const read = (id: string) => store.readArtifact(id);
  await assert.rejects(analyzeNext({ snapshot: { ...snapshot, id: 'other-snapshot' } as any, analysis: source, read }), (e: any) => e instanceof NextPackError && e.code === 'sentinel.next.invalidInput');
  await assert.rejects(analyzeNext({ snapshot, analysis: { ...source, sourceId: 'api' } as any, read }), (e: any) => e.code === 'sentinel.next.invalidInput');
  await assert.rejects(analyzeNext({ snapshot, analysis: source, read, properties: ['everything' as any] }), (e: any) => e.code === 'sentinel.next.invalidInput');
  const tampered = async (id: string) => { const b = Buffer.from(await store.readArtifact(id)); b[0] = b[0]! ^ 1; return b; };
  await assert.rejects(analyzeNext({ snapshot, analysis: source, read: tampered }), (e: any) => e.code === 'sentinel.next.integrity');
});


test('captured pnpm patch evidence leaves matcher exclusions unknown, while ordinary peer suffixes qualify', needsStore, async t => {
  const files = { ...APP, 'pnpm-lock.yaml': pnpmLock({ '.': '14.2.25' }) };
  delete (files as Record<string, string>)['package-lock.json'];
  const plain = await analyzed(t, files);
  assert.equal(plain.result.projects[0]!.supported, true);
  assert.deepEqual(verdicts(plain.result, SURFACE.info), ['does-not-apply']);
  const patch = 'diff --git a/package.json b/package.json\n--- a/package.json\n+++ b/package.json\n@@ -1 +1 @@\n-{}\n+{ "sentinelFixturePatch": true }\n';
  const patchMap = 'patchedDependencies:\n  next@14.2.25:\n    path: patches/next.patch\n    hash: synthetic-patch\n\n';
  for (const evidence of ['lock-map', 'importer-suffix', 'manifest', 'all'] as const) {
    let lock = files['pnpm-lock.yaml'];
    if (evidence === 'lock-map' || evidence === 'all') lock = lock.replace('importers:', patchMap + 'importers:');
    if (evidence === 'importer-suffix' || evidence === 'all') lock = lock.replace('version: 14.2.25(', 'version: 14.2.25(patch_hash=synthetic-patch)(');
    const packageJson = { name: 'next-fixture', private: true, version: '0.0.0', dependencies: VERSIONS,
      ...(evidence === 'manifest' || evidence === 'all' ? { pnpm: { patchedDependencies: { 'next@14.2.25': 'patches/next.patch' } } } : {}) };
    const { result } = await analyzed(t, { ...files, 'package.json': JSON.stringify(packageJson), 'pnpm-lock.yaml': lock, 'patches/next.patch': patch });
    assert.equal(result.projects[0]!.supported, false, evidence);
    assert.deepEqual(verdicts(result, SURFACE.info), ['unknown'], evidence);
    assert.ok(facts(result, SURFACE.info).every((f: any) => f.reasonCode === 'sentinel.next.reason.versionUnknown'), evidence);
  }
});


test('captured workspace-root patch declarations bind nested Next analysis', needsStore, async t => {
  const nested = Object.fromEntries(Object.entries(APP).filter(([p]) => p !== 'package-lock.json').map(([p, text]) => [`apps/web/${p}`, text]));
  const files = { ...nested, 'package.json': JSON.stringify({ name: 'workspace', private: true }), 'pnpm-lock.yaml': pnpmLock({ 'apps/web': '14.2.25' }) };
  const before = await analyzed(t, files);
  assert.equal(before.result.projects[0]!.supported, true);
  assert.deepEqual(verdicts(before.result, SURFACE.info), ['does-not-apply']);
  const root = JSON.stringify({ name: 'workspace', private: true, pnpm: { patchedDependencies: { 'next@14.2.25': 'patches/next.patch' } } });
  const after = await analyzed(t, { ...files, 'package.json': root, 'patches/next.patch': '# Original inert fixture patch evidence\n' });
  assert.equal(after.result.projects[0]!.supported, false);
  assert.deepEqual(verdicts(after.result, SURFACE.info), ['unknown']);
  assert.notEqual(before.result.envelopes[0]!.registrationDigest, after.result.envelopes[0]!.registrationDigest);
});


for (const depth of [1, 4, 8]) {
  test(`captured pnpm patch maps at indentation ${depth} cannot borrow registry identity`, needsStore, async t => {
    const pad = ' '.repeat(depth);
    const patchMap = (target: string) => `patchedDependencies:
${pad}# Original inert fixture: an unrelated patch precedes the selected package.
${pad}'left-pad@1.0.0':
${pad}  path: patches/unrelated.patch
${pad}  hash: unrelated-fixture
${pad}'${target}':
${pad}  path: patches/target.patch
${pad}  hash: target-fixture

`;
    const files = { ...APP, 'pnpm-lock.yaml': pnpmLock({ '.': '14.2.25' }),
      'patches/unrelated.patch': '# Original inert unrelated patch\n', 'patches/target.patch': '# Original inert target patch\n' };
    delete (files as Record<string, string>)['package-lock.json'];
    const changed = await analyzed(t, { ...files,
      'pnpm-lock.yaml': files['pnpm-lock.yaml'].replace('importers:', patchMap('next@14.2.25') + 'importers:') });
    assert.equal(changed.result.projects[0]!.supported, false);
    assert.deepEqual(verdicts(changed.result, SURFACE.info), ['unknown']);
    assert.ok(facts(changed.result, SURFACE.info).every((f: any) => f.reasonCode === 'sentinel.next.reason.versionUnknown'));
    // Same valid map shape and ordinary peer suffixes, but no relevant modified package: exclusions still decide.
    const unrelated = await analyzed(t, { ...files,
      'pnpm-lock.yaml': files['pnpm-lock.yaml'].replace('importers:', patchMap('@fixture/other@1.0.0') + 'importers:') });
    assert.equal(unrelated.result.projects[0]!.supported, true);
    assert.deepEqual(verdicts(unrelated.result, SURFACE.info), ['does-not-apply']);
  });
}


for (const [label, patchMap] of [
  ['before the first entry', `patchedDependencies:
# Original inert comment at column zero does not end a YAML mapping.
    next@14.2.25:
        path: patches/next.patch
        hash: next-fixture

`],
  ['between patch entries', `patchedDependencies:
    left-pad@1.0.0:
        path: patches/unrelated.patch
        hash: unrelated-fixture
# Original inert comment at column zero does not end a YAML mapping.
    next@14.2.25:
        path: patches/next.patch
        hash: next-fixture

`],
] as const) {
  test(`captured pnpm patch comments ${label} cannot hide relevant entries`, needsStore, async t => {
    const files = { ...APP, 'pnpm-lock.yaml': pnpmLock({ '.': '14.2.25' }).replace('importers:', patchMap + 'importers:'),
      'patches/next.patch': '# Original inert Next patch\n', 'patches/unrelated.patch': '# Original inert unrelated patch\n' };
    delete (files as Record<string, string>)['package-lock.json'];
    const { result } = await analyzed(t, files);
    assert.deepEqual({ supported: result.projects[0]!.supported, verdicts: verdicts(result, SURFACE.info) },
      { supported: false, verdicts: ['unknown'] });
  });
}

test('captured pnpm patch comments alone are not an explicit empty patch map', needsStore, async t => {
  const files = { ...APP, 'pnpm-lock.yaml': pnpmLock({ '.': '14.2.25' }) };
  delete (files as Record<string, string>)['package-lock.json'];
  const empty = await analyzed(t, { ...files,
    'pnpm-lock.yaml': files['pnpm-lock.yaml'].replace('importers:', 'patchedDependencies: {}\n# Original inert comment\nimporters:') });
  assert.equal(empty.result.projects[0]!.supported, true);
  assert.deepEqual(verdicts(empty.result, SURFACE.info), ['does-not-apply']);
  const nullMap = await analyzed(t, { ...files,
    'pnpm-lock.yaml': files['pnpm-lock.yaml'].replace('importers:', 'patchedDependencies:\n# Original inert comment\n\nimporters:') });
  assert.deepEqual({ supported: nullMap.result.projects[0]!.supported, verdicts: verdicts(nullMap.result, SURFACE.info) },
    { supported: false, verdicts: ['unknown'] });
});


for (const [label, property] of [
  ['single-quoted key', "'patched'"],
  ['double-quoted key', '"patched"'],
  ['escaped key', '"p' + '\\u0061' + 'tched"'],
] as const) {
  test('captured pnpm modification metadata ' + label + ' cannot borrow registry identity', needsStore, async t => {
    const text = pnpmLock({ '.': '14.2.25' }).replace('  next@14.2.25:\n', '  next@14.2.25:\n    ' + property + ': true\n');
    const files = { ...APP, 'pnpm-lock.yaml': text };
    delete (files as Record<string, string>)['package-lock.json'];
    const { result } = await analyzed(t, files);
    assert.deepEqual({ supported: result.projects[0]!.supported, verdicts: verdicts(result, SURFACE.info) },
      { supported: false, verdicts: ['unknown'] });
  });
}

test('captured pnpm ordinary quoted metadata retains the measured package identity', needsStore, async t => {
  const metadata = ["    'engines': {node: '>=16'}", '    "hasBin": true', ''].join('\n');
  const text = pnpmLock({ '.': '14.2.25' }).replace('  next@14.2.25:\n', '  next@14.2.25:\n' + metadata);
  const files = { ...APP, 'pnpm-lock.yaml': text };
  delete (files as Record<string, string>)['package-lock.json'];
  const { result } = await analyzed(t, files);
  assert.equal(result.projects[0]!.supported, true);
  assert.deepEqual(verdicts(result, SURFACE.info), ['does-not-apply']);
});


test('captured pnpm tagged root patch key cannot hide modifications', needsStore, async t => {
  const patch = '!!str patchedDependencies:\n  next@14.2.25:\n    path: patches/next.patch\n    hash: fixture\n\n';
  const files = { ...APP, 'pnpm-lock.yaml': pnpmLock({ '.': '14.2.25' }).replace('importers:', patch + 'importers:'),
    'patches/next.patch': '# Original inert tagged-key patch\n' };
  delete (files as Record<string, string>)['package-lock.json'];
  const { result } = await analyzed(t, files);
  assert.deepEqual({ supported: result.projects[0]!.supported, verdicts: verdicts(result, SURFACE.info) },
    { supported: false, verdicts: ['unknown'] });
});

test('captured pnpm ordinary safe root config and unrelated patches retain peer identity', needsStore, async t => {
  const extras = ['safeConfig: {}', "'safeQuotedConfig': {}", '"safeDoubleConfig": []',
    'patchedDependencies:', '  unrelated@1.0.0:', '    path: patches/other.patch', '    hash: fixture', ''].join('\n');
  const files = { ...APP, 'pnpm-lock.yaml': pnpmLock({ '.': '14.2.25' }).replace('importers:', extras + 'importers:'),
    'patches/other.patch': '# Original inert unrelated patch\n' };
  delete (files as Record<string, string>)['package-lock.json'];
  const { result } = await analyzed(t, files);
  assert.equal(result.projects[0]!.supported, true);
  assert.deepEqual(verdicts(result, SURFACE.info), ['does-not-apply']);
});
