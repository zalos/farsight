// SARIF 2.1.0 (OASIS) as an imported claim. Every object this adapter walks is checked against the specification's
// own property names for that object: a name the specification does not define is a malformed document, a defined
// name this adapter does not interpret is counted as ignored (code flows, fixes, graphs, invocations, taxonomies,
// suppressions and the rest are never read as a flow, a fix, an execution or a clean result). Results are the tool's
// claims; `kind: "pass"` or no results at all clear nothing. Locations are kept as unbound claims (uri, index, hash,
// region): nothing here places them in captured source. An HTTP exchange is read from a result's inline webRequest
// and webResponse, or from the same run's cached webRequests/webResponses by index when the inline object agrees with
// the cached one; no external property file, schema or URL is ever read.
import { canonicalJson } from '@farsight/graph';
import { Collector, bounded, type RequestInfo, type ResponseInfo } from './collect.js';
import { TOKEN, originOf, validFieldValue } from './http.js';
import { ImportRefusal, isObject, type ImportUnknownCode, type Json, type JsonObject } from './types.js';

// Property names per object, SARIF 2.1.0 §3 (properties bags anywhere). `I` = interpreted here; the rest are ignored.
const SPEC: Record<string, { readonly all: readonly string[]; readonly read: readonly string[] }> = {
  log: { all: ['$schema', 'version', 'runs', 'inlineExternalProperties', 'properties'], read: ['$schema', 'version', 'runs', 'inlineExternalProperties'] },
  run: {
    all: ['tool', 'invocations', 'conversion', 'language', 'versionControlProvenance', 'originalUriBaseIds', 'artifacts', 'logicalLocations',
      'graphs', 'results', 'automationDetails', 'runAggregates', 'baselineGuid', 'redactionTokens', 'defaultEncoding', 'defaultSourceLanguage',
      'newlineSequences', 'columnKind', 'externalPropertyFileReferences', 'threadFlowLocations', 'taxonomies', 'addresses', 'translations',
      'policies', 'webRequests', 'webResponses', 'specialLocations', 'properties'],
    read: ['tool', 'artifacts', 'results', 'externalPropertyFileReferences', 'webRequests', 'webResponses'],
  },
  tool: { all: ['driver', 'extensions', 'properties'], read: ['driver'] },
  component: {
    all: ['guid', 'name', 'organization', 'product', 'productSuite', 'shortDescription', 'fullDescription', 'fullName', 'version',
      'semanticVersion', 'dottedQuadFileVersion', 'releaseDateUtc', 'downloadUri', 'informationUri', 'globalMessageStrings', 'notifications',
      'rules', 'taxa', 'locations', 'language', 'contents', 'isComprehensive', 'localizedDataSemanticVersion',
      'minimumRequiredLocalizedDataSemanticVersion', 'associatedComponent', 'translationMetadata', 'supportedTaxonomies', 'properties'],
    read: ['name', 'version', 'semanticVersion', 'rules'],
  },
  rule: {
    all: ['id', 'deprecatedIds', 'guid', 'deprecatedGuids', 'name', 'deprecatedNames', 'shortDescription', 'fullDescription',
      'messageStrings', 'defaultConfiguration', 'helpUri', 'help', 'relationships', 'properties'],
    read: ['id'],
  },
  result: {
    all: ['ruleId', 'ruleIndex', 'rule', 'kind', 'level', 'message', 'analysisTarget', 'locations', 'guid', 'correlationGuid',
      'occurrenceCount', 'partialFingerprints', 'fingerprints', 'stacks', 'codeFlows', 'graphs', 'graphTraversals', 'relatedLocations',
      'suppressions', 'baselineState', 'rank', 'attachments', 'hostedViewerUri', 'workItemUris', 'provenance', 'fixes', 'taxa',
      'webRequest', 'webResponse', 'properties'],
    read: ['ruleId', 'ruleIndex', 'rule', 'kind', 'level', 'message', 'locations', 'webRequest', 'webResponse'],
  },
  ruleRef: { all: ['id', 'index', 'guid', 'toolComponent', 'properties'], read: ['id', 'index'] },
  message: { all: ['text', 'markdown', 'id', 'arguments', 'properties'], read: ['text'] },
  location: { all: ['id', 'physicalLocation', 'logicalLocations', 'message', 'annotations', 'relationships', 'properties'], read: ['physicalLocation'] },
  physicalLocation: { all: ['address', 'artifactLocation', 'region', 'contextRegion', 'properties'], read: ['artifactLocation', 'region'] },
  artifactLocation: { all: ['uri', 'uriBaseId', 'index', 'description', 'properties'], read: ['uri', 'uriBaseId', 'index'] },
  region: {
    all: ['startLine', 'startColumn', 'endLine', 'endColumn', 'charOffset', 'charLength', 'byteOffset', 'byteLength', 'snippet',
      'message', 'sourceLanguage', 'properties'],
    read: ['startLine', 'startColumn', 'endLine', 'endColumn', 'charOffset', 'charLength', 'byteOffset', 'byteLength'],
  },
  artifact: {
    all: ['location', 'parentIndex', 'offset', 'length', 'roles', 'mimeType', 'contents', 'encoding', 'sourceLanguage', 'hashes',
      'lastModifiedTimeUtc', 'description', 'properties'],
    read: ['location', 'hashes'],
  },
  webRequest: { all: ['index', 'protocol', 'version', 'target', 'method', 'headers', 'parameters', 'body', 'properties'], read: ['index', 'protocol', 'target', 'method', 'headers'] },
  webResponse: {
    all: ['index', 'protocol', 'version', 'statusCode', 'reasonPhrase', 'headers', 'body', 'noResponseReceived', 'properties'],
    read: ['index', 'protocol', 'statusCode', 'headers', 'noResponseReceived'],
  },
};
const LEVELS = ['none', 'note', 'warning', 'error'];
const KINDS = ['notApplicable', 'pass', 'fail', 'review', 'open', 'informational'];
const REGION_KEYS = ['startLine', 'startColumn', 'endLine', 'endColumn', 'charOffset', 'charLength', 'byteOffset', 'byteLength'] as const;

