// Container isolation for external tools. There is no host fallback: if no qualified local container runtime is
// reachable, the step stops with isolationUnavailable or backendUnqualified.
//
// - The Docker client is a fixed, checked executable, and talks only to a local unix socket. Its configuration
//   folder is an empty private one, so no registry credential, credential helper or host CLI setting reaches it.
// - Images are pinned `repository@sha256:<digest>`, inspected, never pulled (`--pull never`); the installed
//   image must match the pin, Linux and the server's processor.
// - Each container: no network, read-only root, a non-root user, every capability dropped, no new
//   privileges, memory = memory+swap, CPU, process and file-size ceilings, a small noexec /tmp, the attempt's
//   inputs read-only at /input and its own output folder at /output, nothing else from the host, no daemon logs.
// - After creation the container is read back and every setting compared before it may start.
// - Ownership labels (store, attempt, epoch, invocation, a random owner nonce) are checked before any kill or
//   removal, and removal is confirmed by the daemon reporting the exact container absent. Nothing is ever
//   selected by name pattern or command line.
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdtempSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Id } from '../contracts/common.js';
import { currentHost } from '../store/runtime.js';
import { ExecutionError } from './errors.js';
import { runBounded, runBoundedSync, spawnWorker, succeeded, type BoundedResult, type WorkerProcess } from './processes.js';
import { IMAGE_REFERENCE, type AdapterLimits } from './registry.js';

export type ContainerBackendKind = 'docker-desktop' | 'docker-engine';

/** One host, container runtime and server processor, measured or a candidate CI must still run. */
export interface QualifiedIsolation {
  readonly host: string;
  readonly backend: ContainerBackendKind;
  readonly server: string;
  readonly status: 'measured' | 'candidate';
  readonly evidence: string;
}

export interface IsolationPolicy { readonly qualified: readonly QualifiedIsolation[] }

/**
 * darwin-arm64 with Docker Desktop (linux-arm64 VM): PR 01's runtime matrix and the PR 07 isolation canaries.
 * linux-x64 with Docker Engine (linux-amd64): measured by PR 07's GitHub ubuntu canaries.
 * Nothing else is qualified (feasibility-decisions
 * defers independent Linux hosts, Colima, AMD64 Desktop, Windows and emulation). This is separate from the store's
 * SQLite qualification: a host qualified for the store is not thereby qualified to isolate scanners.
 */
export const ISOLATION_POLICY: IsolationPolicy = Object.freeze({
  qualified: Object.freeze([
    Object.freeze({ host: 'darwin-arm64', backend: 'docker-desktop' as const, server: 'linux-arm64', status: 'measured' as const,
      evidence: 'PR 01 runtime matrix (Docker Desktop 4.65.0, Engine 29.2.1) and PR 07 isolation canaries' }),
    Object.freeze({ host: 'linux-x64', backend: 'docker-engine' as const, server: 'linux-amd64', status: 'measured' as const,
      evidence: 'PR 07 CI 39728679640/119658477459: Node 24.21.0, Engine 28.0.4, Ubuntu 24.04.5 LTS, cgroup v2; 82 passed, zero skips' }),
  ]),
});

export function isolationQualification(policy: IsolationPolicy, host: string, backend: ContainerBackendKind, server: string): QualifiedIsolation | undefined {
  return policy.qualified.find(q => q.host === host && q.backend === backend && q.server === server);
}

const DOCKER_CANDIDATES = ['/usr/bin/docker', '/usr/local/bin/docker', '/opt/homebrew/bin/docker', '/Applications/Docker.app/Contents/Resources/bin/docker'];
const SAFE_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const LABEL = 'org.farsight.sentinel';
export const LABELS = Object.freeze({
  owner: `${LABEL}.owner`, store: `${LABEL}.store`, attempt: `${LABEL}.attempt`, epoch: `${LABEL}.epoch`, invocation: `${LABEL}.invocation`,
});
export const INPUT_MOUNT = '/input';
export const OUTPUT_MOUNT = '/output';
/**
 * The container's user: the invoking user's own uid:gid when that is not root (outputs then belong to the
 * user and the output folder stays private), otherwise the unprivileged 65534. Never root, never a capability.
 */
export function containerUser(): string {
  const uid = process.getuid?.() ?? 0, gid = process.getgid?.() ?? 0;
  return uid === 0 ? '65534:65534' : `${uid}:${gid}`;
}
const CONTAINER_ID = /^[0-9a-f]{64}$/;

const unavailable = (reason: string, cause?: unknown): never => {
  throw new ExecutionError('sentinel.execution.isolationUnavailable', { reason }, cause ? { cause } : undefined);
};

