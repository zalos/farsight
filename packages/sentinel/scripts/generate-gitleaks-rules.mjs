// Regenerates src/adapters/gitleaks/rules.ts from a Gitleaks release's own default configuration (the
// config/gitleaks.toml at the pinned tag, which the binary embeds). Owner-run when the pin changes; reads one local
// file and writes one source file, fetches nothing:  node scripts/generate-gitleaks-rules.mjs <gitleaks.toml> <tag> <commit>
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const [file, tag, commit] = process.argv.slice(2);
if (!file || !/^v\d+\.\d+\.\d+$/.test(tag ?? '') || !/^[0-9a-f]{40}$/.test(commit ?? '')) {
  console.error('usage: node scripts/generate-gitleaks-rules.mjs <gitleaks.toml> <tag> <commit>');
  process.exit(2);
}
const toml = readFileSync(file, 'utf8');
const sha = createHash('sha256').update(toml).digest('hex');
const lines = toml.split('\n');
const ids = lines.filter((l) => /^id = "/.test(l)).map((l) => /^id = "([a-z0-9][a-z0-9-]*)"$/.exec(l)?.[1] ?? (() => { throw new Error(`rule id: ${l}`); })());
if (new Set(ids).size !== ids.length) throw new Error('duplicate rule id');
const a = lines.indexOf('[allowlist]');
const p0 = lines.findIndex((l, i) => i > a && l === 'paths = [');
const p1 = lines.findIndex((l, i) => i > p0 && l === ']');
const firstRule = lines.indexOf('[[rules]]');
if (!(a >= 0 && a < p0 && p1 < firstRule)) throw new Error('unexpected layout: the global allowlist paths must precede the rules');
const paths = lines.slice(p0 + 1, p1).map((l) => { const m = /^\s*'''(.*)''',?$/.exec(l); if (!m) throw new Error(`path: ${l}`); return m[1]; });
const regexes = paths.map((p) => {
  const ci = p.startsWith('(?i)');
  const src = ci ? p.slice(4) : p;
  if (/\(\?[a-zA-Z]|\\[pPQEzA]|\[\[:/.test(src)) throw new Error(`not a plain RE2/JavaScript subset: ${p}`);
  new RegExp(src, ci ? 'i' : '');
  // `u` always: RE2 matches code points, and its (?i) folds by Unicode simple case folding (s ~ U+017F, k ~ U+212A),
  // which JavaScript does only in Unicode mode; without it `i` folds ASCII only and misses paths the engine skips.
  return { src, flags: ci ? 'iu' : 'u' };
});
const out = `// Generated from Gitleaks ${tag}'s own default configuration (config/gitleaks.toml at tag ${tag}, commit
// ${commit}; the file the binary embeds as its default rules) by scripts/generate-gitleaks-rules.mjs.
// Regenerate with a new pin; never edit by hand.
//
// - GITLEAKS_RULE_IDS: every rule the pinned default configuration defines. A report line naming anything else is
//   refused, so no field of a report can carry text other than a known detector name.
// - GITLEAKS_GLOBAL_ALLOWLIST_PATHS: the default configuration's global path allowlist. Gitleaks skips a matching
//   file silently; Sentinel lists each one as a skipped scope instead (\`sentinel.secrets.toolAllowlisted\`). The
//   patterns are RE2 in the original; each is a plain subset that JavaScript reads the same way in Unicode mode (\`u\`
//   on every pattern; a leading \`(?i)\` becomes \`iu\`, Unicode simple case folding as RE2 does, so \`ſ\` matches \`s\` and
//   the Kelvin sign \`k\`), matched against each path the engine walks (\`scan/tree/<folder>…\`, \`scan/tree/<path>\`).

/** SHA-256 of the configuration file these lists were read from. */
export const GITLEAKS_DEFAULT_CONFIG_SHA256 = 'sha256:${sha}';

export const GITLEAKS_RULE_IDS: ReadonlySet<string> = new Set([
${ids.map((i) => `  '${i}',`).join('\n')}
]);

export const GITLEAKS_GLOBAL_ALLOWLIST_PATHS: readonly RegExp[] = Object.freeze([
${regexes.map((r) => `  new RegExp(${JSON.stringify(r.src)}, '${r.flags}'),`).join('\n')}
]);
`;
writeFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'adapters', 'gitleaks', 'rules.ts'), out);
console.log(`rules.ts: ${ids.length} rules, ${regexes.length} allowlisted path patterns, from ${tag} (sha256:${sha})`);
