import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BUILTIN_WORKERS, builtinWorker } from '../dist/execution/builtin-workers.js';
import { builtinWorkerFiles } from '../dist/execution/assets.js';
import { CLOSURE_REFUSED, writeBuiltinClosureEntry, writeClosureEntry } from '../dist/frameworks/controls/closure.js';
import { CONTROLS_MODELED_VERSIONS } from '../dist/frameworks/controls/definitions.js';
import { NEXT_SUPPORT } from '../dist/frameworks/next/support.js';
import { EXPRESS_SUPPORT } from '../dist/frameworks/express/support.js';
import { NEST_PACK } from '../dist/frameworks/nest/support.js';
import { SPRING_SUPPORT } from '../dist/frameworks/spring/support.js';
const invalid = (e: any) => e.code === 'sentinel.execution.adapterInvalid';
const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
function scratch(t: any) {
  const p = realpathSync(mkdtempSync(join(tmpdir(), 'sentinel-builtin-')));
  t.after(() => rmSync(p, { recursive: true, force: true }));
  return p;
}

// Unmodified compiled resolver in an inert layout fixture. Actual packed npm-only acceptance qualifies the emitted
// installed layout separately; these controls enumerate malformed paths/manifests without touching a real install.
async function layoutFixture(t: any, change: (root: string, manifest: any) => void = () => {}, rootIn?: string) {
  const root = rootIn ?? scratch(t),
    dist = join(root, 'dist');
  mkdirSync(root, { recursive: true });
  const compiled = join(import.meta.dirname, '../dist');
  for (const rel of [
    'execution/assets.js',
    'execution/builtin-workers.js',
    'execution/errors.js',
    'policy/immutable.js',
  ]) {
    mkdirSync(dirname(join(dist, rel)), { recursive: true });
    cpSync(join(compiled, rel), join(dist, rel));
  }
  symlinkSync(join(import.meta.dirname, '../node_modules'), join(root, 'node_modules'));
  const assets: Record<string, any> = {};
  for (const stem of ['execution/launch-gate', 'frameworks/controls/worker', 'analysis/paths/worker']) {
    const path = `dist/${stem}.mjs`,
      bytes = '// inert owned asset\n';
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), bytes);
    assets[stem] = { path, sha256: sha(bytes) };
  }
  writeFileSync(join(dist, 'frameworks/controls/driver.mjs'), '// inert owned driver\n');
  writeFileSync(join(dist, 'analysis/paths/driver.mjs'), '// inert owned path driver\n');
  const manifest = { name: 'farsight-sentinel', type: 'module', sentinel: { assets } };
  change(root, manifest);
  writeFileSync(join(root, 'package.json'), JSON.stringify(manifest));
  return await import(pathToFileURL(join(dist, 'execution/assets.js')).href);
}

test('built-in descriptors are a frozen own-property closed set; both shipped workers have fixed entries', (t) => {
  assert.deepEqual(Object.keys(BUILTIN_WORKERS), ['framework-controls', 'bounded-paths']);
  assert.ok(Object.isFrozen(BUILTIN_WORKERS) && Object.isFrozen(BUILTIN_WORKERS['framework-controls']));
  assert.equal(BUILTIN_WORKERS['framework-controls'].closureRefusalExit, CLOSURE_REFUSED);
  assert.equal(BUILTIN_WORKERS['bounded-paths'].closureRefusalExit, CLOSURE_REFUSED);
  assert.ok(builtinWorkerFiles('bounded-paths').driver.endsWith('/analysis/paths/driver.js'));
  assert.ok(writeBuiltinClosureEntry(scratch(t), 'bounded-paths').module);
  const out = scratch(t);
  for (const id of ['x', '__proto__', 'constructor', null, 1, {}]) {
    if (id !== 'bounded-paths') assert.throws(() => builtinWorker(id), invalid);
    assert.throws(() => writeBuiltinClosureEntry(out, id as any), invalid);
    assert.deepEqual(readdirSync(out), []);
  }
});

test('workspace production entry is stable, fixes the driver and exposes no fixture helpers from index', async (t) => {
  const out = scratch(t),
    files = builtinWorkerFiles('framework-controls');
  assert.equal(files.layout.installed, false);
  assert.ok(files.worker.endsWith('/worker.js') && files.driver.endsWith('/driver.js'));
  const first = writeBuiltinClosureEntry(out, 'framework-controls');
  assert.deepEqual(writeBuiltinClosureEntry(out, 'framework-controls'), first);
  assert.equal(first.module, join(out, `framework-controls-${sha(readFileSync(first.module))}.mjs`));
  const index = await import('../dist/frameworks/controls/index.js');
  for (const key of ['workerClosure', 'writeClosureEntry', 'closureEntrySource', 'FRAMEWORK_CONTROLS_WORKER'])
    assert.ok(!Object.hasOwn(index, key), key);
  t.diagnostic(JSON.stringify({ layout: 'workspace', entries: first.files, bytes: readFileSync(first.module).length }));
});

test('modeled versions come from each real support module', () => {
  assert.deepEqual(CONTROLS_MODELED_VERSIONS, {
    next: NEXT_SUPPORT.versions,
    express: { express: EXPRESS_SUPPORT.versions.express },
    nest: NEST_PACK.versions,
    spring: {
      'spring-boot': SPRING_SUPPORT.versions.springBoot,
      'spring-security': SPRING_SUPPORT.versions.springSecurity,
    },
  });
});

