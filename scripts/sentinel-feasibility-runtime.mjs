#!/usr/bin/env node
// PR01 prototype. No acquisition, fixture execution, host scanner fallback or production support claim.
import { readFile, mkdir, writeFile, access, readdir, lstat } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpus, totalmem, release, platform, arch } from 'node:os';
import { execute, scrub, validateHost, validateDockerPlatform } from './sentinel-feasibility-scanners.mjs';
import { IMAGE, containerTrial, classifyFailure, missingImage, ok } from './sentinel-feasibility/runtime-matrix/containers.mjs';
import { resourceTrials, sha } from './sentinel-feasibility/runtime-matrix/resources.mjs';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['scripts/sentinel-feasibility-runtime.mjs', 'scripts/sentinel-feasibility/runtime-matrix/containers.mjs', 'scripts/sentinel-feasibility/runtime-matrix/resources.mjs', 'scripts/sentinel-feasibility/runtime-matrix/codec-worker.mjs', 'scripts/sentinel-feasibility-scanners.mjs'];
export function parseArgs(args) {
  const options = { run: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--run') options.run = true;
    else if (args[i] === '--help') options.help = true;
    else if (args[i] === '--out' && args[i + 1] && !args[i + 1].startsWith('--')) options.out = resolve(args[++i]);
    else throw new Error('Unknown option or missing value');
  }
  if (options.run && !options.out) throw new Error('--run requires --out <fresh-directory>');
  return options;
}
export function preview() {
  return { state: 'preview', effects: ['Fresh private output directory; synthetic JSON artifacts (64KiB/1MiB/8MiB minimum), 54 bounded fresh-child codec trials', 'Read installed Docker identities; inspect pinned image without pull; actual missing executable/image, bounded harmless container controls', 'Seven uniquely owned containers, network none, UID65534, read-only root, no host mounts, noexec 1MiB tmpfs, 256MiB memory/swap, 1CPU,32PIDs; exact-ID cleanup verified'],
    image: IMAGE, run: 'node scripts/sentinel-feasibility-runtime.mjs --run --out /tmp/sentinel-runtime-matrix-new',
    notRun: ['No download, source execution, fixture dependency installation, advisory requests, model/provider operation or scanner host fallback'],
    gaps: ['No installed candidate advisory database: missing-db prerequisite check is synthetic, not candidate DB behavior', 'Required unavailable online/advisory check remains gap', 'Other host/runtime versions untested; production crash/orphan recovery PR08/26'] };
}
export function resourcePreflight(info, request) {
  if (!Number.isSafeInteger(request.memoryBytes) || request.memoryBytes < 1 || !Number.isSafeInteger(request.cpus) || request.cpus < 1) throw new Error('INVALID_RESOURCE_REQUEST');
  if (!Number.isSafeInteger(info?.MemTotal) || !Number.isSafeInteger(info?.NCPU) || info.MemTotal < 1 || info.NCPU < 1) return { state: 'gap', admitted: false, reason: 'VM_QUOTAS_UNAVAILABLE' };
  if (request.memoryBytes > info.MemTotal || request.cpus > info.NCPU) return { state: 'gap', admitted: false, reason: 'VM_RESOURCE_BUDGET_EXHAUSTED', requested: request, available: { memoryBytes: info.MemTotal, cpus: info.NCPU } };
  if (![info.MemoryLimit, info.SwapLimit, info.CpuCfsQuota, info.PidsLimit].every(value => value === true)) return { state: 'gap', admitted: false, reason: 'REQUIRED_RESOURCE_CONTROLLER_UNAVAILABLE' };
  return { state: 'admitted', admitted: true, requested: request };
}
async function provenance(runner) {
  const revision = await runner('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { timeout: 10_000 });
  const status = await runner('git', ['-C', ROOT, '-c', 'filter.lfs.process=', '-c', 'filter.lfs.required=false', 'status', '--porcelain=v1', '--untracked-files=all', '--', ...FILES], { timeout: 10_000 });
  return { revision: ok(revision) ? revision.stdout.trim() : null, dirty: ok(status) ? Boolean(status.stdout.trim()) : null,
    files: await Promise.all(FILES.map(async path => ({ path, sha256: sha(await readFile(join(ROOT, path))) }))) };
}
async function inventory(out) {
  const artifacts = [];
  for (const entry of await readdir(out, { withFileTypes: true })) {
    if (entry.name === 'result.json') continue;
    if (entry.isDirectory()) {
      for (const file of await readdir(join(out, entry.name), { withFileTypes: true })) {
        if (!file.isFile()) throw new Error('UNEXPECTED_ARTIFACT_TYPE');
        const bytes = await readFile(join(out, entry.name, file.name));
        artifacts.push({ path: `${entry.name}/${file.name}`, bytes: bytes.length, sha256: sha(bytes) });
      }
    } else if (entry.isFile()) {
      const bytes = await readFile(join(out, entry.name)); artifacts.push({ path: entry.name, bytes: bytes.length, sha256: sha(bytes) });
    } else throw new Error('UNEXPECTED_ARTIFACT_TYPE');
  }
  return artifacts;
}
export async function runProbe({ out }, { runner = execute, signal } = {}) {
  validateHost();
  if (!out) throw new Error('FRESH_OUTPUT_REQUIRED');
  // Parent must exist, and the output itself must be new; never overwrite or follow an existing output link.
  const parent = await lstat(dirname(resolve(out)));
  if (!parent.isDirectory()) throw new Error('OUTPUT_PARENT_MUST_BE_DIRECTORY');
  await mkdir(out, { mode: 0o700 });
  const result = { format: 'sentinel-runtime-matrix/draft-1', state: 'failed', startedAt: new Date().toISOString(),
    host: { os: platform(), arch: arch(), osRelease: release(), cpuModel: cpus()[0]?.model ?? null, logicalCpus: cpus().length, memoryBytes: totalmem(), node: process.versions.node },
    controls: [], containers: [], gaps: [
      { id: 'candidate-advisory-database', state: 'gap', reason: 'No candidate advisory database is installed in this experiment. Synthetic missing-file check does not establish scanner database semantics.' },
      { id: 'required-online-advisory', state: 'gap', reason: 'Required online advisory work unavailable under network-none; no acquisition or cached verdict fabricated.' },
      { id: 'production-crash-orphan-recovery', state: 'deferred', reason: 'PR08/26; normal-process timeout/cancellation/finally cleanup does not establish crash recovery.' },
      { id: 'host-runtime-matrix', state: 'deferred', reason: 'Only observed native macOS ARM64 host plus Linux ARM64 Docker VM; no Colima, independent Linux host, AMD64 or Windows support measured.' },
    ] };
  const persist = async () => writeFile(join(out, 'result.json'), scrub(JSON.stringify(result, null, 2)) + '\n', { mode: 0o600 });
  const control = (id, passed, evidence) => result.controls.push({ id, passed, evidence });
  try {
    if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('NODE24_REQUIRED');
    result.provenance = await provenance(runner);
    if (!result.provenance.revision || result.provenance.dirty !== false) throw new Error('COMMITTED_CLEAN_EXPERIMENT_REQUIRED');
    await persist();
    const missing = await runner(join(out, 'executable-intentionally-absent'), [], { timeout: 1000 });
    control('actual-missing-host-executable-preflight', classifyFailure(missing) === 'missing-executable', missing);
    let missingDatabase;
    try { await access(join(out, 'database-intentionally-absent.db')); missingDatabase = 'unexpected-present'; } catch (error) { missingDatabase = error.code; }
    control('synthetic-missing-database-prerequisite', missingDatabase === 'ENOENT', { classification: missingDatabase, boundary: 'Harness filesystem prerequisite only; no candidate database/tool behavior claim' });
    const vm = await runner('docker', ['info', '--format', '{{json .}}'], { timeout: 15_000, signal });
    if (!ok(vm)) { result.runtimeFailure = vm; throw new Error('DOCKER_RUNTIME_UNAVAILABLE_NO_FALLBACK'); }
    const info = JSON.parse(vm.stdout);
    result.vm = Object.fromEntries(['ID', 'ServerVersion', 'KernelVersion', 'OperatingSystem', 'OSType', 'Architecture', 'NCPU', 'MemTotal', 'CgroupVersion', 'CgroupDriver', 'MemoryLimit', 'SwapLimit', 'CpuCfsQuota', 'PidsLimit', 'SecurityOptions'].map(key => [key, info[key]]));
    result.desktop = await runner('docker', ['desktop', 'version'], { timeout: 10_000 });
    result.macOS = await runner('sw_vers', ['-productVersion'], { timeout: 10_000 });
    const request = { memoryBytes: 268435456, cpus: 1 };
    const admission = resourcePreflight(info, request); control('actual-runtime-resource-admission', admission.admitted, admission);
    const excessive = resourcePreflight(info, { memoryBytes: info.MemTotal + 1, cpus: 1 });
    control('actual-vm-quota-admission-exhaustion', excessive.reason === 'VM_RESOURCE_BUDGET_EXHAUSTED', excessive);
    control('synthetic-unavailable-controller-preflight', resourcePreflight({ ...info, MemoryLimit: false }, request).reason === 'REQUIRED_RESOURCE_CONTROLLER_UNAVAILABLE', { state: 'gap', reason: 'Synthetic missing-controller prerequisite; no cgroup disabled on host' });
    const absentReference = 'farsight-sentinel-intentionally-absent@sha256:' + '0'.repeat(64);
    const absentImage = await runner('docker', ['image', 'inspect', absentReference], { timeout: 10_000, signal });
    control('actual-missing-image-preflight-no-pull', missingImage(absentImage, absentReference), absentImage);
    const version = await runner('docker', ['version', '--format', '{{json .}}'], { timeout: 10_000, signal });
    const image = await runner('docker', ['image', 'inspect', IMAGE], { timeout: 10_000, signal });
    if (!ok(version) || !ok(image)) { result.imageFailure = { version, image }; throw new Error('PINNED_IMAGE_OR_DOCKER_VERSION_UNAVAILABLE_NO_ACQUISITION'); }
    result.platform = validateDockerPlatform(version, [{ candidate: 'semgrep-harmless-runtime-probe', inspection: image }]);
    const parsedImage = JSON.parse(image.stdout)[0]; result.image = { reference: IMAGE, id: parsedImage.Id, repoDigests: parsedImage.RepoDigests, architecture: parsedImage.Architecture, os: parsedImage.Os };
    if (!admission.admitted) throw new Error('RESOURCE_ADMISSION_REFUSED');
    await persist();
    for (const scenario of ['network', 'limits', 'missing-executable', 'timeout', 'cancellation', 'output', 'tmpfs']) {
      if (signal?.aborted) throw new Error('EXPERIMENT_CANCELLED');
      const trial = await containerTrial(scenario, runner, signal); result.containers.push(trial);
      control(`container-${scenario}`, trial.passed, { state: trial.state, outcome: trial.outcome, cleanup: trial.cleanup.state });
      await persist();
      if (!trial.passed) throw new Error('CONTAINER_CONTROL_FAILED');
    }
    result.resources = await resourceTrials(out, runner, signal);
    control('codec-resource-trials', result.resources.accounting.passed, result.resources.accounting);
    result.gaps.push(...result.resources.gaps);
    result.state = result.controls.every(value => value.passed) ? 'measured-with-explicit-gaps' : 'failed';
  } catch (error) { result.reason = scrub(error.message); }
  finally { result.endedAt = new Date().toISOString(); result.artifacts = await inventory(out); await persist(); }
  return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) console.log('Usage: node scripts/sentinel-feasibility-runtime.mjs [--run --out <fresh-directory>]');
    else if (!options.run) console.log(JSON.stringify(preview(), null, 2));
    else {
      const controller = new AbortController(), cancel = () => controller.abort();
      process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
      try { const result = await runProbe(options, { signal: controller.signal }); console.log(JSON.stringify({ state: result.state, controls: result.controls.length, trials: result.resources?.trials.length ?? 0, measuredTrials: result.resources?.accounting.measuredTrials ?? 0, unavailableTrials: result.resources?.accounting.unavailableTrials ?? 0 })); if (result.state === 'failed') process.exitCode = 1; }
      finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
    }
  } catch (error) { console.error(scrub(error.message)); process.exitCode = 1; }
}
