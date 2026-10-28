// strings.js — t() over the two-register catalog served at /api/strings.
// The catalog itself lives in packages/core/src/strings.ts (one source of
// truth); this module only resolves keys against the current register and
// owns the register toggle + the print/export professional-register rule.

import { S, expose, humanize, esc, currentLens } from './store.js';

/**
 * Resolve a catalog key in the current register. sys.* / invariant entries
 * are register-independent by construction (the server enforces it). Unknown
 * keys and a missing catalog fail soft by returning the key itself.
 * @group Grammar
 */
export function t(key) {
  const e = S.STRINGS && S.STRINGS[key];
  if (!e) return key;
  if (e.invariant) return e.professional;
  return S.register === 'hud' ? e.hud : e.professional;
}

/**
 * First-use tooltip for a jargon term (the catalog's `define`), or '' —
 * rendered as a title attribute wherever the term first appears.
 * @group Grammar
 */
export function def(key) {
  const e = S.STRINGS && S.STRINGS[key];
  return (e && e.define) || '';
}

/** Callbacks re-run whenever the register flips (chrome + active surface). */
const registerListeners = [];
/** @group Grammar */
export function onRegisterChange(fn) {
  registerListeners.push(fn);
}

/**
 * Flip or set the register ('hud' | 'professional'), persist it, restyle the
 * chrome, and re-render every registered listener.
 * @group Grammar
 */
export function setRegister(r, opts) {
  S.register = r === 'hud' ? 'hud' : 'professional';
  if (!opts || !opts.transient) {
    try {
      localStorage.setItem('fs-register', S.register);
    } catch (err) {}
  }
  document.body.dataset.register = S.register;
  registerListeners.forEach((fn) => {
    try {
      fn();
    } catch (err) {}
  });
}

/** @group Grammar */
export function toggleRegister() {
  setRegister(S.register === 'hud' ? 'professional' : 'hud');
}

/**
 * Load the persisted register (default: professional — the words that are
 * safe to screenshot) and wire the print rule: print/export paths always
 * render the professional register, restored after printing.
 * @group Grammar
 */
export function initRegister() {
  let r = 'professional';
  try {
    r = localStorage.getItem('fs-register') || 'professional';
  } catch (err) {}
  setRegister(r, { transient: true });
  let printFlipped = false;
  window.addEventListener('beforeprint', () => {
    if (S.register === 'hud') {
      printFlipped = true;
      setRegister('professional', { transient: true });
    }
  });
  window.addEventListener('afterprint', () => {
    if (printFlipped) {
      printFlipped = false;
      setRegister('hud', { transient: true });
    }
  });
}

/**
 * One evidence word for one scope — the class a surface styles with and the
 * catalog key it prints. Four printers chose this for themselves (the journey
 * header, the journey's tests foot, the flow status table, the Tests tab) and
 * two of them did not know about run-level attribution, so one flow read
 * *verified by a run* on the front door and *seen by a coverage run* on the
 * Tests tab at the same sync (visual swarm 2026-09-24).
 *
 * The server's fold decides it (`coverage.evidenceWord`, `core/coverage.ts`),
 * and this only reads that answer: MCP, the CLI and every surface print one
 * word. The viewer's own copy of the rule is gone (docs/COUNTS.md §4) — it
 * still mapped a chip carried only by coverage reports to *verified · stale*,
 * which is how every screen card came to wear *verified* above `0 observed`
 * (pass swarm 2026-09-25). A scope the fold gave no word says so with the
 * absence word; it is never re-derived here.
 * @group Grammar
 */
export function evidenceWord(facts) {
  const f = facts || {};
  if (f.evidenceWord && f.evidenceWord.key) return f.evidenceWord;
  return { cls: 'none', key: 'journey.absent.noneIndexed' };
}

