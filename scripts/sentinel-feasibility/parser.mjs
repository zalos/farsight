import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { resolve, relative, isAbsolute, dirname, sep } from 'node:path';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const canonical = value => JSON.stringify(value, (_key, item) => item && !Array.isArray(item) && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
export function inside(root, path) {
  if (typeof path !== 'string' || !path || path.includes('\\') || isAbsolute(path) || path.split('/').some(part => part === '..' || part === '.')) throw new Error('Expected a safe relative path');
  const full = resolve(root, path);
  if (!relative(resolve(root), full) || relative(resolve(root), full).startsWith(`..${sep}`)) throw new Error('Path escapes root');
  return full;
}
async function regularDirectory(root) {
  const stat=await fs.lstat(root);
  if(stat.isSymbolicLink()) throw new Error('Fixture directory symlink refused');
  if(!stat.isDirectory()) throw new Error('Fixture root must be a regular directory');
}
export async function resolveFixtureRoot(repoRoot, path) {
  const full=inside(repoRoot,path);
  await regularDirectory(repoRoot);
  let current=resolve(repoRoot);
  // Fixed local fixtures: refuse existing redirected components; no hostile filesystem race claim.
  for(const part of path.split('/')) {current=resolve(current,part);await regularDirectory(current);}
  return full;
}
export async function inventory(root) {
  await regularDirectory(root);
  const rows = [];
  async function walk(dir, prefix = '') {
    for (const name of (await fs.readdir(dir)).sort()) {
      const path = prefix ? `${prefix}/${name}` : name;
      const full = resolve(dir, name), stat = await fs.lstat(full);
      if (stat.isSymbolicLink()) rows.push({path, kind:'symlink', digest:sha256(await fs.readlink(full))});
      else if (stat.isDirectory()) { rows.push({path,kind:'directory',digest:sha256(canonical((await fs.readdir(full)).sort()))}); if (path!=='.git') await walk(full,path); }
      else if (stat.isFile()) { const bytes=await fs.readFile(full); rows.push({path,kind:'file',bytes:bytes.length,digest:sha256(bytes)}); }
      else rows.push({path,kind:'special'});
    }
  }
  rows.push({path:'.',kind:'directory',digest:sha256(canonical((await fs.readdir(root)).sort()))});
  await walk(root);
  return rows;
}
export async function loadCorpus(fixtureRoot) {
  await regularDirectory(fixtureRoot);
  const index=resolve(fixtureRoot,'cases.json'),stat=await fs.lstat(index);
  if(stat.isSymbolicLink()) throw new Error('Fixture index symlink refused');
  if(!stat.isFile()) throw new Error('Fixture index must be a regular file');
  const body = await fs.readFile(index);
  const corpus = JSON.parse(body);
  if (corpus.schemaVersion !== 'sentinel-feasibility-corpus-v1' || !Array.isArray(corpus.cases) || !corpus.cases.length) throw new Error('Invalid fixture corpus');
  const ids = new Set();
  for (const item of corpus.cases) {
    if (!/^[A-Za-z0-9_-]+$/.test(item.id) || ids.has(item.id) || !Array.isArray(item.files) || !Array.isArray(item.gates)) throw new Error('Invalid or duplicate fixture id');
    ids.add(item.id);
    const paths = new Set();
    for(const path of item.gitIndex??[]) inside(fixtureRoot,path);
    for (const file of [...item.files,...(item.generated??[])]) {
      inside(fixtureRoot,file.path);
      if(file.path.split('/').includes('.git')) throw new Error('Fixture Git metadata is reserved for the harness');
      if (paths.has(file.path) || [...paths].some(p=>p.startsWith(file.path+'/')||file.path.startsWith(p+'/'))) throw new Error('Conflicting fixture paths');
      paths.add(file.path);
      if (!/^[a-f0-9]{64}$/.test(file.sha256??'') && !['missing','symlink'].includes(file.type)) throw new Error('Missing fixture digest');
      if (file.source) {
        const path=inside(fixtureRoot,file.source);
        // Corpus inputs are regular files; a source symlink must never redirect a read.
        let current=resolve(fixtureRoot);
        for (const part of file.source.split('/')) { current=resolve(current,part); if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('Fixture source symlink refused'); }
        if (sha256(await fs.readFile(path))!==file.sha256) throw new Error(`Fixture digest mismatch: ${item.id}/${file.path}`);
      } else if (file.type==='missing' || file.type==='symlink') {
        if (file.type==='symlink' && (typeof file.target!=='string' || isAbsolute(file.target))) throw new Error('Invalid symlink control');
      } else if (typeof file.repeat !== 'string' || !Number.isSafeInteger(file.count) || file.count<1 || Buffer.byteLength(file.repeat)*file.count>2*1024*1024 || sha256(file.repeat.repeat(file.count))!==file.sha256) throw new Error('Invalid generated fixture');
    }
  }
  return {corpus,digest:sha256(body)};
}
async function materialize(item, fixtureRoot, root) {
  await fs.mkdir(root,{recursive:true});
  for (const file of [...item.files,...(item.generated??[])]) {
    const path=inside(root,file.path); await fs.mkdir(dirname(path),{recursive:true});
    if (file.type==='missing') continue;
    if (file.type==='symlink') await fs.symlink(file.target,path);
    else await fs.writeFile(path,file.source?await fs.readFile(inside(fixtureRoot,file.source)):file.repeat.repeat(file.count),{flag:'wx'});
  }
  if(item.gitIndex?.length) {
    const env={PATH:process.env.PATH,HOME:process.env.HOME,LANG:'C',LC_ALL:'C',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null',GIT_CONFIG_COUNT:'0',GIT_INDEX_FILE:resolve(root,'.git/index'),GIT_TEMPLATE_DIR:''};
    execFileSync('git',['-c','core.hooksPath=/dev/null','init','--quiet',root],{env});
    execFileSync('git',['-C',root,'-c','core.hooksPath=/dev/null','add','--force','--',...item.gitIndex],{env});
  }
}
export function reconcileInputs(rows, analysis) {
  const byPath = new Map(rows.map(row=>[row.path,row]));
  return analysis.inputs.map(input=> {
    const row=byPath.get(input.path);
    const expected=input.kind==='content'?row?.kind==='file'?row.digest:null
      :input.kind==='directory'?row?.kind==='directory'?row.digest:null
      :input.kind==='metadata'?row && ['file','directory'].includes(row.kind)?sha256(row.kind):null
      :input.kind==='missing'?(!row || row.kind==='symlink')?sha256('unavailable'):null:null;
    return {...input,expected,matched:expected!==null && input.digest===expected};
  });
}
export async function runParserProbe({fixtureRoot,workDir,artifactDir}) {
  const artifacts=[], checks=[], measurements=[];
  const save=async(name,value)=> { const body=JSON.stringify(value,null,2)+'\n'; await fs.writeFile(resolve(artifactDir,name),body,{flag:'wx'}); artifacts.push({path:name,sha256:sha256(body),bytes:Buffer.byteLength(body)}); };
  await fs.mkdir(workDir,{recursive:true}); await fs.mkdir(artifactDir,{recursive:true});
  const {corpus,digest}=await loadCorpus(fixtureRoot);
  const [{createParser,PARSER_VERSION},{tsJsAdapter},{javaAdapter}]=await Promise.all([
    import('../../packages/code-parser/dist/index.js'),import('../../packages/code-parser/dist/tsjs.js'),import('../../packages/code-parser/dist/java/index.js')]);
  const parser=createParser({adapters:[tsJsAdapter,javaAdapter]});
  const options={gitignore:true,testFiles:'include',limits:{maxFiles:128,maxFileBytes:4096,maxTotalBytes:2*1024*1024,maxEntries:4096,maxDurationMs:30000}};
  const selected=corpus.cases.filter(item=>item.gates.includes('E1'));
  if (!selected.length) throw new Error('Corpus has no E1 cases');
  for (const item of selected) {
    const root=inside(workDir,item.id); await materialize(item,fixtureRoot,root);
    const before=await inventory(root), started=performance.now();
    const declaredInventory=[...item.files,...(item.generated??[])].map(file=>({path:file.path,expected:file.type??'file',actual:before.find(row=>row.path===file.path)?.kind??'missing'}));
    checks.push({id:`${item.id}:declared-inventory`,passed:declaredInventory.every(row=>row.actual===(row.expected==='symlink'?'symlink':row.expected==='missing'?'missing':'file')) && (item.expected?.enumerated??[]).every(path=>declaredInventory.some(row=>row.path===path)),evidence:declaredInventory});
    const artifact=await parser.parseRepository({root,sourceId:item.id,...options});
    const after=await inventory(root), reconciliation=reconcileInputs(before,artifact.analysis);
    const reported=new Map(artifact.analysis.files.map(file=>[file.path,file]));
    const selection=before.filter(row=>row.kind==='file').map(row=>({path:row.path,inventory:item.files.find(file=>file.path===row.path)?.inventory??item.generated?.find(file=>file.path===row.path)?.inventory??'generated',parser:reported.get(row.path)??null,inputs:artifact.analysis.inputs.filter(input=>input.path===row.path).map(input=>input.kind)}));
    checks.push({id:`${item.id}:source-unchanged`,passed:canonical(before)===canonical(after),evidence:{before:sha256(canonical(before)),after:sha256(canonical(after))}});
    checks.push({id:`${item.id}:input-digests`,passed:reconciliation.every(row=>row.matched),evidence:{checked:reconciliation.length,mismatches:reconciliation.filter(row=>!row.matched)}});
    for (const path of item.expected?.parserCandidates??[]) checks.push({id:`${item.id}:candidate:${path}`,passed:reported.has(path),evidence:{path,actual:reported.get(path)??null}});
    for (const path of item.expected?.parserExcluded??[]) checks.push({id:`${item.id}:excluded:${path}`,passed:!reported.has(path)||reported.get(path).status!=='analyzed',evidence:{path,actual:reported.get(path)??null}});
    for(const file of [...item.files,...(item.generated??[])]) {
      if(file.inventory==='malformed') checks.push({id:`${item.id}:malformed:${file.path}`,passed:!artifact.analysis.complete&&artifact.analysis.diagnostics.some(row=>row.code==='parse-error'&&row.path===file.path),evidence:{file:reported.get(file.path),diagnostics:artifact.analysis.diagnostics.filter(row=>row.path===file.path)}});
      if(file.inventory==='unsupported') checks.push({id:`${item.id}:unsupported:${file.path}`,passed:reported.get(file.path)?.status!=='analyzed',evidence:{inventory:'unsupported',parser:reported.get(file.path)??null}});
      if(file.inventory==='oversized') checks.push({id:`${item.id}:oversized:${file.path}`,passed:!artifact.analysis.complete&&artifact.analysis.diagnostics.some(row=>row.code==='resource-limit'&&row.path===file.path),evidence:{file:reported.get(file.path)}});
    }
    measurements.push({id:item.id,wallMs:performance.now()-started,complete:artifact.analysis.complete,inventoryFiles:selection.length,reportedFiles:reported.size,omittedFiles:selection.filter(row=>!row.parser).map(row=>row.path),diagnostics:artifact.analysis.diagnostics});
    const gitIndex=item.gitIndex?.length?execFileSync('git',['-C',root,'ls-files','--cached'],{encoding:'utf8'}).trim().split('\n'):[];
    if(item.gitIndex?.length) checks.push({id:`${item.id}:tracked-inventory`,passed:item.gitIndex.every(path=>gitIndex.includes(path)),evidence:{expected:item.gitIndex,actual:gitIndex}});
    await save(`${item.id}.json`,{options,declaredInventory,before,after,selection,reconciliation,gitIndex,artifact});
  }
  // Independent controls demonstrate ignored omission, refusal, missing inputs, limits and ignore-rule identity.
  const root=inside(workDir,'boundary-controls'); await fs.mkdir(root);
  await fs.writeFile(resolve(root,'visible.ts'),'export function visible() { return 1; }\n');
  await fs.writeFile(resolve(root,'ignored.ts'),'export function ignored() { return 2; }\n');
  await fs.writeFile(resolve(root,'.gitignore'),'ignored.ts\n');
  const first=await parser.parseRepository({root,sourceId:'controls',...options});
  await fs.writeFile(resolve(root,'.gitignore'),'# include everything\n');
  const second=await parser.parseRepository({root,sourceId:'controls',...options});
  checks.push({id:'ignored-complete-trap',passed:first.analysis.complete && !first.analysis.files.some(row=>row.path==='ignored.ts'),evidence:{complete:first.analysis.complete,reported:first.analysis.files.map(row=>row.path),independentInventory:['ignored.ts','visible.ts','.gitignore']}});
  checks.push({id:'gitignore-change',passed:first.analysis.fingerprint!==second.analysis.fingerprint && second.analysis.files.some(row=>row.path==='ignored.ts'),evidence:{before:first.analysis.fingerprint,after:second.analysis.fingerprint,ignoreBefore:first.analysis.inputs.filter(row=>row.path==='.gitignore'),ignoreAfter:second.analysis.inputs.filter(row=>row.path==='.gitignore')}});
  await fs.symlink('absent.ts',resolve(root,'refused.ts'));
  await fs.writeFile(resolve(root,'huge.ts'),'x'.repeat(8192));
  await fs.writeFile(resolve(root,'tsconfig.json'),'{"extends":"./missing-config.json"}');
  const boundary=await parser.parseRepository({root,sourceId:'controls',...options});
  checks.push({id:'symlink-refused',passed:boundary.analysis.diagnostics.some(row=>row.code==='read-boundary'&&row.reason==='symlink'),evidence:boundary.analysis.diagnostics.filter(row=>row.code==='read-boundary')});
  checks.push({id:'oversize-not-clean',passed:!boundary.analysis.complete&&boundary.analysis.diagnostics.some(row=>row.code==='resource-limit'),evidence:boundary.analysis.files.filter(row=>row.path==='huge.ts')});
  checks.push({id:'missing-recorded',passed:boundary.analysis.inputs.some(row=>row.kind==='missing'&&row.path==='package.json'),evidence:boundary.analysis.inputs.filter(row=>row.kind==='missing')});
  await save('boundary-controls.json',{options,first,second,boundary,inventory:await inventory(root)});
  const limitations=['Measurements concern public syntax artifacts, not security enforcement or application enrichment.','Ignored/unsupported/security configuration inventory is independent; analysis.complete is selected-parser completeness only.','No unreadable-directory claim: permission behavior depends on executing identity.','Label review and capability acceptance remain separate owner decisions.','Missing configuration probes record actual reads; an unvisited extends target is not claimed captured.'];
  return {experiment:'E1',status:'measured',checks,metrics:{parserVersion:PARSER_VERSION,adapters:[{id:tsJsAdapter.id,version:tsJsAdapter.version},{id:javaAdapter.id,version:javaAdapter.version}],corpusDigest:digest,cases:measurements,rssBytes:process.memoryUsage().rss},limitations,artifacts};
}
