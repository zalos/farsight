#!/usr/bin/env node
// lint-strings.mjs — the Grammar Book's enforcement gate (v3-build-plan P2.6, G7).
//
// Fails the build when:
//
//  RULE 1 — raw chrome prose. In CHROME_FILES (the shell + every new-surface
//    module), a string literal containing three or more prose words must come
//    from the catalog via t(...). Pragmatic detectable rule: a single- or
//    double-quoted literal matching three word tokens in a row
//    (/[A-Za-z][a-z’']* +[a-z][a-z’']* +[a-z]/) fails unless the same line
//    calls t( or carries a `str:ok` pragma comment with a reason.
//    Deliberately NOT covered (documented grandfathering, migrated by the
//    passes that rewrite them):
//      - lib/graph-render.js + surfaces/journeys.js + store.js — pre-split
//        viewer code; P4 (code map) and P5 (journeys v3) own their strings;
//      - sym.js — its SYMBOLS/STATUS/UTILITY tables are Grammar Book *content*
//        (form/mapping columns), the very data this lint validates against;
//      - viewer.html markup — static settings/dialog copy; markup is not
//        register-switchable until surfaces own it (P3+).
//
//  RULE 2 — missing keys: any t('key') referenced anywhere in app/ that the
//    catalog does not define.
//
//  RULE 3 — jargon budget: a surface module referencing more than
//    JARGON_BUDGET (5) distinct catalog keys whose registers differ
//    (hud !== professional) and which lack a `define` (undefined jargon).
//
//  RULE 5 — the business register's words: a catalog key under `journey.biz.*`
//    or `impact.biz.*` may not carry a developer's unit in either register —
//    step · cut · seam · beat · moment · truncated · helper · hop. The business
//    lens prints these keys and only these; the shared keys keep their words
//    for hybrid and code. `hop` joined the list with the impact words (B5.4):
//    a distance counted in edges is a developer's unit like the rest.
//    `count.*` joined with the typed counts (docs/COUNTS.md): a count's scope
//    and the parts of its breakdown are printed in every lens, business too.
//    (the clarity pass §3.1; a per-surface jargon budget of 0 is not
//    checkable with RULE 3 as written — this is the nearest thing that is.)
//
//  RULE 4 — sprite integrity: every symbol id referenced via sym('id') /
//    symWord('id', …) / href="#sym-id" in app/ or declared in sym.js's tables
//    must exist as <symbol id="sym-id"> in viewer.html's sprite; and every
//    sprite symbol must be reachable (referenced or declared) — a glyph the
//    book doesn't license cannot render, and the book carries no dead glyphs.
//
// Run: node scripts/lint-strings.mjs   (root: pnpm lint:strings)
// Requires @farsight/core to be built (reads the catalog from core/dist).

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pub = join(root, 'packages/server/public');
const appDir = join(pub, 'app');

const { STRINGS } = await import(join(root, 'packages/core/dist/strings.js')).catch((err) => {
  console.error('lint-strings: cannot load packages/core/dist/strings.js — run `pnpm build` first.');
  console.error(String(err.message || err));
  process.exit(2);
});

const CHROME_FILES = [
  'shell.js', 'strings.js', 'keymap.js', 'share.js', 'impact.js', 'provenance.js',
  'surfaces/portfolio.js', 'surfaces/codemap.js', 'surfaces/changes.js',
  'surfaces/stewardship.js', 'surfaces/journeys.js', 'surfaces/journey-drill.js', 'surfaces/apis.js',
  'surfaces/tests.js', 'surfaces/work.js', 'work-chips.js', 'stories.js', 'lib/tooltip.js',
];
// journeys.js: only its NEW surface chrome is expected to use t(); its legacy
// overlay strings are grandfathered line-by-line below.
const GRANDFATHERED = ['lib/graph-render.js', 'store.js', 'sym.js'];
const JARGON_BUDGET = 5;

const failures = [];

function walk(dir) {
  const out = [];
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}

const appFiles = walk(appDir);
const viewerHtml = readFileSync(join(pub, 'viewer.html'), 'utf8');

// ── RULE 1: raw prose literals in chrome files ──────────────────────────────
const PROSE = /[A-Za-z][a-z’']* +[a-z][a-z’']* +[a-z]/;
// legacy journey-overlay prose kept verbatim from viewer.js (pre-catalog);
// P5 rewrites the journeys surface and migrates these.
// 'Forks along this journey', 'No forks recorded along this journey' and
// 'Re-ingest with the latest parser' left this list when the drawer's chrome
// moved into the catalog (fix/biz-register-words) — the drawer is where the
// business register's "not written in plain language" sentence sends a reader,
// so it could not stay outside the book.
const LEGACY_JOURNEY_LINES = [
  'fork — click for arms',
  'flow ends here', 'no tracked steps', 'no tracked calls', 'may exit',
  'exits (return/throw)', 'end of tracked flow', 'continues below',
  'recursion — traversal stopped', 'already shown', 'code truncated',
  'Copy mock-state recipe', 'crosses into', 'async via', 'more — narrow the scope',
];

