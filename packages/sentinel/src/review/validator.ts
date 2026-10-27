// Reply validation (PR 22). A model reply is untrusted text. It is accepted only as one JSON object of the fixed
// grammar (prompts.ts) with no other key: a tool request within the session's tool set, or a final assessment.
// Grammar only, so no reply can name a new tool, target, disclosure, approval, suppression or promotion: such a
// field is a shape error. A final assessment's citations must be evidence ids this session served, each re-checked
// against the snapshot's bytes; "inspected" must name only files the session actually served. Valid citations make
// a claim well-formed, not correct: semantic correctness is the evaluation's question (evaluation.ts), not this one.
import type { ReviewAssessment, ReviewClaim, ReviewVerdict } from '../contracts/index.js';
import { snapshot } from '../policy/immutable.js';
import type { EvidenceBroker, ToolRequest } from './evidence.js';
import type { ReplyRejectionCode } from './errors.js';

export type Verdict = ReviewVerdict;
export type Claim = ReviewClaim;
export type FinalAssessment = ReviewAssessment;

export type ValidatedReply =
  | { readonly ok: true; readonly kind: 'tool'; readonly request: ToolRequest }
  | { readonly ok: true; readonly kind: 'final'; readonly assessment: FinalAssessment }
  | { readonly ok: false; readonly code: ReplyRejectionCode; readonly detail: string };

export const REPLY_BOUNDS = Object.freeze({
  maxReplyBytes: 64 * 1024,
  maxClaims: 16,
  maxCitations: 16,
  maxStatement: 2000,
  maxInspected: 1000,
});

const plain = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const exactKeys = (o: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) =>
  required.every((k) => Object.hasOwn(o, k)) &&
  Object.keys(o).every((k) => required.includes(k) || optional.includes(k));
const text = (v: unknown, max: number) =>
  // eslint-disable-next-line no-control-regex -- Review reply text rejects controls while allowing tabs and newlines.
  typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(v);
const CWE = /^CWE-[1-9][0-9]{0,4}$/;

/**
 * Reads one reply. `tools` is the session's tool set; anything else is a shape error. Leading and trailing whitespace
 * and one fenced code block around the object are tolerated; any other text is not.
 */
export function validateReply(
  raw: string,
  broker: EvidenceBroker,
  tools: ReadonlySet<ToolRequest['action']>,
): ValidatedReply {
  const no = (code: ReplyRejectionCode, detail: string): ValidatedReply => ({ ok: false, code, detail });
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > REPLY_BOUNDS.maxReplyBytes)
    return no('sentinel.review.reply.shape', 'the reply is not bounded text');
  const body = raw
    .trim()
    .replace(/^```(?:json)?\s*\n([\s\S]*)\n```$/, '$1')
    .trim();
  let v: unknown;
  try {
    v = JSON.parse(body);
  } catch {
    return no('sentinel.review.reply.notJson', 'the reply is not one JSON object');
  }
  if (!plain(v) || typeof v.action !== 'string') return no('sentinel.review.reply.shape', 'the reply names no action');
  const action = v.action;
  if (action === 'final') {
    if (!exactKeys(v, ['action', 'verdict', 'claims', 'inspected']))
      return no('sentinel.review.reply.shape', 'a final assessment has exactly action, verdict, claims and inspected');
    if (v.verdict !== 'finding' && v.verdict !== 'no-finding' && v.verdict !== 'inconclusive')
      return no('sentinel.review.reply.shape', 'unknown verdict');
    if (!Array.isArray(v.claims) || v.claims.length > REPLY_BOUNDS.maxClaims)
      return no('sentinel.review.reply.shape', 'claims is a bounded list');
    if (
      !Array.isArray(v.inspected) ||
      v.inspected.length > REPLY_BOUNDS.maxInspected ||
      !v.inspected.every((p) => text(p, 4096))
    )
      return no('sentinel.review.reply.shape', 'inspected is a bounded list of paths');
    const claims: Claim[] = [];
    for (const c of v.claims) {
      if (!plain(c) || !exactKeys(c, ['statement', 'citations'], ['cwe']))
        return no('sentinel.review.reply.shape', 'a claim has a statement, citations and an optional CWE');
      if (!text(c.statement, REPLY_BOUNDS.maxStatement))
        return no('sentinel.review.reply.shape', 'a claim statement is bounded text');
      if (
        !Array.isArray(c.citations) ||
        c.citations.length > REPLY_BOUNDS.maxCitations ||
        !c.citations.every((x) => typeof x === 'string')
      ) {
        return no('sentinel.review.reply.shape', 'citations are a bounded list of evidence ids');
      }
      if (c.cwe !== undefined && (typeof c.cwe !== 'string' || !CWE.test(c.cwe)))
        return no('sentinel.review.reply.shape', 'a CWE is CWE-<number>');
      if (c.citations.length === 0)
        return no('sentinel.review.reply.missingCitation', 'every claim cites served evidence');
      for (const id of c.citations as string[]) {
        const item = broker.served(id);
        if (!item)
          return no('sentinel.review.reply.unknownCitation', `${id.slice(0, 64)} was never served in this session`);
        if (!broker.verifyServed(id)) {
          return no('sentinel.review.reply.citationChanged', `${id.slice(0, 64)} no longer matches its captured bytes`);
        }
      }
      claims.push({
        statement: c.statement as string,
        citations: [...new Set(c.citations as string[])],
        ...(c.cwe ? { cwe: c.cwe as string } : {}),
      });
    }
    if (v.verdict === 'finding' && claims.length === 0)
      return no('sentinel.review.reply.missingCitation', 'a finding needs at least one cited claim');
    const read = new Set(broker.state().served.map((s) => s.relativePath));
    const unread = (v.inspected as string[]).filter((p) => !read.has(p));
    if (unread.length)
      return no('sentinel.review.reply.inspectedUnread', `${unread.length} claimed path(s) were never read`);
    return {
      ok: true,
      kind: 'final',
      assessment: snapshot({
        verdict: v.verdict as Verdict,
        claims,
        inspected: [...new Set(v.inspected as string[])].sort(),
      }),
    };
  }
  if (!tools.has(action as ToolRequest['action']))
    return no('sentinel.review.reply.shape', 'not a tool of this session');
  switch (action) {
    case 'list':
      return exactKeys(v, ['action'])
        ? { ok: true, kind: 'tool', request: { action: 'list' } }
        : no('sentinel.review.reply.shape', 'list takes no arguments');
    case 'read':
      if (
        !exactKeys(v, ['action', 'path', 'startLine', 'endLine']) ||
        !text(v.path, 4096) ||
        typeof v.startLine !== 'number' ||
        typeof v.endLine !== 'number'
      ) {
        return no('sentinel.review.reply.shape', 'read takes path, startLine and endLine');
      }
      return {
        ok: true,
        kind: 'tool',
        request: { action: 'read', path: v.path as string, startLine: v.startLine, endLine: v.endLine },
      };
    case 'rule':
      return exactKeys(v, ['action', 'familyId']) && text(v.familyId, 256)
        ? { ok: true, kind: 'tool', request: { action: 'rule', familyId: v.familyId as string } }
        : no('sentinel.review.reply.shape', 'rule takes familyId');
    case 'paths':
      return exactKeys(v, ['action', 'nodeId']) && text(v.nodeId, 1024)
        ? { ok: true, kind: 'tool', request: { action: 'paths', nodeId: v.nodeId as string } }
        : no('sentinel.review.reply.shape', 'paths takes nodeId');
    default:
      return no('sentinel.review.reply.shape', 'unknown action');
  }
}
