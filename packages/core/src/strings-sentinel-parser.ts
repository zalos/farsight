import type { StringEntry } from './strings.js';

// Sentinel parser evidence (PR 05): why a parse was refused, how each captured entry's parser outcome is classed, and
// how each recorded parser read reconciled. Each key is the stable code a ParserError, a joined entry or a reconciled
// input carries. Both registers carry the same words until the PR 09 vocabulary freeze, as in strings-sentinel-capture.ts.
const same = (text: string, define: string): StringEntry => ({ hud: text, professional: text, define });

export const SENTINEL_PARSER_STRINGS: Record<string, StringEntry> = {
  // ---- refusals ----
  'sentinel.parse.invalidRequest': same('the parse request is not valid: {detail}', 'A parse names an admitted snapshot, a canonical private working folder, the parser selection stated in full and every limit. Application enrichment options are refused.'),
  'sentinel.parse.integrity': same('the parser\'s reads do not match the snapshot: {detail}', 'The parser has no reader hook, so its recorded reads and the private copy it read are checked afterwards. A read that cannot be explained by the captured snapshot, or a copy that changed, means the result cannot be trusted, so nothing is kept.'),
  'sentinel.parse.artifactTooLarge': same('the parser\'s output is larger than the largest object the store keeps: {detail}', 'The complete analysis is kept as one stored object. This one is over the limit, so it is refused before anything is written. Parse fewer sources or a narrower selection.'),
  // ---- how a captured entry's parser outcome is classed ----
  'sentinel.parseClass.parsed': same('parsed', 'The parser read this captured file and finished it. That is syntax evidence only; it does not mean any check passed.'),
  'sentinel.parseClass.parseFailed': same('the parser could not read this file', 'The parser selected this captured file and failed on it, usually a syntax error. Its diagnostics say why and give a line only when the parser reported one.'),
  'sentinel.parseClass.parserSkipped': same('the parser skipped this file', 'The parser selected this captured file but stopped before finishing it, for example at a size, file-count or time limit. Its reason is recorded.'),
  'sentinel.parseClass.notSelected': same('the parser did not select this file', 'The file was captured, but the parser does not read its kind or its selection left it out, for example an ignored path or a workflow file. It stays in scope as a file no parser read.'),
  'sentinel.parseClass.notCaptured': same('not captured, so not parsed', 'Capture recorded this entry without its bytes (excluded, refused, unreadable, too large or a link). The capture\'s reason takes precedence.'),
  'sentinel.parseClass.unknownScope': same('a folder whose contents were not listed', 'Capture did not list this folder\'s contents, so how many files it holds is unknown, not zero.'),
  // ---- how a recorded parser read reconciled ----
  'sentinel.parseInput.contentCaptured': same('read the captured bytes', 'The parser read a file whose bytes equal the captured file\'s.'),
  'sentinel.parseInput.directoryListed': same('listed a captured folder', 'The parser listed a folder whose names equal the captured folder\'s.'),
  'sentinel.parseInput.metadataMatched': same('checked a captured file or folder', 'The parser checked whether this path is a file or a folder, and the captured copy agrees.'),
  'sentinel.parseInput.missingVerifiedAbsent': same('looked for a path that is not in the snapshot', 'The parser looked for this path (for example an import candidate) and it is absent. Its folder was listed in full at capture, so the absence is verified.'),
  'sentinel.parseInput.missingRecordedRefusal': same('looked for a path capture recorded without its bytes', 'The path existed at capture but was recorded without its bytes, so the parser could not read it. What it would have resolved to is unknown.'),
  'sentinel.parseInput.missingUnderBoundary': same('looked inside a folder capture did not list', 'The path is below a folder whose contents capture did not list, so whether it exists is unknown.'),
  'sentinel.parseInput.missingInGitlink': same('looked inside a submodule held only as a link', 'The path is inside a submodule this snapshot records as a pinned commit, not as files, so whether it exists is unknown.'),
};

export function sentinelParserWord(key: string, values: Record<string, string | number> = {}): string {
  const entry = SENTINEL_PARSER_STRINGS[key];
  if (!entry) throw new Error(key);
  let text = entry.professional;
  for (const [name, value] of Object.entries(values)) text = text.replaceAll(`{${name}}`, String(value));
  return text;
}
