import type { EchoContext } from './types.js';
import type { RecallResult } from './memory.js';
import { word } from './words.js';
import { submindSettings } from './config.js';
import type { HookBriefResult, HookResearchBinding } from './hook-research.js';
import type { SubmindFinding } from './submind-types.js';

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/** Keep retrieved records visibly separate from the trusted access instructions. */
export function hookContext(
  ctx: EchoContext,
  executable: string,
  event: 'SessionStart' | 'UserPromptSubmit',
  result?: RecallResult,
): object {
  const command = [process.execPath, executable, '--config', ctx.configPath, '--profile', ctx.profileId]
    .map(quote)
    .join(' ');
  const limit = ctx.profile.budget.briefMaxChars;
  const access = submindSettings(ctx.profile).hookResearch !== 'manual' ? 'hookCuratorAccess' : 'hookAccess';
  const intro = event === 'SessionStart' ? word(access, { command }) : word('hookPrompt');
  let text = intro.length <= limit ? intro : word('hookAccessShort');
  if (result) {
    const notice = `\n${word('hookTruncated')}`;
    // Reserve the omission notice before rows: truncation is never silent, even
    // when the entire requested memory cannot fit the configured brief budget.
    const rowLimit = limit - notice.length;
    if (text.length > rowLimit) text = word('hookAccessShort');
    let omitted = result.truncated;
    for (const memory of result.memories) {
      const provenance = memory.provenance
        ? word('memoryProvenance', {
            workspace: memory.provenance.workspace,
            commit: memory.provenance.commit ?? word('memoryCommitUnknown'),
            date: memory.provenance.savedAt,
          })
        : word('memoryProvenanceUnknown');
      const row = (content: string): string =>
        `\n${JSON.stringify({ id: memory.id, title: memory.title, timestamp: memory.timestamp, provenance, content })}`;
      const remaining = rowLimit - text.length;
      if (row('').length >= remaining) {
        omitted = true;
        continue;
      }
      // JSON string encoding prevents line breaks and delimiters in stored content
      // from pretending to be trusted hook instructions. Whole JSON records only.
      let low = 0;
      let high = Math.min(memory.content.length, 480);
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (row(memory.content.slice(0, middle)).length <= remaining) low = middle;
        else high = middle - 1;
      }
      text += row(memory.content.slice(0, low));
      omitted ||= low < memory.content.length;
    }
    if (omitted) text += notice;
  }
  return { hookSpecificOutput: { hookEventName: event, additionalContext: text } };
}

function researchHookText(ctx: EchoContext, result: HookBriefResult): { text: string; fits: boolean } {
  const limit = ctx.profile.budget.briefMaxChars;
  const actions = result.actions.filter((action) => action.rel === 'poll' && action.operation === 'memory.brief');
  const receipt = { schema: result.schema, requestId: result.requestId, status: result.status, actions };
  const brief = result.result;
  if (submindSettings(ctx.profile).hookResearch === 'wait' && result.status === 'ready' && brief?.findings.length) {
    const findings: SubmindFinding[] = [];
    let fitted: string | undefined;
    // Keep complete findings and engine-validated references. Provider metadata,
    // evidence, usage and source contents never enter the main agent's context.
    for (const finding of brief.findings) {
      findings.push({
        problem: finding.problem,
        fix: finding.fix,
        why: finding.why,
        citations: finding.citations.map(({ id, revision }) => ({ id, revision })),
      });
      const included = new Set(findings.flatMap((item) => item.citations.map((c) => `${c.id}:${c.revision}`)));
      const more = findings.length < brief.findings.length;
      const row = `\n${JSON.stringify({
        ...receipt,
        result: {
          schema: brief.schema,
          status: more ? 'partial' : brief.status,
          mode: brief.mode,
          findings,
          actions: brief.actions
            .filter((action) => included.has(`${action.arguments.id}:${action.arguments.revision}`))
            .map((action) => ({
              rel: action.rel,
              operation: action.operation,
              arguments: { id: action.arguments.id, revision: action.arguments.revision },
            })),
          coverage: { ...brief.coverage, truncated: brief.coverage.truncated || more },
        },
      })}`;
      const intro = word('hookCuratorReady');
      if (intro.length + row.length > limit) break;
      fitted = intro + row;
    }
    if (fitted) return { text: fitted, fits: true };
  }
  const row = `\n${JSON.stringify(receipt)}`;
  for (const intro of [word('hookCuratorPrompt'), word('hookAccessShort')]) {
    if (intro.length + row.length <= limit) return { text: intro + row, fits: true };
  }
  return { text: `${word('hookAccessShort')}\n${word('hookTruncated')}`, fits: false };
}

/** Refuse paid work when the main agent cannot receive its complete retrieval handle. */
export function canFitHookResearch(ctx: EchoContext, binding: HookResearchBinding): boolean {
  const requestId = 'x'.repeat(32);
  return researchHookText(ctx, {
    schema: 'echo-hook-brief/v1',
    requestId,
    status: 'pending',
    actions: [{ rel: 'poll', operation: 'memory.brief', arguments: { ...binding, requestId } }],
  }).fits;
}

/** Return a bounded curated brief in wait mode, otherwise a complete retrieval handle. */
export function hookResearchContext(ctx: EchoContext, result: HookBriefResult): object {
  return {
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: researchHookText(ctx, result).text },
  };
}
