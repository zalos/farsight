#!/usr/bin/env node
// The release manifest: which independently versioned packages one GitHub Release carries, each with its own version,
// tarball name and download URL. Written by scripts/release.mjs into the release commit
// (.github/release-manifests/vX.Y.Z.json), validated by publish.yml against the packages' own manifests, completed
// with each packed tarball's size and SHA-256, and uploaded beside the tarballs as `release-manifest.json`, where the
// post-release verifier (scripts/verify-release.mjs) reads it. No package's version is ever inferred from another's:
// Sentinel's comes from packages/sentinel/package.json, which only an explicit `--sentinel-version` changes.
//
//   node scripts/release-manifest.mjs validate --tag vX.Y.Z            # the committed manifest matches the packages
//   node scripts/release-manifest.mjs assets --tag vX.Y.Z --repo-url <url> --commit <sha> --out <file>
//       # after packing: the asset manifest with sizes and digests of build/farsight-cli-<v>.tgz and build/sentinel/farsight-sentinel-<v>.tgz
//   node scripts/release-manifest.mjs lines --manifest <file>          # one `name<TAB>version<TAB>file<TAB>url` line per package
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

export const MANIFEST_SCHEMA = 'farsight-release-manifest/v1';
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{7,40}$/;

/** Each package a release carries: where its version lives and where its tarball is packed. */
export const PACKAGES = Object.freeze([
  Object.freeze({ key: 'farsight', name: 'farsight-cli', manifest: 'package.json', tarball: (v) => `build/farsight-cli-${v}.tgz`, bin: 'farsight' }),
  Object.freeze({ key: 'sentinel', name: 'farsight-sentinel', manifest: 'packages/sentinel/package.json', tarball: (v) => `build/sentinel/farsight-sentinel-${v}.tgz`, bin: 'farsight-sentinel' }),
]);

export const manifestPath = (tag) => `.github/release-manifests/${tag}.json`;
export const fileName = (name, version) => `${name}-${version}.tgz`;
/** The download URL of one release asset; derived per package from its own name and version. */
export const assetUrl = (repoUrl, tag, file) => `${repoUrl.replace(/\/+$/, '')}/releases/download/${tag}/${file}`;

const fail = (message) => { throw new Error(message); };
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

/** The packages present in this checkout (Sentinel is optional in a workspace copy without it). */
export function presentPackages(cwd) {
  return PACKAGES.filter((p) => existsSync(join(cwd, p.manifest)));
}

/** The committed manifest for a release: the tag and each package's own version, nothing derived. */
export function buildManifest(tag, versions) {
  if (!TAG.test(tag)) fail(`not a release tag: ${tag}`);
  const packages = {};
  for (const p of PACKAGES) {
    const v = versions[p.key];
    if (v === undefined) continue;
    if (!SEMVER.test(v)) fail(`${p.name}: not a version: ${v}`);
    packages[p.key] = { name: p.name, version: v, file: fileName(p.name, v) };
  }
  if (!packages.farsight) fail('a release always carries farsight-cli');
  if (`v${packages.farsight.version}` !== tag) fail(`the tag ${tag} is not farsight-cli's version ${packages.farsight.version}`);
  return { schema: MANIFEST_SCHEMA, tag, packages };
}

/** Checks a manifest's shape; returns it. Every field is checked, unknown fields are refused. */
export function checkManifest(value, { assets = false } = {}) {
  const keys = (o, want, where) => {
    const got = Object.keys(o ?? {}).sort().join(',');
    if (got !== [...want].sort().join(',')) fail(`${where}: expected fields ${[...want].sort().join(', ')}, got ${got || 'none'}`);
  };
  if (!value || typeof value !== 'object') fail('the release manifest is not an object');
  keys(value, assets ? ['schema', 'tag', 'commit', 'repoUrl', 'packages'] : ['schema', 'tag', 'packages'], 'manifest');
  if (value.schema !== MANIFEST_SCHEMA) fail(`manifest schema is ${value.schema}, not ${MANIFEST_SCHEMA}`);
  if (!TAG.test(value.tag)) fail(`manifest tag ${value.tag} is not a release tag`);
  if (assets && (!COMMIT.test(value.commit ?? '') || !/^https:\/\/[^\s]+$/.test(value.repoUrl ?? ''))) fail('asset manifest: commit or repoUrl is malformed');
  const known = new Map(PACKAGES.map((p) => [p.key, p]));
  if (!value.packages || typeof value.packages !== 'object' || !value.packages.farsight) fail('manifest: packages must include farsight');
  for (const [key, entry] of Object.entries(value.packages)) {
    const p = known.get(key);
    if (!p) fail(`manifest: unknown package ${key}`);
    keys(entry, assets ? ['name', 'version', 'file', 'url', 'bytes', 'sha256'] : ['name', 'version', 'file'], `manifest.packages.${key}`);
    if (entry.name !== p.name || !SEMVER.test(entry.version) || entry.file !== fileName(p.name, entry.version)) fail(`manifest.packages.${key}: name, version or file is wrong`);
    if (assets && (entry.url !== assetUrl(value.repoUrl, value.tag, entry.file) || !Number.isSafeInteger(entry.bytes) || entry.bytes <= 0 || !DIGEST.test(entry.sha256))) {
      fail(`manifest.packages.${key}: url, bytes or sha256 is wrong`);
    }
  }
  if (`v${value.packages.farsight.version}` !== value.tag) fail(`manifest tag ${value.tag} is not farsight-cli's version`);
  return value;
}

