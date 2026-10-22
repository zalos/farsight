// Advisory database acquisition: the only network step, separate from every scan. It is an owner action
// (`tool.acquire`) confirmed by a spent receipt for exactly this request, fetches only the OSV project's published
// per-ecosystem archives from one allowlisted origin, refuses redirects and anything over the stated size, checks the
// origin's own MD5, and stores each archive by SHA-256 with a manifest of its provenance in an owner-only folder. A
// scan never downloads: it receives these snapshots by digest and runs with no network.
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants as FS, fstatSync, fsyncSync, openSync, readSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { ActionIntent } from '../../contracts/policy.js';
import { canonicalDigest } from '../../policy/digest.js';
import { intentDigest, receiptAuthority, stamp } from '../../policy/receipts.js';
import { ensurePrivateDir, readPrivateFile, writePrivateFileAtomic } from '../../policy/user-state.js';
import { osvFail } from './errors.js';
import type { Ecosystem } from './job.js';

export const ADVISORY_ORIGIN = 'https://osv-vulnerabilities.storage.googleapis.com';
export const ADVISORY_ECOSYSTEMS: readonly Ecosystem[] = Object.freeze(['npm', 'Maven']);
/** The largest archive a request may allow: the npm archive was 219 MB on 2026-10-22; anything multi-GB is refused. */
export const MAX_ACQUISITION_BYTES = 512 * 1024 * 1024;

export const advisoryUrl = (ecosystem: Ecosystem): string => `${ADVISORY_ORIGIN}/${ecosystem}/all.zip`;

/** One acquired archive and where it came from. */
export interface AdvisorySnapshot {
  readonly schema: 'sentinel-advisory-snapshot/draft-1';
  readonly ecosystem: Ecosystem;
  readonly source: string;
  readonly sha256: string;
  /** The origin's MD5 (base64), which the bytes were checked against. */
  readonly md5: string;
  readonly size: number;
  /** When the origin last changed the archive: the age of the advisory data. */
  readonly sourceLastModified: string;
  readonly etag: string | null;
  readonly acquiredAt: string;
}

export interface AcquisitionRequest {
  readonly ecosystems: readonly Ecosystem[];
  readonly maxBytesPerEcosystem: number;
}

/** The exact intent the owner confirms before anything is fetched. */
export function acquisitionIntent(request: AcquisitionRequest): ActionIntent {
  const urls = [...request.ecosystems].sort().map(advisoryUrl);
  return {
    action: 'tool.acquire',
    input: canonicalDigest({ kind: 'sentinel-advisory-acquisition/1', urls, maxBytesPerEcosystem: request.maxBytesPerEcosystem }),
    effects: ['network', 'local-artifacts'],
    budget: { maxTokens: null, maxCost: null, currency: null },
    scope: { profile: null, provider: null, targets: urls },
  };
}

export type Transport = (url: string, init: { redirect: 'error'; signal?: AbortSignal }) => Promise<Response>;

function md5Of(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(',')) { const m = /^\s*md5=([A-Za-z0-9+/=]{24})\s*$/.exec(part); if (m) return m[1]!; }
  return null;
}

function checkRequest(request: AcquisitionRequest): void {
  if (!request.ecosystems.length || new Set(request.ecosystems).size !== request.ecosystems.length) osvFail('sentinel.osv.acquisitionRefused', 'name each ecosystem once');
  for (const e of request.ecosystems) if (!ADVISORY_ECOSYSTEMS.includes(e)) osvFail('sentinel.osv.acquisitionRefused', `no allowlisted source for ${String(e)}`);
  if (!Number.isSafeInteger(request.maxBytesPerEcosystem) || request.maxBytesPerEcosystem < 1 || request.maxBytesPerEcosystem > MAX_ACQUISITION_BYTES) {
    osvFail('sentinel.osv.acquisitionRefused', `the size bound is between 1 byte and ${MAX_ACQUISITION_BYTES}`);
  }
}

/**
 * Fetches the requested archives. `receipt` must be the owner's spent receipt for `acquisitionIntent(request)`.
 * `transport` is the network seam (the platform fetch by default); it is called only with allowlisted URLs.
 */
