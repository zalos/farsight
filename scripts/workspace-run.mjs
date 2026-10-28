#!/usr/bin/env node
// pnpm keeps its native recursive scheduler; npm builds the same dependency graph in topological order.
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { workspacePackages } from './pack-preflight.mjs';

const FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

/** The selected packages (all by default), dependencies first; refuse a cycle before running any script. */
export function workspaceOrder(packages, entry) {
  const ordered = [],
    done = new Set(),
    active = new Set();
  const visit = (name) => {
    if (done.has(name)) return;
    if (active.has(name)) throw new Error(`Workspace dependency cycle at ${name}`);
    const pkg = packages.get(name);
    if (!pkg) throw new Error(`Missing workspace package: ${name}`);
    active.add(name);
    for (const field of FIELDS)
      for (const dep of Object.keys(pkg.manifest[field] ?? {})) {
        if (packages.has(dep)) visit(dep);
        else if (dep.startsWith('@farsight/')) throw new Error(`Missing workspace package: ${dep}`);
      }
    active.delete(name);
    done.add(name);
    ordered.push({ name, ...pkg });
  };
  for (const name of entry ? [entry] : [...packages.keys()].sort()) visit(name);
  return ordered;
}

/** Preserve pnpm's existing commands; npm runs each package's script through its own lifecycle environment. */
export function runWorkspace(
  task,
  entry,
  { root = fileURLToPath(new URL('../', import.meta.url)), env = process.env, run = spawnSync } = {},
) {
  if (!['build', 'typecheck', 'test'].includes(task))
    throw new Error('Usage: workspace-run.mjs build|typecheck|test [@farsight/package]');
  const ordered = workspaceOrder(workspacePackages(root), entry);
  if (!ordered.length) throw new Error('No workspace packages');
  const invoke = (args, cwd) => {
    const result = env.npm_execpath
      ? run(process.execPath, [env.npm_execpath, ...args], { cwd, env, stdio: 'inherit' })
      : run('npm', args, { cwd, env, stdio: 'inherit', shell: process.platform === 'win32' });
    if (result.error) throw result.error;
    return result.status ?? 1;
  };
  if (env.npm_config_user_agent?.startsWith('pnpm/'))
    return invoke(entry ? ['--filter', `${entry}...`, task] : ['-r', task], root);
  for (const { name, manifest } of ordered) {
    if (!manifest.scripts?.[task]) continue;
    const status = invoke(['run', task, '--workspace', name], root);
    if (status !== 0) return status;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = runWorkspace(...process.argv.slice(2));
  } catch (error) {
    console.error(`workspace-run: ${error.message}`);
    process.exitCode = 1;
  }
}
