// ZAP's traditional JSON reports, as the report-generation add-on documents its two templates (traditional-json and
// traditional-json-plus, read 2026-10-22). Every documented field is accepted; the ones this adapter does not interpret
// (insights, statistics, Automation Framework messages, script diagnostics, tags, node names, descriptions) are
// counted as ignored, and a field neither template documents is malformed. The plain template carries no HTTP
// messages, so a plain report that does is refused as the wrong format; its alerts are claims only. In the plus
// template an instance's request and response heads are read for Set-Cookie facts, after its request line is found to
// agree with the instance's own method and URI. `@programName` appears only in older reports: when absent the
// producer stays unknown, never assumed. `@generated` and `created` are when the report was made, not when any message
// was observed. Sequence steps are pass/fail claims of the tool and are never read as exchanges.
import { Collector, bounded, type RequestInfo, type ResponseInfo } from './collect.js';
import { originOf, parseHead, parseRequestLine, parseStatusLine, type RequestLine, type StatusLine } from './http.js';
import { ImportRefusal, isObject, type Json, type JsonObject } from './types.js';

const PAYLOAD = ['request-header', 'request-body', 'response-header', 'response-body'];
const SPEC: Record<string, { readonly all: readonly string[]; readonly read: readonly string[] }> = {
  report: {
    all: ['@programName', '@version', '@generated', 'created', 'insights', 'site', 'sequences', 'statistics', 'afPlanErrors', 'afPlanWarns', 'scriptDiagnostics'],
    read: ['@programName', '@version', '@generated', 'created', 'site', 'sequences'],
  },
  site: { all: ['@name', '@host', '@port', '@ssl', 'alerts', 'statistics'], read: ['@name', '@host', '@port', '@ssl', 'alerts'] },
  alert: {
    all: ['pluginid', 'alertRef', 'alert', 'name', 'riskcode', 'confidence', 'riskdesc', 'desc', 'instances', 'count', 'systemic',
      'solution', 'otherinfo', 'reference', 'cweid', 'wascid', 'sourceid', 'tags'],
    read: ['pluginid', 'alertRef', 'alert', 'name', 'riskcode', 'confidence', 'instances', 'count', 'systemic', 'cweid', 'wascid'],
  },
  instance: { all: ['uri', 'nodeName', 'method', 'param', 'attack', 'evidence', 'otherinfo', ...PAYLOAD], read: ['uri', 'method', 'param', 'request-header', 'response-header'] },
  sequence: { all: ['name', 'steps'], read: ['steps'] },
  step: { all: ['step', 'pass', 'resultDetails', 'alertIds', 'original', 'replay'], read: [] },
};

const malformed = (pointer: string): never => { throw new ImportRefusal('sentinel.import.formatMalformed', pointer.slice(0, 256)); };

function object(c: Collector, v: Json | undefined, kind: string, pointer: string, plus: boolean): JsonObject {
  if (!isObject(v)) return malformed(pointer);
  const spec = SPEC[kind]!;
  for (const k of Object.keys(v)) {
    c.budget.work();
    if (!plus && kind === 'instance' && PAYLOAD.includes(k)) throw new ImportRefusal('sentinel.import.formatMismatch', `${pointer}/${k}`.slice(0, 256));
    if (!spec.all.includes(k)) malformed(`${pointer}/${k}`);
    if (!spec.read.includes(k)) c.ignore(`zap.${kind}`, k);
  }
  return v;
}
const list = (v: Json | undefined, pointer: string): readonly Json[] => Array.isArray(v) ? v : malformed(pointer);
function text(o: JsonObject, k: string, pointer: string, max = 1024): string | null {
  const v = o[k];
  if (v === undefined) return null;
  if (typeof v !== 'string') return malformed(`${pointer}/${k}`);
  return bounded(v, max);
}