// ── plain words: what the business lens may print of a sentence somebody wrote ──
// A document reference: a design id, a backlog or decision record, a route of a
// design, a spec section. They are how the authors cross-reference each other,
// and they read as noise to anyone who is not one of them.
// An ADR number is not one of them: it is the citation key a reader quotes the
// decision by, so it stays in every register (swarm 2026-10-05, the business analyst).
// A one-letter id (`D6`, `G8`) is a plan's own numbering of its decisions and goals.
const DOC_REF =
  /\b(?:PBI\s?#?\d+|(?!ADR-)[A-Z]{2,5}-\d+(?:\.\d+)?[a-z]?|Route\s\d+[a-z]?|RFC\s?\d+|MVP|(?:[Dd]ecision\s+)?[A-Z]\d{1,2}[a-z]?)\b|§\s?\d+[a-z]?/;
const DOC_REF_G = new RegExp(DOC_REF.source, 'g');
// A piece of code in prose: a backticked span, a path, a URL path, a file name, an HTTP verb.
const CODE_BIT =
  /`[^`]*`|(?:^|[\s(])\/[\w{}:.-]+|\b[\w-]+\/[\w./-]*\w\.\w+|\b\w+\.(?:tsx?|jsx?|mjs|json|md|ya?ml)\b|\b(?:GET|POST|PUT|PATCH|DELETE)s?\b|=>|\w\(\)/;
const IDENT =
  /\b[a-z]+[A-Z][A-Za-z0-9]*\b|\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b|\b[a-z0-9]+(?:_[a-z0-9]+)+\b|\b[A-Z0-9]+(?:_[A-Z0-9]+)+\b/g;

/**
 * The words of a sentence somebody wrote, as the business lens may print them.
 *
 * The business register shows what a person wrote and never an identifier
 * (the 2026-09-25 pass-swarm review: *falsy*, `(PBI #352)`, `SCR-02`,
 * `/submit/verify?t=…`, `(plans/api.md §3e)` all reached a business reader).
 * So: a parenthesis that only cross-references a document or quotes code goes
 * whole; a sentence that still leans on a path, a backticked span or a
 * reference goes whole — half a sentence with its object cut out reads worse
 * than no sentence; and an identifier left in prose is said the way humanize()
 * says it. Returns `''` when nothing a person can read is left, so the caller
 * can say so with its absence word instead of printing the identifier.
 * @group Grammar
 */
