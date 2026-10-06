// lib/gate-card-model.js — one gate, folded for its card (swarm-fixes round 2026-10-05, finding 4).
//
// A gate answers its click with one card, the same card on every surface that draws a gate: the journey's lists,
// the Sheet, the drill, the Map's property, the code map's badges. This module decides what the card says; the
// card (lib/gate-card.js) draws it. Pure: no DOM, no catalog, no fetch — words are catalog keys the card
// translates, and the facts come from two places:
//
//   - the page's own graph, by lookup only: the node (`ctx.byId`) and its own edges (`ctx.edgesOf`, store.js
//     `S.EDGES_OF`) — never a scan of the graph's edges, so opening a card costs the same on a 245k-node graph;
//   - the service's answer (`GET /api/gate?node=`, core `gateCard()`), for what the page cannot answer by lookup:
//     the calls a request goes through to meet the gate (a walk up the callers) and the tests that reach them.
//     Until it arrives the card says so; without it the card is still the gate's words, place and code.

/** How many calls and tests the card lists before *n more*. */
export const GATE_CARD_CAP = 8;

function edgesOf(ctx, id) {
  const e = ctx && ctx.edgesOf;
  if (!e || !id) return [];
  return (typeof e.get === 'function' ? e.get(id) : e[id]) || [];
}
function repoOf(n) {
  return (n && n.loc && n.loc.repo) || String((n && n.id) || '').split('::')[0];
}
/** `requireX: what somebody wrote` → its identifier and its words; a rule's name is its identifier alone. */
export function nameParts(name) {
  const raw = String(name || '');
  const i = raw.indexOf(': ');
  return i > 0 ? { ident: raw.slice(0, i), phrase: raw.slice(i + 2) } : { ident: '', phrase: raw };
}
function firstSentence(s) {
  const text = String(s || '').trim();
  if (!text) return '';
  const m = text.match(/^[\s\S]*?[.!?](?=\s|$)/);
  const out = (m ? m[0] : text).replace(/\s+/g, ' ').trim();
  return out.length > 280 ? out.slice(0, 277).replace(/\s+\S*$/, '') + '…' : out;
}

/**
 * What the page knows about a gate by lookup: the node, its kind, the words on it, where it is and what it sits on.
 * `hint.config` is a journey's own word that this gate is a config check (the step carries it); the service's
 * answer says it too. Null when the id is not a guard or a rule in the page's graph.
 */
export function gateFacts(id, ctx = {}, hint = {}) {
  const n = ctx.byId ? ctx.byId[id] : null;
  if (!n || (n.kind !== 'guard' && n.kind !== 'rule')) return null;
  const { ident, phrase } = nameParts(n.name);
  const sitsOn = [];
  const seen = new Set();
  for (const e of edgesOf(ctx, id)) {
    if (e.from !== id || (e.kind !== 'guards' && e.kind !== 'validates') || seen.has(e.to)) continue;
    seen.add(e.to);
    const t = ctx.byId[e.to];
    sitsOn.push(t ? { id: t.id, kind: t.kind, name: t.name, loc: t.loc || null } : { id: e.to, kind: 'unknown', name: e.to.split('::').pop(), loc: null });
  }
  const tags = n.tags || [];
  const business = String((n.facets && n.facets.business && n.facets.business.description) || '').trim();
  return {
    id, node: n,
    gateKind: n.kind === 'rule' ? 'rule' : 'guard',
    configCheck: !!(hint.config || tags.includes('config-check')),
    declared: tags.includes('declared'),
    ident, phrase,
    business,
    docs: firstSentence(n.docs),
    loc: n.loc || null,
    repo: repoOf(n),
    project: (n.project && n.project.name) || '',
    sitsOn,
  };
}

