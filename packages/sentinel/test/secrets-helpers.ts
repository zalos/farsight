// Shared set-up for the secret-scan tests. The synthetic value is assembled here at run time from inert parts, so no
// secret-shaped value is committed and the repository's own secret scan needs no allowlist for it. No assertion
// message, diagnostic or report line ever includes it: `absent()` names only where it looked.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** `ghp_` and 36 letters and digits: the GitHub token shape, plainly synthetic. */
export const VALUE = ['ghp', '_', 'SentinelSynthetic', 'InertFixture', '0000001'].join('');
export const sha = (b: string | Uint8Array) => `sha256:${createHash('sha256').update(b).digest('hex')}`;

/** Fails with a message naming the place only; the value and the haystack are never printed. */
export function absent(haystack: string | Uint8Array, where: string): void {
  const found = typeof haystack === 'string' ? haystack.includes(VALUE) : Buffer.from(haystack).includes(VALUE);
  assert.equal(found, false, `${where} contains the synthetic value`);
}

/** The default captured tree: one leaking line, one clean file, an inline allow, and a root ignore list for both. */
export function treeFiles(extra: Record<string, string | Buffer | null> = {}): Record<string, string | Buffer> {
  const files: Record<string, string | Buffer | null> = {
    'config/service.env': `# synthetic fixture for the secret scanner\nSENTINEL_SYNTHETIC_TOKEN=${VALUE}\n`,
    'src/clean.ts': 'export const nothingSecret = 1;\n',
    'notes/allowed.md': `example ${VALUE} gitleaks:allow\n`,
    // Fingerprints for both findings in every form a path could take: none of them may suppress anything.
    '.gitleaksignore': ['config/service.env:github-pat:2', 'notes/allowed.md:github-pat:1', 'scan/tree/config/service.env:github-pat:2',
      'scan/tree/notes/allowed.md:github-pat:1', 'tree/config/service.env:github-pat:2', 'tree/notes/allowed.md:github-pat:1'].join('\n') + '\n',
    ...extra,
  };
  return Object.fromEntries(Object.entries(files).filter((e): e is [string, string | Buffer] => e[1] !== null));
}

/** Writes captured contents under `dir` by digest and returns the targets. */
export function captured(dir: string, files: Record<string, string | Buffer>) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return Object.entries(files).map(([relativePath, text]) => {
    const bytes = Buffer.from(text);
    const artifact = sha(bytes);
    const path = join(dir, artifact.slice(7));
    writeFileSync(path, bytes);
    return { relativePath, artifact, path };
  });
}
