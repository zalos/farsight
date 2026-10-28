// Numbered, checksummed ledger migrations and the runner that applies them. Every pending step runs in one
// transaction; an existing ledger is first copied with SQLite's online backup and the copy verified, so a failed
// upgrade leaves the prior schema and data untouched and a recoverable copy beside it.
import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { LedgerError, type LedgerFailpoint, type Migration, type MigrationReport } from './store-types.js';
import { sha256Id } from '../kernel/digest.js';

/** `PRAGMA application_id` of a Sentinel ledger ('STNL'); any other non-empty SQLite file is refused. */
export const LEDGER_APPLICATION_ID = 0x53544e4c;

// SQL fragments shared by the first migration. They are literal text (a checksum covers them), and
// test/store-migrations.test.ts asserts each enumerated set equals the contract's own pinned list.
const DIGEST = (col: string) =>
  `length(${col}) = 71 AND substr(${col}, 1, 7) = 'sha256:' AND substr(${col}, 8) NOT GLOB '*[^0-9a-f]*'`;
const PRIVACY_RANK = (v: string) =>
  `(CASE ${v} WHEN 'metadata' THEN 0 WHEN 'source-derived' THEN 1 WHEN 'source' THEN 2 END)`;
const APPEND_ONLY = (table: string, what: 'UPDATE' | 'DELETE') =>
  `CREATE TRIGGER ${table}_no_${what.toLowerCase()} BEFORE ${what} ON ${table}
     BEGIN SELECT RAISE(ABORT, 'sentinel.store.appendOnly: ${table}'); END;`;

