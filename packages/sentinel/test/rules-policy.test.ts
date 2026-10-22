import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateEnvelope, schemaOf, readPackDirectory, validatePack, emptyLock, lockDigest, promote, promotionIntent,
  verifyPinnedLock, candidateDigest, isValidatedPack, resolveLockedRules, parseSettings, parseRepoConfig, effectivePolicy, DEFAULT_SETTINGS, ReceiptBook,
  intentDigest, isConsumedReceipt, adoptSettings, adoptionIntent, loadPolicyInputs, trustDirectory, workspaceIdentity,
  admit, compareDecimal, isEffectivePolicy, PolicyError, SETTINGS_PATH, REPO_CONFIG_PATH, MAX_RECEIPT_TTL_MS,
  RULE_LANGUAGES, RULE_SCOPE_KINDS, RULE_CAPABILITIES, RULE_MEANINGS, SEVERITIES, RULE_EVIDENCE, FRAMEWORK_IDS, RULE_ORIGINS,
  SENTINEL_ACTIONS, OWNER_ACTIONS, ACTION_EFFECTS, SETTINGS_TRUST, ADMISSION_OUTCOMES, CREDENTIAL_BASES,
  CONTROL_PROPERTIES, CONTROL_VERDICTS,
} from '../dist/index.js';
import type { ActionIntent, EffectivePolicy, PolicyInputs, RuleLockEnvelope, SettingsEnvelope } from '../dist/index.js';
// The owner CLI's issuing module: reachable from this package's own tests, not through its exports.
import { issueReceipt } from '../dist/policy/owner-receipts.js';
import { readPackDirectoryWith } from '../dist/rules/pack.js';
import { execFileSync } from 'node:child_process';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const VALID = here('./contracts/valid/');
const load = (name: string) => JSON.parse(readFileSync(`${VALID}${name}.json`, 'utf8'));
const NOW = new Date('2026-10-22T10:00:00.000Z');
const later = (ms: number) => new Date(NOW.getTime() + ms);
const D = (c: string) => `sha256:${c.repeat(64)}`;

function scratch(t: { after(fn: () => void): void }, prefix = 'sentinel-policy-'): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => { try { chmodSync(dir, 0o700); } catch { /* gone */ } rmSync(dir, { recursive: true, force: true }); });
  return dir;
}
function code(fn: () => unknown): string {
  try { fn(); } catch (e) { assert.ok(e instanceof PolicyError, String(e)); return (e as PolicyError).code; }
  return assert.fail('expected a PolicyError');
}
const invariant = (kind: Parameters<typeof validateEnvelope>[0], value: unknown) => {
  const r = validateEnvelope(kind, value);
  assert.equal(r.ok, false, `${kind} should be refused`);
  return (r as { errors: { code: string; message: string }[] }).errors;
};

// ---- contracts --------------------------------------------------------------------------------------------------

const schemaEnum = (kind: Parameters<typeof schemaOf>[0], def: string, ...path: string[]): string[] => {
  let node: any = (schemaOf(kind) as any).definitions[def];
  for (const p of path) node = node.properties?.[p] ?? node.items ?? node;
  node = node.items ?? node;
  if (node.$ref) node = (schemaOf(kind) as any).definitions[node.$ref.split('/').pop()];
  return node.enum ?? [node.const];
};

test('policy enum sets are pinned to an explicit list and to the generated schema', () => {
  const pins: [string, readonly string[], string[], string[] | null][] = [
    ['languages', RULE_LANGUAGES, ['typescript', 'javascript', 'java'], schemaEnum('rulepack', 'RuleLanguage')],
    ['scope kinds', RULE_SCOPE_KINDS, ['source-file', 'surface', 'dependency-manifest', 'ci-config', 'infrastructure-config', 'repository'], schemaEnum('rulepack', 'RuleScopeKind')],
    ['capabilities', RULE_CAPABILITIES, ['source-bytes', 'pattern-match', 'source-span', 'call-occurrence', 'resolved-receiver-type', 'framework-order', 'interprocedural-flow', 'runtime-observation', 'dependency-manifest', 'advisory-database'], schemaEnum('rulepack', 'RuleCapability')],
    ['meanings', RULE_MEANINGS, ['candidate', 'finding'], schemaEnum('rulepack', 'RuleMeaning')],
    ['severities', SEVERITIES, ['info', 'low', 'medium', 'high', 'critical'], schemaEnum('rulepack', 'Severity')],
    ['evidence', RULE_EVIDENCE, ['source-span', 'matched-pattern', 'control-fact', 'dependency-version', 'advisory-id'], schemaEnum('rulepack', 'RuleEvidence')],
    ['frameworks', FRAMEWORK_IDS, ['next', 'express', 'nest', 'spring'], schemaEnum('controls', 'FrameworkId')],
    ['origins', RULE_ORIGINS, ['sentinel-original', 'third-party'], schemaEnum('rulepack', 'RuleOrigin')],
    ['actions', SENTINEL_ACTIONS, ['run.start', 'capture.source', 'disposition.propose', 'disposition.approve', 'rule.promote', 'tool.acquire', 'paid.admit', 'disclosure.send', 'settings.adopt'], schemaEnum('settings', 'SentinelAction')],
    ['owner actions', OWNER_ACTIONS, ['disposition.approve', 'rule.promote', 'tool.acquire', 'settings.adopt'], null],
    ['effects', ACTION_EFFECTS, ['local-artifacts', 'source-disclosure', 'paid-inference', 'network', 'tool-execution'], schemaEnum('settings', 'ActionEffect')],
    ['trust', SETTINGS_TRUST, ['adopted', 'not-adopted', 'changed', 'missing', 'invalid'], schemaEnum('policy', 'SettingsTrust')],
    ['outcomes', ADMISSION_OUTCOMES, ['admitted', 'denied', 'awaiting-confirmation'], schemaEnum('admission', 'AdmissionOutcome')],
    ['credential bases', CREDENTIAL_BASES, ['local-only', 'keychain-scope', 'unknown', 'not-asked'], schemaEnum('admission', 'CredentialVerdict', 'basis')],
    ['control properties', CONTROL_PROPERTIES, ['authentication', 'authorization', 'csrf', 'input-validation', 'rate-limit', 'security-headers', 'cors'], schemaEnum('controls', 'ControlProperty')],
    ['control verdicts', CONTROL_VERDICTS, ['applies', 'does-not-apply', 'unknown'], schemaEnum('controls', 'ControlVerdict')],
  ];
  for (const [name, exported, literal, schema] of pins) {
    assert.deepEqual([...exported], literal, `${name}: exported constant`);
    if (schema) assert.deepEqual([...schema].sort(), [...literal].sort(), `${name}: schema`);
  }
  assert.ok(OWNER_ACTIONS.every(a => (SENTINEL_ACTIONS as readonly string[]).includes(a)));
});

