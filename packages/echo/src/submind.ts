import { randomUUID } from 'node:crypto';
import { containsCredentialShape } from '@farsight/core/dist/credential-shapes.js';
import { echoSubmindWord } from '@farsight/core/dist/strings-echo-submind.js';
import { submindSettings } from './config.js';
import { generateSubmind, submindInputChars } from './models.js';
import type { EchoProfile } from './types.js';
import type {
  SubmindCitation,
  ExpandAction,
  ExpandResult,
  ResearchMemory,
  ResearchStore,
  SubmindFinding,
  SubmindModelRequest,
  SubmindModelResponse,
  SubmindResult,
} from './submind-types.js';

export type SubmindGenerator = (profile: EchoProfile, request: SubmindModelRequest) => Promise<SubmindModelResponse>;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const only = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every((key) => keys.includes(key));
const validText = (value: unknown, max: number): value is string =>
  // eslint-disable-next-line no-control-regex -- Submind text permits tabs/newlines while rejecting other ASCII controls.
  typeof value === 'string' && !!value.trim() && value.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
const refKey = (value: { id: string; revision: string }) => `${value.id}:${value.revision}`;
const clipped = (value: string, max: number): string =>
  value.slice(0, Math.max(0, max)).replace(/[\uD800-\uDBFF]$/, '');

async function withinDeadline<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let listener!: () => void;
  const stopped = new Promise<never>((_, reject) => {
    listener = () => reject(new Error('aborted'));
    signal.addEventListener('abort', listener, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve().then(operation), stopped]);
  } finally {
    signal.removeEventListener('abort', listener);
  }
}

export function validateResearchQuery(value: unknown): string {
  if (!validText(value, 4000) || containsCredentialShape(value)) throw new Error(echoSubmindWord('input'));
  return value.trim();
}
export function validateExpansion(value: unknown): { id: string; revision: string } {
  if (
    !object(value) ||
    !only(value, ['id', 'revision']) ||
    typeof value.id !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,256}$/.test(value.id) ||
    typeof value.revision !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.revision)
  )
    throw new Error(echoSubmindWord('reference'));
  return { id: value.id, revision: value.revision };
}

