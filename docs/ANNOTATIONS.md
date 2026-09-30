# Annotations reference

Farsight reads the doc comments your codebase already has. Ordinary
JSDoc/TSDoc/Javadoc summaries and standard tags flow into the graph as-is, and
five small custom tags add the things no vanilla tag can say. The same spelling
works in all three ecosystems, so one set of annotations is plug-n-play
everywhere.

This is the contract: what each tag does, where fork labels go, and how to make
the custom tags coexist with your existing doc tooling. For the guided tour see
[GETTING-STARTED.md](GETTING-STARTED.md); for the *why* see the
[doc-comment proposal](proposals/doc-comments.md).

Two rules underpin all of it:

- **Code is the source of truth.** Annotations augment what parsing already
  found — they never invent behavior. A `@business` line is a translation of the
  code next to it, not a substitute for it.
- **Authored beats derived, but derived is free.** `@business` sets the
  business-lens description explicitly. When it's absent, the **first sentence**
  of the comment becomes that description automatically — so a well-documented
  repo lights up the Business lens with zero Farsight-specific work.

## Tag matrix

| Tag | Source | What it does in the graph |
|---|---|---|
| `@business <text>` | Farsight | Business-lens description of a node; on a branch (via a `// @business` comment) the plain-language fork label |
| `@group <text>` | Farsight | Logical group (overrides file-based grouping) |
| `@tag` / `@tags a, b` | Farsight | Custom tags for search & filtering |
| `@guard [label]` | Farsight | Marks the function an auth/permission guard (🔒); every caller gets a guard edge |
| `@entrypoint [kind:name]` | Farsight | Declares an entry point no route detector can see (cron/queue jobs) |
| `@covers <target…>` | Farsight | On a test file or a test case: what the test verifies. Becomes a `covers` edge with evidence class `declared` |
| `@design <url\|id> [name]` | Farsight | Joins a screen (page/component) to its design: a Figma URL (node id kept) or the id the docs use (`SCR-07`); surfaced on the card, the inspector and `describe_node`, searchable as `design:<id>` |
| *(prose)* | all | `docs` text; **its first sentence is the business description when `@business` is absent** |
| `@summary <text>` | JSDoc | Prepended to prose (becomes the summary sentence) |
| `@description <text>` | JSDoc | Appended to prose |
| `@remarks <text>` | TSDoc | Appended to prose |
| `@deprecated [reason]` | all | Adds the `deprecated` tag + a `Deprecated: <reason>.` line in docs |
| `@internal` `@alpha` `@beta` `@experimental` | TSDoc | Adds a tag of the same name (maturity/visibility) |
| `@see <target>` | all | A URL becomes a link on the node (rendered as an anchor, never as prose); any other target is a `See: <target>` line in docs |
| `@since <v>` | all | `Since <v>.` line in docs |
| `{@link t\|label}` `{@linkcode}` `{@linkplain}` `{@code}` `{@literal}` `{@inheritDoc}` | all | Reduced to readable text (the label, else the target) in prose and tag values |
| `@param` `@returns` `@throws` `@typeParam` `@defaultValue` `@example` `@author` `@version` | all | Dropped — code detail already carried by the signature/snippet |

Simple HTML in prose (`<p>`, `<code>` — a Javadoc habit) is stripped. Declaration
doc comments are `/** … */` only, the convention in every ecosystem.

The six Farsight tags are the *only* custom vocabulary. Everything else in the
table is a standard tag Farsight now harvests instead of discarding. `@business`
always wins over the first-sentence fallback — write it when the summary
sentence isn't the plain-language version you want the Business lens to show.

## `@covers` — what a test verifies

A test file or a single case can say what it stands behind. Farsight turns each
value into a `covers` edge from the `test` node to the thing it names, tagged
**declared**: a claim by the author, never rendered as an observation.

```ts
/**
 * Journey `invoice-submission` against the mock server.
 *
 * @covers invoice-submission
 * @covers SCR-07
 * @covers SCR-04
 */
```

One target per tag, or several comma- or space-separated on one tag. A file
header block applies to **every case in the file**; a block above a single
`it(...)` / `test(...)` applies to that case only, and adds to the file's.

Targets resolve in this order — the first match wins:

| Written | Matches |
|---|---|
| `example-app::flow::my-invoices` | a full node id, exactly |
| `invoice-submission` | a **flow** id from the design manifest |
| `SCR-07` | a **design screen** id (the page/component built from it) |
| `POST /api/v1/submissions` | a **route** (`{token}`, `:id` and `${id}` all normalize) |
| `/invoices` | a **page** at that route |
| `src/server/invoiceService.ts::finalizeInvoice` | a node id without the repo prefix |
| `finalizeInvoice` | a symbol name, when it is **unique** in the repo |

