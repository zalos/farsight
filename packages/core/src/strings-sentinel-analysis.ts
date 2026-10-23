import type { StringEntry } from './strings.js';

// Sentinel's analysis evidence (PR 18): bounded static call paths and imported deep-analysis results. Each key is a
// stable reason or limitation code. Both registers carry the same words until the PR 09 vocabulary freeze.
const same = (text: string, define: string): StringEntry => ({ hud: text, professional: text, define });

export const SENTINEL_ANALYSIS_STRINGS: Record<string, StringEntry> = {
  // ---- bounded call paths ----
  'sentinel.paths.budgetExceeded': same('the structural search stopped at its work limit', 'The shared input, retained-byte, traversal, output or time allowance was exhausted. No partial search is accepted as a completed result.'),
  'sentinel.paths.rule.callReachability': same('bounded structural call reachability', 'A retained bounded call-path query result includes a reached, no-path or frontier outcome in the captured parser graph. It never establishes data flow, security enforcement or clearance.'),
  'sentinel.paths.unresolvedCall': same('the search met a call it cannot follow', 'The parser could not tell what a call reaches, or it reaches something outside the analysed graph. The search stops there, so it cannot say whether a path continues through it.'),
  'sentinel.paths.fanoutLimit': same('a function calls more places than the search follows', 'A function has more outgoing calls than the search bound allows; the calls past the bound were not followed, so a path through them is not ruled out.'),
  'sentinel.paths.depthLimit': same('the search reached its depth bound', 'Paths longer than the depth bound were not explored, so a longer path is not ruled out.'),
  'sentinel.paths.visitLimit': same('the search reached its visit bound', 'The search stopped after visiting as many functions as its bound allows, so a path through the rest is not ruled out.'),
  'sentinel.paths.analysisIncomplete': same('the parser analysis is not complete', 'The parser did not analyse every selected file, so calls in the files it skipped are missing from the graph and a path through them is not ruled out.'),
  'sentinel.paths.unknownNode': same('a start or end of the query is not in the graph', 'The query names something the parser analysis does not contain, so nothing can be said about a path between them.'),
  'sentinel.paths.inactiveEdge': same('the search skipped a call that is switched off', 'The parser read a call under a constant that switches it off. It is not followed; if that constant changes, a path through it is possible.'),
  'sentinel.paths.notDataFlow': same('a call path is not a data flow', 'A path shows that one function can call its way to another. It does not show that any value travels along it, that input reaches the end unchanged, or that anything is or is not checked on the way.'),
  'sentinel.paths.graphOnly': same('only the parser graph is searched', 'The search reads the calls the public parser recorded. Calls it could not see, made at run time or through reflection, are not in the graph, so even a complete search is a statement about the graph only.'),
  'sentinel.paths.deferredStep': same('a call on the path happens in a callback stored for later', 'A call on the path is made inside a function kept for later use, such as a hook, so it may not run as part of the same request.'),
  'sentinel.paths.siteUnplaced': same('a call on the path has no exact location in the captured source', 'The parser gave no exact byte range for a call on this path, so that call cannot be cited.'),
  'sentinel.paths.unrecordedCall': same('a function makes calls the graph does not record', 'A function on the search has more places that could be calls than the parser recorded: a computed call, a call on a value of unknown type or a global function. Where those go is not in the graph, so a path through them is not ruled out.'),
  'sentinel.paths.functionAsValue': same('a function is handed on as a value', 'A function on the search passes or returns another function without calling it there. Whoever calls it later is not in the graph, so a path through it is not ruled out.'),
  'sentinel.paths.bodyUnread': same('a function\'s source could not be read in full', 'The parser gave no exact whole-line location for a function on the search, so whether the graph records all of its calls cannot be checked.'),
  'sentinel.paths.shadowedCall': same('a call may go to a local function of the same name', 'The parser linked a call to a top-level function, but the calling function has a parameter or local of that name, which may be what is really called. The search does not follow the link, so a path through it is not ruled out.'),
  'sentinel.paths.escapedIdentifier': same('a function spells a name with an escape', 'A function on the search writes a name with a Unicode escape, which can stand for any identifier. Which functions it calls, binds or hands on cannot be read lexically, so none of its calls is followed and a path through it is not ruled out.'),
  'sentinel.paths.invalidInput': same('the path request is not valid', 'The request names no parser evidence, more queries than allowed, a query without two different ends, or bounds outside their limits.'),
  'sentinel.paths.unbound': same('the parser evidence is for another snapshot', 'Paths are computed only over the parser evidence of the snapshot and source the request names, whose index and analysis are the same parser run.'),
  // ---- imported deep-analysis results ----
  'sentinel.deep.malformed': same('the imported document is not valid', 'The document is not valid UTF-8, is too large, or does not match the import contract, so nothing in it is used.'),
  'sentinel.deep.notOwnerConfirmed': same('the owner has not confirmed this import', 'Imported analysis is used only when the owner confirmed exactly this document, with its tool, version, licence terms, provenance and configuration, for exactly this snapshot. Who the document says attested it counts for nothing on its own, so none of its results are used.'),
  'sentinel.deep.unbound': same('the imported results are not about this source', 'The document names another snapshot or source, or says it read files that differ from the captured ones, so its results are not about this source.'),
  'sentinel.deep.fileNotCaptured': same('the tool read a file that was not captured', 'A file the document says the tool read is not a captured file of this source.'),
  'sentinel.deep.contentMismatch': same('the tool read different bytes than were captured', 'The document says the tool read a file whose content differs from the captured bytes.'),
  'sentinel.deep.contentUnverified': same('the captured bytes could not be confirmed', 'The bytes read for a file the import cites do not hash to its captured content id or do not have its captured length, so no location in it is accepted.'),
  'sentinel.deep.locationOutOfRange': same('an imported location is outside its file', 'A location in a flow points past the end of the captured file or is empty, so the flow is not used.'),
  'sentinel.deep.locationNotRead': same('an imported location is in a file the tool did not read', 'A flow points into a file the document does not list among the files the tool read, so the flow is not used.'),
  'sentinel.deep.importedNotExecuted': same('imported, not run by Sentinel', 'This result was produced by a tool the customer ran and imported here. It never counts as a check Sentinel executed.'),
  'sentinel.deep.toolScopeOnly': same('the result holds only within the tool\'s stated scope', 'The imported result is the tool\'s claim over exactly the files and configuration it says it read. It says nothing about other files or other configurations.'),
  'sentinel.deep.buildStated': same('the tool says it built or ran the project', 'The document states that the analyzer built or ran the project. That is recorded as stated; Sentinel did neither.'),
};