/** Find the Docker client: a fixed location, a regular file, not writable by other users. Never a PATH search. */
export function locateDocker(candidates: readonly string[] = DOCKER_CANDIDATES): string {
  for (const candidate of candidates) {
    let real: string;
    try { real = realpathSync.native(candidate); } catch { continue; }
    const s = lstatSync(real);
    if (!s.isFile() || (s.mode & 0o022) !== 0 || (s.uid !== 0 && s.uid !== process.getuid?.())) continue;
    return real;
  }
  return unavailable('no docker client');
}

export interface BackendFacts {
  host: string;
  backend: ContainerBackendKind;
  server: string;
  serverVersion: string;
  operatingSystem: string;
  cgroupVersion: string;
  qualification: QualifiedIsolation;
}

export interface ImagePin {
  reference: string;
  /** The installed image's own id, which a created container must name as its image. */
  id: string;
  os: string;
  architecture: string;
  /** The image's own environment; a container may carry nothing beyond it and Sentinel's names. */
  env: readonly string[];
}

export interface ContainerSpec {
  image: ImagePin;
  command: readonly string[];
  limits: AdapterLimits;
  inputDir: string;
  outputDir: string;
  labels: { owner: string; store: Id; attempt: Id; epoch: Id; invocation: string };
  /** Told to the worker so its hello can repeat it; a consistency check, not a credential. */
  adapter: { id: Id; digest: string };
  /** From containerUser(); never 0. */
  user: string;
}

export interface ContainerState {
  status: string;
  exitCode: number | null;
  oomKilled: boolean;
}

export type CleanupState = 'removed-owned-container' | 'already-absent' | 'cleanup-failed';

/**
 * How the backend talks to the Docker client. Production uses the fixed client with its pinned environment;
 * package-internal tests substitute a daemon stand-in to reproduce lost output, refused removals and similar
 * faults. Never part of the public API (the execution modules are not exported).
 */
export interface DockerRunner {
  run(args: readonly string[], signal?: AbortSignal): Promise<BoundedResult>;
  runSync(args: readonly string[]): BoundedResult;
  start(id: string): WorkerProcess;
}

/** The labels an attempt's container carries; all of them must match before it is stopped or removed. */
export type OwnershipLabels = ContainerSpec['labels'];

const absentContainer = (r: BoundedResult) => !succeeded(r) && /no such (container|object)/i.test(r.stderr.toString('utf8'));

function labelsMatch(c: { Id?: string; Config?: { Labels?: Record<string, string> } } | null | undefined, id: string | null, expected: Partial<OwnershipLabels>): boolean {
  if (!c || !CONTAINER_ID.test(String(c.Id ?? '')) || (id !== null && c.Id !== id)) return false;
  const labels = c.Config?.Labels ?? {};
  return Object.entries(expected).every(([k, v]) => labels[LABELS[k as keyof typeof LABELS]] === v);
}

/** A qualified local Docker runtime. Every method addresses one container by its exact 64-hex identity. */
export class ContainerBackend {
  readonly facts: Readonly<BackendFacts>;
  readonly #runner: DockerRunner;
  readonly #serverArch: string;

  private constructor(runner: DockerRunner, facts: BackendFacts, serverArch: string) {
    this.#runner = runner; this.facts = Object.freeze(facts); this.#serverArch = serverArch;
  }