test('installed fixed worker and driver need only the worker asset pin; launch gate is checked', async (t) => {
  const m = await layoutFixture(t);
  assert.ok(m.builtinWorkerFiles('framework-controls').driver.endsWith('/driver.mjs'));
  assert.ok(m.builtinWorkerFiles('bounded-paths').driver.endsWith('/analysis/paths/driver.mjs'));
  assert.ok(m.launchGateUrl().endsWith('/launch-gate.mjs'));
});
for (const stem of ['frameworks/controls/worker', 'analysis/paths/worker', 'execution/launch-gate']) {
  for (const fault of ['missing-with-js', 'missing-pin', 'wrong-path', 'wrong-sha', 'linked-file']) {
    test(`installed ${stem}: ${fault} refuses`, async (t) => {
      const m = await layoutFixture(t, (root, manifest) => {
        const path = join(root, `dist/${stem}.mjs`);
        if (fault === 'missing-with-js') renameSync(path, join(root, `dist/${stem}.js`));
        if (fault === 'missing-pin') delete manifest.sentinel.assets[stem];
        if (fault === 'wrong-path') manifest.sentinel.assets[stem].path = `dist/${stem}.js`;
        if (fault === 'wrong-sha') manifest.sentinel.assets[stem].sha256 = '0'.repeat(64);
        if (fault === 'linked-file') {
          renameSync(path, path + '.elsewhere');
          symlinkSync(path + '.elsewhere', path);
        }
      });
      assert.throws(
        () =>
          stem.includes('worker')
            ? m.builtinWorkerFiles(stem.startsWith('analysis/') ? 'bounded-paths' : 'framework-controls')
            : m.launchGateUrl(),
        invalid,
      );
    });
  }
}
for (const fault of ['missing-driver', 'linked-driver', 'linked-dist', 'missing-assets']) {
  test(`installed ${fault} refuses`, async (t) => {
    const m = await layoutFixture(t, (root, manifest) => {
      const driver = join(root, 'dist/frameworks/controls/driver.mjs');
      if (fault === 'missing-driver') rmSync(driver);
      if (fault === 'linked-driver') {
        renameSync(driver, driver + '.elsewhere');
        symlinkSync(driver + '.elsewhere', driver);
      }
      if (fault === 'linked-dist') {
        renameSync(join(root, 'dist'), join(root, 'dist-elsewhere'));
        symlinkSync(join(root, 'dist-elsewhere'), join(root, 'dist'));
      }
      if (fault === 'missing-assets') delete (manifest as any).sentinel.assets;
    });
    assert.throws(() => m.builtinWorkerFiles('framework-controls'), invalid);
  });
}

test('missing fixed worker export exits 71 before any protocol output', (t) => {
  const root = scratch(t),
    worker = join(root, 'worker.mjs'),
    entries = join(root, 'entries');
  mkdirSync(entries);
  writeFileSync(worker, 'export const someOtherExport = () => {};\n');
  const entry = writeClosureEntry(entries, worker);
  const result = spawnSync(process.execPath, [entry.module], { encoding: 'utf8' });
  assert.equal(result.status, 71);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('production source never imports the generic fixture helpers', () => {
  const src = join(import.meta.dirname, '../src');
  for (const file of readdirSync(src, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('controls/closure.ts'))) {
    assert.ok(
      !/import[^;]*\b(?:workerClosure|writeClosureEntry|closureEntrySource)\b[^;]*from/.test(
        readFileSync(join(src, file), 'utf8'),
      ),
      file,
    );
  }
});

for (const fault of ['missing', 'malformed', 'wrong-name', 'unreadable', 'non-file', 'dangling-link']) {
  test(`nested installed ${fault} own manifest never falls back to enclosing workspace`, async (t) => {
    const outer = scratch(t),
      inner = join(outer, 'node_modules/farsight-sentinel');
    writeFileSync(join(outer, 'package.json'), JSON.stringify({ name: '@farsight/sentinel', type: 'module' }));
    for (const stem of ['frameworks/controls/worker', 'frameworks/controls/driver', 'execution/launch-gate']) {
      const path = join(outer, `dist/${stem}.js`);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, '// outer workspace decoy\n');
    }
    const m = await layoutFixture(t, undefined, inner);
    const manifest = join(inner, 'package.json');
    if (fault === 'missing') rmSync(manifest);
    if (fault === 'malformed') writeFileSync(manifest, '{broken own package');
    if (fault === 'wrong-name') writeFileSync(manifest, JSON.stringify({ name: 'some-other-package', type: 'module' }));
    if (fault === 'unreadable') {
      // A directory is an existing boundary whose bytes cannot be read as a manifest, even under a privileged test uid.
      rmSync(manifest);
      mkdirSync(manifest);
    }
    if (fault === 'non-file') {
      rmSync(manifest);
      symlinkSync(join(outer, 'package.json'), manifest);
    }
    if (fault === 'dangling-link') {
      rmSync(manifest);
      symlinkSync(join(inner, 'missing-manifest'), manifest);
    }
    assert.throws(() => m.packageLayout(), invalid, 'the existing own boundary refuses');
    assert.throws(
      () => m.builtinWorkerFiles('framework-controls'),
      invalid,
      'outer unpinned .js decoys cannot substitute',
    );
  });
}

test('returned installed pins are copied and deeply frozen; mutation cannot authorize changed bytes', async (t) => {
  const m = await layoutFixture(t),
    own = m.packageLayout(),
    stem = 'frameworks/controls/worker';
  const worker = m.builtinWorkerFiles('framework-controls').worker;
  const changed = '// changed installed worker bytes\n';
  writeFileSync(worker, changed);
  assert.ok(Object.isFrozen(own) && Object.isFrozen(own.assets) && Object.isFrozen(own.assets[stem]));
  assert.throws(() => {
    own.assets[stem].sha256 = sha(changed);
  }, TypeError);
  assert.throws(() => {
    own.assets[stem] = { path: `dist/${stem}.mjs`, sha256: sha(changed) };
  }, TypeError);
  assert.throws(() => m.builtinWorkerFiles('framework-controls'), invalid);
});