/** The committed manifest must name exactly the versions the packages' own manifests carry at this commit. */
export function validateCommitted(cwd, tag) {
  const file = join(cwd, manifestPath(tag));
  if (!existsSync(file)) fail(`${manifestPath(tag)} is missing from the release commit`);
  const manifest = checkManifest(readJson(file));
  if (manifest.tag !== tag) fail(`${manifestPath(tag)} names ${manifest.tag}`);
  const present = presentPackages(cwd);
  const keys = Object.keys(manifest.packages).sort().join(',');
  if (keys !== present.map((p) => p.key).sort().join(',')) fail(`the manifest carries ${keys}; this checkout has ${present.map((p) => p.key).join(', ')}`);
  for (const p of present) {
    const actual = readJson(join(cwd, p.manifest)).version;
    if (actual !== manifest.packages[p.key].version) fail(`${p.name}: the manifest says ${manifest.packages[p.key].version}, ${p.manifest} says ${actual}`);
  }
  return manifest;
}

const sha256File = (file) => `sha256:${createHash('sha256').update(readFileSync(file)).digest('hex')}`;

/** The uploaded manifest: the committed one plus each packed tarball's URL, size and digest. */
export function assetManifest(cwd, tag, { repoUrl, commit }) {
  const manifest = validateCommitted(cwd, tag);
  const packages = {};
  for (const [key, entry] of Object.entries(manifest.packages)) {
    const p = PACKAGES.find((x) => x.key === key);
    const tarball = join(cwd, p.tarball(entry.version));
    if (!existsSync(tarball)) fail(`${p.tarball(entry.version)} is missing; pack ${p.name} first`);
    packages[key] = { ...entry, url: assetUrl(repoUrl, tag, entry.file), bytes: statSync(tarball).size, sha256: sha256File(tarball) };
  }
  return checkManifest({ schema: MANIFEST_SCHEMA, tag, commit, repoUrl: repoUrl.replace(/\/+$/, ''), packages }, { assets: true });
}

/** `name<TAB>version<TAB>file<TAB>url` per package, for shell steps that must not re-derive anything. */
export function manifestLines(manifest) {
  return Object.values(manifest.packages).map((e) => [e.name, e.version, e.file, e.url ?? ''].join('\t')).join('\n') + '\n';
}

function main(argv) {
  const [command, ...rest] = argv;
  const { values } = parseArgs({ args: rest, options: { tag: { type: 'string' }, 'repo-url': { type: 'string' }, commit: { type: 'string' }, out: { type: 'string' }, manifest: { type: 'string' } } });
  const cwd = process.cwd();
  if (command === 'validate') {
    const m = validateCommitted(cwd, values.tag ?? fail('--tag is required'));
    process.stdout.write(manifestLines(m));
  } else if (command === 'assets') {
    const m = assetManifest(cwd, values.tag ?? fail('--tag is required'), { repoUrl: values['repo-url'] ?? fail('--repo-url is required'), commit: values.commit ?? fail('--commit is required') });
    writeFileSync(values.out ?? fail('--out is required'), JSON.stringify(m, null, 2) + '\n');
    process.stdout.write(manifestLines(m));
  } else if (command === 'lines') {
    process.stdout.write(manifestLines(checkManifest(readJson(values.manifest ?? fail('--manifest is required')), { assets: true })));
  } else {
    fail('usage: node scripts/release-manifest.mjs validate|assets|lines …');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(`release-manifest: ${e.message}`); process.exit(1); }
}
