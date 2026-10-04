#!/usr/bin/env node
// Writes the changelog and the release notes from conventional commits.
//
//   node scripts/changelog.mjs --dry-run                    # print the next section and the notes
//   node scripts/changelog.mjs --version 0.2.0 --write      # prepend the section to CHANGELOG.md
//   node scripts/changelog.mjs --version 0.2.0 --notes n.md # write the release-notes body
//
// The range is `<since>..HEAD`. `since` is, in order: --since, the newest `v*`
// tag reachable from HEAD, the commit that added the newest released section
// to CHANGELOG.md (so the first tagged release does not repeat the seeded
// one), or nothing — the whole history. Merge commits and earlier release
// commits are skipped; a subject that is not a conventional commit lands
// under *Other* rather than being dropped. PRs are squash-merged, so each
// commit on main is one PR: its ` (#N)` suffix becomes a link to the PR.
// Zero dependencies (Node 24).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

/** The headings, in print order, and which commit types land under each. */
export const GROUPS = [
  ['breaking', 'Breaking'],
  ['feat', 'Features'],
  ['fix', 'Fixes'],
  ['perf', 'Performance'],
  ['docs', 'Docs'],
  ['test', 'Tests'],
  ['chore', 'Chores'],
  ['other', 'Other'],
];
const CHORE_TYPES = new Set(['chore', 'build', 'ci', 'refactor', 'style']);
// a release commit (`chore(release): v1.2.3`) describes the release, it is not a change in it
const RELEASE_SUBJECT = /^v?\d+\.\d+\.\d+/;
const SUBJECT = /^(?<type>[a-zA-Z]+)(?:\((?<scope>[^)]+)\))?(?<bang>!)?:\s+(?<subject>.+)$/;
const BREAKING_FOOTER = /^BREAKING[ -]CHANGE:\s*(?<note>.+)$/m;
// the ` (#123)` GitHub appends to a squash-merge subject
const PR_SUFFIX = /\s\(#(?<pr>\d+)\)$/;

export const UNRELEASED_HEAD = '## [Unreleased]';
const CHANGELOG_PREAMBLE = [
  '# Changelog',
  '',
  'Every release of `farsight-cli`, newest first. Generated from conventional commits by',
  '`scripts/changelog.mjs` when a release is cut (see [docs/RELEASING.md](docs/RELEASING.md)).',
  '',
].join('\n');
const UNRELEASED_BODY = 'Changes on `main` since the last release: `node scripts/changelog.mjs --dry-run` lists them.';

const plural = (n) => `${n} commit${n === 1 ? '' : 's'}`;
const git = (cwd, args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).toString();
const tryGit = (cwd, args) => { try { return git(cwd, args).trim(); } catch { return ''; } };

/** Parse one commit; `type` is the group key it lands under. */
export function parseCommit({ sha, short, subject, body = '', parents = [] }) {
  const pr = PR_SUFFIX.exec(subject.trim())?.groups.pr ?? null;
  const m = SUBJECT.exec(subject.trim().replace(PR_SUFFIX, ''));
  const footer = BREAKING_FOOTER.exec(body);
  const breaking = Boolean(m?.groups.bang || footer);
  let type = 'other';
  if (m) {
    const t = m.groups.type.toLowerCase();
    type = t === 'feat' || t === 'fix' || t === 'perf' || t === 'docs' || t === 'test' ? t
      : t === 'tests' ? 'test'
      : CHORE_TYPES.has(t) ? 'chore' : 'other';
  }
  return {
    sha, short,
    group: breaking ? 'breaking' : type,
    type,
    scope: m?.groups.scope ?? null,
    subject: m ? m.groups.subject.trim() : subject.trim().replace(PR_SUFFIX, ''),
    pr: pr ? Number(pr) : null,
    breaking,
    breakingNote: footer?.groups.note.trim() ?? null,
    merge: parents.length > 1,
  };
}

/** The commits in `<since>..HEAD` (or all of HEAD), oldest first, merges and release commits dropped. */
export function readCommits(cwd, since) {
  const range = since ? [`${since}..HEAD`] : ['HEAD'];
  const raw = tryGit(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'])
    ? git(cwd, ['log', '--reverse', '--format=%H%x1f%h%x1f%P%x1f%s%x1f%b%x1e', ...range])
    : '';
  return raw.split('\x1e').map((r) => r.replace(/^\n/, '')).filter(Boolean).map((r) => {
    const [sha, short, parents, subject, body] = r.split('\x1f');
    return parseCommit({ sha, short, subject, body, parents: parents.split(' ').filter(Boolean) });
  }).filter((c) => !c.merge && !(c.type === 'chore' && c.scope === 'release' && RELEASE_SUBJECT.test(c.subject)));
}

/** Where the next release starts: --since, the newest reachable v* tag, the commit that seeded the newest released section, or null. */
export function resolveSince(cwd, explicit) {
  if (explicit) return explicit;
  const tag = tryGit(cwd, ['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*', 'HEAD']);
  if (tag) return tag;
  const file = join(cwd, 'CHANGELOG.md');
  if (!existsSync(file)) return null;
  const released = /^## \[(\d+\.\d+\.\d+[^\]]*)\]/m.exec(readFileSync(file, 'utf8'));
  if (!released) return null;
  // the oldest commit whose diff added that heading: everything before it is in the seeded section
  const adds = tryGit(cwd, ['log', '--format=%H', '-S', `## [${released[1]}]`, '--', 'CHANGELOG.md']).split('\n').filter(Boolean);
  return adds.at(-1) ?? null;
}

/** https://github.com/owner/repo, from --repo-url, the Actions env, the origin remote, or package.json. */
export function resolveRepoUrl(cwd, explicit) {
  const norm = (u) => u?.trim()
    .replace(/^git\+/, '')
    .replace(/^git@([^:]+):/, 'https://$1/')
    .replace(/^ssh:\/\/git@/, 'https://')
    .replace(/\.git$/, '')
    .replace(/\/$/, '') || null;
  if (explicit) return norm(explicit);
  if (process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY) return `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}`;
  const origin = tryGit(cwd, ['remote', 'get-url', 'origin']);
  if (origin) return norm(origin);
  try {
    const repo = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')).repository;
    return norm(typeof repo === 'string' ? repo : repo?.url);
  } catch { return null; }
}

function line(c, repoUrl) {
  const scope = c.scope ? `**${c.scope}:** ` : '';
  const link = repoUrl ? `[${c.short}](${repoUrl}/commit/${c.sha})` : `\`${c.short}\``;
  const note = c.breakingNote ? ` — ${c.breakingNote}` : '';
  const pr = c.pr ? (repoUrl ? ` [#${c.pr}](${repoUrl}/pull/${c.pr})` : ` #${c.pr}`) : '';
  return `- ${scope}${c.subject}${note}${pr} (${link})`;
}

/** The grouped body: one `### Heading` per non-empty group, in GROUPS order. */
export function renderGroups(commits, repoUrl) {
  if (!commits.length) return '_No changes._\n';
  const out = [];
  for (const [key, heading] of GROUPS) {
    const in_ = commits.filter((c) => c.group === key);
    if (!in_.length) continue;
    out.push(`### ${heading}`, '', ...in_.map((c) => line(c, repoUrl)), '');
  }
  return out.join('\n');
}

export function renderSection({ version, date, commits, repoUrl }) {
  return `## [${version}] — ${date}\n\n${renderGroups(commits, repoUrl)}`;
}

export function tarballUrl(repoUrl, version) {
  return `${repoUrl ?? '<repository>'}/releases/download/v${version}/farsight-cli-${version}.tgz`;
}

export function renderNotes({ version, commits, repoUrl }) {
  const guide = repoUrl ? `${repoUrl}/blob/v${version}/docs/GETTING-STARTED.md` : 'docs/GETTING-STARTED.md';
  return [
    renderGroups(commits, repoUrl).trimEnd(),
    '',
    '### Install',
    '',
    '```sh',
    `npm install -g ${tarballUrl(repoUrl, version)}`,
    `farsight --version   # farsight ${version} · built … · commit …`,
    '```',
    '',
    `Needs Node 24 or newer. Then follow [Getting started](${guide}).`,
    '',
  ].join('\n');
}

/** CHANGELOG.md with `section` placed under an emptied `## [Unreleased]` head. Throws if the version is already there. */
export function prependSection(existing, section, version) {
  const text = existing ?? `${CHANGELOG_PREAMBLE}\n${UNRELEASED_HEAD}\n\n${UNRELEASED_BODY}\n`;
  if (new RegExp(`^## \\[${version.replace(/[.+]/g, '\\$&')}\\]`, 'm').test(text)) {
    throw new Error(`CHANGELOG.md already has a section for ${version}`);
  }
  const head = text.indexOf(UNRELEASED_HEAD);
  const firstRelease = text.search(/^## \[(?!Unreleased\])/m);
  const before = head >= 0 ? text.slice(0, head) : (firstRelease >= 0 ? text.slice(0, firstRelease) : `${text.trimEnd()}\n\n`);
  const after = firstRelease >= 0 ? text.slice(firstRelease) : '';
  return `${before}${UNRELEASED_HEAD}\n\n${UNRELEASED_BODY}\n\n${section.trimEnd()}\n${after ? `\n${after}` : ''}`;
}

/** A tag as it is, a seed commit shortened, or the start of history. */
export function sinceLabel(since) {
  return !since ? 'the first commit' : /^[0-9a-f]{40}$/.test(since) ? since.slice(0, 7) : since;
}

export function today() { return new Date().toISOString().slice(0, 10); }

/** Everything the CLI prints or writes, for one release. */
export function changelog(cwd, { version, since, repoUrl, date } = {}) {
  const v = version ?? JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')).version;
  const from = resolveSince(cwd, since);
  const url = resolveRepoUrl(cwd, repoUrl);
  const commits = readCommits(cwd, from);
  return {
    version: v, since: from, repoUrl: url, commits,
    section: renderSection({ version: v, date: date ?? today(), commits, repoUrl: url }),
    notes: renderNotes({ version: v, commits, repoUrl: url }),
  };
}

function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      version: { type: 'string' },
      since: { type: 'string' },
      write: { type: 'boolean', default: false },
      notes: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      'repo-url': { type: 'string' },
      date: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    console.log('usage: node scripts/changelog.mjs [--version X.Y.Z] [--since <tag|sha>] [--write] [--notes <file>] [--dry-run] [--repo-url <url>] [--date YYYY-MM-DD]');
    return;
  }
  const cwd = tryGit(process.cwd(), ['rev-parse', '--show-toplevel']) || process.cwd();
  const r = changelog(cwd, { version: values.version, since: values.since, repoUrl: values['repo-url'], date: values.date });
  const dry = values['dry-run'] || (!values.write && !values.notes);
  if (dry) {
    console.log(`# CHANGELOG.md section (${plural(r.commits.length)} since ${sinceLabel(r.since)})\n`);
    console.log(r.section);
    console.log('# Release notes\n');
    console.log(r.notes);
    return;
  }
  if (values.write) {
    const file = join(cwd, 'CHANGELOG.md');
    writeFileSync(file, prependSection(existsSync(file) ? readFileSync(file, 'utf8') : null, r.section, r.version));
    console.log(`CHANGELOG.md: added [${r.version}] (${plural(r.commits.length)} since ${sinceLabel(r.since)})`);
  }
  if (values.notes) {
    writeFileSync(values.notes, r.notes);
    console.log(`release notes: ${values.notes}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(`changelog: ${e.message}`); process.exit(1); }
}