const malformed = (pointer: string): never => { throw new ImportRefusal('sentinel.import.formatMalformed', pointer.slice(0, 256)); };
const nonNegative = (v: Json | undefined): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

function object(c: Collector, v: Json | undefined, kind: string, pointer: string): JsonObject {
  if (!isObject(v)) return malformed(pointer);
  const spec = SPEC[kind]!;
  for (const k of Object.keys(v)) {
    c.budget.work();
    if (!spec.all.includes(k)) malformed(`${pointer}/${k}`);
    if (!spec.read.includes(k)) c.ignore(`sarif.${kind}`, k);
  }
  return v;
}
const list = (v: Json | undefined, pointer: string): readonly Json[] => Array.isArray(v) ? v : malformed(pointer);
function optionalString(o: JsonObject, k: string, pointer: string, max = 1024): string | null {
  const v = o[k];
  if (v === undefined) return null;
  if (typeof v !== 'string') return malformed(`${pointer}/${k}`);
  return bounded(v, max);
}

export function readSarif(doc: Json, c: Collector): Json {
  if (!isObject(doc) || doc.version !== '2.1.0') throw new ImportRefusal('sentinel.import.formatMismatch', '/version');
  const log = object(c, doc, 'log', '');
  const schemaClaim = optionalString(log, '$schema', '', 512);
  if (log.inlineExternalProperties !== undefined) c.unknown('/inlineExternalProperties', 'sentinel.import.externalProperties');
  const tools: Json[] = [];
  list(log.runs, '/runs').forEach((runValue, ri) => {
    const rp = `/runs/${ri}`;
    const run = object(c, runValue, 'run', rp);
    const tool = object(c, run.tool, 'tool', `${rp}/tool`);
    const driver = object(c, tool.driver, 'component', `${rp}/tool/driver`);
    const name = optionalString(driver, 'name', `${rp}/tool/driver`, 256);
    const version = optionalString(driver, 'version', `${rp}/tool/driver`, 256);
    const semanticVersion = optionalString(driver, 'semanticVersion', `${rp}/tool/driver`, 256);
    compareProducer(c, `${rp}/tool/driver`, name, version ?? semanticVersion);
    tools.push({ pointer: `${rp}/tool/driver`, name, version, semanticVersion });
    if (run.externalPropertyFileReferences !== undefined) c.unknown(`${rp}/externalPropertyFileReferences`, 'sentinel.import.externalProperties');

    const ruleIds: (string | null)[] = [];
    if (driver.rules !== undefined) list(driver.rules, `${rp}/tool/driver/rules`).forEach((r, i) => {
      const rule = object(c, r, 'rule', `${rp}/tool/driver/rules/${i}`);
      ruleIds.push(typeof rule.id === 'string' ? rule.id : malformed(`${rp}/tool/driver/rules/${i}/id`));
    });
    const artifacts = run.artifacts === undefined ? [] : list(run.artifacts, `${rp}/artifacts`).map((a, i) => {
      const art = object(c, a, 'artifact', `${rp}/artifacts/${i}`);
      if (art.location !== undefined) object(c, art.location, 'artifactLocation', `${rp}/artifacts/${i}/location`);
      if (art.hashes !== undefined && !isObject(art.hashes)) malformed(`${rp}/artifacts/${i}/hashes`);
      return art;
    });
    const cache = (key: 'webRequests' | 'webResponses', kind: string) => {
      if (run[key] === undefined) return undefined;
      const all = list(run[key], `${rp}/${key}`);
      c.budget.count('exchanges', all.length);
      return all.map((w, i) => object(c, w, kind, `${rp}/${key}/${i}`));
    };
    const requests = cache('webRequests', 'webRequest');
    const responses = cache('webResponses', 'webResponse');

    if (run.results === undefined) return;
    list(run.results, `${rp}/results`).forEach((value, i) => {
      const p = `${rp}/results/${i}`;
      const result = object(c, value, 'result', p);
      const level = optionalString(result, 'level', p, 32);
      if (level !== null && !LEVELS.includes(level)) malformed(`${p}/level`);
      const kind = optionalString(result, 'kind', p, 32);
      if (kind !== null && !KINDS.includes(kind)) malformed(`${p}/kind`);
      const message = result.message === undefined ? undefined : object(c, result.message, 'message', `${p}/message`);
      const text = message ? optionalString(message, 'text', `${p}/message`, Number.MAX_SAFE_INTEGER) : null;
      c.claim(p, {
        format: 'sarif-2.1.0', run: ri, ruleId: ruleId(c, result, ruleIds, p), level, kind,
        messageDigest: text === null ? null : c.digest(text),
        locations: result.locations === undefined ? [] : list(result.locations, `${p}/locations`).map((l, li) => location(c, l, artifacts, `${p}/locations/${li}`)),
      });
      if (result.webRequest !== undefined || result.webResponse !== undefined) {
        const req = result.webRequest === undefined ? undefined : resolve(c, result.webRequest, requests, 'webRequest', `${p}/webRequest`);
        const res = result.webResponse === undefined ? undefined : resolve(c, result.webResponse, responses, 'webResponse', `${p}/webResponse`);
        const indexed = !!(req && 'indexed' in req && req.indexed) || !!(res && 'indexed' in res && res.indexed);
        c.exchange(p, indexed ? 'sarif-indexed' : 'sarif-inline',
          req === undefined ? null : 'reason' in req ? { ok: false, reason: req.reason } : request(c, req.value, `${p}/webRequest`),
          res === undefined ? null : 'reason' in res ? { ok: false, reason: res.reason } : response(c, res.value, `${p}/webResponse`));
      }
    });
  });
  return { schemaClaim, tools };
}

