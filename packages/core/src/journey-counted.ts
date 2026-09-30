/**
 * The journey's numbers as typed counts (core/counts.ts, docs/COUNTS.md).
 *
 * `journeySummary()` calls `withJourneyCounted()` last, the same one-line tail
 * the coverage fold uses. Nothing here recounts anything the fold already
 * counted: every `Counted` is read off `summary.counts`, a segment's `counts`,
 * or the lists they were computed from — and the core tests pin each pair.
 *
 * The decisions this file encodes (the pass swarm of 2026-09-25 found each one
 * printing two numbers for what read as one concept):
 *
 * - **actions vs stops.** `actions` (13 on the reference app's POC flow) is what a person
 *   can do, each operation once; `actionStops` (31) is every column of the
 *   drill's rail — each call the code makes *each time* it makes it, each call
 *   only declared, and each screen with nothing to call. Two concepts, two
 *   names, and the breakdown of the second contains the first.
 * - **not in plain language** is one number in every register (118 on the POC
 *   flow): the technical conditions (90) plus the conditions on a gate nobody
 *   labelled (28). The hybrid lens used to print 90 and the business lens 118.
 * - **gates** counts gates *and* validation rules (34), named so.
 * - **in words** counts the lines the business lane's *In words* view draws:
 *   one per screen (its sentence, or its name) plus each decision in words.
 */
import type { Journey, JourneySummary, JourneySegment } from './query.js';
import { counted, type Counted } from './counts.js';

/** The journey header's numbers and their siblings, each with its scope. */
export interface JourneyCounted {
  screens: Counted;
  built: Counted;
  /** code lens only (no `bizUnit`): the walk's own unit */
  steps: Counted;
  planned: Counted;
  gates: Counted;
  checks: Counted;
  decisions: Counted;
  notInWords: Counted;
  inWords: Counted;
  actions: Counted;
  again: Counted;
  declaredNotCalled: Counted;
  actionStops: Counted;
  systems: Counted;
  setup: Counted;
  deferred: Counted;
  repeats: Counted;
  cutPoints: Counted;
  choices: Counted;
}

/** One screen's numbers — the same concepts, scoped to the screen. */
export interface SegmentCounted {
  actionStops: Counted;
  actions: Counted;
  gates: Counted;
  checks: Counted;
  decisions: Counted;
  notInWords: Counted;
  inWords: Counted;
}

const SRC = 'journeySummary()';

/** How the stops of a list of moments split: calls made, calls only declared, screens with nothing to call. */
function stopSplit(j: Journey, moments: JourneySegment['moments']): { called: number; declared: number; noCall: number; ops: Set<string> } {
  const stepAt = new Map(j.steps.map((st) => [st.order, st] as const));
  let called = 0, declared = 0, noCall = 0;
  const ops = new Set<string>();
  for (const mo of moments) {
    if (mo.callStep == null) { noCall++; continue; }
    const st = stepAt.get(mo.callStep);
    if (st?.via === 'planned') { declared++; continue; }
    called++;
    if (st) ops.add(st.nodeId);
  }
  return { called, declared, noCall, ops };
}

/** The lines the *In words* view draws for one segment: its sentence (authored or the name) and its decisions in words. */
function wordLines(sg: JourneySegment, entryBusiness: string | undefined): { sentences: number; names: number; decisions: number } {
  const scr = sg.screen;
  const sentences = scr ? (scr.business ? 1 : 0) : (entryBusiness ? 1 : 0);
  const names = scr && !scr.business && scr.name ? 1 : 0;
  return { sentences, names, decisions: sg.decisions.filter((d) => d.class === 'business').length };
}

function inWordsCounted(lines: { sentences: number; names: number; decisions: number }, scope: 'journey.scopeAll' | 'journey.scopeHere', source: string): Counted {
  return counted(lines.sentences + lines.names + lines.decisions, 'count.unit.inWords', scope, source, {
    bizUnit: 'count.unit.inWords',
    breakdown: [
      { key: 'count.part.sentences', n: lines.sentences },
      { key: 'count.part.namesOnly', n: lines.names },
      { key: 'count.part.decisionsInWords', n: lines.decisions },
    ],
  });
}