  /**
   * Connect to the local runtime and qualify it. `privateDir` is a private folder for the empty client
   * configuration. Refuses a remote endpoint, an unqualified combination or missing resource controllers.
   * `runner` is the package-internal test seam (see DockerRunner); production never passes one.
   */
  static async connect(options: { privateDir: string; policy?: IsolationPolicy; docker?: string; signal?: AbortSignal; runner?: DockerRunner; wrapRunner?: (runner: DockerRunner) => DockerRunner }): Promise<ContainerBackend> {
    let runner = options.runner;
    if (!runner) {
      const docker = options.docker ?? locateDocker();
      const endpoint = await resolveEndpoint(docker, options.signal);
      const config = mkdtempSync(join(options.privateDir, 'docker-config-'));
      const made = lstatSync(config, { bigint: true });
      runner = clientRunner(docker, { PATH: SAFE_PATH, DOCKER_HOST: endpoint, DOCKER_CONFIG: config });
      clientConfigs.set(runner, Object.freeze({ path: config, identity: `${made.dev}:${made.ino}` }));
    }
    // Package-internal fault injection around the real client (lost replies, delayed commits); never in production.
    if (options.wrapRunner) runner = options.wrapRunner(runner);
    const version = await runner.run(['version', '--format', '{{json .Server}}'], options.signal);
    if (!succeeded(version)) unavailable('docker server unreachable');
    const info = await runner.run(['info', '--format', '{{json .}}'], options.signal);
    if (!succeeded(info)) unavailable('docker info unavailable');
    let server: { Os?: string; Arch?: string; Version?: string }, i: Record<string, unknown>;
    try { server = JSON.parse(version.stdout.toString('utf8')); i = JSON.parse(info.stdout.toString('utf8')); } catch (e) { return unavailable('docker answer unreadable', e); }
    const arch = ({ aarch64: 'arm64', x86_64: 'amd64' } as Record<string, string>)[server.Arch ?? ''] ?? server.Arch ?? 'unknown';
    const serverId = `${server.Os}-${arch}`;
    const os = String(i.OperatingSystem ?? '');
    const backend: ContainerBackendKind = os.startsWith('Docker Desktop') ? 'docker-desktop' : 'docker-engine';
    const host = currentHost();
    const qualification = isolationQualification(options.policy ?? ISOLATION_POLICY, host, backend, serverId);
    if (!qualification) throw new ExecutionError('sentinel.execution.backendUnqualified', { backend: `${backend} (${serverId})`, host });
    if (![i.MemoryLimit, i.SwapLimit, i.CpuCfsQuota, i.PidsLimit].every(v => v === true)) unavailable('required resource controllers missing');
    return new ContainerBackend(runner, {
      host, backend, server: serverId, serverVersion: String(server.Version ?? ''), operatingSystem: os,
      cgroupVersion: String(i.CgroupVersion ?? ''), qualification,
    }, arch);
  }

  /** The installed image for a pin; refuses a missing or mismatched image and never pulls. */
  async inspectImage(reference: string, signal?: AbortSignal): Promise<ImagePin> {
    if (!IMAGE_REFERENCE.test(reference)) throw new ExecutionError('sentinel.execution.imageMismatch', { image: reference.slice(0, 200) });
    const r = await this.#runner.run(['image', 'inspect', '--format', '{{json .}}', reference], signal);
    if (!succeeded(r)) {
      if (/no such image/i.test(r.stderr.toString('utf8'))) throw new ExecutionError('sentinel.execution.imageMissing', { image: reference });
      throw new ExecutionError('sentinel.execution.commandFailed', { operation: 'image inspect' });
    }
    let v: { Id?: string; Os?: string; Architecture?: string; RepoDigests?: string[]; Config?: { Env?: unknown } };
    try { v = JSON.parse(r.stdout.toString('utf8')); } catch { throw new ExecutionError('sentinel.execution.imageMismatch', { image: reference }); }
    const digest = reference.slice(reference.indexOf('@') + 1);
    const repo = reference.slice(0, reference.indexOf('@'));
    const pinned = v.Id === digest || (v.RepoDigests ?? []).some(d => d === reference || d === `docker.io/${repo}@${digest}` || d === `docker.io/library/${repo}@${digest}`);
    if (!pinned || !/^sha256:[0-9a-f]{64}$/.test(String(v.Id)) || v.Os !== 'linux' || v.Architecture !== this.#serverArch) {
      throw new ExecutionError('sentinel.execution.imageMismatch', { image: reference });
    }
    const env = Array.isArray(v.Config?.Env) ? (v.Config!.Env as unknown[]).map(String) : [];
    return { reference, id: String(v.Id), os: v.Os, architecture: v.Architecture, env };
  }

