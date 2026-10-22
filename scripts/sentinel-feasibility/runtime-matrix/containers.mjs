// Harmless, agent-authored commands only, in the already acquired pinned Semgrep image.
import { randomUUID } from 'node:crypto';
import { CANDIDATES, cleanupOwned, execute, networkDenied } from '../../sentinel-feasibility-scanners.mjs';
export const IMAGE = CANDIDATES[0].image;
const OWNER = 'org.farsight.sentinel-feasibility.owner';
const ok = value => value?.exitCode === 0 && !value.spawnError && !value.timedOut && !value.cancelled && !value.outputExceeded && !value.exitSignal;
export function classifyFailure(value) {
  if (value?.spawnError === 'ENOENT') return 'missing-executable';
  if (value?.cancelled) return 'cancelled';
  if (value?.timedOut) return 'timeout';
  if (value?.outputExceeded) return 'output-budget-exhausted';
  return ok(value) ? 'completed' : 'failed';
}
export function validateIsolation(container, owner) {
  const host = container?.HostConfig;
  if (!/^[a-f0-9]{64}$/.test(container?.Id ?? '') || container.Config?.Labels?.[OWNER] !== owner || container.Config?.Image !== IMAGE ||
      container.Config?.User !== '65534:65534' || host?.NetworkMode !== 'none' || host.ReadonlyRootfs !== true ||
      host.Memory !== 268435456 || host.MemorySwap !== 268435456 || host.NanoCpus !== 1_000_000_000 || host.PidsLimit !== 32 ||
      !host.CapDrop?.includes('ALL') || !host.SecurityOpt?.includes('no-new-privileges:true') ||
      !host.Tmpfs?.['/tmp']?.includes('noexec') || !host.Tmpfs?.['/tmp']?.includes('size=1m') || (container.Mounts ?? []).length !== 0) throw new Error('CONTAINER_ISOLATION_MISMATCH');
  return { id: container.Id, imageId: container.Image, image: container.Config.Image, user: container.Config.User,
    networkMode: host.NetworkMode, readOnlyRootfs: host.ReadonlyRootfs, memoryBytes: host.Memory,
    memorySwapBytes: host.MemorySwap, nanoCpus: host.NanoCpus, pidsLimit: host.PidsLimit,
    capDrop: host.CapDrop, securityOpt: host.SecurityOpt, tmpfs: host.Tmpfs, mounts: [] };
}
export const PROGRAMS = Object.freeze({
  network: 'import socket,json\ns=socket.socket();s.settimeout(2)\ntry:\n s.connect(("192.0.2.1",443)); print(json.dumps({"connected":True}))\nexcept OSError as e:\n print(json.dumps({"connected":False,"errorType":type(e).__name__,"errno":e.errno}))\nfinally:\n s.close()',
  limits: 'import json,resource,pathlib\nb=bytearray(32*1024*1024)\nfor i in range(0,len(b),4096): b[i]=1\nr={"processLifetimeMaxRssKiB":resource.getrusage(resource.RUSAGE_SELF).ru_maxrss}\nfor n in ["memory.max","memory.peak","cpu.max","pids.max"]:\n try: r[n]=pathlib.Path("/sys/fs/cgroup/"+n).read_text().strip()\n except OSError as e: r[n]={"unavailable":type(e).__name__,"errno":e.errno}\nprint(json.dumps(r))',
  timeout: 'import time\nprint("TRUSTED_PROBE_READY",flush=True)\ntime.sleep(30)',
  cancellation: 'import time\nprint("TRUSTED_PROBE_READY",flush=True)\ntime.sleep(30)',
  output: 'import os\nfor i in range(128): os.write(1,b"X"*4096)',
  tmpfs: 'import json,os\ntry:\n with open("/tmp/bounded-probe", "wb") as f: f.write(b"X"*(2*1024*1024))\n print(json.dumps({"unexpectedWrite":True}))\nexcept OSError as e:\n print(json.dumps({"errorType":type(e).__name__,"errno":e.errno}))',
});
export async function containerTrial(scenario, runner = execute, outerSignal) {
  if (!Object.hasOwn(PROGRAMS, scenario) && scenario !== 'missing-executable') throw new Error('INVALID_SCENARIO');
  const owner = randomUUID(), name = `sentinel-runtime-${randomUUID()}`;
  const args = ['create', '--pull', 'never', '--name', name, '--label', `${OWNER}=${owner}`, '--platform', 'linux/arm64',
    '--network', 'none', '--read-only', '--user', '65534:65534', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '--memory', '256m', '--memory-swap', '256m', '--cpus', '1', '--pids-limit', '32', '--tmpfs', '/tmp:rw,noexec,nosuid,size=1m,mode=1777',
    '--env', 'HOME=/tmp', '--env', 'PYTHONDONTWRITEBYTECODE=1', '--entrypoint', scenario === 'missing-executable' ? '/sentinel-executable-intentionally-absent' : 'python3', IMAGE];
  if (scenario !== 'missing-executable') args.push('-c', PROGRAMS[scenario]);
  const record = { scenario, name, owner, command: ['docker', ...args], state: 'failed' };
  let identity = name;
  const inspect = async () => {
    const observation = await runner('docker', ['inspect', '--type', 'container', identity], { timeout: 10_000 });
    if (!ok(observation)) throw new Error('CONTAINER_INSPECTION_UNAVAILABLE');
    const values = JSON.parse(observation.stdout);
    if (values.length !== 1 || (/^[a-f0-9]{64}$/.test(identity) && values[0].Id !== identity)) throw new Error('CONTAINER_IDENTITY_MISMATCH');
    const isolation = validateIsolation(values[0], owner);
    return { isolation, state: values[0].State };
  };
  try {
    record.create = await runner('docker', args, { timeout: 10_000, signal: outerSignal });
    if (!ok(record.create)) throw new Error('CONTAINER_CREATE_FAILED');
    identity = record.create.stdout.trim();
    if (!/^[a-f0-9]{64}$/.test(identity)) throw new Error('INVALID_CONTAINER_ID');
    const before = await inspect(); record.isolation = before.isolation;
    const controller = new AbortController(), cancelOuter = () => controller.abort();
    outerSignal?.addEventListener('abort', cancelOuter, { once: true });
    if (outerSignal?.aborted) controller.abort();
    // Cancellation starts after a bounded real delay; READY establishes whether the command actually began.
    const timer = scenario === 'cancellation' ? setTimeout(() => controller.abort(), 1500) : null;
    try { record.execution = await runner('docker', ['start', '--attach', identity], { timeout: scenario === 'timeout' ? 1500 : 10_000, maxOutput: scenario === 'output' ? 16_384 : 65_536, signal: controller.signal }); }
    finally { clearTimeout(timer); outerSignal?.removeEventListener('abort', cancelOuter); }
    record.afterClient = await inspect();
    record.outcome = classifyFailure(record.execution);
    if (scenario === 'missing-executable') record.outcome = !ok(record.execution) && /(?:no such file|not found|executable file)/i.test(record.execution.stderr) ? 'missing-container-executable' : 'unexpected-missing-executable-result';
    if (['network', 'limits', 'tmpfs'].includes(scenario)) try { record.observation = JSON.parse(record.execution.stdout); } catch { record.observation = null; }
    const complete = record.afterClient.state?.Status === 'exited' && record.afterClient.state?.OOMKilled === false && record.afterClient.state?.ExitCode === 0;
    record.passed = scenario === 'network' ? complete && networkDenied({ isolation: record.isolation, execution: record.execution, socketAttempt: record.observation })
      : scenario === 'timeout' ? record.outcome === 'timeout' && record.execution.stdout.includes('TRUSTED_PROBE_READY')
      : scenario === 'cancellation' ? record.outcome === 'cancelled' && record.execution.stdout.includes('TRUSTED_PROBE_READY')
      : scenario === 'output' ? record.outcome === 'output-budget-exhausted' && Buffer.byteLength(record.execution.stdout) <= 16_384
      : scenario === 'tmpfs' ? complete && ok(record.execution) && record.observation?.errno === 28
      : scenario === 'missing-executable' ? record.outcome === 'missing-container-executable'
      : complete && ok(record.execution) && record.observation?.['memory.max'] === '268435456' && record.observation?.['pids.max'] === '32' && record.observation?.['cpu.max'] === '100000 100000';
  } catch (error) { record.reason = error.message; record.passed = false; }
  finally {
    try { record.cleanup = await cleanupOwned(runner, identity, owner); }
    catch (error) { record.cleanup = { state: 'cleanup-failed', reason: error.message }; }
    record.passed = record.passed === true && record.cleanup.state === 'removed-owned-container';
    record.state = record.passed ? 'measured' : 'failed';
  }
  return record;
}
export { ok };
