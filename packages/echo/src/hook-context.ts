import type { EchoContext } from './types.js';
import type { RecallResult } from './memory.js';
import { word } from './words.js';

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/** Keep retrieved records visibly separate from the trusted access instructions. */
export function hookContext(ctx: EchoContext, executable: string, event: 'SessionStart' | 'UserPromptSubmit', result?: RecallResult): object {
  const command = [process.execPath, executable, '--config', ctx.configPath, '--profile', ctx.profileId].map(quote).join(' ');
  const limit = ctx.profile.budget.briefMaxChars;
  const intro = event === 'SessionStart' ? word('hookAccess', { command }) : word('hookPrompt');
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
