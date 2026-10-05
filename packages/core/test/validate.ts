// Minimal JSON Schema validator — just enough of draft 2020-12 to hold the
// three frozen contracts (schemas/farsight-diff-v1, farsight-tests-matrix-v1,
// farsight-impact-tests-v1) against real output in tests without pulling a
// dependency (D5: zero-dep node --test). Supports: type (a string or a list,
// so a nullable column can say so), const, enum, required, properties,
// additionalProperties (false, or a schema every other property must match —
// `farsight-impact-tests v1` keys `select` by runner name), items, minimum,
// pattern, and local $ref into $defs; anyOf and patternProperties joined with the config and
// design manifest schemas (schemas/farsight-config, farsight-design). Anything a schema file starts using
// beyond that must be added here (the test fails loudly on unknown keywords).

type Schema = Record<string, unknown>;

const KNOWN = new Set([
  '$schema', '$id', '$defs', '$ref', 'title', 'description',
  'type', 'const', 'enum', 'required', 'properties', 'additionalProperties', 'items', 'minimum', 'pattern',
  'anyOf', 'patternProperties',
]);

export function validate(value: unknown, schema: Schema, root?: Schema, path = '$'): string[] {
  root ??= schema;
  const errors: string[] = [];
  for (const key of Object.keys(schema)) {
    if (!KNOWN.has(key)) errors.push(`${path}: validator does not implement schema keyword "${key}"`);
  }

  if (typeof schema.$ref === 'string') {
    const m = schema.$ref.match(/^#\/\$defs\/(.+)$/);
    if (!m) return [`${path}: unsupported $ref ${schema.$ref}`];
    const target = (root.$defs as Record<string, Schema> | undefined)?.[m[1]!];
    if (!target) return [`${path}: dangling $ref ${schema.$ref}`];
    return validate(value, target, root, path);
  }

  if (Array.isArray(schema.anyOf)) {
    const tries = (schema.anyOf as Schema[]).map((s) => validate(value, s, root, path));
    if (!tries.some((e) => e.length === 0)) errors.push(`${path}: matches none of anyOf (${tries.map((e) => e[0]).join(' | ')})`);
  }

  if ('const' in schema && value !== schema.const) {
    errors.push(`${path}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} not in enum`);
  }

  // `type` may be a string or a list of them ("integer or null" — the matrix
  // contract distinguishes "no answer" from zero, so nullable columns are real)
  const isType = (t: string): boolean =>
    t === 'object' ? typeof value === 'object' && value !== null && !Array.isArray(value)
    : t === 'array' ? Array.isArray(value)
    : t === 'string' ? typeof value === 'string'
    : t === 'boolean' ? typeof value === 'boolean'
    : t === 'integer' ? typeof value === 'number' && Number.isInteger(value)
    : t === 'number' ? typeof value === 'number'
    : t === 'null' ? value === null
    : false;
  if (typeof schema.type === 'string' || Array.isArray(schema.type)) {
    const types = (Array.isArray(schema.type) ? schema.type : [schema.type]) as string[];
    if (!types.some(isType)) {
      return [...errors, `${path}: expected ${types.join(' | ')}, got ${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value}`];
    }
  }

  if (typeof schema.minimum === 'number' && typeof value === 'number' && value < schema.minimum) {
    errors.push(`${path}: ${value} < minimum ${schema.minimum}`);
  }
  if (typeof schema.pattern === 'string' && typeof value === 'string' && !new RegExp(schema.pattern).test(value)) {
    errors.push(`${path}: "${value}" does not match ${schema.pattern}`);
  }

  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const props = (schema.properties ?? {}) as Record<string, Schema>;
    for (const req of (schema.required as string[] | undefined) ?? []) {
      if (!(req in obj)) errors.push(`${path}: missing required "${req}"`);
    }
    const extra = schema.additionalProperties;
    const patterns = Object.entries((schema.patternProperties ?? {}) as Record<string, Schema>);
    for (const [k, v] of Object.entries(obj)) {
      const byPattern = patterns.filter(([re]) => new RegExp(re).test(k));
      for (const [, ps] of byPattern) errors.push(...validate(v, ps, root, `${path}.${k}`));
      if (k in props) errors.push(...validate(v, props[k]!, root, `${path}.${k}`));
      else if (byPattern.length) continue;
      else if (extra === false) errors.push(`${path}: unexpected property "${k}"`);
      // an open map with a value schema: every key the caller invented still has to fit
      else if (typeof extra === 'object' && extra !== null) errors.push(...validate(v, extra as Schema, root, `${path}.${k}`));
    }
  }

  if (Array.isArray(value) && schema.items) {
    value.forEach((item, i) => errors.push(...validate(item, schema.items as Schema, root, `${path}[${i}]`)));
  }

  return errors;
}
