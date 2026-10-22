// A stand-in for the Gitleaks binary, for the adapter tests that run without the pinned image. It emulates the
// documented behaviour the adapter depends on, and deliberately misbehaves in the ways the adapter must survive:
// - reads `<source>/.gitleaksignore` and the `--gitleaks-ignore-path` folder's `.gitleaksignore`, and honours
//   `gitleaks:allow` comments unless `--ignore-gitleaks-allow` is given, exactly where Gitleaks does;
// - writes a report that keeps the raw `Secret`, `Match` and `Line` (as if redaction were off), so the test proves
//   the worker drops them rather than relying on the tool;
// - the failure behaviours quote the matched value on stderr, as a real error message can.
// The only detector is the synthetic token shape the tests assemble at run time; no value is stored in this file.
import { readFileSync, readdirSync, statSync, writeFileSync, writeSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const [behaviour, command, source, ...rest] = process.argv.slice(2);
const flag = name => { const i = rest.indexOf(name); return i < 0 ? undefined : rest[i + 1]; };
const has = name => rest.includes(name);
const TOKEN = /ghp_[A-Za-z0-9]{36}/;
const PINNED = 'title = "sentinel-gitleaks-pinned"\n\n[extend]\nuseDefault = true\n';

// The adapter's fixed arguments: refuse to run if any control is missing, so a regression fails loudly.
if (command !== 'dir' || readFileSync(flag('--config'), 'utf8') !== PINNED || !has('--ignore-gitleaks-allow')
  || !has('--redact=100') || flag('--report-format') !== 'json' || flag('--exit-code') !== '2' || has('--baseline-path')) {
  process.stderr.write('fake-gitleaks: unexpected arguments\n');
  process.exit(64);
}

const ignored = new Set();
for (const file of [join(source, '.gitleaksignore'), join(flag('--gitleaks-ignore-path'), '.gitleaksignore')]) {
  if (existsSync(file)) for (const line of readFileSync(file, 'utf8').split('\n')) if (line.trim()) ignored.add(line.trim());
}
const findings = [];
let firstValue = '';
const walk = dir => {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) { walk(path); continue; }
    readFileSync(path, 'utf8').split('\n').forEach((line, i) => {
      const m = TOKEN.exec(line);
      if (!m) return;
      if (line.includes('gitleaks:allow') && !has('--ignore-gitleaks-allow')) return;
      const fingerprint = `${path}:github-pat:${i + 1}`;
      if (ignored.has(fingerprint)) return;
      firstValue ||= m[0];
      findings.push({ RuleID: 'github-pat', Description: `GitHub token ${m[0]}`, File: path, StartLine: i + 1, EndLine: i + 1,
        StartColumn: m.index + 1, EndColumn: m.index + m[0].length, Secret: m[0], Match: m[0], Line: line, Fingerprint: fingerprint,
        Entropy: 4.2, Tags: [], Commit: '', Author: '', Email: '', Date: '', Message: '' });
    });
  }
};
walk(source);
const report = flag('--report-path');
switch (behaviour) {
  case 'normal': writeFileSync(report, JSON.stringify(findings)); process.exit(findings.length ? 2 : 0);
  case 'crash': process.stderr.write(`fatal: could not handle ${firstValue}\n`); process.stdout.write(`${firstValue}\n`); process.exit(1);
  case 'malformed': writeFileSync(report, `[{"RuleID": "github-pat", "Secret": "${firstValue}"`); process.exit(2);
  case 'no-report': process.exit(0);
  case 'lie-clean': writeFileSync(report, JSON.stringify(findings)); process.exit(0);
  case 'unknown-file': writeFileSync(report, JSON.stringify(findings.map(f => ({ ...f, File: '/etc/passwd' })))); process.exit(2);
  case 'bad-line': writeFileSync(report, JSON.stringify(findings.map(f => ({ ...f, StartLine: 9999, EndLine: 9999 })))); process.exit(2);
  case 'rule-text': writeFileSync(report, JSON.stringify(findings.map(f => ({ ...f, RuleID: `github-pat ${firstValue}` })))); process.exit(2);
  // Synchronous writes: the worker must stop the tool part-way, not merely see a short exit.
  case 'flood': writeFileSync(report, JSON.stringify(findings)); for (let i = 0; i < 4096; i++) writeSync(2, `${firstValue}\n`.repeat(1000)); process.exit(2);
  default: process.exit(70);
}
