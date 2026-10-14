import type { EchoContext } from './types.js';
import type { RecallResult } from './memory.js';
import { word } from './words.js';
import { submindSettings } from './config.js';
import type { HookBriefResult, HookResearchBinding } from './hook-research.js';

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/** Keep retrieved records visibly separate from the trusted access instructions. */
export function hookContext(ctx: EchoContext, executable: string, event: 'SessionStart' | 'UserPromptSubmit', result?: RecallResult): object {
  const command = [process.execPath, executable, '--config', ctx.configPath, '--profile', ctx.profileId].map(quote).join(' ');
  const limit = ctx.profile.budget.briefMaxChars;
  const access = submindSettings(ctx.profile).hookResearch === 'background' ? 'hookCuratorAccess' : 'hookAccess';
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
        ? word('memoryProvenance', { workspace: memory.provenance.workspace, commit: memory.provenance.commit ?? word('memoryCommitUnknown'), date: memory.provenance.savedAt })
        : word('memoryProvenanceUnknown');
      const row = (content: string): string => `\n${JSON.stringify({ id: memory.id, title: memory.title, timestamp: memory.timestamp, provenance, content })}`;
      const remaining = rowLimit - text.length;
      if (row('').length >= remaining) { omitted = true; continue; }
      // JSON string encoding prevents line breaks and delimiters in stored content
      // from pretending to be trusted hook instructions. Whole JSON records only.
      let low = 0; let high = Math.min(memory.content.length, 480);
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
  const actions = result.actions.filter(action => action.rel === 'poll' && action.operation === 'memory.brief');
  const row = `\n${JSON.stringify({ schema: result.schema, requestId: result.requestId, status: result.status, actions })}`;
  for (const intro of [word('hookCuratorPrompt'), word('hookAccessShort')]) {
    if (intro.length + row.length <= limit) return { text: intro + row, fits: true };
  }
  return { text: `${word('hookAccessShort')}\n${word('hookTruncated')}`, fits: false };
}

/** Refuse paid work when the main agent cannot receive its complete retrieval handle. */
export function canFitHookResearch(ctx: EchoContext, binding: HookResearchBinding): boolean {
  const requestId = 'x'.repeat(32);
  return researchHookText(ctx, { schema: 'echo-hook-brief/v1', requestId, status: 'pending', actions: [
    { rel: 'poll', operation: 'memory.brief', arguments: { ...binding, requestId } },
  ] }).fits;
}

/** Background hooks send an engine-created handle, never the model's evidence or full result. */
export function hookResearchContext(ctx: EchoContext, result: HookBriefResult): object {
  return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: researchHookText(ctx, result).text } };
}
