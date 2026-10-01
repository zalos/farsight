#!/usr/bin/env node
// The local half of a release: bump the version, write the changelog, commit,
// and tag. Usable by hand and by .github/workflows/release.yml. It never
// pushes, packs or publishes — it prints those steps instead.
//
//   node scripts/release.mjs --dry-run --bump patch     # show what would happen
//   node scripts/release.mjs --bump minor               # 0.1.0 → 0.2.0
//   node scripts/release.mjs --version 1.0.0 --prerelease beta.1   # → 1.0.0-beta.1
//
// Only the root package.json carries the release version: scripts/pack.mjs
// gives it to the farsight-cli tarball and core's buildInfo() reads it in a
// workspace build. The packages/*/package.json versions are private workspace
// versions (linked with workspace:*), never published, so they are left alone.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { changelog, prependSection } from './changelog.mjs';

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export function parseVersion(v) {
  const m = SEMVER.exec(v);
  if (!m) throw new Error(`not a version: ${v} (want X.Y.Z or X.Y.Z-tag)`);
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ?? null };
}

/** semver order, enough for refusing a release that does not move forward */
export function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] - y[k];
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  const p = x.pre.split('.'), q = y.pre.split('.');
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    if (p[i] === undefined) return -1;
    if (q[i] === undefined) return 1;
    const n = /^\d+$/.test(p[i]), o = /^\d+$/.test(q[i]);
    if (n && o && +p[i] !== +q[i]) return +p[i] - +q[i];
    if (n !== o) return n ? -1 : 1;
    if (p[i] !== q[i]) return p[i] < q[i] ? -1 : 1;
  }
  return 0;
}

/**
 * The next version. A bump from a prerelease finishes it first (1.0.0-beta.1
 * --bump patch → 1.0.0), as semver orders them; `prerelease` is appended last.
 */
export function nextVersion(current, { bump, version, prerelease } = {}) {
  let base;
  if (version) {
    base = version;
  } else {
    const c = parseVersion(current);
    const kind = bump ?? 'patch';
    if (!['patch', 'minor', 'major'].includes(kind)) throw new Error(`--bump must be patch, minor or major, not ${kind}`);
    if (c.pre !== null && (kind === 'patch' || (kind === 'minor' && c.patch === 0) || (kind === 'major' && c.patch === 0 && c.minor === 0))) {
      base = `${c.major}.${c.minor}.${c.patch}`;
    } else if (kind === 'major') base = `${c.major + 1}.0.0`;
    else if (kind === 'minor') base = `${c.major}.${c.minor + 1}.0`;
    else base = `${c.major}.${c.minor}.${c.patch + 1}`;
  }
  const next = prerelease ? `${base.replace(/-.*$/, '')}-${prerelease.replace(/^-/, '')}` : base;
  parseVersion(next);
  return next;
}

const plural = (n) => `${n} commit${n === 1 ? '' : 's'}`;
const git = (cwd, args, opts = {}) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], ...opts }).toString().trim();