test('policy invariants a schema cannot express are refused', () => {
  const settings = load('settings');
  const agentOwner = structuredClone(settings);
  agentOwner.grants = [{ actions: ['rule.promote'], principals: ['agent'] }];
  assert.match(invariant('settings', agentOwner)[0]!.message, /owner action cannot be granted to an agent/);
  const plain = parseExample();
  plain.providers[1].endpoint = 'http://models.example.com';
  assert.match(invariant('settings', plain)[0]!.message, /loopback/);

  const pack = load('rulepack');
  pack.rules[0].fixtures.negative = [...pack.rules[0].fixtures.positive];
  assert.match(invariant('rulepack', pack)[0]!.message, /both positive and negative/);
  const third = load('rulepack-third-party');
  delete third.rights.upstream;
  assert.match(invariant('rulepack', third)[0]!.message, /upstream/);

  const lock = load('rulelock');
  lock.previous = null;
  assert.match(invariant('rulelock', lock)[0]!.message, /predecessor/);

  const receipt = load('receipt');
  receipt.expiresAt = '2026-10-22T11:00:00.000000001Z';
  assert.match(invariant('receipt', receipt)[0]!.message, /one hour/);

  const awaiting = load('admission-awaiting');
  awaiting.verdicts.credential = { allowed: false, asked: true, reasonCode: 'sentinel.admission.credentialUnknown', detail: 'x', basis: 'unknown' };
  assert.match(invariant('admission', awaiting)[0]!.message, /all three verdicts/);
  const denied = load('admission-denied');
  denied.verdicts.capability.asked = true;
  assert.match(invariant('admission', denied)[0]!.message, /nothing is asked after the policy denies/);
  const owner = load('admission-admitted');
  owner.receipt = null;
  assert.match(invariant('admission', owner)[0]!.message, /only with a receipt/);

  const controls = load('controls');
  controls.facts[0].evidence = [];
  assert.match(invariant('controls', controls)[0]!.message, /names the evidence/);
  const unknown = load('controls');
  delete unknown.facts[1].reasonCode;
  assert.match(invariant('controls', unknown)[0]!.message, /says why/);
  const unresolved = load('controls-unresolved');
  unresolved.facts[0] = load('controls').facts[0];
  assert.match(invariant('controls', unresolved)[0]!.message, /unresolved framework version/);
  const foreign = load('controls');
  foreign.facts[0].evidence[0].snapshotId = 'snap-2';
  assert.match(invariant('controls', foreign)[0]!.message, /another snapshot/);
  // No property of the contract claims a surface is simply protected.
  assert.doesNotMatch(JSON.stringify(schemaOf('controls')), /"(secure|protected)"/);
});

// ---- rule packs and the lock ------------------------------------------------------------------------------------

function writePack(dir: string, overrides: { rulePath?: string } = {}) {
  const manifest = load('rulepack');
  if (overrides.rulePath) manifest.rules[0].implementation.rulePath = overrides.rulePath;
  mkdirSync(join(dir, 'detectors'), { recursive: true });
  mkdirSync(join(dir, 'fixtures/sql'), { recursive: true });
  writeFileSync(join(dir, 'sentinel-pack.json'), JSON.stringify(manifest));
  writeFileSync(join(dir, manifest.rules[0].implementation.rulePath), 'rules: []\n');
  writeFileSync(join(dir, 'fixtures/sql/concatenated.ts'), 'db.query("select " + id);\n');
  writeFileSync(join(dir, 'fixtures/sql/parameterized.ts'), 'db.query("select $1", [id]);\n');
}

test('a staged pack is read as data and every named file is in its digest', t => {
  const dir = scratch(t);
  writePack(dir);
  const pack = validatePack(readPackDirectory(dir));
  assert.equal(pack.manifest.packId, 'sentinel-core');
  assert.deepEqual(pack.files.map(f => f.path), ['detectors/dynamic-query.yml', 'fixtures/sql/concatenated.ts', 'fixtures/sql/parameterized.ts', 'sentinel-pack.json']);
  assert.ok(Object.isFrozen(pack) && Object.isFrozen(pack.rules));

  writeFileSync(join(dir, 'fixtures/sql/parameterized.ts'), 'db.query("select ?", [id]);\n');
  const changed = validatePack(readPackDirectory(dir));
  assert.notEqual(changed.packDigest, pack.packDigest, 'a fixture byte changes the pack');
  assert.notEqual(changed.rules[0]!.definitionDigest, pack.rules[0]!.definitionDigest, 'and the rule revision digest');

  rmSync(join(dir, 'fixtures/sql/parameterized.ts'));
  assert.equal(code(() => validatePack(readPackDirectory(dir))), 'sentinel.rules.fileMissing');
});

test('a pack cannot supply a script, a link or a path outside itself', t => {
  const script = scratch(t);
  writePack(script, { rulePath: 'detectors/dynamic-query.mjs' });
  assert.equal(code(() => validatePack(readPackDirectory(script))), 'sentinel.rules.executableRule');

  const linked = scratch(t);
  writePack(linked);
  symlinkSync('/etc/hosts', join(linked, 'fixtures/hosts'));
  assert.equal(code(() => readPackDirectory(linked)), 'sentinel.rules.packUnsafe');

  const alias = join(scratch(t), 'alias');
  const real = scratch(t);
  writePack(real);
  symlinkSync(real, alias);
  assert.equal(code(() => readPackDirectory(alias)), 'sentinel.rules.packUnsafe');

  const escaping = load('rulepack');
  escaping.rules[0].fixtures.positive = ['../outside.ts'];
  assert.equal(code(() => validatePack(new Map([['sentinel-pack.json', Buffer.from(JSON.stringify(escaping))]]))), 'sentinel.rules.manifestInvalid');
});

test('pack reading is bounded in entries, depth, path length, files and bytes, empty folders included', t => {
  const dir = scratch(t);
  writePack(dir);
  for (let i = 0; i < 6; i++) mkdirSync(join(dir, `empty-${i}`));
  assert.equal(code(() => readPackDirectory(dir, { entries: 8 })), 'sentinel.rules.packTooLarge', 'empty folders count');
  assert.equal(readPackDirectory(dir).size, 4);
  mkdirSync(join(dir, 'a/b/c'), { recursive: true });
  assert.equal(code(() => readPackDirectory(dir, { depth: 2 })), 'sentinel.rules.packTooLarge');
  assert.equal(code(() => readPackDirectory(dir, { pathBytes: 20 })), 'sentinel.rules.packTooLarge');
  assert.equal(code(() => readPackDirectory(dir, { files: 3 })), 'sentinel.rules.packTooLarge');
  assert.equal(code(() => readPackDirectory(dir, { fileBytes: 40 })), 'sentinel.rules.packTooLarge');
  assert.equal(code(() => readPackDirectory(dir, { totalBytes: 100, fileBytes: 1_000_000 })), 'sentinel.rules.packTooLarge');
  assert.equal(readPackDirectory(dir, { entries: 1_000_000 }).size, 4, 'a caller can lower a limit, never raise one');

  // The same files as a directory read and as a map meet the same entry budget: 3 folders + 4 files = 7.
  const plain = scratch(t);
  writePack(plain);
  assert.equal(code(() => readPackDirectory(plain, { entries: 6 })), 'sentinel.rules.packTooLarge');
  const map = readPackDirectory(plain, { entries: 7 });
  assert.equal(code(() => validatePack(map, { entries: 6 })), 'sentinel.rules.packTooLarge');
  assert.equal(validatePack(map, { entries: 7 }).files.length, 4);
});

