// The compiled outputs a package's tarball needs, read from the workspace manifests.
// Packing bundles one entry package; esbuild resolves its `@farsight/*` imports through
// each workspace package's `main`, so only that package's workspace dependency closure
// must be built. An optional package outside the closure (Sentinel, Echo, the app)
// may be absent or unbuilt without blocking the pack.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DEPENDENCY_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies'];

/** Every workspace package under `packages/`, by name: `{ name → { dir, manifest } }`. */
export function workspacePackages(root) {
  const packages = new Map();
  const dir = join(root, 'packages');
  if (!existsSync(dir)) return packages;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(dir, entry.name, 'package.json');
    if (!existsSync(path)) continue;
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof manifest.name === 'string') packages.set(manifest.name, { dir: join(dir, entry.name), manifest });
  }
  return packages;
}

/**
 * The entry package and every workspace package it depends on, transitively, by its
 * `workspace:` specifiers. The entry's own devDependencies count (it is the package being
 * bundled, and its type-only imports still resolve through them); the closure's do not.
 * A `workspace:` dependency with no manifest is reported, never skipped.
 */
export function buildClosure(root, entry) {
  const packages = workspacePackages(root);
  const closure = [], missing = [];
  const seen = new Set();
  const visit = (name, fields) => {
    if (seen.has(name)) return;
    seen.add(name);
    const pkg = packages.get(name);
    if (!pkg) { missing.push(name); return; }
    closure.push({ name, ...pkg });
    for (const field of fields) {
      for (const [dep, spec] of Object.entries(pkg.manifest[field] ?? {})) {
        if (typeof spec === 'string' && spec.startsWith('workspace:')) visit(dep, DEPENDENCY_FIELDS);
      }
    }
  };
  visit(entry, [...DEPENDENCY_FIELDS, 'devDependencies']);
  return { closure, missing };
}

/** Compiled paths the pack of `entry` needs that are not on disk; empty when it can proceed. */
export function missingBuildOutputs(root, entry, extra = []) {
  const { closure, missing } = buildClosure(root, entry);
  const needed = [...extra];
  for (const pkg of closure) if (typeof pkg.manifest.main === 'string') needed.push(join(pkg.dir, pkg.manifest.main));
  return [...missing.map((name) => `${name} (no workspace manifest)`), ...needed.filter((path) => !existsSync(path))];
}
