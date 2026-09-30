#!/usr/bin/env node
// Runs after `tsc` in packages/core's build: records which code the dist was
// compiled from — HEAD, the last commit that touched the code, and whether the
// code had uncommitted changes — beside dist/version.js, where buildInfo() reads
// it. Taken now, at compile time, because a process that reads git when it
// starts learns what the checkout says then, not what its dist holds.
// The module's mtime goes in too: a later `tsc` by hand rewrites version.js
// without this script, and buildInfo() then ignores the stamp as belonging to
// another compile rather than vouching for code it never saw.
import { statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'packages', 'core', 'dist');
const { gitIdentity, BUILD_STAMP_FILE } = await import(join(dist, 'version.js'));
const stamp = { ...gitIdentity(root), moduleMtimeMs: statSync(join(dist, 'version.js')).mtimeMs };
writeFileSync(join(dist, BUILD_STAMP_FILE), JSON.stringify(stamp, null, 2) + '\n');
