// PR 14: the Next pack's pure parts — matcher sources, App Router folder forms, the automaton decision, the static
// reads of middleware and next.config, and lockfile version resolution. Original synthetic inputs only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMatcherSource,
  routeLanguage,
  decide,
  decideCaseStable,
  readMiddleware,
  readNextConfig,
  resolveVersions,
  NEXT_SUPPORT,
  NEXT_PACK_DIGEST,
  NEXT_REASON_CODES,
  NEXT_ERROR_CODES,
} from '../dist/frameworks/next/index.js';
import { integrityOf, npmLock, pnpmLock, registryEntry } from './next-helpers.ts';

const lang = (s: string) => {
  const p = parseMatcherSource(s);
  assert.ok(p.ok, s);
  return p.language;
};
const route = (path: string) => {
  const r = routeLanguage(path.split('/').filter(Boolean));
  assert.ok(r.ok, path);
  return r.items;
};
const cov = (r: string, ...m: string[]) => decide(route(r), m.flatMap(lang)).coverage;

test('the supported source subset is whole-segment literals and parameters', () => {
  for (const s of ['/api', '/api/:path*', '/api/:id', '/api/:id?', '/api/:rest+', '/a.b/c-d/~e_f', '/'])
    assert.equal(parseMatcherSource(s).ok, true, s);
  const reason = (s: string) => {
    const p = parseMatcherSource(s);
    assert.equal(p.ok, false, s);
    return (p as { reason: string }).reason;
  };
  // Custom regular-expression groups (the common negative look-ahead form included), brace groups, escapes,
  // partial-segment parameters, a trailing slash and encoded characters are outside the subset.
  for (const s of [
    '/((?!api|_next/static).*)',
    '/api/:id(\\d+)',
    '/api{/:x}?',
    '/a\\:b',
    '/file.:ext',
    '/api/',
    '/caf%C3%A9',
    '/café',
    '/a//b',
  ]) {
    assert.equal(reason(s), 'unsupported', s);
  }
  for (const s of ['api', '/api/*', '/:']) assert.equal(reason(s), 'invalid', s);
  assert.equal(reason('/' + 'a'.repeat(2000)), 'unsupported', 'longer than the subset reads');
});

test('App Router folders: groups and slots vanish, dynamic forms keep their arity, private folders are not routable', () => {
  assert.deepEqual(routeLanguage(['(shop)', '@modal', 'cart']), {
    ok: true,
    items: [{ t: 'lit', s: 'cart' }],
    display: '/cart',
  });
  assert.deepEqual(routeLanguage(['blog', '[slug]']), {
    ok: true,
    items: [{ t: 'lit', s: 'blog' }, { t: 'one' }],
    display: '/blog/[slug]',
  });
  assert.deepEqual(routeLanguage(['docs', '[...p]']).ok && routeLanguage(['docs', '[...p]']), {
    ok: true,
    items: [{ t: 'lit', s: 'docs' }, { t: 'one' }, { t: 'star' }],
    display: '/docs/[...p]',
  });
  assert.deepEqual(routeLanguage(['[[...p]]']), { ok: true, items: [{ t: 'star' }], display: '/[[...p]]' });
  assert.deepEqual(routeLanguage([]), { ok: true, items: [], display: '/' });
  assert.equal((routeLanguage(['_lib']) as { reason: string }).reason, 'not-routable');
  for (const f of [['(.)photo'], ['(..)photo'], ['(...)photo'], ['[...a]', 'b'], ['%5Fx'], ['x.json']]) {
    assert.equal((routeLanguage(f) as { reason: string }).reason, 'unsupported', f.join('/'));
  }
});