export function plainWords(text) {
  let s = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return '';
  // a design id the sentence uses as a place (*on CON-03 with business info*) is a screen: its name, never a hole
  s = screenIdsAsNames(s);
  // a refusal message with a hole the code fills when it runs (*Vendor account is …, not ACTIVE*): said, not left open
  if (/…/.test(s) && !/…\s*$/.test(s)) s = filledMessage(s);
  // a backticked word is emphasis (`PAID`); a backticked path or expression is code
  s = s.replace(/`([A-Za-z][A-Za-z ]*)`/g, '$1');
  // references and code inside parentheses are asides: drop the aside, keep the sentence
  for (let i = 0; i < 3; i++) {
    s = s.replace(/\s*\(([^()]*)\)/g, (m, inner) =>
      DOC_REF.test(inner) || CODE_BIT.test(inner) || /\b[a-z]+[A-Z]/.test(inner) ? '' : m,
    );
  }
  // a reference left in the sentence is a label on something the sentence names anyway
  s = s.replace(DOC_REF_G, '').replace(/\s+—\s+(?=[—.,;])/g, ' ');
  // a sentence still carrying code goes whole: half a sentence with its object cut out reads worse than none
  const sentences = s.split(/(?<=[.!?])\s+(?=[A-Z0-9"“‘(])/);
  s = sentences
    .map((x) => {
      if (!CODE_BIT.test(x)) return x;
      // a trailing clause set off by a dash can go on its own; the sentence keeps what came before it
      const parts = x.split(/\s+—\s+/);
      const cut = parts.findIndex((c) => CODE_BIT.test(c));
      const keep = parts.slice(0, cut);
      return keep.length
        ? keep
            .join(' — ')
            .replace(/[,;:\s]+$/, '')
            .replace(/([^.!?])$/, '$1.')
        : '';
    })
    .filter(Boolean)
    .join(' ');
  s = s.replace(IDENT, (w) => humanize(w).toLowerCase());
  return s
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\(\s*\)/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+—\s*([.,;]|$)/g, '$1')
    .replace(/^[\s,;:—–-]+/, '')
    .trim();
}

// ── the business register's words for what the app wrote (outsider round 2026-10-13, F6) ──

/** Design ids → the screen's name, once per graph object. */
let SCREEN_NAMES = null;
let SCREEN_NAMES_OF = null;
function screenNames() {
  const g = S.GRAPH;
  if (SCREEN_NAMES && SCREEN_NAMES_OF === g) return SCREEN_NAMES;
  const m = new Map();
  for (const n of (g && g.nodes) || []) {
    const d = n.design;
    if (d && d.id && d.name && !m.has(d.id)) m.set(d.id, d.name);
  }
  SCREEN_NAMES = m;
  SCREEN_NAMES_OF = g;
  return m;
}
const SCREEN_ID = /\b([A-Z]{2,5}-\d+(?:\.\d+)?[a-z]?)(['’]s)?\b/g;
/**
 * A design id a sentence uses as a place — after *on*, *in*, *from*, *to*, *at*, *via* or as a possessive — reads as
 * the screen it names (`on CON-03 with` → *on Create your vendor account with*), else *a page*; an id that is only a
 * cross-reference is left to `plainWords()`, which drops it. A sentence never keeps a hole where the id stood.
 * @group Grammar
 */
export function screenIdsAsNames(text) {
  const names = screenNames();
  return String(text || '').replace(SCREEN_ID, (m, id, poss, at, whole) => {
    const before = whole.slice(0, at);
    const place = /\b(?:on|in|from|to|at|via|onto|into|and|or)\s+$/i.test(before) || !!poss;
    // a range or a list of ids (*CON-01 to CON-08*) is a cross-reference, not a place
    if (!place || /\(\s*$/.test(before) || /\b[A-Z]{2,5}-\d+\w*\s+(?:to|and|or)\s+$/.test(before)) return m;
    const name = names.get(id);
    return (name || t('plain.aPage')) + (poss || '');
  });
}

/**
 * A refusal message the code builds, as a reader may read it: a hole the parser could not fill (`…`, a value the code
 * only knows when it runs) says *(a value)*, and a status constant (`ACTIVE`) reads as a word. Hybrid and code keep
 * the message as the parser read it.
 * @group Grammar
 */
export function filledMessage(text) {
  const v = t('plain.aValue');
  return String(text || '')
    .replace(/\(\s*…\s*\)/g, v)
    .replace(/…/g, v)
    .replace(/\b[A-Z]{4,}(?:_[A-Z]+)*\b/g, (w) => (/^ADR/.test(w) ? w : w.replace(/_/g, ' ').toLowerCase()));
}

/**
 * What the code does when a check fails, in the lens's words: an HTTP refusal (`409 conflict`) is *the request is
 * refused* in business and *refused (409 conflict)* elsewhere; anything else is printed as written.
 * @group Grammar
 */
export function refusalWords(text, lens) {
  const s = String(text || '').trim();
  if (!/\b[45]\d\d\b/.test(s)) return s;
  return (lens || currentLens()) === 'business' ? t('plain.refused') : t('plain.refusedCode').replace('{code}', s);
}

/**
 * A gate or rule named by its code, as the business register may name it: a schema (`opsVendorAccountApproveSchema`)
 * is *the ops vendor account approve form's rules*; a precondition's code form (`fn: table.field = VALUE`) is
 * *table field must be value*; any other name is returned as it is (the caller's humanize applies).
 * @group Grammar
 */
export function schemaWords(name) {
  const s = String(name || '').trim();
  const words = (x) =>
    x
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[_-]+/g, ' ')
      .toLowerCase()
      .trim();
  const sm = /^([A-Za-z][A-Za-z0-9]*?)Schema$/.exec(s);
  if (sm) return t('plain.schema').replace('{name}', words(sm[1]));
  const pm = /^[\w.$]+:\s*(\w+)\.(\w+)\s*(?:=|∈)\s*\{?([^}]+)\}?$/.exec(s);
  if (pm)
    return t('plain.mustBe')
      .replace('{record}', words(pm[1]))
      .replace('{field}', words(pm[2]))
      .replace(
        '{value}',
        pm[3]
          .split(/\s*,\s*/)
          .map((x) => words(x))
          .join(' or '),
      );
  return s;
}

/**
 * A label somebody wrote, as plain text without its markdown: a backticked span
 * keeps its words and loses the two backticks, for a chip or a heading that is
 * escaped as text and has no room for a code face (swarm 2026-10-05, QA).
 * @group Grammar
 */
export function unTick(text) {
  return String(text || '').replace(/`([^`\n]+)`/g, '$1');
}
/**
 * A sentence somebody wrote, as HTML for the lens on screen. The business lens
 * reads `plainWords()`; hybrid and code keep every word and draw a backticked
 * span as code — the writer's markdown, not two raw backticks in the middle of
 * a sentence (swarm 2026-10-05, QA). Returns escaped HTML; `''` when nothing is
 * left to print.
 * @group Grammar
 */
export function proseHtml(text) {
  if (currentLens() === 'business') return esc(plainWords(text));
  return esc(String(text || '')).replace(/`([^`\n]+)`/g, '<code class="tick">$1</code>');
}

expose({ toggleRegister });
