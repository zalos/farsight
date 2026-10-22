import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '@farsight/core';
import { decideGrants } from '../dist/index.js';

test('Work re-exports core’s one grant matcher, not a copy (ADR 20)', () => {
  assert.equal(decideGrants, core.decideGrants);
});
