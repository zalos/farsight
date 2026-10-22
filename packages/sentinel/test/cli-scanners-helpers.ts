import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {syntheticSnapshot} from './osv-helpers.ts';
import {loadChecksBundle} from '../dist/adapters/trivy/index.js';
const ROOT=fileURLToPath(new URL('../',import.meta.url));
export function scannerFixture(dir:string){
 const ws=join(dir,'workspace');mkdirSync(ws,{mode:0o700});
 const read=(pack:string,path:string)=>readFileSync(join(ROOT,'rules',pack,'fixtures',path),'utf8');
 const files:Record<string,string>={
  'src/bad.ts':'export function lookup(id: string) { return db.query("SELECT * FROM users WHERE id = " + id); }\n',
  'src/good.ts':'export function lookup(id: string) { return db.query("SELECT * FROM users WHERE id = ?", [id]); }\n',
  'bad/Dockerfile':read('infrastructure','root-dockerfile.fixture'),'good/Dockerfile':read('infrastructure','hardened-dockerfile.fixture'),
  '.github/workflows/bad.yml':read('ci','injection-workflow-yml.fixture'),'.github/workflows/good.yml':read('ci','hardened-workflow-yml.fixture'),
  'bad/package-lock.json':read('advisories','vulnerable-package-lock-json.fixture'),'good/package-lock.json':read('advisories','clean-package-lock-json.fixture'),
  'package.json':'{"name":"inert-original-scanner-fixture","private":true}\n',
 };
 for(const [path,text]of Object.entries(files)){mkdirSync(join(ws,path,'..'),{recursive:true});writeFileSync(join(ws,path),text);}
 const db=syntheticSnapshot(join(dir,'db'),'npm',[1],'2026-10-21T00:00:00.000000000Z');
 const manifest=join(dir,'advisory-manifest.json');writeFileSync(manifest,JSON.stringify(db.snapshot));
 const checksDir=process.env.SENTINEL_TRIVY_CHECKS_DIR;assert.ok(checksDir);const checks=loadChecksBundle(join(checksDir,'checks'));assert.ok(checks);
 const trivyManifest=join(checksDir,'checks',checks.bundle.layer.slice(7)+'.json');
 return{ws,files,db,manifest,checks,trivyManifest};
}

