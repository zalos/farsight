// A refactor changes no identity (docs/proposals/sentinel-v2, the lane rules): plan digests, invocation records and
// work and attempt ids are byte-identical across it. Set SENTINEL_BASELINE_PACKAGE to the packages/sentinel folder of
// a built baseline (a main worktree after `pnpm --filter '@farsight/sentinel...' build`). This test then copies each
// build into one temporary package folder in turn, so an absolute path an adapter digest names is the same for both,
// runs the same deterministic foundation-preview run (test/helpers/deterministic-run.mjs) with each, and requires the
// two dumps, every retained object and every ledger row, to be identical. Without a baseline it is skipped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unlock } from './snapshot-helpers.ts';

const here = fileURLToPath(new URL('../', import.meta.url));
const baseline = process.env.SENTINEL_BASELINE_PACKAGE;
const helper = fileURLToPath(new URL('./helpers/deterministic-run.mjs', import.meta.url));

test(
  'a deterministic run on this build and on the baseline build retains the same objects and ledger rows, byte for byte',
  baseline ? {} : { skip: 'set SENTINEL_BASELINE_PACKAGE to a built baseline packages/sentinel folder' },
  (t) => {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'sentinel-identity-')));
    t.after(() => {
      unlock(dir);
      rmSync(dir, { recursive: true, force: true });
    });
    const pkg = join(dir, 'pkg');
    const run = (from: string, name: string) => {
      unlock(dir);
      rmSync(pkg, { recursive: true, force: true });
      mkdirSync(pkg);
      for (const part of ['dist', 'rules', 'schemas', 'package.json'])
        cpSync(join(from, part), join(pkg, part), { recursive: true });
      // Dependencies resolve from this package's own node_modules, so both builds run against one installation.
      symlinkSync(join(here, 'node_modules'), join(pkg, 'node_modules'));
      const line = execFileSync(process.execPath, [helper, pkg, join(dir, 'work'), join(dir, `${name}.json`)], {
        cwd: pkg,
        encoding: 'utf8',
        timeout: 300_000,
      });
      return {
        summary: JSON.parse(line.trim().split('\n').pop()!),
        dump: readFileSync(join(dir, `${name}.json`), 'utf8'),
      };
    };
    const before = run(baseline!, 'baseline');
    const after = run(here, 'this');
    t.diagnostic(`baseline ${JSON.stringify(before.summary)}`);
    t.diagnostic(`this     ${JSON.stringify(after.summary)}`);
    assert.ok(before.summary.objects > 10, 'the run retained its objects');
    assert.equal(after.dump, before.dump);
  },
);
