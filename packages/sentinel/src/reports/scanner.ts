import {structuralText} from './structural-paths.js';
// The public scanner slice reads only accepted publications of the exact current admitted plan. It exposes the
// canonical coverage evaluator's verdict, with raw normalized records retained as observations, not a security verdict.
import type {SentinelStore} from '../store/index.js';
import type {CoverageEnvelope} from '../contracts/coverage.js';
import type {ReportControlInspection,ReportStructuralPaths,ReportDefinition,ReportCount} from '../contracts/report.js';
import {loadPlan} from '../execution/plans.js';
import {openSnapshot} from '../snapshot/materialize.js';
import {evaluateRequiredCoverage,type RequiredCoverage} from '../planner/coverage.js';
import {countedProblems} from '@farsight/core/dist/counts.js';
import {STRINGS} from '@farsight/core/dist/strings.js';
import {selectedSecretNames} from './selected-privacy.js';
export interface ScannerReport{
 schema:'sentinel-scanner-report/draft-1';label:'deterministic';runId:string;snapshotId:string;planDigest:string;ledgerSequence:number;generatedAt:string;
 counts:ReportCount[];coverage:RequiredCoverage;observations:Array<{artifact:string;attemptId:string;value:unknown}>;
 inspections?:ReportControlInspection[];
 structuralPaths?:ReportStructuralPaths[];definitions?:ReportDefinition[];
 reports:Array<{artifact:string;attemptId:string;value:unknown}>;pins:unknown;limitations:string[];
}
export async function scannerReportOf(store:SentinelStore,runId:string,now:Date,options:{trustDir?:string}={}):Promise<ScannerReport|undefined>{
 const run=store.ledger.getRun(runId);if(!run||run.state!=='completed')return undefined;
 const admitted=await loadPlan(store,runId,run.planRevision);const plan=admitted.plan;
 if(!plan.units.some(u=>u.adapterId&&['pattern-semgrep','advisories-osv','iac-trivy','ci-zizmor','secrets-gitleaks','framework-controls','bounded-paths'].includes(u.adapterId)))return undefined;
 const records:CoverageEnvelope[]=[];const observations:ScannerReport['observations']=[];const reports:ScannerReport['reports']=[];
 for(const unit of plan.units){const pub=store.ledger.getPublication({id:unit.id,revision:unit.revision});if(!pub)continue;
  for(const output of pub.outputs){if(!['sentinel-coverage/draft-1','sentinel-driver-finding/draft-1','sentinel-driver-report/draft-1'].includes(output.schema))continue;
   const value=JSON.parse((await store.readArtifact(output.id)).toString('utf8'));
   if(output.schema==='sentinel-coverage/draft-1'){
    if(value.runId!==runId||value.workId!==unit.id||value.workRevision!==unit.revision||value.basis?.kind!=='executed'||value.basis.attemptId!==pub.attemptId)throw new Error('invalid accepted coverage binding');records.push(value);
   }else{
    if(unit.adapterId==='framework-controls')continue; // The authenticated, privacy-projected section below owns inspection records.
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
 const doc:ScannerReport={schema:'sentinel-scanner-report/draft-1',label:'deterministic',runId,snapshotId:plan.pins.snapshotId!,planDigest:plan.digest,ledgerSequence:sequence,generatedAt:now.toISOString(),counts,coverage,observations,reports,
  pins:{rules:plan.pins.rules,tools:plan.pins.tools,databases:plan.pins.databases},limitations:['sentinel.service.policyNotEvaluated','sentinel.report.scannerSlice']};
 if(plan.units.some(u=>u.adapterId==='framework-controls'||u.adapterId==='bounded-paths')){
  const {fullReport}=await import('../service/full-report.js');
  const projected=await fullReport({store,runId,now,workspace:'',trustDir:options.trustDir,disclosure:'shareable'});
  doc.inspections=projected.document.inspections;
  if(projected.document.structuralPaths){doc.structuralPaths=projected.document.structuralPaths;doc.definitions=projected.document.definitions;}
  if(projected.document.counts.pathQueries)doc.counts.push(projected.document.counts.pathQueries);
  if(projected.document.counts.controlAnswers)doc.counts.push(projected.document.counts.controlAnswers);
 }
 const names=[...await matchedNames(store,plan.pins.snapshotId!,observations),...await selectedSecretNames(store,runId,admitted)];
 return withholdMatchedNames(doc,[...new Set(names)].sort((a,b)=>b.length-a.length));
}
/** A captured file whose name the secret scan matched: its path and name, resolved only over the private snapshot. */
async function matchedNames(store:SentinelStore,snapshotId:string,observations:ScannerReport['observations']):Promise<string[]>{
 const named=observations.filter(o=>(o.value as any)?.adapter==='secrets-gitleaks'&&((o.value as any).limitationKeys??[]).includes('sentinel.secrets.nameMatch'));
 if(!named.length)return[];
 const {snapshot}=await openSnapshot(store,snapshotId);const out=new Set<string>();
 for(const o of named)for(const e of (o.value as any).evidence??[]){const entry=snapshot.entries[e?.entry];
  if(!entry||entry.kind!=='file'||entry.disposition!=='included'||entry.content!==e.content)throw new Error('invalid accepted secret location');
  out.add(entry.relativePath);const base=entry.relativePath.split('/').pop()!;if(base.length>=8)out.add(base);}
 // Longest first, so a path is replaced whole before its own name is.
 return [...out].sort((a,b)=>b.length-a.length);
}
/** Every string that names such a file (a path, a scope, a symbol) carries a fixed marker instead, in every record. */
function withholdMatchedNames<T>(doc:T,names:readonly string[]):T{
 if(!names.length)return doc;
 const walk=(v:unknown):unknown=>typeof v==='string'?names.reduce((s,n)=>s.split(n).join('[a file name the secret scan matched is withheld]'),v)
  :Array.isArray(v)?v.map(walk):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,walk(x)])):v;
 return walk(doc) as T;
}
export function renderScannerMarkdown(doc:ScannerReport):string{
 const word=(key:string)=>STRINGS[key]?.professional??key;
 return[`# ${word('sentinel.report.scannerHeading')}`,'',word('sentinel.report.scannerRun').replace('{run}',doc.runId),word('sentinel.report.scannerSnapshot').replace('{snapshot}',doc.snapshotId),'',...doc.counts.map(c=>`- ${word(c.unit).replace('{n}',String(c.n))} ${word(c.scope)}; re-check: \`${c.recheck!.cli}\``),'',...(doc.inspections??[]).flatMap(i=>[word('sentinel.controls.reportHeading'),word(i.limitationKey),...i.rows.map(r=>`${r.surfaceId} · ${r.property}: ${r.state}${r.verdict?` · ${r.verdict}`:''}${r.reasonCode?` · ${word(r.reasonCode)}`:''}`)]),...(doc.structuralPaths?.length?[word('sentinel.paths.report.heading'),...structuralText(doc as any).flatMap(p=>[p.source,...p.lines])]:[]),...doc.limitations.map(key=>word(key)),''].join('\n');
}