const V1 = `
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY CHECK (version >= 1),
  name TEXT NOT NULL,
  checksum TEXT NOT NULL CHECK (${DIGEST('checksum')}),
  build TEXT NOT NULL,
  applied_at TEXT NOT NULL
) STRICT;

CREATE TABLE epochs (
  epoch TEXT PRIMARY KEY,
  previous_epoch TEXT REFERENCES epochs(epoch),
  opened_at TEXT NOT NULL
) STRICT;

CREATE TABLE ledger_store (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  store_id TEXT NOT NULL,
  current_epoch TEXT NOT NULL REFERENCES epochs(epoch),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES runs(id),
  snapshot_id TEXT NOT NULL,
  plan_revision INTEGER NOT NULL CHECK (plan_revision >= 1),
  coordinator_epoch TEXT NOT NULL REFERENCES epochs(epoch),
  state TEXT NOT NULL CHECK (state IN ('planned','running','pausing','paused','canceling','canceled','completed')),
  outcome TEXT CHECK (outcome IN ('complete-coverage','partial-coverage','execution-failure')),
  completed_at TEXT,
  envelope TEXT NOT NULL CHECK (json_valid(envelope)),
  created_at TEXT NOT NULL,
  CHECK (parent_id IS NULL OR parent_id <> id),
  CHECK ((state = 'completed') = (outcome IS NOT NULL)),
  CHECK ((state = 'completed') = (completed_at IS NOT NULL))
) STRICT;

CREATE TABLE work_units (
  id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  run_id TEXT NOT NULL REFERENCES runs(id),
  plan_revision INTEGER NOT NULL CHECK (plan_revision >= 1),
  input_fingerprint TEXT NOT NULL CHECK (${DIGEST('input_fingerprint')}),
  influence_manifest TEXT NOT NULL CHECK (${DIGEST('influence_manifest')}),
  coordinator_epoch TEXT NOT NULL REFERENCES epochs(epoch),
  state TEXT NOT NULL CHECK (state IN
    ('pending','ready','published','failed','running','leased','blocked','disabled-by-policy','satisfied-by-reuse')),
  active_attempt_id TEXT,
  envelope TEXT NOT NULL CHECK (json_valid(envelope)),
  PRIMARY KEY (id, revision),
  FOREIGN KEY (active_attempt_id, id, revision)
    REFERENCES attempts(id, work_id, work_revision) DEFERRABLE INITIALLY DEFERRED,
  CHECK ((state IN ('running','leased')) = (active_attempt_id IS NOT NULL))
) STRICT;
-- Locates a run's revisions; readiness also needs state and dependency checks, so it is not called ready_work.
CREATE INDEX work_by_run ON work_units(run_id, state, id, revision);

CREATE TABLE work_dependencies (
  work_id TEXT NOT NULL,
  work_revision INTEGER NOT NULL,
  depends_on_id TEXT NOT NULL,
  depends_on_revision INTEGER NOT NULL,
  PRIMARY KEY (work_id, work_revision, depends_on_id, depends_on_revision),
  FOREIGN KEY (work_id, work_revision) REFERENCES work_units(id, revision),
  FOREIGN KEY (depends_on_id, depends_on_revision) REFERENCES work_units(id, revision),
  CHECK (NOT (work_id = depends_on_id AND work_revision = depends_on_revision))
) STRICT;

CREATE TABLE attempts (
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL,
  work_revision INTEGER NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
  coordinator_epoch TEXT NOT NULL REFERENCES epochs(epoch),
  state TEXT NOT NULL CHECK (state IN
    ('running','succeeded','failed','interrupted','canceled','canceled-after-spend')),
  usage_certainty TEXT NOT NULL CHECK (usage_certainty IN ('confirmed','unknown','not-applicable')),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  envelope TEXT NOT NULL CHECK (json_valid(envelope)),
  -- Observed when the attempt ends: the validated final envelope and its usage certainty. The start-time
  -- identity (envelope, usage_certainty) is immutable; these columns are written once, with the end.
  final_usage_certainty TEXT CHECK (final_usage_certainty IN ('confirmed','unknown','not-applicable')),
  final_envelope TEXT CHECK (final_envelope IS NULL OR json_valid(final_envelope)),
  CHECK ((state = 'running') = (final_envelope IS NULL)),
  CHECK ((final_envelope IS NULL) = (final_usage_certainty IS NULL)),
  UNIQUE (work_id, work_revision, ordinal),
  UNIQUE (id, work_id, work_revision),
  FOREIGN KEY (work_id, work_revision) REFERENCES work_units(id, revision),
  CHECK ((state = 'running') = (ended_at IS NULL))
) STRICT;

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY CHECK (${DIGEST('id')}),
  raw_size INTEGER NOT NULL CHECK (raw_size BETWEEN 0 AND 16777216),
  privacy_floor TEXT NOT NULL CHECK (privacy_floor IN ('metadata','source-derived','source')),
  first_sequence INTEGER NOT NULL
) STRICT;

CREATE TABLE artifact_objects (
  artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  codec TEXT NOT NULL CHECK (codec IN ('identity','gzip')),
  stored_digest TEXT NOT NULL CHECK (${DIGEST('stored_digest')}),
  stored_size INTEGER NOT NULL CHECK (stored_size >= 0),
  PRIMARY KEY (artifact_id, codec),
  CHECK (codec <> 'identity' OR stored_digest = artifact_id)
) STRICT;

CREATE TABLE artifact_links (
  parent_id TEXT NOT NULL REFERENCES artifacts(id),
  child_id TEXT NOT NULL REFERENCES artifacts(id),
  PRIMARY KEY (parent_id, child_id),
  CHECK (parent_id <> child_id)
) STRICT;
CREATE INDEX artifact_links_by_child ON artifact_links(child_id);

CREATE TABLE publications (
  work_id TEXT NOT NULL,
  work_revision INTEGER NOT NULL,
  attempt_id TEXT NOT NULL UNIQUE,
  result_digest TEXT NOT NULL CHECK (${DIGEST('result_digest')}),
  coordinator_epoch TEXT NOT NULL REFERENCES epochs(epoch),
  accepted_at TEXT NOT NULL,
  sequence INTEGER NOT NULL UNIQUE REFERENCES events(sequence),
  PRIMARY KEY (work_id, work_revision),
  FOREIGN KEY (work_id, work_revision) REFERENCES work_units(id, revision),
  FOREIGN KEY (attempt_id, work_id, work_revision) REFERENCES attempts(id, work_id, work_revision)
) STRICT;

-- An accepted reference exists only beside its publication: there is no path to a reference without one.
CREATE TABLE artifact_refs (
  work_id TEXT NOT NULL,
  work_revision INTEGER NOT NULL,
  attempt_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  role TEXT NOT NULL CHECK (role IN ('output','linked')),
  position INTEGER CHECK (position >= 0),
  schema TEXT NOT NULL CHECK (length(schema) BETWEEN 1 AND 128),
  privacy TEXT NOT NULL CHECK (privacy IN ('metadata','source-derived','source')),
  PRIMARY KEY (attempt_id, artifact_id),
  FOREIGN KEY (work_id, work_revision) REFERENCES publications(work_id, work_revision),
  FOREIGN KEY (attempt_id, work_id, work_revision) REFERENCES attempts(id, work_id, work_revision),
  CHECK ((role = 'output') = (position IS NOT NULL))
) STRICT;
CREATE INDEX artifact_refs_by_artifact ON artifact_refs(artifact_id);

-- Durable intent, written before any object byte. Rows here pin their IDs from collection until accepted or aborted.
CREATE TABLE staging (
  stage_id TEXT PRIMARY KEY,
  coordinator_epoch TEXT NOT NULL REFERENCES epochs(epoch),
  work_id TEXT,
  work_revision INTEGER,
  attempt_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (attempt_id, work_id, work_revision) REFERENCES attempts(id, work_id, work_revision),
  CHECK ((work_id IS NULL) = (work_revision IS NULL) AND (work_id IS NULL) = (attempt_id IS NULL))
) STRICT;

CREATE TABLE staging_artifacts (
  stage_id TEXT NOT NULL REFERENCES staging(stage_id) ON DELETE CASCADE,
  artifact_id TEXT NOT NULL CHECK (${DIGEST('artifact_id')}),
  schema TEXT NOT NULL CHECK (length(schema) BETWEEN 1 AND 128),
  privacy TEXT NOT NULL CHECK (privacy IN ('metadata','source-derived','source')),
  PRIMARY KEY (stage_id, artifact_id)
) STRICT;

CREATE TABLE staging_links (
  stage_id TEXT NOT NULL,
  parent_id TEXT NOT NULL,
  child_id TEXT NOT NULL CHECK (${DIGEST('child_id')}),
  PRIMARY KEY (stage_id, parent_id, child_id),
  FOREIGN KEY (stage_id, parent_id) REFERENCES staging_artifacts(stage_id, artifact_id) ON DELETE CASCADE,
  CHECK (parent_id <> child_id)
) STRICT;

CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  sequence INTEGER NOT NULL REFERENCES events(sequence),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE report_artifacts (
  report_id TEXT NOT NULL REFERENCES reports(id),
  artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  PRIMARY KEY (report_id, artifact_id)
) STRICT;

CREATE TABLE events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('epoch-opened','run-created','run-state','work-created','attempt-started',
    'attempt-ended','work-published','staging-registered','staging-aborted','report-pinned')),
  run_id TEXT REFERENCES runs(id),
  work_id TEXT,
  work_revision INTEGER,
  coordinator_epoch TEXT NOT NULL REFERENCES epochs(epoch),
  at TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload) AND length(CAST(payload AS BLOB)) <= 16384),
  FOREIGN KEY (work_id, work_revision) REFERENCES work_units(id, revision),
  CHECK ((work_id IS NULL) = (work_revision IS NULL))
) STRICT;
CREATE INDEX events_by_run ON events(run_id, sequence);

CREATE TABLE idempotency_keys (
  client_id TEXT NOT NULL,
  key TEXT NOT NULL,
  operation TEXT NOT NULL,
  request_digest TEXT NOT NULL CHECK (${DIGEST('request_digest')}),
  result TEXT NOT NULL CHECK (json_valid(result) AND length(CAST(result AS BLOB)) <= 16384),
  coordinator_epoch TEXT NOT NULL REFERENCES epochs(epoch),
  created_at TEXT NOT NULL,
  PRIMARY KEY (client_id, key)
) STRICT;

-- Append-only history: rows are never deleted, and identity columns never change in place.
${[
  'epochs',
  'runs',
  'work_units',
  'work_dependencies',
  'attempts',
  'artifacts',
  'artifact_objects',
  'artifact_links',
  'publications',
  'artifact_refs',
  'reports',
  'report_artifacts',
  'events',
  'idempotency_keys',
  'schema_migrations',
  'ledger_store',
]
  .map((t) => APPEND_ONLY(t, 'DELETE'))
  .join('\n')}
${[
  'epochs',
  'work_dependencies',
  'artifact_objects',
  'artifact_links',
  'publications',
  'artifact_refs',
  'reports',
  'report_artifacts',
  'events',
  'idempotency_keys',
  'schema_migrations',
  'staging_artifacts',
  'staging_links',
]
  .map((t) => APPEND_ONLY(t, 'UPDATE'))
  .join('\n')}

CREATE TRIGGER ledger_store_identity BEFORE UPDATE OF singleton, store_id, created_at ON ledger_store
  BEGIN SELECT RAISE(ABORT, 'sentinel.store.appendOnly: ledger_store identity'); END;
CREATE TRIGGER runs_identity BEFORE UPDATE OF id, parent_id, snapshot_id, plan_revision, coordinator_epoch, envelope,
  created_at ON runs BEGIN SELECT RAISE(ABORT, 'sentinel.store.appendOnly: runs identity'); END;
CREATE TRIGGER runs_terminal BEFORE UPDATE ON runs WHEN OLD.state IN ('completed','canceled')
  BEGIN SELECT RAISE(ABORT, 'sentinel.store.appendOnly: terminal run'); END;
CREATE TRIGGER work_identity BEFORE UPDATE OF id, revision, run_id, plan_revision, input_fingerprint,
  influence_manifest, coordinator_epoch, envelope ON work_units
  BEGIN SELECT RAISE(ABORT, 'sentinel.store.appendOnly: work identity'); END;
CREATE TRIGGER work_published BEFORE UPDATE ON work_units WHEN OLD.state = 'published'
  BEGIN SELECT RAISE(ABORT, 'sentinel.store.appendOnly: published work'); END;
CREATE TRIGGER attempts_identity BEFORE UPDATE OF id, work_id, work_revision, ordinal, coordinator_epoch,
  usage_certainty, started_at, envelope ON attempts
  BEGIN SELECT RAISE(ABORT, 'sentinel.store.appendOnly: attempt identity'); END;
CREATE TRIGGER attempts_ended BEFORE UPDATE ON attempts WHEN OLD.state <> 'running'
  BEGIN SELECT RAISE(ABORT, 'sentinel.store.appendOnly: ended attempt'); END;
CREATE TRIGGER artifacts_identity BEFORE UPDATE OF id, raw_size, first_sequence ON artifacts
  BEGIN SELECT RAISE(ABORT, 'sentinel.store.appendOnly: artifact identity'); END;
CREATE TRIGGER artifacts_no_privacy_downgrade BEFORE UPDATE OF privacy_floor ON artifacts
  WHEN ${PRIVACY_RANK('NEW.privacy_floor')} < ${PRIVACY_RANK('OLD.privacy_floor')}
  BEGIN SELECT RAISE(ABORT, 'sentinel.store.privacyDowngrade'); END;
CREATE TRIGGER staging_identity BEFORE UPDATE ON staging
  BEGIN SELECT RAISE(ABORT, 'sentinel.store.appendOnly: staging'); END;
`;

