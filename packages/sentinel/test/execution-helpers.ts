// Shared set-up for the execution tests: a real store owner in a private temporary folder, synthetic captured
// inputs, and built-in adapters that run the hostile worker fixture with one behaviour each.
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, writeFileSync, mkdirSync, chmodSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireStoreOwner } from '../dist/store/owner.js';
import { createAdapterRegistry } from '../dist/execution/registry.js';

export const WORKER = fileURLToPath(new URL('./fixtures/workers/hostile-worker.mjs', import.meta.url));

export function scratch(label: string) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), `sentinel-exec-${label}-`));
  chmodSync(root, 0o700);
  const work = join(root, 'work');
  mkdirSync(work, { mode: 0o700 });
  return { root, work };
}

export async function ownerIn(root: string) {
  return acquireStoreOwner(join(root, 'store'));
}

/** Synthetic captured inputs: small files whose ids are their SHA-256. */
export function inputs(root: string, contents: string[] = ['synthetic input one\n', 'synthetic input two\n']) {
  const dir = join(root, 'captured');
  mkdirSync(dir, { mode: 0o700, recursive: true });
  return contents.map((text, i) => {
    const path = join(dir, `input-${i}`);
    writeFileSync(path, text);
    return { id: `sha256:${createHash('sha256').update(text).digest('hex')}`, path };
  });
}

/** One built-in adapter per behaviour: a two-line wrapper module that sets the behaviour and imports the worker. */
export function builtInRegistry(root: string, behaviours: string[], limits: Record<string, number> = {}, argument?: string) {
  const dir = join(root, 'adapters');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return createAdapterRegistry(behaviours.map(b => {
    const module = join(dir, `${b}.mjs`);
    writeFileSync(module, `globalThis.SENTINEL_BEHAVIOR = ${JSON.stringify(b)}; globalThis.SENTINEL_ARGUMENT = ${JSON.stringify(argument ?? null)};\nawait import(${JSON.stringify(new URL(`file://${WORKER}`).href)});\n`);
    return { id: `test-${b}`, version: '0.0.0-test', kind: 'built-in' as const, isolation: 'child' as const, module, limits: { timeoutMs: 15_000, cancelGraceMs: 1_000, helloTimeoutMs: 5_000, ...limits } };
  }));
}

export const work = { id: 'work-synthetic', revision: 1 };

/** Remove a test scratch tree, reopening sealed attempt input folders first. */
export function removeScratch(root: string) {
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory() && !e.isSymbolicLink()) { chmodSync(join(d, e.name), 0o700); walk(join(d, e.name)); }
    }
  };
  try { walk(root); } catch { /* already gone */ }
  rmSync(root, { recursive: true, force: true });
}
