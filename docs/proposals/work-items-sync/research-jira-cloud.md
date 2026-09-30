# Jira Cloud adapter — research report

*Gathered 2026-09-27 by an Opus research lane. Endpoint, parameter, scope and limit facts were read from the
current official OpenAPI specs with jq: the platform v3 spec (**[v3spec]**,
https://developer.atlassian.com/cloud/jira/platform/swagger-v3.v3.json), the platform v2 spec (**[v2spec]**,
https://developer.atlassian.com/cloud/jira/platform/swagger.v3.json) and the Agile/Software spec (**[agilespec]**,
https://developer.atlassian.com/cloud/jira/software/swagger.v3.json). Human reference pages:
https://developer.atlassian.com/cloud/jira/platform/rest/v3/ and https://developer.atlassian.com/cloud/jira/software/rest/.
**UNCONFIRMED** marks secondary sources or facts not verified on an official page. Feeds
[../work-items-sync.md](../work-items-sync.md).*

---

## 1. Auth options for a local CLI or server

**A. Basic auth with email and API token (classic, "unscoped" token)**
- Header `Authorization: Basic base64(email:api_token)`; requests go to `https://<site>.atlassian.net/rest/api/{2|3}/…`. Passwords are deprecated. Repeated failures trigger a CAPTCHA, after which REST auth fails; detect it with `X-Seraph-LoginReason: AUTHENTICATION_DENIED`. — https://developer.atlassian.com/cloud/jira/platform/basic-auth-for-rest-apis/
- Atlassian says basic auth is "not as secure… recommend using it for simple scripts and manual calls", discourages apps that collect users' API tokens, and recommends one distributable 3LO app instead. — same page and https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/
- **Token expiry is now forced:** since 2024-12-15 new tokens default to 1 year (allowed range 1–365 days); older tokens were set to expire between 2026-03-14 and 2026-05-12. — https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/ Design impact: handle a 401 from an expired token and store an expiry hint.

**B. Scoped API tokens (granular scopes chosen at creation)**
- Must be called through the gateway `https://api.atlassian.com/ex/jira/{cloudId}`, with basic auth (`email:token`). — the two pages above.
- cloudId: `https://<site>.atlassian.net/_edge/tenant_info` returns JSON with `cloudId`; it also appears in `admin.atlassian.com/s/<cloudId>/…`. — https://support.atlassian.com/jira/kb/retrieve-my-atlassian-sites-cloud-id/
- **UNCONFIRMED:** that `tenant_info` needs no authentication; that scoped tokens also accept `Authorization: Bearer` (third-party posts only).

**C. OAuth 2.0 (3LO), authorization-code grant only**
- Authorize: `https://auth.atlassian.com/authorize?audience=api.atlassian.com&client_id=…&scope=…&redirect_uri=…&state=…&response_type=code&prompt=consent`. Token: `POST https://auth.atlassian.com/oauth/token`; `client_secret` is required; PKCE is not documented.
- Refresh tokens need the `offline_access` scope; they rotate on every refresh and expire after 90 days of inactivity (10-minute reuse leeway).
- cloudId: `GET https://api.atlassian.com/oauth/token/accessible-resources` → `[{id (=cloudId), name, url, scopes, avatarUrl}]`. API base: `https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3/…`.
- Consent is per site; admins cannot revoke a user's grant from the Connected Apps UI; an undistributed app shows an "unreviewed" warning.
- Source: https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/
- **Desktop pitfalls:** the `client_secret` cannot be kept secret inside a distributed CLI; **UNCONFIRMED** community reports say the console allows a single callback URL and sometimes refuses http callbacks (https://community.developer.atlassian.com/t/oauth-2-0-callback-url-using-http-not-https/58722, https://community.developer.atlassian.com/t/multiple-callback-urls-for-a-single-outh-2-0-3lo-app/32413). Each consumer registers their own app, or Farsight runs a hosted callback; Atlassian's compliance language disfavours "instruct customers to create individual 3LO apps".

**D. Classic 3LO scopes:** `read:jira-work`, `write:jira-work`, `read:jira-user`, `manage:jira-webhook`, `manage:jira-project`, `manage:jira-configuration`, plus `offline_access`. Use fewer than 50 scopes and prefer classic scopes. — https://developer.atlassian.com/cloud/jira/platform/scopes-for-oauth-2-3LO-and-forge-apps/

**E. Per-operation scopes from [v3spec] and [agilespec]** (classic ‖ granular)

| Operation | Classic ‖ granular |
|---|---|
| GET/POST `/search/jql` | `read:jira-work` ‖ `read:issue-details:jira, read:field:jira, read:issue-meta:jira, read:field-configuration:jira, read:avatar:jira, read:audit-log:jira, read:field.default-value:jira, read:field.option:jira, read:group:jira` |
| GET `/issue/{key}`, POST `/issue/bulkfetch` | `read:jira-work` ‖ `read:issue:jira, read:issue-meta:jira, read:issue-security-level:jira, read:issue.vote:jira, read:issue.changelog:jira, read:status:jira, read:user:jira, read:avatar:jira, read:field-configuration:jira` |
| GET `/issue/{key}/comment` | `read:jira-work` ‖ `read:comment:jira, read:comment.property:jira, read:group:jira, read:project:jira, read:project-role:jira, read:user:jira, read:avatar:jira` |
| Changelog (GET and bulkfetch) | `read:jira-work` ‖ `read:issue-meta:jira, read:issue.changelog:jira, read:avatar:jira` |
| GET `/issue/{key}/transitions` | `read:jira-work` ‖ `read:issue.transition:jira, read:status:jira, read:field-configuration:jira` |
| PUT `/issue/{key}`, PUT `/assignee` | `write:jira-work` ‖ `write:issue:jira` |
| POST `/transitions` | `write:jira-work` ‖ `write:issue:jira, write:issue.property:jira` |
| POST `/comment` | `write:jira-work` ‖ `write:comment:jira` plus the comment read scopes |
| POST `/issueLink` | `write:jira-work` ‖ `write:issue-link:jira, write:issue:jira, write:comment:jira` |
| POST `/attachments` | `write:jira-work` ‖ `write:attachment:jira, read:attachment:jira, read:user:jira, read:avatar:jira` |
| GET `/myself`, `/user/assignable/search` | `read:jira-user` ‖ `read:user:jira, …` |
| GET `/mypermissions` | `read:jira-work` ‖ `read:permission:jira` |
| GET `/field`, `/field/search` | `read:jira-work` ‖ `read:field:jira, read:field-configuration:jira, …` |
| Dynamic webhooks | `read:jira-work` + `manage:jira-webhook` ‖ `read:webhook:jira, write:webhook:jira, read:jql:jira, read:field:jira, read:project:jira` |
| Agile boards / sprints / epics | `read:board-scope:jira-software, read:project:jira` / `read:sprint:jira-software` (`write:sprint:jira-software` to move) / `read:epic:jira-software` |
| GET `/statuses/search` | `manage:jira-configuration` (admin). Use `GET /project/{key}/statuses` instead: `read:jira-work` ‖ `read:status:jira, read:issue-status:jira, read:issue-type:jira` |

**F. Forge and Connect** are apps installed into the site, not a fit for an external desktop tool. Connect is deprecated: new Marketplace apps must be Forge since 2025-09-17, Connect updates blocked from 2026-03-31, end of support end of 2026. — https://www.atlassian.com/blog/development/announcing-connect-end-of-support-timeline-and-next-steps `/webhook/failed` is Connect-only [v3spec].

**G. Jira Data Center / Server:** Personal Access Tokens as `Authorization: Bearer <PAT>` (since Jira 8.14 / JSM 4.15); default max expiry 365 days (`atlassian.pats.max.tokens.expiry.days`); admins can list and revoke. — https://confluence.atlassian.com/enterprise/using-personal-access-tokens-1026032365.html **UNCONFIRMED:** Data Center exposes `/rest/api/2` (wiki-markup bodies, `startAt` paging, username/key user model) and has no ADF v3 — treat as a separate adapter variant.

**Recommendation for a desktop developer tool:** primary **per-user email + API token** stored in the OS keychain against `https://<site>.atlassian.net` — simplest, not subject to the new points quota, and every request acts as that user so Jira's own permissions apply. Offer **scoped tokens** as the least-privilege variant (needs the cloudId gateway). Keep **3LO** for a hosted/distributed future (registered app, client secret, per-site consent, callback URL; enables dynamic webhooks). Pitfalls: one token per user, no shared service identity (Atlassian service-account tokens exist, not researched); tokens expire within a year; the site URL and the gateway URL differ between auth modes; the CAPTCHA lockout.

## 2. Read API

**Search — current state**
- `GET/POST /rest/api/{2,3}/search` is `deprecated: true` in [v3spec]/[v2spec], "Currently being removed", linking to https://developer.atlassian.com/changelog/#CHANGE-2046 (JavaScript-rendered, unread). **Timeline (secondary, UNCONFIRMED):** deprecated 2025-05-01, progressive shutdown 2025-08-01 → 2025-10-31, clients now report `410 Gone` (https://docs.adaptavist.com/sr4jc/latest/release-notes/breaking-changes/atlassian-rest-api-search-endpoints-deprecation/, https://community.strategy.com/article/KB489535-Data-import-from-Jira-Cloud-Connector-failed-API-removed-410-Gone-Please-migrate-to-rest-api-3-search-jql). **Treat `/search` as gone.**
- **Replacement: `GET/POST /rest/api/3/search/jql`** (v2 twin exists) [v3spec]. Parameters: `jql`, `nextPageToken`, `maxResults`, `fields`, `expand`, `properties` (≤5), `fieldsByKeys`, `failFast`, `reconcileIssues` (≤50 IDs), `includeArchivedProjects`. **The JQL must be bounded** (`order by key desc` rejected; `orderBy` ≤7 fields). **`fields` defaults to `id`** — pass `*all`, `*navigable` or a list. `maxResults` defaults to 50, "returns max 5000 issues", may return fewer where many fields are requested. `expand`: `renderedFields, names, schema, transitions, operations, editmeta, changelog, versionedRepresentations`. Response `{issues, isLast, nextPageToken, names, schema, warnings}` — **no `total`, no `startAt`**; `nextPageToken` expires in 7 days; absent/null on the last page.
- **Consistency:** search is eventually consistent ("a few seconds to minutes"); `reconcileIssues` forces fresh data for ≤50 IDs. — https://developer.atlassian.com/cloud/jira/platform/search-and-reconcile/
- **Count:** `POST /search/approximate-count` (estimate, bounded JQL) [v3spec].
- **Bulk fetch:** `POST /issue/bulkfetch` — 100 issues per call; up to 1000 only when `fields` names ≤100 non-multi-valued fields (`comment`, `worklog`, `attachment` excluded) and `expand` excludes `changelog, editmeta, operations, renderedFields, transitions, versionedRepresentations`. Ascending `id` order, per-issue errors reported separately; `expand=changelog` returns ≤40 changelogs [v3spec].

**Get one issue:** `GET /rest/api/3/issue/{idOrKey}` with `fields` (default all), `fieldsByKeys`, `expand`, `properties`, `updateHistory`, `failFast`. A moved issue resolves silently with the new key [v3spec].

**Changelog:** `GET /issue/{key}/changelog` (`startAt`, default `maxResults` 100, oldest first); `POST /changelog/bulkfetch` (≤1000 issues, ≤10 `fieldIds`, `maxResults` default 1000 / max 10000, `nextPageToken`, sorted by date then issue ID). Entry shape `{id, author, created, items:[{field, fieldId, fieldtype, from, fromString, to, toString}]}` [v3spec].

**Comments:** `GET /issue/{key}/comment` (`startAt`, default 100, `orderBy=created`, `expand=renderedBody` → HTML). In v3, `body` is ADF ("The comment text in Atlassian Document Format"). **Rendering options are HTML only; no markdown or plain-text output** (no "markdown" in [v3spec]). In [v2spec] a comment `body` is a plain string (wiki markup).

**ADF:** minimal document `{"version":1,"type":"doc","content":[]}`; block nodes (paragraph, heading, lists, table, codeBlock, panel, blockquote, expand, media, rule), inline nodes (text, mention with `attrs.id` = accountId, date, emoji, hardBreak, inlineCard, status), marks. JSON schema http://go.atlassian.com/adf-json-schema; no official converter named. — https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/ **Farsight needs its own ADF ↔ text/markdown converter.**

**Links, parents, epics:** links from `issuelinks`, created with `POST /issueLink`; parents from `parent` (set by key or ID on edit; cleared with `update.parent.set.none: true`). Agile epic endpoints "do not work for epics in next-gen projects" [agilespec] — **prefer `parent`.**

**Sprints and boards (`/rest/agile/1.0`)** [agilespec]: `GET /board`, `/board/{id}/sprint`, `/sprint/{id}`, `/issue/{key}`. `/sprint/{id}/issue` and `/board/{id}/issue` are **deprecated**; use `GET /rest/software/1.0/sprint/{id}/issue` (enhanced, `nextPageToken`, max 5000).

**Custom fields:** `GET /rest/api/3/field` (all) or `GET /field/search` (paginated; `type`, `id`, `query`, `projectIds`, `expand=key,stableId,lastUsed,searcherKey,…`). Field shape `{id, key, name, custom, schema:{type, items, system|custom (type URI), customId}, clauseNames}`. **Match on `schema.custom`, not the name** — Sprint is `com.pyxis.greenhopper.jira:gh-sprint`; "custom field names are mutable". Story Points is "just a regular numeric field"; the estimation field per board is `board/{id}/configuration` → `estimation.field.fieldId` [agilespec].

**Statuses and workflows:** `GET /issue/{key}/transitions` (`expand=transitions.fields`, `transitionId`, `includeUnavailableTransitions`, `sortByOpsBarAndStatus`); returns an empty list when the user lacks *Transition issues*. Statuses: `GET /project/{key}/statuses`, `GET /statuscategory` (`{id, key, name, colorName}`). `/statuses/search` needs admin scope [v3spec].

**Users, projects, issue types:** `GET /myself`, `/user/assignable/search`, `/user/assignable/multiProjectSearch`, `/project/search` (paginated), `/issuetype` [v3spec].

**Incremental-sync JQL:** `updated` accepts `"yyyy/MM/dd HH:mm"`, `"yyyy-MM-dd HH:mm"`, date-only forms, or relative `w/d/h/m` (default minutes). Values are relative to the caller's configured time zone; quote the value or it is read as epoch milliseconds. — https://support.atlassian.com/jira-software-cloud/docs/jql-fields/ **Granularity is one minute and the zone is the user's**: overlap the window by a few minutes, dedupe on `id` + `fields.updated`, allow for search lag.

**Rate limits** — https://developer.atlassian.com/cloud/jira/platform/rate-limiting/
- Three independent limits: a **points-based hourly quota** (1 point per request, +1 for writes, 2 for identity/permission objects; Tier 1 is a shared global 65,000 points/hour per app, Tier 2 per tenant); **burst limits** per endpoint (GET/POST 100 req/s, PUT/DELETE 50 req/s); **per-issue write limits** (20 writes / 2 s and 100 / 30 s).
- **Points enforcement started 2026-03-02** for Forge, Connect and 3LO. **"API token-based traffic is not affected… will continue to be governed by existing burst rate limits."**
- Headers: `Retry-After`, `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` (ISO 8601), `RateLimit-Reason` (`jira-quota-global-based | jira-quota-tenant-based | jira-burst-based | jira-per-issue-on-write`), `X-RateLimit-NearLimit` (true under 20% remaining); `Beta-RateLimit-*` informational. A 429 means honour `Retry-After`; otherwise exponential backoff with jitter.

**Pagination in general:** offset pages `{startAt, maxResults, total?, isLast?, values}`; per-operation limits "may change without notice"; the server can lower `maxResults`; `total` and `isLast` are not always present. — https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/ The old "100-result page limit" is **no longer accurate for search** (`search/jql` up to 5000, adaptive); it still holds for comments and changelog defaults (100) and bulkfetch (100, or 1000 when eligible).

## 3. Write API (all [v3spec] unless noted)

**Edit issue: `PUT /issue/{key}`** — body `{fields, update, properties, historyMetadata}`; `fields` sets directly, `update` is `field → [{set|add|remove|edit|copy}]`; a field cannot appear in both (`"update":{"labels":[{"add":"triaged"},{"remove":"blocker"}]}`). Query: `notifyUsers` (turning off needs admin), `returnIssue` + `expand` (200 with the issue, else 204), `overrideScreenSecurity`/`overrideEditableFlag` (admin apps). Status transitions are ignored here. `description`, `environment` and textarea custom fields take ADF; `textfield` fields take a string. The endpoint "doesn't check screen configurations to determine if a field is editable". **Errors:** 400 (no permission for a field, unknown field), **409 "the issue could not be updated due to a conflicting update"**, 422 (configuration). Permissions: Browse + Edit issues. `GET /issue/{key}/editmeta` lists editable fields.

**Create issue:** `POST /issue`.

**Add comment: `POST /issue/{key}/comment`** — v3 body is ADF; v2 takes a string. 413 when the per-issue comment/attachment limit is exceeded. Permissions: Browse + Add comments.

**Transition: `POST /issue/{key}/transitions`** — `{transition:{id}, fields?, update?, historyMetadata?, properties?}`; only fields on the transition screen are allowed (discover with `expand=transitions.fields`). Errors 400, 409 (conflicting update), 413, 422. Permissions: Browse + Transition issues.

**Assign: `PUT /issue/{key}/assignee`** — `{"accountId": "..."}`; `null` unassigns; `"-1"` sets the project default. Needs only *Assign issues*. 400 if the user is not found or more than one identifier is given.

**Labels:** `update.labels` add/remove on PUT issue. **Links:** `POST /issueLink`. **Attachments:** `POST /issue/{key}/attachments` multipart, **requires `X-Atlassian-Token: no-check`** (v3 intro).

**Concurrency:** **there is no optimistic locking** — no `ETag`, `If-Match` or `If-Unmodified` in [v3spec]. The only signal is **409 "conflicting update"**, a server-side collision, not a version check. Inference: a write against a stale local copy succeeds, last writer wins per field. The adapter must re-GET `fields.updated` (and the changelog since the cached version) immediately before writing, refuse or merge if it changed, and treat 409 as retryable. Prefer `update` verbs (labels add/remove) over `fields` replacement for multi-valued fields. After writing, `returnIssue=true` for fresh state and `reconcileIssues` on the next search.

**Asking Jira what the caller may do:** `GET /rest/api/3/mypermissions?permissions=BROWSE_PROJECTS,EDIT_ISSUES,ADD_COMMENTS,ASSIGN_ISSUES,TRANSITION_ISSUES&issueKey=…` (or `projectKey`); `permissions` is required. **Pass `issueKey`** — at project level the answer can be "yes" where the permission does not hold for a particular issue (the spec's example is Reporter-only EDIT_ISSUES). Per issue, `expand=operations`, `editmeta` and `transitions` show the available operations, editable fields and allowed transitions.

## 4. Change detection

**Webhooks** — https://developer.atlassian.com/cloud/jira/platform/webhooks/ plus [v3spec]
- Registration: the admin UI or `/rest/webhooks/1.0/webhook` (Jira admin; can carry a `secret` for HMAC `X-Hub-Signature: sha256=…`), the Connect descriptor, or OAuth 3LO dynamic webhooks via `POST /rest/api/3/webhook`.
- Dynamic webhooks: only Connect and OAuth 2.0 apps (basic-auth callers get 403 "caller isn't an app"); 5 per app per user per tenant; **expire after 30 days**, extend with `PUT /webhook/refresh`; for non-public OAuth apps delivery only if the app owner registered; deliveries carry a bearer token signed with the client secret.
- JQL filter subset: `issueKey, project, issuetype, status, assignee, reporter, issue.property, cf[id]` (epic-label only), operators `= != IN NOT IN`, plus `priority` on the webhooks page; `fieldIdsFilter` limits `jira:issue_updated` to listed fields.
- Events: `jira:issue_created/updated/deleted`, `comment_created/updated/deleted`, `issue_property_set/deleted`, `sprint_*`, `jira:version_*`; admin webhooks add `issuelink_*`, `attachment_*` and others.
- Payload: `{timestamp, webhookEvent, issue_event_type_name, user, issue, changelog:{items:[…]}, comment}`.
- Delivery: target must be **public HTTPS** on an allowed port (443, 8080, 8443, …) returning 200; up to 5 retries for 408/409/425/429/5xx or timeouts, 5–15 minutes apart at random; `X-Atlassian-Webhook-Identifier` is stable across retries (idempotency key); concurrency capped at 20 per tenant + host; payloads over 25 MB dropped; ordering not promised; project deletion does not fire `issue_deleted`; `/webhook/failed` is Connect-only.

**What this means for a desktop tool with no public URL:** push is not practical (public HTTPS endpoint, 3LO registration, 30-day refresh). **Poll instead:** (1) page `POST /search/jql` with bounded JQL such as `project in (…) AND updated >= "yyyy/MM/dd HH:mm" ORDER BY updated ASC` and an explicit field list, cursor = last seen `updated` minus a few minutes' overlap; (2) for changed issues, `POST /changelog/bulkfetch` and paginated comments; (3) hard deletes never match an `updated` query — run a periodic key-only reconcile scan (`fields=id`, large pages) to detect deletions and moves; (4) `reconcileIssues` after Farsight's own writes. Optional future path: a hosted relay that receives webhooks and exposes a pull queue.

## 5. Data model for a common schema

**Issue** [v3spec IssueBean]: `{id, key, self, fields, expand, names?, schema?, renderedFields?, changelog?, transitions?, operations?, editmeta?, properties?}`.

**System fields under `fields`:** `project`, `issuetype`, `summary`, `description` (ADF in v3), `status {id, name, statusCategory {id, key, name, colorName}}` (category keys `new` / `indeterminate` / `done`, displayed To Do / In Progress / Done — **UNCONFIRMED** literals, verify with `GET /statuscategory`), `priority`, `assignee`/`reporter` (users), `labels` (string[]), `components`, `fixVersions`, `parent`, `subtasks`, `issuelinks` `[{id, type:{name, inward, outward}, inwardIssue | outwardIssue}]` (**UNCONFIRMED** sub-schema), `created`/`updated`/`resolutiondate` (ISO 8601 in the default user time zone), `comment` (paged).

**User** [v3spec UserDetails]: `{accountId, accountType: atlassian|app|customer, active, displayName, emailAddress, timeZone, avatarUrls, self}`; `emailAddress` "may be returned as null" (privacy); `displayName` "may return an alternative value"; `name` and `key` no longer exist.

**Comment:** `{id, author, body (ADF), created, updated, renderedBody?, visibility?}`. **Changelog:** `{id, author, created, items:[{field, fieldId, fieldtype, from, fromString, to, toString}]}`.

**Custom fields with site-specific IDs:** Sprint (`com.pyxis.greenhopper.jira:gh-sprint`), Story Points / Story point estimate (numeric, chosen per board), Epic Link / Epic Name (legacy), Rank, Flagged. Spec examples use different IDs (`customfield_10002`, `_10007`, `_11410`) — IDs are not stable across sites; `customfield_10016` / `_10020` are common defaults, not guarantees (**UNCONFIRMED**). Discover with `GET /field`, match on `schema.custom` (and `searcherKey`/`stableId`), cache per site, read the board configuration for the estimation field; `expand=names` maps IDs to display names per response.

## 6. Constraints to design around

1. **Identity.** Users are `accountId` only; `username`/`userKey` were removed from REST and JQL (2019-04-29). — https://developer.atlassian.com/cloud/jira/platform/deprecation-notice-user-privacy-api-migration-guide/ Email and time zone can be null: never key on email; key on `accountId`, keep `displayName` as a mutable label. Partial email matches do not find users who hid their email.
2. **Page sizes.** `search/jql` up to 5000 but adaptive, 7-day token, no `total`; comments/changelog default 100; bulkfetch 100 or 1000 when eligible. Loop until `isLast` or no token; never trust the requested size.
3. **Body formats.** ADF is required for comment bodies and rich-text fields in v3. v2 still exists for Cloud with the same operations (including `/rest/api/2/search/jql`) and accepts wiki-markup strings; **UNCONFIRMED** whether v2 as a whole is deprecated (only its `/search` is being removed). Choice: write through v3 with an internal markdown → ADF converter (recommended), or wiki markup through v2 (simpler, legacy format).
4. **Rate limits.** API-token traffic: burst limits only. 3LO: points quota as well (65k/hour shared at Tier 1, since 2026-03-02). Per-issue write caps 20 / 2 s and 100 / 30 s. Honour `Retry-After` and `RateLimit-Reason`.
5. **Search deprecation.** `/search` should be treated as removed (410); only `/search/jql` with bounded JQL. Official entry CHANGE-2046 unread; dates from secondary sources.
6. **Search lag.** Eventually consistent; `reconcileIssues` (≤50) for read-after-write.
7. **No ETag.** Compare-before-write with `fields.updated` and the changelog; 409 is a conflict to retry after a fresh read.
8. **Permissions.** Evaluate per issue (`mypermissions?issueKey=` or `expand=operations,editmeta,transitions`); an empty transitions list means no *Transition issues*; assign works with *Assign issues* alone. Farsight's consumer-configured policy combines with Jira's per-issue answer (logical AND).
9. **Credential lifetime.** API tokens ≤365 days; 3LO refresh tokens rotate and die after 90 idle days; Data Center PATs admin-configurable.
10. **Agile.** Old sprint/board issue endpoints deprecated; use `/rest/software/1.0/…` (token pagination). Epic endpoints fail for team-managed projects; use `parent`.
