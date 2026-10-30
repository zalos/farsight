import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from './support';
import { CLI, makeWorkspace, ingest } from '../fixture/workspace.mjs';

let workspace: ReturnType<typeof makeWorkspace>;
let server: ChildProcess;
let base = '';
const routeId = 'invoice-app::route::POST /pattern-preview';
const flowId = 'invoice-app::flow::pattern-preview';

test.beforeAll(async () => {
  workspace = makeWorkspace('patterns');
  const configPath = join(join(workspace.dir, 'invoice-app'), 'farsight.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.patterns = [
    {
      id: 'custom-route',
      files: ['src/patterns.tsx'],
      match: { call: 'portal.$METHOD', args: { path: 0, handler: -1 } },
      emit: {
        kind: 'route',
        method: '$METHOD',
        path: '$path',
        handler: '$handler',
        business: 'Preview the invoice through a custom endpoint.',
      },
    },
  ];
  writeFileSync(configPath, JSON.stringify(config));
  writeFileSync(
    join(join(workspace.dir, 'invoice-app'), 'src/patterns.tsx'),
    `export function patternHandler() { return { ok: true }; }\nportal.post('/pattern-preview', patternHandler);\n/** @business Preview an invoice. */\nexport function PatternPreview() {\n async function preview() { return fetch('/pattern-preview', { method: 'POST' }); }\n return <button onClick={preview}>Preview invoice</button>;\n}\n`,
  );
  const designPath = join(join(workspace.dir, 'invoice-app'), 'docs/design/screens.json');
  const design = JSON.parse(readFileSync(designPath, 'utf8'));
  design.screens.push({
    id: 'PATTERN',
    name: 'Pattern preview',
    component: 'PatternPreview',
    operations: ['POST /pattern-preview'],
  });
  design.flows.push({
    id: 'pattern-preview',
    name: 'Pattern preview',
    screens: ['PATTERN'],
    operations: ['POST /pattern-preview'],
  });
  writeFileSync(designPath, JSON.stringify(design));
  ingest(workspace.dir, workspace.graph);
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  const port = address.port;
  await new Promise<void>((done) => probe.close(() => done()));
  base = `http://127.0.0.1:${port}/`;
  server = spawn(process.execPath, [CLI, 'serve', workspace.graph, '--port', String(port), '--read-only'], {
    cwd: workspace.dir,
    stdio: 'ignore',
  });
  await expect
    .poll(async () => {
      try {
        return (await fetch(base + 'api/version')).status;
      } catch {
        return 0;
      }
    })
    .toBe(200);
});

test.afterAll(async () => {
  if (server && server.exitCode === null) {
    const stopped = once(server, 'exit');
    server.kill();
    await stopped;
  }
  workspace?.cleanup();
});

/**
 * @covers packages/parsers/src/patterns.ts::applyPatterns
 * @covers GET /api/patterns/test
 * @covers GET /api/config
 * @covers packages/server/public/app/surfaces/settings-config.js::configFilesHtml
 */
test('a pattern-only route reaches the Map and APIs, with declared match evidence and a counted report', async ({
  page,
}, testInfo) => {
  const graph = await (await fetch(base + 'graph')).json();
  const route = graph.nodes.find((n: { id: string }) => n.id === routeId);
  expect(route.tags).toContain('pattern:custom-route');
  expect(route.tags).toContain('declared');
  const edge = graph.edges.find((e: { from: string; kind: string }) => e.from === routeId && e.kind === 'calls');
  expect(edge.resolution).toMatchObject({ technique: 'config-pattern', confidence: 'HIGH' });
  expect(edge.resolution.note).toContain('patterns[custom-route]');
  await page.goto(base + '#/map/' + encodeURIComponent(flowId) + '?lens=code&card=call:' + encodeURIComponent(routeId));
  await expect(page.locator('#stats')).not.toHaveText('loading…');
  await expect(page.locator('.map-xcard')).toContainText('/pattern-preview');
  await expect(page.locator('.map-xcard')).toContainText('implied');
  await page.screenshot({ path: testInfo.outputPath('pattern-map.png') });
  const apiList = await (await fetch(base + 'api/apis')).json();
  const api = apiList.apis.find(
    (a: { repo: string; operations: { routeId: string }[] }) =>
      a.repo === 'invoice-app' && a.operations.some((op) => op.routeId === routeId),
  );
  expect(api).toBeTruthy();
  await page.goto(base + '#/apis/' + encodeURIComponent(api.id) + '?lens=code&op=' + encodeURIComponent(routeId));
  await expect(page.locator('#api-op')).toContainText('/pattern-preview');
  await expect(page.locator('#api-op')).toContainText('src/patterns.tsx');
  await expect(page.locator('#api-op')).toContainText('undocumented');
  await page.screenshot({ path: testInfo.outputPath('pattern-api.png') });
  const before = readFileSync(workspace.graph, 'utf8');
  const dry = await (await fetch(base + 'api/patterns/test?source=invoice-app&rule=custom-route')).json();
  expect(dry.matches[0].name).toBe('POST /pattern-preview');
  expect(readFileSync(workspace.graph, 'utf8')).toBe(before);
  if (!(await page.locator('#gearbtn').isVisible())) await page.locator('#morebtn').click();
  await page.locator('#gearbtn').click();
  await expect(page.locator('.cfg-pattern-row')).toContainText('custom-route');
  await expect(page.locator('.cfg-pattern-row')).toContainText('1 match');
  // Hover opens after scrolling settles; a scroll closes an already pinned tip.
  await page.locator('.cfg-pattern-row .cnt-n').first().hover();
  await expect(page.locator('#fs-tip')).toContainText('for this pattern rule');
  await page.screenshot({ path: testInfo.outputPath('pattern-report.png') });
  await page.goto(base + '#/map/' + encodeURIComponent(flowId) + '?lens=business');
  await expect(page.locator('#stats')).not.toHaveText('loading…');
  if (!(await page.locator('#gearbtn').isVisible())) await page.locator('#morebtn').click();
  await page.locator('#gearbtn').click();
  await expect(page.locator('.cfg-pattern-row')).toContainText('1 part added');
  await expect(page.locator('.cfg-pattern-row')).toContainText('1 connection added');
  await page.screenshot({ path: testInfo.outputPath('pattern-report-business.png') });
});
