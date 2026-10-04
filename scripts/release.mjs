#!/usr/bin/env node
// The local half of a release: bump the version, write the changelog, commit,
// and (by default) tag. Usable by hand and by .github/workflows/release.yml. It
// never pushes, packs or publishes — it prints those steps instead.
//
//   node scripts/release.mjs --dry-run --bump patch     # show what would happen
//   node scripts/release.mjs --bump minor               # 0.1.0 → 0.2.0, committed and tagged here
//   node scripts/release.mjs --version 1.0.0 --prerelease beta.1   # → 1.0.0-beta.1
//   node scripts/release.mjs --bump patch --no-tag --branch 'release/v{version}' --commit-notes
//       # the release-PR shape the workflow uses: a new branch holding the version
//       # commit and .github/release-notes/vX.Y.Z.md, no tag (publish.yml tags the squash-merged commit)
//
// Only the root package.json carries the release version: scripts/pack.mjs
// gives it to the farsight-cli tarball and core's buildInfo() reads it in a
// workspace build. The packages/*/package.json versions are private workspace
// versions (linked with workspace:*), never published, so they are left alone.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { changelog, prependSection, sinceLabel } from './changelog.mjs';

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
export function preflight(cwd, { tag, allowBranch, newBranch }) {
  const problems = [];
  const branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch !== 'main' && !allowBranch) problems.push(`on branch ${branch}, not main (pass --allow-branch to release from it)`);
  if (newBranch) {
    try { git(cwd, ['check-ref-format', '--branch', newBranch]); } catch { problems.push(`${newBranch} is not a valid branch name`); }
    try { git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${newBranch}`]); problems.push(`branch ${newBranch} already exists`); } catch { /* free */ }
  }
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

/** Where --commit-notes puts the notes: in the release commit, for publish.yml to read after the merge. */
export const notesPath = (tag) => `.github/release-notes/${tag}.md`;

/** `release/v{version}` → `release/v1.2.3`; `{tag}` works too. */
export const branchName = (template, version) => template.replaceAll('{version}', version).replaceAll('{tag}', `v${version}`);

export function release(cwd, opts) {
  const current = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')).version;
  const version = nextVersion(current, opts);
  if (compareVersions(version, current) <= 0) throw new Error(`${version} is not after the current version ${current}`);
  const tag = `v${version}`;
  const tagIt = opts.tag !== false;
  const newBranch = opts.branch ? branchName(opts.branch, version) : null;
  const { branch, problems } = preflight(cwd, { tag, allowBranch: opts.allowBranch, newBranch });
  const log = changelog(cwd, { version, repoUrl: opts.repoUrl });
  const committedNotes = opts.commitNotes ? notesPath(tag) : null;
  const notesFile = opts.notesOut ?? (committedNotes ? join(cwd, committedNotes) : join(mkdtempSync(join(tmpdir(), 'farsight-release-')), 'release-notes.md'));
  const releaseBranch = newBranch ?? branch;
  const files = ['package.json', 'CHANGELOG.md', ...(committedNotes ? [committedNotes] : [])];
  const plan = { current, version, tag, branch: releaseBranch, from: branch, tagged: tagIt, prerelease: version.includes('-'), since: log.since, commits: log.commits.length, notesFile };

  if (opts.dryRun) {
    console.log(`release (dry run): ${current} → ${version} on ${branch}, ${plural(log.commits.length)} since ${sinceLabel(log.since)}`);
    if (problems.length) console.log(`\nwould refuse:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    const where = newBranch ? ` on a new branch ${newBranch}` : '';
    const tagging = tagIt ? ` and tag ${tag} (annotated, message = the notes below)` : ` and not tag it (${tag} is created after the release PR merges)`;
    console.log(`\nwould commit "chore(release): ${tag}" (${files.join(', ')})${where}${tagging}\n`);
    console.log(log.section);
    console.log('# Release notes\n');
    console.log(log.notes);
    return { ...plan, problems };
  }
  if (problems.length) throw new Error(`refusing to release:\n${problems.map((p) => `  - ${p}`).join('\n')}`);

  if (newBranch) git(cwd, ['switch', '-q', '-c', newBranch]);
  setRootVersion(cwd, version);
  const changelogFile = join(cwd, 'CHANGELOG.md');
  writeFileSync(changelogFile, prependSection(existsSync(changelogFile) ? readFileSync(changelogFile, 'utf8') : null, log.section, version));
  if (committedNotes) {
    mkdirSync(dirname(join(cwd, committedNotes)), { recursive: true });
    writeFileSync(join(cwd, committedNotes), log.notes);
  }
  writeFileSync(notesFile, log.notes);

  git(cwd, ['add', '--', ...files]);
  git(cwd, ['commit', '-q', '-m', `chore(release): ${tag}`, ...trailerArgs(opts.trailers)]);
  // verbatim: the notes are Markdown, and git's default cleanup would strip every `### heading` as a comment
  if (tagIt) git(cwd, ['tag', '-a', tag, '--cleanup=verbatim', '-F', notesFile]);
  const commit = git(cwd, ['rev-parse', '--short', 'HEAD']);
  setOutputs({ version, tag, prerelease: String(plan.prerelease), notes: notesFile, commit, branch: releaseBranch, tagged: String(tagIt) });

  console.log(`released ${tag} locally: commit ${commit}${newBranch ? ` on ${newBranch}` : ''}${tagIt ? '' : ', not tagged'}, ${plural(log.commits.length)} since ${sinceLabel(log.since)}`);
  console.log(`release notes: ${notesFile}`);
  console.log('\nnext:');
  if (tagIt) {
    console.log('  node scripts/pack.mjs                 # the tarball, stamped with this commit');
    console.log(`  git push --follow-tags origin ${releaseBranch}`);
    console.log(`  gh release create ${tag} build/farsight-cli-${version}.tgz --title "farsight-cli ${tag}" --notes-file ${notesFile}${plan.prerelease ? ' --prerelease' : ''} --verify-tag`);
  } else {
    console.log(`  git push -u origin ${releaseBranch}`);
    console.log(`  gh pr create --base ${branch} --head ${releaseBranch} --title "chore(release): ${tag}" --body-file ${notesFile} --label release`);
    console.log(`  # squash-merge it (gh pr merge --squash); publish.yml then tags ${tag} on the squash commit, packs and creates the GitHub Release`);
  }
  return { ...plan, commit, problems: [] };
}