function segmentCounted(j: Journey, sg: JourneySegment, entryBusiness: string | undefined): SegmentCounted {
  const here = 'journey.scopeHere' as const;
  const s = `${SRC}.segments[${sg.index}]`;
  const split = stopSplit(j, sg.moments);
  const guardDecisions = sg.decisions.filter((d) => d.class === 'guard').length;
  const guards = sg.gates.filter((g) => g.kind === 'guard').length;
  return {
    actionStops: counted(sg.moments.length, 'count.unit.actionStops', here, `${s}.moments.length`, {
      bizUnit: 'count.unit.actionStops',
      breakdown: [
        { key: 'count.part.stopsCalled', n: split.called },
        { key: 'count.part.stopsDeclared', n: split.declared },
        { key: 'count.part.stopsNoCall', n: split.noCall },
      ],
    }),
    actions: counted(split.ops.size, 'journey.countActions', here, `${s}.moments — distinct operations code calls`, { bizUnit: 'journey.biz.countActions' }),
    gates: counted(sg.counts.gates, 'journey.countGates', here, `${s}.counts.gates`, {
      bizUnit: 'journey.countGates',
      breakdown: [{ key: 'count.part.guards', n: guards }, { key: 'count.part.rules', n: sg.gates.length - guards }],
    }),
    checks: counted(sg.counts.checks, 'journey.countChecks', here, `${s}.counts.checks`, { bizUnit: 'journey.countChecks' }),
    decisions: counted(sg.counts.decisions, 'journey.countDecisions', here, `${s}.counts.decisions`, {
      bizUnit: 'journey.countDecisions',
      breakdown: [
        { key: 'count.part.decisionsInWords', n: sg.counts.decisions - guardDecisions },
        { key: 'count.part.gateConditions', n: guardDecisions },
      ],
    }),
    notInWords: counted(sg.untranslated + guardDecisions, 'count.unit.notInWords', here, `${s}.untranslated + guard-class decisions`, {
      bizUnit: 'journey.biz.untranslated',
      breakdown: [
        { key: 'journey.untranslated', n: sg.untranslated },
        { key: 'count.part.gateConditions', n: guardDecisions },
      ],
    }),
    inWords: inWordsCounted(wordLines(sg, entryBusiness), here, `${s}.screen + decisions`),
  };
}

/**
 * Every number the journey header, the lane's tabs and the drill print, typed.
 * `built` follows the header's rule: a screen with a design row is built when
 * the design reconciled it to code, one without is built when the walk found
 * its source.
 */