test('validatePack applies the same bounds to a map it is handed, before decoding or hashing', () => {
  const junk = Buffer.from('not json');
  const many = new Map(Array.from({ length: 5 }, (_, i) => [`f${i}`, junk] as [string, Buffer]));
  many.set('sentinel-pack.json', junk);
  assert.equal(code(() => validatePack(many, { files: 5 })), 'sentinel.rules.packTooLarge', 'counted before the manifest is read');
  assert.equal(code(() => validatePack(new Map([['sentinel-pack.json', Buffer.alloc(41)]]), { fileBytes: 40 })), 'sentinel.rules.packTooLarge');
  assert.equal(code(() => validatePack(new Map([['a', Buffer.alloc(30)], ['b', Buffer.alloc(30)]]), { totalBytes: 50 })), 'sentinel.rules.packTooLarge');
  assert.equal(code(() => validatePack(new Map([['x'.repeat(30), junk]]), { pathBytes: 20 })), 'sentinel.rules.packTooLarge');
  assert.equal(code(() => validatePack(new Map([['a/b/c/d', junk]]), { depth: 2 })), 'sentinel.rules.packTooLarge');
  assert.equal(code(() => validatePack(new Map([['../x', junk]]))), 'sentinel.rules.packUnsafe');
  // Entries count implied folders as readPackDirectory does: a/1, b/1, c/1 are 3 files + 3 folders = 6.
  const spread = new Map([['a/1', junk], ['b/1', junk], ['c/1', junk]]);
  assert.equal(code(() => validatePack(spread, { entries: 5 })), 'sentinel.rules.packTooLarge');
  // Shared prefixes count once: d/e/1, d/e/2, d/e/3 are 3 files + 2 folders = 5, so the limit is not reached and
  // validation goes on to the (missing) manifest.
  const shared = new Map([['d/e/1', junk], ['d/e/2', junk], ['d/e/3', junk]]);
  assert.equal(code(() => validatePack(shared, { entries: 5 })), 'sentinel.rules.manifestInvalid');
  assert.equal(code(() => validatePack(shared, { entries: 4 })), 'sentinel.rules.packTooLarge');
  // Deep unique prefixes with few files: two files, eight implied folders.
  const deep = new Map([['p/q/r/s/1', junk], ['w/x/y/z/2', junk]]);
  assert.equal(code(() => validatePack(deep, { entries: 9 })), 'sentinel.rules.packTooLarge');
  // One path cannot be both a file and a folder, in either order.
  assert.equal(code(() => validatePack(new Map([['f', junk], ['f/g', junk]]))), 'sentinel.rules.packUnsafe');
  assert.equal(code(() => validatePack(new Map([['f/g', junk], ['f', junk]]))), 'sentinel.rules.packUnsafe');

});

test('a folder swapped for a link, or a file swapped for a FIFO, mid-read refuses the pack', t => {
  const outside = scratch(t);
  mkdirSync(join(outside, 'detectors'));
  writeFileSync(join(outside, 'detectors/dynamic-query.yml'), 'outside bytes\n');
  const dir = scratch(t);
  writePack(dir);
  const swapFolder = (rel: string) => {
    if (rel !== 'detectors/dynamic-query.yml') return;
    renameSync(join(dir, 'detectors'), join(dir, 'moved'));
    symlinkSync(join(outside, 'detectors'), join(dir, 'detectors'));
  };
  assert.equal(code(() => readPackDirectoryWith(dir, {}, { beforeRead: swapFolder })), 'sentinel.rules.packChanged');

  const fifo = scratch(t);
  writePack(fifo);
  const swapFile = (rel: string) => {
    if (rel !== 'fixtures/sql/parameterized.ts') return;
    rmSync(join(fifo, rel));
    execFileSync('mkfifo', [join(fifo, rel)]);
  };
  // Without O_NONBLOCK the open would wait for a writer forever; with it, the FIFO is seen and refused.
  assert.equal(code(() => readPackDirectoryWith(fifo, {}, { beforeRead: swapFile })), 'sentinel.rules.packChanged');
  assert.equal(code(() => readPackDirectory(fifo)), 'sentinel.rules.packUnsafe', 'a FIFO already in place is not a regular file');
});

test('a validated pack is deeply immutable, and only validatePack’s own object promotes', t => {
  const dir = scratch(t);
  writePack(dir);
  const pack = validatePack(readPackDirectory(dir));
  const p = pack as any;
  assert.throws(() => { p.manifest.rights.spdx = 'Proprietary'; }, TypeError);
  assert.throws(() => { p.manifest.rules[0].familyId = 'sentinel.other.rule'; }, TypeError);
  assert.throws(() => { p.manifest.rules[0].implementation.rulePath = 'detectors/other.yml'; }, TypeError);
  assert.throws(() => { p.files[0].digest = D('0'); }, TypeError);
  assert.throws(() => { p.entry.rules[0].definitionDigest = D('0'); }, TypeError);
  assert.throws(() => { p.entry.rights.origin = 'third-party'; }, TypeError);
  assert.throws(() => { p.rules[0].familyId = 'sentinel.other.rule'; }, TypeError);
  assert.throws(() => { p.rules.push({ familyId: 'sentinel.x.y', revision: 1, definitionDigest: D('0') }); }, TypeError);
  assert.equal(pack.manifest.rights.spdx, 'MIT');
  assert.equal(isValidatedPack(pack), true);

  const book = owner(t);
  const lock = emptyLock(NOW);
  const real = confirm(book, promotionIntent(lock, { kind: 'pack', pack }), lockDigest(lock), D('0'));
  // A structural copy carrying the real digests, then one with edited metadata, under the real confirmation.
  const copy = JSON.parse(JSON.stringify(pack));
  assert.equal(isValidatedPack(copy), false);
  assert.equal(code(() => promote(lock, { kind: 'pack', pack: copy }, real, NOW)), 'sentinel.rules.promotionUnauthorized');
  const edited = JSON.parse(JSON.stringify(pack));
  edited.entry.rights = { spdx: 'Proprietary', origin: 'sentinel-original' };
  edited.entry.rules[0].familyId = 'sentinel.other.rule';
  assert.equal(code(() => promote(lock, { kind: 'pack', pack: edited }, real, NOW)), 'sentinel.rules.promotionUnauthorized');
  assert.equal(code(() => promotionIntent(lock, { kind: 'pack', pack: edited })), 'sentinel.rules.promotionUnauthorized');

  // The real pack still promotes with its receipt, and the written entry is exactly the confirmed one.
  const next = promote(lock, { kind: 'pack', pack }, real, NOW);
  assert.deepEqual({ ...next.packs[0], promotion: undefined }, { ...structuredClone(pack.entry), promotion: undefined });
  assert.throws(() => { (next.packs[0] as any).rights.spdx = 'X'; }, TypeError, 'the new lock is deeply frozen');
  assert.throws(() => { (lock as any).packs.push({}); }, TypeError, 'the old lock is deeply frozen');
  assert.equal(lock.packs.length, 0);
});