// Large string maxLength values become unsupported repetitions in some Ollama grammars.
// Validate the 4000-character limits below; generation and transport remain independently capped.
const answerSchema: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'findings'],
  properties: {
    kind: { type: 'string', enum: ['answer'] },
    findings: {
      type: 'array',
      maxItems: 5,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['problem', 'fix', 'why', 'citations'],
        properties: {
          problem: { type: 'string' },
          fix: { type: 'string' },
          why: { type: ['string', 'null'] },
          citations: {
            type: 'array',
            minItems: 1,
            maxItems: 5,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'revision'],
              properties: { id: { type: 'string' }, revision: { type: 'string' } },
            },
          },
        },
      },
    },
  },
};
const actionSchema: Record<string, unknown> = {
  anyOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'query'],
      properties: { kind: { type: 'string', enum: ['search'] }, query: { type: 'string' } },
    },
    answerSchema,
  ],
};
function findingsFrom(value: unknown, evidence: Map<string, ResearchMemory>): SubmindFinding[] | undefined {
  if (!Array.isArray(value) || value.length > 5) return;
  const findings: SubmindFinding[] = [];
  for (const row of value) {
    if (
      !object(row) ||
      !only(row, ['problem', 'fix', 'why', 'citations']) ||
      !validText(row.problem, 4000) ||
      !validText(row.fix, 4000) ||
      (row.why !== null && !validText(row.why, 4000)) ||
      !Array.isArray(row.citations) ||
      row.citations.length < 1 ||
      row.citations.length > 5
    )
      return;
    const citations: SubmindCitation[] = [];
    for (const candidate of row.citations) {
      let citation;
      try {
        citation = validateExpansion(candidate);
      } catch {
        return;
      }
      if (!evidence.has(refKey(citation))) return;
      if (!citations.some((existing) => refKey(existing) === refKey(citation)))
        citations.push(sourceCitation(evidence.get(refKey(citation))!));
    }
    findings.push({
      problem: row.problem.trim(),
      fix: row.fix.trim(),
      why: typeof row.why === 'string' ? row.why.trim() : null,
      citations,
    });
  }
  return findings;
}
function actionsFor(findings: SubmindFinding[]): ExpandAction[] {
  const refs = new Map(findings.flatMap((f) => f.citations).map((ref) => [refKey(ref), ref]));
  return [...refs.values()].map((ref) => ({
    rel: 'read_more',
    operation: 'memory.expand',
    arguments: { id: ref.id, revision: ref.revision },
  }));
}
/** Budget includes citation/action overhead; omit whole findings if even references cannot fit. */
function fitFindings(
  findings: SubmindFinding[],
  maxChars: number,
): { findings: SubmindFinding[]; actions: ExpandAction[]; truncated: boolean } {
  const kept: SubmindFinding[] = [];
  let truncated = false;
  for (const original of findings) {
    const source = {
      ...original,
      problem: original.problem.trim(),
      fix: original.fix.trim(),
      why: original.why?.trim() || null,
    };
    if (!source.problem || !source.fix) {
      truncated = true;
      continue;
    }
    // The minimum must retain one whole code point in every required field.
    const minimum = Math.max(
      ...[source.problem, source.fix, source.why ?? ''].map((text) => ((text.codePointAt(0) ?? 0) > 0xffff ? 2 : 1)),
    );
    const fit = (size: number) => ({
      ...source,
      problem: clipped(source.problem, size).trimEnd(),
      fix: clipped(source.fix, size).trimEnd(),
      why: source.why === null ? null : clipped(source.why, size).trimEnd(),
    });
    const sizeOf = (item: SubmindFinding) =>
      JSON.stringify({ findings: [...kept, item], actions: actionsFor([...kept, item]) }).length;
    const smallest = fit(minimum);
    if (!smallest.problem || !smallest.fix || smallest.why === '' || sizeOf(smallest) > maxChars) {
      truncated = true;
      continue;
    }
    let low = minimum,
      high = Math.max(source.problem.length, source.fix.length, source.why?.length ?? 0);
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (sizeOf(fit(mid)) <= maxChars) low = mid;
      else high = mid - 1;
    }
    const item = fit(low);
    truncated ||= item.problem !== original.problem || item.fix !== original.fix || item.why !== original.why;
    kept.push(item);
  }
  return { findings: kept, actions: actionsFor(kept), truncated };
}
function sourceCitation(memory: ResearchMemory): SubmindCitation {
  return {
    id: memory.id,
    revision: memory.revision,
    title: memory.title,
    timestamp: memory.timestamp,
    ...(memory.provenance ? { provenance: memory.provenance } : {}),
  };
}
function mockFindings(query: string, evidence: ResearchMemory[]): SubmindFinding[] {
  return evidence.slice(0, 2).map((memory) => {
    const match = /^Problem:\s*([\s\S]+?)\s+Fix:\s*([\s\S]+?)\s+Why:\s*([\s\S]+)$/i.exec(memory.content);
    return {
      problem: clipped(match?.[1] ?? query, 4000),
      fix: clipped(match?.[2] ?? memory.content, 4000),
      why: match ? clipped(match[3]!, 4000) : null,
      citations: [sourceCitation(memory)],
    };
  });
}

