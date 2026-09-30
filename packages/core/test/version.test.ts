// Build identity: when two builds are the same code, and when a differing stamp still means "restart".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sameBuild, currencyAdvice, gitIdentity, buildInfo, installState, BUILD_PATHS } from '../dist/version.js';

// the case that cried wolf: `pnpm build` wrote the workspace dist, `node scripts/pack.mjs` stamped the
// tarball seconds later, both from one clean commit
const workspace = { version: '0.1.0', built: '2026-09-25T03:10:00.100Z', commit: 'a94a943', codeCommit: 'a94a943', dirty: false, source: 'workspace' as const };
const packed = { version: '0.1.0', built: '2026-09-25T03:10:07.900Z', commit: 'a94a943', codeCommit: 'a94a943', dirty: false, source: 'packed' as const };

test('sameBuild: one clean code commit is one build, whatever seconds separate the stamps', () => {
  assert.equal(sameBuild(workspace, packed), true);
  // a docs-only commit moves HEAD, not the code commit
  assert.equal(sameBuild(workspace, { ...packed, commit: 'd0c5d0c' }), true);
});

test('farsight status: a workspace server and the installed CLI of the same clean commit agree — exit 0', () => {
  const a = currencyAdvice({ role: 'cli', running: packed, server: { port: 4477, reachable: true, farsight: workspace, install: { startedAt: workspace.built, newerInstalled: false } }, graph: { farsight: workspace } });
  assert.deepEqual(a.findings, []);
  assert.equal(a.ok, true);
  // and the server's own view of the graph an installed CLI wrote
  const s = currencyAdvice({ role: 'server', running: workspace, graph: { farsight: packed } });
  assert.equal(s.ok, true);
});

test('sameBuild: a different code commit is a different build', () => {
  const next = { ...packed, commit: 'bbbbbbb', codeCommit: 'bbbbbbb' };
  assert.equal(sameBuild(workspace, next), false);
  const a = currencyAdvice({ role: 'cli', running: next, server: { port: 4477, reachable: true, farsight: workspace } });
  assert.equal(a.ok, false);
  assert.match(a.findings[0]!, /restart the server/);
});

test('sameBuild: with uncommitted changes the stamp is the only distinguisher, and it still fires', () => {
  const dirtyWs = { ...workspace, dirty: true };
  const dirtyPk = { ...packed, dirty: true };
  assert.equal(sameBuild(dirtyWs, packed), false, 'one side dirty: the commit does not say what it ran');
  assert.equal(sameBuild(workspace, dirtyPk), false);
  assert.equal(sameBuild(dirtyWs, dirtyPk), false, 'both dirty, built apart: two edits of one commit');
  assert.equal(sameBuild(dirtyWs, { ...dirtyWs }), true, 'the same stamp is the same build, dirty or not');
  const a = currencyAdvice({ role: 'cli', running: dirtyPk, server: { port: 4477, reachable: true, farsight: dirtyWs } });
  assert.match(a.findings[0]!, /uncommitted changes.* restart the server/);
});

test('sameBuild: a build that does not say whether it was clean (older stamp, no git) is matched by its stamp only', () => {
  const { dirty: _d, codeCommit: _c, ...old } = workspace;
  assert.equal(sameBuild(old, packed), false);
  assert.equal(sameBuild({ ...workspace, dirty: undefined }, packed), false);
  assert.equal(sameBuild(old, { ...old }), true);
  assert.equal(sameBuild(undefined, packed), false);
});

test('gitIdentity: this checkout has a code commit and a dirty flag; outside git it claims nothing', () => {
  const here = gitIdentity(process.cwd());
  assert.match(here.commit ?? '', /^[0-9a-f]{7,}$/);
  assert.match(here.codeCommit ?? '', /^[0-9a-f]{7,}$/);
  assert.equal(typeof here.dirty, 'boolean');
  assert.deepEqual(gitIdentity(mkdtempSync(join(tmpdir(), 'fs-nogit-'))), {});
  assert.ok(BUILD_PATHS.includes('packages') && !BUILD_PATHS.includes('docs'), 'docs are not code');
});

test('buildInfo: a workspace build reads the stamp its compile wrote', () => {
  const b = buildInfo();
  assert.equal(b.source, 'workspace');
  assert.ok(b.codeCommit, 'the core build stamps dist/build-stamp.json (scripts/stamp-build.mjs)');
  assert.equal(typeof b.dirty, 'boolean');
});

test('installState: the build on disk is compared build to build, not by file date', () => {
  // the HUD's RESTART chip and `farsight status` read this. It used to be the file's
  // mtime against the process start, so `pnpm build` of unchanged code lit RESTART on
  // a server already running that code (2026-09-27: codeCommit 75c87a1, clean, both
  // sides — newerInstalled true).
  const s = installState();
  assert.equal(s.basis, 'build', 'a stamped workspace dist is read as a build identity');
  assert.ok(s.installed?.built, 'the installed build carries its stamp');
  assert.equal(s.installed?.codeCommit, buildInfo().codeCommit);
  assert.equal(s.newerInstalled, false, 'the file this process loaded is the build it runs');
});

test('currencyAdvice: a build-to-build restart names both builds; a same-code rebuild is no finding', () => {
  const running = { ...workspace };
  const sameCode = { built: '2026-09-25T09:00:00.000Z', commit: 'a94a943', codeCommit: 'a94a943', dirty: false };
  assert.equal(sameBuild(sameCode, running), true, 'rebuilt hours later from the same clean commit');
  const ok = currencyAdvice({ role: 'server', running, install: { startedAt: running.built, basis: 'build', installed: sameCode, newerInstalled: false } });
  assert.deepEqual(ok.findings, []);
  const next = { built: '2026-09-25T09:00:00.000Z', commit: 'bbbbbbb', codeCommit: 'bbbbbbb', dirty: false };
  const a = currencyAdvice({ role: 'server', running, install: { startedAt: running.built, basis: 'build', installed: next, newerInstalled: true } });
  assert.equal(a.findings.length, 1);
  assert.match(a.findings[0]!, /newer build is installed \(.*bbbbbbb\) than this server runs \(.*a94a943.*\) — restart it/);
});
