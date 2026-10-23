// Each genuine startup tamper case uses an independent compiled package. Normal test-file concurrency is safe:
// no writer in the case reaches this worktree’s dist or another test’s registered build.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync, symlinkSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { needsStore, scratch } from './snapshot-helpers.ts';

const sourcePackage = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const sharedDist = join(sourcePackage, 'dist');
function sharedBuild() {
  const files: Array<[string, string]> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
      const path=join(dir,entry.name),name=relative(sharedDist,path);
      if(entry.isDirectory()) walk(path);
      else files.push([name,entry.isSymbolicLink()?`link:${readlinkSync(path)}`:createHash('sha256').update(readFileSync(path)).digest('hex')]);
    }
  };
  walk(sharedDist);
  return files;
}

for (const part of ['worker', 'imported-module', 'manifest'] as const) test(`genuine ${part} startup tamper is final, raw cause stays workerExited and restored identity is unchanged`, needsStore, async t => {
  const before=sharedBuild();
  const root=scratch(t,'sentinel-private-startup-build-'),pkg=join(root,'package');
  mkdirSync(pkg);
  for(const member of ['package.json','dist','rules']) cpSync(join(sourcePackage,member),join(pkg,member),{recursive:true,dereference:true});
  // Runtime dependencies are only read. All mutable build files and the genuine fixture helpers belong to this
  // case; copied modules never import Sentinel’s shared dist and cannot share its owner-binding module instance.
  symlinkSync(join(sourcePackage,'node_modules'),join(pkg,'node_modules'),'dir');
  const tests=join(pkg,'test');mkdirSync(tests);
  for(const helper of ['framework-startup-tamper-case.ts','framework-canonical-helpers.ts','snapshot-helpers.ts','lease-helpers.ts','express-fixtures.ts']) {
    cpSync(join(sourcePackage,'test',helper),join(tests,helper));
  }
  for(const member of ['frameworks/controls/worker.js','frameworks/express/effects.js']) {
    const shared=statSync(join(sharedDist,member)),copied=statSync(join(pkg,'dist',member));
    assert.ok(shared.dev!==copied.dev||shared.ino!==copied.ino,'tamper targets are independent files, never hard links');
  }
  try {
    const {runStartupTamperCase}=await import(pathToFileURL(join(tests,'framework-startup-tamper-case.ts')).href);
    await runStartupTamperCase(t,part);
  } finally {
    const after=sharedBuild();
    assert.deepEqual(after,before,'the entire shared compiled build remains byte-for-byte unchanged');
    t.diagnostic(JSON.stringify({isolation:'private copied package',sharedDistFiles:before.length,sharedDistSha256:createHash('sha256').update(JSON.stringify(before)).digest('hex')}));
  }
});
