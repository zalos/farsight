// Stage packs: the prompts, instructions and skills an agent stage uses, as owner-promoted bytes pinned by digest.
//
// A pack is a folder the owner writes, with a manifest naming every file and its sha256:
//
//   sentinel-stage-pack.json   {"schema":"sentinel-stage-pack/draft-1","kind":"stage"|"skill","id":"review",
//                               "revision":3,"files":[{"path":"prompt.md","digest":"sha256:…"}]}
//
// A skill pack holds `SKILL.md` (and optional resources beside it). Promotion validates the folder, copies exactly the
// listed bytes into the trust folder (`<trust>/stage-packs/<kind>s/<id>@<revision>/`, read-only) and records the
// pack's digest in the pack lock. A promoted revision is write-once. A stage names bytes by pack reference
// (`stages/review@3#prompt.md`, `skills/owasp-top10@2`); resolution re-reads them from the trust folder, checks every
// file against its manifest and the manifest against the lock, and refuses a changed or unapproved byte before
// anything is dispatched. Nothing here runs a pack's bytes; they are text the model reads.
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { canonicalDigest } from '../policy/digest.js';
import { readPackDirectory } from '../rules/pack.js';
import { reviewFail } from './errors.js';
import { prepareInstructions, type PreparedInstructions, type SkillSelection } from './instructions.js';
import type { PromptArtifact } from './prompts.js';

export const STAGE_PACK_MANIFEST = 'sentinel-stage-pack.json';
export const STAGE_PACK_SCHEMA = 'sentinel-stage-pack/draft-1';
/** Bounds of one stage pack: small text the model reads, never a code bundle. */
export const STAGE_PACK_LIMITS = Object.freeze({
  files: 32,
  entries: 64,
  depth: 4,
  pathBytes: 256,
  fileBytes: 65536,
  totalBytes: 524288,
});

export type StagePackKind = 'stage' | 'skill';
export interface StagePackFile {
  readonly path: string;
  readonly digest: string;
  readonly bytes: Uint8Array;
}
/** A validated pack: its identity, its exact files, and the digest the lock pins. */
export interface StagePack {
  readonly kind: StagePackKind;
  readonly id: string;
  readonly revision: number;
  readonly files: readonly StagePackFile[];
  /** Canonical digest of the manifest (kind, id, revision and every file's path and digest). */
  readonly digest: string;
}

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}(\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}){0,7}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const REF = /^(stages|skills)\/([a-z0-9][a-z0-9-]{0,63})@([1-9][0-9]{0,8})(?:#(.+))?$/;
const sha = (b: Uint8Array) => 'sha256:' + createHash('sha256').update(b).digest('hex');
const invalid = (detail: string): never => reviewFail('sentinel.review.packInvalid', detail);
const changed = (detail: string): never => reviewFail('sentinel.review.packChanged', detail);

/** Checks a pack folder's bytes against its own manifest: every listed file present and exact, nothing else. */
export function validateStagePack(files: ReadonlyMap<string, Uint8Array>): StagePack {
  const raw = files.get(STAGE_PACK_MANIFEST) ?? invalid('a stage pack has its manifest');
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(raw)) as Record<string, unknown>;
  } catch {
    return invalid('the manifest is UTF-8 JSON');
  }
  if (
    !m ||
    typeof m !== 'object' ||
    Array.isArray(m) ||
    Object.keys(m).sort().join() !== 'files,id,kind,revision,schema'
  )
    return invalid('the manifest has exactly schema, kind, id, revision and files');
  if (m.schema !== STAGE_PACK_SCHEMA) invalid('the manifest schema is sentinel-stage-pack/draft-1');
  if (m.kind !== 'stage' && m.kind !== 'skill') invalid('a pack is a stage pack or a skill pack');
  if (typeof m.id !== 'string' || !ID.test(m.id)) invalid('a pack id is lower-case words joined by hyphens');
  if (!Number.isSafeInteger(m.revision) || (m.revision as number) < 1 || (m.revision as number) > 999999999)
    invalid('a pack revision is a positive integer');
  const listed = m.files;
  if (!Array.isArray(listed) || !listed.length || listed.length > STAGE_PACK_LIMITS.files - 1)
    return invalid('a pack lists its files');
  const out: StagePackFile[] = [];
  const seen = new Set<string>();
  for (const f of listed as unknown[]) {
    const e = f as Record<string, unknown>;
    if (!e || typeof e !== 'object' || Object.keys(e).sort().join() !== 'digest,path')
      invalid('a file is a path and a digest');
    if (typeof e.path !== 'string' || !FILE.test(e.path) || e.path === STAGE_PACK_MANIFEST || seen.has(e.path))
      invalid('a pack file is a distinct plain relative path');
    if (typeof e.digest !== 'string' || !DIGEST.test(e.digest)) invalid('a pack file digest is sha256');
    const bytes = files.get(e.path as string) ?? changed(`${e.path as string} is listed but absent`);
    if (sha(bytes) !== e.digest) changed(`${e.path as string} differs from its manifest digest`);
    try {
      new TextDecoder('utf8', { fatal: true }).decode(bytes);
    } catch {
      invalid(`${e.path as string} is UTF-8 text`);
    }
    seen.add(e.path as string);
    out.push(Object.freeze({ path: e.path as string, digest: e.digest as string, bytes: Uint8Array.from(bytes) }));
  }
  for (const path of files.keys())
    if (path !== STAGE_PACK_MANIFEST && !seen.has(path)) changed(`${path} is in the folder but not in the manifest`);
  if (m.kind === 'skill' && !seen.has('SKILL.md')) invalid('a skill pack holds SKILL.md');
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const identity = {
    schema: STAGE_PACK_SCHEMA,
    kind: m.kind as StagePackKind,
    id: m.id as string,
    revision: m.revision as number,
    files: out.map((f) => ({ path: f.path, digest: f.digest })),
  };
  return Object.freeze({
    kind: identity.kind,
    id: identity.id,
    revision: identity.revision,
    files: Object.freeze(out),
    digest: canonicalDigest(identity),
  });
}