export async function acquireAdvisorySnapshots(request: AcquisitionRequest, options: { dir: string; receipt: unknown; transport?: Transport; now?: () => Date; signal?: AbortSignal }): Promise<readonly AdvisorySnapshot[]> {
  checkRequest(request);
  const authority = receiptAuthority(options.receipt);
  if (!authority || authority.action !== 'tool.acquire' || authority.intentDigest !== intentDigest(acquisitionIntent(request))) {
    osvFail('sentinel.osv.acquisitionUnauthorized', 'acquisition needs the owner’s spent receipt for exactly this request');
  }
  ensurePrivateDir(options.dir, 'sentinel.policy.trustDirUnsafe');
  const transport: Transport = options.transport ?? ((url, init) => fetch(url, init));
  const now = options.now ?? (() => new Date());
  const out: AdvisorySnapshot[] = [];
  for (const ecosystem of [...request.ecosystems].sort()) {
    const url = advisoryUrl(ecosystem);
    let res: Response;
    try { res = await transport(url, { redirect: 'error', ...(options.signal ? { signal: options.signal } : {}) }); } catch {
      return osvFail('sentinel.osv.acquisitionFailed', `${ecosystem}: the request failed`);
    }
    if (res.status !== 200 || (res.url && res.url !== url)) osvFail('sentinel.osv.acquisitionFailed', `${ecosystem}: unexpected response ${res.status}`);
    const declared = Number(res.headers.get('content-length') ?? NaN);
    if (Number.isFinite(declared) && declared > request.maxBytesPerEcosystem) osvFail('sentinel.osv.acquisitionRefused', `${ecosystem}: ${declared} bytes is over the bound`);
    const md5 = md5Of(res.headers.get('x-goog-hash'));
    if (!md5) osvFail('sentinel.osv.acquisitionFailed', `${ecosystem}: the origin did not state an MD5`);
    if (!res.body) osvFail('sentinel.osv.acquisitionFailed', `${ecosystem}: empty response`);
    const tmp = join(options.dir, `.acquire-${randomBytes(8).toString('hex')}.partial`);
    const fd = openSync(tmp, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | (FS.O_NOFOLLOW ?? 0), 0o600);
    const sha = createHash('sha256');
    const m5 = createHash('md5');
    let size = 0;
    try {
      const reader = res.body!.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > request.maxBytesPerEcosystem) { await reader.cancel().catch(() => {}); osvFail('sentinel.osv.acquisitionRefused', `${ecosystem}: over the bound while downloading`); }
        sha.update(value); m5.update(value);
        for (let off = 0; off < value.byteLength;) off += writeSync(fd, value, off, value.byteLength - off);
      }
      fsyncSync(fd);
    } catch (e) {
      closeSync(fd); try { unlinkSync(tmp); } catch { /* best effort */ }
      throw e;
    }
    closeSync(fd);
    if (Number.isFinite(declared) && size !== declared) { unlinkSync(tmp); osvFail('sentinel.osv.acquisitionFailed', `${ecosystem}: the download was cut short`); }
    if (m5.digest('base64') !== md5) { unlinkSync(tmp); osvFail('sentinel.osv.acquisitionFailed', `${ecosystem}: the bytes do not match the origin’s MD5`); }
    const hex = sha.digest('hex');
    renameSync(tmp, join(options.dir, `${hex}.zip`));
    const lastModified = new Date(res.headers.get('last-modified') ?? '');
    const snapshot: AdvisorySnapshot = Object.freeze({
      schema: 'sentinel-advisory-snapshot/draft-1', ecosystem, source: url, sha256: `sha256:${hex}`, md5: md5!, size,
      sourceLastModified: Number.isNaN(lastModified.getTime()) ? stamp(now()) : stamp(lastModified),
      etag: res.headers.get('etag'), acquiredAt: stamp(now()),
    });
    writePrivateFileAtomic(options.dir, `${hex}.json`, Buffer.from(JSON.stringify(snapshot)), 'sentinel.policy.trustDirUnsafe');
    out.push(snapshot);
  }
  return Object.freeze(out);
}

/** A stored snapshot, re-hashed against its manifest before any scan may use it. */
export function loadAdvisorySnapshot(dir: string, sha256: string): { snapshot: AdvisorySnapshot; path: string } {
  const m = /^sha256:([0-9a-f]{64})$/.exec(sha256);
  if (!m) return osvFail('sentinel.osv.snapshotInvalid', 'not a snapshot digest');
  const bytes = readPrivateFile(join(dir, `${m[1]}.json`), 64 * 1024, 'sentinel.policy.trustDirUnsafe');
  if (!bytes) return osvFail('sentinel.osv.snapshotInvalid', 'no such snapshot');
  let s: AdvisorySnapshot;
  try { s = JSON.parse(bytes.toString('utf8')); } catch { return osvFail('sentinel.osv.snapshotInvalid', 'the snapshot manifest is not JSON'); }
  if (s?.schema !== 'sentinel-advisory-snapshot/draft-1' || s.sha256 !== sha256 || !ADVISORY_ECOSYSTEMS.includes(s.ecosystem)) osvFail('sentinel.osv.snapshotInvalid', 'the snapshot manifest does not describe this archive');
  const path = join(dir, `${m[1]}.zip`);
  const fd = openSync(path, FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0));
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size !== s.size || (st.mode & 0o077) !== 0) osvFail('sentinel.osv.snapshotInvalid', 'the archive is not the private file its manifest describes');
    const hash = createHash('sha256');
    const buf = Buffer.alloc(1 << 20);
    for (let off = 0; ;) { const n = readSync(fd, buf, 0, buf.length, off); if (!n) break; hash.update(buf.subarray(0, n)); off += n; }
    if (`sha256:${hash.digest('hex')}` !== sha256) osvFail('sentinel.osv.snapshotInvalid', 'the archive does not match its digest');
  } finally { closeSync(fd); }
  return { snapshot: Object.freeze({ ...s }), path };
}
