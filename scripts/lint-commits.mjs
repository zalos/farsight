#!/usr/bin/env node
// Checks that commit messages and pull-request titles are Conventional Commits.
//
//   node scripts/lint-commits.mjs --message "feat(cli): a thing"   # one subject (a PR title)
//   node scripts/lint-commits.mjs --file .git/COMMIT_EDITMSG       # the commit-msg hook
//   node scripts/lint-commits.mjs --range origin/main..HEAD        # every commit in a range (CI on a PR)
//
// Why it is strict: PRs are squash-merged, so the PR title *is* the commit that
// lands on main and the line that `scripts/changelog.mjs` prints in CHANGELOG.md
// and the release notes. Zero dependencies (Node 24).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

/** The types the changelog groups (`scripts/changelog.mjs`), plus the ones it files under Chores. */
export const TYPES = ['feat', 'fix', 'docs', 'test', 'chore', 'build', 'ci', 'refactor', 'perf', 'style', 'revert'];
/** The scopes a reader expects: the packages, the surfaces that are not a package, and the release. */
export const SCOPES = [
  'core', 'parsers', 'server', 'mcp', 'cli', 'work', 'work-jira', 'work-azdo', 'work-fixture',
  'e2e', 'scripts', 'ci', 'docs', 'proposals', 'examples', 'release', 'deps', 'viewer', 'skills',
];
export const MAX_SUBJECT = 120;

const SUBJECT = /^(?<type>[a-z]+)(?:\((?<scope>[^()\s]+)\))?(?<bang>!)?:\s(?<subject>\S.*)$/;
// git's own subjects, never written by a person: skipped, not judged
const GIT_OWN = [/^Merge /, /^Revert "/, /^fixup! /, /^squash! /, /^amend! /];
// the ` (#123)` GitHub appends to a squash subject does not count against its length
const PR_SUFFIX = /\s\(#\d+\)$/;

/**
 * The problems with one subject line, as sentences; empty when it conforms.
 * `scopes` may be `null` to accept any scope (the hook does; CI passes the list).
 */
export function lintSubject(line, { scopes = SCOPES, types = TYPES, maxLength = MAX_SUBJECT } = {}) {
  const subject = line.replace(/\r?\n[\s\S]*$/, '').trimEnd();
  if (GIT_OWN.some((re) => re.test(subject))) return [];
  const problems = [];
  const m = SUBJECT.exec(subject);
  if (!m) {
    problems.push(`not a conventional commit — write \`type(scope): subject\`, e.g. \`fix(cli): …\`; types: ${types.join(', ')}`);
    if (/^[A-Z][a-z]+(\([^)]*\))?!?:/.test(subject)) problems.push('the type is lower-case (`fix:`, not `Fix:`)');
    if (/^[a-z]+(\([^)]*\))?!?:\S/.test(subject)) problems.push('one space after the colon');
    return problems;
  }
  const { type, scope, subject: text } = m.groups;
  if (!types.includes(type)) problems.push(`unknown type \`${type}\` — one of ${types.join(', ')}`);
  if (scope !== undefined && scopes && !scopes.includes(scope)) problems.push(`unknown scope \`${scope}\` — one of ${scopes.join(', ')} (add a new one to scripts/lint-commits.mjs SCOPES in the same change)`);
  if (/[.!?]$/.test(text.replace(PR_SUFFIX, ''))) problems.push('no full stop at the end of the subject');
  if (subject.replace(PR_SUFFIX, '').length > maxLength) problems.push(`subject is ${subject.length} characters; keep it under ${maxLength}`);
  if (/^(wip|tmp|temp|fixes?|updates?|changes?|misc|stuff)$/i.test(text.trim())) problems.push(`\`${text.trim()}\` says nothing — name what changed`);
  return problems;
}

/** Lint every commit subject in a git range; `[{ sha, subject, problems }]` for the ones that fail. */
export function lintRange(cwd, range, opts) {
  const raw = execFileSync('git', ['log', '--no-merges', '--format=%h%x1f%s', range], { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  return raw.split('\n').filter(Boolean).map((r) => {
    const [sha, subject] = r.split('\x1f');
    return { sha, subject, problems: lintSubject(subject, opts) };
  }).filter((c) => c.problems.length);
}

export function report(label, problems) {
  return [`✗ ${label}`, ...problems.map((p) => `    - ${p}`)].join('\n');
}

function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      message: { type: 'string', short: 'm' },
      file: { type: 'string', short: 'f' },
      range: { type: 'string', short: 'r' },
      'any-scope': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help || (!values.message && !values.file && !values.range)) {
    console.log('usage: node scripts/lint-commits.mjs (--message <subject> | --file <path> | --range <a..b>) [--any-scope]');
    return values.help ? 0 : 2;
  }
  const opts = values['any-scope'] ? { scopes: null } : {};
  if (values.range) {
    const bad = lintRange(process.cwd(), values.range, opts);
    if (!bad.length) { console.log(`commits ok: ${values.range}`); return 0; }
    for (const c of bad) console.error(report(`${c.sha} ${c.subject}`, c.problems));
    return 1;
  }
  const text = values.message ?? readFileSync(values.file, 'utf8').split('\n').filter((l) => !l.startsWith('#')).join('\n').trim();
  const problems = lintSubject(text, opts);
  if (!problems.length) return 0;
  console.error(report(text.split('\n')[0], problems));
  console.error('\nConventional Commits: https://www.conventionalcommits.org — the rules this repo uses: CONTRIBUTING.md § Branches, commits, pull requests');
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exit(main(process.argv.slice(2))); } catch (e) { console.error(`lint-commits: ${e.message}`); process.exit(2); }
}
