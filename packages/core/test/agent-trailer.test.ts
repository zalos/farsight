// Agent sessions on the commit spine (round 2026-10-10, proposal 9): a co-author trailer naming an AI assistant
// marks a commit as made with an agent, by the trailer's own name; a CI bot or a person does not; a session link is
// never read. The store keeps the name (an additive column) and the history fact counts it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentOfMessage, agentsCounted, historyFact, countedProblems, SnapshotDb } from '../dist/index.js';

test('the assistant a co-author trailer names, as the trailer wrote it', () => {
  assert.equal(agentOfMessage('feat: x\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'), 'Claude Opus 5.5');
  assert.equal(
    agentOfMessage('fix: y\n\nco-authored-by: Copilot <175728472+Copilot@users.noreply.github.com>'),
    'Copilot',
  );
  assert.equal(agentOfMessage('x\n\nCo-authored-by: <noreply@openai.com>'), 'Codex');
});

test('a person, a CI bot, no trailer and a session link are not an agent and never a name', () => {
  assert.equal(agentOfMessage('chore: y\n\nCo-Authored-By: Ada Okafor <ada@example.com>'), null);
  assert.equal(
    agentOfMessage(
      'chore(release): v1\n\nCo-authored-by: github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>',
    ),
    null,
  );
  assert.equal(agentOfMessage(''), null);
  assert.equal(agentOfMessage(undefined), null);
  const withLink = agentOfMessage(
    'x\n\nCo-Authored-By: Claude https://claude.ai/code/session_1 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_1',
  );
  assert.equal(withLink, 'Claude');
});

test('agentsCounted: n of m with a breakdown by name that sums, and a re-check', () => {
  const c = agentsCounted(5, 9, { 'Claude Fable 5.1': 3, 'Claude Opus 5.5': 2 });
  assert.equal(c.n, 5);
  assert.equal(c.of, 9);
  assert.deepEqual(
    c.breakdown!.map((p) => [p.label, p.n]),
    [
      ['Claude Fable 5.1', 3],
      ['Claude Opus 5.5', 2],
    ],
  );
  assert.equal(c.recheck!.cli, 'farsight history --agents');
  assert.deepEqual(countedProblems(c), []);
  // names that do not sum to n are not a breakdown
  assert.equal(agentsCounted(5, 9, { a: 1 }).breakdown, undefined);
});

test('the store keeps the agent in an additive column; the spine and the history fact count it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'farsight-agent-'));
  try {
    const db = new SnapshotDb(join(dir, 'farsight.db'));
    db.writeCommits('app', [
      { sha: 'a'.repeat(40), at: '2026-10-09T10:00:00.000Z', subject: 'feat: one', agent: 'Claude Fable 5.1' },
      { sha: 'b'.repeat(40), at: '2026-10-10T10:00:00.000Z', subject: 'fix: two' },
    ]);
    const spine = db.commitSpine('app');
    assert.equal(spine.commits, 2);
    assert.equal(spine.agents, 1);
    assert.deepEqual(db.agentCounts('app'), { 'Claude Fable 5.1': 1 });
    assert.equal(db.commitsByPrefix('aaaa')[0]!.agent, 'Claude Fable 5.1');
    assert.equal(db.commitsByPrefix('bbbb')[0]!.agent, undefined);
    assert.deepEqual(
      db.commitsSince('app', '2026-10-10T00:00:00.000Z').map((c) => c.subject),
      ['fix: two'],
    );
    const f = historyFact([spine], { byAgent: db.agentCounts('app') });
    assert.equal(f.agents!.n, 1);
    assert.equal(f.agents!.of, 2);
    db.close();
    // reopening an existing store keeps the column and its rows
    const again = new SnapshotDb(join(dir, 'farsight.db'));
    assert.equal(again.commitSpine('app').agents, 1);
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
