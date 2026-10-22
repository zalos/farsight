#!/usr/bin/env node
// Coarse CI boundaries, not a per-test dependency graph. Unknown inputs run everything.
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildClosure } from './pack-preflight.mjs';

const all = () => ({ validate: true, e2e: true, echo: true, sentinel: true });

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * The package directories `sentinel-package` packs: farsight-cli's whole workspace dependency
 * closure (its clean-consumer startup without Sentinel is checked there) and Sentinel's own.
 * Read from the manifests, so a new dependency of the CLI joins the set without editing this file.
 */
export function sentinelPackageInputs(root = repoRoot) {
  const dirs = new Set(['graph', 'code-parser', 'core']);
  for (const entry of ['@farsight/cli', '@farsight/sentinel']) {
    const { closure, missing } = buildClosure(root, entry);
    if (entry === '@farsight/cli' && (!closure.length || missing.length)) throw new Error('CLI closure unreadable');
    for (const pkg of closure) dirs.add(basename(pkg.dir));
  }
  dirs.delete('sentinel'); // its own rules below
  return dirs;
}

export function selectChecks(paths, { packageInputs } = {}) {
  let inputs;
  try { inputs = packageInputs ?? sentinelPackageInputs(); } catch { return all(); } // unreadable manifests: everything
  const checks = { validate: false, e2e: false, echo: false, sentinel: false };
  for (const path of paths) {
    // These Markdown files are shipped in the Echo tarball, so still check packaging.
    if (['docs/ECHO.md', 'packages/echo/README.md', 'scripts/pack-echo.mjs',
      'scripts/test-echo-package.mjs', '.echo/settings.example.json', '.echo/connection.example.json'].includes(path)) {
      checks.echo = true;
    } else if (['packages/sentinel/README.md', 'scripts/pack-sentinel.mjs', 'scripts/test-sentinel-package.mjs'].includes(path)) {
      // Sentinel's tarball and its packaging; Farsight's package does not include it.
      checks.sentinel = true;
    } else if (/^(?:[^/]+\.md|docs\/.*\.md|\.(?:github|claude|agents)\/.*\.md)$/s.test(path) || path === 'LICENSE') {
      // Only known documentation locations; Markdown in fixtures can affect tests.
    } else if (path.startsWith('e2e/') || /^scripts\/(?:e2e|e2e-perf|synth-graph)\.mjs$/.test(path)) {
      checks.e2e = true;
    } else if (/^packages\/sentinel\/(?!test\/)/.test(path)) {
      // Nothing in Farsight's application imports Sentinel, so its code needs no e2e run.
      checks.validate = checks.sentinel = true;
    } else if (/^packages\/[^/]+\/test\//.test(path) || path.startsWith('scripts/test/') ||
      /^scripts\/(?:changelog|release|install-hooks|lint-commits)\.mjs$/.test(path)) {
      checks.validate = true;
    } else if (/^(?:packages|examples|schemas)\//.test(path)) {
      checks.validate = checks.e2e = true;
      if (/^packages\/(?:graph|core|echo)\//.test(path)) checks.echo = true;
      // farsight-cli's closure (it must still pack and start without Sentinel) and Sentinel's own;
      // the package smoke also ingests the invoice example.
      if (inputs.has(/^packages\/([^/]+)\//.exec(path)?.[1]) || path.startsWith('examples/invoice-app/')) checks.sentinel = true;
    } else {
      return all(); // includes build/config/dependencies, workflows and this selector
    }
  }
  return checks;
}

export function changedPaths({ base, head, event, cwd = process.cwd() }) {
  // Only event-provided commit IDs; never accept a revision option from an input.
  if (![base, head].every(sha => /^[a-f0-9]{40,64}$/.test(sha ?? '') && !/^0+$/.test(sha))) {
    throw new Error('No usable base/head commit');
  }
  if (!['pull_request', 'push'].includes(event)) throw new Error('Unknown event');
  const git = args => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
  // PRs compare from their branch point, pushes compare the entire pushed range.
  const from = event === 'pull_request' ? git(['merge-base', base, head]).trim() : base;
  // No rename detection: consider BOTH the deleted old path and the added new path.
  // NUL delimiters preserve spaces/newlines; no GitHub API file-list limit.
  return git(['diff', '--name-only', '--no-renames', '-z', from, head, '--']).split('\0').filter(Boolean);
}

export function detectChecks(options) {
  try {
    const paths = changedPaths(options);
    return { checks: selectChecks(paths), reason: `${paths.length} changed paths` };
  } catch {
    return { checks: all(), reason: 'Change range unavailable; running every check' };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { checks, reason } = detectChecks({ base: process.env.BASE_SHA, head: process.env.HEAD_SHA, event: process.env.GITHUB_EVENT_NAME });
  const output = Object.entries(checks).map(([name, run]) => `${name}=${run}`).join('\n') + '\n';
  console.log(`${reason}\n${output}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Affected checks\n\n${reason}.\n\n` +
      Object.entries(checks).map(([name, run]) => `- ${{ echo: 'echo-package', sentinel: 'sentinel-package' }[name] ?? name}: ${run ? 'run' : 'skip'}`).join('\n') +
      '\n\nSecret scanning and PR commit conventions run independently.\n');
  }
}