function compareProducer(c: Collector, pointer: string, name: string | null, version: string | null): void {
  const want = c.manifest.producer;
  if (want.name !== null) {
    if (name === null) c.unknown(`${pointer}/name`, 'sentinel.import.producerUnknown');
    else if (name !== want.name) throw new ImportRefusal('sentinel.import.producerMismatch', `${pointer}/name`);
  }
  if (want.version !== null) {
    if (version === null) c.unknown(`${pointer}/version`, 'sentinel.import.producerUnknown');
    else if (version !== want.version) throw new ImportRefusal('sentinel.import.producerMismatch', `${pointer}/version`);
  }
}

function ruleId(c: Collector, result: JsonObject, ruleIds: readonly (string | null)[], p: string): string | null {
  const stated: string[] = [];
  if (result.ruleId !== undefined) stated.push(typeof result.ruleId === 'string' ? result.ruleId : malformed(`${p}/ruleId`));
  if (result.rule !== undefined) {
    const ref = object(c, result.rule, 'ruleRef', `${p}/rule`);
    if (ref.id !== undefined) stated.push(typeof ref.id === 'string' ? ref.id : malformed(`${p}/rule/id`));
    if (ref.index !== undefined) {
      const id = nonNegative(ref.index) ? ruleIds[ref.index] : undefined;
      if (id === undefined || id === null) c.unknown(`${p}/rule/index`, 'sentinel.import.referenceUnresolved'); else stated.push(id);
    }
  }
  if (result.ruleIndex !== undefined) {
    const id = nonNegative(result.ruleIndex) ? ruleIds[result.ruleIndex] : undefined;
    if (id === undefined || id === null) c.unknown(`${p}/ruleIndex`, 'sentinel.import.referenceUnresolved'); else stated.push(id);
  }
  if (new Set(stated).size > 1) { c.unknown(`${p}/ruleId`, 'sentinel.import.referenceConflict'); return null; }
  return stated[0] === undefined ? null : bounded(stated[0], 256);
}

