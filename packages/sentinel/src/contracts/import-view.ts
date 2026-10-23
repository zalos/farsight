// Data projections only: these records confer no receipt, finding, coverage or mitigation authority.
import type { Digest, Id } from './common.js';
import type { ReportCount } from './report.js';
import type { NormalizedImport } from '../imports/normalize.js';
export interface ImportViewEnvelope {
  schema:'sentinel-import-view/draft-1'; kind:'imported-report'; authority:'owner-associated-imported-claims';
  candidateDigest:Digest; root:Digest; withheld:boolean;
  limitation:'accepted-secret-match'|'privacy-unassessed-canceled-run'|null;
  limitationKey:'sentinel.evidence.importedClaims';
  counts:{claims:ReportCount;exchanges:ReportCount;cookies:ReportCount};
  document:NormalizedImport|null;
}
export interface ImportPageEnvelope {
  schema:'sentinel-import-page/draft-1'; authority:'metadata-only-not-evaluated';
  /** @maxItems 100 */
  items:Array<{operationId:Id;candidateDigest:Digest;state:'open'|'accepted'|'superseded'|'aborted';root:Digest|null;previous:Digest|null;availability:'not-evaluated'}>;
  /** @maxLength 512 */
  next:string|null;
  count:ReportCount;
}
