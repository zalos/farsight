import type { StringEntry } from './strings.js';

// Sentinel current-tree secret scanning (PR 11): the Gitleaks adapter's limitation keys, skipped-scope reasons and
// the coded failures its worker and its reader report. A failure is never a clean scan. Both registers carry the
// same words until the PR 09 vocabulary freeze.
const same = (text: string, define: string): StringEntry => ({ hud: text, professional: text, define });

export const SENTINEL_SECRETS_STRINGS: Record<string, StringEntry> = {
  'sentinel.secrets.valueWithheld': same('the matched value is withheld', 'A secret scan keeps which detector matched and where, never the value it matched. The value stays only in the captured source, where a person with access can open it.'),
  'sentinel.secrets.lineLocation': same('located to whole lines', 'The location covers the whole lines the detector matched, not the exact characters, so the citation itself cannot reveal any part of the value.'),
  'sentinel.secrets.nameMatch': same('a file name is shaped like a secret', 'The scanner found a value shaped like a secret in a file name itself. The name is withheld; the finding cites the file by its location reference, which the captured source resolves for someone allowed to open it.'),
  'sentinel.secrets.locationOpaque': same('the location is a reference, not a file name', 'Secret scan results never print a file name, because a name can itself hold a secret the scanner cannot recognise out of context. Each file is cited by a reference; the captured source, which stays on this computer, resolves it for someone allowed to open it.'),
  'sentinel.secrets.fileTooLarge': same('a file was too large for the secret scan', 'Files above the scan size limit are not given to the scanner. Each one is listed as a skipped part of the scope, so the scan is partial, never clean.'),
  'sentinel.secrets.pathUnsupported': same('a file name the secret scan cannot carry', 'A file whose name holds a line break or another control character cannot be handed to the scanner. It is listed as a skipped part of the scope, so the scan is partial, never clean.'),
  'sentinel.secrets.toolAllowlisted': same('a file the scanner always skips', 'The scanner\u2019s own default rules skip some paths, such as images, lockfiles and vendored folders, and everything inside a folder whose name they skip. Each such file is listed as a skipped part of the scope rather than counted as scanned.'),
  'sentinel.secrets.toolTimedOut': same('the secret scanner ran out of time', 'The scanner was stopped at its time limit before it finished. The scan counts as not done.'),
  'sentinel.secrets.platformUnmeasured': same('the secret scanner ran on a platform that has not been measured', 'Results are trusted only from the image platform the scanner was qualified on. A run on any other platform is recorded as failed.'),
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
  'sentinel.secrets.outputRefused': same('the secret scanner output was refused', 'The run record and the report must have exactly the expected shape and name the job they were made for. Anything else is refused and the scan is recorded as failed.'),
};

export function sentinelSecretsWord(key: string, values: Record<string, string | number> = {}): string {
  const entry = SENTINEL_SECRETS_STRINGS[key];
  if (!entry) throw new Error(key);
  let text = entry.professional;
  for (const [name, value] of Object.entries(values)) text = text.replaceAll(`{${name}}`, String(value));
  return text;
}