test('locked rules resolve to their original definitions only from the exact pinned packs', t => {
  const dir = scratch(t);
  writePack(dir);
  const v1 = validatePack(readPackDirectory(dir));
  const book = owner(t);
  const lock0 = emptyLock(NOW);
  const lock1 = promote(lock0, { kind: 'pack', pack: v1 }, confirm(book, promotionIntent(lock0, { kind: 'pack', pack: v1 }), lockDigest(lock0), D('0')), NOW);
  const pin1 = lockDigest(lock1);

  // The mandatory rule of the adopted settings resolves to the manifest's own definition, frozen, with its pins.
  const policy = effectivePolicy(adopted(parseSettings(Buffer.from(JSON.stringify({ ...parseExample(), mandatoryRules: ['sentinel.sql.dynamic-query'] })))));
  const [rule] = resolveLockedRules(JSON.parse(JSON.stringify(lock1)), pin1, [v1], policy.rules);
  assert.deepEqual(rule!.definition, load('rulepack').rules[0]);
  assert.equal(rule!.definitionDigest, lock1.packs[0]!.rules[0]!.definitionDigest);
  assert.equal(rule!.packDigest, v1.packDigest);
  assert.equal(rule!.lockDigest, pin1);
  assert.throws(() => { (rule!.definition as any).severity = 'info'; }, TypeError);
  assert.deepEqual(resolveLockedRules(lock1, pin1, [v1]).map(r => r.familyId), ['sentinel.sql.dynamic-query'], 'every locked rule by default');

  // A pack update promoted into a newer lock leaves the active lock resolvable only with the pack it pinned.
  writeFileSync(join(dir, 'detectors/dynamic-query.yml'), 'rules: [ { id: v2 } ]\n');
  const v2 = validatePack(readPackDirectory(dir));
  const lock2 = promote(lock1, { kind: 'pack', pack: v2 }, confirm(book, promotionIntent(lock1, { kind: 'pack', pack: v2 }), pin1, D('0')), NOW);
  assert.equal(lockDigest(lock1), pin1);
  assert.equal(code(() => resolveLockedRules(lock1, pin1, [v2])), 'sentinel.rules.packMismatch', 'a newer pack is not the pinned one');
  assert.equal(resolveLockedRules(lock1, pin1, [v2, v1])[0]!.packDigest, v1.packDigest, 'the matching pack is chosen among several');
  assert.equal(resolveLockedRules(lock2, lockDigest(lock2), [v2])[0]!.packDigest, v2.packDigest);
  assert.equal(code(() => resolveLockedRules(lock2, lockDigest(lock2), [v1])), 'sentinel.rules.packMismatch', 'an older pack is stale');

  // Forged, missing, unlocked and wrong pins are refused.
  assert.equal(code(() => resolveLockedRules(lock1, pin1, [JSON.parse(JSON.stringify(v1))])), 'sentinel.rules.packMismatch');
  assert.equal(code(() => resolveLockedRules(lock1, pin1, [])), 'sentinel.rules.packMissing');
  assert.equal(code(() => resolveLockedRules(lock1, pin1, [v1], ['sentinel.extra.rule-one'])), 'sentinel.rules.ruleNotLocked');
  assert.equal(code(() => resolveLockedRules(lock1, lockDigest(lock2), [v1])), 'sentinel.rules.lockInvalid');
});

test('a tool entry changed after the owner confirmed it is refused', t => {
  const book = owner(t);
  const lock = emptyLock(NOW);
  const tool = { adapterId: 'pattern-engine', version: '1.2.3', artifactDigest: D('7'), platform: 'linux-x64', rights: { spdx: 'MIT', origin: 'third-party' as const, upstream: { name: 'engine', revision: '1.2.3' } } };
  const r = confirm(book, promotionIntent(lock, { kind: 'tool', tool }), lockDigest(lock), D('0'));
  tool.artifactDigest = D('8');
  assert.equal(code(() => promote(lock, { kind: 'tool', tool }, r, NOW)), 'sentinel.rules.promotionUnauthorized');
});

test('a spent receipt is a frozen snapshot; editing or copying it authorizes nothing else', t => {
  const book = owner(t);
  const lock = emptyLock(NOW);
  const toolA = { adapterId: 'pattern-engine', version: '1.2.3', artifactDigest: D('7'), platform: 'linux-x64', rights: { spdx: 'MIT', origin: 'sentinel-original' as const } };
  const toolB = { ...toolA, artifactDigest: D('8') };
  const spent = confirm(book, promotionIntent(lock, { kind: 'tool', tool: toolA }), lockDigest(lock), D('0'));
  const intentB = intentDigest(promotionIntent(lock, { kind: 'tool', tool: toolB }));
  assert.throws(() => { (spent.receipt as any).intentDigest = intentB; }, TypeError);
  assert.throws(() => { (spent.receipt as any).actor.principal = 'someone'; }, TypeError);
  assert.equal(code(() => promote(lock, { kind: 'tool', tool: toolB }, spent, NOW)), 'sentinel.rules.promotionUnauthorized');
  const copy = { receipt: { ...spent.receipt, intentDigest: intentB }, digest: spent.digest } as any;
  assert.equal(code(() => promote(lock, { kind: 'tool', tool: toolB }, copy, NOW)), 'sentinel.rules.promotionUnauthorized', 'a wrapper copy has no authority');
  const next = promote(lock, { kind: 'tool', tool: toolA }, spent, NOW);
  assert.equal(next.tools[0]!.artifactDigest, D('7'));
  assert.equal(next.tools[0]!.promotion.receipt, spent.digest);
});