test('the decision is exact over every request path a route serves', () => {
  assert.equal(cov('/api/dashboard/secret', '/api/dashboard/:path*'), 'all');
  assert.equal(cov('/api/dashboard', '/api/dashboard/:path*'), 'all', ':path* matches zero segments');
  assert.equal(cov('/api/dashboard', '/api/dashboard/:path+'), 'none');
  assert.equal(cov('/api/info', '/api/dashboard/:path*'), 'none');
  assert.equal(cov('/api/dashboard/[id]', '/api/dashboard/:id'), 'all');
  assert.equal(cov('/api/[section]', '/api/dashboard/:path*'), 'some', 'a dynamic segment can take the literal value');
  assert.equal(cov('/api/[section]', '/api/:s', '/api/dashboard/:path*'), 'all', 'entries are a union');
  assert.equal(cov('/docs/[...p]', '/docs/:p'), 'some', 'a catch-all reaches deeper than one parameter');
  assert.equal(cov('/docs/[...p]', '/docs/:p+'), 'all');
  assert.equal(cov('/docs/[[...p]]', '/docs/:p+'), 'some', '/docs itself is not matched by :p+');
  assert.equal(cov('/docs/[[...p]]', '/docs/:p*'), 'all');
  assert.equal(cov('/a/[x]', '/a/:x?'), 'all');
  assert.equal(cov('/a', '/a/:x?'), 'all');
  // Next's root source also matches /index.
  assert.equal(cov('/', '/'), 'all');
  assert.equal(cov('/index', '/'), 'all');
  assert.equal(cov('/about', '/'), 'none');
  assert.equal(decide(route('/x'), []).coverage, 'none', 'an empty language matches nothing');
  const d = decide(route('/api/[section]'), lang('/api/dashboard/:path*'));
  assert.deepEqual([d.matchedExample, d.unmatchedExample], ['/api/dashboard', '/api/{segment}']);
});

test('a decision that letter case could change is ambiguous, never answered', () => {
  const r = decideCaseStable(route('/API/x'), lang('/api/:p*'));
  assert.equal(r.caseAmbiguous, true);
  assert.equal(decideCaseStable(route('/api/x'), lang('/api/:p*')).caseAmbiguous, false);
});

const bytes = (s: string) => Buffer.from(s, 'utf8');

test('middleware: the handler and a literal config are read with exact UTF-8 spans', async () => {
  const src =
    "// ünïcode 😀 first, so byte and character offsets differ\nimport { NextResponse } from 'next/server';\n" +
    'export function middleware() { return NextResponse.next(); }\n' +
    "export const config = { matcher: ['/api/:path*', { source: '/admin', has: [{ type: 'header', key: 'x-a' }] }, { source: '/b', locale: false }] };\n";
  const r = await readMiddleware('middleware.ts', bytes(src));
  assert.ok(r.ok);
  assert.equal(r.exportName, 'middleware');
  const slice = (s: { startByte: number; endByte: number }) =>
    bytes(src).subarray(s.startByte, s.endByte).toString('utf8');
  assert.match(slice(r.exportSpan), /^export function middleware\(\)/);
  assert.equal(r.config.state, 'static');
  if (r.config.state !== 'static' || !r.config.matcher) throw new Error('static');
  assert.equal(
    slice(r.config.matcher.span),
    "['/api/:path*', { source: '/admin', has: [{ type: 'header', key: 'x-a' }] }, { source: '/b', locale: false }]",
  );
  assert.deepEqual(
    r.config.matcher.entries.map((e) => [e.source, e.conditional, e.invalid ?? null]),
    [
      ['/api/:path*', false, null],
      ['/admin', true, null],
      ['/b', false, null],
    ],
  );
  assert.equal(slice(r.config.matcher.entries[0]!.span), "'/api/:path*'");
});

