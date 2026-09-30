# Doc-comment pass — vanilla JSDoc/TSDoc/Javadoc harvesting + one business vocabulary

Status: accepted, in progress (2026-07-21)
Builds on: [journey-forks-splice.md](journey-forks-splice.md) (branch points as graph facts).

## Problem

Farsight reads exactly five custom tags (`@business @group @tag @guard @entrypoint`)
and throws away everything else in a doc comment. That means:

1. **A well-documented codebase with zero Farsight tags gets no business lens.**
   Ordinary Javadoc/JSDoc/TSDoc summaries — which most mature codebases already
   have — are exactly the plain-language translation the business lens needs,
   but we only use them as raw `docs` text, never as the business description.
2. **Forks are business-opaque.** Journey pass 2 made branch points first-class,
   but a condition reads as `speed >= 98` in every lens. There is no way to say
   "when the recall is high-severity" next to the gate that decides it.
3. **No cross-ecosystem story.** The tag vocabulary is defined implicitly by
   `parseDoc()` in the TS/JS adapter. A future Java adapter has no spec to
   implement against, and users have no guide for making their existing doc
   conventions light up in Farsight.

## The determination: default tags where they exist, one custom vocabulary where they don't

Research across the three dialects (this is the decision the pass encodes):

- **No dialect has a vanilla tag meaning "business translation", "logical
  group", "auth guard", or "entry point".** These stay custom. Custom block
  tags are the *sanctioned* extension mechanism in all three ecosystems —
  JSDoc accepts any tag, TSDoc declares them in `tsdoc.json` `tagDefinitions`,
  Javadoc registers them with `-tag`/taglets (the JDK itself ships custom tags:
  `@apiNote`, `@implSpec`, `@implNote`). The same `@name value` spelling parses
  verbatim in all three, so **one vocabulary is plug-n-play everywhere**. Keep
  the existing five, unchanged. Add none.
- **Everything else comes from the vanilla harvest.** The single biggest
  plug-n-play move: the **summary sentence** (first sentence of the comment
  prose — an explicit convention in the Javadoc spec, de-facto in JSDoc/TSDoc)
  becomes the business description *fallback* when no `@business` is present.
  Plus the standard tags that carry business-relevant meaning: `@deprecated`
  ("don't build on this"), TSDoc maturity modifiers, `@see`, `@remarks`,
  `@summary`/`@description`, `@since`.
- **Fork labels need a (small) convention** because no dialect can attach a doc
  comment to a statement — doc comments bind to declarations only. We reuse the
  *same* tag rather than inventing a new one: a plain comment `// @business
  <label>` on or above a branch/arm. One tag, one meaning everywhere: *"the
  plain-language translation of the adjacent code element"*. (`@when` was
  considered and rejected: two spellings for one concept.)
  Precedent for statement-level comment directives: `/* istanbul ignore next */`,
  Wallaby's inline hints.

## Tag matrix (the contract; ecosystem-neutral)

| Tag | Source | Effect on graph |
|---|---|---|
| `@business <text>` | Farsight | `facets.business.description` (nodes); `business` label (branch points/arms via comment directive) |
| `@group <text>` | Farsight | `group` |
| `@tag`/`@tags a, b` | Farsight | `tags` |
| `@guard [label]` | Farsight | node kind `guard`, 🔒 edges |
| `@entrypoint [kind:name]` | Farsight | entry tags |
| *(prose)* | all dialects | `docs` (cleaned); **first sentence = business description fallback** |
| `@summary <text>` | JSDoc | prepended to prose (becomes the summary sentence) |
| `@description <text>` | JSDoc | appended to prose |
| `@remarks <text>` | TSDoc | appended to prose |
| `@deprecated [reason]` | all dialects | tag `deprecated` + `Deprecated: <reason>.` line in docs |
| `@internal` `@alpha` `@beta` `@experimental` | TSDoc modifiers | tag of the same name |
| `@see <target>` | all dialects | `See: <target>` line in docs (multiple collected) |
| `@since <v>` | all dialects | `Since <v>.` line in docs |
| `{@link t\|label}` `{@linkcode}` `{@linkplain}` `{@code}` `{@literal}` `{@inheritDoc}` | all dialects | stripped to readable text (label, else target) in prose and tag values |
| `@param` `@returns`/`@return` `@throws` `@typeParam` `@defaultValue` `@example` `@author` `@version` | all dialects | dropped — code detail; `signature`/`snippet` already carry it |

