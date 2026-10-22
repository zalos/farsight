import type { StringEntry } from './strings.js';

// Sentinel's OSV advisory adapter (PR 12): its errors, per-file coverage reasons, refused results, engine failure
// categories and the in-container worker's diagnostics. Both registers carry the same words until the PR 09
// vocabulary freeze. No entry repeats engine or advisory text.
const same = (text: string, define: string): StringEntry => ({ hud: text, professional: text, define });

export const SENTINEL_OSV_STRINGS: Record<string, StringEntry> = {
  'sentinel.osv.targetInvalid': same('a dependency file is unsafe or does not match its captured bytes', 'Every dependency file is named by a safe relative path and identified by the digest of its captured bytes. A mismatch stops the job before anything runs.'),
  'sentinel.osv.snapshotInvalid': same('an advisory snapshot is missing or does not match its record', 'Advisory snapshots are stored by digest with a record of where they came from. One that is missing, altered or not private is refused before any scan.'),
  'sentinel.osv.outputInvalid': same('the advisory scanner output could not be trusted', 'The output must name the job that was supplied and be well formed. Anything else is refused rather than partly read.'),
  'sentinel.osv.acquisitionUnauthorized': same('downloading advisories was not confirmed by the owner for this request', 'Fetching an advisory database is an owner action. It needs the owner’s receipt for exactly these sources and size bound.'),
  'sentinel.osv.acquisitionRefused': same('the advisory download request is outside what is allowed', 'Only the OSV project’s published archives for supported ecosystems may be fetched, each within the stated size bound.'),
  'sentinel.osv.acquisitionFailed': same('the advisory download failed or did not verify', 'The archive could not be fetched completely, or its bytes did not match the checksum its source published. Nothing was stored.'),
  'sentinel.osv.coverage.complete': same('every component matched against a fresh advisory snapshot', 'Each component in this file has an established version and was compared with an advisory snapshot within the owner’s freshness bound.'),
  'sentinel.osv.coverage.versionsUnknown': same('some components have no established version', 'A range, a version managed elsewhere or another undetermined version cannot be compared with advisories, so those components are not assessed.'),
  'sentinel.osv.coverage.transitivesNotResolved': same('indirect dependencies are not known from this file', 'A manifest names direct dependencies only. Offline, their own dependencies are not resolved, so they are not assessed; a lockfile or SBOM supplies them.'),
  'sentinel.osv.coverage.databaseAbsent': same('no advisory snapshot for this file’s ecosystem', 'Without a snapshot for the ecosystem, the file is not compared with any advisory. It is a gap, never a clean result.'),
  'sentinel.osv.coverage.databaseStale': same('the advisory snapshot is older than the allowed age', 'The snapshot’s source changed longer ago than the owner allows, so newer advisories may be missing. Matches still stand; the file is not counted as complete.'),
  'sentinel.osv.coverage.databaseNotLoaded': same('the scanner did not load the advisory snapshot it needed', 'The scanner did not report reading the snapshot for this file’s ecosystem, so nothing in the file was compared with advisories, whatever the exit status.'),
  'sentinel.osv.coverage.componentsSkipped': same('the scanner listed some components without matching them', 'The scanner treats some packages as local (an npm lock entry with no registry source) and lists them with no advisories without checking. They are not counted as assessed, and the file is not complete.'),
  'sentinel.osv.coverage.componentsRefused': same('some components in this file were refused', 'The scanner reported components this adapter could not accept, from an ecosystem the file cannot contain or in a malformed form. They are not assessed, and the file is not complete.'),
  'sentinel.osv.coverage.databaseAgeUnknown': same('the advisory snapshot’s age is unknown', 'The source did not state when it last changed the archive in a recognized form, so its freshness cannot be shown. The file is not counted as complete.'),
  'sentinel.osv.coverage.noComponents': same('the scanner reported no components in this file', 'The file was scanned but no component was reported. It is not counted as checked.'),
  'sentinel.osv.coverage.notDependencyFile': same('not a dependency file this scanner reads', 'Only npm and pnpm lockfiles, Maven manifests and CycloneDX SBOMs are read for advisories.'),
  'sentinel.osv.coverage.inputMismatch': same('the scanned copy of this file does not match what was captured', 'Each file is checked again, whole, against the digest the job pinned. A copy that is missing or differs earns no coverage.'),
  'sentinel.osv.coverage.attemptFailed': same('the advisory scan attempt failed', 'The isolated scan did not complete, so no file in it counts as checked.'),
  'sentinel.osv.coverage.attemptTimedOut': same('the advisory scan attempt reached its deadline', 'The isolated scan was stopped at its deadline, so no file in it counts as checked.'),
  'sentinel.osv.coverage.attemptCanceled': same('the advisory scan attempt was canceled', 'The isolated scan was canceled before it finished, so no file in it counts as checked.'),
  'sentinel.osv.coverage.engineFailed': same('the advisory scanner reported a failure', 'The scanner ended with an error status. Its output is not read, because it can list packages without their advisories when it fails.'),
  'sentinel.osv.coverage.engineTimedOut': same('the advisory scanner reached its time limit', 'The scanner was stopped at its time limit inside the container. Partial output is not used.'),
  'sentinel.osv.coverage.outputTruncated': same('the advisory scanner output was larger than its limit', 'The scanner’s output exceeded its fixed limit, so it was not read and no file counts as checked.'),
  'sentinel.osv.coverage.platformUnmeasured': same('the advisory scanner ran on an image platform that has not been measured', 'Only the measured platform of the pinned image is trusted. Results from another are not used until that platform is measured on its own hardware.'),
  'sentinel.osv.refused.unknownSource': same('a result names a file that was not in the job', 'Only results on the job’s own files are kept.'),
  'sentinel.osv.refused.versionUnverified': same('an advisory matched a version that was not established', 'A match on a guessed version, such as the lower bound of a Maven range, is not reported as a finding.'),
  'sentinel.osv.refused.ecosystem': same('a component is from an ecosystem this file cannot contain', 'A component is kept only when its ecosystem fits the kind of file it came from.'),
  'sentinel.osv.refused.malformed': same('a result is malformed', 'A result that does not have the expected shape is not kept.'),
  'sentinel.osv.refused.inputMismatch': same('a result is on a file whose scanned copy does not match what was captured', 'A result is kept only on a file whose bytes match, whole, the digest the job pinned.'),
  'sentinel.osv.engine.engineError': same('the advisory scanner reported an error', 'The scanner ended with its general error status. Its own messages are not kept, because they can quote file contents.'),
  'sentinel.osv.engine.noPackages': same('the advisory scanner found no packages', 'The scanner ended with its no-packages status. Its own messages are not kept.'),
  'sentinel.osv.engine.killed': same('the advisory scanner was stopped', 'The scanner process was killed, at its time or memory limit. No output from that run is used.'),
  'sentinel.osv.engine.unknown': same('the advisory scanner failed for an unrecognized reason', 'The scanner ended with an error status this adapter does not recognize. Its exit code is kept; its messages are not.'),
  'sentinel.osv.jobAmbiguous': same('the advisory scan job could not be identified', 'The isolated worker expects exactly one job description among its inputs. More than one, or none, stops the scan.'),
  'sentinel.osv.jobInvalid': same('the advisory scan job is malformed', 'The job names files, snapshots and limits in a fixed form. Anything else stops the scan.'),
  'sentinel.osv.databaseMissing': same('an advisory snapshot was not among the inputs', 'Every snapshot the job names must be supplied with it, byte for byte.'),
  'sentinel.osv.targetMissing': same('a dependency file was not among the inputs', 'Every file the job names must be supplied with it, byte for byte.'),
};