  /**
   * Create (not start) the container, then read it back and compare every isolation setting.
   *
   * The intent is recorded before the request: the generated name (`sentinel-<owner nonce>`) and every ownership
   * label. A create request is never cut short by a cancellation, since an aborted client does not stop the daemon
   * (the runner's own bound can still end it). Whatever the request's answer (failure, timeout, lost or unreadable
   * output), what the daemon made is found again by that name and those labels and removed only by its verified
   * exact ID; if nothing is found, the request may still complete, which is reconciliationPending with the intent.
   */
  async create(spec: ContainerSpec, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw new ExecutionError('sentinel.execution.canceled', {});
    const r = await this.#runner.run(createArgs(spec, this.#serverArch));
    const answered = r.stdout.toString('utf8').trim();
    const id = succeeded(r) && CONTAINER_ID.test(answered) ? answered : undefined;
    if (!id) {
      await this.#reconcileIntent(spec);
      // Found and removed: the request had committed, so nothing is pending.
      throw new ExecutionError('sentinel.execution.commandFailed', { ...intentDetail(spec), operation: r.timedOut ? 'create timed out' : 'create' });
    }
    try {
      if (signal?.aborted) throw new ExecutionError('sentinel.execution.canceled', {});
      validateContainer(await this.#container(id), spec);
    } catch (error) {
      const removed = await this.remove(id, spec.labels).catch(() => 'cleanup-failed' as const);
      if (removed === 'cleanup-failed') throw new ExecutionError('sentinel.execution.cleanupFailed', { container: id, owner: spec.labels.owner }, { cause: error });
      throw error;
    }
    return id;
  }

  /**
   * After a create without a confirmed answer: look for its container by the generated name and by the labels over
   * a short window and remove what is found by verified exact ID. Finding and removing it settles the request (the
   * daemon committed it). Finding nothing proves nothing: the request may still complete later, so that is
   * reconciliationPending with the full intent (name and every label), for recovery to finish; there is no
   * unbounded wait here.
   */
  async #reconcileIntent(spec: ContainerSpec): Promise<void> {
    const name = containerName(spec.labels.owner);
    const intent = intentDetail(spec);
    const uncertain = new Set<string>();
    let removed = false;
    for (let pass = 0; pass < 3 && !removed; pass++) {
      if (pass) await new Promise(resolve => setTimeout(resolve, 500));
      const byName = await this.#runner.run(['inspect', '--type', 'container', '--format', '{{json .}}', name]);
      if (succeeded(byName)) {
        let c: { Id?: string } | undefined;
        try { c = JSON.parse(byName.stdout.toString('utf8')); } catch { /* unreadable: the label pass decides */ }
        if (c && labelsMatch(c as never, null, spec.labels)) {
          if (await this.remove(String(c.Id), spec.labels) === 'removed-owned-container') removed = true; else uncertain.add(String(c.Id));
        } else uncertain.add(name);
      } else if (!absentContainer(byName)) uncertain.add(name);
      const leftover = await this.reconcileOwned(spec.labels);
      leftover.uncertain.forEach(u => uncertain.add(u));
      if (leftover.removed.length) removed = true;
    }
    if (uncertain.size) throw new ExecutionError('sentinel.execution.cleanupFailed', { ...intent, container: [...uncertain].join(', ') });
    if (!removed) throw new ExecutionError('sentinel.execution.reconciliationPending', intent);
  }

  /**
   * Recovery's question about a journaled intent from an earlier epoch: is its container there, and if so remove it
   * (by the generated name and by the labels, exact ID only). `not-found` is not proof of absence; the caller keeps
   * the intent.
   */
  async settleIntent(intent: { name: string; owner: string; store: Id; attempt: Id; epoch: Id; invocation: string }, signal?: AbortSignal): Promise<'removed' | 'not-found' | 'uncertain'> {
    const labels = { owner: intent.owner, store: intent.store, attempt: intent.attempt, epoch: intent.epoch, invocation: intent.invocation };
    let removed = false;
    const byName = await this.#runner.run(['inspect', '--type', 'container', '--format', '{{json .}}', intent.name], signal);
    if (succeeded(byName)) {
      let c: { Id?: string } | undefined;
      try { c = JSON.parse(byName.stdout.toString('utf8')); } catch { return 'uncertain'; }
      if (!c || !labelsMatch(c as never, null, labels)) return 'uncertain';
      if (await this.remove(String(c.Id), labels, signal) !== 'removed-owned-container') return 'uncertain';
      removed = true;
    } else if (!absentContainer(byName)) return 'uncertain';
    const swept = await this.reconcileOwned(labels, signal);
    if (swept.uncertain.length) return 'uncertain';
    return removed || swept.removed.length ? 'removed' : 'not-found';
  }

  /** Start the created container attached: stdin carries coordinator frames, stdout worker frames, stderr diagnostics. */
  startAttached(id: string): WorkerProcess {
    if (!CONTAINER_ID.test(id)) throw new ExecutionError('sentinel.execution.commandFailed', { operation: 'start' });
    return this.#runner.start(id);
  }