test('the effective policy is one immutable snapshot: source settings, defaults and the result cannot be changed under it', () => {
  const source = parseSettings(readFileSync(EXAMPLE)) as any;
  const policy = effectivePolicy(adopted(source));
  const local = { action: 'run.start' as const, input: D('e'), effects: ['local-artifacts' as const], budget: { maxTokens: null, maxCost: null, currency: null }, scope: { profile: 'static', provider: null, targets: [] } };
  const req = { intent: local, requestedBy: { principal: 'agent' as const, channel: 'mcp' as const }, policy, capability: available, credential: localOnly, stateDigest: D('1'), now: NOW };
  const before = { revision: policy.revision, view: JSON.stringify(policy.view) };
  assert.equal(admit(req).record.outcome, 'awaiting-confirmation');

  source.agentActions = 'allow';
  source.grants[0].confirm = 'never';
  source.providers[0].budget.maxTokens = 10 ** 9;
  assert.equal(admit(req).record.outcome, 'awaiting-confirmation', 'the caller’s settings are not the policy');
  assert.equal(policy.revision, before.revision);
  assert.equal(JSON.stringify(policy.view), before.view);

  const p = policy as any;
  assert.throws(() => { p.settings.agentActions = 'allow'; }, TypeError);
  assert.throws(() => { p.settings.grants[0].confirm = 'never'; }, TypeError);
  assert.throws(() => { p.settings.grants.push({ actions: ['run.start'], principals: ['agent'], confirm: 'never' }); }, TypeError);
  assert.throws(() => { p.view.grants.push({}); }, TypeError);
  assert.throws(() => { p.thresholds.failOnSeverity = 'critical'; }, TypeError);
  assert.throws(() => { (DEFAULT_SETTINGS as any).grants.push({ actions: ['run.start'], principals: ['agent'], confirm: 'never' }); }, TypeError);
  assert.throws(() => { (DEFAULT_SETTINGS as any).thresholds.failOnSeverity = 'critical'; }, TypeError);
  const untrusted = effectivePolicy({ trust: 'not-adopted', settings: null, settingsDigest: null, repoConfig: null, repoConfigDigest: null });
  assert.deepEqual(untrusted.settings.grants, []);

  // A structural copy with friendlier settings is not a policy admission accepts.
  const forged = { ...JSON.parse(JSON.stringify(policy)), settings: { ...JSON.parse(JSON.stringify(policy.settings)), agentActions: 'allow' } };
  assert.equal(isEffectivePolicy(forged), false);
  assert.equal(code(() => admit({ ...req, policy: forged })), 'sentinel.policy.settingsInvalid');
  // Any grant difference changes the revision a receipt binds to.
  const other = parseSettings(readFileSync(EXAMPLE)) as any;
  other.grants[0].confirm = 'never';
  assert.notEqual(effectivePolicy(adopted(other)).revision, policy.revision);
});

test('admission decides on a private copy of the request', () => {
  const policy = effectivePolicy(adopted(parseSettings(readFileSync(EXAMPLE))));
  const intent = structuredClone(baseIntent) as any;
  const r = admit({
    intent, requestedBy: { principal: 'agent', channel: 'mcp' }, policy, stateDigest: D('1'), now: NOW,
    capability: () => { intent.budget.maxCost = '9999'; intent.scope.provider = 'repo-chosen'; return available(); },
    credential: () => ({ basis: 'keychain-scope' as const, allowed: true, detail: 'ok' }),
  });
  assert.equal(r.record.intentDigest, intentDigest(baseIntent), 'the decision is about the intent as submitted');
  assert.equal(r.record.outcome, 'awaiting-confirmation');
  assert.throws(() => { (r.record as any).verdicts.policy.allowed = false; }, TypeError);
});

function owner(t: { after(fn: () => void): void }) {
  const dir = join(scratch(t, 'sentinel-trust-'), 'receipts');
  return new ReceiptBook(dir);
}
function confirm(book: ReceiptBook, intent: ActionIntent, stateDigest: string, policyRevision: string, now = NOW) {
  const r = issueReceipt(book, { channel: 'owner-cli', principal: 'owner' }, { intent, stateDigest, policyRevision }, { now, ttlMs: 600_000 });
  return book.consume(r.id, { intent, stateDigest, policyRevision }, now);
}

test('promotion writes a new immutable lock; a plan pinned to the old lock is unchanged', t => {
  const dir = scratch(t);
  writePack(dir);
  const pack = validatePack(readPackDirectory(dir));
  const book = owner(t);
  const first = emptyLock(NOW);
  const pin = lockDigest(first);

  const intent = promotionIntent(first, { kind: 'pack', pack });
  assert.equal(intent.action, 'rule.promote');
  assert.equal(intent.input, candidateDigest({ kind: 'pack', pack }), 'the intent covers the complete entry, not only the inventory');
  const second = promote(first, { kind: 'pack', pack }, confirm(book, intent, pin, D('0')), NOW);
  assert.equal(second.revision, 2);
  assert.equal(second.previous, pin);
  assert.equal(second.packs[0]!.packDigest, pack.packDigest);
  assert.ok(Object.isFrozen(second.packs[0]));
  assert.equal(lockDigest(first), pin, 'the pinned lock did not change');
  assert.deepEqual(verifyPinnedLock(JSON.parse(JSON.stringify(first)), pin), first);
  assert.equal(code(() => verifyPinnedLock(JSON.parse(JSON.stringify(second)), pin)), 'sentinel.rules.lockInvalid', 'a newer lock is not the pinned one');

  // A pack update replaces the pack in a third revision and leaves the second as it was.
  writeFileSync(join(dir, 'detectors/dynamic-query.yml'), 'rules: [ { id: x } ]\n');
  const update = validatePack(readPackDirectory(dir));
  const secondPin = lockDigest(second);
  const third = promote(second, { kind: 'pack', pack: update }, confirm(book, promotionIntent(second, { kind: 'pack', pack: update }), secondPin, D('0')), NOW);
  assert.equal(third.packs.length, 1);
  assert.equal(third.packs[0]!.packDigest, update.packDigest);
  assert.equal(lockDigest(second), secondPin);

  // A tool is recorded by digest under its own owner action.
  const tool = { adapterId: 'pattern-engine', version: '1.2.3', artifactDigest: D('7'), platform: 'linux-x64', rights: { spdx: 'MIT', origin: 'third-party' as const, upstream: { name: 'engine', revision: '1.2.3' } } };
  const toolIntent = promotionIntent(third, { kind: 'tool', tool });
  assert.equal(toolIntent.action, 'tool.acquire');
  assert.equal(toolIntent.input, candidateDigest({ kind: 'tool', tool }));
  const fourth = promote(third, { kind: 'tool', tool }, confirm(book, toolIntent, lockDigest(third), D('0')), NOW);
  assert.equal(fourth.tools[0]!.artifactDigest, D('7'));
});

test('promotion needs the owner’s spent receipt for exactly this candidate and lock', t => {
  const dir = scratch(t);
  writePack(dir);
  const pack = validatePack(readPackDirectory(dir));
  const book = owner(t);
  const lock = emptyLock(NOW);
  const forged = { receipt: load('receipt'), digest: D('1') } as any;
  assert.equal(isConsumedReceipt(forged), false);
  assert.equal(code(() => promote(lock, { kind: 'pack', pack }, forged, NOW)), 'sentinel.rules.promotionUnauthorized', 'a receipt-shaped object is not a spent receipt');

  const other: RuleLockEnvelope = { ...emptyLock(later(1000)) };
  const forOtherLock = confirm(book, promotionIntent(other, { kind: 'pack', pack }), lockDigest(other), D('0'));
  assert.equal(code(() => promote(lock, { kind: 'pack', pack }, forOtherLock, NOW)), 'sentinel.rules.promotionUnauthorized', 'bound to the lock revision');

  // A rule family is locked by one pack only.
  const promoted = promote(lock, { kind: 'pack', pack }, confirm(book, promotionIntent(lock, { kind: 'pack', pack }), lockDigest(lock), D('0')), NOW);
  const rival = scratch(t);
  writePack(rival);
  const m = JSON.parse(readFileSync(join(rival, 'sentinel-pack.json'), 'utf8'));
  m.packId = 'rival';
  writeFileSync(join(rival, 'sentinel-pack.json'), JSON.stringify(m));
  const rivalPack = validatePack(readPackDirectory(rival));
  const r = confirm(book, promotionIntent(promoted, { kind: 'pack', pack: rivalPack }), lockDigest(promoted), D('0'));
  assert.equal(code(() => promote(promoted, { kind: 'pack', pack: rivalPack }, r, NOW)), 'sentinel.rules.familyConflict');
});