/**
 * The one sentence the card leads with, as catalog keys and their fillings:
 *
 * - somebody wrote what it allows (`@business`) → those words;
 * - else the requirement written after the colon of `@guard`, when it is words (`inWords`, the journey's own
 *   `jrnGateInWords()`, so the card and the lists agree on what counts as words) → *Lets a request through only
 *   when: …* (a rule: *The data has to match: …*);
 * - else *Nobody has written down what this allows*, and who should: in business, the team that owns the code;
 *   elsewhere, a business line above the function in its file, or the config file.
 *
 * A config check adds its own sentence: it checks how the app was started, not a request.
 */
export function gateSentence(f, inWords, lens, plain) {
  if (!f) return null;
  const biz = lens === 'business';
  // the business register prints only plain words: a sentence that is all code is no sentence there
  const bizWords = f.business && biz && plain ? plain(f.business) : f.business;
  let says;
  if (bizWords) says = { key: '', words: bizWords, source: 'business' };
  else if (inWords) says = { key: f.gateKind === 'rule' ? 'gate.says.rulePhrase' : 'gate.says.phrase', words: inWords, source: 'phrase' };
  else says = { key: 'gate.says.none', words: '', source: 'none' };
  let who = null;
  if (says.source === 'none') {
    who = biz
      ? (f.project ? { key: 'gate.who.biz', vars: { project: f.project } } : { key: 'gate.who.bizNoProject', vars: {} })
      : { key: 'gate.who.code', vars: { ident: f.ident || f.node.name, path: f.loc ? f.loc.path + ':' + f.loc.line : f.id } };
  }
  return {
    says, who,
    // the doc comment's first sentence, where it is not the sentence already said; never in business (it is the developer's)
    docs: !biz && f.docs && f.docs !== f.business ? f.docs : '',
    config: f.configCheck ? 'gate.config.sentence' : '',
  };
}

/**
 * The card's whole view: the facts by lookup, the sentence, and — once the service answered — the calls and the
 * tests with their typed counts, each list capped at `cap` (the count beside the heading counts them all).
 * `answer` is the `/api/gate` body, `null` while it is on its way, `false` when it could not be read.
 */
export function gateCardModel(id, ctx = {}, opts = {}) {
  const answer = opts.answer;
  const f = gateFacts(id, ctx, { config: opts.config || (answer && answer.gate && answer.gate.configCheck) });
  if (!f) return null;
  const cap = opts.cap || GATE_CARD_CAP;
  const lens = opts.lens || ctx.lens || 'hybrid';
  const kind = f.configCheck ? 'config' : f.gateKind;
  const out = {
    id, kind, gateKind: f.gateKind, declared: f.declared,
    facts: f,
    sentence: gateSentence(f, opts.inWords || '', lens, opts.plain),
    sitsOn: f.sitsOn,
    pending: answer == null,
    failed: answer === false,
    calls: null, pages: null, tests: null, counted: null, evidence: null, truncated: false,
  };
  if (answer && typeof answer === 'object') {
    const calls = answer.calls || [];
    const tests = answer.tests || [];
    out.calls = { rows: calls.slice(0, cap), more: Math.max(0, calls.length - cap), total: calls.length };
    out.pages = { rows: (answer.pages || []).slice(0, cap), more: Math.max(0, (answer.pages || []).length - cap), total: (answer.pages || []).length };
    out.tests = {
      rows: tests.slice(0, cap).map((t) => ({ ...t, onGate: t.reaches && t.reaches.nodeId === id })),
      more: Math.max(0, tests.length - cap), total: tests.length, onGate: answer.testsOnGate || 0,
    };
    out.counted = answer.counted || null;
    out.evidence = { chip: answer.chip, evidenceWord: answer.evidenceWord, ...(answer.verdict ? { verdict: answer.verdict } : {}) };
    out.truncated = !!answer.truncated;
  }
  return out;
}

/** The gate a clicked element names: `data-gate-card` on it or on the nearest element above it. */
export function gateIdOf(el) {
  const host = el && el.closest ? el.closest('[data-gate-card]') : null;
  return host ? host.getAttribute('data-gate-card') : null;
}