  async state(id: string, owner: Partial<OwnershipLabels>, signal?: AbortSignal): Promise<ContainerState | null> {
    const until = performance.now() + 500;
    const controller = new AbortController();
    let stop!: () => void;
    const stopped = new Promise<null>(resolve => { stop = () => { controller.abort(); resolve(null); }; });
    const timer = setTimeout(stop, 500);
    signal?.addEventListener('abort', stop, { once: true });
    try {
      if (signal?.aborted) { stop(); return null; }
      // Attach completion and the daemon's TaskOOM notification are separate observations. Give only an exited
      // SIGKILL-shaped result a short settling window; exit 137 itself never establishes a memory-limit failure.
      // Every reread checks exact ownership. A missing container or abort ends observation immediately; neither
      // a late inspect reply nor a stuck client may extend the 500 ms window or resurrect a result.
      return await Promise.race([stopped, (async () => {
        for (let pass = 0; pass < 4; pass++) {
          if (controller.signal.aborted || performance.now() >= until) return null;
          const c = await this.#owned(id, owner, controller.signal);
          if (!c || controller.signal.aborted || performance.now() >= until) return null;
          const s = (c.State ?? {}) as { Status?: string; ExitCode?: number; OOMKilled?: boolean };
          const state = { status: String(s.Status ?? ''), exitCode: typeof s.ExitCode === 'number' ? s.ExitCode : null, oomKilled: s.OOMKilled === true };
          if (pass === 3 || s.Status !== 'exited' || s.ExitCode !== 137 || state.oomKilled) return state;
          await Promise.race([stopped, new Promise(resolve => setTimeout(resolve, 50))]);
        }
        return null;
      })()]);
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', stop); controller.abort();
    }
  }

  /**
   * Stop a running owned container and confirm the daemon reports it stopped. Ending the attached client proves
   * nothing about the container, so this asks the daemon. Returns false when the stop cannot be confirmed.
   */
  async kill(id: string, owner: Partial<OwnershipLabels>, signal?: AbortSignal): Promise<boolean> {
    const running = (c: Record<string, unknown> | null) => (c?.State as { Running?: boolean } | undefined)?.Running === true;
    let c = await this.#owned(id, owner, signal);
    for (let attempt = 0; attempt < 3 && running(c); attempt++) {
      await this.#runner.run(['kill', id], signal);
      c = await this.#owned(id, owner, signal);
    }
    return !running(c);
  }

  /**
   * Remove every container carrying these labels (at least the random owner nonce), each checked by exact
   * identity and every label before removal. Containers whose removal cannot be confirmed come back uncertain.
   */
  async reconcileOwned(owner: Partial<OwnershipLabels> & { owner: string }, signal?: AbortSignal): Promise<{ removed: string[]; uncertain: string[] }> {
    const r = await this.#runner.run(['ps', '--all', '--no-trunc', '--quiet', '--filter', `label=${LABELS.owner}=${owner.owner}`], signal);
    if (!succeeded(r)) return { removed: [], uncertain: [`label ${owner.owner}`] };
    const removed: string[] = [], uncertain: string[] = [];
    for (const id of r.stdout.toString('utf8').split('\n').map(l => l.trim()).filter(Boolean)) {
      if (!CONTAINER_ID.test(id)) { uncertain.push(id.slice(0, 64)); continue; }
      const state = await this.remove(id, owner, signal);
      (state === 'cleanup-failed' ? uncertain : removed).push(id);
    }
    return { removed, uncertain };
  }

  /** Remove an owned container (exact ID, every given label) and confirm the daemon no longer knows it. */
  async remove(id: string, owner: Partial<OwnershipLabels>, signal?: AbortSignal): Promise<CleanupState> {
    const c = await this.#owned(id, owner, signal).catch(() => undefined);
    if (c === null) return 'already-absent';
    if (!c) return 'cleanup-failed';
    const r = await this.#runner.run(['rm', '--force', '--volumes', id], signal);
    if (!succeeded(r)) return 'cleanup-failed';
    const after = await this.#runner.run(['inspect', '--type', 'container', id], signal);
    return absentContainer(after) ? 'removed-owned-container' : 'cleanup-failed';
  }

