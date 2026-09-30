// The e2e fixture workspace: a temp copy of examples/invoice-app ingested with an
// explicit --out, so the real CLI + server run against a small graph that never
// touches the dogfood graph.json (AGENTS.md: preserve the dogfood graph).
//
// The fixture is copied, never used in place: the MCP spec edits its copy to prove
// refresh_graph and /api/sync see a new function, and the checked-in example has to
// stay what the other suites (and the dogfood source) read.
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CLI = join(REPO_ROOT, 'packages', 'cli', 'dist', 'cli.js');
export const FIXTURE_REPO = 'invoice-app';
const FIXTURE_SRC = join(REPO_ROOT, 'examples', FIXTURE_REPO);
/** Where the stories spec serves its fake Storybook (index.json + iframe.html). */
export const STORYBOOK_PORT = Number(process.env.FARSIGHT_E2E_SB_PORT || 4539);

/**
 * Build a fresh workspace in a temp dir: `<dir>/invoice-app` (the copy),
 * `<dir>/.farsight/settings.json` naming it as the one local source (so the
 * server's POST /api/sync re-ingests it), and `<dir>/graph.json`.
 * Snapshots land in `<dir>/.farsight/farsight.db` because ingest writes them
 * relative to cwd — which is why cwd is the temp dir, never the repo.
 */
export function makeWorkspace(label = 'ws', { fixed = false } = {}) {
  // `fixed` reuses one path per label, wiped first: Playwright stops the webServer
  // with a signal the wrapper may never see, so a random dir per run would pile up
  const dir = fixed ? join(tmpdir(), `farsight-e2e-${label}`) : mkdtempSync(join(tmpdir(), `farsight-e2e-${label}-`));
  if (fixed) { rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true }); }
  cpSync(FIXTURE_SRC, join(dir, FIXTURE_REPO), { recursive: true });
  mkdirSync(join(dir, '.farsight'), { recursive: true });
  writeFileSync(join(dir, '.farsight', 'settings.json'), JSON.stringify({
    theme: 'dark',
    defaultLens: 'hybrid',
    // the fixture's Storybook is a fake the stories spec starts on this port (never a real one);
    // a lane that moves its ports moves this one too
    sources: [{ id: FIXTURE_REPO, name: FIXTURE_REPO, type: 'local', path: FIXTURE_REPO, enabled: true, storybook: { url: `http://127.0.0.1:${STORYBOOK_PORT}` } }],
    collections: [],
  }, null, 2));
  const graph = join(dir, 'graph.json');
  ingest(dir, graph);
  return { dir, graph, repoDir: join(dir, FIXTURE_REPO), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** The real CLI ingest, from the workspace cwd, with an explicit --out. */
export function ingest(dir, graph) {
  execFileSync(process.execPath, [CLI, 'ingest', FIXTURE_REPO, '--repo', FIXTURE_REPO, '--out', graph], {
    cwd: dir, stdio: ['ignore', 'ignore', 'pipe'],
  });
}
