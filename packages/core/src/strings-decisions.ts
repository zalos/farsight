// Declared decisions, work done outside the code, parties, and cited documents quoted (the 2026-10-13 outsider round,
// F8 + F11): the words for a decision the team made or left open and where the code names it, a step a person or a
// partner does on purpose outside the app — drawn apart from a screen that is designed and not built — a counterparty
// no code reaches, and a document's first paragraph quoted where something cites it. Spread into STRINGS in
// strings.ts like strings-doors.ts. Same rules as the rest of the catalog: both registers, a define on every word,
// defines in plain words (no backticks, no markdown, no dotted identifiers, no placeholders in a define).
import type { StringEntry } from './strings.js';

function same(word: string, define?: string): StringEntry {
  return define ? { hud: word, professional: word, define } : { hud: word, professional: word };
}
function one(word: string, pluralKey: string): StringEntry {
  return { hud: word, professional: word, singularOf: pluralKey };
}

export const DECISION_STRINGS: Record<string, StringEntry> = {
  // the counts
  'count.unit.decisions': same('{n} decisions', 'Decisions the team declared in a design manifest or a config file, and decisions the code names in a comment that nothing declares. Each is counted once, however many places name it.'),
  'count.unit.decisionsOne': one('1 decision', 'count.unit.decisions'),
  'count.part.decisionsOpen': same('{n} open', 'Declared decisions the team has not made yet: the code works one way until somebody decides.'),
  'count.part.decisionsDecided': same('{n} decided', 'Declared decisions the team has made, with the date it gave.'),
  'count.part.decisionsCodeOnly': same('{n} named in code, not declared', 'Decision names a comment in the code uses that no manifest or config declares, so their title, state and owner are unknown here.'),
  'count.part.decisionsCited': same('{n} named in code', 'Decisions a comment in the code names, on or above the code the decision governs.'),
  'count.part.decisionsUncited': same('{n} not named in code', 'Declared decisions no comment in the code names; they may still bear on a screen the declaration lists.'),
  'count.unit.offPlatform': same('{n} done outside the code', 'Things the design says somebody does outside the application on purpose: a person, a partner or another system. They are not screens waiting to be built, they have no gate and no test can reach them.'),
  'count.unit.offPlatformOne': one('1 done outside the code', 'count.unit.offPlatform'),
  'count.part.offPlatformPerson': same('{n} by a person', 'Done by a person by hand, outside the application.'),
  'count.part.offPlatformPartner': same('{n} by a partner', 'Done by a partner organisation outside the application.'),
  'count.part.offPlatformExternal': same('{n} by another system', 'Done by another system the application does not call.'),
  'count.unit.parties': same('{n} parties', 'Counterparties the team declared that the application hands work to outside its code, such as a payment partner or the client. No code reaches them.'),
  'count.unit.partiesOne': one('1 party', 'count.unit.parties'),

  // the chip and the card
  'decision.chip.open': same('pending decision {id} · {title}', 'A decision the team has declared and not made yet bears on this. The code works one way until somebody decides; the card says who owns it and quotes the team’s words.'),
  'decision.chip.decided': same('decided {id} · {title}', 'A decision the team has declared and made bears on this. The card quotes the team’s words and says when.'),
  'decision.chip.unknown': same('decision {id} · named in code', 'A comment in the code names a decision here that no manifest or config declares, so its title, state and owner are unknown.'),
  'decision.card.title': same('decision', 'A choice the team declared, in its own words. It is a declaration, shown as one: it never changes what the code was found to do.'),
  'decision.state.open': same('open — not decided yet', 'The team has not made this decision. Whatever the code does here is how it works until somebody decides.'),
  'decision.state.decided': same('decided {date}', 'The team made this decision on the date it gave.'),
  'decision.state.decidedNoDate': same('decided', 'The team made this decision; it gave no date.'),
  'decision.state.codeOnly': same('named in code, not declared', 'A comment in the code names this decision, and no manifest or config declares it: its title, state and owner are unknown here.'),
  'decision.owner': same('owner · {owner}', 'Who the team says owns this decision.'),
  'decision.ownerNone': same('no owner named', 'The declaration names nobody who owns this decision.'),
  'decision.said': same('in the team’s words', 'The summary the team wrote in its declaration, quoted as written.'),
  'decision.quoted': same('quoted from {path}', 'The text above is copied from this document as written: its heading and its first paragraph. Nothing is summarised or reworded.'),
  'decision.code': same('named in the code', 'The places a comment in the code names this decision, on or above the code it governs.'),
  'decision.affects': same('bears on', 'Screens and parts the declaration says this decision bears on.'),
  'decision.declaredIn': same('declared in {path}', 'The manifest or config file the decision’s words come from.'),
  'decision.openDoc': same('open the document', 'Opens the document the decision cites in the editor.'),
  'decision.openCode': same('open the code', 'Opens the line the decision is named on in the editor.'),
  'decision.none': same('no decision is declared for this', 'No declared decision lists this, and no comment in the code names one here.'),
  'decision.above': same('above {symbol}', 'The comment sits above this constant; a call that runs only when it is set carries the decision.'),

  // work done outside the code
  'offPlatform.chip': same('done outside the code', 'The design says somebody does this outside the application on purpose. It is not a screen waiting to be built: it has no gate, and no test can reach it.'),
  'offPlatform.by.person': same('done by a person', 'A person does this by hand, outside the application.'),
  'offPlatform.by.partner': same('done by a partner', 'A partner organisation does this, outside the application.'),
  'offPlatform.by.external': same('done by another system', 'Another system does this; the application does not call it.'),
  'offPlatform.byWho': same('done by {who}', 'Who the design says does this, outside the application.'),
  'offPlatform.where': same('where · {where}', 'Where it happens, in the team’s words.'),
  'offPlatform.noTest': same('no test can reach it', 'No test can reach something the application does not do. This is not an absence of tests: there is no code here to test.'),
  'offPlatform.declared': same('the design says', 'This comes from the design manifest, as written; the code was not read for it.'),

  // parties
  'party.lane.sub': same('a party · no code reaches it', 'A counterparty the team declared. The application hands work to it outside its code, so no call reaches it and nothing here is a guess about how it works.'),
  'party.lane.count': same('{n} done here', 'Things the design says this party does outside the application, drawn in its lane.'),
  'party.lane.countOne': one('1 done here', 'party.lane.count'),
  'party.declared': same('declared, no code reaches it', 'The team declared this party in its config file. No code calls it.'),
  'lanes.legend.offPlatform': same('done outside the code', 'A dotted card is something the design says a person, a partner or another system does outside the application. It is not a screen waiting to be built.'),
  'lanes.part.partyLanes': same('{n} for a party', 'Lanes of the counterparties the design says do something here outside the application.'),

  // the walk's stop for it (core tour.ts)
  'tour.kind.offPlatform': same('done outside the code', 'A stop on something the design says a person, a partner or another system does outside the application: who does it and where. It has no gate and no test can reach it.'),
  'tour.off.who': same('{who} does this outside the app.', 'The design says this is done outside the application, by whom it names. The walk prints it as declared; no code was read for it.'),
  'tour.off.whoWhere': same('{who} does this outside the app — {where}.', 'The design says this is done outside the application, by whom and where it names. The walk prints it as declared; no code was read for it.'),
  'tour.off.party': same('{party} is a party the team declared; no code reaches it.', 'A counterparty the team declared in its config file. The application hands work to it outside its code.'),
  'tour.off.partyRole': same('{party} is a party the team declared — {role}; no code reaches it.', 'A counterparty the team declared in its config file, with what it does in the team’s words. The application hands work to it outside its code.'),
  'tour.off.noTest': same('No test can reach it: there is no code here to test.', 'Something done outside the application has no code, so no test can reach it. This is not a missing test.'),
  'tour.off.sub': same('done outside the code · on {screen}', 'This stop is something the design says is done outside the application, on this screen of the journey.'),
  'count.part.tourOffPlatform': same('{n} done outside the code', 'Stops for things the design says a person, a partner or another system does outside the application.'),

  // cited documents
  'doc.quoted': same('quoted from {path}', 'The heading and the first paragraph are copied from this document as written. Nothing is summarised or reworded.'),
  'doc.status': same('status · {status}', 'The status line the document gives itself, as written.'),
  'doc.cut': same('… the paragraph goes on in the document', 'The first paragraph is longer than the card shows; it was cut between two words, never reworded. The document has the rest.'),
};