// Snapshot admission (PR 04). SQLite cannot change a CHECK in place, so the event log is rebuilt with the
// documented procedure (new table, copy every row with its sequence, drop, rename, recreate its index and
// triggers); the runner applies every step with foreign keys switched off and checks them before commit.
const EVENT_KINDS_V2 = `'epoch-opened','run-created','run-state','work-created','attempt-started',
    'attempt-ended','work-published','staging-registered','staging-aborted','report-pinned','snapshot-admitted'`;
const V2 = `
CREATE TABLE events_next (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN (${EVENT_KINDS_V2})),
  run_id TEXT REFERENCES runs(id),
  work_id TEXT,
  work_revision INTEGER,
  coordinator_epoch TEXT NOT NULL REFERENCES epochs(epoch),
  at TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload) AND length(CAST(payload AS BLOB)) <= 16384),
  FOREIGN KEY (work_id, work_revision) REFERENCES work_units(id, revision),
  CHECK ((work_id IS NULL) = (work_revision IS NULL))
) STRICT;
INSERT INTO events_next (sequence, kind, run_id, work_id, work_revision, coordinator_epoch, at, payload)
  SELECT sequence, kind, run_id, work_id, work_revision, coordinator_epoch, at, payload FROM events ORDER BY sequence;
DROP TABLE events;
ALTER TABLE events_next RENAME TO events;
CREATE INDEX events_by_run ON events(run_id, sequence);
${APPEND_ONLY('events', 'DELETE')}
${APPEND_ONLY('events', 'UPDATE')}

-- A captured snapshot, admitted without a run: its manifest and materialization are roots, its content is
-- reachable through their links. Rows are immutable.
CREATE TABLE snapshots (
  id TEXT PRIMARY KEY,
  manifest_id TEXT NOT NULL REFERENCES artifacts(id),
  materialization_id TEXT NOT NULL REFERENCES artifacts(id),
  inventory_digest TEXT NOT NULL CHECK (${DIGEST('inventory_digest')}),
  coordinator_epoch TEXT NOT NULL REFERENCES epochs(epoch),
  sequence INTEGER NOT NULL UNIQUE REFERENCES events(sequence),
  admitted_at TEXT NOT NULL,
  CHECK (manifest_id <> materialization_id)
) STRICT;
${APPEND_ONLY('snapshots', 'DELETE')}
${APPEND_ONLY('snapshots', 'UPDATE')}
`;

