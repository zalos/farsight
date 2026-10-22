// Repository read binding is derived from the same admitted work/check/source, never a worker's scope claim.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {capturedInputScopes} from '../dist/execution/plan.js';
const content='sha256:'+'1'.repeat(64);const other='sha256:'+'2'.repeat(64);
function fixture(){const check:any={id:'check',state:'planned',scopeKind:'repository',scopeId:'app',sourceId:'app',unit:{id:'work',revision:1}};
 const unit:any={id:'work',revision:1,sourceId:'app',checks:['check'],scopes:['app'],inputs:[{sourceId:'app',relativePath:'.env',content},{sourceId:'app',relativePath:'same.txt',content}]};return{unit,check};}
test('a repository check binds every same-source sealed content once, including identical-byte files',()=>{
 const{unit,check}=fixture();assert.deepEqual(capturedInputScopes(unit,[check],[{id:content}]),[{input:content,scopes:['app','app:.env','app:same.txt']}]);
});
test("sealed content from another source cannot acquire this work's repository scope",()=>{
 const{unit,check}=fixture();unit.inputs=[{sourceId:'other',relativePath:'.env',content}];assert.deepEqual(capturedInputScopes(unit,[check],[{id:content}]),[{input:content,scopes:['other:.env']}]);
});
test('an unassigned check, revision or repository scope grants no sealed input the repository scope',()=>{
 for(const change of [{unit:{id:'other',revision:1}},{unit:{id:'work',revision:2}},{id:'other'},{sourceId:'other'},{scopeId:'other'}]){
  const{unit,check}=fixture();assert.deepEqual(capturedInputScopes(unit,[{...check,...change}],[{id:content}])[0]!.scopes,['app:.env','app:same.txt']);}
 const{unit,check}=fixture();unit.scopes=['other'];assert.deepEqual(capturedInputScopes(unit,[check],[{id:content}])[0]!.scopes,['app:.env','app:same.txt']);
 assert.deepEqual(capturedInputScopes(unit,[check],[{id:other}]),[{input:other,scopes:[]}],'a sealed auxiliary or unrelated content acquires no scope');
});
test('ordinary file-unit scope binding is unchanged',()=>{
 const{unit,check}=fixture();check.scopeKind='source-file';check.scopeId='app:.env';unit.scopes=['app:.env'];assert.deepEqual(capturedInputScopes(unit,[check],[{id:content}]),[{input:content,scopes:['app:.env','app:same.txt']}]);
});
