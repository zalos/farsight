// scripts/verify-release.mjs against a loopback stand-in of a GitHub Release (the /releases/download/<tag>/<file>
// layout, the manifest asset and two stand-in tarballs): it installs the published URLs themselves, checks bytes
// and digests first, and refuses a manifest for another tag or repository, or a tarball that changed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename } from 'node:path';
import { verifyRelease, checkPublished } from '../verify-release.mjs';
import { standIns } from './helpers/acceptance-standins.mjs';

const sha = (b) => `sha256:${createHash('sha256').update(b).digest('hex')}`;

async function release(s, { tag = 'v0.4.0', tamper = false, manifestTag } = {}) {
  const files = new Map([[basename(s.farsight), readFileSync(s.farsight)], [basename(s.sentinel), readFileSync(s.sentinel)]]);
  const server = createServer((req, res) => {
    const m = /^\/releases\/download\/([^/]+)\/(.+)$/.exec(req.url ?? '');
    const body = m && m[1] === tag ? (m[2] === 'release-manifest.json' ? Buffer.from(JSON.stringify(manifest)) : files.get(decodeURIComponent(m[2]))) : undefined;
    if (!body) { res.writeHead(404).end(); return; }
    res.writeHead(200).end(tamper && m[2].startsWith('farsight-sentinel') ? Buffer.concat([body, Buffer.from('x')]) : body);
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const repoUrl = `http://127.0.0.1:${server.address().port}`;
  const entry = (key, name, version, file) => ({ name, version, file: basename(file), url: `${repoUrl}/releases/download/${tag}/${basename(file)}`, bytes: files.get(basename(file)).length, sha256: sha(files.get(basename(file))) });
  const manifest = { schema: 'farsight-release-manifest/v1', tag: manifestTag ?? tag, commit: 'abc1234', repoUrl,
    packages: { farsight: entry('farsight', 'farsight-cli', '0.4.0', s.farsight), sentinel: entry('sentinel', 'farsight-sentinel', '0.1.0', s.sentinel) } };
  return { repoUrl, close: () => new Promise((ok) => server.close(ok)) };
}

test('a published release is installed from its own URLs after its bytes and digests are checked', async () => {
  const s = standIns();
  const r = await release(s);
  try {
    const result = await verifyRelease({ tag: 'v0.4.0', repoUrl: r.repoUrl, loopback: true, modes: ['global', 'local'], log: () => {} });
    assert.equal(result.summary.failed, 0, JSON.stringify(result.results.filter((x) => x.status === 'failed'), null, 2));
    assert.equal(result.sources.farsight, `${r.repoUrl}/releases/download/v0.4.0/farsight-cli-0.4.0.tgz`);
    assert.equal(result.sources.sentinel, `${r.repoUrl}/releases/download/v0.4.0/farsight-sentinel-0.1.0.tgz`, 'Sentinel\'s own name and version');
    assert.equal(new Set(result.results.map((x) => x.combination)).size, 6);
    assert.ok(result.summary.pending > 0, 'unbuilt Sentinel features stay pending, never passed');
  } finally { await r.close(); s.done(); }
});

test('a changed tarball, another tag or another repository is refused before anything is installed', async () => {
  const s = standIns();
  const tampered = await release(s, { tamper: true });
  const otherTag = await release(s, { manifestTag: 'v0.4.1' });
  try {
    await assert.rejects(checkPublished({ tag: 'v0.4.0', repoUrl: tampered.repoUrl, loopback: true }), /farsight-sentinel-0\.1\.0\.tgz: the published bytes .* are not the manifest's/);
    await assert.rejects(checkPublished({ tag: 'v0.4.0', repoUrl: otherTag.repoUrl, loopback: true }), /url, bytes or sha256 is wrong|manifest tag v0\.4\.1|names v0\.4\.1/);
    await assert.rejects(checkPublished({ tag: 'v0.4.0', repoUrl: `${tampered.repoUrl}/other`, loopback: true }), /HTTP 404|names http/);
    await assert.rejects(checkPublished({ tag: 'v0.4.0', repoUrl: tampered.repoUrl }), /commit or repoUrl is malformed/, 'only a test may name a loopback origin');
  } finally { await tampered.close(); await otherTag.close(); s.done(); }
});