test('middleware: anything Next would compute, or syntax not verified, is dynamic; missing handlers are named', async () => {
  const state = async (src: string) => {
    const r = await readMiddleware('middleware.ts', bytes(src));
    return r.ok ? r.config.state : r.reason;
  };
  const h = 'export default function m() {}\n';
  assert.equal(await state(h), 'absent');
  assert.equal(await state(`${h}export const config = {};`), 'static');
  assert.equal(await state(`${h}const p = ['/a'];\nexport const config = { matcher: p };`), 'dynamic');
  assert.equal(await state(`${h}export const config = { matcher: ['/a'] as const };`), 'dynamic');
  assert.equal(await state(`${h}export const config = { matcher: [\`/a/\${'b'}\`] };`), 'dynamic');
  assert.equal(await state(`${h}export const config = { ...base };`), 'dynamic');
  assert.equal(await state(`${h}export let config = { matcher: '/a' };`), 'dynamic');
  assert.equal(await state(`${h}const config = { matcher: '/a' };\nexport { config };`), 'dynamic');
  assert.equal(await state(`${h}export * from './shared';`), 'dynamic');
  assert.equal(await state(`${h}export const config = { matcher: [] };`), 'invalid');
  assert.equal(await state(`${h}export const config = { matcher: '/a', other: 1 };`), 'invalid');
  assert.equal(await state(`${h}export const config = { matcher: '/a', runtime: 'nodejs' };`), 'runtime-unsupported');
  assert.equal(await state(`${h}export const config = { matcher: '/a', runtime: 'edge' };`), 'static');
  assert.equal(
    await state(`export { default } from 'some-auth/middleware';\nexport const config = { matcher: '/a' };`),
    'static',
  );
  assert.equal(await state(`export const config = { matcher: '/a' };`), 'no-export');
  assert.equal(await state(`export * from './mw';`), 'export-ambiguous');
  assert.equal(await state(`export function middleware( {`), 'parse-failed');
  assert.equal((await readMiddleware('middleware.ts', Buffer.from([0xff, 0xfe]))).ok, false);
  const r = await readMiddleware(
    'middleware.ts',
    bytes(`${h}export const config = { matcher: [{ source: '/a', regexp: '.*' }, 42] };`),
  );
  assert.ok(r.ok && r.config.state === 'static' && r.config.matcher);
  if (r.ok && r.config.state === 'static' && r.config.matcher)
    assert.deepEqual(
      r.config.matcher.entries.map((e) => !!e.invalid),
      [true, true],
    );
});

test('next.config: only a statically empty object is supported', async () => {
  const state = async (src: string, file = 'next.config.js') => (await readNextConfig(file, bytes(src))).state;
  assert.equal(
    await state(
      "// c\n/** @type {import('next').NextConfig} */\nconst nextConfig = {};\nmodule.exports = nextConfig;\n",
    ),
    'empty',
  );
  assert.equal(await state("'use strict';\nmodule.exports = {};\n"), 'empty');
  assert.equal(await state('export default {};\n', 'next.config.mjs'), 'empty');
  assert.equal(await state("module.exports = { basePath: '/docs' };\n"), 'unsupported');
  assert.equal(await state("const c = {};\nc.basePath = '/x';\nmodule.exports = c;\n"), 'unsupported');
  assert.equal(await state("module.exports = require('./base');\n"), 'unsupported');
  assert.equal(await state(''), 'unsupported', 'no export');
});

const lockfile = (pkgs: Record<string, string>, extra: Record<string, unknown> = {}) => npmLock(pkgs, extra);
const OK = { next: '14.2.25', react: '18.3.1', 'react-dom': '18.3.1' };

async function versions(files: Record<string, string>, projectDir = '', pkgJson: Record<string, unknown> = {}) {
  const map = new Map(
    Object.entries(files).map(([p, t]) => [p, { relativePath: p, content: `c:${p}`, bytes: Buffer.byteLength(t) }]),
  );
  return resolveVersions({
    projectDir,
    files: map,
    recorded: new Set(Object.keys(files)),
    packageJson: pkgJson,
    pins: NEXT_SUPPORT.packages,
    read: async (f) => bytes(files[f.relativePath]!),
  });
}

