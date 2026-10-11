// lib/scope-words.js — the short words a number prints beside it for the scope it counts over (*over this screen*),
// the viewer's copy of core `SCOPE_WORDS` (counts.ts) for numbers that arrive without a verdict to carry them — the
// *conditions not in plain language* counts on the journey head, a screen, an action and the drill's caption, which
// printed 10 / 27 / 96 / 136 with nothing saying over what (swarm round 3). Pure; held equal to core by
// test/scope-words.test.ts.

export const SCOPE_WORDS = {
  'journey.scopeAll': 'count.over.journey',
  'journey.scopeHere': 'count.over.screen',
  'count.scope.action': 'count.over.action',
  'count.scope.node': 'count.over.part',
  'count.scope.gate': 'count.over.gate',
  'count.scope.route': 'count.over.route',
  'count.scope.affected': 'count.over.affected',
  'count.scope.source': 'count.over.source',
  'count.scope.selection': 'count.over.selection',
  'count.scope.workspace': 'count.over.workspace',
};

/** The catalog key of a scope's chip words, else the scope key itself (its long words). */
export function scopeWordKey(scope) {
  return SCOPE_WORDS[scope] || scope || '';
}
