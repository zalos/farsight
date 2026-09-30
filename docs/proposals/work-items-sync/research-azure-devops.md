# Azure DevOps (Azure Boards) adapter — research report

*Gathered 2026-09-27 by an Opus research lane from official Microsoft Learn pages and the Azure DevOps devblog.
Each fact carries its source URL. **UNCONFIRMED** marks anything not verified. Feeds
[../work-items-sync.md](../work-items-sync.md).*

**Bottom line for the adapter spec:**
- **Auth:** use Microsoft Entra with MSAL. Device-code flow for the CLI, auth-code flow for the local server. Accept an org-scoped PAT as the fallback for Azure DevOps Server and for orgs where Entra isn't possible.
- **Initial sync:** WIQL for ids, then `workitemsbatch` in chunks of 200.
- **Incremental sync:** `wit/reporting/workitemrevisions`, persisting its `continuationToken`. Microsoft's integration guidance says to use this instead of queries. A WIQL poll on `System.ChangedDate` is the simpler fallback.
- **Every write:** a JSON-Patch that starts with `{"op":"test","path":"/rev","value":N}`. Validate state changes against the work item type's `transitions` map. Treat 400/403 as the final word on permission.
- **Comments:** still preview only (`7.1-preview.4` / `7.2-preview.4`). Pin the version and expect previews to be retired.

---

## 1. Auth options for a local CLI/server tool

### Microsoft Entra ID OAuth (recommended)

- **Official recommendation.** "Use Microsoft Entra ID authentication for new applications that integrate with Azure DevOps Services. Use personal access tokens sparingly, and only when Microsoft Entra ID isn't available." (doc dated 2026-07-21) — https://learn.microsoft.com/en-us/azure/devops/integrate/get-started/authentication/authentication-guidance?view=azure-devops
- **Recommended method per app type** (same page): Web/desktop apps: "Microsoft Entra OAuth with the Microsoft Authentication Library (MSAL)". Headless/CLI apps: "Device authorization grant flow". Azure DevOps Server apps: ".NET client libraries or Windows Auth". Personal/ad hoc scripts: PATs.
- **Resource identifiers.** Resource ID `499b84ac-1321-427f-aa17-267ca6975798`; resource URI `https://app.vssps.visualstudio.com`. "Use the `.default` scope when requesting a token with all scopes that the app is permissioned for." So the scope is `499b84ac-1321-427f-aa17-267ca6975798/.default`. — https://learn.microsoft.com/en-us/azure/devops/integrate/get-started/authentication/entra-oauth?view=azure-devops
- **Personal Microsoft accounts are not supported.** "Microsoft Entra apps don't natively support Microsoft account (MSA) users for the Azure DevOps resource… Microsoft is currently working on native support." Orgs backed only by MSA accounts cannot use Entra OAuth today. (same page)
- **Identity mapping when migrating.** Use the ReadIdentities API to match identities across providers. (same page)
- **Tokens are opaque.** "Starting summer 2025, Azure DevOps is further encrypting authentication tokens… Any application that decodes tokens to extract claims breaks." Resolve the user through REST, never from token claims. — authentication-guidance URL above.
- **Azure CLI route.** Run `az login`, then `az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798 --query accessToken -o tsv`, and send the result as `Authorization: Bearer`. "Entra access tokens only last for one hour." The subscription must belong to the tenant connected to the org. — https://learn.microsoft.com/en-us/azure/devops/cli/entra-tokens?view=azure-devops
  - A zero-registration option for users who already have `az` installed.
  - **UNCONFIRMED:** whether the `azure-devops` extension's `az devops login` still stores a PAT.
- **Entra and OAuth are cloud-only.** "OAuth 2.0 and Microsoft Entra ID authentication are available for Azure DevOps Services only, not Azure DevOps Server." — authentication-guidance URL above.

### Personal Access Tokens