/** Only explicitly enabled model mode can call a provider. Mock/off modes cannot reach it. */
export async function research(
  profile: EchoProfile,
  store: ResearchStore,
  input: { query: string },
  options: { generate?: SubmindGenerator; signal?: AbortSignal; now?: () => number } = {},
): Promise<SubmindResult> {
  const query = validateResearchQuery(input.query);
  const settings = submindSettings(profile);
  const now = options.now ?? Date.now;
  const start = now();
  const since = new Date(start - settings.lookbackDays * 86_400_000).toISOString();
  const result: SubmindResult = {
    schema: 'echo-memory/v1',
    requestId: randomUUID(),
    status: 'empty',
    mode: settings.mode,
    findings: [],
    actions: [],
    coverage: { exhaustive: false, since, inspected: 0, stopReason: 'no_matches', truncated: false },
    usage: {
      modelCalls: 0,
      searches: 0,
      evidenceChars: 0,
      inputChars: 0,
      inputTokens: settings.mode === 'model' ? null : 0,
      outputTokens: settings.mode === 'model' ? null : 0,
      elapsedMs: 0,
    },
  };
  const finish = (reason: SubmindResult['coverage']['stopReason'], status: SubmindResult['status'] = result.status) => {
    result.coverage.stopReason = reason;
    result.status = status;
    result.usage.elapsedMs = Math.max(0, now() - start);
    return result;
  };
  if (settings.mode === 'off') return finish('disabled', 'disabled');
  const signal = AbortSignal.any([
    AbortSignal.timeout(settings.timeoutMs),
    ...(options.signal ? [options.signal] : []),
  ]);
  const evidence = new Map<string, ResearchMemory>();
  const searched = new Set<string>();
  let unknownInput = false,
    unknownOutput = false;
  let inputTokens = 0,
    outputTokens = 0;
  const lookup = async (question: string): Promise<boolean> => {
    signal.throwIfAborted();
    const key = question.trim().toLowerCase();
    if (
      searched.has(key) ||
      result.usage.searches >= settings.maxSearches ||
      result.usage.evidenceChars >= settings.evidenceMaxChars ||
      result.coverage.inspected >= settings.maxCandidates
    )
      return false;
    searched.add(key);
    result.usage.searches++;
    const found = await withinDeadline(
      () =>
        store.search(
          {
            query: question,
            limit: settings.maxCandidates - result.coverage.inspected,
            maxChars: settings.evidenceMaxChars - result.usage.evidenceChars,
            since,
          },
          signal,
        ),
      signal,
    );
    signal.throwIfAborted();
    result.coverage.inspected += found.inspected;
    result.coverage.truncated ||= found.truncated;
    for (const memory of found.memories) {
      if (evidence.has(refKey(memory))) continue;
      const size = memory.title.length + memory.content.length;
      if (result.usage.evidenceChars + size > settings.evidenceMaxChars) {
        result.coverage.truncated = true;
        break;
      }
      evidence.set(refKey(memory), memory);
      result.usage.evidenceChars += size;
    }
    return true;
  };
  try {
    await lookup(query);
  } catch {
    return finish(signal.aborted ? 'timeout' : 'store_unavailable', 'unavailable');
  }
  if (settings.mode === 'mock') {
    const fitted = fitFindings(mockFindings(query, [...evidence.values()]), profile.budget.briefMaxChars);
    result.findings = fitted.findings;
    result.actions = fitted.actions;
    result.coverage.truncated ||= fitted.truncated;
    return finish(
      evidence.size ? (fitted.truncated ? 'budget' : 'complete') : 'no_matches',
      fitted.truncated ? 'partial' : result.findings.length ? 'ready' : 'empty',
    );
  }
  // Empty search can be rephrased by the model; never widen identity or time scope.
  let answerOnly = false;
  for (let step = 0; step < settings.maxSteps; step++) {
    if (signal.aborted) return finish('timeout', 'unavailable');
    const remaining = {
      modelCalls: settings.maxSteps - result.usage.modelCalls,
      searches: settings.maxSearches - result.usage.searches,
      candidates: settings.maxCandidates - result.coverage.inspected,
      evidenceChars: settings.evidenceMaxChars - result.usage.evidenceChars,
      inputChars: settings.inputMaxChars - result.usage.inputChars,
    };
    // Leave the last permitted call for synthesis, even if more lookups would fit.
    const canSearch =
      !answerOnly &&
      remaining.modelCalls > 1 &&
      remaining.searches > 0 &&
      remaining.candidates > 0 &&
      remaining.evidenceChars > 0;
    const request: SubmindModelRequest = {
      messages: [
        {
          role: 'system',
          content: canSearch
            ? echoSubmindWord('prompt')
            : `${echoSubmindWord('prompt')}\n${echoSubmindWord('finalPrompt')}`,
        },
        {
          role: 'user',
          content: JSON.stringify({
            question: query,
            since,
            canSearch,
            remaining,
            previousQueries: [...searched],
            evidence: [...evidence.values()],
          }),
        },
      ],
      schema: canSearch ? actionSchema : answerSchema,
      signal,
      maxOutputTokens: profile.budget.modelMaxTokens,
    };
    const inputSize = submindInputChars(profile, request);
    if (result.usage.inputChars + inputSize > settings.inputMaxChars) return finish('budget', 'partial');
    result.usage.inputChars += inputSize;
    result.usage.modelCalls++;
    // Until this attempt reports usage, the cumulative amount may include unknown billed work.
    result.usage.inputTokens = null;
    result.usage.outputTokens = null;
    let response: SubmindModelResponse;
    try {
      response = await withinDeadline(() => (options.generate ?? generateSubmind)(profile, request), signal);
    } catch {
      return finish(signal.aborted ? 'timeout' : 'model_unavailable', 'unavailable');
    }
    if (signal.aborted) return finish('timeout', 'unavailable');
    unknownInput ||= response.usage.inputTokens === null;
    unknownOutput ||= response.usage.outputTokens === null;
    inputTokens += response.usage.inputTokens ?? 0;
    outputTokens += response.usage.outputTokens ?? 0;
    result.usage.inputTokens = unknownInput ? null : inputTokens;
    result.usage.outputTokens = unknownOutput ? null : outputTokens;
    const action = response.content;
    if (!object(action)) return finish('invalid_response', 'unavailable');
    if (action.kind === 'answer' && only(action, ['kind', 'findings'])) {
      const findings = findingsFrom(action.findings, evidence);
      if (!findings) return finish('invalid_response', 'unavailable');
      const fitted = fitFindings(findings, profile.budget.briefMaxChars);
      result.findings = fitted.findings;
      result.actions = fitted.actions;
      result.coverage.truncated ||= fitted.truncated;
      return finish(
        fitted.truncated ? 'budget' : findings.length ? 'complete' : 'no_matches',
        fitted.truncated ? 'partial' : findings.length ? 'ready' : 'empty',
      );
    }
    if (!canSearch || action.kind !== 'search' || !only(action, ['kind', 'query']))
      return finish('invalid_response', 'unavailable');
    let next: string;
    try {
      next = validateResearchQuery(action.query);
    } catch {
      return finish('invalid_response', 'unavailable');
    }
    // A repeated/disallowed lookup must not discard already gathered evidence.
    // The next call can only synthesize; it still spends the remaining request budget.
    try {
      if (!(await lookup(next))) answerOnly = true;
    } catch {
      return finish(signal.aborted ? 'timeout' : 'store_unavailable', 'unavailable');
    }
  }
  return finish('budget', 'partial');
}

/** Exact evidence expansion is deterministic and never invokes the sub-mind. */
export async function expandMemory(
  profile: EchoProfile,
  store: ResearchStore,
  input: { id: string; revision: string },
  signal?: AbortSignal,
): Promise<ExpandResult> {
  const reference = validateExpansion(input);
  const settings = submindSettings(profile);
  const deadline = AbortSignal.any([AbortSignal.timeout(settings.timeoutMs), ...(signal ? [signal] : [])]);
  const result = await withinDeadline(
    () => store.read({ ...reference, maxChars: settings.expandedMaxChars }, deadline),
    deadline,
  );
  deadline.throwIfAborted();
  return { schema: 'echo-memory/v1', ...result, actions: [] };
}