export function journeyCounted(j: Journey, summary: JourneySummary): JourneyCounted {
  const all = 'journey.scopeAll' as const;
  const k = summary.counts;
  const c = (field: keyof JourneySummary['counts']) => `${SRC}.counts.${field}`;
  const moments = summary.segments.flatMap((sg) => sg.moments);
  const split = stopSplit(j, moments);
  const built = summary.user.filter((u) => (u.designStatus ? u.designStatus === 'both' : !!u.loc)).length;
  const guardNames = new Set(summary.business.gates.map((g) => g.name)).size;
  const ruleNames = new Set(summary.business.rules.map((r) => r.name)).size;
  const guardDecisions = summary.business.untranslated.guardsUnlabelled;
  const technical = summary.business.untranslated.count;
  const lines = summary.segments.reduce((acc, sg) => {
    const w = wordLines(sg, summary.business.description);
    return { sentences: acc.sentences + w.sentences, names: acc.names + w.names, decisions: acc.decisions + w.decisions };
  }, { sentences: 0, names: 0, decisions: 0 });
  return {
    screens: counted(k.screens, 'journey.countScreens', all, c('screens'), { bizUnit: 'journey.biz.countScreens' }),
    built: counted(built, 'journey.countBuilt', all, `${SRC}.user — designStatus 'both', else a source location`, { of: summary.user.length, bizUnit: 'journey.biz.countBuilt' }),
    steps: counted(k.steps, 'journey.countSteps', all, c('steps')),
    planned: counted(k.planned, 'journey.plannedCount', all, c('planned')),
    gates: counted(k.gates, 'journey.countGates', all, c('gates'), {
      bizUnit: 'journey.countGates',
      breakdown: [{ key: 'count.part.guards', n: guardNames }, { key: 'count.part.rules', n: ruleNames }],
    }),
    checks: counted(k.checks, 'journey.countChecks', all, c('checks'), { bizUnit: 'journey.countChecks' }),
    decisions: counted(k.decisions, 'journey.countDecisions', all, c('decisions'), {
      bizUnit: 'journey.countDecisions',
      breakdown: [
        { key: 'count.part.decisionsInWords', n: k.decisions - guardDecisions },
        { key: 'count.part.gateConditions', n: guardDecisions },
      ],
    }),
    notInWords: counted(technical + guardDecisions, 'count.unit.notInWords', all, `${SRC}.business.untranslated.count + .guardsUnlabelled`, {
      bizUnit: 'journey.biz.untranslated',
      breakdown: [
        { key: 'journey.untranslated', n: technical },
        { key: 'count.part.gateConditions', n: guardDecisions },
      ],
    }),
    inWords: inWordsCounted(lines, all, `${SRC}.segments[].screen + business.decisions (class business)`),
    actions: counted(k.called, 'journey.countActions', all, c('called'), { bizUnit: 'journey.biz.countActions' }),
    again: counted(k.again, 'journey.countAgain', all, c('again'), { bizUnit: 'journey.countAgain' }),
    declaredNotCalled: counted(k.declaredNotCalled, 'journey.countDeclaredOnly', all, c('declaredNotCalled'), { bizUnit: 'journey.countDeclaredOnly' }),
    actionStops: counted(moments.length, 'count.unit.actionStops', all, `${SRC}.segments[].moments.length`, {
      bizUnit: 'count.unit.actionStops',
      breakdown: [
        { key: 'count.part.stopsCalled', n: split.called },
        { key: 'count.part.stopsDeclared', n: split.declared },
        { key: 'count.part.stopsNoCall', n: split.noCall },
      ],
    }),
    systems: counted(summary.systems.length, 'journey.countSystems', all, `${SRC}.systems.length`),
    setup: counted(k.setup, 'journey.countSetup', all, c('setup')),
    deferred: counted(k.deferred, 'journey.countAfterwards', all, c('deferred'), { bizUnit: 'journey.countAfterwards' }),
    repeats: counted(k.repeats, 'journey.countRepeats', all, c('repeats')),
    cutPoints: counted(k.cutPoints, 'journey.cutPoints', all, c('cutPoints')),
    choices: counted(k.choices, 'journey.countChoices', all, c('choices'), { bizUnit: 'journey.countChoices' }),
  };
}

// ── the absence words: one per fact, decided here once ───────────────────
//
// The story swarm (2026-09-25, finding 4) read *not involved* on the Timeline
// and *none indexed* on the Sheet for the same cell: each view chose its own
// word for an empty cell. The word is a property of the fact — this action,
// this layer — so it is decided here, once, and every view prints what this
// fold says (the viewer reads `segment.absent`, never its own rule).

/** The six absence words: a closed set. Each is the tail of a `journey.absent.*` key; adding a seventh is the failure mode. */
export const ABSENCE_WORDS = ['noneIndexed', 'notBuilt', 'notInvolved', 'notReached', 'notIndexed', 'notTranslated'] as const;
export type AbsenceWord = typeof ABSENCE_WORDS[number];

/** The layers every surface keeps in view even when the walk reached none — the drill's always-present rows, the storyboard's ledger. */
export const ABSENCE_KINDS = ['records', 'messages', 'external', 'afterwards'] as const;
export type AbsenceKind = typeof ABSENCE_KINDS[number];

/**
 * The absence word for one empty (action, layer) cell — the whole rule.
 *
 * - `noneIndexed` — the journey has **no system of this kind at all**: we
 *   looked through everything the walk reached and found nothing of it.
 * - `notReached` — the walk was **cut** inside this action on a system that
 *   comes before this one in request order: what lies past the cut was not
 *   walked, so nobody can say this layer takes no part.
 * - `notInvolved` — the journey has this layer, the walk ran to its end, and
 *   this action has nothing on it.
 *
 * A planned row is not a reason on its own: an action that never touches a
 * row of contract-only calls is *not involved* with it, and the planned calls
 * themselves are drawn where they are, as planned. `notBuilt`, `notIndexed`
 * and `notTranslated` are facts about a part, a history or a sentence, never
 * about an empty cell, so this rule never answers them.
 */
export function absenceWord(fact: { inJourney: boolean; cutBefore: boolean }): AbsenceWord {
  if (!fact.inJourney) return 'noneIndexed';
  return fact.cutBefore ? 'notReached' : 'notInvolved';
}

