// Checks-bundle acquisition: the only network step, separate from every scan. It is an owner action (`tool.acquire`)
// confirmed by a spent receipt for exactly the pinned bundle, fetches only that OCI manifest and its one layer by
// digest from the allowlisted registry (following only the registry's own redirect to its blob host), checks every
// byte against the pins, and stores the archive by SHA-256 with a manifest of its provenance in an owner-only folder.
// Because the request names digests, an acquisition is immutable: it can only ever yield those bytes. A scan never
// downloads: it receives the archive by digest and runs with no network.
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants as FS, fstatSync, fsyncSync, openSync, readSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { ActionIntent } from '../../contracts/policy.js';
import { canonicalDigest } from '../../policy/digest.js';
import { intentDigest, receiptAuthority, stamp } from '../../policy/receipts.js';
import { ensurePrivateDir, readPrivateFile, writePrivateFileAtomic } from '../../policy/user-state.js';
import { TRIVY_CHECKS_BUNDLE } from './adapter.js';
import { trivyFail } from './errors.js';

export const CHECKS_REGISTRY = 'https://ghcr.io';
/** The only host the registry's blob redirect may lead to. */
export const CHECKS_BLOB_HOST = 'https://pkg-containers.githubusercontent.com/';
const REPO_PATH = 'aquasecurity/trivy-checks';
export const checksManifestUrl = () => `${CHECKS_REGISTRY}/v2/${REPO_PATH}/manifests/${TRIVY_CHECKS_BUNDLE.manifest}`;
export const checksBlobUrl = () => `${CHECKS_REGISTRY}/v2/${REPO_PATH}/blobs/${TRIVY_CHECKS_BUNDLE.layer}`;
const tokenUrl = () => `${CHECKS_REGISTRY}/token?scope=repository:${REPO_PATH}:pull&service=ghcr.io`;

/** One acquired checks bundle and where it came from. */
export interface ChecksBundle {
  readonly schema: 'sentinel-trivy-checks/draft-1';
  readonly name: 'trivy-checks';
  readonly version: string;
  readonly commit: string;
  readonly repository: string;
  readonly manifest: string;
  readonly layer: string;
  readonly size: number;
  /** When the bundle was published (the manifest's own annotation): its age. */
  readonly created: string;
  readonly acquiredAt: string;
}

/** The exact intent the owner confirms before anything is fetched: the pinned bundle and nothing else. */
export function checksAcquisitionIntent(): ActionIntent {
  const targets = [tokenUrl(), checksManifestUrl(), checksBlobUrl()];
  return {
    action: 'tool.acquire',
    input: canonicalDigest({ kind: 'sentinel-trivy-checks-acquisition/1', repository: TRIVY_CHECKS_BUNDLE.repository, manifest: TRIVY_CHECKS_BUNDLE.manifest, layer: TRIVY_CHECKS_BUNDLE.layer, size: TRIVY_CHECKS_BUNDLE.size }),
    effects: ['network', 'local-artifacts'],
    budget: { maxTokens: null, maxCost: null, currency: null },
    scope: { profile: null, provider: null, targets },
  };
}

export type ChecksTransport = (url: string, init: { redirect: 'error' | 'manual'; headers?: Record<string, string>; signal?: AbortSignal }) => Promise<Response>;

const used = new WeakSet<object>();
const sha = (b: Uint8Array) => `sha256:${createHash('sha256').update(b).digest('hex')}`;

async function boundedBytes(res: Response, max: number, what: string): Promise<Buffer> {
  if (!res.body) return trivyFail('sentinel.trivy.acquisitionFailed', `${what}: empty response`);
  const declared = Number(res.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > max) trivyFail('sentinel.trivy.acquisitionRefused', `${what}: ${declared} bytes is over the bound`);
  const parts: Buffer[] = [];
  let size = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel().catch(() => {}); trivyFail('sentinel.trivy.acquisitionRefused', `${what}: over the bound while downloading`); }
    parts.push(Buffer.from(value));
  }
  return Buffer.concat(parts);
}

/**
 * Fetches the pinned bundle. `receipt` must be the owner's spent receipt for `checksAcquisitionIntent()`. `transport`
 * is the network seam (the platform fetch by default); it is called only with the allowlisted URLs above and the one
 * blob redirect, to which no credential is sent.
 */
