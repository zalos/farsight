// Original rule packs shipped with the production drivers. No acquired engines, advisory snapshots, credentials or
// grants ship here, and these assets do not register a driver or make any CLI capability available.
import {createHash} from 'node:crypto';
import {cpSync,mkdirSync,readdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,relative} from 'node:path';
import {pathToFileURL} from 'node:url';
export async function stageAssets(pkgDir,outDir){
 const {readPackDirectory,validatePack}=await import(pathToFileURL(join(pkgDir,'dist/rules/pack.js')).href);
 const packs=[];
 for(const name of ['advisories','ci','infrastructure']){
  const source=join(pkgDir,'rules',name);const validated=validatePack(readPackDirectory(source));
  cpSync(source,join(outDir,'rules',name),{recursive:true});
  const files=readdirSync(source,{recursive:true,withFileTypes:true}).filter(e=>e.isFile()).map(e=>relative(source,join(e.parentPath??e.path,e.name)).split('\\').join('/')).sort().map(path=>{const b=readFileSync(join(source,path));return{path,digest:'sha256:'+createHash('sha256').update(b).digest('hex'),size:b.length};});
  packs.push({path:'rules/'+name,packId:validated.entry.packId,packDigest:validated.entry.packDigest,rights:validated.manifest.rights,rules:validated.entry.rules,files});
 }
 mkdirSync(join(outDir,'assets','drivers'),{recursive:true});writeFileSync(join(outDir,'assets','drivers','manifest.json'),JSON.stringify({schema:'sentinel-driver-assets/draft-1',registered:false,acquisition:'owner action; no engines or databases included',packs},null,2)+'\n');
 return{files:['rules','assets'],exports:{'./rules/*':'./rules/*','./assets/*':'./assets/*'}};
}
