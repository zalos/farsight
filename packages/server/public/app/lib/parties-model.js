// lib/parties-model.js — the pure half of lib/parties.js (no DOM, no catalog): which off-platform cards the storyline's
// lanes draw, in which lane, and the party lanes and their counts. Imported by lib/map-lanes-model.js (node-tested).

/**
 * The off-platform cards for these stages: one per declared step of each stage's first read segment, in the
 * manifest's order. A step whose `party` the graph names goes in that party's lane (`pt:<party id>`), any other in
 * the stage's own lane; both at the stage's column. Pure.
 * @param {Array} stages  laneLayout's stages (each `{ key, lane, col, segs: [{ seg }] }`)
 * @returns {Array} new stage objects, `off: true`
 */
export function offPlatformStages(stages) {
  const out = [];
  const seen = new Set();
  for (const st of stages) {
    const seg = st.segs && st.segs[0] && st.segs[0].seg;
    for (const step of (seg && seg.offPlatform) || []) {
      const k = step.screen + '|' + step.id;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({
        key: 'o:' + k,
        off: true,
        decl: step,
        lane: step.party ? 'pt:' + step.party.id : st.lane,
        col: st.col,
        row: 0,
        flowId: st.flowId,
        journeyId: st.journeyId,
        journeyName: st.journeyName,
        screenIndex: st.screenIndex,
        screenId: st.screenId,
        designId: 'o:' + k,
        name: step.name,
        words: '',
        sub: '',
        state: 'off',
        read: true,
        segs: [],
        decisions: [],
        ...(st.branch ? { branch: st.branch } : {}),
        ...(st.step != null ? { step: st.step } : {}),
        of: st.key,
      });
    }
  }
  return out;
}

/** One lane per party an off-platform card names, in the order the cards first name them. Pure. */
export function partyLanes(offStages) {
  const lanes = [];
  for (const s of offStages) {
    const p = s.decl.party;
    if (!p || lanes.some((l) => l.party.id === p.id)) continue;
    lanes.push({
      id: 'party:' + p.name,
      ref: 'pt:' + p.id,
      kind: 'party',
      party: p,
      name: p.name,
      description: p.role || '',
      surface: '',
      declared: null,
    });
  }
  return lanes;
}

/** A party lane's count: the cards in it, over the storyline (or the journey). Pure. */
export function partyLaneCount(lane, stages, scope) {
  const n = stages.filter((s) => s.off && s.lane === lane.id).length;
  return {
    n,
    unit: 'party.lane.count',
    bizUnit: 'party.lane.count',
    scope,
    source: 'laneLayout ← /api/journey segments[].offPlatform (manifest steps[].by)',
  }; // str:ok a Counted's source: where the number was read
}

/** Who does it, in words: the party's name, else the team's `who`, else *a person · a partner · another system*. Pure. */
export function offWho(step) {
  return (step.party && step.party.name) || step.who || '';
}

/**
 * The cards done outside the code, as one count over the storyline (or the journey), split by who does them — the
 * same partition core `offPlatformCounted()` gives the journey answer. Pure.
 */
export function offPlatformCounted(offStages, scope) {
  const by = (k) => offStages.filter((s) => s.decl.by === k).length;
  return {
    n: offStages.length,
    unit: 'count.unit.offPlatform',
    bizUnit: 'count.unit.offPlatform',
    scope,
    source: 'laneLayout ← /api/journey segments[].offPlatform (manifest steps[].by)', // str:ok a Counted's source: where the number was read
    breakdown: [
      { key: 'count.part.offPlatformPerson', n: by('person') },
      { key: 'count.part.offPlatformPartner', n: by('partner') },
      { key: 'count.part.offPlatformExternal', n: by('external') },
    ],
  };
}
