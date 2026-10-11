// Agent sessions on the commit spine (round 2026-10-10, proposal 9).
//
// A commit made with an AI assistant says so in its trailers — `Co-Authored-By: <name> <address>` — and the
// address names the assistant: Claude Code writes `noreply@anthropic.com`, other assistants write their own. This
// reads only that: whether a commit names an assistant as a co-author, and the assistant's name as the trailer
// wrote it. It never reads or keeps a session link (a `Claude-Session:` or any other URL trailer): the repository
// may be public, and which session made which commit is the owner's private record.
//
// Pure: a commit message in, a name or null out. The git reader (`parsers/src/shared/git.ts commitInputsOf`)
// calls it once per commit and the snapshot store keeps the name in `commit.agent`.

/**
 * The co-author addresses an AI assistant writes, matched on the address only (the name is free text a person
 * could also write). A bot that is not an assistant — a CI account, a dependency updater — is not here.
 */
export const AGENT_ADDRESSES: readonly { pattern: RegExp; assistant: string }[] = [
  { pattern: /@anthropic\.com$/i, assistant: 'Claude' },
  { pattern: /@openai\.com$/i, assistant: 'Codex' },
  { pattern: /(^|[+.])copilot@users\.noreply\.github\.com$/i, assistant: 'Copilot' },
  { pattern: /^copilot@github\.com$/i, assistant: 'Copilot' },
  { pattern: /@cursor\.(com|sh)$/i, assistant: 'Cursor' },
  { pattern: /@aider\.chat$/i, assistant: 'Aider' },
  { pattern: /devin-ai-integration/i, assistant: 'Devin' },
  { pattern: /gemini-code-assist|@gemini\.google\.com$/i, assistant: 'Gemini' },
];

/** One trailer line: `Co-Authored-By: Name <address>` in any letter case, at the start of a line. */
const TRAILER = /^co-authored-by:\s*(.*?)\s*<([^>\s]+)>\s*$/gim;

/**
 * The assistant a commit message names as a co-author — the trailer's own name (*Claude Opus 5.5*), else the
 * assistant the address belongs to — or null when no co-author is an assistant. The first assistant wins; a
 * commit made with two assistants is rare and its first trailer is the one the tool wrote.
 */
export function agentOfMessage(message: string | undefined | null): string | null {
  if (!message) return null;
  TRAILER.lastIndex = 0;
  for (let m = TRAILER.exec(message); m; m = TRAILER.exec(message)) {
    const name = (m[1] ?? '').trim();
    const address = (m[2] ?? '').trim();
    const hit = AGENT_ADDRESSES.find((a) => a.pattern.test(address));
    if (!hit) continue;
    // a URL is never a name: a session link written into the name field is not kept
    const clean = name.replace(/https?:\/\/\S+/g, '').trim();
    return clean || hit.assistant;
  }
  return null;
}
