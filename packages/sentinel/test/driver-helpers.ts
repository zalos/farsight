import { scannerKernels } from '../dist/adapters/drivers/kernels.js';
// Shared set-up for the check-driver tests: the shipped original packs as the coordinator would hand them to a driver
// (resolved rules, pins, file list and verified bytes), synthetic plan units and checks, and a stand-in for the
// coordinator's execution step that runs a prepared unit through the real PR 07 execution service.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readPackDirectory, validatePack } from '../dist/rules/pack.js';
import { readSealedInput } from '../dist/adapters/sealed-input.js';
import { releaseWorkDir } from '../dist/execution/supervisor.js';

export const PACKS = fileURLToPath(new URL('../rules/', import.meta.url)).replace(/\/$/, '');
export const sha = (b: Uint8Array | string) => `sha256:${createHash('sha256').update(b).digest('hex')}`;

/** A shipped pack as the coordinator resolves it from an admitted lock: rules, pins, files and their bytes. */
export function shippedRules(pack: string, override: { definitionDigest?: string; adapterId?: string } = {}) {
  const files = readPackDirectory(`${PACKS}/${pack}`);
  const p = validatePack(files);
  const bytes = new Map<string, Uint8Array>();
  for (const [, b] of files) bytes.set(sha(b), b);
  const resolved = p.manifest.rules.map(r => {
    const locked = p.entry.rules.find(x => x.familyId === r.familyId)!;
    return { familyId: r.familyId, revision: r.revision, definition: r, definitionDigest: override.definitionDigest ?? locked.definitionDigest,
      packId: p.entry.packId, packDigest: p.entry.packDigest, lockDigest: sha('lock') };
  });
  const pins = resolved.map(r => ({ familyId: r.familyId, revision: r.revision, definitionDigest: r.definitionDigest, packDigest: r.packDigest,
    adapterId: override.adapterId ?? r.definition.implementation.adapterId }));
  return { pack: p, rules: { pins, resolved, files: p.files, bytesOf: (d: string) => bytes.get(d) } };
}

export function unit(id: string, sourceId: string, inputs: { relativePath: string; artifact: string }[]) {
  return { id, revision: 1, stage: 'analysis', contract: 'test', implementationDigest: sha('impl'), sourceId, adapterId: null, dependencies: [],
    inputFingerprint: sha(id), checks: [], scopes: inputs.map(i => `${sourceId}:${i.relativePath}`),
    inputs: inputs.map(i => ({ sourceId, relativePath: i.relativePath, content: i.artifact })), inputSetDigest: sha(`${id}-inputs`) } as any;
}

export function checks(familyId: string, scopeKind: string, sourceId: string, paths: string[]) {
  return paths.map((p, i) => ({ id: `chk-${familyId.replace(/[^a-z]/g, '')}-${i}`, familyId, ruleRevision: 1, scopeKind, scopeId: `${sourceId}:${p}`, sourceId,
    environment: sha('env'), mode: 'deterministic', required: true, state: 'planned' } as any));
}

export function prepareContext(driverRules: any, u: any, cs: any[], targets: { relativePath: string; artifact: string; path: string }[], scratch: string, extra: Record<string, unknown> = {}) {
  return {
    run: { id: 'run-driver', snapshotId: 'snap-driver' }, unit: u, checks: cs, rules: driverRules, tools: [], databases: [], scratch, now: new Date(),
    tools: (() => { const id = driverRules.resolved[0]?.definition.implementation.adapterId; const d = scannerKernels({ maxAdvisoryAgeMs: 86400000 }).get(id)?.definition; return d ? [{ adapterId: id, artifactDigest: d.image.slice(d.image.indexOf('@') + 1) }] : []; })(),
    inputs: targets.map(t => ({ input: { sourceId: u.sourceId, relativePath: t.relativePath, content: t.artifact }, scopes: [`${u.sourceId}:${t.relativePath}`], path: t.path })),
    ...extra,
  } as any;
}

/** What the coordinator does with a prepared unit: run it through the execution service and normalize its outputs. */
export async function execute(service: any, driver: any, ctx: any, attemptId: string, extra: Record<string, unknown> = {}) {
  const prepared = await driver.prepare(ctx);
  if (prepared.skipRun) return { prepared, result: prepared.skipRun.result, records: [] as any[] };
  const all = [...ctx.inputs.map((i: any) => ({ id: i.input.content, path: i.path })), ...prepared.artifacts.map((a: any) => ({ id: a.id, path: a.path }))];
  // One sealed copy per artifact: two captured files with the same bytes are one input.
  const inputs = all.filter((x, i) => all.findIndex(y => y.id === x.id) === i);
  const outcome = await service.run({ adapterId: driver.adapterId, attemptId, work: { id: ctx.unit.id, revision: 1 }, inputs, ...extra });
  try {
    const byId = new Map(outcome.outputs.map((o: any) => [o.id, o.path]));
    const normalized = driver.normalize({ context: prepared.context, outcome, unit: ctx.unit, checks: ctx.checks, now: ctx.now,
      output: (id: string) => readFileSync(byId.get(id) as string), sealed: (id: string) => readSealedInput(outcome.workDir, id) });
    return { prepared, outcome, ...normalized };
  } finally { releaseWorkDir(outcome.workDir); }
}

/** Per check, keyed by `family scope` when the checks span several rules (else by scope): covered with its limits, or not run with its reason. */
export function verdicts(result: any, cs: any[]) {
  const many = new Set(cs.map(c => c.familyId)).size > 1;
  const covered = new Set(result.coveredChecks.map((c: any) => c.checkId));
  return Object.fromEntries(cs.map(c => {
    const why = result.skipped.filter((s: any) => s.scopeId === c.scopeId).map((s: any) => s.reasonCode.split('.').pop()).sort();
    return [many ? `${c.familyId} ${c.scopeId}` : c.scopeId, `${covered.has(c.id) ? 'ran' : 'not-run'}${why.length ? `:${why.join(',')}` : ''}`];
  }));
}