const root = (trustDir: string) => join(trustDir, 'stage-packs');
const lockPath = (trustDir: string) => join(root(trustDir), 'lock.json');
const packDir = (trustDir: string, kind: StagePackKind, id: string, revision: number) =>
  join(root(trustDir), kind === 'stage' ? 'stages' : 'skills', `${id}@${revision}`);
const refOf = (p: Pick<StagePack, 'kind' | 'id' | 'revision'>) =>
  `${p.kind === 'stage' ? 'stages' : 'skills'}/${p.id}@${p.revision}`;

/** The pack lock: each promoted pack reference and the digest it was promoted with. */
export function readStagePackLock(trustDir: string): Readonly<Record<string, string>> {
  let bytes: Buffer;
  try {
    const st = lstatSync(lockPath(trustDir));
    if (!st.isFile() || st.isSymbolicLink() || st.size > 262144) return changed('the pack lock is not a plain file');
    bytes = readFileSync(lockPath(trustDir));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return Object.freeze({});
    throw e;
  }
  let lock: unknown;
  try {
    lock = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes));
  } catch {
    return changed('the pack lock is not JSON');
  }
  const value = lock as Record<string, unknown>;
  if (!value || typeof value !== 'object' || value.schema !== 'sentinel-stage-pack-lock/draft-1')
    return changed('the pack lock has the wrong schema');
  const packs = value.packs as Record<string, unknown>;
  if (!packs || typeof packs !== 'object' || Array.isArray(packs)) return changed('the pack lock lists packs');
  for (const [ref, d] of Object.entries(packs))
    if (!REF.test(ref) || REF.exec(ref)![4] !== undefined || typeof d !== 'string' || !DIGEST.test(d))
      changed('the pack lock holds a malformed entry');
  return Object.freeze({ ...(packs as Record<string, string>) });
}