  /** Synchronous removal for the store owner's close path, with the same identity and label checks. */
  removeSync(id: string, owner: Partial<OwnershipLabels>): CleanupState {
    if (!CONTAINER_ID.test(id)) return 'cleanup-failed';
    const r = this.#runner.runSync(['inspect', '--type', 'container', '--format', '{{json .}}', id]);
    if (!succeeded(r)) return absentContainer(r) ? 'already-absent' : 'cleanup-failed';
    let c;
    try { c = JSON.parse(r.stdout.toString('utf8')); } catch { return 'cleanup-failed'; }
    if (!labelsMatch(c, id, owner)) return 'cleanup-failed';
    if (!succeeded(this.#runner.runSync(['rm', '--force', '--volumes', id]))) return 'cleanup-failed';
    return absentContainer(this.#runner.runSync(['inspect', '--type', 'container', id])) ? 'removed-owned-container' : 'cleanup-failed';
  }

  /** Synchronous reconcile by owner nonce and labels, for the store owner's close path. */
  reconcileOwnedSync(owner: Partial<OwnershipLabels> & { owner: string }): { removed: string[]; uncertain: string[] } {
    const r = this.#runner.runSync(['ps', '--all', '--no-trunc', '--quiet', '--filter', `label=${LABELS.owner}=${owner.owner}`]);
    if (!succeeded(r)) return { removed: [], uncertain: [`label ${owner.owner}`] };
    const removed: string[] = [], uncertain: string[] = [];
    for (const id of r.stdout.toString('utf8').split('\n').map(l => l.trim()).filter(Boolean)) {
      (this.removeSync(id, owner) === 'cleanup-failed' ? uncertain : removed).push(id);
    }
    return { removed, uncertain };
  }

  /**
   * Read-only, for recovery (PR 08): every container labelled with this store, with its attempt, epoch and owner
   * nonce. Nothing is stopped or removed here; recovery decides, by those labels, under its own owner.
   */
  async listStoreContainers(store: Id, signal?: AbortSignal): Promise<Array<{ id: string; attempt: string; epoch: string; owner: string; running: boolean }>> {
    const r = await this.#runner.run(['ps', '--all', '--no-trunc', '--quiet', '--filter', `label=${LABELS.store}=${store}`], signal);
    if (!succeeded(r)) throw new ExecutionError('sentinel.execution.commandFailed', { operation: 'list' });
    const out = [];
    for (const id of r.stdout.toString('utf8').split('\n').map(l => l.trim()).filter(l => CONTAINER_ID.test(l))) {
      const c = await this.#container(id, signal).catch(() => null) as { Config?: { Labels?: Record<string, string> }; State?: { Running?: boolean } } | null;
      const labels = c?.Config?.Labels ?? {};
      if (labels[LABELS.store] !== store) continue;
      out.push({ id, attempt: labels[LABELS.attempt] ?? '', epoch: labels[LABELS.epoch] ?? '', owner: labels[LABELS.owner] ?? '', running: c?.State?.Running === true });
    }
    return out;
  }

  /** The exact container if it carries every given label; null when the daemon says it is absent; throws otherwise. */
  async #owned(id: string, owner: Partial<OwnershipLabels>, signal?: AbortSignal): Promise<Record<string, unknown> | null> {
    if (!CONTAINER_ID.test(id)) throw new ExecutionError('sentinel.execution.commandFailed', { operation: 'identity' });
    if (!owner.owner) throw new ExecutionError('sentinel.execution.cleanupFailed', { container: id, reason: 'no owner nonce' });
    const r = await this.#runner.run(['inspect', '--type', 'container', '--format', '{{json .}}', id], signal);
    if (!succeeded(r)) {
      if (absentContainer(r)) return null;
      throw new ExecutionError('sentinel.execution.commandFailed', { operation: 'inspect' });
    }
    let c;
    try { c = JSON.parse(r.stdout.toString('utf8')); } catch { throw new ExecutionError('sentinel.execution.commandFailed', { operation: 'inspect' }); }
    if (!labelsMatch(c, id, owner)) throw new ExecutionError('sentinel.execution.cleanupFailed', { container: id, reason: 'ownership mismatch' });
    return c as Record<string, unknown>;
  }

  async #container(id: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const r = await this.#runner.run(['inspect', '--type', 'container', '--format', '{{json .}}', id], signal);
    if (!succeeded(r)) throw new ExecutionError('sentinel.execution.commandFailed', { operation: 'inspect' });
    try {
      const v = JSON.parse(r.stdout.toString('utf8'));
      if (v && typeof v === 'object') return v as Record<string, unknown>;
    } catch { /* below */ }
    throw new ExecutionError('sentinel.execution.commandFailed', { operation: 'inspect' });
  }
}

/** The production runner: the fixed client, its pinned environment, bounded output, no shell. */
// The empty client configuration folder each real client runner was made with, by the runner object this module
// created. Package-internal: a scratch lease (service/scratch-lease.ts) may remove exactly that folder once every
// client it started has exited. Any other runner (a caller's, a test seam's) has none.
const clientConfigs = new WeakMap<DockerRunner, { readonly path: string; readonly identity: string }>();

/** The configuration folder (path and `dev:ino` at creation) of a client runner this module made; else undefined. */
export function clientConfigOf(runner: DockerRunner): { readonly path: string; readonly identity: string } | undefined {
  return clientConfigs.get(runner);
}

function clientRunner(docker: string, env: Record<string, string>): DockerRunner {
  const bounds = { env, timeoutMs: 30_000, maxStdoutBytes: 4 * 1024 * 1024, maxStderrBytes: 65_536 };
  return Object.freeze({
    run: (args: readonly string[], signal?: AbortSignal) => runBounded(docker, args, { ...bounds, ...(signal ? { signal } : {}) }),
    runSync: (args: readonly string[]) => runBoundedSync(docker, args, bounds),
    start: (id: string) => spawnWorker(docker, ['start', '--attach', '--interactive', id], { env }),
  });
}

export const containerName = (owner: string): string => `sentinel-${owner}`;

/** A create's whole intent, kept in every failure so recovery can find the container without its ID. */
export const intentDetail = (spec: Pick<ContainerSpec, 'labels'>) => ({
  name: containerName(spec.labels.owner), owner: spec.labels.owner, store: spec.labels.store, attempt: spec.labels.attempt,
  epoch: spec.labels.epoch, invocation: spec.labels.invocation,
});

/** The local unix socket the client should talk to. A tcp/ssh endpoint is a remote daemon and is refused. */
async function resolveEndpoint(docker: string, signal?: AbortSignal): Promise<string> {
  let endpoint = process.env.DOCKER_HOST;
  if (!endpoint) {
    // Only this read sees the user's client configuration, to learn which local context is current. Every
    // command with an effect runs with an empty configuration and no proxy or other inherited variable.
    const env: Record<string, string> = { PATH: SAFE_PATH, HOME: homedir() };
    for (const name of ['DOCKER_CONFIG', 'DOCKER_CONTEXT']) if (process.env[name]) env[name] = process.env[name]!;
    const r = await runBounded(docker, ['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}'], {
      env, timeoutMs: 10_000, maxStdoutBytes: 16_384, maxStderrBytes: 16_384, signal,
    });
    if (!succeeded(r)) unavailable('docker context unreadable');
    try { endpoint = JSON.parse(r.stdout.toString('utf8')) as string; } catch (e) { unavailable('docker context unreadable', e); }
  }
  if (typeof endpoint !== 'string' || !/^unix:\/\/\/[^\0]+$/.test(endpoint)) return unavailable('only a local unix socket endpoint is used');
  return endpoint;
}

/** The exact `docker create` argument list. Pure, so a test can pin every isolation flag. */
export function createArgs(spec: ContainerSpec, serverArch: string): string[] {
  const l = spec.limits;
  const name = containerName(spec.labels.owner);
  return [
    'create', '--pull', 'never', '--interactive', '--init', '--name', name,
    '--label', `${LABELS.owner}=${spec.labels.owner}`, '--label', `${LABELS.store}=${spec.labels.store}`,
    '--label', `${LABELS.attempt}=${spec.labels.attempt}`, '--label', `${LABELS.epoch}=${spec.labels.epoch}`,
    '--label', `${LABELS.invocation}=${spec.labels.invocation}`,
    '--platform', `linux/${serverArch}`,
    '--network', 'none', '--read-only', '--user', spec.user, '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true', '--ipc', 'none',
    '--memory', String(l.memoryBytes), '--memory-swap', String(l.memoryBytes), '--cpus', String(l.cpus), '--pids-limit', String(l.pids),
    '--ulimit', `fsize=${Math.max(l.outputBytes, 1)}`, '--ulimit', 'core=0',
    '--tmpfs', `/tmp:rw,noexec,nosuid,nodev,size=${l.tmpfsBytes},mode=1777`,
    '--mount', `type=bind,source=${spec.inputDir},target=${INPUT_MOUNT},readonly`,
    '--mount', `type=bind,source=${spec.outputDir},target=${OUTPUT_MOUNT}`,
    '--log-driver', 'none', '--workdir', '/tmp',
    ...expectedEnv(spec).flatMap(e => ['--env', e]),
    '--entrypoint', spec.command[0]!, spec.image.reference, ...spec.command.slice(1),
  ];
}

/** The whole environment Sentinel gives a container, on top of the image's own. */
export const expectedEnv = (spec: Pick<ContainerSpec, 'adapter'>): string[] => [
  'HOME=/tmp', `SENTINEL_INPUT=${INPUT_MOUNT}`, `SENTINEL_OUTPUT=${OUTPUT_MOUNT}`,
  `SENTINEL_ADAPTER_ID=${spec.adapter.id}`, `SENTINEL_ADAPTER_DIGEST=${spec.adapter.digest}`,
];

/** Compare a created container against its spec. Any difference is an isolationMismatch naming the setting. */
export function validateContainer(c: Record<string, unknown>, spec: ContainerSpec): void {
  const fail = (setting: string): never => { throw new ExecutionError('sentinel.execution.isolationMismatch', { setting }); };
  const config = (c.Config ?? {}) as Record<string, any>;
  const host = (c.HostConfig ?? {}) as Record<string, any>;
  const l = spec.limits;
  if (!CONTAINER_ID.test(String(c.Id ?? ''))) fail('id');
  const labels = config.Labels ?? {};
  for (const [key, value] of Object.entries({ owner: spec.labels.owner, store: spec.labels.store, attempt: spec.labels.attempt, epoch: spec.labels.epoch, invocation: spec.labels.invocation })) {
    if (labels[LABELS[key as keyof typeof LABELS]] !== value) fail(`label ${key}`);
  }
  if (config.Image !== spec.image.reference) fail('image');
  // The image the daemon actually created it from, not only the reference it was asked for.
  if (c.Image !== spec.image.id) fail('image id');
  if (config.User !== spec.user || /^0(:|$)/.test(spec.user)) fail('user');
  if (config.Tty === true || config.OpenStdin !== true) fail('stdio');
  if (host.NetworkMode !== 'none') fail('network');
  if (host.ReadonlyRootfs !== true) fail('read-only root');
  if (host.Privileged === true) fail('privileged');
  if ((host.CapAdd ?? []).length || !(host.CapDrop ?? []).includes('ALL')) fail('capabilities');
  if (!(host.SecurityOpt ?? []).includes('no-new-privileges:true')) fail('no-new-privileges');
  if (host.IpcMode !== 'none') fail('ipc');
  if (host.PidMode || host.UTSMode || host.UsernsMode === 'host' || host.CgroupnsMode === 'host') fail('namespaces');
  if (host.Memory !== l.memoryBytes || host.MemorySwap !== l.memoryBytes) fail('memory');
  if (host.NanoCpus !== Math.round(l.cpus * 1_000_000_000)) fail('cpus');
  if (host.PidsLimit !== l.pids) fail('pids');
  if ((host.Devices ?? []).length || (host.DeviceRequests ?? []).length) fail('devices');
  if (Object.keys(host.PortBindings ?? {}).length || host.PublishAllPorts === true) fail('ports');
  if ((host.ExtraHosts ?? []).length || (host.Links ?? []).length || (host.VolumesFrom ?? []).length || (host.Binds ?? []).length) fail('host links');
  if (host.LogConfig?.Type !== 'none') fail('logs');
  if (host.Init !== true) fail('init');
  const tmpfs = host.Tmpfs ?? {};
  const expectedTmpfs = ['rw', 'noexec', 'nosuid', 'nodev', `size=${l.tmpfsBytes}`, 'mode=1777'].sort().join(',');
  if (Object.keys(tmpfs).length !== 1 || String(tmpfs['/tmp'] ?? '').split(',').sort().join(',') !== expectedTmpfs) fail('tmpfs');
  const mounts = (c.Mounts ?? []) as Array<{ Type?: string; Source?: string; Destination?: string; RW?: boolean }>;
  const byTarget = new Map(mounts.map(m => [m.Destination, m]));
  if (mounts.length !== 2 || byTarget.get(INPUT_MOUNT)?.RW !== false || byTarget.get(OUTPUT_MOUNT)?.RW !== true
    || mounts.some(m => m.Type !== 'bind')) fail('mounts');
  // The exact canonical folders of this attempt (the supervisor also re-checks their inode identity).
  if (byTarget.get(INPUT_MOUNT)?.Source !== spec.inputDir || byTarget.get(OUTPUT_MOUNT)?.Source !== spec.outputDir) fail('mount source');
  const ulimits = ((host.Ulimits ?? []) as Array<{ Name?: string; Soft?: number; Hard?: number }>)
    .map(u => `${u.Name}=${u.Soft}:${u.Hard}`).sort().join(',');
  const fsize = Math.max(l.outputBytes, 1);
  if (ulimits !== [`core=0:0`, `fsize=${fsize}:${fsize}`].sort().join(',')) fail('ulimits');
  const env = (config.Env ?? []) as string[];
  const expected = expectedEnv(spec);
  const allowed = new Set([...spec.image.env, ...expected]);
  if (expected.some(e => !env.includes(e)) || env.some(e => !allowed.has(e))) fail('environment');
}

/** A fresh owner nonce for one container. */
export const ownerNonce = (): string => randomUUID();
