import { Ajv2020 } from 'ajv/dist/2020.js';
import schema from './config-schema.js';

export const configSchema = schema;
let compiled: ReturnType<Ajv2020['compile']> | undefined;

/** The schema's first refusal, with a caller's field path. Never includes the rejected value. */
export function configSchemaProblem(value: unknown, path: string): string | null {
  const validate = (compiled ??= new Ajv2020({ strict: false, allErrors: true }).compile(schema));
  if (validate(value)) return null;
  const e = validate.errors![0]!;
  const parts = e.instancePath
    .split('/')
    .slice(1)
    .map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  if (e.keyword === 'required') parts.push(String(e.params.missingProperty));
  if (e.keyword === 'additionalProperties') parts.push(String(e.params.additionalProperty));
  const suffix = parts.map((p) => (/^\d+$/.test(p) ? `[${p}]` : `.${p}`)).join('');
  return `${path}${suffix} ${e.message}`;
}