- **How to send a PAT.** HTTP Basic with an empty username: base64 of `:{PAT}` in `Authorization: Basic …`. PATs are 84 characters and contain the `AZDO` signature at positions 76–80. — https://learn.microsoft.com/en-us/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate?view=azure-devops (doc dated 2026-09-21)
- **Scopes.** `vso.work` "Grants the ability to read work items, queries, boards, area and iterations paths…" — https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/wiql/query-by-wiql?view=azure-devops-rest-7.1 · `vso.work_write` "Grants the ability to read, create, and update work items and queries…" — https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/work-items/update?view=azure-devops-rest-7.1 · Identity lookup needs `vso.identity`. — https://learn.microsoft.com/en-us/rest/api/azure/devops/ims/identities/read-identities?view=azure-devops-rest-7.1 · **UNCONFIRMED:** the exact wording for `vso.work_full`.
- **Global PATs are being retired.** "All existing global PATs stop working on December 1, 2026." Create only organization-scoped PATs. (PAT page above; also https://learn.microsoft.com/en-us/azure/devops/release-notes/2026/sprint-270-update)
- **Admin policies.** Tenant admins can restrict global and full-scoped PATs, set a maximum PAT lifetime, and control automatic revocation of leaked PATs. Organization owners can restrict PAT creation. A user's regeneration may be blocked. (PAT page above)
- **Maximum lifetime.** **UNCONFIRMED:** the platform default maximum (commonly cited as one year).
- **Inactivity.** For Entra-backed orgs, "sign in with a new PAT within 90 days or it becomes inactive." Conditional Access may force re-authentication. (PAT page)
- **Where PATs don't work.** PATs "work with most" REST APIs. The Organizations, Profiles and PAT Lifecycle APIs require Entra tokens. (PAT page)
- **On-prem gotcha.** "For Azure DevOps Server, IIS Basic Authentication prevents PAT authentication. Keep IIS Basic Authentication disabled." (PAT page)
- **Leaked PATs.** A PAT found in a public GitHub repo is auto-revoked unless tenant policy disables that. (PAT page)
- **OAuth-policy switch.** If an admin disabled "Third-party application access through OAuth", OAuth tokens fail with `TF400813` while PATs still work. — https://learn.microsoft.com/en-us/azure/devops/integrate/get-started/authentication/azure-devops-oauth?view=azure-devops

### Legacy Azure DevOps OAuth 2.0 (deprecated)

- "Azure DevOps OAuth is deprecated and scheduled for removal in 2026… New app registrations are no longer accepted as of April 2025." — https://learn.microsoft.com/en-us/azure/devops/integrate/get-started/authentication/azure-devops-oauth?view=azure-devops
- **UNCONFIRMED:** the exact 2026 cutoff date. Not an option for a new tool.

### Azure DevOps Server (on-prem)

- Use PATs or Windows authentication. Microsoft's FAQ: build "separate authentication paths for each service." — authentication-guidance URL above.
- **UNCONFIRMED:** NTLM/Negotiate specifics for a Node client. A Node 24 tool would need an NTLM/Kerberos library, so PAT is the practical path.

### Recommendation for a desktop developer tool

Use Entra delegated auth through MSAL Node: the CLI uses the device-code flow; the local server uses the auth-code flow with PKCE and a loopback redirect; request the scope `499b84ac-…/.default`; offer `az account get-access-token` as a zero-setup alternative; keep org-scoped PATs as the fallback for Azure DevOps Server and MSA-only orgs.

**UNCONFIRMED:** whether Microsoft publishes a first-party public client ID that third-party tools may reuse. Assume the consumer or tool registers its own Entra app, and that tenant admin consent may be required.

### Pitfalls

- **URL forms.** Services: `https://dev.azure.com/{organization}`. Server/TFS: `{server:port}/tfs/{collection}`. Identity APIs live on a different host: `https://vssps.dev.azure.com/{organization}`. (https://learn.microsoft.com/en-us/rest/api/azure/devops/?view=azure-devops-rest-7.2 and the read-identities URL above) **UNCONFIRMED:** whether legacy `https://{org}.visualstudio.com` URLs still work. Normalise both forms to the org name.
- **`api-version` is mandatory.** "API version must be specified with every request." Query string or `Accept: application/json;api-version=…`. — https://learn.microsoft.com/en-us/azure/devops/integrate/concepts/rest-api-versioning?view=azure-devops
- **Preview versions expire.** After release, a `-preview` version "is deprecated and can be deactivated after 12 weeks… requests that specify a -preview version get rejected." (same page)
- **Scope level differs per endpoint.** WIQL is `{org}/{project?}/{team?}/_apis/wit/wiql`; `workitemsbatch` accepts an optional project; comments and type states require a project; the permissions batch is org-level.

---

## 2. Read API (all `api-version=7.1` unless noted)

### WIQL query

- **Request.** `POST {org}/{project?}/{team?}/_apis/wit/wiql?api-version=7.1`. Optional `$top` and `timePrecision` (boolean). Body: `{"query": "…"}`. — https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/wiql/query-by-wiql?view=azure-devops-rest-7.1
- **Response.** `WorkItemQueryResult` with `asOf`, `columns`, `queryType` (`flat|tree|oneHop`), `queryResultType`, `sortColumns`, `workItems[] {id,url}`, and `workItemRelations[] {rel, source, target}` for link queries.
- **Ids only.** "The API only returns work item IDs, regardless of which fields you include in the SELECT statement." — https://learn.microsoft.com/en-us/azure/devops/boards/queries/wiql-syntax?view=azure-devops
- **Limits** (Services): query results 20,000 items; query length 32,000 characters; execution time 30 s on Services, 6 min on Server; "Results are truncated at 20,000 items - no error is shown." — https://learn.microsoft.com/en-us/azure/devops/organizations/settings/work/object-limits?view=azure-devops (doc dated 2026-09-10)
- **Timeout error.** "VS402335: The timeout period (30 seconds) elapsed…" — https://learn.microsoft.com/en-us/azure/devops/integrate/concepts/integration-bestpractices?view=azure-devops
- **Dates.** Literals are in the client's locale unless ISO 8601 or UTC with a `Z` suffix, e.g. `[System.ChangedDate] >= '1/1/2025 00:00:00Z'`. Without time precision, times default to midnight. Use `timePrecision=true` for sub-day incremental polling. — wiql-syntax URL above.
- **Link queries and system link types.** `FROM workItemLinks` with `MODE (MustContain|MayContain|DoesNotContain|Recursive)`. System link types: `System.LinkTypes.Hierarchy-Forward`, `System.LinkTypes.Related`, `System.LinkTypes.Dependency-Predecessor/Successor`, `Microsoft.VSTS.Common.Affects-Forward` (CMMI).

### Get work items batch

- `POST {org}/{project?}/_apis/wit/workitemsbatch?api-version=7.1`. "Gets work items for a list of work item ids (Maximum 200)." Body: `ids[]`, `fields[]`, `$expand` (`none|relations|fields|links|all`), `asOf`, `errorPolicy` (`fail|omit`). — https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/work-items/get-work-items-batch?view=azure-devops-rest-7.1

### Single work item

- `GET …/_apis/wit/workitems/{id}?$expand=all` uses the same `WorkItemExpand` enum. `_links` include `workItemUpdates`, `workItemRevisions`, `workItemHistory`, `html`, `workItemType` and `fields`. — https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/work-items/create?view=azure-devops-rest-7.1

### Updates and revisions

- **Updates (field deltas).** `GET {org}/{project}/_apis/wit/workItems/{id}/updates?$top&$skip&api-version=7.1`. A `WorkItemUpdate` has `id, rev, revisedBy, revisedDate`, `fields: {ref: {oldValue,newValue}}` and `relations: {added,removed,updated}`. — https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/updates/list?view=azure-devops-rest-7.1
- **Revisions (full snapshots).** `GET …/workItems/{id}/revisions?$top&$skip&$expand&api-version=7.1`, "fully hydrated work item revisions, paged." — https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/revisions/list?view=azure-devops-rest-7.1

### Comments (preview only)

- **List.** `GET {org}/{project}/_apis/wit/workItems/{id}/comments?$top&continuationToken&includeDeleted&$expand&order&api-version=7.2-preview.4`. Response: `totalCount, count, comments[], continuationToken, nextPage`. `$expand` values: `none|reactions|renderedText|renderedTextOnly|all`; `renderedText` means "Include the rendered text (html) in addition to MD text." — https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/comments/get-comments?view=azure-devops-rest-7.2
- **Comment fields.** `id, workItemId, version, text, renderedText` ("in HTML format"), `format` (`markdown|html`), `createdBy/modifiedBy` (IdentityRef), `createdDate/modifiedDate`, `isDeleted`, `mentions[]`, `reactions[]`.
- **Add comment on 7.1.** `POST …/comments?api-version=7.1-preview.4` with body `{text}`. No `format` parameter. — https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/comments/add-comment?view=azure-devops-rest-7.1
- **Add comment on 7.2.** `POST …/comments?format={markdown|html}&api-version=7.2-preview.4`. `format` is **Required**. — https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/comments/add-work-item-comment?view=azure-devops-rest-7.2
- **Summary.** Comments have no GA version. Markdown comments need 7.2-preview. Azure DevOps Server 2022.1 is capped at 7.1, which has no `format` parameter.

### Relations and links

- **Shape.** `relations[] {rel, url, attributes}`. Examples use `System.LinkTypes.Hierarchy-Reverse` (parent), `System.LinkTypes.Dependency-forward`, attachments and hyperlinks. — update URL above.
- **Link limit.** 1,000 links per work item. — object-limits URL above.
- **UNCONFIRMED:** the relation-types list endpoint (`_apis/wit/workitemrelationtypes`).

### Attachments

- Limits on Services: 100 per work item, 60 MB each. On Server the default is 4 MB, configurable up to 2 GB. Adding one is a `/relations/-` patch with rel `AttachedFile`. **UNCONFIRMED:** upload endpoint details (`POST _apis/wit/attachments`).

### Work item types, states and fields

- **Type definition.** `GET {org}/{project}/_apis/wit/workitemtypes/{type}?api-version=7.1` returns `name, referenceName, color, icon, isDisabled, states[] {name,color,category}`, `fields/fieldInstances[] {referenceName, name, alwaysRequired, allowedValues, defaultValue, dependentFields, helpText}`, and `transitions` (a map from state to `[{to, actions}]`; the `""` key gives the initial state). — https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/work-item-types/get?view=azure-devops-rest-7.1
- **States.** `GET {org}/{project}/_apis/wit/workitemtypes/{type}/states?api-version=7.1` returns `[{name, color, category}]`, e.g. New→Proposed, Active→InProgress, Resolved→Resolved, Closed→Completed. — https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/work-item-type-states/list?view=azure-devops-rest-7.1
- **UNCONFIRMED:** the org fields list (`_apis/wit/fields`).

### Process state models and categories

- **Categories:** Proposed, In Progress, Resolved, Completed, plus Removed.
- **Default mappings:**

| Process | Proposed | In Progress | Resolved | Completed | Removed |
| --- | --- | --- | --- | --- | --- |
| Agile | New | Active | Resolved (Bug) | Closed | Removed |
| Basic | To Do | Doing | — | Done | — |
| Scrum | New / Approved / To Do (Task) | Committed / Open (Impediment) | — | Done | Removed |
| CMMI | Proposed | Active, plus Resolved for Epic/Feature/Requirement/Task | Resolved (Bug/Issue/Review/Risk) | Closed | none by default |

- Note the CMMI row: "Resolved" is in the In Progress category for some types, so never infer category from the state name. "Each work item type can have only one state mapped to this category" (Completed). — https://learn.microsoft.com/en-us/azure/devops/boards/work-items/workflow-and-state-categories?view=azure-devops (doc dated 2026-07-01)

### Iterations, areas and boards

- **Team iterations.** `GET {org}/{project}/{team}/_apis/work/teamsettings/iterations?$timeframe=current&api-version=7.1` returns `{id, name, path, attributes {startDate, finishDate, timeFrame: past|current|future}}`. Only `Current` is supported as a timeframe filter. — https://learn.microsoft.com/en-us/rest/api/azure/devops/work/iterations/list?view=azure-devops-rest-7.1
- **Classification nodes.** `GET {org}/{project}/_apis/wit/classificationnodes?ids&$depth&errorPolicy&api-version=7.1` returns nodes with `{id, identifier (GUID), name, structureType: area|iteration, hasChildren, children, path, attributes}`. — https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/classification-nodes/get-classification-nodes?view=azure-devops-rest-7.1
- **Area/iteration limits:** 10,000 per project, 14 levels deep. — object-limits URL above.
- **Board visibility.** On Services, backlogs and boards hide completed items whose `ChangedDate` is older than 183 days. — workflow-and-state-categories URL above.
- **UNCONFIRMED:** boards and backlogs REST endpoints.

### Reporting revisions (the incremental feed)

- **Request.** `GET {org}/{project?}/_apis/wit/reporting/workitemrevisions?api-version=7.1` with parameters `fields, types, continuationToken, startDateTime, includeIdentityRef, includeDeleted, includeTagRef, includeLatestOnly, $expand (none|fields), includeDiscussionChangesOnly, $maxPageSize`.
- **Watermark.** "continuationToken… Specifies the watermark to start the batch from." Response: `values[], nextLink, continuationToken` ("acts as a waterMark"), `isLastBatch`.
- **Mutual exclusion.** `startDateTime` "Cannot be used in conjunction with 'watermark' parameter."
- **Long text.** Long text fields are not returned by default; `$expand=fields` is needed.
- Source: https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/reporting-work-item-revisions/read-reporting-revisions-get?view=azure-devops-rest-7.1
- **This is Microsoft's intended bulk and incremental path.** "Using queries and individual get work item calls is the top way to get rate limits enforced… Don't execute queries to return large lists of work items. Use the reporting work item links and work item revisions REST APIs instead." — https://learn.microsoft.com/en-us/azure/devops/integrate/concepts/integration-bestpractices?view=azure-devops (doc dated 2026-03-02)
- There is a sibling reporting work-item-links API, referenced on the same page.
- **UNCONFIRMED:** the maximum `$maxPageSize`; how long a continuation token stays valid; whether comments (as opposed to the `System.History` discussion field) appear in the feed.

### Rate limits

- **The limit.** "The global limit is 200 TSTUs within any sliding five-minute window." One TSTU is the average load of a typical user over five minutes.
- **Throttling behaviour.** Delays range "from a few milliseconds per request up to 30 seconds." When blocked, the response is HTTP 429 with `TF400733`.
- **Headers:** `Retry-After` (seconds), `X-RateLimit-Resource`, `X-RateLimit-Delay`, `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` (epoch), `X-RateLimit-Cost` (TSTUs for this request). All except `X-RateLimit-Delay` are sent before delays begin. `Retry-After` can arrive on an HTTP 200.
- **Higher limits.** Assigning the "Basic + Test Plans" access level to the identity raises them.
- Source: https://learn.microsoft.com/en-us/azure/devops/integrate/concepts/rate-limits?view=azure-devops (doc dated 2025-09-15, updated 2026-07)

---

## 3. Write API

### Create

- `POST {org}/{project}/_apis/wit/workitems/${type}?validateOnly&bypassRules&suppressNotifications&$expand&api-version=7.1`. The `$` before the type is literal. Media type `application/json-patch+json`. Ops: `add|remove|replace|move|copy|test`. — https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/work-items/create?view=azure-devops-rest-7.1

### Update

- `PATCH {org}/{project?}/_apis/wit/workitems/{id}?validateOnly&bypassRules&suppressNotifications&$expand&api-version=7.1`. `bypassRules`: "Do not enforce the work item type rules on this update". `suppressNotifications`: "Do not fire any notifications for this change". `validateOnly` validates without saving. — https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/work-items/update?view=azure-devops-rest-7.1

### Optimistic concurrency

- Every official example starts with `{"op":"test","path":"/rev","value":N}`. The path is `/rev`, not `/fields/System.Rev`.
- **UNCONFIRMED:** the exact HTTP status and error code for a stale rev (believed 400 with a test-operation failure). Treat any failure of the test op as a conflict: refetch, then rebase or ask the user.

### Common operations (from the update page's examples)

- **Tags:** `{"op":"add","path":"/fields/System.Tags","value":"Tag1; Tag2"}`, semicolon-separated. 100 tags per work item.
- **Link:** `{"op":"add","path":"/relations/-","value":{"rel":"System.LinkTypes.Dependency-forward","url":"…/_apis/wit/workItems/300","attributes":{"comment":"…"}}}`. Removing a link targets `/relations/{index}`.
- **Assign:** `System.AssignedTo` accepts a display name, a distinct display name (`"Jamal Hartnett<fabrikamfiber4@hotmail.com>"`), or a full IdentityRef object with `id` and `descriptor`. A plain display name is ambiguous, so prefer the distinct form or the IdentityRef.
- **bypassRules example:** writes `"Invalid Value"` into `System.AssignedTo` and succeeds.

### bypassRules and suppressNotifications permissions

- These map to the Project-namespace permissions `BYPASS_RULES` and `SUPPRESS_NOTIFICATIONS`. — https://learn.microsoft.com/en-us/azure/devops/organizations/security/namespace-reference?view=azure-devops
- An ordinary contributor won't have them. Never default either to true.

### State changes

- Set `System.State`, and optionally `System.Reason`.
- **Inherited processes.** Adding a custom state creates "Bidirectional transitions to and from all existing states… automatically." Default reasons are "Moved to state X" and "Moved out of state X". "You can't specify custom Reasons." Custom rules can apply on transitions. — https://learn.microsoft.com/en-us/azure/devops/organizations/settings/work/customize-process-workflow?view=azure-devops (doc dated 2026-03-03)
- **Hidden or removed states.** Items left in them "become invalid… You must update the state value before making any changes."
- **Validation.** The allowed transition graph is exposed in `WorkItemType.transitions`.
- **UNCONFIRMED:** the exact error for an illegal transition or a rule violation (expect a 400 rule-validation error). Pre-validate against `transitions` and `allowedValues`, and use `validateOnly=true` as a dry run.

### Add a comment

- See section 2. Preview-only endpoints; need the `vso.work_write` scope.

### Markdown in long-text fields

- **The patch op.** `{"op":"add","path":"/multilineFieldsFormat/System.Description","value":"Markdown"}`. Works on Description, Repro Steps, Acceptance Criteria and custom large text fields.
- **Default is HTML.** Fields created through the REST API are HTML unless you set this. **One-way.** "Once you convert a field to Markdown, there's no way to revert it back to HTML."
- **Rollout.** GA from 2025-07-07 on Services. On-prem timeline "TBD". — https://devblogs.microsoft.com/devops/markdown-support-arrives-for-work-items/
- **UNCONFIRMED:** whether GET returns markdown or HTML for markdown fields; whether `multilineFieldsFormat` appears on the WorkItem object in REST responses.

### Revision limit

- "The REST API… enforces a work item revision limit of 10,000 updates" per item. Batch field changes into one PATCH.

### Permission discovery

- **Permissions batch.** `POST {org}/_apis/security/permissionevaluationbatch?api-version=7.1`. Body: `{alwaysAllowAdministrators, evaluations:[{securityNamespaceId, token, permissions(bit)}]}`. Each result carries `value: bool`. "does not aggregate the results, nor does it short-circuit." — https://learn.microsoft.com/en-us/rest/api/azure/devops/security/permissions/has-permissions-batch?view=azure-devops-rest-7.1
- **Relevant namespaces:** **CSS (area paths):** `83e28ad4-2d72-4ceb-97b0-c7726d5502c3`, permissions `GENERIC_READ, GENERIC_WRITE, CREATE_CHILDREN, DELETE, WORK_ITEM_READ, WORK_ITEM_WRITE, MANAGE_TEST_PLANS, MANAGE_TEST_SUITES`, token `vstfs:///Classification/Node/{area_node_guid}` (hierarchical). **Project:** `52d39943-cb85-4d7f-8fa8-c6baac873819`, includes `WORK_ITEM_DELETE`, `WORK_ITEM_MOVE`, `BYPASS_RULES`, `SUPPRESS_NOTIFICATIONS`. **Tagging:** `bb50f182-8e5e-40b8-bc21-e8752a1e7ae2`. — namespace-reference URL above.
- **UNCONFIRMED:** the exact permission bit values (fetch at runtime with `GET _apis/securitynamespaces/{id}`); how hierarchical area tokens are chained (assume `:` like the Iteration example).
- **Practical guidance.** Use the batch evaluation as a best-effort pre-check for write access per area. It cannot predict rule failures or field-level rules, and Entra Conditional Access can also block calls. A 403 or 400 on the actual write remains the final signal. `validateOnly=true` is the closest thing to a dry run.

---

## 4. Change detection

### Service hooks (push)

- Events: `workitem.created`, `workitem.updated`, `workitem.deleted`, `workitem.restored`, `workitem.commented`. Publisher `tfs`. Filters: `areaPath`, `workItemType`, `changedFields`. — https://learn.microsoft.com/en-us/azure/devops/service-hooks/events?view=azure-devops
- Managing subscriptions needs the ServiceHooks namespace (`EditSubscriptions`), which Project Collection Administrators have by default.
- They need a publicly reachable HTTPS endpoint (inference). Not practical for a desktop tool without a relay.

### Polling (pull)

- **Option A (Microsoft-recommended):** the reporting revisions feed. First call without a token. Persist `continuationToken`. Loop until `isLastBatch`, then poll with the saved token. `includeDeleted=true` to see deletions. `includeLatestOnly=true` skips history.
- **Option B:** WIQL `[System.ChangedDate] > '{last}Z'` with `timePrecision=true`, then `workitemsbatch` in chunks of 200. Simpler, but does not see hard deletes; subject to the 20,000-row silent truncation and the 30-second query timeout; Microsoft names queries as the leading rate-limit trigger.
- **Comments:** comment changes update the work item, but not reliably as a field. Re-pull `/comments` for items whose ChangedDate moved. **UNCONFIRMED** whether the reporting feed covers comment edits.
- **Retention:** **UNCONFIRMED.**

---

## 5. Data model facts for a common schema

### Work item shape

- `{id, rev, url, fields{}, relations[]?, _links, commentVersionRef?}`. `_links` includes `self`, `workItemUpdates`, `workItemRevisions`, `workItemHistory`, `html` (web URL), `workItemType`, `fields`.

### Fields (keyed by reference name)

- `System.Id`, `System.Rev`, `System.WorkItemType`, `System.Title`, `System.State`, `System.Reason`
- `System.AssignedTo`, `System.CreatedBy`, `System.CreatedDate`, `System.ChangedBy`, `System.ChangedDate`
- `System.AreaPath`, `System.IterationPath`, `System.TeamProject`, `System.Tags`
- `System.Description`, `System.History`, `System.BoardColumn`, `System.BoardColumnDone`, `System.RevisedDate`
- `Microsoft.VSTS.Common.Priority`, `Microsoft.VSTS.Common.StateChangeDate`, `Microsoft.VSTS.Common.ActivatedDate/By`, `Microsoft.VSTS.Common.ResolvedDate/By`, `Microsoft.VSTS.Common.ClosedDate/By`, `Microsoft.VSTS.Common.Severity`, `Microsoft.VSTS.Common.ValueArea`, `Microsoft.VSTS.Common.BacklogPriority`
- `Microsoft.VSTS.Scheduling.StoryPoints`, `Microsoft.VSTS.Scheduling.RemainingWork`, `Microsoft.VSTS.Scheduling.OriginalEstimate`, `Microsoft.VSTS.Scheduling.CompletedWork`
- `Microsoft.VSTS.TCM.ReproSteps`

Custom fields on inherited processes use a `Custom.` prefix (e.g. `Custom.Approver`).

- The reporting feed also emits team-specific Kanban fields such as `WEF_<guid>_Kanban.Column`. Expect dynamic keys.
- `Activated/Resolved By/Date` are set by the system from state-category changes. "Don't manually change these field values."
- **UNCONFIRMED:** `Microsoft.VSTS.Scheduling.Effort` (Scrum) and `System.Parent` did not appear in the pages fetched. Derive the parent from the `System.LinkTypes.Hierarchy-Reverse` relation. The reporting feed may stringify `System.Parent`.

### Identity fields

- IdentityRef shape: `{displayName, uniqueName, id, descriptor, imageUrl, url, _links.avatar}`. The definition marks `uniqueName` and `imageUrl` as **deprecated**, and `displayName` as non-unique. `descriptor` is "the primary way to reference the graph subject… unique across Accounts and Organizations." Key users on `descriptor`, falling back to `id`.
- In the reporting feed, identity fields come as strings (`"Name <email>"`) unless `includeIdentityRef=true`.

### Resolving users

- `GET https://vssps.dev.azure.com/{org}/_apis/identities?searchFilter=General|AccountName|DisplayName|MailAddress&filterValue=…&api-version=7.1`, or by `identityIds` or `subjectDescriptors`. Needs `vso.identity`. — https://learn.microsoft.com/en-us/rest/api/azure/devops/ims/identities/read-identities?view=azure-devops-rest-7.1
- **UNCONFIRMED:** `_apis/graph/users` details.

### State category (the equivalent of Jira's statusCategory)

- **Confirmed.** `…/workitemtypes/{type}/states` returns `category` per state, as does `WorkItemType.states[]`. Strings: `Proposed`, `InProgress`, `Resolved`, `Completed`. The conceptual docs add `Removed` (**UNCONFIRMED** REST string). Custom states pick a category, and category names cannot be changed.

---

## 6. Constraints to design around

### API versions

| Area | Version |
| --- | --- |
| Work items, WIQL, batch, updates, revisions, reporting, types, states, classification nodes, iterations, identities, permission batch | `7.1` GA |
| Comments | `7.1-preview.4` / `7.2-preview.4` only |
| Markdown comment create | `7.2-preview.4` with required `format` |

- Previews can be deactivated 12 weeks after release.

### Batch and query limits

- 200 ids per `workitemsbatch` · WIQL 20,000 results (silently truncated), 32,000 characters, 30-second timeout · 10,000 REST revisions per item · 1,000 links per item · 100 tags per item · 100 attachments per item, 60 MB each · 1M characters per long-text field.

### Text formats

- Long-text fields default to HTML. Markdown can be enabled per field and per item via `multilineFieldsFormat`, one-way, cloud only. Comments carry `text` (markdown or source depending on format) plus `renderedText` in HTML. Store both the raw value and a format flag.

### Credential lifecycle

- Entra access tokens last about one hour; plan for silent refresh through the MSAL cache.
- PATs: global PATs die on 2026-12-01; org policy can cap lifetime, block creation or block full-scope PATs; unused PATs go inactive after 90 days on Entra-backed orgs; a PAT leaked to a public GitHub repo is auto-revoked.

### Rate limits

- Throttle on `X-RateLimit-Remaining` and honour `Retry-After`, even on a 200. Back off on 429 and `TF400733`.

### On-prem version skew

| Server version | Max REST version |
| --- | --- |
| Azure DevOps Server 2022 | 7.0 |
| Azure DevOps Server 2022.1 | 7.1 |
| Azure DevOps Server 2020 | 6.0 |
| Azure DevOps Server 2019 | 5.0 |

- The newest on-prem product is "Azure DevOps Server" (no year), Modern Lifecycle Policy, maps to REST 7.2 ("vNext = 7.2"). Base URL `{server:port}/tfs/{collection}`. No Entra; PAT or Windows auth. Probe the server version and cap `api-version` to match. — https://learn.microsoft.com/en-us/rest/api/azure/devops/?view=azure-devops-rest-7.2

### Other gotchas

- Board and backlog views hide completed items older than 183 days, but queries still return them.
- Rules and the SQL expression complexity of heavily customised processes can fail saves.

---

## Not confirmed (verify before finalising the spec)

1. The exact 2026 cutoff date for legacy Azure DevOps OAuth.
2. The platform default maximum PAT lifetime.
3. Whether `{org}.visualstudio.com` URLs still work.
4. The HTTP status and error body for a failed `test /rev` op and for an illegal state transition or rule violation.
5. CSS namespace bit values and how area tokens chain.
6. Reporting feed: maximum page size, token retention, and whether comments are covered.
7. Whether GET returns markdown or HTML for markdown-enabled fields.
8. `Effort` and `System.Parent` field presence.
9. Endpoint details for `_apis/wit/fields`, `_apis/wit/workitemrelationtypes`, `_apis/wit/attachments`, `_apis/graph/users`, and boards/backlogs.
10. The `Removed` category string in REST.
11. A reusable first-party Entra client ID for third-party CLIs.
12. NTLM/Kerberos from Node against Azure DevOps Server.