// ---- settings and the effective policy --------------------------------------------------------------------------

const EXAMPLE = here('../../../.farsight/sentinel/settings.example.json');
const parseExample = () => JSON.parse(readFileSync(EXAMPLE, 'utf8'));
const adopted = (settings: SettingsEnvelope, repo: unknown = null): PolicyInputs => ({
  trust: 'adopted', settings, settingsDigest: D('a'),
  repoConfig: repo === null ? null : parseRepoConfig(Buffer.from(JSON.stringify(repo))), repoConfigDigest: repo === null ? null : D('b'),
});

test('the tracked settings example is scrubbed and valid', () => {
  const s = parseSettings(readFileSync(EXAMPLE));
  assert.equal(s.agentActions, 'confirm');
  for (const p of s.providers) assert.ok(p.credential === null || /^keychain:farsight\/[a-z0-9-]+-example$/.test(p.credential), p.id);
  assert.doesNotMatch(readFileSync(EXAMPLE, 'utf8'), /\/Users\/|\/home\/|@[a-z0-9-]+\.[a-z]/i);
});

test('settings hold keychain references only, and a credential-shaped value is refused without being echoed', () => {
  const secret = 'sk-' + 'A1b2C3d4'.repeat(6);
  const s = parseExample();
  s.mandatoryRules = [secret];
  try { parseSettings(Buffer.from(JSON.stringify(s))); assert.fail('accepted'); } catch (e) {
    assert.ok(e instanceof PolicyError);
    assert.doesNotMatch((e as Error).message, new RegExp(secret));
  }
  const grantName = parseExample();
  grantName.providers[0].id = 'x'.repeat(40);
  grantName.grants[2].scope.providers = ['x'.repeat(40), 'hosted-review'];
  assert.equal(code(() => parseSettings(Buffer.from(JSON.stringify(grantName)))), 'sentinel.policy.credentialValue');
  const env = parseExample();
  env.providers[1].credential = 'env:REVIEW_TOKEN';
  assert.equal(code(() => parseSettings(Buffer.from(JSON.stringify(env)))), 'sentinel.policy.settingsInvalid');
});

test('the repository cannot remove a mandatory rule, weaken a threshold, approve a suppression or add a provider', () => {
  const trusted = parseSettings(readFileSync(EXAMPLE));
  const repo = {
    schema: 'sentinel-repoconfig/draft-1',
    requestedRules: ['sentinel.extra.rule-one'],
    disabledRules: ['sentinel.sql.dynamic-query'],
    thresholds: { failOnSeverity: 'critical', requireCompleteCoverage: false, requiredCapabilities: ['source-span'] },
    suppressions: [{ familyId: 'sentinel.sql.dynamic-query', scopeId: 'api:src/db.ts', rationale: 'trust me' }],
    providers: ['hosted-review', 'repo-chosen'],
  };
  const p = effectivePolicy(adopted(trusted, repo));
  assert.deepEqual([...p.rules], ['sentinel.extra.rule-one', 'sentinel.secrets.committed-credential', 'sentinel.sql.dynamic-query']);
  assert.equal(p.thresholds.failOnSeverity, 'high', 'critical would fail fewer findings');
  assert.equal(p.thresholds.requireCompleteCoverage, true);
  assert.deepEqual(p.thresholds.requiredCapabilities, ['pattern-match', 'source-bytes', 'source-span'], 'a stricter request is added');
  assert.deepEqual(p.view.refused.map(r => `${r.request}:${r.reasonCode}`), [
    'disable-rule:sentinel.policy.mandatoryRuleKept',
    'weaken-threshold:sentinel.policy.thresholdNotWeakened',
    'weaken-threshold:sentinel.policy.thresholdNotWeakened',
    'suppression:sentinel.policy.suppressionNotApproved',
    'provider:sentinel.policy.providerNotTrusted',
  ]);
  // A rule simply left out of the repository file stays mandatory too.
  assert.ok(effectivePolicy(adopted(trusted, { ...repo, requestedRules: [], disabledRules: [] })).rules.includes('sentinel.sql.dynamic-query'));
  // A stricter severity is honoured.
  assert.equal(effectivePolicy(adopted(trusted, { ...repo, thresholds: { failOnSeverity: 'low' } })).thresholds.failOnSeverity, 'low');
});

test('untrusted settings grant nothing, and the served view is redacted', () => {
  const trusted = parseSettings(readFileSync(EXAMPLE));
  for (const trust of ['not-adopted', 'changed', 'missing', 'invalid'] as const) {
    const p = effectivePolicy({ trust, settings: trusted, settingsDigest: D('a'), repoConfig: null, repoConfigDigest: null });
    assert.deepEqual(p.settings, DEFAULT_SETTINGS, trust);
    assert.equal(p.view.settingsDigest, null);
    assert.deepEqual(p.view.grants, []);
  }
  assert.equal(effectivePolicy({ trust: 'adopted', settings: null, settingsDigest: null, repoConfig: null, repoConfigDigest: null }).view.settingsTrust, 'invalid');
  const view = JSON.stringify(effectivePolicy(adopted(trusted)).view);
  assert.doesNotMatch(view, /keychain:|https?:\/\/|example\.com|127\.0\.0\.1/);
  assert.match(view, /"credential":"keychain"/);
  assert.ok(validateEnvelope('policy', JSON.parse(view)).ok);
});

// ---- adoption -------------------------------------------------------------------------------------------------

function workspace(t: { after(fn: () => void): void }, settings = readFileSync(EXAMPLE)) {
  const root = scratch(t, 'sentinel-ws-');
  const ws = join(root, 'repo');
  mkdirSync(join(ws, '.farsight/sentinel'), { recursive: true });
  writeFileSync(join(ws, SETTINGS_PATH), settings);
  return { root, ws, trust: join(scratch(t, 'sentinel-trust-'), 'trust') };
}
function adopt(ws: string, trust: string, book: ReceiptBook) {
  const { intent, settingsDigest } = adoptionIntent(ws);
  const r = confirm(book, intent, settingsDigest, D('0'));
  return adoptSettings({ workspace: ws, trustDir: trust, receipt: r, now: NOW });
}