/** One screen's absences: every empty cell of every action, and every system the whole screen leaves empty. */
export interface SegmentAbsence {
  /** `moment.index` → system row key (or `user`, *what the user sees*) → the word, for each layer the action has nothing on */
  moments: Record<number, Record<string, AbsenceWord>>;
  /** `moment.index` → layer kind → the word, for each of `ABSENCE_KINDS` the action has nothing of */
  kinds: Record<number, Partial<Record<AbsenceKind, AbsenceWord>>>;
  /** system row key → the word, for each system this screen has nothing on in any action (the ladder's folded columns) */
  screen: Record<string, AbsenceWord>;
}

/** Every empty cell's word, on every segment, plus the kinds the whole journey has none of. */
export function journeyAbsence(summary: JourneySummary): { segments: SegmentAbsence[]; kinds: Partial<Record<AbsenceKind, AbsenceWord>> } {
  const rank = new Map(summary.systems.map((r, i) => [r.key, i] as const));
  const kindOf = new Map(summary.systems.map((r) => [r.key, r.kind] as const));
  const has = new Set(summary.systems.map((r) => r.kind));
  const journeyKinds: Partial<Record<AbsenceKind, AbsenceWord>> = {};
  for (const k of ABSENCE_KINDS) if (!has.has(k)) journeyKinds[k] = absenceWord({ inJourney: false, cutBefore: false });
  const segments = summary.segments.map((sg) => {
    const sysAt = new Map(sg.markers.map((mk) => [mk.stepOrder, mk.system] as const));
    // the earliest system, in request order, a cut in each action happened on
    const cutRank = new Map<number, number>();
    for (const c of sg.cutPoints) {
      const r = rank.get(sysAt.get(c.parentStep) ?? '') ?? 0;
      cutRank.set(c.moment, Math.min(cutRank.get(c.moment) ?? Infinity, r));
    }
    const screenCut = Math.min(Infinity, ...cutRank.values());
    const moments: SegmentAbsence['moments'] = {};
    const kinds: SegmentAbsence['kinds'] = {};
    const usedOnScreen = new Set(sg.markers.map((mk) => mk.system));
    for (const mo of sg.moments) {
      const used = new Set(sg.markers.filter((mk) => mk.moment === mo.index).map((mk) => mk.system));
      // the browser row is in use while the action's component is open, even with no marker of its own
      if (mo.component) for (const r of summary.systems) if (r.kind === 'repo' && r.side === 'ux') used.add(r.key);
      const cut = cutRank.get(mo.index) ?? Infinity;
      const cell: Record<string, AbsenceWord> = {};
      for (const r of summary.systems) {
        if (used.has(r.key)) continue;
        cell[r.key] = absenceWord({ inJourney: true, cutBefore: cut < (rank.get(r.key) ?? 0) });
      }
      // what the user sees: the action's component, else the screen itself
      if (!mo.component && !sg.screen) cell.user = absenceWord({ inJourney: true, cutBefore: false });
      moments[mo.index] = cell;
      const kc: Partial<Record<AbsenceKind, AbsenceWord>> = {};
      for (const k of ABSENCE_KINDS) {
        if (journeyKinds[k]) { kc[k] = journeyKinds[k]; continue; }
        if ([...used].some((key) => kindOf.get(key) === k)) continue;
        const first = Math.min(...summary.systems.filter((r) => r.kind === k).map((r) => rank.get(r.key) ?? 0));
        kc[k] = absenceWord({ inJourney: true, cutBefore: cut < first });
      }
      kinds[mo.index] = kc;
    }
    const screen: Record<string, AbsenceWord> = {};
    for (const r of summary.systems) {
      if (usedOnScreen.has(r.key)) continue;
      screen[r.key] = absenceWord({ inJourney: true, cutBefore: screenCut < (rank.get(r.key) ?? 0) });
    }
    return { moments, kinds, screen };
  });
  return { segments, kinds: journeyKinds };
}

/** `journeySummary()`'s tail: the typed counts beside the plain ones, on the journey and on every segment, and the absence word of every empty cell. */
export function withJourneyCounted(j: Journey, summary: JourneySummary): JourneySummary {
  summary.counted = journeyCounted(j, summary);
  for (const sg of summary.segments) sg.counted = segmentCounted(j, sg, summary.business.description);
  const absent = journeyAbsence(summary);
  summary.absentKinds = absent.kinds;
  summary.segments.forEach((sg, i) => { sg.absent = absent.segments[i]; });
  return summary;
}