export function readZap(doc: Json, c: Collector, plus: boolean): Json {
  if (!isObject(doc) || !Array.isArray(doc.site)) throw new ImportRefusal('sentinel.import.formatMismatch', '/site');
  const report = object(c, doc, 'report', '', plus);
  const programName = text(report, '@programName', '', 256);
  const version = text(report, '@version', '', 256);
  const want = c.manifest.producer;
  if (want.name !== null) {
    if (programName === null) c.unknown('/@programName', 'sentinel.import.producerUnknown');
    else if (programName !== want.name) throw new ImportRefusal('sentinel.import.producerMismatch', '/@programName');
  }
  if (want.version !== null) {
    if (version === null) c.unknown('/@version', 'sentinel.import.producerUnknown');
    else if (version !== want.version) throw new ImportRefusal('sentinel.import.producerMismatch', '/@version');
  }

  list(report.site, '/site').forEach((s, si) => {
    const sp = `/site/${si}`;
    const site = object(c, s, 'site', sp, plus);
    for (const k of ['@name', '@host', '@port', '@ssl']) text(site, k, sp);
    if (site.alerts === undefined) return;
    list(site.alerts, `${sp}/alerts`).forEach((a, ai) => {
      const ap = `${sp}/alerts/${ai}`;
      const alert = object(c, a, 'alert', ap, plus);
      if (alert.systemic !== undefined && typeof alert.systemic !== 'boolean') malformed(`${ap}/systemic`);
      const instances = alert.instances === undefined ? [] : list(alert.instances, `${ap}/instances`);
      c.claim(ap, {
        format: plus ? 'zap-traditional-json-plus' : 'zap-traditional-json',
        siteDigest: c.digest(text(site, '@name', sp, Number.MAX_SAFE_INTEGER) ?? ''),
        pluginId: text(alert, 'pluginid', ap, 64), alertRef: text(alert, 'alertRef', ap, 64),
        nameDigest: c.digest(text(alert, 'alert', ap, Number.MAX_SAFE_INTEGER) ?? text(alert, 'name', ap, Number.MAX_SAFE_INTEGER) ?? ''),
        riskcode: text(alert, 'riskcode', ap, 16), confidence: text(alert, 'confidence', ap, 16),
        cweid: text(alert, 'cweid', ap, 16), wascid: text(alert, 'wascid', ap, 16), countClaim: text(alert, 'count', ap, 16),
        systemic: typeof alert.systemic === 'boolean' ? alert.systemic : null,
        instances: instances.map((v, ii) => {
          const ip = `${ap}/instances/${ii}`;
          const inst = object(c, v, 'instance', ip, plus);
          const uri = text(inst, 'uri', ip, Number.MAX_SAFE_INTEGER);
          const method = text(inst, 'method', ip, 64);
          for (const k of ['nodeName', 'param', 'attack', 'evidence', 'otherinfo', ...PAYLOAD]) text(inst, k, ip, Number.MAX_SAFE_INTEGER);
          if (plus) exchange(c, inst, ip, uri, method);
          else c.unknown(ip, 'sentinel.import.noExchange');
          return { pointer: ip, uriDigest: uri === null ? null : c.digest(uri), method, hasParam: inst.param !== undefined && inst.param !== '' };
        }),
      });
    });
  });

  let steps = 0;
  if (report.sequences !== undefined) list(report.sequences, '/sequences').forEach((s, i) => {
    const seq = object(c, s, 'sequence', `/sequences/${i}`, plus);
    if (seq.steps === undefined) return;
    list(seq.steps, `/sequences/${i}/steps`).forEach((st, j) => {
      const p = `/sequences/${i}/steps/${j}`;
      object(c, st, 'step', p, plus);
      for (const side of ['original', 'replay'] as const) {
        const m = (st as JsonObject)[side];
        if (m === undefined) continue;
        if (!isObject(m)) return malformed(`${p}/${side}`);
        for (const k of Object.keys(m)) {
          if (!plus && PAYLOAD.includes(k)) throw new ImportRefusal('sentinel.import.formatMismatch', `${p}/${side}/${k}`);
          if (!['uri', 'method', ...PAYLOAD].includes(k) || typeof m[k] !== 'string') malformed(`${p}/${side}/${k}`);
        }
      }
      steps++;
      c.unknown(p, 'sentinel.import.sequenceUnsupported');
    });
  });

  return {
    programName, version,
    generatedClaim: text(report, '@generated', '', 64), createdClaim: text(report, 'created', '', 64),
    sequenceSteps: steps,
  };
}

/** One plus instance's recorded request and response heads. */
function exchange(c: Collector, inst: JsonObject, ip: string, uri: string | null, method: string | null): void {
  const rh = inst['request-header'];
  const sh = inst['response-header'];
  let request: RequestInfo | null = null;
  if (typeof rh === 'string') {
    const head = parseHead<RequestLine>(rh, parseRequestLine, c.budget);
    if (!head.ok) request = { ok: false, reason: head.code };
    else if (head.start.method !== method || head.start.target !== uri) request = { ok: false, reason: 'sentinel.import.requestInconsistent' };
    else request = {
      ok: true, method: head.start.method, target: head.start.target, origin: originOf(head.start.target),
      cookieHeaders: head.headers.filter(h => h.lower === 'cookie').map(h => h.value),
    };
  } else request = { ok: false, reason: 'sentinel.import.missingHeader' };
  let response: ResponseInfo | null;
  if (typeof sh === 'string') {
    const head = parseHead<StatusLine>(sh, parseStatusLine, c.budget);
    response = head.ok
      ? { ok: true, status: head.start.status, setCookies: head.headers.filter(h => h.lower === 'set-cookie').map(h => h.value) }
      : { ok: false, reason: head.code };
  } else response = { ok: false, reason: 'sentinel.import.missingHeader' };
  c.exchange(ip, 'zap-instance', request, response);
}