/** A location as the tool stated it, never placed: Stage A has no captured source to place it in. */
function location(c: Collector, value: Json, artifacts: readonly JsonObject[], p: string): Json {
  c.budget.count('locations');
  const loc = object(c, value, 'location', p);
  if (loc.physicalLocation === undefined) return { pointer: p, binding: 'unbound', uri: null, path: null, uriStatus: 'absent', uriBaseId: null, hash: null, region: null };
  const phys = object(c, loc.physicalLocation, 'physicalLocation', `${p}/physicalLocation`);
  let uri: string | null = null;
  let uriBaseId: string | null = null;
  let hash: string | null = null;
  if (phys.artifactLocation !== undefined) {
    const al = object(c, phys.artifactLocation, 'artifactLocation', `${p}/physicalLocation/artifactLocation`);
    const direct = optionalString(al, 'uri', `${p}/physicalLocation/artifactLocation`, 4096);
    uriBaseId = optionalString(al, 'uriBaseId', `${p}/physicalLocation/artifactLocation`, 256);
    uri = direct;
    if (al.index !== undefined) {
      const art = nonNegative(al.index) ? artifacts[al.index] : undefined;
      if (!art) c.unknown(`${p}/physicalLocation/artifactLocation/index`, 'sentinel.import.locationUnresolved');
      else {
        const viaIndex = isObject(art.location) && typeof art.location.uri === 'string' ? bounded(art.location.uri, 4096) : null;
        if (direct !== null && viaIndex !== null && direct !== viaIndex) { c.unknown(`${p}/physicalLocation/artifactLocation`, 'sentinel.import.locationConflict'); uri = null; }
        else uri = direct ?? viaIndex;
        if (direct === null && isObject(art.location) && typeof art.location.uriBaseId === 'string') uriBaseId = bounded(art.location.uriBaseId, 256);
        if (isObject(art.hashes) && art.hashes['sha-256'] !== undefined) {
          const h = art.hashes['sha-256'];
          if (typeof h === 'string' && /^[0-9A-Fa-f]{64}$/.test(h)) hash = `sha256:${h.toLowerCase()}`;
          else c.unknown(`${p}/physicalLocation/artifactLocation/index`, 'sentinel.import.hashInvalid');
        }
      }
    }
  }
  const classified = uri === null ? { status: 'absent', path: null } : classifyUri(uri);
  if (classified.status === 'rejected') c.unknown(`${p}/physicalLocation/artifactLocation/uri`, 'sentinel.import.uriRejected');
  let region: Json = null;
  if (phys.region !== undefined) {
    const r = object(c, phys.region, 'region', `${p}/physicalLocation/region`);
    const out: Record<string, number> = {};
    for (const k of REGION_KEYS) {
      if (r[k] === undefined) continue;
      if (!nonNegative(r[k])) malformed(`${p}/physicalLocation/region/${k}`);
      out[k] = r[k] as number;
    }
    region = out;
  }
  return { pointer: p, binding: 'unbound', uri, path: classified.path, uriStatus: classified.status, uriBaseId, hash, region };
}

/**
 * What a location's uri says as a path, compared after decoding rather than as raw text: a relative reference with no
 * query or fragment whose decoded segments are ordinary names. A scheme makes it absolute (kept, not a path).
 */
export function classifyUri(uri: string): { status: 'relative' | 'absolute' | 'rejected'; path: string | null } {
  if (!/^[\x21-\x7e]+$/.test(uri) || uri.includes('\\')) return { status: 'rejected', path: null };
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(uri)) return { status: 'absolute', path: null };
  if (uri.includes('?') || uri.includes('#') || uri.startsWith('/')) return { status: 'rejected', path: null };
  const segments: string[] = [];
  for (const raw of uri.split('/')) {
    let s: string;
    try { s = decodeURIComponent(raw); } catch { return { status: 'rejected', path: null }; }
    if (!s || s === '.' || s === '..' || s.includes('/') || s.includes('\\') || /[\u0000-\u001f\u007f]/.test(s)) return { status: 'rejected', path: null };
    segments.push(s);
  }
  return { status: 'relative', path: segments.join('/') };
}