A value nothing matches is **kept verbatim** on the node (`test.unresolved`) and
reported as a blind spot — *"`e2e/x.pw.spec.ts` declares `CON-99`, which nothing
in the graph matches"*. An ambiguous bare name resolves to nothing rather than
guessing.

`@covers` is only one of the three evidence classes. The other two need no
annotation at all: **static** evidence is what the test's own code imports,
renders, or opens (`page.goto('/invoices')`, `request.post('/invoices')`), and
**observed** evidence is what a coverage or results report saw run. See
[the tests-surface proposal](proposals/tests-surface.md) for the report formats
and the `tests` block of `farsight.config.json`.

## Fork labels

A fork is an `if` / `switch` / `try…catch` / ternary / logical decision — the
branches a [Journey](proposals/journey-view.md) narrates. No doc-comment
dialect can attach to a *statement* (they bind to declarations), so a fork label
is a **plain comment containing `@business <text>`** placed on or above the
branch. Same tag, same meaning: *the plain-language translation of the code
element next to it.* Labels are whitespace-collapsed and capped at ~120 chars.

The label surfaces in the Journey's fork gutter, the Forks drawer, and the MCP
`journey` tool's `[when …]` hop markers and fork list — plain language in the
Business lens, alongside the raw condition in Hybrid.

### Placement

**On the fork itself** (labels the whole decision) — a leading comment
immediately above the statement, or a trailing comment on the test line:

```ts
// @business An invoice must have at least one line item before it can be sent
if (invoice.lines.length < 1) throw new Error('empty invoice');

// stacked lines are joined:
// @business Pick the wording that matches the customer's tax region —
// EU VAT, UK VAT, or none charged here
switch (country) { … }

/* @business Block-comment form works too */
if (recall.severity >= 8) escalate(recall);
```

**On one arm** (labels that branch) — a trailing comment on the arm's opening
line, or (for a `case`) a leading comment above it:

```ts
if (recall.severity >= 8) {
  escalate(recall);
} else { // @business Routine recalls wait for the weekly review
  enqueue(recall);
}

switch (country) {
  // @business EU member states: VAT at the local rate
  case 'DE':
  case 'FR': return vat(country);
  case 'GB': // @business United Kingdom: standard-rate VAT
    return 'UK VAT 20%';
  default: // @business Everywhere else: no VAT charged here
    return 'none';
}

try { // @business Post the ledger entry and notify the customer
  await commit();
} catch (e) { // @business If the ledger or notifier is down, surface the failure
  throw e;
}
```

Rules of thumb: nothing but indentation may sit between a leading comment and
its statement; a trailing label must be on the same source line as the arm's
opening `{`, `case X:`, `else`, or `catch (…)`. An arm label overrides the
fork label for that branch.

## Plug-n-play setup

The five Farsight tags parse verbatim in JSDoc, TSDoc, and Javadoc. Nothing
below is required for Farsight itself — it's how to keep your *existing* doc
tooling from warning about the custom tags.

### TSDoc (`tsdoc.json`)

TSDoc rejects unknown tags unless declared. Add them as block tags and opt them
into the standard support set:

```jsonc
// tsdoc.json — at your project root
{
  "$schema": "https://developer.microsoft.com/json-schemas/tsdoc/v0/tsdoc.schema.json",
  "tagDefinitions": [
    { "tagName": "@business",   "syntaxKind": "block" },
    { "tagName": "@group",      "syntaxKind": "block" },
    { "tagName": "@tag",        "syntaxKind": "block", "allowMultiple": true },
    { "tagName": "@guard",      "syntaxKind": "block" },
    { "tagName": "@entrypoint", "syntaxKind": "block" }
  ],
  "supportForTags": {
    "@business": true,
    "@group": true,
    "@tag": true,
    "@guard": true,
    "@entrypoint": true
  }
}
```

### ESLint (`eslint-plugin-jsdoc`)

Tell the `no-undefined-types` / `check-tag-names` rules the tags are defined:

```jsonc
// .eslintrc.json (or eslint.config.js → settings)
{
  "settings": {
    "jsdoc": {
      "definedTags": ["business", "group", "tag", "tags", "guard", "entrypoint"]
    }
  }
}
```

### Javadoc (`-tag`)

Register the tags so `javadoc` renders them instead of erroring (the Java
adapter emits the same graph from the same spelling — `examples/spring-invoice-api`
is the annotated fixture):

```sh
javadoc \
  -tag business:a:"Business:" \
  -tag group:a:"Group:" \
  -tag tag:a:"Tags:" \
  -tag guard:a:"Guard:" \
  -tag entrypoint:a:"Entry point:" \
  -sourcepath src -d out com.example
```

`a` places the tag in all doc contexts; change the trailing label to taste.
Fork labels need no registration in any ecosystem — they live in plain `//` or
`/* … */` comments, which every toolchain already ignores.
