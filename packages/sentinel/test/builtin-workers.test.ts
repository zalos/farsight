import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BUILTIN_WORKERS, builtinWorker } from '../dist/execution/builtin-workers.js';
import { builtinWorkerFiles } from '../dist/execution/assets.js';
import { writeBuiltinClosureEntry, writeClosureEntry } from '../dist/frameworks/controls/closure.js';
import { CONTROLS_MODELED_VERSIONS } from '../dist/frameworks/controls/definitions.js';
import { NEXT_SUPPORT } from '../dist/frameworks/next/support.js';
import { EXPRESS_SUPPORT } from '../dist/frameworks/express/support.js';
import { NEST_PACK } from '../dist/frameworks/nest/support.js';
import { SPRING_SUPPORT } from '../dist/frameworks/spring/support.js';
const invalid = (e: any) => e.code === 'sentinel.execution.adapterInvalid';
const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
function scratch(t: any) { const p = realpathSync(mkdtempSync(join(tmpdir(), 'sentinel-builtin-'))); t.after(() => rmSync(p, { recursive: true, force: true })); return p; }

// Unmodified compiled resolver in an inert layout fixture. Actual packed npm-only acceptance qualifies the emitted
// installed layout separately; these controls enumerate malformed paths/manifests without touching a real install.
async function layoutFixture(t: any, change: (root: string, manifest: any) => void = () => {}) {
  const root = scratch(t), dist = join(root, 'dist');
  const compiled = join(import.meta.dirname, '../dist');
  for (const rel of ['execution/assets.js', 'execution/builtin-workers.js', 'execution/errors.js', 'policy/immutable.js']) {
    mkdirSync(dirname(join(dist, rel)), { recursive: true }); cpSync(join(compiled, rel), join(dist, rel));
  }
  symlinkSync(join(import.meta.dirname, '../node_modules'), join(root, 'node_modules'));
  const assets: Record<string, any> = {};
  for (const stem of ['execution/launch-gate', 'frameworks/controls/worker']) {
    const path = `dist/${stem}.mjs`, bytes = '// inert owned asset\n'; mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), bytes); assets[stem] = { path, sha256: sha(bytes) };
  }
  writeFileSync(join(dist, 'frameworks/controls/driver.mjs'), '// inert owned driver\n');
  const manifest = { name: 'farsight-sentinel', type: 'module', sentinel: { assets } };
  change(root, manifest);
  writeFileSync(join(root, 'package.json'), JSON.stringify(manifest));
  return await import(pathToFileURL(join(dist, 'execution/assets.js')).href);
}

test('built-in descriptors are a frozen own-property closed set; unavailable paths never register', t => {
  assert.deepEqual(Object.keys(BUILTIN_WORKERS), ['framework-controls', 'bounded-paths']);
  assert.ok(Object.isFrozen(BUILTIN_WORKERS) && Object.isFrozen(BUILTIN_WORKERS['framework-controls']));
  assert.equal(BUILTIN_WORKERS['framework-controls'].closureRefusalExit, 71);
  assert.ok(!Object.hasOwn(BUILTIN_WORKERS['bounded-paths'], 'closureRefusalExit'));
  const out = scratch(t);
  for (const id of ['x', '__proto__', 'constructor', null, 1, {}, 'bounded-paths']) {
    if (id !== 'bounded-paths') assert.throws(() => builtinWorker(id), invalid);
    assert.throws(() => writeBuiltinClosureEntry(out, id as any), invalid);
    assert.deepEqual(readdirSync(out), []);
  }
});

test('workspace production entry is stable, fixes the driver and exposes no fixture helpers from index', async t => {
  const out = scratch(t), files = builtinWorkerFiles('framework-controls');
  assert.equal(files.layout.installed, false); assert.ok(files.worker.endsWith('/worker.js') && files.driver.endsWith('/driver.js'));
  const first = writeBuiltinClosureEntry(out, 'framework-controls');
  assert.deepEqual(writeBuiltinClosureEntry(out, 'framework-controls'), first);
  assert.equal(first.module, join(out, `framework-controls-${sha(readFileSync(first.module))}.mjs`));
  const index = await import('../dist/frameworks/controls/index.js');
  for (const key of ['workerClosure', 'writeClosureEntry', 'closureEntrySource', 'FRAMEWORK_CONTROLS_WORKER']) assert.ok(!Object.hasOwn(index, key), key);
  t.diagnostic(JSON.stringify({ layout: 'workspace', entries: first.files, bytes: readFileSync(first.module).length }));
});

