// The native command gate reuses the existing package/isolation selector union and exact adapter pins.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {selectChecks,detectChecks} from '../ci-changes.mjs';
const root=new URL('../../',import.meta.url);
const workflow=readFileSync(new URL('.github/workflows/sentinel-scanner-cli.yml',root),'utf8');
const selected=paths=>{const checks=selectChecks(paths);return checks.sentinel||checks.isolation;};
test('scanner CLI acceptance selects source, captured inputs, owner gates, packs, helpers, packaging and build dependencies',()=>{
 for(const path of ['packages/sentinel/src/service/canonical.ts','packages/sentinel/src/service/scanner-assets.ts','packages/sentinel/src/policy/admission.ts','packages/sentinel/src/adapters/drivers/canonical.ts','packages/sentinel/rules/pattern/sentinel-pack.json','packages/sentinel/test/cli-scanners-helpers.ts','packages/sentinel/test/scanner-admission.test.ts','packages/sentinel/README.md','packages/core/src/strings-sentinel-cli.ts','packages/code-parser/src/index.ts','packages/graph/src/index.ts','scripts/npm-consumer.mjs','scripts/pack-sentinel.mjs','scripts/test-sentinel-scanner-consumer.mjs','.github/workflows/sentinel-scanner-cli.yml','pnpm-lock.yaml','.nvmrc'])assert.equal(selected([path]),true,path);
 for(const path of ['docs/VISION.md','docs/CI.md','AGENTS.md','e2e/tests/chrome.pw.spec.ts'])assert.equal(selected([path]),false,path);
 assert.equal(selected(['docs/VISION.md','packages/sentinel/test/cli-scanners-e2e.test.ts']),true,'mixed inputs retain the gate');
 const fallback=detectChecks({base:undefined,head:undefined,event:'pull_request'}).checks;assert.equal(fallback.sentinel||fallback.isolation,true,'unavailable ranges fail closed');
});
test('workflow image indexes and native manifests exactly match all five adapter source pins',()=>{
 const engines=[['pattern','PATTERN'],['osv','OSV'],['trivy','TRIVY'],['zizmor','ZIZMOR'],['gitleaks','GITLEAKS']];
 for(const[id,prefix]of engines){const source=readFileSync(new URL(`packages/sentinel/src/adapters/${id}/adapter.ts`,root),'utf8');
  const image=/\bimage: '([^']+)'/.exec(source)?.[1];const manifest=/architecture: 'amd64'[\s\S]*?manifest: '([^']+)'/.exec(source)?.[1];assert.ok(image);assert.ok(manifest);
  assert.equal(new RegExp(`^      ${prefix}_INDEX: (.+)$`,'m').exec(workflow)?.[1],image,id);assert.equal(new RegExp(`^      ${prefix}_AMD64: (.+)$`,'m').exec(workflow)?.[1],manifest,id);}
 assert.equal((workflow.match(/^          check "\$[A-Z]+_INDEX" "\$[A-Z]+_AMD64"$/gm)??[]).length,5,'each exact image is explicitly provisioned');
});
test('selection failure cannot skip the native gate, and selected tests cannot silently skip or run empty',()=>{
 assert.match(workflow,/if: \$\{\{ !cancelled\(\) && needs\.changes\.outputs\.run != 'false' \}\}/);
 assert.match(workflow,/SENTINEL_ISOLATION: '1'/);assert.match(workflow,/--test-concurrency=1/);
 for(const counter of ['skipped','fail','cancelled'])assert.ok(workflow.includes(`grep -qx '# ${counter} 0' scanner-cli.tap`));
 assert.ok(workflow.includes("grep -Eq '^# tests [1-9][0-9]*$' scanner-cli.tap"));
 assert.ok(workflow.includes('node scripts/test-sentinel-scanner-consumer.mjs | tee scanner-consumer.log'));
 assert.doesNotMatch(workflow,/continue-on-error|docker (?:system prune|rm)|pkill|killall/);
});

test('full-report native acceptance builds its context-ingestion dependency and retains every opted-in evidence suite',()=>{
 assert.match(workflow,/pnpm --filter '@farsight\/sentinel\.\.\.' --filter '@farsight\/parsers\.\.\.' build/);
 assert.ok(workflow.includes('test/cli-full-report-e2e.test.ts'));
 for(const name of ['review','redaction-neighbors','short-production','exemptions'])
  assert.ok(workflow.includes(`test/sol-report-${name}.test.ts`),name);
 assert.ok(workflow.includes('test/report-redaction.test.ts'),'pure projection controls remain in the native union too');
 for(const name of ['selected-rerun-containers','selected-rerun-secrets']) assert.ok(workflow.includes(`test/${name}.test.ts`),name);
});

test('framework inspection privacy and genuine installed delivery remain mandatory in native acceptance',()=>{
 assert.ok(workflow.includes('test/framework-report-secrets.test.ts'));assert.ok(workflow.includes('node scripts/test-sentinel-framework-consumer.mjs'));assert.ok(workflow.includes('framework-delivery/clean.html'));assert.ok(workflow.includes('framework-delivery/secret.html'));
});

test('SDK run controls remain in the native service zero-skip list and installed package hook',()=>{
 const serviceWorkflow=readFileSync(new URL('.github/workflows/ci.yml',root),'utf8');
 const service=serviceWorkflow.slice(serviceWorkflow.indexOf('    name: sentinel-service'),serviceWorkflow.indexOf('\n  e2e:'));
 for(const file of ['service-mcp-controls','service-planned-pause'])assert.ok(service.includes(`test/${file}.test.ts`));
 for(const counter of ['skipped','fail','cancelled'])assert.ok(service.includes(`grep -qx '# ${counter} 0' service.tap`));
 const manifest=JSON.parse(readFileSync(new URL('package.json',root),'utf8'));
 assert.ok(manifest.scripts['test:sentinel:package'].endsWith('&& node scripts/test-sentinel-mcp-controls-consumer.mjs'));
 assert.equal(selected(['scripts/test-sentinel-mcp-controls-consumer.mjs']),true,'changing the consumer selects package/native acceptance');
});

test('accepted imports have a zero-skip genuine privacy gate and npm-only public owner consumer',()=>{
 const manifest=JSON.parse(readFileSync(new URL('package.json',root),'utf8'));
 assert.ok(manifest.scripts['test:sentinel:package'].includes('node scripts/test-sentinel-evidence-consumer.mjs'));
 assert.equal(selected(['scripts/test-sentinel-evidence-consumer.mjs']),true);
 assert.ok(workflow.includes('test/evidence-privacy.test.ts'));assert.ok(workflow.includes('node scripts/test-sentinel-evidence-consumer.mjs | tee evidence-consumer.log'));assert.ok(workflow.includes(`grep -q '"nativePrivacy":true' evidence-consumer.log`));
});