// Durable execution (PR 08): a reason beside a held work state, a bounded error detail beside an ended attempt,
// and the event log rebuilt (as in V2) to admit the work-state event.
const EVENT_KINDS_V3 = `${EVENT_KINDS_V2},'work-state'`;
const V3 = `
ALTER TABLE work_units ADD COLUMN state_reason TEXT
  CHECK (state_reason IS NULL OR (length(state_reason) BETWEEN 1 AND 128));
ALTER TABLE attempts ADD COLUMN error_detail TEXT
  CHECK (error_detail IS NULL OR (json_valid(error_detail) AND length(CAST(error_detail AS BLOB)) <= 4096));
CREATE TABLE events_next (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN (${EVENT_KINDS_V3})),
  run_id TEXT REFERENCES runs(id),
  work_id TEXT,
  work_revision INTEGER,
  coordinator_epoch TEXT NOT NULL REFERENCES epochs(epoch),
  at TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload) AND length(CAST(payload AS BLOB)) <= 16384),
  FOREIGN KEY (work_id, work_revision) REFERENCES work_units(id, revision),
  CHECK ((work_id IS NULL) = (work_revision IS NULL))
) STRICT;
INSERT INTO events_next (sequence, kind, run_id, work_id, work_revision, coordinator_epoch, at, payload)
  SELECT sequence, kind, run_id, work_id, work_revision, coordinator_epoch, at, payload FROM events ORDER BY sequence;
DROP TABLE events;
ALTER TABLE events_next RENAME TO events;
CREATE INDEX events_by_run ON events(run_id, sequence);
${APPEND_ONLY('events', 'DELETE')}
${APPEND_ONLY('events', 'UPDATE')}
`;

