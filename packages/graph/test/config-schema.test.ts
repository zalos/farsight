import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { configSchema, configSchemaProblem } from '@farsight/graph/config';

test('the public config export embeds the canonical schema', () => {
  assert.deepEqual(
    configSchema,
    JSON.parse(readFileSync(new URL('../../../schemas/farsight-config.schema.json', import.meta.url), 'utf8')),
  );
  assert.equal(
    configSchemaProblem({ glossary: { submit: {} } }, 'source.config'),
    'source.config.glossary.submit.label is required',
  );
});