Simple HTML tags in prose (`<p>`, `<code>` — Javadoc habit) are stripped.
Declaration docs remain `/** … */` only (the convention in all three
ecosystems); fork labels accept `//` and `/* … */` too.

**Authored vs derived stays distinct**: `facets.business.description` is set
*only* from `@business`. The summary-sentence fallback is computed by
consumers (shared helper in core; viewer.js keeps its own one-liner — it
already has the `split(/[.!?]\s/)` idiom). Code is the source of truth; docs
augment (core principle #2).

## Fork-label placement rules (parser contract)

A label = comment containing `@business <text>` (≤120 chars, whitespace-collapsed):

- **Branch point** (`if`/`switch`/`try`/ternary/logical): leading comment whose
  last line is immediately above the statement's first line (stacked `//` lines
  allowed), or trailing `// @business …` on the test/discriminant line.
  → `BranchPoint.business`.
- **Arm**: trailing `// @business …` on the arm's opening line
  (`} else { // @business …`, `case 'x': // @business …`,
  `catch (e) { // @business …`), or leading comment immediately above a `case`.
  → `BranchArm.business`.

## Data contract (all optional, backward-compatible)

```ts
// graph.ts
export interface BranchArm   { …; business?: string }  // plain-language label for this arm
export interface BranchPoint { …; business?: string }  // plain-language label for the fork
// query.ts
export interface PathCondition { …; business?: string } // arm.business ?? branchPoint.business
```

Core exports a `businessSummary(node): string | undefined` helper
(`facets.business.description` → first sentence of `docs` → undefined) shared
by MCP + server; the caller falls back to `humanize(name)` where it already does.

## Consumers

- **journey() (core)**: `conditionsAt` copies `business` onto each PathCondition.
- **MCP**: `journey` hop markers prefer the label — `[when high-severity recall]`
  instead of `[when severity >= 8]` (raw only when no label; token-lean, no
  duplication). Fork summary + `forks:true` list show labels beside conditions.
  `describe_node` leads with `businessSummary` and calls out `deprecated`.
- **Viewer**: fork gutter markers, inline fork cards, and Forks drawer are
  lens-aware — business lens shows the label (falls back to raw condition);
  hybrid shows label (amber) + condition (mono); code shows the condition.
  Business-lens node card description falls back to the docs summary sentence.
  `deprecated` renders as a warn-tinted chip.
- **Server**: `/api/journey` passes journey() output through — no change needed.

## Plug-n-play deliverable — docs/ANNOTATIONS.md

Ecosystem-neutral guide: the tag matrix, fork-label placement, and copy-paste
snippets so the custom tags coexist with each ecosystem's tooling:

- `tsdoc.json` `tagDefinitions` (+`supportForTags`) for the five Farsight tags
- `eslint-plugin-jsdoc` `settings.jsdoc.definedTags`
- `javadoc -tag business:a:"Business:" …` flags (future Java adapter emits the
  same graph from the same spelling)

## Test bed

`examples/invoice-app` gets a heavy annotation pass exercising the full matrix —
vanilla summaries only (no `@business`) on some nodes to prove the fallback,
`@business` overrides on others, `@deprecated` + reason, `{@link}`/`{@code}`
inline tags, `@remarks`/`@see`/`@since`, a TSDoc modifier, and `@business` fork
labels (leading, trailing, `case`, `catch` forms) on its branchy functions.
`examples/claims-mini` gets a lighter touch (a couple of fork labels + one
vanilla-summary fallback) so the review fixture stays review-shaped.

## Out of scope (this pass)

- Java adapter itself (this pass defines the contract it will implement)
- Annotations-as-code (Java `@interface`, TS decorators) — doc comments are the
  cross-ecosystem common denominator
- A lint/validate gate for unknown tags (ROADMAP: lint-docs gate)

## File ownership (implementation agents)

- **A — parser+core**: `packages/core/src/graph.ts`, `packages/core/src/query.ts`,
  `packages/parsers/src/tsjs.ts`
- **B — viewer**: `packages/server/public/viewer.js`, `viewer.html`
- **C — MCP + fixtures + guide**: `packages/mcp/src/run.ts`, `examples/**`,
  `docs/ANNOTATIONS.md`

B and C start after A lands (schema dependency).
