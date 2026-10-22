// The framework inspection worker's identity is its byte closure (ADR 44, review blocker): a change to any file it
// imports, or to any package it uses, is a different adapter, and an entry whose closure changed after it was written
// refuses to start the worker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLOSURE_REFUSED, FRAMEWORK_CONTROLS_WORKER, workerClosure, writeClosureEntry } from '../dist/frameworks/controls/index.js';
import { moduleDigestOf } from '../dist/execution/registry.js';

/** A synthetic worker: dist/frameworks/controls/worker.js importing a sibling module and a package with a dependency. */
function synthetic(t: any) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sentinel-closure-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dist = join(root, 'pkg', 'dist');
  mkdirSync(join(dist, 'frameworks', 'controls'), { recursive: true });
  mkdirSync(join(dist, 'frameworks', 'express'), { recursive: true });
  const worker = join(dist, 'frameworks', 'controls', 'worker.js');
  writeFileSync(worker, `import { effect } from '../express/effects.js';\nimport dep from 'dep-a';\nimport { readFileSync } from 'node:fs';\nexport async function runFrameworkControlsWorker() { process.stdout.write(effect() + dep); }\n`);
  writeFileSync(join(dist, 'frameworks', 'express', 'effects.js'), `export const effect = () => 'refusal';\n`);
  const a = join(root, 'pkg', 'node_modules', 'dep-a');
  const b = join(root, 'pkg', 'node_modules', 'dep-b');
  mkdirSync(a, { recursive: true });
  mkdirSync(b, { recursive: true });
  writeFileSync(join(a, 'package.json'), JSON.stringify({ name: 'dep-a', version: '1.0.0', type: 'module', main: 'index.js', dependencies: { 'dep-b': '1.0.0' } }));
  writeFileSync(join(a, 'index.js'), `export default '+a';\n`);
  writeFileSync(join(b, 'package.json'), JSON.stringify({ name: 'dep-b', version: '1.0.0' }));
  writeFileSync(join(b, 'native.node'), 'synthetic binding bytes');
  return { root, worker, effects: join(dist, 'frameworks', 'express', 'effects.js'), depB: join(b, 'native.node') };
}

const run = (module: string) => spawnSync(process.execPath, [module], { encoding: 'utf8' });

test('the closure reaches imported Sentinel files and whole packages, transitively', t => {
  const fx = synthetic(t);
  const c = workerClosure(fx.worker);
  const paths = c.entries.map(e => e[0]);
  for (const p of [fx.worker, fx.effects, fx.depB]) assert.ok(paths.includes(p), p);
  // The real worker reaches the fact mapping, every framework library and the parser package.
  const real = workerClosure().entries.map(e => e[0]);
  for (const needle of ['/controls/facts.js', '/express/effects.js', '/nest/analyze.js', '/spring/pack.js', '/next/analyze.js', '/oxc-parser/']) {
    assert.ok(real.some(p => p.includes(needle)), needle);
  }
  assert.ok(real.includes(realpathSync(FRAMEWORK_CONTROLS_WORKER)));
});

test('a change to an imported file or to a dependency\'s bytes is a different adapter pin, and the old entry refuses to run', t => {
  const fx = synthetic(t);
  const dir = join(fx.root, 'entries');
  mkdirSync(dir, { mode: 0o700 });
  const first = writeClosureEntry(dir, fx.worker);
  assert.equal(run(first.module).stdout, 'refusal+a', 'an unchanged closure runs the worker');
  const pin = moduleDigestOf(first.module);
  // The fact semantics change in a file the worker only imports.
  writeFileSync(fx.effects, `export const effect = () => 'pass-through';\n`);
  const changed = run(first.module);
  assert.equal(changed.status, CLOSURE_REFUSED);
  assert.equal(changed.stdout, '', 'nothing is written before the closure is proven');
  const second = writeClosureEntry(dir, fx.worker);
  assert.notEqual(second.closureDigest, first.closureDigest);
  assert.notEqual(moduleDigestOf(second.module), pin, 'the supervisor\'s module pin moves with the closure');
  assert.equal(run(second.module).stdout, 'pass-through+a');
  // A transitive dependency's bytes, a file that appears where an absence was recorded, and a link all count.
  writeFileSync(fx.depB, 'other binding bytes');
  assert.equal(run(second.module).status, CLOSURE_REFUSED);
  const third = writeClosureEntry(dir, fx.worker);
  symlinkSync('elsewhere', join(fx.root, 'pkg', 'node_modules', 'dep-b', 'link'));
  assert.equal(run(third.module).status, CLOSURE_REFUSED, 'a new link inside a listed package is a change');
});

test('the same closure writes the same entry; a different file under that name is refused', t => {
  const fx = synthetic(t);
  const dir = join(fx.root, 'entries');
  mkdirSync(dir, { mode: 0o700 });
  const a = writeClosureEntry(dir, fx.worker);
  assert.deepEqual(writeClosureEntry(dir, fx.worker), a);
  writeFileSync(a.module, '// tampered\n');
  assert.throws(() => writeClosureEntry(dir, fx.worker));
});