test('versions come from lockfiles only, with the bytes that record them', async () => {
  const text = lockfile(OK);
  const v = await versions({ 'package-lock.json': text });
  assert.deepEqual([v.next.state, v.react.state, v['react-dom'].state], ['resolved', 'resolved', 'resolved']);
  if (v.next.state !== 'resolved') throw new Error();
  assert.equal(v.next.version, '14.2.25');
  assert.ok(v.next.span);
  assert.match(
    bytes(text).subarray(v.next.span!.startByte, v.next.span!.endByte).toString(),
    /^"node_modules\/next": \{\s+"version": "14.2.25"$/,
  );
  // A nested project resolves through its own node_modules first, then the lockfile folder's.
  const nested = lockfile(OK, {
    'apps/web': { name: 'web' },
    'apps/web/node_modules/next': registryEntry('next', '14.2.24'),
  });
  const w = await versions({ 'package-lock.json': nested }, 'apps/web');
  assert.equal(w.next.state === 'resolved' && w.next.version, '14.2.24');
  assert.equal(w.react.state === 'resolved' && w.react.version, '18.3.1');
});

test('a declaration, an unsupported or ambiguous lockfile, or a stale pin is unknown', async () => {
  const reason = (v: Awaited<ReturnType<typeof versions>>) => (v.next as { reason?: string }).reason;
  assert.equal(reason(await versions({ 'package.json': '{}' }, '', { dependencies: OK })), 'no-lockfile');
  assert.equal(reason(await versions({ 'yarn.lock': '# yarn' })), 'lockfile-unsupported');
  assert.equal(
    reason(await versions({ 'package-lock.json': lockfile(OK), 'pnpm-lock.yaml': "lockfileVersion: '9.0'\n" })),
    'lockfile-ambiguous',
  );
  assert.equal(
    reason(await versions({ 'package-lock.json': JSON.stringify({ lockfileVersion: 1, dependencies: {} }) })),
    'lockfile-unsupported',
  );
  assert.equal(reason(await versions({ 'package-lock.json': '{' })), 'lockfile-invalid');
  assert.equal(reason(await versions({ 'package-lock.json': lockfile({ react: '18.3.1' }) })), 'not-in-lockfile');
  assert.equal(
    reason(await versions({ 'package-lock.json': lockfile(OK) }, '', { dependencies: { next: '14.2.26' } })),
    'pin-disagrees',
  );
  const linked = JSON.stringify({
    lockfileVersion: 3,
    packages: { '': {}, 'node_modules/next': { resolved: '../next', link: true } },
  });
  assert.equal(reason(await versions({ 'package-lock.json': linked })), 'not-registry');
});

test('untrusted lockfile JSON of any shape is invalid, never a crash', async () => {
  const reason = (v: Awaited<ReturnType<typeof versions>>) => (v.next as { reason?: string }).reason;
  for (const text of [
    'null',
    '[]',
    '"x"',
    '42',
    'true',
    '{"lockfileVersion":3}',
    '{"lockfileVersion":3,"packages":null}',
    '{"lockfileVersion":3,"packages":[]}',
    '{"lockfileVersion":3,"packages":{"":{},"node_modules/next":null}}',
    '{"lockfileVersion":3,"packages":{"":{},"node_modules/next":"14.2.25"}}',
    '{"lockfileVersion":3,"packages":{"":{},"node_modules/next":{"version":14}}}',
    '{"lockfileVersion":3,"packages":{"":null}}',
  ]) {
    const v = await versions({ 'package-lock.json': text });
    assert.equal(v.next.state, 'unknown', text);
    assert.ok(
      ['lockfile-invalid', 'lockfile-unsupported', 'not-in-lockfile', 'not-exact'].includes(reason(v)!),
      `${text}: ${reason(v)}`,
    );
  }
  assert.equal(reason(await versions({ 'package-lock.json': 'null' })), 'lockfile-invalid');
  // A package.json whose dependency fields are not objects, or whose spec is not text, is a non-registry declaration.
  assert.equal(
    reason(await versions({ 'package-lock.json': lockfile(OK) }, '', { dependencies: ['next'] })),
    'declared-nonregistry',
  );
  assert.equal(
    reason(
      await versions({ 'package-lock.json': lockfile(OK) }, '', { dependencies: { next: { version: '14.2.25' } } }),
    ),
    'declared-nonregistry',
  );
});

test('the version string alone never qualifies: local, linked, Git, mirrored, unhashed and repacked packages are unknown', async () => {
  const reason = (v: Awaited<ReturnType<typeof versions>>) => (v.next as { reason?: string }).reason;
  const withNext = (entry: Record<string, unknown>, pkgJson: Record<string, unknown> = {}) =>
    versions({ 'package-lock.json': lockfile(OK, { 'node_modules/next': entry }) }, '', pkgJson);
  const good = registryEntry('next', '14.2.25');
  assert.equal(
    reason(await withNext({ version: '14.2.25', resolved: 'file:vendor/next-custom.tgz', integrity: good.integrity })),
    'not-registry',
  );
  assert.equal(reason(await withNext({ ...good, resolved: 'git+ssh://git@example.com/next.git#abc' })), 'not-registry');
  assert.equal(
    reason(await withNext({ ...good, resolved: 'https://registry.example.com/next/-/next-14.2.25.tgz' })),
    'not-registry',
  );
  assert.equal(
    reason(await withNext({ ...good, resolved: 'https://registry.npmjs.org/next/-/next-14.2.24.tgz' })),
    'not-registry',
    'the tarball names another version',
  );
  assert.equal(reason(await withNext({ version: '14.2.25', resolved: good.resolved })), 'no-integrity');
  assert.equal(reason(await withNext({ ...good, integrity: 'sha1-abc' })), 'no-integrity');
  assert.equal(
    reason(await withNext({ ...good, integrity: integrityOf('next', 'repacked') })),
    'identity-mismatch',
    'same version, other bytes',
  );
  // The case the review found: a local tarball in the lock and a file: spec in package.json.
  assert.equal(
    reason(
      await withNext(
        { version: '14.2.25', resolved: 'file:vendor/next-custom.tgz' },
        { dependencies: { next: 'file:vendor/next-custom.tgz' } },
      ),
    ),
    'not-registry',
  );
  for (const spec of [
    'file:vendor/next.tgz',
    'link:../next',
    'git+https://example.com/next.git',
    'https://example.com/next.tgz',
    'npm:other@14.2.25',
    'workspace:*',
    'example/next',
  ]) {
    assert.equal(
      reason(await versions({ 'package-lock.json': lockfile(OK) }, '', { dependencies: { next: spec } })),
      'declared-nonregistry',
      spec,
    );
  }
  assert.equal(
    reason(await versions({ 'package.json': '{}' }, '', { dependencies: { next: 'file:vendor/next.tgz' } })),
    'declared-nonregistry',
  );
  // Ranges are declarations the lockfile settles; the exact registry package qualifies.
  for (const spec of ['^14.2.0', '~14.2.25', '14.2.25', '>=14 <15']) {
    assert.equal(
      (await versions({ 'package-lock.json': lockfile(OK) }, '', { dependencies: { next: spec } })).next.state,
      'resolved',
      spec,
    );
  }
  // A near-neighbour registry lock is resolved, with its own integrity, and is simply another version.
  const near = await versions({ 'package-lock.json': lockfile({ ...OK, next: '14.2.26' }) });
  assert.equal(near.next.state === 'resolved' && near.next.version, '14.2.26');
});

test('pnpm lockfile importers are read strictly, with the package resolution integrity', async () => {
  const text = pnpmLock({ '.': '14.2.25' });
  const v = await versions({ 'pnpm-lock.yaml': text });
  assert.deepEqual(
    [v.next, v.react, v['react-dom']].map((x) => x.state === 'resolved' && x.version),
    ['14.2.25', '18.3.1', '18.3.1'],
  );
  if (v.next.state === 'resolved') {
    assert.equal(v.next.integrity, integrityOf('next', '14.2.25'));
    assert.match(
      bytes(text).subarray(v.next.span!.startByte, v.next.span!.endByte).toString(),
      /^ {6}next:\n {8}specifier: 14\.2\.25\n {8}version: 14\.2\.25\(/,
    );
  }
  assert.equal(
    (await versions({ 'pnpm-lock.yaml': pnpmLock({ 'apps/web': '14.2.25' }) }, 'apps/web')).next.state,
    'resolved',
  );
  const reason = async (t: string) => ((await versions({ 'pnpm-lock.yaml': t })).next as { reason?: string }).reason;
  assert.equal(await reason(pnpmLock({ '.': 'link:../next' })), 'not-registry');
  assert.equal(await reason(pnpmLock({ '.': 'file:vendor/next.tgz' })), 'not-registry');
  assert.equal(
    await reason(pnpmLock({ '.': '14.2.25' }, (n, ver) => `{tarball: file:vendor/${n}-${ver}.tgz}`)),
    'not-registry',
  );
  assert.equal(
    await reason(
      pnpmLock({ '.': '14.2.25' }, (n) =>
        n === 'next' ? `{integrity: ${integrityOf('next', '0.0.1')}}` : `{integrity: ${integrityOf(n, '18.3.1')}}`,
      ),
    ),
    'identity-mismatch',
  );
  assert.equal(await reason(pnpmLock({ '.': '14.2.25' }, () => '{}')), 'no-integrity');
  assert.equal(await reason("lockfileVersion: '5.4'\n"), 'lockfile-unsupported');
});

test('the support manifest names exactly the measured versions, and its digest is the pack digest', async () => {
  assert.deepEqual({ ...NEXT_SUPPORT.versions }, OK);
  assert.ok(Object.isFrozen(NEXT_SUPPORT) && Object.isFrozen(NEXT_SUPPORT.versions));
  assert.match(NEXT_PACK_DIGEST, /^sha256:[0-9a-f]{64}$/);
  const { STRINGS } = await import('@farsight/core/dist/strings.js');
  for (const key of [...NEXT_REASON_CODES, ...NEXT_ERROR_CODES]) {
    const e = STRINGS[key];
    assert.ok(e && e.hud && e.professional && e.define, `${key} needs both registers and a define`);
  }
});

test('pnpm patches do not inherit the measured registry package identity', async () => {
  const base = pnpmLock({ '.': '14.2.25' });
  const patchMap = (pkg: string) =>
    `patchedDependencies:\n  '${pkg}':\n    hash: synthetic-patch\n    path: patches/framework.patch\n\n`;
  const reason = (v: any) => v.reason;
  for (const pkg of ['next', 'react', 'react-dom'] as const) {
    const version = OK[pkg];
    const mapped = base.replace('importers:', patchMap(`${pkg}@${version}`) + 'importers:');
    assert.equal(
      reason((await versions({ 'pnpm-lock.yaml': mapped }))[pkg]),
      'identity-mismatch',
      `lock patch map ${pkg}`,
    );
    const dependency = `      ${pkg}:\n        specifier: ${version}\n        version: ${version}`;
    const selected = base.replace(dependency, `${dependency}(patch_hash=synthetic-patch)`);
    assert.equal(
      reason((await versions({ 'pnpm-lock.yaml': selected }))[pkg]),
      'identity-mismatch',
      `importer patch hash ${pkg}`,
    );
    for (const key of [pkg, `${pkg}@${version}`, `${pkg}@^${version}`]) {
      const declarations = { pnpm: { patchedDependencies: { [key]: 'patches/framework.patch' } } };
      assert.equal(
        reason((await versions({ 'pnpm-lock.yaml': base }, '', declarations))[pkg]),
        'identity-mismatch',
        `manifest patch ${key}`,
      );
      assert.equal(
        reason((await versions({ 'package-lock.json': lockfile(OK) }, '', declarations))[pkg]),
        'identity-mismatch',
        `manifest evidence with npm lock ${key}`,
      );
    }
  }
  const v6 = base
    .replace("lockfileVersion: '9.0'", "lockfileVersion: '6.0'")
    // eslint-disable-next-line no-regex-spaces -- Match the literal two-space pnpm package-key indentation in the fixture.
    .replace(/^  (next|react|react-dom)@/gm, '  /$1@');
  assert.equal(
    (await versions({ 'pnpm-lock.yaml': v6 })).next.state,
    'resolved',
    'v6 ordinary peer suffix remains supported',
  );
  const patchedEntry = v6.replace('  /next@14.2.25:', '  /next@14.2.25(patch_hash=synthetic-patch):');
  assert.equal(
    reason((await versions({ 'pnpm-lock.yaml': patchedEntry })).next),
    'identity-mismatch',
    'v6 package key patch hash alone',
  );
  const modifiedEntry = base.replace('  next@14.2.25:', '  next@14.2.25:\n    patched: true');
  assert.equal(reason((await versions({ 'pnpm-lock.yaml': modifiedEntry })).next), 'identity-mismatch');
  const unrelated = base.replace('importers:', patchMap('unrelated@1.0.0') + 'importers:');
  const positive = await versions({ 'pnpm-lock.yaml': unrelated }, '', {
    pnpm: { patchedDependencies: { 'unrelated@1.0.0': 'patches/other.patch' } },
  });
  assert.deepEqual(
    Object.values(positive).map((v) => v.state),
    ['resolved', 'resolved', 'resolved'],
    'ordinary peer suffix and unrelated patches remain supported',
  );
  for (const patch of [
    'patchedDependencies: {next@14.2.25: patches/next.patch}\n',
    'patchedDependencies:\n  next@14.2.25: patches/next.patch\n',
  ]) {
    assert.equal(
      (await versions({ 'pnpm-lock.yaml': base.replace('importers:', patch + 'importers:') })).next.state,
      'unknown',
      'unsupported patch layout fails closed',
    );
  }
  const escapedHead = base.replace(
    'importers:',
    '\u0022patched\\u0044ependencies\u0022:\n  next@14.2.25:\n    path: patches/next.patch\nimporters:',
  );
  assert.equal(
    (await versions({ 'pnpm-lock.yaml': escapedHead })).next.state,
    'unknown',
    'escaped patch-map keys are outside the supported YAML shape',
  );
  const escapedSuffix = base.replace('version: 14.2.25(', 'version: 14.2.25(\\u0070atch_hash=synthetic-patch)(');
  assert.equal(
    (await versions({ 'pnpm-lock.yaml': escapedSuffix })).next.state,
    'unknown',
    'escaped version metadata is not a peer suffix',
  );
  const nested = {
    'pnpm-lock.yaml': pnpmLock({ 'apps/web': '14.2.25' }),
    'package.json': JSON.stringify({ pnpm: { patchedDependencies: { 'next@14.2.25': 'patches/next.patch' } } }),
  };
  assert.equal(
    reason((await versions(nested, 'apps/web', { dependencies: OK })).next),
    'identity-mismatch',
    'workspace root patches apply to nested apps',
  );
  assert.equal(
    (await versions({ ...nested, 'package.json': '{}' }, 'apps/web', { dependencies: OK })).next.state,
    'resolved',
  );
  for (const malformed of [
    'null',
    '{',
    JSON.stringify({ pnpm: { patchedDependencies: [] } }),
    JSON.stringify({ pnpm: null }),
  ]) {
    assert.equal(
      (await versions({ ...nested, 'package.json': malformed }, 'apps/web', { dependencies: OK })).next.state,
      'unknown',
    );
  }
  const map = new Map([
    [
      'pnpm-lock.yaml',
      { relativePath: 'pnpm-lock.yaml', content: 'lock', bytes: Buffer.byteLength(nested['pnpm-lock.yaml']) },
    ],
  ]);
  const unavailable = await resolveVersions({
    projectDir: 'apps/web',
    files: map,
    recorded: new Set(['pnpm-lock.yaml', 'package.json']),
    packageJson: { dependencies: OK },
    pins: NEXT_SUPPORT.packages,
    read: async () => bytes(nested['pnpm-lock.yaml']),
  });
  assert.equal(unavailable.next.state, 'unknown', 'recorded root declaration without bytes cannot qualify');
});

test('pnpm root-key preflight rejects unsupported YAML key and document forms', async () => {
  const base = pnpmLock({ '.': '14.2.25' });
  const escaped = '"patched' + String.fromCharCode(92) + 'u0044ependencies": {}\n';
  for (const prefix of [
    '!!str patchedDependencies: {}\n',
    '&fixture patchedDependencies: {}\n',
    '? patchedDependencies\n: {}\n',
    '*fixture: {}\n',
    escaped,
    '---\n',
    '%YAML 1.2\n---\n',
    'settings: {}\n',
  ]) {
    assert.ok(
      Object.values(await versions({ 'pnpm-lock.yaml': prefix + base })).every((v) => v.state === 'unknown'),
      prefix,
    );
  }
  // Ordinary plain/quoted identifiers, including known section names, remain supported.
  const quoted = base.replace(/^(lockfileVersion|settings|importers|packages):/gm, '"$1":');
  assert.ok(Object.values(await versions({ 'pnpm-lock.yaml': quoted })).every((v) => v.state === 'resolved'));
});