/** Everything that would stop a release, as sentences; empty when it can go. */
export function preflight(cwd, { tag, allowBranch }) {
  const problems = [];
  const branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch !== 'main' && !allowBranch) problems.push(`on branch ${branch}, not main (pass --allow-branch to release from it)`);
  const dirty = git(cwd, ['status', '--porcelain']);
  if (dirty) problems.push(`the working tree has changes:\n${dirty.split('\n').map((l) => `    ${l}`).join('\n')}`);
  try { git(cwd, ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`]); problems.push(`tag ${tag} already exists`); } catch { /* free */ }
  return { branch, problems };
}

function setRootVersion(cwd, version) {
  const file = join(cwd, 'package.json');
  const text = readFileSync(file, 'utf8');
  // replace in place, so the file's formatting and key order stay as they were
  const next = text.replace(/^(\s*"version"\s*:\s*")[^"]*(")/m, `$1${version}$2`);
  if (next === text) throw new Error('package.json has no "version" to bump');
  writeFileSync(file, next);
}

/** GitHub Actions step outputs, when running under Actions. */
function setOutputs(values) {
  const out = process.env.GITHUB_OUTPUT;
  if (!out) return;
  writeFileSync(out, Object.entries(values).map(([k, v]) => `${k}=${v}\n`).join(''), { flag: 'a' });
}

export function release(cwd, opts) {
  const current = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')).version;
  const version = nextVersion(current, opts);
  if (compareVersions(version, current) <= 0) throw new Error(`${version} is not after the current version ${current}`);
  const tag = `v${version}`;
  const { branch, problems } = preflight(cwd, { tag, allowBranch: opts.allowBranch });
  const log = changelog(cwd, { version, repoUrl: opts.repoUrl });
  const notesFile = opts.notesOut ?? join(mkdtempSync(join(tmpdir(), 'farsight-release-')), 'release-notes.md');
  const plan = { current, version, tag, branch, prerelease: version.includes('-'), since: log.since, commits: log.commits.length, notesFile };

  if (opts.dryRun) {
    console.log(`release (dry run): ${current} → ${version} on ${branch}, ${plural(log.commits.length)} since ${log.since ?? 'the first commit'}`);
    if (problems.length) console.log(`\nwould refuse:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    console.log(`\nwould commit "chore(release): ${tag}" (package.json, CHANGELOG.md) and tag ${tag} (annotated, message = the notes below)\n`);
    console.log(log.section);
    console.log('# Release notes\n');
    console.log(log.notes);
    return { ...plan, problems };
  }
  if (problems.length) throw new Error(`refusing to release:\n${problems.map((p) => `  - ${p}`).join('\n')}`);

  setRootVersion(cwd, version);
  const changelogFile = join(cwd, 'CHANGELOG.md');
  writeFileSync(changelogFile, prependSection(existsSync(changelogFile) ? readFileSync(changelogFile, 'utf8') : null, log.section, version));
  writeFileSync(notesFile, log.notes);

  git(cwd, ['add', '--', 'package.json', 'CHANGELOG.md']);
  git(cwd, ['commit', '-q', '-m', `chore(release): ${tag}`, ...trailerArgs(opts.trailers)]);
  // verbatim: the notes are Markdown, and git's default cleanup would strip every `### heading` as a comment
  git(cwd, ['tag', '-a', tag, '--cleanup=verbatim', '-F', notesFile]);
  const commit = git(cwd, ['rev-parse', '--short', 'HEAD']);
  setOutputs({ version, tag, prerelease: String(plan.prerelease), notes: notesFile, commit });

  console.log(`released ${tag} locally: commit ${commit}, ${plural(log.commits.length)} since ${log.since ?? 'the first commit'}`);
  console.log(`release notes: ${notesFile}`);
  console.log('\nnext:');
  console.log('  node scripts/pack.mjs                 # the tarball, stamped with this commit');
  console.log(`  git push --follow-tags origin ${branch}`);
  console.log(`  gh release create ${tag} build/farsight-cli-${version}.tgz --title "farsight-cli ${tag}" --notes-file ${notesFile}${plan.prerelease ? ' --prerelease' : ''} --verify-tag`);
  return { ...plan, commit, problems: [] };
}

// trailers go in through git's own --trailer, so they land in one block after the subject
function trailerArgs(trailers = []) {
  return trailers.flatMap((t) => ['--trailer', t]);
}

function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      bump: { type: 'string' },
      version: { type: 'string' },
      prerelease: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      'allow-branch': { type: 'boolean', default: false },
      'notes-out': { type: 'string' },
      'repo-url': { type: 'string' },
      trailer: { type: 'string', multiple: true },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    console.log('usage: node scripts/release.mjs (--bump patch|minor|major | --version X.Y.Z) [--prerelease beta.1] [--dry-run] [--allow-branch] [--notes-out <file>] [--trailer "Key: value"]...');
    return;
  }
  if (values.bump && values.version) throw new Error('pass --bump or --version, not both');
  const cwd = git(process.cwd(), ['rev-parse', '--show-toplevel']);
  release(cwd, {
    bump: values.bump, version: values.version || undefined, prerelease: values.prerelease || undefined,
    dryRun: values['dry-run'], allowBranch: values['allow-branch'], notesOut: values['notes-out'],
    repoUrl: values['repo-url'], trailers: values.trailer ?? [],
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(`release: ${e.message}`); process.exit(1); }
}
