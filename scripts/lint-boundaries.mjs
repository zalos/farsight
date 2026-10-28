#!/usr/bin/env node
// Prints Sentinel's frozen layer debt: every import in packages/sentinel/src that points up a layer (the boundaries
// rule in eslint.config.mjs), with eslint-suppressions.json left out, so the sites `pnpm lint` keeps frozen are
// readable. It reports and exits 0; `pnpm lint` is the gate, and fails on a new upward import.
// Run: pnpm lint:boundaries
import { ESLint } from 'eslint';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const RULE = 'boundaries/dependencies';
// applySuppressions is off by default in the Node API: every site is reported, frozen or not.
const eslint = new ESLint({ cwd: root, cache: false, ruleFilter: ({ ruleId }) => ruleId === RULE });
const results = await eslint.lintFiles(['packages/sentinel/src']);
const formatter = await eslint.loadFormatter('stylish');
process.stdout.write(await formatter.format(results));
const pairs = new Map();
for (const r of results)
  for (const m of r.messages) {
    const pair = /^sentinel layers: (\S+ → \S+) points up/.exec(m.message)?.[1];
    if (pair) pairs.set(pair, (pairs.get(pair) ?? 0) + 1);
  }
const sites = [...pairs.values()].reduce((a, b) => a + b, 0);
process.stdout.write(
  `\n${sites} upward imports over ${pairs.size} folder pairs (frozen in eslint-suppressions.json):\n`,
);
for (const [pair, n] of [...pairs].sort()) process.stdout.write(`  ${String(n).padStart(3)}  ${pair}\n`);
