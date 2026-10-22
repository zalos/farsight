// Shared set-up for the Trivy and zizmor adapter tests: the original fixtures under their real names inside a
// temporary captured tree (never built, applied or run), as capture would hand them over.
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const IAC_FIXTURES = fileURLToPath(new URL('./fixtures/iac/', import.meta.url));
export const sha = (b: Uint8Array | string) => `sha256:${createHash('sha256').update(b).digest('hex')}`;

/** `layout` maps a real relative path to a fixture file (`trivy/dockerfile-root.fixture`) or `{ text }`. */
export function capturedTree(root: string, layout: Record<string, string | { text: string | Buffer }>) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  const out: { relativePath: string; artifact: string; path: string }[] = [];
  for (const [rel, from] of Object.entries(layout)) {
    const bytes = typeof from === 'string' ? readFileSync(join(IAC_FIXTURES, from)) : Buffer.from(from.text);
    const path = join(root, rel);
    mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
    writeFileSync(path, bytes, { mode: 0o600 });
    out.push({ relativePath: rel, artifact: sha(bytes), path });
  }
  return out;
}

/** The Trivy fixture tree: positives, a negative, an ignore, Terraform with and without a remote module. */
export const TRIVY_LAYOUT: Record<string, string> = {
  'services/api/Dockerfile': 'trivy/dockerfile-root.fixture',
  'services/worker/hardened.Dockerfile': 'trivy/dockerfile-hardened.fixture',
  'services/legacy/Containerfile': 'trivy/dockerfile-inline-ignore.fixture',
  'deploy/pod.yaml': 'trivy/k8s-privileged-pod.fixture',
  'config/settings.yaml': 'trivy/k8s-not-a-manifest.fixture',
  'infra/storage/main.tf': 'trivy/tf-open-bucket.fixture',
  'infra/storage/locals.tf': 'trivy/tf-locals.fixture',
  'infra/network/main.tf': 'trivy/tf-remote-module.fixture',
  'infra/network/terraform.tfvars': 'trivy/tfvars.fixture',
};

/** The zizmor fixture tree: positives, a true negative, an action, Dependabot, and two files it cannot audit. */
export const ZIZMOR_LAYOUT: Record<string, string> = {
  '.github/workflows/triage.yml': 'zizmor/workflow-injection.fixture',
  '.github/workflows/build.yaml': 'zizmor/workflow-hardened.fixture',
  '.github/workflows/broken.yml': 'zizmor/workflow-broken.fixture',
  '.github/workflows/notes.yml': 'zizmor/workflow-not-workflow.fixture',
  '.github/actions/setup/action.yml': 'zizmor/action-injection.fixture',
  '.github/dependabot.yml': 'zizmor/dependabot.fixture',
  'services/api/.github/workflows/ci.yml': 'zizmor/workflow-hardened.fixture',
};