test('settings are trusted only once the owner adopts these exact bytes for this workspace', t => {
  const { ws, trust } = workspace(t);
  const book = new ReceiptBook(join(trust, '..', 'receipts'));
  assert.equal(loadPolicyInputs({ workspace: ws, trustDir: trust }).trust, 'not-adopted');
  const record = adopt(ws, trust, book);
  assert.equal(record.workspaceIdentity, workspaceIdentity(ws).digest);
  const inputs = loadPolicyInputs({ workspace: ws, trustDir: trust });
  assert.equal(inputs.trust, 'adopted');
  assert.equal(inputs.settings?.providers.length, 2);

  writeFileSync(join(ws, SETTINGS_PATH), readFileSync(join(ws, SETTINGS_PATH), 'utf8').replace('"high"', '"low" '));
  const changed = loadPolicyInputs({ workspace: ws, trustDir: trust });
  assert.equal(changed.trust, 'changed');
  assert.equal(changed.settings, null, 'changed bytes have no authority');
  assert.equal(effectivePolicy(changed).view.grants.length, 0);
});

test('a clone, a moved checkout or a re-created folder has no adoption', t => {
  const { root, ws, trust } = workspace(t);
  const book = new ReceiptBook(join(trust, '..', 'receipts'));
  adopt(ws, trust, book);
  const clone = join(root, 'clone');
  cpSync(ws, clone, { recursive: true });
  assert.equal(loadPolicyInputs({ workspace: clone, trustDir: trust }).trust, 'not-adopted');
  // The original folder is kept (renamed aside) so the re-created one cannot reuse its inode number.
  renameSync(ws, join(root, 'old'));
  cpSync(join(root, 'old'), ws, { recursive: true });
  assert.equal(loadPolicyInputs({ workspace: ws, trustDir: trust }).trust, 'not-adopted');
});

test('adoption needs the owner’s receipt for these settings here, and trust state stays outside the checkout', t => {
  const { ws, trust } = workspace(t);
  const book = new ReceiptBook(join(trust, '..', 'receipts'));
  const other = workspace(t);
  const { intent, settingsDigest } = adoptionIntent(other.ws);
  const wrong = confirm(book, intent, settingsDigest, D('0'));
  assert.equal(code(() => adoptSettings({ workspace: ws, trustDir: trust, receipt: wrong, now: NOW })), 'sentinel.policy.adoptionUnauthorized');
  assert.equal(code(() => adoptSettings({ workspace: ws, trustDir: trust, receipt: { receipt: load('receipt'), digest: D('1') } as any, now: NOW })), 'sentinel.policy.adoptionUnauthorized');
  assert.equal(code(() => adopt(ws, join(ws, '.farsight/trust'), book)), 'sentinel.policy.trustDirInsideWorkspace');

  mkdirSync(trust, { recursive: true, mode: 0o700 });
  chmodSync(trust, 0o755);
  assert.equal(code(() => loadPolicyInputs({ workspace: ws, trustDir: trust })), 'sentinel.policy.trustDirUnsafe');
  chmodSync(trust, 0o700);

  rmSync(join(ws, SETTINGS_PATH));
  symlinkSync(EXAMPLE, join(ws, SETTINGS_PATH));
  assert.equal(code(() => loadPolicyInputs({ workspace: ws, trustDir: trust })), 'sentinel.policy.settingsUnreadable');
  assert.equal(code(() => workspaceIdentity(`${ws}/`)), 'sentinel.policy.workspaceNotCanonical');
});

test('the trust folder follows XDG state, then the platform default', () => {
  assert.equal(trustDirectory({ XDG_STATE_HOME: '/state' }, 'linux', '/h'), '/state/farsight/sentinel/trust');
  assert.equal(trustDirectory({ XDG_STATE_HOME: 'relative' }, 'linux', '/h'), '/h/.local/state/farsight/sentinel/trust');
  assert.equal(trustDirectory({}, 'darwin', '/h'), '/h/Library/Application Support/farsight/sentinel/trust');
});

// ---- receipts -------------------------------------------------------------------------------------------------

const baseIntent: ActionIntent = {
  action: 'paid.admit', input: D('c'), effects: ['paid-inference', 'network'],
  budget: { maxTokens: 1000, maxCost: '0.50', currency: 'USD' },
  scope: { profile: 'review', provider: 'hosted-review', targets: ['api:src'] },
};

test('a receipt is one-use, short-lived and bound to the exact intent, state and policy', t => {
  const book = owner(t);
  const bind = { intent: baseIntent, stateDigest: D('1'), policyRevision: D('2') };
  const r = issueReceipt(book, { channel: 'owner-cli', principal: 'owner' }, bind, { now: NOW, ttlMs: 60_000 });
  for (const [change, expect] of [
    [{ ...bind, intent: { ...baseIntent, budget: { ...baseIntent.budget, maxCost: '0.51' } } }, 'sentinel.receipt.mismatch'],
    [{ ...bind, intent: { ...baseIntent, effects: ['paid-inference', 'network', 'source-disclosure'] } }, 'sentinel.receipt.mismatch'],
    [{ ...bind, intent: { ...baseIntent, input: D('d') } }, 'sentinel.receipt.mismatch'],
    [{ ...bind, stateDigest: D('9') }, 'sentinel.receipt.mismatch'],
    [{ ...bind, policyRevision: D('9') }, 'sentinel.receipt.mismatch'],
  ] as const) {
    assert.equal(code(() => book.consume(r.id, change as any, NOW)), expect);
  }
  assert.equal(code(() => book.consume(r.id, bind, later(60_000))), 'sentinel.receipt.expired');
  const spent = book.consume(r.id, bind, later(59_999));
  assert.ok(isConsumedReceipt(spent));
  assert.equal(spent.receipt.intentDigest, intentDigest(baseIntent));
  assert.equal(code(() => book.consume(r.id, bind, NOW)), 'sentinel.receipt.alreadyUsed');
  assert.equal(code(() => new ReceiptBook(book.directory).consume(r.id, bind, NOW)), 'sentinel.receipt.alreadyUsed', 'spent for every reader of the trust folder');
});

test('only the owner CLI channel issues a receipt, and a receipt not issued here is unknown', t => {
  const book = owner(t);
  const bind = { intent: baseIntent, stateDigest: D('1'), policyRevision: D('2') };
  for (const channel of ['mcp', 'http-bridge', 'model']) {
    assert.equal(code(() => issueReceipt(book, { channel, principal: 'owner' }, bind, { now: NOW, ttlMs: 1000 })), 'sentinel.receipt.ownerOnly', channel);
  }
  assert.equal(code(() => issueReceipt(book, { channel: 'owner-cli', principal: 'owner' }, bind, { now: NOW, ttlMs: MAX_RECEIPT_TTL_MS + 1 })), 'sentinel.receipt.ttlInvalid');
  assert.equal(code(() => book.consume('receipt-never-issued', bind, NOW)), 'sentinel.receipt.unknown');
  assert.equal(code(() => book.consume('../escape', bind, NOW)), 'sentinel.receipt.unknown');
});

