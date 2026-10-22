// A deliberately misbehaving Sentinel worker for the execution tests. Synthetic only: it reads only what it is
// given, contacts nothing beyond the reserved test addresses below, and every "escape" it tries must fail.
// Runs two ways: as a built-in child (a wrapper sets globalThis.SENTINEL_BEHAVIOR) and inside a container
// (`node --input-type=module -e <this file> <behavior> [argument]`).
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, symlinkSync, existsSync, openSync, writeSync, closeSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { lookup } from 'node:dns/promises';

const args = globalThis.SENTINEL_BEHAVIOR ? [globalThis.SENTINEL_BEHAVIOR, globalThis.SENTINEL_ARGUMENT] : process.argv.slice(1);
const [behavior, argument] = args;
const IN = process.env.SENTINEL_INPUT, OUT = process.env.SENTINEL_OUTPUT;
const send = m => process.stdout.write(`${JSON.stringify(m)}\n`);
const raw = s => process.stdout.write(s);
const P = 'sentinel-worker/draft-1';
const hello = () => send({ protocol: P, type: 'hello', supported: [P], adapterId: process.env.SENTINEL_ADAPTER_ID, adapterDigest: process.env.SENTINEL_ADAPTER_DIGEST });
const sha = b => createHash('sha256').update(b).digest('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let seq = 0;
const bound = (start, extra = {}) => ({ attemptId: start.attemptId, work: start.work, coordinatorEpoch: start.coordinatorEpoch, seq: seq++, ...extra });

function writeArtifact(bytes) {
  const hex = sha(bytes);
  writeFileSync(`${OUT}/${hex}`, bytes);
  return { id: `sha256:${hex}`, mediaType: 'application/json', bytes: bytes.length };
}

function result(start, artifacts, extra = {}) {
  send({ protocol: P, type: 'result', ...bound(start), inputFingerprint: start.inputFingerprint, granularity: 'per-file',
    artifacts, observations: artifacts.map(a => a.id), coveredChecks: [], scannedSet: [], skipped: [], actualReadSet: [],
    unresolvedFrontiers: [], diagnostics: [], ...extra });
}

/** Read every input and write one summary artifact naming the inputs and their digests. */
function honestWork(start) {
  const read = start.inputs.map(id => ({ id, sha256: sha(readFileSync(`${IN}/${id.slice(7)}`)) }));
  return [writeArtifact(Buffer.from(JSON.stringify({ read })))];
}

async function tryEscapes() {
  const report = {};
  const attempt = async (name, fn) => { try { await fn(); report[name] = 'ESCAPED'; } catch (e) { report[name] = e.code ?? e.name ?? 'refused'; } };
  if (behavior === 'network') {
    // 192.0.2.1 is TEST-NET-1 (RFC 5737): no real host is ever contacted.
    await attempt('tcp', () => new Promise((resolve, reject) => {
      const s = connect({ host: '192.0.2.1', port: 443, timeout: 2000 }, () => { s.destroy(); resolve(); });
      s.on('error', reject); s.on('timeout', () => { s.destroy(); reject(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })); });
    }));
    await attempt('dns', async () => { await lookup('example.com'); });
  }
  if (behavior === 'hostfile') {
    await attempt('hostPath', async () => { readFileSync(argument); });
    // On the host the attempt folder sits beside secret-canary.txt; through the mount it must be unreachable.
    await attempt('besideAttempt', async () => { readFileSync(`${IN}/../../secret-canary.txt`); });
    await attempt('dockerSocket', async () => { if (!existsSync('/var/run/docker.sock')) throw Object.assign(new Error('absent'), { code: 'ENOENT' }); openSync('/var/run/docker.sock', 'r'); });
    await attempt('writeInput', async () => { writeFileSync(`${IN}/planted`, 'x'); });
    await attempt('writeRoot', async () => { writeFileSync('/planted', 'x'); });
    report.environment = Object.keys(process.env).sort();
  }
  if (behavior === 'tmpfs') {
    await attempt('fillTmp', async () => { const fd = openSync('/tmp/fill', 'w'); const mb = Buffer.alloc(1024 * 1024, 1); try { for (let i = 0; i < 2048; i++) writeSync(fd, mb); } finally { closeSync(fd); } });
  }
  if (behavior === 'pids') {
    let started = 0;
    const kids = [];
    await attempt('forkMany', async () => {
      for (let i = 0; i < 400; i++) {
        const child = spawn('sleep', ['30'], { stdio: 'ignore' });
        await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
        kids.push(child); started++;
      }
    });
    report.started = started;
    for (const k of kids) k.kill('SIGKILL');
  }
  return report;
}