for (const file of appFiles) {
  const rel = relative(appDir, file);
  if (!CHROME_FILES.includes(rel)) continue;
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    const code = line.replace(/^\s*(\/\/|\*|\/\*\*?).*$/, ''); // skip comment lines
    if (!code.trim()) return;
    if (/\bt\(/.test(code) || /str:ok/.test(line)) return;
    if (rel === 'surfaces/journeys.js' && LEGACY_JOURNEY_LINES.some((s) => line.includes(s))) return;
    for (const m of code.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g)) {
      const lit = (m[1] ?? m[2]) || '';
      // strip html tags/attrs so class soup doesn't trip the prose matcher
      const text = lit.replace(/<[^>]*>/g, ' ').replace(/\b[\w-]+=\\?"[^"]*\\?"/g, ' ');
      if (PROSE.test(text)) {
        failures.push(`RULE1 ${rel}:${i + 1} raw prose literal outside t(): ${JSON.stringify(lit.slice(0, 60))}`);
      }
    }
  });
}

// ── RULE 2 + 3: key existence and per-surface jargon budget ────────────────
for (const file of appFiles) {
  const rel = relative(appDir, file);
  const src = readFileSync(file, 'utf8');
  const keys = new Set();
  for (const m of src.matchAll(/\bt\(\s*'([^']+)'/g)) keys.add(m[1]);
  for (const m of src.matchAll(/\bdef\(\s*'([^']+)'/g)) keys.add(m[1]);
  for (const m of src.matchAll(/\bsymWord\(\s*'[^']+'\s*,\s*'([^']+)'/g)) keys.add(m[1]);
  // keys referenced via table fields (sym.js: word: 'sym.step')
  for (const m of src.matchAll(/\bword:\s*'([^']+)'/g)) keys.add(m[1]);
  let undefinedJargon = 0;
  for (const k of keys) {
    // dynamic prefixes like t('nav.' + s) resolve at runtime; only whole literal keys checked
    if (k.endsWith('.') || !/^[\w.]+$/.test(k)) continue;
    const entry = STRINGS[k];
    if (!entry) {
      failures.push(`RULE2 ${rel}: t('${k}') has no catalog entry`);
      continue;
    }
    if (entry.hud !== entry.professional && !entry.define) undefinedJargon++;
  }
  if (undefinedJargon > JARGON_BUDGET) {
    failures.push(`RULE3 ${rel}: ${undefinedJargon} undefined jargon terms (budget ${JARGON_BUDGET}) — add define: to their catalog entries`);
  }
}

// ── RULE 4: sprite integrity ────────────────────────────────────────────────
const spriteIds = new Set([...viewerHtml.matchAll(/<symbol id="sym-([\w-]+)"/g)].map((m) => m[1]));
const referenced = new Set();
for (const file of appFiles) {
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(/\bsym(?:Word)?\(\s*'([\w-]+)'/g)) referenced.add(m[1]);
  for (const m of src.matchAll(/#sym-([\w-]+)/g)) referenced.add(m[1]);
  // sym.js's tables declare their drawn glyph explicitly (glyph: 'x'); ids are
  // NOT sprite ids by definition — HOTSPOT's id maps to the WARNING glyph.
  if (file.endsWith('sym.js')) {
    for (const m of src.matchAll(/\bglyph:\s*'([\w-]+)'/g)) referenced.add(m[1]);
  }
}
for (const m of viewerHtml.matchAll(/use href="#sym-([\w-]+)"/g)) referenced.add(m[1]);
// sym.js STATUS/UTILITY ids are sprite ids; SYMBOLS use glyph:. Ids collected above.
for (const id of referenced) {
  if (!spriteIds.has(id)) failures.push(`RULE4 symbol "${id}" referenced but missing from viewer.html sprite`);
}
for (const id of spriteIds) {
  if (!referenced.has(id)) failures.push(`RULE4 sprite symbol "${id}" is dead — nothing references it and sym.js's tables don't declare it`);
}

// ── RULE 5: no developer's unit in the business register ────────────────────
const BIZ_BANNED = /\b(steps?|cuts?|seams?|beats?|moments?|truncated|helpers?|hops?)\b/i;
const BIZ_PREFIXES = ['journey.biz.', 'impact.biz.', 'count.'];
for (const [key, entry] of Object.entries(STRINGS)) {
  if (!BIZ_PREFIXES.some((p) => key.startsWith(p))) continue;
  for (const register of ['hud', 'professional']) {
    const m = BIZ_BANNED.exec(entry[register] || '');
    if (m) failures.push(`RULE5 ${key} (${register}): "${m[0]}" is a developer's unit — the business register does not count in it`);
  }
}

// ── report ──────────────────────────────────────────────────────────────────
if (failures.length) {
  console.error(`lint-strings: ${failures.length} failure(s)`);
  for (const f of failures) console.error('  ' + f);
  process.exit(1);
}
console.log(`lint-strings: ok — ${Object.keys(STRINGS).length} catalog entries, ${spriteIds.size} sprite symbols, ${appFiles.length} modules checked`);