// trailers go in through git's own --trailer, so they land in one block after the subject
function trailerArgs(trailers = []) {
  return trailers.flatMap((t) => ['--trailer', t]);
}

function main(argv) {
  const { values } = parseArgs({
    args: argv,
    allowNegative: true, // --no-tag
    options: {
      bump: { type: 'string' },
      version: { type: 'string' },
      prerelease: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      'allow-branch': { type: 'boolean', default: false },
      tag: { type: 'boolean', default: true },
      branch: { type: 'string' },
      'commit-notes': { type: 'boolean', default: false },
      'notes-out': { type: 'string' },
      'repo-url': { type: 'string' },
      trailer: { type: 'string', multiple: true },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    console.log('usage: node scripts/release.mjs (--bump patch|minor|major | --version X.Y.Z) [--prerelease beta.1] [--dry-run] [--allow-branch] [--no-tag] [--branch release/v{version}] [--commit-notes] [--notes-out <file>] [--trailer "Key: value"]...');
    return;
  }
  if (values.bump && values.version) throw new Error('pass --bump or --version, not both');
  const cwd = git(process.cwd(), ['rev-parse', '--show-toplevel']);
  release(cwd, {
    bump: values.bump, version: values.version || undefined, prerelease: values.prerelease || undefined,
    dryRun: values['dry-run'], allowBranch: values['allow-branch'], notesOut: values['notes-out'],
    repoUrl: values['repo-url'], trailers: values.trailer ?? [],
    tag: values.tag, branch: values.branch || undefined, commitNotes: values['commit-notes'],
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(`release: ${e.message}`); process.exit(1); }
}
