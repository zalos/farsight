// Closed model inputs appended to a genuine deterministic analysis plan. These bytes are data; plan admission,
// current adopted selection and the coordinator's exact unit/attempt remain the authority.
import { createHash } from 'node:crypto';
import { validateEnvelope } from '../validate.js';
import type { ArtifactId, PlanEnvelope, PlanWork, PlannedReview } from '../contracts/index.js';
import { canonicalDigest } from '../policy/digest.js';
import { snapshot } from '../policy/immutable.js';
import type { EffectivePolicy } from '../policy/settings.js';
import { reviewUnitIdOf } from '../planner/identity.js';
import type { SentinelStore } from '../store/index.js';
import { canonicalJsonBytes } from '../store/objects.js';
import {
  prepareInstructions,
  instructionArtifacts,
  instructionManifest,
  type InstructionArtifact,
} from './instructions.js';
import { specDigest, type SessionSpec } from './session.js';
import { resolveReviewModel } from './providers/selection.js';
import { reviewFail } from './errors.js';
import { guidedSpec } from './guided.js';
import { generalSpec } from './general.js';
import { partitionInventory } from './evidence.js';
import { cliKind } from './providers/registry.js';
const digest = (v: unknown) => canonicalDigest(v) as ArtifactId;
const bad = (): never => reviewFail('sentinel.review.integrity', 'the admitted review inputs differ');
export const MAX_REVIEW_UNITS = 32;
export interface ReviewPlanInputs {
  readonly plan: PlanEnvelope;
  readonly artifacts: readonly InstructionArtifact[];
}
export function withReviewUnits(
  given: PlanEnvelope,
  specs: readonly SessionSpec[],
  terms: ReadonlyMap<string, PlannedReview['terms']>,
): ReviewPlanInputs {
  if (specs.length > MAX_REVIEW_UNITS)
    reviewFail('sentinel.review.planLimit', String(specs.length) + ' requested, maximum ' + MAX_REVIEW_UNITS);
  if (given.kind !== 'analysis' || given.units.some((u) => u.review)) return bad();
  const plan = structuredClone(given),
    artifacts = new Map<ArtifactId, InstructionArtifact>();
  const put = (value: unknown, schema: string, links: readonly ArtifactId[]) => {
    const bytes = canonicalJsonBytes(value),
      id = digest(value);
    if (bytes.length > 4194304) return bad();
    artifacts.set(id, { id, bytes, schema, links });
    return id;
  };
  for (const s of specs) {
    if (
      !s.instructions ||
      !s.segmentId ||
      !s.requestedSelection ||
      s.runId !== plan.runId ||
      s.scope.snapshotId !== plan.pins.snapshotId
    )
      return bad();
    const manifest = instructionManifest(s.instructions);
    for (const a of instructionArtifacts(s.instructions)) artifacts.set(a.id, a);
    const instructions = put(manifest, manifest.schema, [
        manifest.prompt.content,
        manifest.assembled.content,
        ...manifest.skills.flatMap((k) => [k.content, ...k.resources.map((r) => r.content)]),
      ]),
      sourcePacket = put(
        s.scope,
        'application/json',
        s.scope.files.map((f) => f.content as ArtifactId),
      );
    const { instructions: opaque, ...plain } = s;
    void opaque;
    const spec = put(
      { schema: 'sentinel-admitted-review/draft-1', spec: plain, instructions },
      'sentinel-admitted-review/draft-1',
      [instructions, sourcePacket],
    );
    const review: PlannedReview = {
        spec,
        specDigest: specDigest(s),
        instructions,
        instructionDigest: manifest.digest,
        sourcePacket,
        segmentId: s.segmentId,
        selection: { ...s.requestedSelection },
        terms: structuredClone(terms.get(s.requestedSelection.bindingDigest) ?? bad()),
      },
      stage = `review-${s.kind}` as const;
    const unit: PlanWork = {
      id: reviewUnitIdOf({
        runId: plan.runId,
        revision: plan.revision,
        stage,
        sourceId: s.scope.sourceId,
        segmentId: s.segmentId,
        specDigest: review.specDigest,
      }),
      revision: 1,
      stage,
      contract: `sentinel.stage.review.${s.kind}`,
      implementationDigest: s.adapterDigest,
      sourceId: s.scope.sourceId,
      adapterId: s.adapterId,
      dependencies: [
        ...plan.reused.map((r) => ({ ...r })),
        ...plan.units.filter((u) => !u.review).map((u) => ({ id: u.id, revision: u.revision })),
      ],
      inputFingerprint: review.specDigest,
      checks: [],
      scopes: [s.scope.sourceId],
      inputs: s.scope.files.map((f) => ({
        sourceId: s.scope.sourceId,
        relativePath: f.relativePath,
        content: f.content as ArtifactId,
      })),
      inputSetDigest: digest(
        s.scope.files.map((f) => ({ sourceId: s.scope.sourceId, relativePath: f.relativePath, content: f.content })),
      ),
      review,
    };
    if (plan.units.some((u) => u.id === unit.id)) return bad();
    plan.units.push(unit);
    if (!plan.pins.adapters.some((a) => a.adapterId === s.adapterId))
      plan.pins.adapters.push({ adapterId: s.adapterId, digest: s.adapterDigest });
  }
  plan.units.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  plan.pins.adapters.sort((a, b) => (a.adapterId < b.adapterId ? -1 : a.adapterId > b.adapterId ? 1 : 0));
  plan.tallies.units = plan.units.length;
  const { digest: old, ...body } = plan;
  void old;
  plan.digest = digest(body);
  const checked = validateEnvelope('plan', plan);
  if (!checked.ok)
    reviewFail(
      'sentinel.review.integrity',
      'closed review plan does not validate: ' +
        checked.errors
          .map((e) => e.path)
          .slice(0, 4)
          .join(','),
    );
  return { plan: snapshot(plan), artifacts: Object.freeze([...artifacts.values()]) };
}
export async function readReviewSpec(
  store: SentinelStore,
  unit: Readonly<PlanWork>,
  supplied?: ReadonlyMap<ArtifactId, InstructionArtifact>,
): Promise<SessionSpec> {
  store.assertHeld();
  const r = unit.review;
  if (!r) return bad();
  let total = 0;
  const seen = new Set<ArtifactId>();
  const read = async (id: ArtifactId) => {
    const item = supplied?.get(id);
    if (item && item.bytes.byteLength > 4194304) return bad();
    const bytes = item ? Buffer.from(item.bytes) : await store.readArtifact(id);
    store.assertHeld();
    if (
      bytes.length > 4194304 ||
      (!seen.has(id) && (total += bytes.length) > 8388608) ||
      `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== id
    )
      return bad();
    seen.add(id);
    return bytes;
  };
  const json = async (id: ArtifactId) => {
    try {
      return JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(await read(id)));
    } catch {
      return bad();
    }
  };
  const payload = await json(r.spec),
    manifest = await json(r.instructions);
  if (!payload || typeof payload !== 'object' || !payload.spec || !validateEnvelope('instructions', manifest).ok)
    return bad();
  if (
    payload.schema !== 'sentinel-admitted-review/draft-1' ||
    payload.instructions !== r.instructions ||
    manifest.digest !== r.instructionDigest
  )
    return bad();
  const text = async (c: any) => {
    const bytes = await read(c.content);
    if (bytes.length !== c.bytes || c.digest !== c.content) return bad();
    return new TextDecoder('utf8', { fatal: true }).decode(bytes);
  };
  const prompt = { id: manifest.prompt.id, version: manifest.prompt.revision, text: await text(manifest.prompt) },
    skills = [];
  for (const s of manifest.skills) {
    const resources = [];
    for (const x of s.resources) resources.push({ id: x.id, revision: x.revision, text: await text(x) });
    skills.push({ id: s.id, revision: s.revision, text: await text(s), resources });
  }
  const instructions = prepareInstructions({ prompt, skills });
  if (digest(instructionManifest(instructions)) !== r.instructions) return bad();
  const spec = { ...payload.spec, instructions } as SessionSpec;
  if (
    spec.segmentId !== r.segmentId ||
    spec.kind !== unit.stage.slice(7) ||
    spec.adapterId !== unit.adapterId ||
    spec.adapterDigest !== unit.implementationDigest ||
    spec.scope.sourceId !== unit.sourceId ||
    specDigest(spec) !== r.specDigest ||
    digest(spec.scope) !== r.sourcePacket ||
    digest(spec.requestedSelection) !== digest(r.selection) ||
    digest(
      spec.scope.files.map((f) => ({
        sourceId: spec.scope.sourceId,
        relativePath: f.relativePath,
        content: f.content,
      })),
    ) !== unit.inputSetDigest
  )
    return bad();
  if (
    digest(spec.prompt) !== digest(prompt) ||
    digest(await json(r.sourcePacket)) !== r.sourcePacket ||
    digest(spec.scope) !== r.sourcePacket
  )
    return bad();
  await read(manifest.assembled.content);
  return spec;
}
/** Full admission recheck, including genuine current policy and same captured source; called before any plan writes. */
export async function verifyReviewInputs(
  store: SentinelStore,
  plan: PlanEnvelope,
  policy: EffectivePolicy,
  artifacts: readonly InstructionArtifact[],
): Promise<void> {
  const units = plan.units.filter((u) => u.review);
  if (units.length > MAX_REVIEW_UNITS || artifacts.length > MAX_REVIEW_UNITS * 54) return bad();
  let bytes = 0;
  const supplied = new Map<ArtifactId, InstructionArtifact>();
  for (const a of artifacts) {
    if (!a || a.bytes.byteLength > 4194304 || (bytes += a.bytes.byteLength) > 16777216) return bad();
    if (supplied.has(a.id)) return bad();
    supplied.set(a.id, a);
  }
  const captured = plan.pins.snapshotId && store.ledger.getSnapshot(plan.pins.snapshotId);
  if (!captured && units.length) return bad();
  const capture = captured
    ? (await (await import('../snapshot/materialize.js')).openSnapshot(store, plan.pins.snapshotId!)).snapshot
    : null;
  const specs: SessionSpec[] = [],
    terms = new Map<string, PlannedReview['terms']>();
  for (const unit of units) {
    const spec = await readReviewSpec(store, unit, supplied);
    specs.push(spec);
    const resolved = resolveReviewModel(policy, spec.kind, spec.segmentId!);
    terms.set(resolved.selection.bindingDigest, {
      disclosure: resolved.binding.disclosure,
      budget: policy.settings.providers.find((p) => p.id === resolved.selection.providerId)!.budget,
    });
    if (
      spec.runId !== plan.runId ||
      spec.scope.snapshotId !== plan.pins.snapshotId ||
      resolved.selection.bindingDigest !== unit.review!.selection.bindingDigest
    )
      return bad();
    for (const f of spec.scope.files)
      if (
        !capture!.entries.some(
          (e: any) =>
            e.kind === 'file' &&
            e.disposition === 'included' &&
            e.sourceId === unit.sourceId &&
            e.relativePath === f.relativePath &&
            e.content === f.content &&
            e.bytes === f.bytes,
        )
      )
        return bad();
  }
  const skeleton = {
    ...plan,
    units: plan.units.filter((u) => !u.review),
    pins: { ...plan.pins, adapters: plan.pins.adapters.filter((a) => !units.some((u) => u.adapterId === a.adapterId)) },
  };
  const expected = withReviewUnits(skeleton, specs, terms);
  if (digest(expected.plan) !== digest(plan) || expected.artifacts.length !== artifacts.length) return bad();
  for (const a of expected.artifacts) {
    const actual = supplied.get(a.id);
    if (
      !actual ||
      actual.schema !== a.schema ||
      digest(actual.links) !== digest(a.links) ||
      !Buffer.from(actual.bytes).equals(Buffer.from(a.bytes))
    )
      return bad();
  }
  store.assertHeld();
}

/**
 * The review units' sealed model inputs as seeds for the planner, without touching any plan (Sentinel v2 P-3): the
 * same specs `service/review-adapter.ts reviewsFor` builds from the accepted inventory and the planned checks of a
 * deterministic revision, under the adopted selection, each with its admitted-review, instruction and source-packet
 * artifacts. The planner places each seed under the agent stage declaring its fan-out and seals the revision once;
 * `withReviewUnits` stays for admission's re-derivation until it is retired.
 */
export function reviewSeedsFor(
  plan: PlanEnvelope,
  evidence: Pick<import('../execution/bootstrap.js').BootstrapEvidence, 'snapshot'>,
  policy: EffectivePolicy,
  registry: import('../execution/registry.js').AdapterRegistry,
  packs: readonly import('../rules/pack.js').ValidatedPack[] = [],
): { seeds: import('../planner/pipeline.js').AgentUnitSeed[]; artifacts: readonly InstructionArtifact[] } {
  const configured = policy.settings.reviewModels;
  if (!configured) return { seeds: [], artifacts: [] };
  const limits = { maxSliceLines: 200, maxSliceBytes: 65536, maxToolCalls: 20, maxServedBytes: 262144 },
    budget = { maxSteps: 12, maxInvalidReplies: 2, maxInputBytes: 4194304, maxOutputTokens: 512, deadlineMs: 120000 };
  const specs: SessionSpec[] = [],
    terms = new Map<string, PlannedReview['terms']>();
  const enabled = (kind: 'guided' | 'general', segment: string) =>
    configured.stages.some((s) => s.stage === kind) ||
    configured.segments.some((s) => s.stage === kind && s.segmentId === segment);
  const finish = (s: SessionSpec, segmentId: string) => {
    if (!enabled(s.kind, segmentId)) return;
    if (specs.length >= MAX_REVIEW_UNITS) reviewFail('sentinel.review.planLimit', 'more than 32 requested, maximum 32');
    const resolved = resolveReviewModel(policy, s.kind, segmentId),
      adapter = registry.get(s.adapterId);
    terms.set(resolved.selection.bindingDigest, {
      disclosure: resolved.binding.disclosure,
      budget: policy.settings.providers.find((p) => p.id === resolved.selection.providerId)!.budget,
    });
    specs.push({
      ...s,
      budget: {
        ...s.budget,
        ...cliKind(resolved.binding.kind)?.sessionBudget,
        maxOutputTokens: Math.min(s.budget.maxOutputTokens, resolved.binding.limits.maxOutputTokens),
      },
      adapterDigest: adapter.digest,
      instructions: prepareInstructions({ prompt: s.prompt, skills: [] }),
      segmentId,
      requestedSelection: resolved.selection,
    });
  };
  for (const check of plan.checks) {
    if (check.state !== 'planned') continue;
    const unit = plan.units.find((u) => u.id === check.unit?.id && u.revision === check.unit.revision);
    if (!unit) continue;
    const files = unit.inputs
        .map((i) =>
          evidence.snapshot.entries.find(
            (e) =>
              e.kind === 'file' &&
              e.disposition === 'included' &&
              e.sourceId === i.sourceId &&
              e.relativePath === i.relativePath &&
              e.content === i.content,
          ),
        )
        .filter((e) => e?.kind === 'file' && e.disposition === 'included')
        .map((e) => {
          const f = e as Extract<typeof e, { kind: 'file'; disposition: 'included' }>;
          return { relativePath: f.relativePath, content: f.content, bytes: f.bytes };
        }),
      pin = plan.pins.rules.find((r) => r.familyId === check.familyId && r.revision === check.ruleRevision)!;
    finish(
      guidedSpec({
        runId: plan.runId,
        attemptId: 'pending-review',
        snapshotId: evidence.snapshot.id,
        sourceId: check.sourceId,
        check: {
          checkId: check.id,
          familyId: check.familyId,
          revisionDigest: pin.definitionDigest,
          ruleText: JSON.stringify(
            packs
              .flatMap((p) => p.manifest.rules)
              .find((r) => r.familyId === check.familyId && r.revision === check.ruleRevision) ?? {
              familyId: check.familyId,
              revision: check.ruleRevision,
              definitionDigest: pin.definitionDigest,
            },
          ),
          files,
        },
        limits,
        budget,
      }),
      'guided-' + check.id,
    );
  }
  for (const source of evidence.snapshot.sources) {
    const partitions = partitionInventory(evidence.snapshot, source.sourceId, { maxFiles: 100, maxBytes: 1048576 });
    for (const part of partitions.partitions)
      finish(
        generalSpec({
          runId: plan.runId,
          attemptId: 'pending-review',
          plan: partitions,
          partitionId: part.id,
          limits,
          budget,
        }),
        'general-' + part.id,
      );
  }
  // The same sealed bytes withReviewUnits stores for each spec: the instruction manifest, the source packet and the
  // admitted-review record linking them.
  const artifacts = new Map<ArtifactId, InstructionArtifact>();
  const put = (value: unknown, schema: string, links: readonly ArtifactId[]) => {
    const bytes = canonicalJsonBytes(value),
      id = digest(value);
    if (bytes.length > 4194304) return bad();
    artifacts.set(id, { id, bytes, schema, links });
    return id;
  };
  const seeds = specs.map((s) => {
    if (!s.instructions || !s.segmentId || !s.requestedSelection || s.scope.snapshotId !== plan.pins.snapshotId)
      return bad();
    const manifest = instructionManifest(s.instructions);
    for (const a of instructionArtifacts(s.instructions)) artifacts.set(a.id, a);
    const instructions = put(manifest, manifest.schema, [
        manifest.prompt.content,
        manifest.assembled.content,
        ...manifest.skills.flatMap((k) => [k.content, ...k.resources.map((r) => r.content)]),
      ]),
      sourcePacket = put(
        s.scope,
        'application/json',
        s.scope.files.map((f) => f.content as ArtifactId),
      );
    const { instructions: opaque, ...plain } = s;
    void opaque;
    const spec = put(
      { schema: 'sentinel-admitted-review/draft-1', spec: plain, instructions },
      'sentinel-admitted-review/draft-1',
      [instructions, sourcePacket],
    );
    return {
      kind: s.kind,
      sourceId: s.scope.sourceId,
      segmentId: s.segmentId,
      adapterId: s.adapterId,
      adapterDigest: s.adapterDigest,
      review: {
        spec,
        specDigest: specDigest(s),
        instructions,
        instructionDigest: manifest.digest,
        sourcePacket,
        segmentId: s.segmentId,
        selection: { ...s.requestedSelection },
        terms: structuredClone(terms.get(s.requestedSelection.bindingDigest) ?? bad()),
      },
      inputs: s.scope.files.map((f) => ({
        sourceId: s.scope.sourceId,
        relativePath: f.relativePath,
        content: f.content as ArtifactId,
      })),
    };
  });
  return { seeds, artifacts: Object.freeze([...artifacts.values()]) };
}
