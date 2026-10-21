// PR 01 prototype only: no production coordinator, schema migration or runtime-support policy.
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const workerPath = fileURLToPath(new URL('./storage-worker.mjs', import.meta.url));

const schema = `
PRAGMA journal_mode=WAL;
PRAGMA synchronous=FULL;
PRAGMA foreign_keys=ON;
CREATE TABLE runs (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES runs(id)) STRICT;
CREATE TABLE work_units (
 id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=1), run_id TEXT NOT NULL REFERENCES runs(id),
 active_attempt_id TEXT, PRIMARY KEY(id,revision),
 FOREIGN KEY(active_attempt_id,id,revision) REFERENCES attempts(id,work_id,work_revision) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TABLE attempts (
 id TEXT PRIMARY KEY, work_id TEXT NOT NULL, work_revision INTEGER NOT NULL, ordinal INTEGER NOT NULL CHECK(ordinal>=1),
 UNIQUE(work_id,work_revision,ordinal), UNIQUE(id,work_id,work_revision),
 FOREIGN KEY(work_id,work_revision) REFERENCES work_units(id,revision)
) STRICT;
CREATE TABLE publications (
 work_id TEXT NOT NULL, work_revision INTEGER NOT NULL, attempt_id TEXT NOT NULL UNIQUE, result_digest TEXT NOT NULL,
 PRIMARY KEY(work_id,work_revision), FOREIGN KEY(work_id,work_revision) REFERENCES work_units(id,revision),
 FOREIGN KEY(attempt_id,work_id,work_revision) REFERENCES attempts(id,work_id,work_revision)
) STRICT;`;

function spawnOwner(children, timeoutMs) {
  const child = fork(workerPath, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [] });
  const state = { child, messages: [], waiters: [], exited: false };
  children.push(state);
  state.exit = new Promise(resolve => child.once('exit', (code, signal) => {
    state.exited = true;
    state.exitInfo = { code, signal };
    for (const waiter of state.waiters.splice(0)) waiter.reject(new Error('CHILD_EXIT_BEFORE_MESSAGE'));
    resolve(state.exitInfo);
  }));
  child.on('error', () => {
    for (const waiter of state.waiters.splice(0)) waiter.reject(new Error('CHILD_START_FAILURE'));
  });
  child.on('message', message => {
    const waiter = state.waiters.shift();
    if (waiter) waiter.resolve(message); else state.messages.push(message);
  });
  state.next = () => {
    if (state.messages.length) return Promise.resolve(state.messages.shift());
    if (state.exited) return Promise.reject(new Error('CHILD_ALREADY_EXITED'));
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); },
      };
      const timer = setTimeout(() => {
        state.waiters = state.waiters.filter(item => item !== waiter);
        reject(new Error('CHILD_MESSAGE_DEADLINE'));
      }, timeoutMs);
      state.waiters.push(waiter);
    });
  };
  return state;
}