const lines = [];
let wake;
let buffered = '';
process.stdin.on('data', b => {
  buffered += b.toString('utf8');
  for (let nl; (nl = buffered.indexOf('\n')) >= 0;) { lines.push(JSON.parse(buffered.slice(0, nl))); buffered = buffered.slice(nl + 1); wake?.(); }
});
const next = async () => { while (!lines.length) await new Promise(r => { wake = r; }); return lines.shift(); };
const awaitStart = async () => { const w = await next(); if (w.type !== 'welcome') process.exit(9); return next(); };

switch (behavior) {
  case 'no-hello': await sleep(60_000); break;
  case 'message-before-hello': raw('{"protocol":"sentinel-worker/draft-1","type":"progress"}\n'); await sleep(60_000); break;
  case 'old-version': send({ protocol: P, type: 'hello', supported: ['sentinel-worker/draft-9'], adapterId: process.env.SENTINEL_ADAPTER_ID, adapterDigest: process.env.SENTINEL_ADAPTER_DIGEST }); await sleep(60_000); break;
  case 'result-before-start': {
    // Answers before it has read its start message, so it can only guess the binding.
    hello();
    send({ protocol: P, type: 'result', attemptId: 'attempt-guessed', work: { id: 'work-guessed', revision: 1 }, coordinatorEpoch: 'epoch-guessed', seq: 0,
      inputFingerprint: `sha256:${'4'.repeat(64)}`, granularity: 'per-file', artifacts: [], observations: [], coveredChecks: [], scannedSet: [],
      skipped: [], actualReadSet: [], unresolvedFrontiers: [], diagnostics: [] });
    await sleep(60_000); break;
  }
  case 'unterminated': hello(); await next(); raw('{"protocol":"sentinel-worker/draft-1"'); await sleep(50); process.exit(0);
  case 'wrong-adapter': send({ protocol: P, type: 'hello', supported: [P], adapterId: process.env.SENTINEL_ADAPTER_ID, adapterDigest: `sha256:${'0'.repeat(64)}` }); await sleep(60_000); break;
  default: {
    hello();
    const start = await awaitStart();
    switch (behavior) {
      case 'ok': result(start, honestWork(start)); break;
      case 'stderr-flood': process.stderr.write('E'.repeat(1024 * 1024)); result(start, honestWork(start)); break;
      case 'progress-then-ok': send({ protocol: P, type: 'progress', ...bound(start), completed: 1, planned: 2 }); result(start, honestWork(start)); break;
      case 'huge-frame': raw('{"x":"' + 'A'.repeat(2 * 1024 * 1024)); await sleep(60_000); break;
      case 'bad-json': raw('{not json}\n'); await sleep(60_000); break;
      case 'bad-utf8': process.stdout.write(Buffer.from([0x7b, 0xff, 0xfe, 0x7d, 0x0a])); await sleep(60_000); break;
      case 'schema-invalid': send({ protocol: P, type: 'progress', ...bound(start), completed: -1, planned: 'many' }); await sleep(60_000); break;
      case 'forged-epoch': send({ protocol: P, type: 'progress', ...bound(start), coordinatorEpoch: 'epoch-forged', completed: 0, planned: 1 }); await sleep(60_000); break;
      case 'other-attempt': send({ protocol: P, type: 'progress', ...bound(start), attemptId: 'attempt-someone-else', completed: 0, planned: 1 }); await sleep(60_000); break;
      case 'other-revision': send({ protocol: P, type: 'progress', ...bound(start), work: { id: start.work.id, revision: start.work.revision + 1 }, completed: 0, planned: 1 }); await sleep(60_000); break;
      case 'seq-repeat': { send({ protocol: P, type: 'progress', ...bound(start), completed: 0, planned: 1 }); seq = 0; send({ protocol: P, type: 'progress', ...bound(start), completed: 0, planned: 1 }); await sleep(60_000); break; }
      case 'duplicate-result': { const a = honestWork(start); result(start, a); result(start, a); break; }
      case 'result-then-malformed': { result(start, honestWork(start)); raw('{broken\n'); break; }
      case 'result-then-partial': { result(start, honestWork(start)); raw('{"protocol":"sentinel-worker/draft-1","type":'); await sleep(50); process.exit(0); }
      case 'late-output': { result(start, honestWork(start)); await sleep(100); writeFileSync(`${OUT}/late`, 'written after the result'); break; }
      case 'seq-gap': seq = 5; send({ protocol: P, type: 'progress', ...bound(start), completed: 0, planned: 1 }); await sleep(60_000); break;
      case 'heartbeat': send({ protocol: P, type: 'heartbeat', ...bound(start), fencingGeneration: 1 }); await sleep(60_000); break;
      case 'wrong-fingerprint': result({ ...start, inputFingerprint: `sha256:${'1'.repeat(64)}` }, honestWork(start)); await sleep(60_000); break;
      case 'stdout-flood': for (let i = 0; i < 200_000; i++) send({ protocol: P, type: 'progress', ...bound(start), completed: 0, planned: 1 }); await sleep(60_000); break;
      case 'unlisted-output': writeFileSync(`${OUT}/extra`, 'planted'); result(start, honestWork(start)); break;
      case 'tampered-output': { const a = honestWork(start); writeFileSync(`${OUT}/${a[0].id.slice(7)}`, Buffer.from(JSON.stringify({ read: [] }).padEnd(a[0].bytes))); result(start, a); break; }
      case 'linked-output': { const t = Buffer.from('link-target'); const hex = sha(t); symlinkSync(`${IN}/${start.inputs[0].slice(7)}`, `${OUT}/${hex}`); result(start, [{ id: `sha256:${hex}`, mediaType: 'text/plain', bytes: t.length }]); break; }
      case 'phantom-reference': result(start, honestWork(start), { observations: [`sha256:${'2'.repeat(64)}`] }); break;
      case 'frame-after-result': { const a = honestWork(start); result(start, a); send({ protocol: P, type: 'progress', ...bound(start), completed: 1, planned: 1 }); break; }
      case 'exit-nonzero-after-result': result(start, honestWork(start)); await sleep(50); process.exit(4);
      case 'output-flood': { const mb = Buffer.alloc(1024 * 1024, 7); for (let i = 0; i < 64; i++) writeFileSync(`${OUT}/flood-${i}`, mb); await sleep(60_000); break; }
      case 'hang': await sleep(600_000); break;
      case 'ack-cancel': { const m = await next(); if (m.type === 'cancel') send({ protocol: P, type: 'cancel-ack', ...bound(start) }); await sleep(100); break; }
      case 'ignore-cancel': await sleep(600_000); break;
      case 'memory': { const hog = []; for (let i = 0; i < 4096; i++) { const b = Buffer.alloc(16 * 1024 * 1024, i & 255); hog.push(b); } result(start, honestWork(start)); break; }
      case 'identity': {
        // What the kernel says this process may do, not what the container configuration claims.
        const status = readFileSync('/proc/self/status', 'utf8');
        const field = name => new RegExp(`^${name}:\\s*(.*)$`, 'm').exec(status)?.[1]?.trim();
        const { networkInterfaces } = await import('node:os');
        let rootWritable = 'refused';
        try { writeFileSync('/identity-probe', 'x'); rootWritable = 'ESCAPED'; } catch (e) { rootWritable = e.code; }
        process.stderr.write(`canary ${JSON.stringify({ uid: process.getuid(), gid: process.getgid(), capEff: field('CapEff'), capPrm: field('CapPrm'),
          capBnd: field('CapBnd'), noNewPrivs: field('NoNewPrivs'), seccomp: field('Seccomp'), interfaces: Object.keys(networkInterfaces()).sort(), rootWritable })}\n`);
        process.exit(3);
      }
      case 'cpu': {
        // Three busy processes for two seconds; the cgroup's own usage counter says how much CPU they got.
        const usage = () => Number(/usage_usec (\d+)/.exec(readFileSync('/sys/fs/cgroup/cpu.stat', 'utf8'))?.[1]);
        const before = usage(), t0 = Date.now();
        const busy = Array.from({ length: 3 }, () => spawn(process.execPath, ['-e', 'const e=Date.now()+2000;while(Date.now()<e){}'], { stdio: 'ignore' }));
        await Promise.all(busy.map(c => new Promise(r => c.on('close', r))));
        const wallUs = (Date.now() - t0) * 1000;
        const throttled = Number(/nr_throttled (\d+)/.exec(readFileSync('/sys/fs/cgroup/cpu.stat', 'utf8'))?.[1]);
        process.stderr.write(`canary ${JSON.stringify({ cpuRatio: Number(((usage() - before) / wallUs).toFixed(2)), throttled, wallMs: wallUs / 1000 })}\n`);
        process.exit(3);
      }
      case 'fsize': {
        // One file larger than the per-file ceiling (the output budget): the kernel refuses the write.
        let outcome = 'ESCAPED';
        try { const fd = openSync(`${OUT}/big`, 'w'); const mb = Buffer.alloc(1024 * 1024, 5); try { for (let i = 0; i < 16; i++) writeSync(fd, mb); } finally { closeSync(fd); } }
        catch (e) { outcome = e.code; }
        process.stderr.write(`canary ${JSON.stringify({ fsize: outcome })}\n`);
        process.exit(3);
      }
      case 'network': case 'hostfile': case 'tmpfs': case 'pids': {
        const report = await tryEscapes();
        process.stderr.write(`canary ${JSON.stringify(report)}\n`);
        // Only an escape produces a result; a contained canary ends without one, which the supervisor records.
        if (Object.values(report).includes('ESCAPED')) result(start, [writeArtifact(Buffer.from(JSON.stringify(report)))]);
        else process.exit(3);
        break;
      }
      default: process.exit(8);
    }
  }
}
