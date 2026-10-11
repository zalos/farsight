import type { EchoContext } from './types.js';
import type { RecallResult } from './memory.js';
import { word } from './words.js';

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/** Keep retrieved records visibly separate from the trusted access instructions. */
export function hookContext(ctx: EchoContext, executable: string, event: 'SessionStart' | 'UserPromptSubmit', result?: RecallResult): object {
  const command = [process.execPath, executable, '--config', ctx.configPath, '--profile', ctx.profileId].map(quote).join(' ');
  const limit = ctx.profile.budget.briefMaxChars;
  const intro = word('hookAccess', { command });
  let text = intro.length <= limit ? intro : word('hookAccessShort');
  if (result?.memories.length) {
    const label = `\n${word('hookReference')}\n`;
    if (text.length + label.length >= limit) return { hookSpecificOutput: { hookEventName: event, additionalContext: text } };
    text += label;
    for (const memory of result.memories) {
      const prefix = JSON.stringify({ id: memory.id, title: memory.title, timestamp: memory.timestamp });
      const remaining = limit - text.length - prefix.length - 30;
      if (remaining < 16) break;
      // JSON string encoding prevents line breaks and delimiters in stored content
      // from pretending to be trusted hook instructions. Whole JSON records only.
      let content = memory.content.slice(0, Math.min(remaining, 480));
      let row = `${JSON.stringify({ id: memory.id, title: memory.title, timestamp: memory.timestamp, content })}\n`;
      while (text.length + row.length > limit && content.length) {
        content = content.slice(0, Math.max(0, content.length - 16));
        row = `${JSON.stringify({ id: memory.id, title: memory.title, timestamp: memory.timestamp, content })}\n`;
      }
      if (text.length + row.length <= limit) text += row;
    }
  }
  return { hookSpecificOutput: { hookEventName: event, additionalContext: text.slice(0, limit) } };
}