// Plan admission (PR 08 with PR 06): an admitted plan revision per run, with its plan, rule lock, effective policy
// and execution profile artifacts as roots; a run's current plan revision may advance one admitted revision at a
// time (its creation envelope stays as recorded); and the event log rebuilt (as in V2) for the two new events.
const EVENT_KINDS_V4 = `${EVENT_KINDS_V3},'plan-admitted','run-plan-advanced'`;
const V4 = `
CREATE TABLE events_next (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN (${EVENT_KINDS_V4})),
  run_id TEXT REFERENCES runs(id),
  work_id TEXT,
  work_revision INTEGER,
  coordinator_epoch TEXT NOT NULL REFERENCES epochs(epoch),
  at TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload) AND length(CAST(payload AS BLOB)) <= 16384),
  FOREIGN KEY (work_id, work_revision) REFERENCES work_units(id, revision),
  CHECK ((work_id IS NULL) = (work_revision IS NULL))
) STRICT;
INSERT INTO events_next (sequence, kind, run_id, work_id, work_revision, coordinator_epoch, at, payload)
  SELECT sequence, kind, run_id, work_id, work_revision, coordinator_epoch, at, payload FROM events ORDER BY sequence;
DROP TABLE events;
ALTER TABLE events_next RENAME TO events;
CREATE INDEX events_by_run ON events(run_id, sequence);
${APPEND_ONLY('events', 'DELETE')}
${APPEND_ONLY('events', 'UPDATE')}

-- One admitted plan revision. The run need not exist yet (a run is created once its snapshot is captured); the
-- revision chain is exact: revision 1 has no predecessor, every later one names the digest of the one before.
CREATE TABLE plans (
  run_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  kind TEXT NOT NULL CHECK (kind IN ('bootstrap','analysis')),
  digest TEXT NOT NULL CHECK (${DIGEST('digest')}),
  previous TEXT CHECK (previous IS NULL OR (${DIGEST('previous')})),
  plan_id TEXT NOT NULL REFERENCES artifacts(id),
  rule_lock_id TEXT REFERENCES artifacts(id),
  policy_id TEXT REFERENCES artifacts(id),
  profile_id TEXT NOT NULL REFERENCES artifacts(id),
  snapshot_id TEXT REFERENCES snapshots(id),
  coordinator_epoch TEXT NOT NULL REFERENCES epochs(epoch),
  sequence INTEGER NOT NULL UNIQUE REFERENCES events(sequence),
  admitted_at TEXT NOT NULL,
  PRIMARY KEY (run_id, revision),
  UNIQUE (run_id, digest),
  CHECK ((revision = 1) = (previous IS NULL)),
  CHECK ((kind = 'bootstrap') = (snapshot_id IS NULL)),
  CHECK ((kind = 'bootstrap') = (rule_lock_id IS NULL AND policy_id IS NULL))
) STRICT;
${APPEND_ONLY('plans', 'DELETE')}
${APPEND_ONLY('plans', 'UPDATE')}

-- The run's plan revision moves forward only, one admitted revision at a time; everything else stays immutable.
DROP TRIGGER runs_identity;
CREATE TRIGGER runs_identity BEFORE UPDATE OF id, parent_id, snapshot_id, coordinator_epoch, envelope, created_at ON runs
  BEGIN SELECT RAISE(ABORT, 'sentinel.store.appendOnly: runs identity'); END;
CREATE TRIGGER runs_plan_advance BEFORE UPDATE OF plan_revision ON runs
  WHEN NEW.plan_revision <> OLD.plan_revision + 1
    OR NOT EXISTS (SELECT 1 FROM plans WHERE run_id = NEW.id AND revision = NEW.plan_revision)
  BEGIN SELECT RAISE(ABORT, 'sentinel.store.appendOnly: a run advances one admitted plan revision at a time'); END;
`;

// Selected reruns (PR 25 backend): an analysis revision may be admitted with a selection record naming exactly the
// units it runs; the record is pinned beside the plan, a root through the plan's links like its other pins.
const V5 = `
ALTER TABLE plans ADD COLUMN selection_id TEXT REFERENCES artifacts(id);
`;

