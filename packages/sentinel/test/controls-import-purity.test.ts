import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

for (const target of [
  'frameworks/controls/definitions.js',
  'service/inspection-report.js',
  'service/full-report.js',
  'index.js',
  'cli.js',
]) {
  test(`${target} import never loads the worker, asset lookup or oxc`, () => {
    const script = `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import Module, { registerHooks, syncBuiltinESMExports } from 'node:module';
      const loaded = [], reads = [];
      registerHooks({ load(url, context, next) { loaded.push(url); return next(url, context); } });
      const load = Module._load;
      Module._load = function(spec, ...rest) { assert.ok(!String(spec).includes('oxc-parser'), 'oxc is not imported'); return load.call(this, spec, ...rest); };
      const read = fs.readFileSync;
      fs.readFileSync = function(path, ...rest) { reads.push(String(path)); return read.call(this, path, ...rest); };
      syncBuiltinESMExports();
      process.argv = [process.execPath, 'not-the-cli-entry'];
      await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../dist', target)).href)});
      assert.ok(!loaded.some(u => /frameworks\\/controls\\/worker\\.js|oxc-parser/.test(u)), JSON.stringify(loaded));
      assert.ok(!reads.some(p => /frameworks\\/controls\\/worker|execution\\/launch-gate|sentinel\\/package\\.json$/.test(p)), JSON.stringify(reads));
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(child.status, 0, child.stderr || child.stdout);
  });
}
