#!/usr/bin/env node
// Coarse CI boundaries, not a per-test dependency graph. Unknown inputs run everything.
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const all = () => ({ validate: true, e2e: true, echo: true });

export function selectChecks(paths) {
  const checks = { validate: false, e2e: false, echo: false };
  for (const path of paths) {
    // These Markdown files are shipped in the Echo tarball, so still check packaging.
    if (['docs/ECHO.md', 'packages/echo/README.md', 'scripts/pack-echo.mjs',
      'scripts/test-echo-package.mjs', '.echo/settings.example.json', '.echo/connection.example.json'].includes(path)) {
      checks.echo = true;
    } else if (/^(?:[^/]+\.md|docs\/.*\.md|\.(?:github|claude|agents)\/.*\.md)$/s.test(path) || path === 'LICENSE') {
      // Only known documentation locations; Markdown in fixtures can affect tests.
    } else if (path.startsWith('e2e/') || /^scripts\/(?:e2e|e2e-perf|synth-graph)\.mjs$/.test(path)) {
      checks.e2e = true;
    } else if (/^packages\/[^/]+\/test\//.test(path) || path.startsWith('scripts/test/') ||
      /^scripts\/(?:changelog|release|install-hooks|lint-commits)\.mjs$/.test(path)) {
      checks.validate = true;
    } else if (/^(?:packages|examples|schemas)\//.test(path)) {
      checks.validate = checks.e2e = true;
      if (/^packages\/(?:graph|core|echo)\//.test(path)) checks.echo = true;
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
      Object.entries(checks).map(([name, run]) => `- ${name === 'echo' ? 'echo-package' : name}: ${run ? 'run' : 'skip'}`).join('\n') +
      '\n\nSecret scanning and PR commit conventions run independently.\n');
  }
}