// Report-import operations are a distinct staging domain, not work attempts. No accepted roots can be minted
// through generic staging; the private publication operation will be the only writer of acceptances.
const EVENT_KINDS_V6 = `${EVENT_KINDS_V4},'evidence-opened','evidence-staged','evidence-transferred','evidence-aborted','evidence-accepted','evidence-abandoned'`;
const V6 = `
CREATE TABLE events_next (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN (${EVENT_KINDS_V6})),
  run_id TEXT REFERENCES runs(id), work_id TEXT, work_revision INTEGER,
  coordinator_epoch TEXT NOT NULL REFERENCES epochs(epoch), at TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload) AND length(CAST(payload AS BLOB)) <= 16384),
  FOREIGN KEY (work_id, work_revision) REFERENCES work_units(id, revision),
  CHECK ((work_id IS NULL) = (work_revision IS NULL))
) STRICT;
INSERT INTO events_next (sequence,kind,run_id,work_id,work_revision,coordinator_epoch,at,payload)
  SELECT sequence,kind,run_id,work_id,work_revision,coordinator_epoch,at,payload FROM events ORDER BY sequence;
DROP TABLE events;
ALTER TABLE events_next RENAME TO events;
CREATE INDEX events_by_run ON events(run_id, sequence);
${APPEND_ONLY('events', 'DELETE')}
${APPEND_ONLY('events', 'UPDATE')}
CREATE UNIQUE INDEX evidence_abandon_receipt ON events(json_extract(payload,'$.receipt.id')) WHERE kind = 'evidence-abandoned';
CREATE TABLE evidence_operations (
  id TEXT PRIMARY KEY, store_id TEXT NOT NULL, coordinator_epoch TEXT NOT NULL REFERENCES epochs(epoch),
  nonce TEXT NOT NULL UNIQUE, domain TEXT NOT NULL CHECK (domain = 'report-import'),
  run_id TEXT NOT NULL REFERENCES runs(id), plan_revision INTEGER NOT NULL,
  plan_digest TEXT NOT NULL CHECK (${DIGEST('plan_digest')}), snapshot_id TEXT NOT NULL REFERENCES snapshots(id),
  source_id TEXT NOT NULL, binding_digest TEXT NOT NULL CHECK (${DIGEST('binding_digest')}),
  candidate_digest TEXT NOT NULL CHECK (${DIGEST('candidate_digest')}),
  receipt_id TEXT NOT NULL UNIQUE, receipt_digest TEXT NOT NULL CHECK (${DIGEST('receipt_digest')}),
  predecessor_id TEXT UNIQUE REFERENCES evidence_operations(id),
  state TEXT NOT NULL CHECK (state IN ('open','aborted','superseded','accepted')),
  identity TEXT NOT NULL CHECK (json_valid(identity) AND length(CAST(identity AS BLOB)) <= 524288),
  opened_sequence INTEGER NOT NULL UNIQUE REFERENCES events(sequence),
  terminal_sequence INTEGER UNIQUE REFERENCES events(sequence), created_at TEXT NOT NULL,
  CHECK ((state = 'open') = (terminal_sequence IS NULL)),
  FOREIGN KEY (run_id, plan_revision) REFERENCES plans(run_id, revision)
) STRICT;
CREATE INDEX evidence_operations_binding ON evidence_operations(binding_digest, id);
CREATE INDEX evidence_operations_open ON evidence_operations(state, id);
CREATE TRIGGER evidence_operations_identity BEFORE UPDATE OF id,store_id,coordinator_epoch,nonce,domain,run_id,
  plan_revision,plan_digest,snapshot_id,source_id,binding_digest,candidate_digest,receipt_id,receipt_digest,
  predecessor_id,identity,opened_sequence,created_at ON evidence_operations
  BEGIN SELECT RAISE(ABORT, 'sentinel.store.appendOnly: evidence operation identity'); END;
CREATE TRIGGER evidence_operations_terminal BEFORE UPDATE OF state,terminal_sequence ON evidence_operations
  WHEN OLD.state <> 'open' OR NEW.state = 'open'
  BEGIN SELECT RAISE(ABORT, 'sentinel.store.appendOnly: evidence operation terminal'); END;
${APPEND_ONLY('evidence_operations', 'DELETE')}
ALTER TABLE staging ADD COLUMN evidence_operation_id TEXT REFERENCES evidence_operations(id);
CREATE TRIGGER staging_evidence_domain BEFORE INSERT ON staging
  WHEN NEW.evidence_operation_id IS NOT NULL AND (NEW.work_id IS NOT NULL OR NEW.attempt_id IS NOT NULL)
  BEGIN SELECT RAISE(ABORT, 'sentinel.store.stagingMismatch: evidence is not an attempt'); END;
CREATE TRIGGER staging_evidence_domain_update BEFORE UPDATE OF evidence_operation_id,work_id,attempt_id ON staging
  WHEN NEW.evidence_operation_id IS NOT NULL AND (NEW.work_id IS NOT NULL OR NEW.attempt_id IS NOT NULL)
  BEGIN SELECT RAISE(ABORT, 'sentinel.store.stagingMismatch: evidence is not an attempt'); END;
CREATE INDEX staging_evidence ON staging(evidence_operation_id,stage_id);
CREATE TABLE evidence_acceptances (
  candidate_digest TEXT PRIMARY KEY CHECK (${DIGEST('candidate_digest')}),
  operation_id TEXT NOT NULL UNIQUE REFERENCES evidence_operations(id),
  root_id TEXT NOT NULL REFERENCES artifacts(id), binding_digest TEXT NOT NULL CHECK (${DIGEST('binding_digest')}),
  previous_candidate TEXT REFERENCES evidence_acceptances(candidate_digest),
  sequence INTEGER NOT NULL UNIQUE REFERENCES events(sequence),
  coordinator_epoch TEXT NOT NULL REFERENCES epochs(epoch), accepted_at TEXT NOT NULL
) STRICT;
CREATE INDEX evidence_acceptances_binding ON evidence_acceptances(binding_digest, sequence);
${APPEND_ONLY('evidence_acceptances', 'UPDATE')}
${APPEND_ONLY('evidence_acceptances', 'DELETE')}
`;

