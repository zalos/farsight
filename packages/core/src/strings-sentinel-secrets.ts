import type { StringEntry } from './strings.js';

// Sentinel current-tree secret scanning (PR 11): the Gitleaks adapter's limitation keys, skipped-scope reasons and
// the coded failures its worker and its reader report. A failure is never a clean scan. Both registers carry the
// same words until the PR 09 vocabulary freeze.
const same = (text: string, define: string): StringEntry => ({ hud: text, professional: text, define });

export const SENTINEL_SECRETS_STRINGS: Record<string, StringEntry> = {
  'sentinel.secrets.valueWithheld': same('the matched value is withheld', 'A secret scan keeps which detector matched and where, never the value it matched. The value stays only in the captured source, where a person with access can open it.'),
  'sentinel.secrets.lineLocation': same('located to whole lines', 'The location covers the whole lines the detector matched, not the exact characters, so the citation itself cannot reveal any part of the value.'),
  'sentinel.secrets.fileTooLarge': same('a file was too large for the secret scan', 'Files above the scan size limit are not given to the scanner. Each one is listed as a skipped part of the scope, so the scan is partial, never clean.'),
  'sentinel.secrets.inputInvalid': same('the secret scan input was not acceptable', 'The list of captured files handed to the scanner did not match the files supplied with it. The scan did not run and nothing was reported as clean.'),
  'sentinel.secrets.protocolInvalid': same('the secret scanner worker received an unexpected message', 'The scanner worker expects one greeting and one start message. Anything else stops it before it scans.'),
  'sentinel.secrets.toolFailed': same('the secret scanner failed', 'The scanner ended with an error, was stopped, or wrote more output than allowed. Its own messages are discarded because they can quote what it read. The scan counts as not done.'),
  'sentinel.secrets.reportMissing': same('the secret scanner wrote no report', 'A scan that leaves no report has not shown that it found nothing, so it is recorded as failed.'),
  'sentinel.secrets.reportTooLarge': same('the secret scanner report was too large', 'Reports above the size limit are refused unread rather than cut short, so the scan is recorded as failed.'),
  'sentinel.secrets.reportMalformed': same('the secret scanner report could not be read', 'Every entry in the report needs a detector name, a file and its lines. A report that does not have them is refused and the scan is recorded as failed.'),
  'sentinel.secrets.reportInconsistent': same('the secret scanner result and its report disagree', 'The scanner said it found something but reported nothing, or the reverse. Neither is trusted, so the scan is recorded as failed.'),
  'sentinel.secrets.tooManyFindings': same('the secret scanner reported more findings than the limit', 'Findings above the limit would have to be dropped, so the whole scan is recorded as failed instead of shown incomplete.'),
  'sentinel.secrets.unknownFile': same('the secret scanner reported a file that was not captured', 'Each reported file must be one of the captured files. A report naming anything else is refused.'),
  'sentinel.secrets.locationOutOfRange': same('the secret scanner reported lines a file does not have', 'A location outside the captured file cannot be cited, so the report is refused.'),
  'sentinel.secrets.workerError': same('the secret scanner worker stopped unexpectedly', 'The worker hit an error it does not name. Only this code is kept, because an error message can quote what it read. The scan counts as not done.'),
  'sentinel.secrets.outputRefused': same('a secret scan observation was refused', 'Every observation is checked again outside the container: it may name the detector and cite whole lines of a captured file, and nothing else. One that carries anything more is refused and the scan is recorded as failed.'),
  'sentinel.secrets.coverageMismatch': same('the secret scan did not account for every captured file', 'Each captured file must be either scanned or listed as skipped with a reason. A file the result does not mention would be a silent gap, so the scan is recorded as failed.'),
};

export function sentinelSecretsWord(key: string, values: Record<string, string | number> = {}): string {
  const entry = SENTINEL_SECRETS_STRINGS[key];
  if (!entry) throw new Error(key);
  let text = entry.professional;
  for (const [name, value] of Object.entries(values)) text = text.replaceAll(`{${name}}`, String(value));
  return text;
}