export async function acquireChecksBundle(options: { dir: string; receipt: unknown; transport?: ChecksTransport; now?: () => Date; signal?: AbortSignal }): Promise<ChecksBundle> {
  const authority = receiptAuthority(options.receipt);
  if (!authority || authority.action !== 'tool.acquire' || authority.intentDigest !== intentDigest(checksAcquisitionIntent())) {
    trivyFail('sentinel.trivy.acquisitionUnauthorized', 'acquisition needs the owner’s spent receipt for exactly the pinned checks bundle');
  }
  if (used.has(options.receipt as object)) trivyFail('sentinel.trivy.acquisitionUnauthorized', 'this confirmation was already used for an acquisition');
  used.add(options.receipt as object);
  ensurePrivateDir(options.dir, 'sentinel.policy.trustDirUnsafe');
  const transport: ChecksTransport = options.transport ?? ((url, init) => fetch(url, init));
  const now = options.now ?? (() => new Date());
  const signal = options.signal ? { signal: options.signal } : {};
  const get = async (url: string, init: Parameters<ChecksTransport>[1], what: string) => {
    try { return await transport(url, { ...init, ...signal }); } catch { return trivyFail('sentinel.trivy.acquisitionFailed', `${what}: the request failed`); }
  };

  // An anonymous pull token for this one repository: the registry's own scheme, no inherited login.
  const tokenRes = await get(tokenUrl(), { redirect: 'error' }, 'token');
  if (tokenRes.status !== 200) trivyFail('sentinel.trivy.acquisitionFailed', `token: unexpected response ${tokenRes.status}`);
  let token: unknown;
  try { token = JSON.parse((await boundedBytes(tokenRes, 16_384, 'token')).toString('utf8')).token; } catch { token = undefined; }
  if (typeof token !== 'string' || !/^[A-Za-z0-9._~+/=-]{1,8192}$/.test(token)) trivyFail('sentinel.trivy.acquisitionFailed', 'token: not a bearer token');
  const auth = { Authorization: `Bearer ${token as string}` };

  // The manifest, by digest: its bytes must hash to the pin and name exactly the pinned layer.
  const manRes = await get(checksManifestUrl(), { redirect: 'error', headers: { ...auth, Accept: 'application/vnd.oci.image.manifest.v1+json' } }, 'manifest');
  if (manRes.status !== 200) trivyFail('sentinel.trivy.acquisitionFailed', `manifest: unexpected response ${manRes.status}`);
  const manBytes = await boundedBytes(manRes, 65_536, 'manifest');
  if (sha(manBytes) !== TRIVY_CHECKS_BUNDLE.manifest) trivyFail('sentinel.trivy.acquisitionFailed', 'manifest: the bytes do not match the pinned digest');
  let manifest: any;
  try { manifest = JSON.parse(manBytes.toString('utf8')); } catch { return trivyFail('sentinel.trivy.acquisitionFailed', 'manifest: not JSON'); }
  const layers = Array.isArray(manifest?.layers) ? manifest.layers : [];
  const layer = layers[0];
  if (layers.length !== 1 || layer?.digest !== TRIVY_CHECKS_BUNDLE.layer || layer?.size !== TRIVY_CHECKS_BUNDLE.size
    || layer?.mediaType !== 'application/vnd.cncf.openpolicyagent.layer.v1.tar+gzip' || layer?.annotations?.['org.opencontainers.image.title'] !== 'bundle.tar.gz'
    || manifest?.annotations?.['org.opencontainers.image.revision'] !== TRIVY_CHECKS_BUNDLE.commit || manifest?.annotations?.['org.opencontainers.image.version'] !== TRIVY_CHECKS_BUNDLE.version) {
    trivyFail('sentinel.trivy.acquisitionFailed', 'manifest: it does not describe the pinned bundle');
  }

  // The layer. The registry answers with a redirect to its blob host; that one hop is followed, without the token.
  const blobRes = await get(checksBlobUrl(), { redirect: 'manual', headers: auth }, 'bundle');
  let body: Response = blobRes;
  if ([301, 302, 303, 307, 308].includes(blobRes.status)) {
    const to = blobRes.headers.get('location') ?? '';
    if (!to.startsWith(CHECKS_BLOB_HOST)) trivyFail('sentinel.trivy.acquisitionRefused', 'bundle: the registry redirected outside its blob host');
    body = await get(to, { redirect: 'error' }, 'bundle');
  }
  if (body.status !== 200) trivyFail('sentinel.trivy.acquisitionFailed', `bundle: unexpected response ${body.status}`);
  const bytes = await boundedBytes(body, TRIVY_CHECKS_BUNDLE.size, 'bundle');
  if (bytes.length !== TRIVY_CHECKS_BUNDLE.size || sha(bytes) !== TRIVY_CHECKS_BUNDLE.layer) trivyFail('sentinel.trivy.acquisitionFailed', 'bundle: the bytes do not match the pinned digest');
  const hex = TRIVY_CHECKS_BUNDLE.layer.slice(7);
  const tmp = join(options.dir, `.acquire-${randomBytes(8).toString('hex')}.partial`);
  const fd = openSync(tmp, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | (FS.O_NOFOLLOW ?? 0), 0o600);
  try {
    for (let off = 0; off < bytes.length;) off += writeSync(fd, bytes, off, bytes.length - off);
    fsyncSync(fd);
  } catch (e) { closeSync(fd); try { unlinkSync(tmp); } catch { /* best effort */ } throw e; }
  closeSync(fd);
  renameSync(tmp, join(options.dir, `${hex}.tar.gz`));
  const bundle: ChecksBundle = Object.freeze({
    schema: 'sentinel-trivy-checks/draft-1', name: 'trivy-checks', version: TRIVY_CHECKS_BUNDLE.version, commit: TRIVY_CHECKS_BUNDLE.commit,
    repository: TRIVY_CHECKS_BUNDLE.repository, manifest: TRIVY_CHECKS_BUNDLE.manifest, layer: TRIVY_CHECKS_BUNDLE.layer, size: bytes.length,
    created: String(manifest.annotations['org.opencontainers.image.created'] ?? TRIVY_CHECKS_BUNDLE.created), acquiredAt: stamp(now()),
  });
  writePrivateFileAtomic(options.dir, `${hex}.json`, Buffer.from(JSON.stringify(bundle)), 'sentinel.policy.trustDirUnsafe');
  return bundle;
}

