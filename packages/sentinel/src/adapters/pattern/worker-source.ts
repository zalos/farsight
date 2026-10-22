// The pattern adapter's in-container worker: an original Sentinel shim that speaks the sentinel-worker protocol for
// Semgrep, which cannot. It runs as `/usr/bin/python3 -I -S -B /input/<its own digest>` inside the pinned image, under
// PR 07's container controls (no network, read-only root, non-root, noexec /tmp, inputs read-only at /input).
//
// It is transport, not authority: it materializes the job's targets under /tmp by the relative paths the job names,
// runs the fixed Semgrep invocation with telemetry and version checks off, and hands back the bounded raw JSON and a
// run record as output artifacts. Every interpretation (which results count, spans, coverage, identity) happens in
// the coordinator's normalizer over those verified outputs. Standard library only; no repository file is executed.
//
// Kept as a string so the package ships it inside dist with no extra build step; its SHA-256 is part of the adapter's
// fixed command and therefore of the adapter digest. Avoid backticks and dollar-brace in the Python below.
export const PATTERN_WORKER_SOURCE = String.raw`# Sentinel pattern worker (sentinel-pattern-worker/1). Original; standard library only.
import hashlib, json, os, subprocess, sys, threading, time

PROTOCOL = 'sentinel-worker/draft-1'
JOB_SCHEMA = 'sentinel-pattern-job/draft-1'
MAX_JOB_BYTES = 1048576
MAX_ENGINE_STDOUT = 3145728
MAX_ENGINE_STDERR = 65536
NEVER_MATERIALIZED = ('.semgrepignore', '.gitignore', '.semgrep', '.semgrep.yml', '.semgrep.yaml', '.semgrepconfig')
ENGINE_ARGS = [ENGINE_ARGS_JSON]

out = sys.stdout.buffer
lock = threading.Lock()
state = {'seq': 0, 'binding': None, 'cancel': False, 'proc': None}

def send(message):
    data = (json.dumps(message, separators=(',', ':'), ensure_ascii=False) + '\n').encode('utf-8')
    with lock:
        out.write(data)
        out.flush()

def bound(kind, **fields):
    b = state['binding']
    m = {'protocol': PROTOCOL, 'type': kind, 'attemptId': b['attemptId'], 'work': b['work'], 'coordinatorEpoch': b['coordinatorEpoch'], 'seq': state['seq']}
    state['seq'] += 1
    m.update(fields)
    return m

def read_frame():
    line = sys.stdin.buffer.readline()
    if not line:
        return None
    return json.loads(line.decode('utf-8'))

def sha(data):
    return 'sha256:' + hashlib.sha256(data).hexdigest()

def input_path(artifact):
    return '/input/' + artifact[len('sha256:'):]

def read_input(artifact, limit):
    path = input_path(artifact)
    st = os.lstat(path)
    if not os.path.isfile(path) or os.path.islink(path) or st.st_size > limit:
        return None
    with open(path, 'rb') as f:
        data = f.read(limit + 1)
    if len(data) > limit or sha(data) != artifact:
        return None
    return data

def safe_rel(path):
    if not isinstance(path, str) or not path or len(path.encode('utf-8')) > 1024:
        return False
    if path.startswith('/') or '\\' in path or '\x00' in path or path.endswith('/'):
        return False
    return all(seg not in ('', '.', '..') for seg in path.split('/'))

# A failed engine run is reported as one fixed category and its exit code. Engine messages can quote arguments, paths
# and source text, so stderr is only matched here, never forwarded or stored; its digest stays in the run record.
EXIT_CATEGORIES = {4: 'invalidPattern', 5: 'unparseableConfig', 7: 'missingConfig', 8: 'invalidLanguage'}
ARGUMENT_MARKERS = (b'Invalid value for', b'invalid value', b'No such option', b'Usage:')

def failure_category(code, err):
    if code in EXIT_CATEGORIES:
        return EXIT_CATEGORIES[code]
    if code == 2 and any(m in err for m in ARGUMENT_MARKERS):
        return 'invalidArgument'
    if code in (137, -9):
        return 'killed'
    return 'unknown'

def finish(status):
    # A daemon thread is blocked reading stdin; a normal interpreter shutdown would wait on its lock. Flush and leave.
    with lock:
        out.flush()
    os._exit(status)

def fail(code):
    send(bound('diagnostic', code=code))
    finish(3)

def watch_cancel():
    while True:
        try:
            frame = read_frame()
        except Exception:
            return
        if frame is None:
            return
        if frame.get('type') == 'cancel':
            state['cancel'] = True
            proc = state['proc']
            if proc is not None:
                try:
                    proc.kill()
                except Exception:
                    pass
            return

def main():
    send({'protocol': PROTOCOL, 'type': 'hello', 'supported': [PROTOCOL], 'adapterId': os.environ.get('SENTINEL_ADAPTER_ID', ''), 'adapterDigest': os.environ.get('SENTINEL_ADAPTER_DIGEST', '')})
    welcome = read_frame()
    if not welcome or welcome.get('type') != 'welcome':
        finish(2)
    start = read_frame()
    if not start or start.get('type') != 'start':
        finish(2)
    state['binding'] = {'attemptId': start['attemptId'], 'work': start['work'], 'coordinatorEpoch': start['coordinatorEpoch']}
    threading.Thread(target=watch_cancel, daemon=True).start()

    jobs = []
    for artifact in start['inputs']:
        data = read_input(artifact, MAX_JOB_BYTES)
        if data is None:
            continue
        try:
            value = json.loads(data.decode('utf-8'))
        except Exception:
            continue
        if isinstance(value, dict) and value.get('schema') == JOB_SCHEMA:
            jobs.append((artifact, value))
    if len(jobs) != 1:
        fail('sentinel.pattern.jobAmbiguous')
    job_digest, job = jobs[0]

    work = '/tmp/sentinel-pattern'
    tree = work + '/tree'
    os.makedirs(tree, mode=0o700)
    rules = read_input(job['rules'], MAX_JOB_BYTES)
    if rules is None:
        fail('sentinel.pattern.rulesMissing')
    with open(work + '/rules.yaml', 'wb') as f:
        f.write(rules)
    excluded = []
    for target in job['targets']:
        rel = target['path']
        if not safe_rel(rel):
            fail('sentinel.pattern.unsafePath')
        if rel.split('/')[-1] in NEVER_MATERIALIZED:
            excluded.append(rel)
            continue
        data = read_input(target['artifact'], int(job['maxTargetBytesRead']))
        if data is None:
            fail('sentinel.pattern.targetMissing')
        dest = tree + '/' + rel
        os.makedirs(os.path.dirname(dest), mode=0o700, exist_ok=True)
        fd = os.open(dest, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'wb') as f:
            f.write(data)

    # An empty ignore file owned by the worker: the engine's built-in default ignores (tests/, dist/, node_modules/...)
    # would otherwise drop targets the owner asked for. Repository ignore files are never materialized.
    fd = os.open(tree + '/.semgrepignore', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    os.close(fd)
    env = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': '/tmp', 'SEMGREP_SEND_METRICS': 'off', 'SEMGREP_ENABLE_VERSION_CHECK': '0', 'PYTHONIOENCODING': 'utf8', 'PYTHONUNBUFFERED': '1'}
    argv = ['/usr/bin/semgrep'] + ENGINE_ARGS + ['--config', work + '/rules.yaml', tree]
    started = time.monotonic()
    proc = subprocess.Popen(argv, cwd=tree, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    state['proc'] = proc
    result = {'out': b'', 'outBytes': 0, 'err': b'', 'errBytes': 0}

    def pump(stream, key, cap):
        while True:
            chunk = stream.read(65536)
            if not chunk:
                return
            result[key + 'Bytes'] += len(chunk)
            if len(result[key]) < cap:
                result[key] += chunk[:cap - len(result[key])]
            if key == 'out' and result['outBytes'] > cap:
                try:
                    proc.kill()
                except Exception:
                    pass

    pumps = [threading.Thread(target=pump, args=(proc.stdout, 'out', MAX_ENGINE_STDOUT)), threading.Thread(target=pump, args=(proc.stderr, 'err', MAX_ENGINE_STDERR))]
    for t in pumps:
        t.start()
    timed_out = False
    try:
        code = proc.wait(timeout=float(job['engineTimeoutSeconds']))
    except subprocess.TimeoutExpired:
        timed_out = True
        proc.kill()
        code = proc.wait()
    for t in pumps:
        t.join()
    if state['cancel']:
        send(bound('cancel-ack'))
        finish(0)

    engine = result['out']
    failure = None
    if code != 0:
        failure = {'category': failure_category(code, result['err']), 'exitCode': code}
        send(bound('diagnostic', code='sentinel.pattern.engine.' + failure['category']))
        sys.stderr.write('sentinel.pattern.engine.' + failure['category'] + ' exit ' + str(code) + '\n')
        sys.stderr.flush()
    record = {
        'schema': 'sentinel-pattern-run/draft-1', 'job': job_digest, 'exitCode': code, 'timedOut': timed_out,
        'stdoutBytes': result['outBytes'], 'stdoutTruncated': result['outBytes'] > MAX_ENGINE_STDOUT,
        'stderrBytes': result['errBytes'], 'stderrDigest': sha(result['err']), 'excluded': excluded,
        'wallMs': int((time.monotonic() - started) * 1000), 'engineOutput': sha(engine), 'failure': failure,
    }
    record_bytes = json.dumps(record, separators=(',', ':'), sort_keys=True).encode('utf-8')
    artifacts = []
    for data, media in ((engine, 'application/vnd.semgrep.result+json'), (record_bytes, 'application/vnd.sentinel.pattern-run+json')):
        digest = sha(data)
        if any(a['id'] == digest for a in artifacts):
            continue
        fd = os.open('/output/' + digest[len('sha256:'):], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'wb') as f:
            f.write(data)
        artifacts.append({'id': digest, 'mediaType': media, 'bytes': len(data)})
    send(bound('result', inputFingerprint=start['inputFingerprint'], granularity='per-file', artifacts=artifacts, observations=[],
               coveredChecks=[], scannedSet=[], skipped=[], actualReadSet=[], unresolvedFrontiers=[], diagnostics=[]))
    finish(0)

main()
`;