async function exitWithin(state, timeoutMs) {
  let timer;
  try {
    return await Promise.race([state.exit, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('CHILD_EXIT_DEADLINE')), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

function rejectedTransaction(db, operation) {
  db.exec('BEGIN IMMEDIATE');
  try {
    operation();
    db.exec('COMMIT');
    return false;
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    // A syntax/runtime error must not masquerade as an expected constraint rejection.
    if ((error.errcode & 255) !== 19) throw error;
    if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('ROLLBACK_INTEGRITY_FAILURE');
    return true;
  }
}

/** Run only against caller-owned temporary directories; no application graph or production state. */
export async function runStorageProbe({ workDir, artifactDir, timeoutMs = 5_000 } = {}) {
  const result = { experiment: 'E4', status: 'measured', checks: [], metrics: { node: process.versions.node, sqlite: process.versions.sqlite ?? null, platform: process.platform, arch: process.arch }, limitations: [
    'Small local SQLite prototype; not the production coordinator or a supported-version policy.',
    'Simultaneous starts use SQLite busy_timeout=250ms; zero-wait lock upgrades can reject both contenders. One SIGKILL and cooperative release on this host; other hosts and twenty kills per publication boundary remain unrun.',
    'No container cleanup, power-loss durability, network filesystem, symlink/alias ownership or stale external-claim fencing validation.',
    'Ledger constraints and owner locking are separate probes; no complete artifact publication/fsync protocol is implemented.',
  ], artifacts: [] };
  const children = [];
  let scratch;
  let db;
  const started = performance.now();
  const check = (id, passed, evidence) => result.checks.push({ id, passed, evidence });
  try {
    if (Number(process.versions.node.split('.')[0]) < 24) {
      result.status = 'blocked'; check('node24-runtime', false, { node: process.versions.node, reason: 'Node 24 or later required' }); return result;
    }
    if (!workDir || !artifactDir || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error('INVALID_PROBE_OPTIONS');
    let DatabaseSync;
    try { ({ DatabaseSync } = await import('node:sqlite')); } catch {
      result.status = 'blocked';
      check('sqlite-available', false, { reason: 'node:sqlite unavailable' });
      return result;
    }
    await mkdir(workDir, { recursive: true, mode: 0o700 });
    await mkdir(artifactDir, { recursive: true, mode: 0o700 });
    scratch = await mkdtemp(join(workDir, 'storage-'));
    const ownerPath = join(scratch, 'owner.sqlite');
    db = new DatabaseSync(ownerPath);
    db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE owner_marker(marker TEXT); INSERT INTO owner_marker VALUES('committed')");
    const ownerMode = db.prepare('PRAGMA journal_mode').get().journal_mode;
    db.close(); db = undefined;
    const contenders = [spawnOwner(children, timeoutMs), spawnOwner(children, timeoutMs)];
    const ready = await Promise.all(contenders.map(state => state.next()));
    if (ready.some(message => message.type !== 'ready')) throw new Error('CHILD_NOT_READY');
    contenders.forEach(state => state.child.send({ type: 'open', path: ownerPath }));
    const opened = await Promise.all(contenders.map(state => state.next()));
    if (opened.some(message => message.type !== 'opened')) throw new Error('CHILD_OPEN_FAILED');
    contenders.forEach(state => state.child.send({ type: 'acquire' }));
    const outcomes = await Promise.all(contenders.map(state => state.next()));
    check('exclusive-contention', outcomes.filter(item => item.type === 'acquired').length === 1 && outcomes.filter(item => item.type === 'busy').length === 1,
      { contenders: 2, outcomes: outcomes.map(item => item.type), journalMode: ownerMode, busyTimeoutMs: 250, phases: outcomes.map(item => item.phase ?? 'held') });
    const winner = contenders[outcomes.findIndex(item => item.type === 'acquired')];
    if (!winner) throw new Error('NO_OWNER');
    const loser = contenders.find(state => state !== winner);
    await exitWithin(loser, timeoutMs);
    winner.child.kill('SIGKILL');
    const killed = await exitWithin(winner, timeoutMs);
    const successor = spawnOwner(children, timeoutMs);
    await successor.next();
    successor.child.send({ type: 'open', path: ownerPath }); await successor.next();
    successor.child.send({ type: 'acquire' });
    const takeover = await successor.next();
    check('sigkill-takeover', killed.signal === 'SIGKILL' && takeover.type === 'acquired', { signal: killed.signal, takeover: takeover.type });
    const blocked = spawnOwner(children, timeoutMs);
    await blocked.next(); blocked.child.send({ type: 'open', path: ownerPath });
    const blockedOpen = await blocked.next();
    if (blockedOpen.type === 'opened') blocked.child.send({ type: 'acquire' });
    const blockedOutcome = blockedOpen.type === 'opened' ? await blocked.next() : blockedOpen;
    check('successor-excludes-contender', blockedOutcome.type === 'busy', { outcome: blockedOutcome.type });
    await exitWithin(blocked, timeoutMs);
    successor.child.send({ type: 'release' });
    const released = await successor.next();
    await exitWithin(successor, timeoutMs);
    const afterRelease = spawnOwner(children, timeoutMs);
    await afterRelease.next(); afterRelease.child.send({ type: 'open', path: ownerPath }); await afterRelease.next();
    afterRelease.child.send({ type: 'acquire' });
    const acquiredAfterRelease = await afterRelease.next();
    afterRelease.child.send({ type: 'release' }); await afterRelease.next(); await exitWithin(afterRelease, timeoutMs);
    check('release-takeover', released.type === 'released' && acquiredAfterRelease.type === 'acquired', { release: released.type, takeover: acquiredAfterRelease.type });
    db = new DatabaseSync(ownerPath);
    const marker = db.prepare('SELECT marker FROM owner_marker').get().marker;
    check('owner-interrupted-rollback', marker === 'committed', { committedMarker: marker, integrity: db.prepare('PRAGMA integrity_check').get().integrity_check });
    db.close(); db = undefined;

    const ledgerPath = join(scratch, 'ledger.sqlite');
    db = new DatabaseSync(ledgerPath); db.exec(schema);
    const ledgerMode = db.prepare('PRAGMA journal_mode').get().journal_mode;
    const synchronous = db.prepare('PRAGMA synchronous').get().synchronous;
    db.exec(`BEGIN IMMEDIATE;
      INSERT INTO runs VALUES('parent',NULL),('child','parent');
      INSERT INTO work_units VALUES('logical-work',1,'parent',NULL),('logical-work',2,'child',NULL);
      INSERT INTO attempts VALUES('a1','logical-work',1,1),('a1-retry','logical-work',1,2),('a2','logical-work',2,1);
      UPDATE work_units SET active_attempt_id='a1' WHERE revision=1;
      UPDATE work_units SET active_attempt_id='a2' WHERE revision=2;
      COMMIT;`);
    // Reject the wrong-revision publication before a uniqueness constraint can hide the FK check.
    const crossPublication = rejectedTransaction(db, () => db.prepare('INSERT INTO publications VALUES(?,?,?,?)').run('logical-work', 1, 'a2', hash('wrong')));
    check('cross-revision-publication-rejected', crossPublication, { publicationsAfterRollback: db.prepare('SELECT count(*) AS n FROM publications').get().n });
    const crossActive = rejectedTransaction(db, () => db.prepare('UPDATE work_units SET active_attempt_id=? WHERE revision=1').run('a2'));
    check('cross-revision-active-attempt-rejected', crossActive, { activeAttempt: db.prepare('SELECT active_attempt_id AS id FROM work_units WHERE revision=1').get().id });
    const orphan = rejectedTransaction(db, () => db.prepare('INSERT INTO attempts VALUES(?,?,?,?)').run('orphan', 'logical-work', 3, 1));
    check('missing-work-revision-rejected', orphan, { missingRevision: 3 });
    const publication = db.prepare('INSERT INTO publications VALUES(?,?,?,?)');
    db.exec('BEGIN IMMEDIATE');
    publication.run('logical-work', 1, 'a1', hash('parent-result'));
    publication.run('logical-work', 2, 'a2', hash('child-result'));
    db.exec('COMMIT');
    const duplicate = rejectedTransaction(db, () => publication.run('logical-work', 1, 'a1-retry', hash('duplicate')));
    check('duplicate-publication-rejected', duplicate, { rejectedAttempt: 'a1-retry', integrityAfterRollback: 'ok' });
    const before = db.prepare('SELECT * FROM publications ORDER BY work_revision').all();
    db.exec('BEGIN IMMEDIATE');
    db.prepare('DELETE FROM publications WHERE work_revision=2').run();
    db.exec('ROLLBACK');
    check('ledger-explicit-rollback', db.prepare('SELECT count(*) AS n FROM publications').get().n === 2, { publications: 2 });
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close(); db = new DatabaseSync(ledgerPath);
    db.exec('PRAGMA foreign_keys=ON');
    const after = db.prepare('SELECT * FROM publications ORDER BY work_revision').all();
    const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
    const foreignKeyViolations = db.prepare('PRAGMA foreign_key_check').all().length;
    check('independent-revisions-reopen', after.length === 2 && JSON.stringify(before) === JSON.stringify(after), { publications: after, journalMode: ledgerMode, synchronous });
    check('ledger-reopen-integrity', integrity === 'ok' && foreignKeyViolations === 0, { integrity, foreignKeyViolations });
    db.close(); db = undefined;
    result.metrics = { ...result.metrics, node: process.versions.node, sqlite: process.versions.sqlite, platform: process.platform, arch: process.arch,
      childrenStarted: children.length, childrenExited: children.filter(state => state.exited).length,
      busyTimeoutMs: 250, sigkills: 1, constraintRollbacks: 4, publications: after.length, elapsedMs: performance.now() - started };
    for (const [source, name] of [[ownerPath, 'E4-owner.sqlite'], [ledgerPath, 'E4-ledger.sqlite']]) {
      await copyFile(source, join(artifactDir, name));
      await chmod(join(artifactDir, name), 0o600);
      const bytes = await readFile(join(artifactDir, name));
      result.artifacts.push({ path: name, sha256: hash(bytes), bytes: bytes.length });
    }
  } catch (error) {
    result.status = 'failed';
    check('probe-completed', false, { reason: /^[A-Z_]+$/.test(error.message) ? error.message : 'STORAGE_PROBE_FAILURE', code: error.code ?? null });
  } finally {
    try { db?.close(); } catch { /* Still clean up only this probe's child processes. */ }
    const cleanupChildren = children.filter(state => !state.exited);
    for (const state of cleanupChildren) state.child.kill('SIGKILL');
    await Promise.all(children.map(state => exitWithin(state, Math.min(timeoutMs || 5_000, 5_000)).catch(() => {
      result.status = 'failed'; check('owned-child-cleanup', false, { reason: 'CHILD_EXIT_DEADLINE' });
    })));
    if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => {
      result.status = 'failed'; check('scratch-cleanup', false, { reason: 'SCRATCH_CLEANUP_FAILURE' });
    });
    Object.assign(result.metrics, { childrenStarted: children.length, childrenExited: children.filter(state => state.exited).length,
      cleanupSigkills: cleanupChildren.length, elapsedMs: performance.now() - started });
  }
  return result;
}
