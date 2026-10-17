// The business register's words for what the app wrote (outsider round 2026-10-13, F6). Spread into STRINGS in strings.ts.
//
// A sentence somebody wrote keeps its words in the business register and loses its code — never leaving a hole where
// the code stood: a screen's design id becomes the screen's name, a refusal message's hole says *(a value)*, an HTTP
// refusal is said in words with its code only in the hybrid and code registers, and a schema check is named by the
// record its form checks.
import type { StringEntry } from './strings.js';

function same(word: string, define: string): StringEntry {
  return { hud: word, professional: word, define };
}

export const PLAIN_STRINGS: Record<string, StringEntry> = {
  'plain.aPage': same('a page', 'A screen the sentence names by a design id this graph does not hold. The id is left out and the sentence keeps its place.'),
  'plain.aValue': same('(a value)', 'The message the code refuses with is built from a value it only knows when it runs — the record’s status, a name. The value is not written in the code, so it is not printed.'),
  'plain.refused': same('the request is refused', 'What the code does when this does not hold: it turns the request down, with an answer that says why. The status code it answers with is shown in the hybrid and code registers.'),
  'plain.refusedCode': same('refused ({code})', 'What the code does when this does not hold: it turns the request down with this status code.'),
  'plain.schema': same('the {name} form’s rules', 'A schema check: the rules the data sent with a request must meet — which fields, which shapes — before the action goes through. Named here by the form it checks.'),
  'plain.mustBe': same('{record} {field} must be {value}', 'A check the code makes on a record before the action goes through: the field must hold this value.'),
};