// A failed or canceled attempt keeps its private record and its linked artifacts for as long as its row exists.
const V7 = `
CREATE TABLE attempt_retained (
  attempt_id TEXT NOT NULL,
  work_id TEXT NOT NULL,
  work_revision INTEGER NOT NULL,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  role TEXT NOT NULL CHECK (role IN ('record','linked')),
  schema TEXT NOT NULL CHECK (length(schema) BETWEEN 1 AND 128),
  privacy TEXT NOT NULL CHECK (privacy IN ('metadata','source-derived','source')),
  sequence INTEGER NOT NULL REFERENCES events(sequence),
  PRIMARY KEY (attempt_id, artifact_id),
  FOREIGN KEY (attempt_id, work_id, work_revision) REFERENCES attempts(id, work_id, work_revision)
) STRICT;
CREATE UNIQUE INDEX attempt_retained_one_record ON attempt_retained(attempt_id) WHERE role = 'record';
CREATE INDEX attempt_retained_by_artifact ON attempt_retained(artifact_id);
CREATE TRIGGER attempt_retained_ended BEFORE INSERT ON attempt_retained
  WHEN (SELECT state FROM attempts WHERE id = NEW.attempt_id) NOT IN ('failed','canceled','canceled-after-spend')
  BEGIN SELECT RAISE(ABORT, 'sentinel.store.wrongState: attempt_retained'); END;
${APPEND_ONLY('attempt_retained', 'UPDATE')}
${APPEND_ONLY('attempt_retained', 'DELETE')}
-- A refusal before any attempt belongs to its held work revision. Its bounded, private detail remains readable
-- after the coordinator exits, while state_reason keeps the catalog code used by ordinary work reads.
CREATE TABLE work_refusals (
  work_id TEXT NOT NULL,
  work_revision INTEGER NOT NULL,
  code TEXT NOT NULL CHECK (length(code) BETWEEN 1 AND 128),
  detail TEXT NOT NULL CHECK (json_valid(detail) AND length(CAST(detail AS BLOB)) <= 4096),
  privacy TEXT NOT NULL CHECK (privacy = 'source'),
  sequence INTEGER PRIMARY KEY REFERENCES events(sequence),
  FOREIGN KEY (work_id, work_revision) REFERENCES work_units(id, revision)
) STRICT;
CREATE INDEX work_refusals_by_work ON work_refusals(work_id, work_revision, sequence DESC);
CREATE TRIGGER work_refusals_held BEFORE INSERT ON work_refusals
  WHEN (SELECT state FROM work_units WHERE id = NEW.work_id AND revision = NEW.work_revision) <> 'blocked'
    OR (SELECT state_reason FROM work_units WHERE id = NEW.work_id AND revision = NEW.work_revision) <> NEW.code
  BEGIN SELECT RAISE(ABORT, 'sentinel.store.wrongState: work_refusals'); END;
${APPEND_ONLY('work_refusals', 'UPDATE')}
${APPEND_ONLY('work_refusals', 'DELETE')}
`;

/** The shipped migrations, in order. Never edit a released step: add the next number. */
export const LEDGER_MIGRATIONS: readonly Migration[] = Object.freeze([
  { version: 1, name: 'foundation', sql: V1 },
  { version: 2, name: 'snapshot-admission', sql: V2 },
  { version: 3, name: 'durable-execution', sql: V3 },
  { version: 4, name: 'plan-admission', sql: V4 },
  { version: 5, name: 'plan-selection', sql: V5 },
  { version: 6, name: 'evidence-operations', sql: V6 },
  { version: 7, name: 'attempt-retention', sql: V7 },
]);

/** The checksum a ledger records for one applied migration: the content address of its version, name and SQL. */
export const migrationChecksum = (m: Migration): string => sha256Id(`${m.version}\n${m.name}\n${m.sql}`);

function checkList(migrations: readonly Migration[]): void {
  migrations.forEach((m, i) => {
    if (m.version !== i + 1 || !m.name || !m.sql) {
      throw new LedgerError('sentinel.store.migrationMismatch', `migration list is not numbered 1..n at index ${i}`);
    }
  });
}

const scalar = (db: DatabaseSync, sql: string): unknown => Object.values(db.prepare(sql).get() ?? {})[0];

/** What a ledger file holds before migration: its schema version, application id and number of user objects. */
export interface LedgerFileState {
  version: number;
  applicationId: number;
  userObjects: number;
}

/** Reads a ledger file's schema version, application id and user object count, changing nothing. */
export function inspectLedgerFile(db: DatabaseSync): LedgerFileState {
  return {
    version: Number(scalar(db, 'PRAGMA user_version')),
    applicationId: Number(scalar(db, 'PRAGMA application_id')),
    userObjects: Number(scalar(db, "SELECT count(*) FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'")),
  };
}

/** Refuses a file that is not a Sentinel ledger, one newer than this build, or one whose history differs. */
export function checkLedgerFile(db: DatabaseSync, migrations: readonly Migration[]): LedgerFileState {
  checkList(migrations);
  const state = inspectLedgerFile(db);
  if (state.version === 0) {
    if (state.userObjects !== 0 || state.applicationId !== 0) {
      throw new LedgerError('sentinel.store.notLedger', 'the database has tables but no Sentinel schema version');
    }
    return state;
  }
  if (state.applicationId !== LEDGER_APPLICATION_ID) {
    throw new LedgerError('sentinel.store.notLedger', 'the database is not a Sentinel ledger');
  }
  if (state.version > migrations.length) {
    throw new LedgerError(
      'sentinel.store.newerSchema',
      `the ledger is at schema ${state.version}; this build reads up to ${migrations.length}`,
    );
  }
  const recorded = db.prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version').all() as Array<{
    version: number;
    name: string;
    checksum: string;
  }>;
  if (recorded.length !== state.version) {
    throw new LedgerError('sentinel.store.migrationMismatch', 'recorded migrations do not match the schema version');
  }
  recorded.forEach((row, i) => {
    const known = migrations[i]!;
    if (row.version !== known.version || row.name !== known.name || row.checksum !== migrationChecksum(known)) {
      throw new LedgerError('sentinel.store.migrationMismatch', `migration ${row.version} differs from this build's`);
    }
  });
  return state;
}

