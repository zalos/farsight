#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import { resolve, relative, dirname, basename, sep, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { platform, arch, cpus, totalmem } from 'node:os';
import { sha256, canonical, inside, inventory, loadCorpus, resolveFixtureRoot } from './sentinel-feasibility/parser.mjs';

const REPO=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export const EXPERIMENTS=Object.freeze(Array.from({length:8},(_,i)=>`E${i+1}`));
const PROBES=Object.freeze({E1:{name:'parser',module:'./sentinel-feasibility/parser.mjs',entry:'runParserProbe'},E4:{name:'storage',module:'./sentinel-feasibility/storage.mjs',entry:'runStorageProbe'},E8:{name:'codec',module:'./sentinel-feasibility/codec.mjs',entry:'runCodecProbe'}});
const PINS={'@farsight/graph':'0.3.1','@farsight/code-parser':'0.3.1','oxc-parser':'0.138.0','@vscode/tree-sitter-wasm':'0.3.1'};
export function validateManifest(value) {
  if (value?.format!=='sentinel-feasibility-manifest/draft-1') throw new Error('Wrong manifest format');
  inside(REPO,value.fixtureRoot);
  if (!Array.isArray(value.candidates)||!Array.isArray(value.prerequisites)||!Array.isArray(value.experiments)) throw new Error('Manifest arrays required');
  for (const effect of ['network','providerDisclosure','sourceExecution','acquisition']) if (value.effects?.[effect]!==false) throw new Error(`Local-only effect required: ${effect}=false`);
  const ids=new Set();
  for (const candidate of value.candidates) {
    if (typeof candidate.id!=='string'||ids.has(candidate.id)) throw new Error('Duplicate or missing candidate id');
    ids.add(candidate.id);
    if (candidate.version && !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(candidate.version)) throw new Error('Candidate versions must be exact');
    if (!candidate.version&&!['not-selected','deferred'].includes(candidate.status)) throw new Error('Unpinned candidate needs explicit deferred/not-selected status');
    if (PINS[candidate.id]&&candidate.version!==PINS[candidate.id]) throw new Error(`Candidate pin mismatch: ${candidate.id}`);
  }
  for (const id of Object.keys(PINS)) if (!ids.has(id)) throw new Error(`Required local candidate missing: ${id}`);
  const prereqs=new Set();
  for (const item of value.prerequisites) { if(typeof item.id!=='string'||prereqs.has(item.id)) throw new Error('Invalid prerequisite id'); prereqs.add(item.id); }
  const experiments=new Set();
  for (const item of value.experiments) {
    if (!EXPERIMENTS.includes(item.id)||experiments.has(item.id)) throw new Error('Wrong or duplicate experiment id');
    experiments.add(item.id);
    if (item.probe!==null && item.probe!==undefined && item.probe!==PROBES[item.id]?.name) throw new Error('Probe is not allowlisted');
    if (!['accepted','rejected','deferred'].includes(item.decision)||!Array.isArray(item.prerequisites)||item.prerequisites.some(id=>!prereqs.has(id))) throw new Error('Invalid experiment decision or prerequisites');
  }
  if (experiments.size!==8) throw new Error('Every E1–E8 experiment is required');
  return value;
}
export function parseArgs(args) {
  const options={run:false,experiments:[],manifest:resolve(REPO,'docs/proposals/farsight-sentinel/feasibility-manifest.json')};
  for (let i=0;i<args.length;i++) {
    const arg=args[i];
    if(arg==='--run') {if(options.run) throw new Error('Duplicate --run'); options.run=true;}
    else if(['--experiment','--out','--manifest'].includes(arg)) {
      const value=args[++i]; if(!value||value.startsWith('--')) throw new Error(`Missing value: ${arg}`);
      if(arg==='--experiment') options.experiments.push(...value.split(',')); else options[arg.slice(2)]=resolve(value);
    } else if(arg==='--help') options.help=true; else throw new Error(`Unknown option: ${arg}`);
  }
  if(options.experiments.some(id=>!EXPERIMENTS.includes(id))||new Set(options.experiments).size!==options.experiments.length) throw new Error('Unknown or duplicate experiment selection');
  if(options.run&&(!options.out||!options.experiments.length)) throw new Error('--run requires --experiment and a fresh --out');
  if(!options.run&&options.out) throw new Error('--out requires --run');
  return options;
}
async function retainedArtifacts(artifactDir, artifacts) {
  if(!Array.isArray(artifacts)||!artifacts.length||artifacts.length>1024) throw new Error('Executed probes must retain artifacts');
  const paths=new Set(), result=[];
  for(const artifact of artifacts) {
    const path=typeof artifact==='string'?artifact:artifact.path;
    if(paths.has(path)) throw new Error('Duplicate artifact path'); paths.add(path);
    const full=inside(artifactDir,path);
    // Refuse symlinks in every component before inspecting retained bytes.
    let part=artifactDir;
    for(const segment of path.split('/')) {part=resolve(part,segment); if((await fs.lstat(part)).isSymbolicLink()) throw new Error('Artifact symlink refused');}
    const stat=await fs.stat(full);
    if(!stat.isFile()||stat.size>64*1024*1024) throw new Error('Artifact is not a bounded regular file');
    if(typeof artifact==='object'&&(!/^[a-f0-9]{64}$/.test(artifact.sha256??'')||!Number.isSafeInteger(artifact.bytes)||artifact.bytes<0)) throw new Error('Invalid artifact identity');
    const bytes=await fs.readFile(full), digest=sha256(bytes);
    if(typeof artifact==='object'&&(artifact.sha256!==digest||artifact.bytes!==bytes.length)) throw new Error('Artifact identity mismatch');
    result.push({path,sha256:digest,bytes:bytes.length});
  }
  return result;
}
export function runHasFailures(result) {
  return result.experiments.some(item=>item.selected&&(['failed','blocked'].includes(item.status)||item.checks?.some(check=>check.passed===false)));
}
export async function validateProbeResult(result,id,artifactDir) {
  if(result?.experiment!==id||!['measured','failed','blocked','deferred'].includes(result.status)||!Array.isArray(result.checks)||!Array.isArray(result.limitations)||!result.metrics||typeof result.metrics!=='object'||Array.isArray(result.metrics)||result.checks.length>10000) throw new Error('Invalid probe result');
  const ids=new Set();
  for(const check of result.checks) {if(typeof check.id!=='string'||ids.has(check.id)||typeof check.passed!=='boolean'||check.evidence===undefined) throw new Error('Invalid probe check'); ids.add(check.id);}
  if(result.status==='measured'&&!result.checks.length) throw new Error('Measured results require actual checks');
  const artifacts=result.status==='measured'?await retainedArtifacts(artifactDir,result.artifacts):result.artifacts?.length?await retainedArtifacts(artifactDir,result.artifacts):[];
  if(/\/Users\/|\/home\/|[A-Z]:\\Users\\/.test(JSON.stringify({...result,artifacts}))) throw new Error('Public result contains a home path');
  return {...result,artifacts};
}
export async function runHarness(options,{repoRoot=REPO}={}) {
  const manifestBytes=await fs.readFile(options.manifest),manifest=validateManifest(JSON.parse(manifestBytes));
  const plan={format:'sentinel-feasibility-plan/draft-1',effects:manifest.effects,manifestSha256:sha256(manifestBytes),experiments:manifest.experiments.map(item=>({id:item.id,selected:options.experiments.includes(item.id),probe:item.probe??null,decision:item.decision,reason:item.reason}))};
  if(!options.run) return plan;
  if(Number(process.versions.node.split('.')[0])<24) throw new Error('Node 24 or newer required');
  const fixtureRoot=await resolveFixtureRoot(repoRoot,manifest.fixtureRoot);
  const corpus=await loadCorpus(fixtureRoot),fixtureInventory=await inventory(fixtureRoot);
  const out=resolve(options.out);
  // The output parent must already exist. Resolve its aliases before comparing directory boundaries.
  const physicalOut=resolve(await fs.realpath(dirname(out)),basename(out));
  const outputScope=relative(await fs.realpath(fixtureRoot),physicalOut);
  if(!outputScope||(!isAbsolute(outputScope)&&outputScope!=='..'&&!outputScope.startsWith(`..${sep}`))) throw new Error('Output cannot be inside fixture inputs');
  // mkdir without recursive refuses an existing folder, file or symlink before any result is written.
  await fs.mkdir(out);
  const startedAt=new Date().toISOString();
  let revision='unavailable',dirty=true;
  try {revision=execFileSync('git',['rev-parse','HEAD'],{cwd:repoRoot,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();dirty=Boolean(execFileSync('git',['status','--porcelain'],{cwd:repoRoot,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim());} catch {}
  const envelope={format:'sentinel-feasibility-results/draft-1',revision,dirty,runtime:{node:process.versions.node,sqlite:process.versions.sqlite??null,zstd:process.versions.zstd??null,platform:platform(),arch:arch(),cpus:cpus().length,memoryBytes:totalmem()},startedAt,manifest:{sha256:sha256(manifestBytes)},fixtures:{corpusSha256:corpus.digest,inventorySha256:sha256(canonical(fixtureInventory))},effects:manifest.effects,harness:[],experiments:[]};
  for(const path of ['scripts/sentinel-feasibility.mjs','scripts/sentinel-feasibility/parser.mjs','scripts/sentinel-feasibility/storage.mjs','scripts/sentinel-feasibility/storage-worker.mjs','scripts/sentinel-feasibility/codec.mjs']) {
    try {const bytes=await fs.readFile(resolve(REPO,path));envelope.harness.push({path,sha256:sha256(bytes),bytes:bytes.length});} catch {}
  }
  await fs.writeFile(resolve(out,'manifest.json'),manifestBytes,{flag:'wx'});
  await fs.writeFile(resolve(out,'fixture-inventory.json'),JSON.stringify(fixtureInventory,null,2)+'\n',{flag:'wx'});
  for(const experiment of manifest.experiments) {
    let result={experiment:experiment.id,status:options.experiments.includes(experiment.id)?'blocked':'deferred',checks:[],metrics:{},limitations:[options.experiments.includes(experiment.id)?'No eligible built-in local probe exists for this stage.':'Not selected for this run.'],artifacts:[]};
    if(options.experiments.includes(experiment.id)&&PROBES[experiment.id]&&experiment.probe===PROBES[experiment.id].name) {
      const artifactDir=resolve(out,experiment.id,'artifacts'),workDir=resolve(out,experiment.id,'work');
      await fs.mkdir(artifactDir,{recursive:true}); await fs.mkdir(workDir,{recursive:true});
      try {
        const required=[];
        const mandatory=experiment.id==='E1'?['node24','parser-build']:['node24'];
        for(const id of new Set([...mandatory,...experiment.prerequisites])) {
          const prerequisite=manifest.prerequisites.find(item=>item.id===id)??{id,required:true,reason:'Built-in runtime prerequisite is unavailable.'};
          if(!mandatory.includes(id)&&!prerequisite.required) continue;
          let available=false;
          try {
            if(id==='node24') {await import('node:sqlite'); available=Number(process.versions.node.split('.')[0])>=24;}
            else if(id==='parser-build') {
              const parser=await import('./../packages/code-parser/dist/index.js');
              available=parser.PARSER_VERSION===PINS['@farsight/code-parser'];
              const {createRequire}=await import('node:module');
              const require=createRequire(resolve(repoRoot,'packages/code-parser/package.json'));
              for(const name of ['oxc-parser','@vscode/tree-sitter-wasm']) {
                const bytes=await fs.readFile(require.resolve(name+'/package.json'));
                available=available&&JSON.parse(bytes).version===PINS[name];
              }
              const graph=JSON.parse(await fs.readFile(resolve(repoRoot,'packages/graph/package.json')));
              available=available&&graph.version===PINS['@farsight/graph'];
            }
          } catch {}
          if(!available) required.push(prerequisite);
        }
        if(required.length) result={...result,status:'blocked',limitations:required.map(item=>`${item.id}: ${item.reason??'unavailable'}`)};
        else {
          // No manifest command, URL, module or candidate can change this literal import table.
          const builtin=PROBES[experiment.id],module=await import(builtin.module);
          result=await validateProbeResult(await module[builtin.entry]({fixtureRoot,workDir,artifactDir}),experiment.id,artifactDir);
        }
      } catch {result={...result,status:'failed',limitations:['Built-in probe failed or returned invalid evidence; inspect retained stage artifacts.']};}
    }
    await fs.mkdir(resolve(out,experiment.id),{recursive:true});
    await fs.writeFile(resolve(out,experiment.id,'result.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
    envelope.experiments.push({...result,selected:options.experiments.includes(experiment.id),decision:experiment.decision});
  }
  envelope.endedAt=new Date().toISOString();
  await fs.writeFile(resolve(out,'results.json'),JSON.stringify(envelope,null,2)+'\n',{flag:'wx'});
  return envelope;
}
async function main() {
  const options=parseArgs(process.argv.slice(2));
  if(options.help) {console.log('Preview: node scripts/sentinel-feasibility.mjs [--experiment E1,E4,E8]\nRun: add --run --experiment E1,E4,E8 --out <fresh-directory>');return;}
  const result=await runHarness(options);console.log(JSON.stringify(result,null,2));
  if(runHasFailures(result)) process.exitCode=1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) main().catch(error=>{console.error(`sentinel-feasibility: ${error.message}`);process.exitCode=1;});
