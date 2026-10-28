// The Express version scope, read from the captured package manifest and lockfile as JSON structure. The pack models
// exactly Express 4.21.2: the root package.json must depend on it exactly, or on a range the npm lockfile resolves to
// exactly that version. Overrides, another lockfile format with a range, a TypeScript path alias for `express`, or
// any manifest that cannot be read leaves the version unresolved or unsupported, never assumed.
import { parseProgram, stringValue, unwrap, type JsNode } from './syntax.js';

/** The one Express version the pack models; any other resolved version is `versionUnsupported`. */
export const EXPRESS_VERSION = '4.21.2';

/** A JSON text read with positions, so each property can be cited by its span. */
export interface JsonDoc {
  readonly text: string;
  /** The parsed value; undefined when the text is not valid JSON. */
  readonly value: unknown;
  /** The object node, with UTF-16 offsets into `text`. */
  readonly root: JsNode | undefined;
}

/** Parses JSON with positions: valid JSON, read as an expression so each property has its span. */
export function parseJson(text: string): JsonDoc {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { text, value: undefined, root: undefined };
  }
  const { program, errors } = parseProgram('document.js', `(${text}\n)`);
  if (errors) return { text, value, root: undefined };
  const stmt = (program.body as JsNode[])[0];
  const root = stmt?.type === 'ExpressionStatement' ? unwrap(stmt.expression as JsNode) : undefined;
  if (!root || hasDuplicateKeys(root)) return { text, value: undefined, root: undefined };
  return { text, value, root: shift(root) };
}

/** A JSON object with a repeated key is read differently by different readers: refused. */
function hasDuplicateKeys(n: JsNode): boolean {
  if (n.type === 'ObjectExpression') {
    const seen = new Set<string>();
    for (const p of n.properties as JsNode[]) {
      const k = stringValue(p.key as JsNode);
      if (k === undefined || seen.has(k)) return true;
      seen.add(k);
      if (hasDuplicateKeys(p.value as JsNode)) return true;
    }
  }
  if (n.type === 'ArrayExpression') return (n.elements as JsNode[]).some((e) => e && hasDuplicateKeys(e));
  return false;
}

/** Offsets in the wrapped text are one past the original's; re-base them. */
function shift(n: JsNode): JsNode {
  const out: Record<string, unknown> = { ...n, start: n.start - 1, end: n.end - 1 };
  for (const [k, v] of Object.entries(n)) {
    if (Array.isArray(v)) out[k] = v.map((x) => (x && typeof x === 'object' && 'type' in x ? shift(x as JsNode) : x));
    else if (v && typeof v === 'object' && 'type' in v) out[k] = shift(v as JsNode);
  }
  return out as unknown as JsNode;
}

/** The property node `key` of an object node, if present. */
export function propertyOf(obj: JsNode | undefined, key: string): JsNode | undefined {
  if (obj?.type !== 'ObjectExpression') return undefined;
  return (obj.properties as JsNode[]).find((p) => stringValue(p.key as JsNode) === key);
}

/** Whether the source's Express is the modeled version, with the manifest evidence either way. */
export type VersionVerdict =
  | { readonly ok: true; readonly evidence: readonly { readonly path: string; readonly node: JsNode }[] }
  | {
      readonly ok: false;
      readonly reason: 'sentinel.express.versionUnresolved' | 'sentinel.express.versionUnsupported';
      readonly evidence: readonly { readonly path: string; readonly node: JsNode }[];
    };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Decides the version scope from the root manifest, the npm lockfile when present, and whether another lockfile or a
 * path alias for `express` exists.
 */
export function versionScope(
  manifest: JsonDoc | undefined,
  npmLock: JsonDoc | undefined,
  otherLockfile: boolean,
  aliased: boolean,
): VersionVerdict {
  const unresolved = (evidence: { path: string; node: JsNode }[] = []): VersionVerdict => ({
    ok: false,
    reason: 'sentinel.express.versionUnresolved',
    evidence,
  });
  const unsupported = (evidence: { path: string; node: JsNode }[]): VersionVerdict => ({
    ok: false,
    reason: 'sentinel.express.versionUnsupported',
    evidence,
  });
  if (!manifest || !isRecord(manifest.value) || !manifest.root || aliased) return unresolved();
  const pkg = manifest.value;
  for (const key of ['overrides', 'resolutions', 'pnpm']) {
    const node = propertyOf(manifest.root, key);
    if (node && /"express"/.test(manifest.text.slice(node.start, node.end)))
      return unsupported([{ path: 'package.json', node }]);
  }
  const depsNode = propertyOf(manifest.root, 'dependencies');
  const depNode = propertyOf(depsNode?.value as JsNode | undefined, 'express');
  const range = isRecord(pkg.dependencies) ? pkg.dependencies.express : undefined;
  if (typeof range !== 'string' || !depNode) return unresolved();
  const manifestEvidence = { path: 'package.json', node: depNode };
  let locked: { version: unknown; node: JsNode } | undefined;
  if (npmLock) {
    const lock = npmLock.value;
    if (
      !isRecord(lock) ||
      !npmLock.root ||
      typeof lock.lockfileVersion !== 'number' ||
      lock.lockfileVersion < 2 ||
      !isRecord(lock.packages)
    )
      return unresolved([manifestEvidence]);
    const entry = lock.packages['node_modules/express'];
    const node = propertyOf(propertyOf(npmLock.root, 'packages')?.value as JsNode | undefined, 'node_modules/express');
    const rootEntry = lock.packages[''];
    const declared =
      isRecord(rootEntry) && isRecord(rootEntry.dependencies) ? rootEntry.dependencies.express : undefined;
    // The lockfile must have been written for this manifest's declaration.
    if (!isRecord(entry) || !node || declared !== range) return unresolved([manifestEvidence]);
    locked = { version: entry.version, node };
  }
  if (/^\d+\.\d+\.\d+$/.test(range)) {
    if (range !== EXPRESS_VERSION) return unsupported([manifestEvidence]);
    if (locked && locked.version !== EXPRESS_VERSION)
      return unsupported([manifestEvidence, { path: 'package-lock.json', node: locked.node }]);
    return {
      ok: true,
      evidence: [manifestEvidence, ...(locked ? [{ path: 'package-lock.json', node: locked.node }] : [])],
    };
  }
  // A range: only the npm lockfile's resolution decides it.
  if (!locked || otherLockfile) return unresolved([manifestEvidence]);
  if (locked.version !== EXPRESS_VERSION)
    return unsupported([manifestEvidence, { path: 'package-lock.json', node: locked.node }]);
  return { ok: true, evidence: [manifestEvidence, { path: 'package-lock.json', node: locked.node }] };
}
