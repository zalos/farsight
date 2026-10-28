// One deterministic foundation-preview run (capture, parse, inventory, canonical plan, the coordinator, the real preview
// worker), then a dump of every object the store retained and every row of every ledger table. Randomness is keyed by
// the names of the functions that ask for it, and the wall and monotonic clocks are held still, so one build gives one
// dump; two builds give one dump only if every digest, id and record they compute is the same. Two runtime
// measurements are blanked in the dump: a worker's process id and the CPU an attempt was measured to use.
// Usage: node deterministic-run.mjs <package folder> <work folder> <dump.json>. build-identity.test.ts runs it.
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { performance } from 'node:perf_hooks';
import { mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';

const counters = new Map();
const draw = () => {
  // Function names only: file paths and line numbers differ between builds and must not change a value.
  const key = (new Error().stack ?? '')
    .split('\n')
    .slice(3, 9)
    .map((l) => /at (?:async )?([^\s(]+) \(/.exec(l)?.[1] ?? '?')
    .join('<');
  const n = (counters.get(key) ?? 0) + 1;
  counters.set(key, n);
  return crypto.createHash('sha256').update(`${key}#${n}`).digest();
};
crypto.randomBytes = (size, callback) => {
  const out = Buffer.alloc(size);
  for (let at = 0; at < size; at += 32) draw().copy(out, at);
  if (callback) return void callback(null, out);
  return out;
};
crypto.randomUUID = () => {
  const h = draw().toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
syncBuiltinESMExports();
let lcg = 0;
Math.random = () => ((lcg = (lcg * 9301 + 49297) % 233280), lcg / 233280);
const FIXED = Date.UTC(2026, 9, 27, 12, 0, 0);
globalThis.Date = class extends Date {
  constructor(...args) {
    if (args.length) super(...args);
    else super(FIXED);
  }
  static now() {
    return FIXED;
  }
};
performance.now = () => 1000;
// With no wall time passing, an operation's CPU check would refuse whatever CPU it measured: report none.
process.cpuUsage = () => ({ user: 0, system: 0 });

const [pkg, work, out] = process.argv.slice(2);
const dist = join(pkg, 'dist');
rmSync(work, { recursive: true, force: true });
mkdirSync(join(work, 'ws/src'), { recursive: true });
const base = realpathSync.native(work);
const workspace = join(base, 'ws');
writeFileSync(
  join(workspace, 'src/users.ts'),
  'export const find = (id: string) => db.query("SELECT * FROM users WHERE id = " + id);\n',
);
writeFileSync(join(workspace, 'src/Orders.java'), 'class Orders { String q = "SELECT * FROM orders WHERE id = ?"; }\n');
writeFileSync(join(workspace, 'src/latin1.ts'), Buffer.from([0x63, 0x6f, 0x6e, 0x73, 0x74, 0x20, 0xe9, 0x3b, 0x0a]));

const { openStore } = await import(join(dist, 'store/index.js'));
const local = await import(join(dist, 'service/local.js'));
const { executeRun, planWorkspaceCanonical } = await import(join(dist, 'service/canonical.js'));
const { builtinPackDir } = await import(join(dist, 'service/package-paths.js'));
const { initWorkspace } = await import(join(dist, 'cli/init.js'));
const { openScratchLease, releaseScratchLease } = await import(join(dist, 'service/scratch-lease.js'));
const ws = local.workspaceOf(workspace, { ...process.env, XDG_STATE_HOME: join(base, 'state') });
initWorkspace({ workspace });
local.adoptWorkspaceSettings(ws, { confirm: true, now: new Date() });
local.promoteRulePack(ws, {
  packDir: realpathSync.native(builtinPackDir('foundation-preview')),
  confirm: true,
  now: new Date(),
});
const adopted = local.adoptedPolicy(ws);
const store = await openStore(ws.storePath);
const lease = openScratchLease(store);
const planned = await planWorkspaceCanonical(store, {
  workspace,
  trustDir: ws.trustDir,
  policy: adopted.policy,
  scratchRoot: lease.path,
  now: new Date(),
});
const summary = await executeRun(store, planned.disclosure.runId, { scratchRoot: lease.path });
releaseScratchLease(store, lease);
store.close();

const files = (d) =>
  readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(d, e.name)) : [join(d, e.name)],
  );
const objects = {};
for (const f of files(join(ws.storePath, 'objects')).sort()) {
  const m = /([0-9a-f]{64})\.(raw|gzip)$/.exec(f);
  if (!m) continue;
  const raw = m[2] === 'gzip' ? gunzipSync(readFileSync(f)) : readFileSync(f);
  try {
    objects[m[1]] = JSON.parse(raw.toString('utf8'));
  } catch {
    objects[m[1]] = { bytes: raw.length };
  }
}
const ledgerFile = files(ws.storePath).find((f) => /ledger/.test(f.split('/').pop()) && !/-(wal|shm|journal)$/.test(f));
const db = new DatabaseSync(ledgerFile, { readOnly: true });
const ledger = {};
for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all())
  ledger[name] = db
    .prepare(`SELECT * FROM "${name}" ORDER BY rowid`)
    .all()
    .map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([k, v]) => [k, v instanceof Uint8Array ? Buffer.from(v).toString('base64') : v]),
      ),
    );
db.close();
const blank = (json) => {
  if (typeof json !== 'string') return json;
  const v = JSON.parse(json);
  if (v?.worker?.pid !== undefined) v.worker.pid = '<pid>';
  if (v?.cpuMs !== undefined) v.cpuMs = '<cpu>';
  return JSON.stringify(v);
};
for (const row of ledger.attempts ?? [])
  for (const k of ['envelope', 'final_envelope', 'error_detail']) row[k] = blank(row[k]);
const text = JSON.stringify(
  { runId: planned.disclosure.runId, state: summary.state, outcome: summary.outcome, objects, ledger },
  null,
  1,
);
writeFileSync(out, text);
process.stdout.write(
  `${JSON.stringify({ objects: Object.keys(objects).length, tables: Object.keys(ledger).length, sha256: crypto.createHash('sha256').update(text).digest('hex') })}\n`,
);