/** A worker whose one dependency is reached through a node_modules link, as pnpm and workspaces install it. */
function linked(t: any) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sentinel-closure-link-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pkg = join(root, 'pkg');
  const control = join(pkg, 'dist', 'frameworks', 'controls');
  mkdirSync(control, { recursive: true });
  mkdirSync(join(pkg, 'node_modules'), { recursive: true });
  writeFileSync(join(pkg, 'package.json'), '{"type":"module"}');
  const worker = join(control, 'worker.js');
  writeFileSync(worker, "import dep from 'dep-a';\nexport async function runFrameworkControlsWorker() { process.stdout.write(dep); }\n");
  const target = (dir: string, word: string, files = true) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dep-a', version: '1.0.0', type: 'module', main: 'index.js', ...(files ? { files: ['index.js'] } : {}) }));
    writeFileSync(join(dir, 'index.js'), `export default ${JSON.stringify(word)};\n`);
  };
  target(join(root, 'workspace-a'), 'original-a');
  target(join(root, 'workspace-b'), 'changed-b');
  const link = join(pkg, 'node_modules', 'dep-a');
  symlinkSync(join(root, 'workspace-a'), link);
  const entries = join(root, 'entries');
  mkdirSync(entries, { mode: 0o700 });
  return { root, pkg, control, worker, link, target, entry: writeClosureEntry(entries, worker) };
}

test('a dependency link retargeted after registration is refused before anything runs (review blocker)', t => {
  const fx = linked(t);
  assert.equal(run(fx.entry.module).stdout, 'original-a', 'a workspace package reached through a link runs unchanged');
  // The resolved package's bytes are unchanged; only the link Node follows to find it now points elsewhere.
  unlinkSync(fx.link);
  symlinkSync(join(fx.root, 'workspace-b'), fx.link);
  const r = run(fx.entry.module);
  assert.deepEqual([r.status, r.stdout], [CLOSURE_REFUSED, '']);
});

test('a nearer package that would shadow the pinned one is refused; the pinned package\'s own bytes still are', t => {
  const fx = linked(t);
  // A new node_modules nearer to the worker than the pinned one.
  fx.target(join(fx.control, 'node_modules', 'dep-a'), 'shadow', false);
  const shadowed = run(fx.entry.module);
  assert.deepEqual([shadowed.status, shadowed.stdout], [CLOSURE_REFUSED, '']);
  rmSync(join(fx.control, 'node_modules'), { recursive: true });
  assert.equal(run(fx.entry.module).stdout, 'original-a');
  writeFileSync(join(fx.root, 'workspace-a', 'index.js'), 'export default "changed-in-place";\n');
  assert.equal(run(fx.entry.module).status, CLOSURE_REFUSED);
});

test('a module folder moved behind a link with identical bytes is refused: Node would resolve from elsewhere', t => {
  const fx = linked(t);
  const moved = join(fx.root, 'moved-dist');
  renameSync(join(fx.pkg, 'dist'), moved);
  symlinkSync(moved, join(fx.pkg, 'dist'));
  assert.equal(run(fx.entry.module).status, CLOSURE_REFUSED);
});

test('an installed (copied, not linked) package closure runs unchanged and binds its resolution', t => {
  const fx = linked(t);
  unlinkSync(fx.link);
  cpSync(join(fx.root, 'workspace-a'), fx.link, { recursive: true });
  const dir = join(fx.root, 'entries-installed');
  mkdirSync(dir, { mode: 0o700 });
  const entry = writeClosureEntry(dir, fx.worker);
  assert.equal(run(entry.module).stdout, 'original-a');
  rmSync(fx.link, { recursive: true });
  symlinkSync(join(fx.root, 'workspace-a'), fx.link);
  assert.equal(run(entry.module).status, CLOSURE_REFUSED, 'the same bytes reached another way are another resolution');
});

test('a link inside a package whose external target changes is refused, though the link itself did not move (review blocker)', t => {
  const fx = linked(t);
  const external = join(fx.root, 'outside-target.mjs');
  writeFileSync(external, 'export default "original-target";\n');
  rmSync(join(fx.root, 'workspace-a', 'index.js'));
  symlinkSync(external, join(fx.root, 'workspace-a', 'index.js'));
  const dir = join(fx.root, 'entries-target');
  mkdirSync(dir, { mode: 0o700 });
  const entry = writeClosureEntry(dir, fx.worker);
  assert.equal(run(entry.module).stdout, 'original-target');
  writeFileSync(external, 'export default "changed-target";\n');
  const r = run(entry.module);
  assert.deepEqual([r.status, r.stdout], [CLOSURE_REFUSED, '']);
  // Retargeting the inner link to another file with the original bytes is refused too.
  const copy = join(fx.root, 'copy-target.mjs');
  writeFileSync(copy, 'export default "original-target";\n');
  writeFileSync(external, 'export default "original-target";\n');
  assert.equal(run(entry.module).stdout, 'original-target', 'restored bytes run again');
  unlinkSync(join(fx.root, 'workspace-a', 'index.js'));
  symlinkSync(copy, join(fx.root, 'workspace-a', 'index.js'));
  assert.equal(run(entry.module).status, CLOSURE_REFUSED);
});
