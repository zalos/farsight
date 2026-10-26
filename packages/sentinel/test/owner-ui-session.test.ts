import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OwnerUiSession } from '../dist/owner-ui/session.js';
const instance = 'host-' + 'a'.repeat(32),
  view = {
    frameNonce: 'frame-' + 'b'.repeat(32),
    documentId: 'document-' + 'c'.repeat(32),
    revision: 1,
    hostInstance: instance,
    mode: 'live',
    sync: null,
  };
test('bootstrap serves one code from one explicit launch; GET never renews or mints another', () => {
  const s = new OwnerUiSession(instance),
    code = s.bootstrap(),
    end = s.expiresAt;
  assert.match(code, /^[a-f0-9]{64}$/);
  assert.throws(() => s.bootstrap());
  const active = s.activate('launch', code, view);
  assert.equal(Date.parse(active.expiresAt), end);
  assert.throws(() => s.activate('launch', code, view));
  assert.equal(s.authenticate(active.capability).mode, 'live');
});
test('reload rotates capability/token absolutely; duplicated consumed reload token revokes the session', () => {
  const s = new OwnerUiSession(instance),
    first = s.activate('launch', s.bootstrap(), view),
    second = s.activate('reload', first.reloadToken, { ...view, frameNonce: 'frame-' + 'd'.repeat(32) });
  assert.throws(() => s.authenticate(first.capability));
  assert.equal(second.expiresAt, first.expiresAt);
  assert.equal(s.authenticate(second.capability).revision, 1);
  assert.throws(() => s.activate('reload', first.reloadToken, view));
  assert.throws(() => s.authenticate(second.capability));
});
test('context is closed, monotonic, document-bound and veto-only; navigation invalidates exact challenges', () => {
  const s = new OwnerUiSession(instance),
    a = s.activate('launch', s.bootstrap(), view),
    c = s.challenge(a.capability, 'prepare');
  s.update(a.capability, { ...view, revision: 2, mode: 'historical', sync: 1 });
  assert.throws(() => s.consume(a.capability, c.id, 'prepare', c.revision));
  assert.throws(() => s.challenge(a.capability, 'prepare'));
  s.update(a.capability, { ...view, revision: 3 });
  assert.throws(() => s.consume(a.capability, c.id, 'prepare', 3));
  assert.throws(() => s.update(a.capability, { ...view, revision: 2 }));
  assert.throws(() => s.update(a.capability, { ...view, revision: 4, documentId: 'document-' + 'e'.repeat(32) }));
  assert.throws(() => s.update(a.capability, { ...view, revision: 4, actor: 'human' }));
});
test('launch and session ceilings are absolute, with conservative backward-clock refusal', (t) => {
  const now = Date.now(),
    s = new OwnerUiSession(instance),
    code = s.bootstrap();
  t.mock.method(Date, 'now', () => now + 120001);
  assert.throws(() => s.activate('launch', code, view));
  assert.throws(() => s.bootstrap());
  t.mock.restoreAll();
  const current = new OwnerUiSession(instance),
    a = current.activate('launch', current.bootstrap(), view);
  t.mock.method(Date, 'now', () => current.createdAt - 1);
  assert.throws(() => current.authenticate(a.capability));
});