type Resolved = { value: JsonObject; indexed: boolean } | { reason: ImportUnknownCode };

/** An inline web object, or the same run's cached one it names by index; the inline properties must equal the cache's. */
function resolve(c: Collector, value: Json, cache: readonly JsonObject[] | undefined, kind: 'webRequest' | 'webResponse', p: string): Resolved {
  const inline = object(c, value, kind, p);
  if (inline.index === undefined) return { value: inline, indexed: false };
  const index = inline.index;
  const cached = nonNegative(index) && cache ? cache[index] : undefined;
  if (!cached) return { reason: 'sentinel.import.referenceUnresolved' };
  if (cached.index !== undefined && cached.index !== index) return { reason: 'sentinel.import.referenceConflict' };
  for (const k of Object.keys(inline)) {
    if (k === 'index') continue;
    c.budget.work();
    if (cached[k] === undefined || canonicalJson(cached[k]) !== canonicalJson(inline[k])) return { reason: 'sentinel.import.referenceConflict' };
  }
  return { value: cached, indexed: true };
}

function headers(c: Collector, o: JsonObject, p: string): { name: string; lower: string; value: string }[] {
  if (o.headers === undefined) return [];
  if (!isObject(o.headers)) return malformed(`${p}/headers`);
  return Object.entries(o.headers).map(([name, value]) => {
    c.budget.count('headerLines');
    if (typeof value !== 'string') return malformed(`${p}/headers`);
    return { name, lower: name.toLowerCase(), value };
  });
}

function protocolOk(o: JsonObject, p: string): boolean {
  const v = o.protocol;
  if (v === undefined) return true;
  if (typeof v !== 'string') return malformed(`${p}/protocol`);
  return v.toUpperCase() === 'HTTP' || v.toUpperCase() === 'HTTPS';
}

function request(c: Collector, o: JsonObject, p: string): RequestInfo {
  const hs = headers(c, o, p);
  if (!protocolOk(o, p)) return { ok: false, reason: 'sentinel.import.versionUnsupported' };
  const method = o.method;
  const target = o.target;
  if (typeof method !== 'string' || typeof target !== 'string' || method.length > 32 || !TOKEN.test(method)
    || target.length > 8192 || !/^[\x21-\x7e]+$/.test(target)) return { ok: false, reason: 'sentinel.import.requestMalformed' };
  if (hs.some(h => !TOKEN.test(h.name) || !validFieldValue(h.value))) return { ok: false, reason: 'sentinel.import.headerMalformed' };
  const cookies = hs.filter(h => h.lower === 'cookie');
  if (cookies.length > 1) return { ok: false, reason: 'sentinel.import.headerAmbiguous' };
  return { ok: true, method, target, origin: originOf(target), cookieHeaders: cookies.map(h => h.value) };
}

function response(c: Collector, o: JsonObject, p: string): ResponseInfo {
  const hs = headers(c, o, p);
  if (o.noResponseReceived !== undefined && typeof o.noResponseReceived !== 'boolean') malformed(`${p}/noResponseReceived`);
  if (o.noResponseReceived === true) return { ok: false, reason: o.statusCode === undefined ? 'sentinel.import.noResponse' : 'sentinel.import.responseConflict' };
  if (!protocolOk(o, p)) return { ok: false, reason: 'sentinel.import.versionUnsupported' };
  const status = o.statusCode;
  if (typeof status !== 'number' || !Number.isSafeInteger(status) || status < 100 || status > 599) return { ok: false, reason: 'sentinel.import.statusMalformed' };
  if (hs.some(h => !TOKEN.test(h.name))) return { ok: false, reason: 'sentinel.import.headerMalformed' };
  // A headers object holds one value per name, so several Set-Cookie lines can only appear folded or under names that
  // differ in case: both are ambiguous. One value is one line, and the strict cookie reader decides the comma.
  const set = hs.filter(h => h.lower === 'set-cookie');
  if (set.length > 1) return { ok: true, status, setCookies: { reason: 'sentinel.import.headerAmbiguous' } };
  if (set.some(h => !validFieldValue(h.value) || /[\t]/.test(h.value))) return { ok: true, status, setCookies: { reason: 'sentinel.import.headerMalformed' } };
  return { ok: true, status, setCookies: set.map(h => h.value) };
}
