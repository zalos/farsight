#!/usr/bin/env node
// The post-release check, re-runnable at any time: reads a published release's `release-manifest.json`, downloads
// each tarball it names from its own URL and checks its size and SHA-256 against the manifest, then runs the clean
// npm acceptance (scripts/npm-acceptance.mjs) installing those exact GitHub Release URLs: farsight-cli alone,
// farsight-sentinel alone and both, each globally and into a project. It changes nothing on GitHub and does not
// depend on publish.yml running again (a re-run of publish skips a tag that exists).
//
//   node scripts/verify-release.mjs --tag vX.Y.Z [--repo-url https://github.com/zalos/farsight] [--report <file>]
//
// A release verification needs every gate passed: a pending gate fails it (exit 2). `--diagnostic` reports pending
// gates and exits 0, labelled as not a verification; no workflow passes it.
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assetUrl, checkManifest } from './release-manifest.mjs';
import { runAcceptance } from './npm-acceptance.mjs';

export const MANIFEST_ASSET = 'release-manifest.json';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The repository URL from the root manifest, as the changelog derives it. */
export function defaultRepoUrl() {
  const repo = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).repository;
  const url = typeof repo === 'string' ? repo : repo?.url;
  return url?.replace(/^git\+/, '').replace(/\.git$/, '');
}

async function download(url, fetchImpl) {
  const res = await fetchImpl(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Reads and checks the published manifest and tarballs. Returns the manifest and, per package, the bytes it checked:
 * those exact bytes are what the acceptance installs (a global install from them, a project install from the URL with
 * their integrity pinned), so a server that answers a later request with other bytes cannot change what is tested.
 */
export async function checkPublished({ tag, repoUrl, fetchImpl = fetch, loopback = false }) {
  const manifest = checkManifest(
    JSON.parse((await download(assetUrl(repoUrl, tag, MANIFEST_ASSET), fetchImpl)).toString('utf8')),
    { assets: true, loopback },
  );
  if (manifest.tag !== tag) throw new Error(`the published manifest names ${manifest.tag}, not ${tag}`);
  if (manifest.repoUrl !== repoUrl.replace(/\/+$/, ''))
    throw new Error(`the published manifest names ${manifest.repoUrl}, not ${repoUrl}`);
  const verified = {};
  for (const [key, entry] of Object.entries(manifest.packages)) {
    const bytes = await download(entry.url, fetchImpl);
    const sha256 = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    if (bytes.length !== entry.bytes || sha256 !== entry.sha256)
      throw new Error(
        `${entry.file}: the published bytes (${bytes.length}, ${sha256}) are not the manifest's (${entry.bytes}, ${entry.sha256})`,
      );
    verified[key] = bytes;
  }
  return Object.assign(manifest, { verified });
}

export async function verifyRelease({
  tag,
  repoUrl = defaultRepoUrl(),
  fetchImpl = fetch,
  loopback = false,
  modes,
  log = console.log,
}) {
  if (!repoUrl) throw new Error('no repository URL: pass --repo-url');
  const { verified, ...manifest } = await checkPublished({ tag, repoUrl, fetchImpl, loopback });
  log(
    `release ${tag}: ${Object.values(manifest.packages)
      .map((p) => `${p.name} ${p.version}`)
      .join(', ')}; commit ${manifest.commit}; bytes and digests match`,
  );
  const held = mkdtempSync(join(tmpdir(), 'farsight-verify-'));
  try {
    chmodSync(held, 0o700);
    const source = (key) => {
      const entry = manifest.packages[key];
      if (!entry) return undefined;
      const file = join(held, entry.file);
      writeFileSync(file, verified[key], { mode: 0o600 });
      return { url: entry.url, file, sha256: entry.sha256 };
    };
    const report = await runAcceptance({
      farsight: source('farsight'),
      sentinel: source('sentinel'),
      ...(modes ? { modes } : {}),
      log,
      expect: {
        farsight: manifest.packages.farsight.version,
        sentinel: manifest.packages.sentinel?.version,
        commit: manifest.commit,
      },
    });
    return { manifest, ...report };
  } finally {
    rmSync(held, { recursive: true, force: true });
  }
}

async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      tag: { type: 'string' },
      'repo-url': { type: 'string' },
      diagnostic: { type: 'boolean', default: false },
      report: { type: 'string' },
    },
  });
  if (!values.tag) throw new Error('--tag is required');
  const result = await verifyRelease({ tag: values.tag, repoUrl: values['repo-url'] ?? defaultRepoUrl() });
  if (values.report) writeFileSync(values.report, JSON.stringify(result, null, 2) + '\n');
  const s = result.summary;
  console.log(
    `\nverify-release ${values.tag}: ${s.passed} passed, ${s.failed} failed, ${s.pending} pending${s.pending ? ` (blocked by ${s.blockedBy.join(', ')})` : ''}`,
  );
  if (s.failed) return 1;
  if (s.pending && !values.diagnostic) {
    console.log('pending gates: this release does not pass verification');
    return 2;
  }
  if (s.pending) console.log('--diagnostic: pending gates reported; this is not a release verification');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`verify-release: ${e.message}`);
      process.exit(1);
    },
  );
}
