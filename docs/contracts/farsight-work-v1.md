# farsight-work v1 — the frozen work-item contract

**Status:** FROZEN 2026-09-30 · **Schema:** [`schemas/farsight-work-v1.schema.json`](../../schemas/farsight-work-v1.schema.json) · **Implementation:** `packages/work/src/contract.ts` · **Design:** [`docs/proposals/work-items-sync.md`](../proposals/work-items-sync.md) §3, §7 · **Pin test:** `packages/work/test/contract.test.ts`

One record shape for every tracker. Providers (Jira, Azure DevOps, the recorded fixture) map *into* it; nothing maps
out of it per consumer. The tracker's native record rides along verbatim in `raw` for the developer register and for
write-back, and is never rendered in the business register.

## Freeze rules

- Everything named here keeps its name, type and meaning for as long as `schema` says `farsight-work v1`.
- v1 may **gain optional fields and enum members** (consumers ignore what they do not know); it never loses or
  repurposes one.
- A breaking change ships as `farsight-work v2` with a migration note.
- The JSON Schema is normative for shape; this document for meaning. The pin test asserts every closed set below
  against an explicit literal list **and** against the schema file's `enum`s.

## Envelope — `farsight work list --json`

```json
{ "schema": "farsight-work v1", "generatedAt": "2026-09-30T10:00:00.000Z", "sources": ["acme-jira"], "items": [ … ] }
```

`farsight work show <key> --json` prints one `WorkItem` (`$defs.workItem`).

## Closed sets

| set | members |
|---|---|
| `provider` | `jira` · `azure-devops` · `fixture` (the recorded CI provider) |
| `type.category` (`WorkType`) | `epic` · `feature` · `story` · `task` · `bug` · `other` |
| `state.category` (`StateCategory`) | `todo` · `in-progress` · `done` · `removed` |
| `body.format` | `markdown` · `html` · `adf` · `wiki` |
| `links[].kind` | `parent` · `child` · `relates` · `blocks` · `blocked-by` · `duplicates` · `other` |
| `estimate.unit` | `points` · `hours` · `days` |
| write actions (`WorkAction`, §7.2) | `comment` · `edit` · `assign` · `transition` · `link` · `label` · `create` |

## Meaning

- **`id`** is the graph node id `work::<sourceId>::<key>`; **`key`** is what people say (`ACME-123`, `4711`).
- **Categories are decided by the provider from the tracker's own category field, never from a name.** Jira
  `statusCategory.key` new/indeterminate/done; Azure DevOps state category Proposed/InProgress/**Resolved →
  in-progress**/Completed/Removed. Surfaces print `state.name` beside the category word.
- **`revision`** is what compare-before-write checks: Azure DevOps `rev`, Jira `fields.updated`.
- **`history`** is field changes, newest last; **`comments`** and **`history`** are complete after hydration.
- **`fields`** carries custom fields by canonical name (the §4.3 map), values as read.
- **`Person.id`** is the stable identity (Jira `accountId`, ADO descriptor); `name` may change, `email` may be absent.
- Times are ISO 8601 UTC.

## In the graph (additive, 2026-09-30)

A `WorkItem` becomes a graph node of kind **`work`** (`id` as above, `name` = `key`, the title as its business label,
no `loc`) and reaches what it is about by **`tracks`** edges — declared (`screens.json` `work: []` on a flow or screen,
or `@work KEY` in a doc comment: technique `annotation-scan`, HIGH) or detected (a commit subject, body, branch or
tracker URL names the key and the commit's hunks changed the node: technique **`work-key`**, MEDIUM, LOW when only the
file is known). `farsight-diff v1` carries `work` in `nodeKind` and `work-key` in `technique`; `farsight-impact-tests
v1` carries `tracks` in `edgeKind`, and the impact walk never follows it. The list document above is unchanged.