function fsyncPath(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * A consistent copy of the live ledger, verified (integrity, application ID, version) and made durable before
 * any schema change. Returns its path. On failure nothing is left at the final path.
 */
async function takeBackup(
  sqlite: typeof import('node:sqlite'),
  db: DatabaseSync,
  path: string,
  from: number,
  tag: string,
  failpoint: (p: LedgerFailpoint) => void,
  guard: LedgerGuard,
): Promise<string> {
  const { backup, DatabaseSync: Db } = sqlite;
  const dir = join(dirname(path), 'backups');
  const final = join(dir, `${basename(path)}.v${from}.${tag}.bak`);
  const temp = `${final}.partial`;
  try {
    failpoint('backup:before');
    try {
      mkdirSync(dir, { mode: 0o700 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    const d = lstatSync(dir);
    if (!d.isDirectory() || (d.mode & 0o077) !== 0) throw new Error('the backup directory is not private');
    rmSync(temp, { force: true });
    guard.notOwnerFile(temp);
    await backup(db, temp);
    guard.assertHeld();
    chmodSync(temp, 0o600);
    failpoint('backup:after-copy');
    guard.notOwnerFile(temp);
    const copy = new Db(temp, { readOnly: true });
    try {
      const state = inspectLedgerFile(copy);
      const integrity = scalar(copy, 'PRAGMA integrity_check');
      if (integrity !== 'ok' || state.version !== from || state.applicationId !== LEDGER_APPLICATION_ID) {
        throw new Error('backup verification failed');
      }
    } finally {
      copy.close();
    }
    fsyncPath(temp);
    guard.notOwnerFile(final);
    guard.assertHeld();
    renameSync(temp, final);
    fsyncPath(dir);
    return final;
  } catch (error) {
    try {
      guard.notOwnerFile(temp);
      rmSync(temp, { force: true });
    } catch {
      /* never touch an owner alias */
    }
    if (error instanceof LedgerError) throw error;
    throw new LedgerError('sentinel.store.backupFailed', 'could not take a verified backup before the upgrade', {
      cause: error,
    });
  }
}

/**
 * What the migration needs from its caller to stay under the owner: a re-check that the owner is still held
 * (throws LedgerError ownerNotHeld) and a refusal of any path that is, or aliases, the owner lock file.
 */
export interface LedgerGuard {
  assertHeld(): void;
  notOwnerFile(path: string): void;
}

/**
 * Brings the ledger to the newest known schema. The connection must not be inside a transaction. Ownership is
 * re-checked after every await, after BEGIN, after each step and immediately before COMMIT; a loss at any point
 * rolls the whole upgrade back.
 */
export async function migrateLedger(
  db: DatabaseSync,
  path: string,
  options: {
    migrations: readonly Migration[];
    build: string;
    now: () => string;
    backupTag: string;
    sqlite: typeof import('node:sqlite');
    failpoint: (p: LedgerFailpoint) => void;
    guard: LedgerGuard;
  },
): Promise<MigrationReport> {
  const { guard } = options;
  guard.assertHeld();
  const { migrations, build, now, failpoint } = options;
  const state = checkLedgerFile(db, migrations);
  const to = migrations.length;
  if (state.version === to) return { from: state.version, to, backupPath: null };
  const backupPath =
    state.version > 0
      ? await takeBackup(options.sqlite, db, path, state.version, options.backupTag, failpoint, guard)
      : null;
  guard.assertHeld();
  checkLedgerFile(db, migrations);
  // Foreign keys are switched off for the upgrade, as SQLite's table-rebuild procedure requires (the pragma is a
  // no-op inside a transaction), checked in full before commit, and switched back on whatever happens.
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      guard.assertHeld();
      if (state.version === 0) db.exec(`PRAGMA application_id = ${LEDGER_APPLICATION_ID}`);
      const record = () =>
        db.prepare('INSERT INTO schema_migrations (version, name, checksum, build, applied_at) VALUES (?, ?, ?, ?, ?)');
      for (const m of migrations.slice(state.version)) {
        db.exec(m.sql);
        failpoint('migrate:after-sql');
        record().run(m.version, m.name, migrationChecksum(m), build, now());
        db.exec(`PRAGMA user_version = ${m.version}`);
        guard.assertHeld();
      }
      if (db.prepare('PRAGMA foreign_key_check').all().length > 0) throw new Error('foreign key check failed');
      guard.assertHeld();
      db.exec('COMMIT');
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      if (error instanceof LedgerError && error.code === 'sentinel.store.ownerNotHeld') throw error;
      throw new LedgerError(
        'sentinel.store.migrationFailed',
        `upgrade from schema ${state.version} to ${to} was rolled back`,
        { cause: error },
      );
    }
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
  if (Number(Object.values(db.prepare('PRAGMA foreign_keys').get() ?? {})[0]) !== 1) {
    throw new LedgerError(
      'sentinel.store.migrationFailed',
      'foreign key enforcement did not come back on after the upgrade',
    );
  }
  return { from: state.version, to, backupPath };
}
