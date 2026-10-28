// One canonicalJson behind every structured digest (docs/proposals/sentinel-v2 K-1). Until this change the store had
// two: store/objects.ts (object ids, plan and work digests) and store/ledger-json.ts (ledger request and result
// digests, plan revisions). The kernel's is the object store's, moved; both store modules now answer through it.
// The two replaced implementations are kept below, copied verbatim from main at 5aad3a6b, so the proof that switching
// changes no byte runs on every change:
//   - every JSON file in the repository (contract fixtures, rule packs, schemas, examples, recorded evidence),
//   - every object a real run retains in a real store (capture, parse, inventory, plans, work, invocations,
//     coverage, findings),
// give the same canonical string, and so the same digest, from the kernel, both replaced implementations and both
// store modules. The edge inputs where the replaced implementations disagreed are pinned one by one at the end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import {
  canonicalJson,
  canonicalJsonBytes,
  digestOf,
  MAX_CANONICAL_DEPTH,
  sha256Hex,
  sha256Id,
  type CanonicalRefusal,
} from '../dist/kernel/digest.js';
import * as objects from '../dist/store/objects.js';
import * as ledgerJson from '../dist/store/ledger-json.js';
import { openStore, qualificationFor, SQLITE_RELEASE_POLICY } from '../dist/store/index.js';
import { adoptedPolicy, adoptWorkspaceSettings, promoteRulePack, workspaceOf } from '../dist/service/local.js';
import { executeRun, planWorkspaceCanonical } from '../dist/service/canonical.js';
import { builtinPackDir } from '../dist/service/package-paths.js';
import { initWorkspace } from '../dist/cli/init.js';
import { scratchUnder, removeScratch } from './lease-helpers.ts';
import { unlock } from './snapshot-helpers.ts';

// ---- store/ledger-json.ts at 5aad3a6b, verbatim ----

function ledgerCanonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON refuses a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(ledgerCanonicalJson).join(',')}]`;
  const plain =
    typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  if (plain) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(([k, v]) => {
        if (v === undefined) throw new TypeError('canonical JSON refuses an undefined member');
        return `${JSON.stringify(k)}:${ledgerCanonicalJson(v)}`;
      })
      .join(',')}}`;
  }
  throw new TypeError(`canonical JSON refuses a ${typeof value}`);
}

// ---- store/objects.ts at 5aad3a6b, verbatim; its fail() raised ObjectStoreError(code, message) ----

class Refused extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
const fail = (code: string, message: string): never => {
  throw new Refused(code, message);
};

function objectsCanonicalJson(value: unknown): string {
  const seen = new Set<object>();
  const walk = (v: unknown, depth: number): string => {
    if (depth > 256) fail('sentinel.object.notCanonical', 'structure is nested deeper than 256 levels');
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) fail('sentinel.object.notCanonical', 'non-finite number');
      return JSON.stringify(Object.is(v, -0) ? 0 : v);
    }
    if (typeof v !== 'object') return fail('sentinel.object.notCanonical', `${typeof v} has no JSON form`);
    if (seen.has(v)) fail('sentinel.object.notCanonical', 'cyclic structure');
    seen.add(v);
    let out: string;
    if (Array.isArray(v)) {
      out = `[${Array.from(v, (item) => walk(item, depth + 1)).join(',')}]`;
    } else {
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null)
        fail('sentinel.object.notCanonical', 'only plain objects have a canonical form');
      if (Object.getOwnPropertySymbols(v).length) fail('sentinel.object.notCanonical', 'symbol keys have no JSON form');
      const keys = Object.keys(v).sort();
      out = `{${keys.map((k) => `${JSON.stringify(k)}:${walk((v as Record<string, unknown>)[k], depth + 1)}`).join(',')}}`;
    }
    seen.delete(v);
    return out;
  };
  return walk(value, 0);
}

// ---- the proof ----

const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');