test('modeled versions come from each real support module', () => {
  assert.deepEqual(CONTROLS_MODELED_VERSIONS, { next: NEXT_SUPPORT.versions, express: { express: EXPRESS_SUPPORT.versions.express }, nest: NEST_PACK.versions, spring: { 'spring-boot': SPRING_SUPPORT.versions.springBoot, 'spring-security': SPRING_SUPPORT.versions.springSecurity } });
});

test('installed fixed worker and driver need only the worker asset pin; launch gate is checked', async t => {
  const m = await layoutFixture(t);
  assert.ok(m.builtinWorkerFiles('framework-controls').driver.endsWith('/driver.mjs'));
  assert.ok(m.launchGateUrl().endsWith('/launch-gate.mjs'));
});
for (const stem of ['frameworks/controls/worker', 'execution/launch-gate']) {
  for (const fault of ['missing-with-js', 'missing-pin', 'wrong-path', 'wrong-sha', 'linked-file']) {
    test(`installed ${stem}: ${fault} refuses`, async t => {
      const m = await layoutFixture(t, (root, manifest) => {
        const path = join(root, `dist/${stem}.mjs`);
        if (fault === 'missing-with-js') renameSync(path, join(root, `dist/${stem}.js`));
        if (fault === 'missing-pin') delete manifest.sentinel.assets[stem];
        if (fault === 'wrong-path') manifest.sentinel.assets[stem].path = `dist/${stem}.js`;
        if (fault === 'wrong-sha') manifest.sentinel.assets[stem].sha256 = '0'.repeat(64);
        if (fault === 'linked-file') { renameSync(path, path + '.elsewhere'); symlinkSync(path + '.elsewhere', path); }
      });
      assert.throws(() => stem.includes('worker') ? m.builtinWorkerFiles('framework-controls') : m.launchGateUrl(), invalid);
    });
  }
}
for (const fault of ['missing-driver', 'linked-driver', 'linked-dist', 'missing-assets']) {
  test(`installed ${fault} refuses`, async t => {
    const m = await layoutFixture(t, (root, manifest) => {
      const driver = join(root, 'dist/frameworks/controls/driver.mjs');
      if (fault === 'missing-driver') rmSync(driver);
      if (fault === 'linked-driver') { renameSync(driver, driver + '.elsewhere'); symlinkSync(driver + '.elsewhere', driver); }
      if (fault === 'linked-dist') { renameSync(join(root, 'dist'), join(root, 'dist-elsewhere')); symlinkSync(join(root, 'dist-elsewhere'), join(root, 'dist')); }
      if (fault === 'missing-assets') delete (manifest as any).sentinel.assets;
    });
    assert.throws(() => m.builtinWorkerFiles('framework-controls'), invalid);
  });
}

test('missing fixed worker export exits 71 before any protocol output', t => {
  const root = scratch(t), worker = join(root, 'worker.mjs'), entries = join(root, 'entries'); mkdirSync(entries);
  writeFileSync(worker, 'export const someOtherExport = () => {};\n');
  const entry = writeClosureEntry(entries, worker);
  const result = spawnSync(process.execPath, [entry.module], { encoding: 'utf8' });
  assert.equal(result.status, 71); assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
});

test('production source never imports the generic fixture helpers', () => {
  const src = join(import.meta.dirname, '../src');
  for (const file of readdirSync(src, { recursive: true }).map(String).filter(f => f.endsWith('.ts') && !f.endsWith('controls/closure.ts'))) {
    assert.ok(!/import[^;]*\b(?:workerClosure|writeClosureEntry|closureEntrySource)\b[^;]*from/.test(readFileSync(join(src, file), 'utf8')), file);
  }
});
