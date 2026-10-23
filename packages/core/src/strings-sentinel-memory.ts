import type { StringEntry } from './strings.js';

const same = (text: string, define: string): StringEntry => ({ hud: text, professional: text, define });
// Detail vocabulary, deliberately separate from the closed execution error-code catalog.
export const SENTINEL_MEMORY_STRINGS: Record<string, StringEntry> = {
  'sentinel.execution.memoryWitness.local': same('the container reached its memory limit and an out-of-memory kill was observed', 'The exact owned container’s local kernel counters increased for limit pressure, out-of-memory handling and a killed process. This records both observations; it does not prove that a particular local limit event caused that kill. The runtime may still report no memory kill.'),
  'sentinel.execution.memoryWitness.runtime': same('the container runtime reported an out-of-memory kill', 'The runtime reported an out-of-memory kill for the exact owned container. Its raw state is retained separately from any kernel-counter observation.'),
};