/** Asserts every implementation writes `value` as the same string, and every digest of it is the same; returns it. */
function sameEverywhere(value: unknown, where: string): string {
  const k = canonicalJson(value);
  assert.equal(objectsCanonicalJson(value), k, `${where}: the replaced object-store implementation differs`);
  assert.equal(ledgerCanonicalJson(value), k, `${where}: the replaced ledger implementation differs`);
  assert.equal(objects.canonicalJson(value), k, `${where}: store/objects.js differs`);
  assert.equal(ledgerJson.canonicalJson(value), k, `${where}: store/ledger-json.js differs`);
  const id = `sha256:${sha(Buffer.from(k, 'utf8'))}`;
  assert.equal(digestOf(value), id, `${where}: the kernel digest differs`);
  assert.equal(ledgerJson.digestOf(value), id, `${where}: the ledger digest differs`);
  assert.equal(
    `sha256:${sha(objects.canonicalJsonBytes(value))}`,
    id,
    `${where}: the object-store canonical bytes differ`,
  );
  assert.deepEqual(canonicalJsonBytes(value), objects.canonicalJsonBytes(value), `${where}: the bytes differ`);
  return k;
}

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const SKIP = new Set(['node_modules', 'dist', 'build', '.git', 'test-results', '.playwright-report', 'coverage']);

function jsonFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (SKIP.has(e.name)) return [];
    const p = join(dir, e.name);
    if (e.isDirectory()) return jsonFiles(p);
    return e.isFile() && e.name.endsWith('.json') ? [p] : [];
  });
}

test('every JSON file in the repository has one canonical form: the kernel, both replaced implementations and both store modules agree byte for byte', (t) => {
  const files = ['packages', 'examples', 'docs', 'schemas', 'e2e'].flatMap((d) => jsonFiles(join(repoRoot, d)));
  let checked = 0,
    notJson = 0;
  for (const file of files) {
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      notJson++; // a JSONC file (tsconfig with comments) or a deliberately malformed fixture
      continue;
    }
    sameEverywhere(value, file.slice(repoRoot.length));
    checked++;
  }
  t.diagnostic(`${checked} JSON files agree byte for byte; ${notJson} files named .json are not JSON`);
  // The contract fixtures, every rule pack and every generated schema are among them.
  assert.ok(checked >= 300, `only ${checked} JSON files were found`);
  for (const where of [
    'packages/sentinel/test/contracts/valid/',
    'packages/sentinel/rules/',
    'packages/sentinel/schemas/',
  ])
    assert.ok(
      files.some((f) => f.startsWith(join(repoRoot, where))),
      `no JSON file under ${where}`,
    );
});

const QUALIFIED =
  qualificationFor(SQLITE_RELEASE_POLICY, `${process.platform}-${process.arch}`, process.versions.sqlite ?? '') !==
  undefined;
const needsStore = QUALIFIED || process.env.CI ? {} : { skip: 'not a qualified store host' };

function objectFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return objectFiles(p);
    return e.isFile() ? [p] : [];
  });
}