function writeDurably(path: string, bytes: Uint8Array, mode: number) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try {
    let at = 0;
    while (at < bytes.length) at += writeSync(fd, bytes, at, bytes.length - at);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Promotes one pack folder into the trust folder. The owner's confirmation is required. Idempotent for the same
 * bytes; a promoted revision whose bytes differ is refused (bump the revision instead). Returns the validated pack.
 */
export function promoteStagePack(trustDir: string, sourceDir: string, options: { confirm: boolean }): StagePack {
  if (options?.confirm !== true)
    return reviewFail('sentinel.review.packUnapproved', 'promotion needs the owner to confirm');
  const pack = validateStagePack(readPackDirectory(sourceDir, STAGE_PACK_LIMITS));
  const lock = readStagePackLock(trustDir),
    ref = refOf(pack);
  if (lock[ref] !== undefined) {
    if (lock[ref] !== pack.digest) changed(`${ref} is already promoted with other bytes`);
    return pack;
  }
  const target = packDir(trustDir, pack.kind, pack.id, pack.revision);
  const staging = `${target}.staging-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  const manifest = Buffer.from(
    JSON.stringify({
      schema: STAGE_PACK_SCHEMA,
      kind: pack.kind,
      id: pack.id,
      revision: pack.revision,
      files: pack.files.map((f) => ({ path: f.path, digest: f.digest })),
    }),
  );
  writeDurably(join(staging, STAGE_PACK_MANIFEST), manifest, 0o400);
  for (const f of pack.files) {
    mkdirSync(dirname(join(staging, f.path)), { recursive: true, mode: 0o700 });
    writeDurably(join(staging, f.path), f.bytes, 0o400);
  }
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  rmSync(target, { recursive: true, force: true });
  renameSync(staging, target);
  const next = Buffer.from(
    JSON.stringify({ schema: 'sentinel-stage-pack-lock/draft-1', packs: { ...lock, [ref]: pack.digest } }, null, 2) +
      '\n',
  );
  const tmp = `${lockPath(trustDir)}.tmp-${process.pid}`;
  rmSync(tmp, { force: true });
  writeDurably(tmp, next, 0o600);
  renameSync(tmp, lockPath(trustDir));
  return pack;
}

/** A promoted pack, re-read from the trust folder and checked against the lock. Refuses a changed or unapproved byte. */
export function readPromotedPack(trustDir: string, kind: StagePackKind, id: string, revision: number): StagePack {
  const ref = refOf({ kind, id, revision }),
    pinned = readStagePackLock(trustDir)[ref];
  if (pinned === undefined) return reviewFail('sentinel.review.packUnapproved', `${ref} is not promoted`);
  const pack = validateStagePack(readPackDirectory(packDir(trustDir, kind, id, revision), STAGE_PACK_LIMITS));
  if (pack.digest !== pinned || pack.kind !== kind || pack.id !== id || pack.revision !== revision)
    changed(`${ref} differs from the bytes it was promoted with`);
  return pack;
}

/** One file of a promoted stage pack, by its reference `stages/<id>@<revision>#<file>`. */
export function resolveStageFile(trustDir: string, ref: string): StagePackFile & { readonly pack: string } {
  const m = REF.exec(ref);
  if (!m || m[1] !== 'stages' || m[4] === undefined)
    return invalid('a stage file reference names stages/<id>@<n>#<file>');
  const pack = readPromotedPack(trustDir, 'stage', m[2]!, Number(m[3]));
  const file = pack.files.find((f) => f.path === m[4]) ?? invalid(`${ref} names no file of its pack`);
  return Object.freeze({ ...file, pack: pack.digest });
}

/** One promoted skill pack, by its reference `skills/<id>@<revision>`, as the instruction preparation reads it. */
export function resolveSkill(trustDir: string, ref: string): ResolvedSkill {
  const m = REF.exec(ref);
  if (!m || m[1] !== 'skills' || m[4] !== undefined) return invalid('a skill reference names skills/<id>@<n>');
  const pack = readPromotedPack(trustDir, 'skill', m[2]!, Number(m[3]));
  const text = (f: StagePackFile) => new TextDecoder('utf8', { fatal: true }).decode(f.bytes);
  const main = pack.files.find((f) => f.path === 'SKILL.md')!;
  return Object.freeze({
    ref,
    id: pack.id,
    revision: pack.revision,
    digest: pack.digest,
    files: pack.files,
    selection: Object.freeze({
      id: pack.id,
      revision: pack.revision,
      text: text(main),
      resources: pack.files
        .filter((f) => f.path !== 'SKILL.md')
        .map((f) => Object.freeze({ id: f.path.replaceAll('/', '.'), revision: pack.revision, text: text(f) })),
    }),
  });
}
export interface ResolvedSkill {
  readonly ref: string;
  readonly id: string;
  readonly revision: number;
  /** The pack digest the lock pins. */
  readonly digest: string;
  /** The skill's exact files (`SKILL.md` and its resources), for a native CLI's skill directory. */
  readonly files: readonly StagePackFile[];
  /** The same bytes as the instruction record's skill selection. */
  readonly selection: SkillSelection;
}

/** The instruction bytes and ordered skills an agent stage names, resolved and checked before anything is sent. */
export interface ResolvedStageInstructions {
  /** The prompt (brokered) or instructions (native) file, or null when the stage uses the bundled text. */
  readonly text: (StagePackFile & { readonly ref: string; readonly pack: string }) | null;
  readonly skills: readonly ResolvedSkill[];
}
export function resolveStageInstructions(
  trustDir: string,
  stage: {
    readonly mode: 'brokered' | 'native';
    readonly prompt?: string;
    readonly instructions?: string;
    readonly skills?: readonly string[];
  },
): ResolvedStageInstructions {
  const named = stage.mode === 'native' ? stage.instructions : stage.prompt;
  if (stage.mode === 'native' && stage.prompt !== undefined) invalid('a native stage names instructions, not a prompt');
  if (stage.mode === 'brokered' && stage.instructions !== undefined)
    invalid('a brokered stage names a prompt, not instructions');
  const skills = stage.skills ?? [];
  if (skills.length > 16 || new Set(skills).size !== skills.length) invalid('a stage names at most 16 distinct skills');
  return Object.freeze({
    text: named === undefined ? null : Object.freeze({ ...resolveStageFile(trustDir, named), ref: named }),
    skills: Object.freeze(skills.map((ref) => resolveSkill(trustDir, ref))),
  });
}

/** What a pipeline digest covers for a stage's referenced bytes: each reference and the pack digest it resolved to. */
export function stagePackDigests(
  resolved: ResolvedStageInstructions,
): readonly Readonly<{ ref: string; digest: string }>[] {
  return Object.freeze([
    ...(resolved.text ? [Object.freeze({ ref: resolved.text.ref, digest: resolved.text.pack })] : []),
    ...resolved.skills.map((s) => Object.freeze({ ref: s.ref, digest: s.digest })),
  ]);
}

/**
 * A brokered stage's prepared instructions: the promoted prompt (or the bundled one) and its promoted skills, in
 * order, as the review session retains and sends them. The instruction record then lists every byte and digest.
 */
export function brokeredInstructions(
  trustDir: string,
  stage: { readonly prompt?: string; readonly skills?: readonly string[] },
  bundled: PromptArtifact,
): Readonly<{ instructions: PreparedInstructions; packs: ReturnType<typeof stagePackDigests> }> {
  const resolved = resolveStageInstructions(trustDir, { ...stage, mode: 'brokered' });
  const prompt: PromptArtifact = resolved.text
    ? Object.freeze({
        id: `${REF.exec(resolved.text.ref)![2]}:${resolved.text.path.replaceAll('/', '.')}`,
        version: Number(REF.exec(resolved.text.ref)![3]),
        text: new TextDecoder('utf8', { fatal: true }).decode(resolved.text.bytes),
      })
    : bundled;
  return Object.freeze({
    instructions: prepareInstructions({ prompt, skills: resolved.skills.map((k) => k.selection) }),
    packs: stagePackDigests(resolved),
  });
}
