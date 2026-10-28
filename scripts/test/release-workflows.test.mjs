// Static checks of the release workflows: publication can never skip a required acceptance gate. Every step is read
// from the workflow files as written (no YAML library: each step is the block under a `- name:` line), so a later
// edit that adds an override, reorders the acceptance after the tag, or makes it conditional fails here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (name) => readFileSync(resolve('.github/workflows', name), 'utf8');
/** The lines of a workflow that are code, not comments. */
const code = (text) =>
  text
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n');
const uses = (text, flag) => code(text).split(flag).length - 1;

/** The steps of a workflow, in order: { name, text } for each `- name:` block. */
function steps(text) {
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s+)- name: (.+)$/.exec(lines[i]);
    if (!m) continue;
    const indent = m[1].length;
    const body = [lines[i]];
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      const lead = /^(\s*)/.exec(l)[1].length;
      if (l.trim() && (lead < indent || (lead === indent && l.trimStart().startsWith('- ')))) break;
      body.push(l);
    }
    out.push({ name: m[2].trim(), text: body.join('\n') });
  }
  return out;
}
const find = (list, pattern) => {
  const i = list.findIndex((s) => pattern.test(s.name));
  assert.ok(i >= 0, `no step matching ${pattern}`);
  return i;
};

test('no workflow input, variable or secret can waive an acceptance gate', () => {
  for (const name of ['release.yml', 'publish.yml', 'verify-release.yml']) {
    const text = code(read(name));
    assert.doesNotMatch(
      text,
      /allow_pending|ALLOW_PENDING|require_complete|REQUIRE_COMPLETE|--require-complete|--diagnostic/,
      `${name} has a gate override`,
    );
    assert.doesNotMatch(text, /continue-on-error/, `${name} lets a step fail quietly`);
  }
});

test('publish: complete acceptance runs unconditionally before the tag, the Release, the upload and npm', () => {
  const list = steps(read('publish.yml'));
  const accept = find(list, /^Accept both tarballs/);
  const step = list[accept].text;
  assert.match(step, /node scripts\/npm-acceptance\.mjs/);
  assert.doesNotMatch(step, /--allow-pending/, 'publication never allows pending gates');
  assert.doesNotMatch(step, /^\s+if:/m, 'the acceptance is unconditional');
  for (const later of [
    /^Tag the release commit/,
    /^Create the GitHub Release/,
    /^Publish to npm/,
    /^Write the release manifest/,
  ]) {
    assert.ok(find(list, later) > accept, `${later} runs after the acceptance`);
  }
  assert.equal(uses(read('publish.yml'), '--allow-pending'), 0);
});

test('release: a real run needs complete acceptance before any branch or PR; only the non-publishing dry run may report pending', () => {
  const text = read('release.yml');
  const list = steps(text);
  const accept = find(list, /^Accept both tarballs/);
  const step = list[accept].text;
  assert.doesNotMatch(step, /^\s+if:/m, 'the acceptance is unconditional');
  // the one place pending gates are allowed: guarded by the dry run
  const allows = step.split('\n').filter((l) => l.includes('--allow-pending'));
  assert.deepEqual(
    allows.map((l) => l.trim()),
    ['if [ "$DRY_RUN" = "true" ]; then args+=(--allow-pending); fi'],
  );
  assert.equal(uses(text, '--allow-pending'), 1, '--allow-pending is used once, in the dry-run branch');
  for (const later of [/^Push the release branch/, /^Open the release PR/]) {
    const i = find(list, later);
    assert.ok(i > accept, `${later} runs after the acceptance`);
    assert.match(list[i].text, /if: \$\{\{ !inputs\.dry_run \}\}/, `${later} never runs in a dry run`);
  }
  assert.doesNotMatch(
    text,
    /git tag|gh release create|npm publish/,
    'the release workflow creates no tag, Release or package',
  );
});

test('verify-release always requires every gate, and publish calls it with nothing that could waive one', () => {
  const verify = read('verify-release.yml');
  const run = steps(verify)[find(steps(verify), /^Install and use the published release/)].text;
  assert.match(run, /node scripts\/verify-release\.mjs --tag "\$TAG"/);
  assert.doesNotMatch(run, /--diagnostic|--allow-pending/);
  // eslint-disable-next-line no-regex-spaces -- Match the workflow's exact two-space job indentation.
  const call = /\n  verify:\n([\s\S]*?)(?:\n\S|\n  \S|$)/.exec(read('publish.yml'))?.[1] ?? '';
  assert.match(call, /uses: \.\/\.github\/workflows\/verify-release\.yml/);
  assert.deepEqual(
    call.match(/^\s{6}\S+:/gm)?.map((s) => s.trim()),
    ['tag:'],
    'the call passes the tag and nothing else',
  );
});

test('the only development uses of --allow-pending publish nothing', () => {
  const ci = read('ci.yml');
  assert.equal(uses(ci, '--allow-pending'), 1);
  assert.doesNotMatch(ci, /gh release|npm publish|git tag /);
});