test('no export of the package can mint a receipt', async () => {
  const root = await import('@farsight/sentinel');
  const policy = await import('@farsight/sentinel/policy');
  for (const m of [root, policy]) {
    assert.equal('issueReceipt' in m, false);
    assert.equal(typeof (m as any).ReceiptBook.prototype.issue, 'undefined');
  }
  await assert.rejects(import('@farsight/sentinel/dist/policy/owner-receipts.js'), (e: any) => e.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED');
});

// ---- admission ------------------------------------------------------------------------------------------------

function policyOf(settings: SettingsEnvelope = parseSettings(readFileSync(EXAMPLE))): EffectivePolicy {
  return effectivePolicy(adopted(settings));
}
const localOnly = () => ({ basis: 'local-only' as const, detail: 'nothing leaves this machine' });
const available = () => ({ available: true, detail: 'ok' });

test('a denied policy asks nothing else, so no provider or credential is contacted', () => {
  let asked = 0;
  const r = admit({
    intent: { ...baseIntent, action: 'tool.acquire', effects: ['local-artifacts'], budget: { maxTokens: null, maxCost: null, currency: null }, scope: { profile: null, provider: null, targets: [] } },
    requestedBy: { principal: 'agent', channel: 'mcp' }, policy: policyOf(),
    capability: () => { asked++; return available(); }, credential: () => { asked++; return localOnly(); },
    stateDigest: D('1'), now: NOW,
  });
  assert.equal(r.record.outcome, 'denied');
  assert.equal(r.record.verdicts.policy.reasonCode, 'sentinel.admission.ownerOnly');
  assert.equal(r.record.verdicts.credential.basis, 'not-asked');
  assert.equal(asked, 0);
});

test('an agent’s allowed paid action waits for the owner, and admits once with the owner’s receipt', t => {
  const book = owner(t);
  const policy = policyOf();
  const req = {
    intent: baseIntent, requestedBy: { principal: 'agent' as const, channel: 'mcp' as const }, policy,
    capability: available, credential: () => ({ basis: 'keychain-scope' as const, allowed: true, detail: 'scope covers inference' }),
    stateDigest: D('1'), now: NOW,
  };
  const waiting = admit(req);
  assert.equal(waiting.record.outcome, 'awaiting-confirmation');
  assert.equal(waiting.record.receipt, null);
  const r = issueReceipt(book, { channel: 'owner-cli', principal: 'owner' }, { intent: baseIntent, stateDigest: D('1'), policyRevision: policy.revision }, { now: NOW, ttlMs: 60_000 });
  const ok = admit({ ...req, receipt: { book, id: r.id } });
  assert.equal(ok.record.outcome, 'admitted');
  assert.equal(ok.record.receipt, ok.receipt!.digest);
  assert.equal(code(() => admit({ ...req, receipt: { book, id: r.id } })), 'sentinel.receipt.alreadyUsed');

  const r2 = issueReceipt(book, { channel: 'owner-cli', principal: 'owner' }, { intent: baseIntent, stateDigest: D('1'), policyRevision: policy.revision }, { now: NOW, ttlMs: 60_000 });
  const stricter = parseSettings(readFileSync(EXAMPLE));
  stricter.thresholds.failOnSeverity = 'low';
  assert.equal(code(() => admit({ ...req, policy: policyOf(stricter), receipt: { book, id: r2.id } })), 'sentinel.receipt.mismatch', 'a changed policy needs a new confirmation');
});

test('budgets, providers, capability and credential each deny on their own', () => {
  const base = { requestedBy: { principal: 'human' as const, channel: 'owner-cli' as const }, policy: policyOf(), capability: available, credential: localOnly, stateDigest: D('1'), now: NOW };
  const run = (intent: ActionIntent, over: Partial<typeof base> = {}) => admit({ ...base, ...over, intent }).record;
  assert.equal(run({ ...baseIntent, budget: { maxTokens: null, maxCost: '0.5', currency: 'USD' } }).verdicts.policy.reasonCode, 'sentinel.admission.budgetRequired');
  assert.equal(run({ ...baseIntent, budget: { maxTokens: 1000, maxCost: '5.000000001', currency: 'USD' } }).verdicts.policy.reasonCode, 'sentinel.admission.budgetExceeded');
  assert.equal(run({ ...baseIntent, budget: { maxTokens: 1000, maxCost: '1', currency: 'EUR' } }).verdicts.policy.reasonCode, 'sentinel.admission.budgetExceeded');
  assert.equal(run({ ...baseIntent, scope: { ...baseIntent.scope, provider: 'repo-chosen' } }).verdicts.policy.reasonCode, 'sentinel.admission.providerNotTrusted');
  assert.equal(run({ ...baseIntent, effects: ['paid-inference', 'tool-execution'] }).verdicts.policy.reasonCode, 'sentinel.admission.noGrant', 'the grant does not permit tool execution');
  const missing = run(baseIntent, { capability: () => ({ available: false, detail: 'no such model' }) });
  assert.equal(missing.outcome, 'denied');
  assert.equal(missing.verdicts.capability.reasonCode, 'sentinel.admission.capabilityMissing');
  const unknown = run(baseIntent, { credential: () => ({ basis: 'unknown' as const, detail: 'scope not reported' }) });
  assert.equal(unknown.outcome, 'denied');
  assert.equal(unknown.verdicts.credential.basis, 'unknown');
  // A local run needs no remote credential and records why; an agent still waits for a person by default.
  const local = { action: 'run.start' as const, input: D('e'), effects: ['local-artifacts' as const], budget: { maxTokens: null, maxCost: null, currency: null }, scope: { profile: 'static', provider: null, targets: [] } };
  assert.equal(run(local).outcome, 'admitted');
  assert.equal(run(local).verdicts.credential.reasonCode, 'sentinel.admission.credentialLocalOnly');
  assert.equal(run(local, { requestedBy: { principal: 'agent', channel: 'mcp' } }).outcome, 'awaiting-confirmation');
  // Untrusted settings: nothing is granted, to anyone.
  const untrusted = effectivePolicy({ trust: 'changed', settings: parseSettings(readFileSync(EXAMPLE)), settingsDigest: null, repoConfig: null, repoConfigDigest: null });
  assert.equal(run(local, { policy: untrusted }).verdicts.policy.reasonCode, 'sentinel.admission.noGrant');
});

test('decimal amounts compare exactly', () => {
  assert.equal(compareDecimal('0.1', '0.10'), 0);
  assert.equal(compareDecimal('10', '9.999999999'), 1);
  assert.equal(compareDecimal('5.000000001', '5.00'), 1);
  assert.equal(compareDecimal('0', '0.000000001'), -1);
});

test('the repository config file and the settings file names are the documented ones', () => {
  assert.equal(SETTINGS_PATH, '.farsight/sentinel/settings.json');
  assert.equal(REPO_CONFIG_PATH, 'sentinel.config.json');
});