test(
  'every object a real run retains keeps its bytes and its id: re-canonicalizing it with any implementation gives the stored bytes back',
  needsStore,
  async (t) => {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'sentinel-kernel-')));
    t.after(() => {
      unlock(dir);
      rmSync(dir, { recursive: true, force: true });
    });
    const path = join(dir, 'ws');
    mkdirSync(join(path, 'src'), { recursive: true });
    writeFileSync(
      join(path, 'src/users.ts'),
      'export const find = (id: string) => db.query("SELECT * FROM users WHERE id = " + id);\n',
    );
    writeFileSync(join(path, 'src/Orders.java'), 'class Orders { String q = "SELECT * FROM orders WHERE id = ?"; }\n');
    writeFileSync(join(path, 'src/latin1.ts'), Buffer.from([0x63, 0x6f, 0x6e, 0x73, 0x74, 0x20, 0xe9, 0x3b, 0x0a]));
    const ws = workspaceOf(path, { ...process.env, XDG_STATE_HOME: join(dir, 'state') });
    initWorkspace({ workspace: path });
    adoptWorkspaceSettings(ws, { confirm: true, now: new Date() });
    promoteRulePack(ws, {
      packDir: realpathSync.native(builtinPackDir('foundation-preview')!),
      confirm: true,
      now: new Date(),
    });
    const adopted = adoptedPolicy(ws);
    assert.ok('policy' in adopted);
    const store = await openStore(ws.storePath);
    const work = scratchUnder(store);
    try {
      const planned = await planWorkspaceCanonical(store, {
        workspace: path,
        trustDir: ws.trustDir,
        policy: adopted.policy,
        scratchRoot: work,
        now: new Date(),
      });
      assert.equal(planned.outcome, 'prepared');
      const summary = await executeRun(store, planned.disclosure.runId, { scratchRoot: work });
      assert.equal(summary.state, 'completed', JSON.stringify(summary.failures));
    } finally {
      removeScratch(work);
      store.close();
    }

    let total = 0,
      canonical = 0,
      json = 0;
    const kinds = new Map<string, number>();
    let sealed = 0;
    for (const file of objectFiles(join(ws.storePath, 'objects'))) {
      const name = /([0-9a-f]{64})\.(raw|gzip)$/.exec(file);
      if (!name) continue;
      const stored = readFileSync(file);
      const raw = name[2] === 'gzip' ? gunzipSync(stored) : stored;
      assert.equal(sha(raw), name[1], `${file}: the object's bytes match its id`);
      total++;
      let value: unknown;
      try {
        value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
      } catch {
        continue; // captured source bytes, a gzip member, a worker's raw output
      }
      json++;
      const k = sameEverywhere(value, `retained ${name[1]}`);
      if (k !== raw.toString('utf8')) continue;
      canonical++;
      // A record sealed by its own digest (a plan revision): the seal is the same under every implementation.
      const { digest, ...rest } = value as { digest?: unknown };
      if (typeof digest === 'string' && digest === digestOf(rest)) {
        assert.equal(`sha256:${sha(ledgerCanonicalJson(rest))}`, digest, `retained ${name[1]}: its seal`);
        assert.equal(`sha256:${sha(objectsCanonicalJson(rest))}`, digest, `retained ${name[1]}: its seal`);
        sealed++;
      }
      const schema = (value as { schema?: unknown })?.schema;
      const kind = typeof schema === 'string' ? schema : `a JSON ${Array.isArray(value) ? 'array' : typeof value}`;
      kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
    }
    t.diagnostic(`${sealed} of them are sealed by their own digest; every seal is the same under each implementation`);
    t.diagnostic(
      `${total} retained objects; ${json} are JSON, all agree; ${canonical} are canonical JSON, byte for byte`,
    );
    t.diagnostic(
      [...kinds]
        .sort()
        .map(([kind, n]) => `${n} ${kind}`)
        .join(' · '),
    );
    assert.ok(canonical >= 10, `only ${canonical} retained canonical objects were found`);
    assert.ok(sealed >= 1, 'a run retains at least its plan revisions, sealed by their own digest');
  },
);

// ---- the edge inputs, one by one ----

const sparse = [1, , 3]; // eslint-disable-line no-sparse-arrays -- the hole is the case
const nested = (levels: number): unknown => {
  let v: unknown = 'leaf';
  for (let i = 0; i < levels; i++) v = [v];
  return v;
};
const cyclic: Record<string, unknown> = { a: 1 };
cyclic.self = cyclic;
const shared = { x: [1, 2] };

test('values every implementation accepts are written identically, including the spellings JSON makes subtle', () => {
  const cases: [string, unknown][] = [
    ['negative zero', -0],
    ['negative zero inside', { a: [-0, 0, -0.0] }],
    ['large and small numbers', [1e21, 5e-324, 1.7976931348623157e308, 0.1 + 0.2, -1e-7]],
    ['keys that sort as strings, not numbers', { '10': 1, '9': 2, a: 3, A: 4, '': 5 }],
    ['keys ordered by UTF-16 code unit, not code point', { '～': 1, '\u{1F600}': 2, é: 3, z: 4 }],
    ['strings JSON escapes', [' ', '\u0000', '"\\', '\uD800', 'line\nbreak']],
    ['a null-prototype object', Object.assign(Object.create(null), { b: 1, a: 2 })],
    ['a __proto__ own key', JSON.parse('{"__proto__":{"x":1},"y":2}')],
    ['a shared sub-object that is not a cycle', { first: shared, second: shared, list: [shared, shared] }],
    ['the deepest accepted nesting', nested(MAX_CANONICAL_DEPTH)],
    ['empty containers', { a: {}, b: [], c: [[]], d: '' }],
    ['scalars', [null, true, false, 0, 'x']],
  ];
  for (const [name, value] of cases) sameEverywhere(value, name);
});