/**
 * The stored pinned bundle, re-hashed against its manifest before any scan may use it. Absent is not an error here:
 * it returns null, and the scan records every configuration file as a `bundle-missing` gap.
 */
export function loadChecksBundle(dir: string): { bundle: ChecksBundle; path: string } | null {
  const hex = TRIVY_CHECKS_BUNDLE.layer.slice(7);
  const bytes = readPrivateFile(join(dir, `${hex}.json`), 64 * 1024, 'sentinel.policy.trustDirUnsafe');
  if (!bytes) return null;
  let b: ChecksBundle;
  try { b = JSON.parse(bytes.toString('utf8')); } catch { return trivyFail('sentinel.trivy.bundleInvalid', 'the bundle manifest is not JSON'); }
  if (b?.schema !== 'sentinel-trivy-checks/draft-1' || b.layer !== TRIVY_CHECKS_BUNDLE.layer || b.manifest !== TRIVY_CHECKS_BUNDLE.manifest
    || b.version !== TRIVY_CHECKS_BUNDLE.version || b.size !== TRIVY_CHECKS_BUNDLE.size) {
    trivyFail('sentinel.trivy.bundleInvalid', 'the stored manifest does not describe the pinned bundle');
  }
  const path = join(dir, `${hex}.tar.gz`);
  let fd: number;
  try { fd = openSync(path, FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0)); } catch { return trivyFail('sentinel.trivy.bundleInvalid', 'the bundle archive is missing'); }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size !== b.size || (st.mode & 0o077) !== 0) trivyFail('sentinel.trivy.bundleInvalid', 'the archive is not the private file its manifest describes');
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) { const n = readSync(fd, buf, off, st.size - off, off); if (!n) break; off += n; }
    if (sha(buf.subarray(0, off)) !== TRIVY_CHECKS_BUNDLE.layer) trivyFail('sentinel.trivy.bundleInvalid', 'the archive does not match its digest');
  } finally { closeSync(fd); }
  return { bundle: Object.freeze({ ...b }), path };
}
