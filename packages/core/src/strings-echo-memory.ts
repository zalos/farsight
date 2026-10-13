import type { StringEntry } from './strings.js';
const same = (word: string, define: string): StringEntry => ({ hud: word, professional: word, define });

export const ECHO_MEMORY_STRINGS: Record<string, StringEntry> = {
  'echo.memory.busy': same('Echo is already researching a question for this profile. Try again shortly.', 'One research job runs per profile service. Additional requests are refused rather than starting competing model work.'),
  'echo.memory.unavailable': same('Echo memory is unavailable. Start Echo for this profile and try again.', 'The local bridge must be running before another process can read or save memory.'),
  'echo.memory.input': same('The memory request is invalid or too large.', 'Echo accepts bounded text, topic labels and a recall limit from one to five. Requests cannot choose their own identity or memory store.'),
  'echo.memory.credential': same('This memory looks like a credential. Keep secrets in the keychain instead.', 'Shared memories refuse the same credential shapes as pinned lessons. Refusal messages never repeat the supplied value.'),
  'echo.memory.stale': same('Echo settings changed. Restart Echo and begin a new agent session.', 'A bridge is bound to the identity, store and model configuration with which it started.'),
  'echo.memory.ownership': same('Echo could not verify ownership of its local memory connection.', 'The private connection directory and socket must belong to the current operating-system user, with no access for other users.'),
  'echo.memory.running': same('Echo memory is already running for this profile.', 'A second bridge cannot replace or stop an existing listener.'),
  'echo.memory.response': same('The memory service returned an invalid response.', 'Echo refuses responses whose shape or identity does not match the selected profile. Errors do not include stored content.'),
  'echo.memory.timeout': same('Echo memory did not respond in time.', 'Each memory request has a fixed deadline. Hooks can continue without waiting for memory.'),
  'echo.memory.externalReadOnly': same('Saving memories currently requires a managed Echo profile.', 'This release permits scoped reads from an external backend. External writes are deferred because upstream memory supersession can alter unscoped records.'),
};

/** The independent Echo package imports its catalog without the graph runtime. */
export function echoMemoryWord(key: string): string {
  const entry = ECHO_MEMORY_STRINGS[`echo.memory.${key}`];
  if (!entry) throw new Error(key);
  return entry.professional;
}