test('values the replaced implementations both refused, the kernel refuses for the same reason the object store gave', () => {
  const cases: [string, unknown, string][] = [
    ['undefined', undefined, 'undefined has no JSON form'],
    ['an undefined member', { a: undefined }, 'undefined has no JSON form'],
    ['an undefined item', [undefined], 'undefined has no JSON form'],
    ['a function', { f() {} }, 'function has no JSON form'],
    ['a symbol', Symbol('s'), 'symbol has no JSON form'],
    ['a bigint', 1n, 'bigint has no JSON form'],
    ['NaN', NaN, 'non-finite number'],
    ['Infinity', [Infinity], 'non-finite number'],
    ['a Date', new Date(0), 'only plain objects have a canonical form'],
    ['a Map', new Map(), 'only plain objects have a canonical form'],
    ['a class instance', new (class Point {})(), 'only plain objects have a canonical form'],
    ['bytes', new Uint8Array([1]), 'only plain objects have a canonical form'],
    ['a boxed string', new String('s'), 'only plain objects have a canonical form'],
  ];
  for (const [name, value, message] of cases) {
    let refusal: CanonicalRefusal | undefined;
    assert.throws(
      () =>
        canonicalJson(value, (r) => {
          refusal = r;
          throw new Error('refused');
        }),
      /refused/,
      name,
    );
    assert.equal(refusal?.message, message, name);
    assert.throws(() => objectsCanonicalJson(value), { code: 'sentinel.object.notCanonical', message }, name);
    assert.throws(() => ledgerCanonicalJson(value), TypeError, name);
    // The store modules keep their own errors: the object store's coded error, the ledger's TypeError.
    assert.throws(
      () => objects.canonicalJson(value),
      { name: 'ObjectStoreError', code: 'sentinel.object.notCanonical', message },
      name,
    );
    assert.throws(() => ledgerJson.canonicalJson(value), TypeError, name);
    assert.throws(() => canonicalJson(value), TypeError, name);
  }
});

test('the four inputs on which the replaced implementations disagreed are refused, as the object store refused them', () => {
  // The ledger's copy wrote a sparse array as `[1,,3]`, which is not JSON; ignored a symbol key; accepted any depth;
  // and overflowed the stack on a cycle. The object store refused all four. No value that reaches a digest is any of
  // them (a parsed document has no hole, symbol or cycle, and imports are capped at 64 levels), so no digest moves.
  assert.equal(ledgerCanonicalJson(sparse), '[1,,3]');
  assert.throws(() => JSON.parse(ledgerCanonicalJson(sparse)), SyntaxError);
  assert.equal(ledgerCanonicalJson({ a: 1, [Symbol('s')]: 2 }), '{"a":1}');
  assert.doesNotThrow(() => ledgerCanonicalJson(nested(MAX_CANONICAL_DEPTH + 1)));
  assert.throws(() => ledgerCanonicalJson(cyclic), RangeError);

  const cases: [string, unknown, CanonicalRefusal['reason'], string][] = [
    ['a sparse array', sparse, 'noJsonForm', 'undefined has no JSON form'],
    ['a symbol key', { a: 1, [Symbol('s')]: 2 }, 'symbolKey', 'symbol keys have no JSON form'],
    [
      'nesting one level too deep',
      nested(MAX_CANONICAL_DEPTH + 1),
      'tooDeep',
      'structure is nested deeper than 256 levels',
    ],
    ['a cycle', cyclic, 'cyclic', 'cyclic structure'],
  ];
  for (const [name, value, reason, message] of cases) {
    let refusal: CanonicalRefusal | undefined;
    assert.throws(() =>
      canonicalJson(value, (r) => {
        refusal = r;
        throw new Error('refused');
      }),
    );
    assert.deepEqual(refusal, { reason, message }, name);
    assert.throws(() => objectsCanonicalJson(value), { code: 'sentinel.object.notCanonical', message }, name);
    assert.throws(() => objects.canonicalJson(value), { code: 'sentinel.object.notCanonical', message }, name);
    assert.throws(() => ledgerJson.canonicalJson(value), TypeError, name);
    assert.throws(() => ledgerJson.digestOf(value), TypeError, name);
  }
});

test('a refuse callback that returns still refuses: canonicalJson never returns a string for a refused value', () => {
  assert.throws(() => canonicalJson(NaN, (() => undefined) as never), TypeError);
});

test('sha256Hex, sha256Id and digestOf are SHA-256 over the bytes they name', () => {
  const bytes = Buffer.from('héllo', 'utf8');
  assert.equal(sha256Hex(bytes), sha(bytes));
  assert.equal(sha256Hex('héllo'), sha(bytes), 'a string is hashed as its UTF-8 bytes');
  assert.equal(sha256Id(new Uint8Array(bytes)), `sha256:${sha(bytes)}`);
  assert.equal(digestOf({ b: 1, a: [true] }), `sha256:${sha('{"a":[true],"b":1}')}`);
  assert.equal(sha256Id(''), 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});
