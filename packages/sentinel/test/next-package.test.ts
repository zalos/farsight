// PR 14: the Next pack as a consumer meets it — the packed tarball, installed outside the workspace, typed and run
// through its published subpaths only. Nothing is fetched: the tarball's own dependencies are linked to the copies
// the workspace already resolved, so no registry, network or package script is involved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commitRepo, needsStore, scratch } from './snapshot-helpers.ts';
import { npmLock } from './next-helpers.ts';

const pkgDir = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
const run = (cmd: string, args: string[], cwd: string) => {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 120_000, env: { ...process.env, npm_config_offline: 'true' } });
  assert.equal(r.status, 0, `${cmd} ${args.join(' ')}\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
};

test('importing the Next pack loads no parser until the first read, starts nothing and writes nothing', () => {
  const dir = scratch({ after: (fn: () => void) => process.on('exit', fn) }, 'sentinel-next-probe-');
  const probe = `
    import { registerHooks } from 'node:module';
    import cp from 'node:child_process';
    const seen = [];
    registerHooks({ resolve(spec, ctx, next) { seen.push(spec); return next(spec, ctx); } });
    const spawned = [];
    for (const n of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork']) { const o = cp[n]; cp[n] = (...a) => { spawned.push(n); return o(...a); }; }
    const pack = await import(${JSON.stringify(join(pkgDir, 'dist/frameworks/next/index.js'))});
    const before = seen.filter(s => s.includes('oxc'));
    // Positive control: the first read does load the parser, and the probe sees it.
    await pack.readNextConfig('next.config.js', Buffer.from('module.exports = {};'));
    process.stdout.write(JSON.stringify({ before, after: seen.includes('oxc-parser'), spawned }));
  `;
  writeFileSync(join(dir, 'probe.mjs'), probe);
  const out = JSON.parse(run(process.execPath, ['probe.mjs'], dir));
  assert.deepEqual(out, { before: [], after: true, spawned: [] });
  assert.deepEqual(readdirSync(dir), ['probe.mjs']);
});

test('the packed package exposes the pack through its published subpath, typed, from a clean consumer', needsStore, async t => {
  const dir = scratch(t, 'sentinel-next-consumer-');
  run('pnpm', ['pack', '--pack-destination', dir], pkgDir);
  const tgz = readdirSync(dir).find(f => f.endsWith('.tgz'))!;
  const app = join(dir, 'consumer');
  const installed = join(app, 'node_modules/@farsight/sentinel');
  mkdirSync(installed, { recursive: true });
  run('tar', ['-xzf', join(dir, tgz), '-C', installed, '--strip-components=1'], dir);
  const shipped = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
  assert.deepEqual(shipped.exports['./frameworks/next'], manifest.exports['./frameworks/next']);
  assert.ok(existsSync(join(installed, 'dist/frameworks/next/index.d.ts')));
  assert.ok(!existsSync(join(installed, 'src')) && !existsSync(join(installed, 'test')), 'only the published files');
  // Its dependencies, as the workspace resolved them: linked, never installed or fetched.
  for (const dep of Object.keys(shipped.dependencies)) {
    const target = join(app, 'node_modules', dep);
    mkdirSync(join(target, '..'), { recursive: true });
    symlinkSync(realpathSync(join(pkgDir, 'node_modules', dep)), target);
  }
  assert.ok(!Object.values(shipped.dependencies as Record<string, string>).some(v => v.startsWith('workspace:')), 'the tarball names real versions');

  const repo = join(dir, 'repo');
  commitRepo(repo, {
    'package.json': JSON.stringify({ name: 'c', dependencies: { next: '14.2.25', react: '18.3.1', 'react-dom': '18.3.1' } }),
    'package-lock.json': npmLock(),
    'middleware.ts': "export function middleware() {}\nexport const config = { matcher: '/private/:path*' };\n",
    'app/private/route.ts': 'export function GET() { return new Response(null); }\n',
    'app/public/route.ts': 'export function GET() { return new Response(null); }\n',
  });
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }));
  writeFileSync(join(app, 'consumer.ts'), `
    import { openStore } from '@farsight/sentinel/store';
    import { captureSnapshot } from '@farsight/sentinel/snapshot';
    import { parseSnapshot } from '@farsight/sentinel/parser';
    import { analyzeNext, NEXT_SUPPORT, type NextPackResult, type SurfaceApplicability } from '@farsight/sentinel/frameworks/next';
    import type { ControlFactsEnvelope } from '@farsight/sentinel/contracts';
    import { mkdirSync } from 'node:fs';
    const [repo, root] = process.argv.slice(2) as [string, string];
    const store = await openStore(root + '/store');
    const { snapshot } = await captureSnapshot(store, { mode: 'committed-tree', sources: [{ sourceId: 'c', repositoryId: 'example/c', root: repo }] });
    mkdirSync(root + '/work', { mode: 0o700 });
    const parsed = await parseSnapshot(store, { snapshotId: snapshot.id, workDir: root + '/work', selection: { gitignore: true, testFiles: 'include' },
      limits: { maxFiles: 100, maxFileBytes: 65536, maxTotalBytes: 1048576, maxEntries: 1000, maxDurationMs: 60000 } });
    const result: NextPackResult = await analyzeNext({ snapshot, analysis: parsed.sources[0]!, read: id => store.readArtifact(id) });
    const env: ControlFactsEnvelope = result.envelopes[0]!;
    const rows: readonly SurfaceApplicability[] = result.projects[0]!.surfaces;
    store.close();
    process.stdout.write(JSON.stringify({ version: env.framework.version, supported: NEXT_SUPPORT.versions.next,
      rows: rows.map(r => [r.relativePath, r.applicability]), verdicts: [...new Set(env.facts.map(f => f.surfaceId + ' ' + f.verdict))].sort() }));
  `);
  writeFileSync(join(app, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true,
    noEmit: true, types: ['node'], typeRoots: [join(app, 'node_modules/@types')], skipLibCheck: false }, include: ['consumer.ts'] }));
  mkdirSync(join(app, 'node_modules/@types'), { recursive: true });
  if (!existsSync(join(app, 'node_modules/@types/node'))) symlinkSync(realpathSync(join(pkgDir, 'node_modules/@types/node')), join(app, 'node_modules/@types/node'));
  // The published declarations type-check for a strict consumer, without skipLibCheck.
  run(process.execPath, [realpathSync(join(pkgDir, '../../node_modules/typescript/bin/tsc')), '-p', 'tsconfig.json'], app);
  const out = JSON.parse(run(process.execPath, ['--disable-warning=ExperimentalWarning', '--experimental-strip-types', 'consumer.ts', repo, dir], app));
  assert.equal(out.version, '14.2.25');
  assert.deepEqual(out.rows, [['app/private/route.ts', 'matched'], ['app/public/route.ts', 'excluded']]);
  assert.deepEqual(out.verdicts, ['c::route::GET /private unknown', 'c::route::GET /public does-not-apply']);
});
