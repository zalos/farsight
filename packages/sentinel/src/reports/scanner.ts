// The public scanner slice reads only accepted publications of the exact current admitted plan. It exposes the
// canonical coverage evaluator's verdict, with raw normalized records retained as observations, not a security verdict.
import type {SentinelStore} from '../store/index.js';
import type {CoverageEnvelope} from '../contracts/coverage.js';
import type {ReportCount} from '../contracts/report.js';
import {loadPlan} from '../execution/plans.js';
import {evaluateRequiredCoverage,type RequiredCoverage} from '../planner/coverage.js';
import {countedProblems} from '@farsight/core/dist/counts.js';
import {STRINGS} from '@farsight/core/dist/strings.js';
export interface ScannerReport{
 schema:'sentinel-scanner-report/draft-1';label:'deterministic';runId:string;snapshotId:string;planDigest:string;ledgerSequence:number;generatedAt:string;
 counts:ReportCount[];coverage:RequiredCoverage;observations:Array<{artifact:string;attemptId:string;value:unknown}>;
 reports:Array<{artifact:string;attemptId:string;value:unknown}>;pins:unknown;limitations:string[];
}
export async function scannerReportOf(store:SentinelStore,runId:string,now:Date):Promise<ScannerReport|undefined>{
 const run=store.ledger.getRun(runId);if(!run||run.state!=='completed')return undefined;
 const admitted=await loadPlan(store,runId,run.planRevision);const plan=admitted.plan;
 if(!plan.units.some(u=>u.adapterId&&['pattern-semgrep','advisories-osv','iac-trivy','ci-zizmor','secrets-gitleaks'].includes(u.adapterId)))return undefined;
 const records:CoverageEnvelope[]=[];const observations:ScannerReport['observations']=[];const reports:ScannerReport['reports']=[];
 for(const unit of plan.units){const pub=store.ledger.getPublication({id:unit.id,revision:unit.revision});if(!pub)continue;
  for(const output of pub.outputs){if(!['sentinel-coverage/draft-1','sentinel-driver-finding/draft-1','sentinel-driver-report/draft-1'].includes(output.schema))continue;
   const value=JSON.parse((await store.readArtifact(output.id)).toString('utf8'));
   if(output.schema==='sentinel-coverage/draft-1'){
    if(value.runId!==runId||value.workId!==unit.id||value.workRevision!==unit.revision||value.basis?.kind!=='executed'||value.basis.attemptId!==pub.attemptId)throw new Error('invalid accepted coverage binding');records.push(value);
   }else{
    if(value.runId!==runId||value.snapshotId!==plan.pins.snapshotId||value.work?.id!==unit.id||value.work?.revision!==unit.revision||value.attemptId!==pub.attemptId)throw new Error('invalid accepted observation binding');
    (output.schema==='sentinel-driver-finding/draft-1'?observations:reports).push({artifact:output.id,attemptId:pub.attemptId,value});
   }
  }
 }
 const coverage=evaluateRequiredCoverage(plan,records);const recheck={cli:`farsight-sentinel report ${runId} --json`};
 const counts:ReportCount[]=[{n:observations.length,unit:'sentinel.count.observations',scope:'sentinel.scope.report',source:'accepted normalized scanner observations before cross-rule grouping',recheck},
  {n:plan.checks.length,unit:'sentinel.count.plannedChecks',scope:'sentinel.scope.report',source:'the exact admitted analysis plan',recheck},
  {n:coverage.checks.filter(c=>c.required&&!c.complete).length+coverage.ruleGaps.filter(g=>g.required).length,unit:'sentinel.count.gaps',scope:'sentinel.scope.report',source:'canonical required check coverage and required rule gaps, each once',recheck}];
 for(const c of counts)if(countedProblems(c as never,'scanner report').length)throw new Error('invalid report count');
 let sequence=0;for(let after=0;;){const page=store.ledger.readEvents({runId,after,limit:500});for(const event of page.events)sequence=event.sequence;if(!page.more)break;after=page.cursor;}
 return{schema:'sentinel-scanner-report/draft-1',label:'deterministic',runId,snapshotId:plan.pins.snapshotId!,planDigest:plan.digest,ledgerSequence:sequence,generatedAt:now.toISOString(),counts,coverage,observations,reports,
  pins:{rules:plan.pins.rules,tools:plan.pins.tools,databases:plan.pins.databases},limitations:['sentinel.service.policyNotEvaluated','sentinel.report.scannerSlice']};
}
export function renderScannerMarkdown(doc:ScannerReport):string{
 const word=(key:string)=>STRINGS[key]?.professional??key;
 return[`# ${word('sentinel.report.scannerHeading')}`,'',word('sentinel.report.scannerRun').replace('{run}',doc.runId),word('sentinel.report.scannerSnapshot').replace('{snapshot}',doc.snapshotId),'',...doc.counts.map(c=>`- ${word(c.unit).replace('{n}',String(c.n))} ${word(c.scope)}; re-check: \`${c.recheck!.cli}\``),'',...doc.limitations.map(key=>word(key)),''].join('\n');
}
