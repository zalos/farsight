import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main, compareTrees, MIRROR } from '../check-skills-mirror.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const quiet = { out: () => {}, err: () => {} };

test('the Codex skills mirror in this checkout is identical to .claude/skills', () => {
  const lines = [];
  const code = main([], { defaultRoot: repo, out: (l) => lines.push(l), err: (l) => lines.push(l) });
  assert.equal(code, 0, lines.join('\n'));
  assert.match(lines.join('\n'), /are identical \(\d+ files\)/);
});

test('a drifted mirror fails and names every differing path', () => {
  const root = mkdtempSync(join(tmpdir(), 'skills-mirror-'));
  try {
    for (const tree of MIRROR) mkdirSync(join(root, tree, 'one'), { recursive: true });
    writeFileSync(join(root, MIRROR[0], 'one', 'SKILL.md'), 'a');
    writeFileSync(join(root, MIRROR[1], 'one', 'SKILL.md'), 'b');
    mkdirSync(join(root, MIRROR[1], 'stale'));
    writeFileSync(join(root, MIRROR[1], 'stale', 'SKILL.md'), 'left behind');
    assert.deepEqual(compareTrees(join(root, MIRROR[0]), join(root, MIRROR[1])),
      [{ path: 'one/SKILL.md', differs: true }, { path: 'stale', only: 'b' }]);
    const errs = [];
    assert.equal(main(['--root', root], { cwd: root, out: () => {}, err: (l) => errs.push(l) }), 1);
    assert.match(errs.join('\n'), /differs: one\/SKILL\.md/);
    assert.match(errs.join('\n'), /only in \.agents\/skills: stale/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a missing tree is a failure, never a pass', () => {
  const root = mkdtempSync(join(tmpdir(), 'skills-mirror-'));
  try {
    mkdirSync(join(root, MIRROR[0]), { recursive: true });
    assert.equal(main(['--root', root], { cwd: root, ...quiet }), 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
