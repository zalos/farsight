#!/usr/bin/env node
// Installs the packed farsight-cli tarball into a clean npm consumer and starts it, with no
// Sentinel package installed. Proves the default package neither bundles nor needs Sentinel:
// the bundle names no Sentinel module, --version and an ingest run, and `serve` answers
// /api/version. The server is this script's own child, stopped by its pid.
//
//   pnpm test:cli:package             # builds only the CLI's closure, packs, then runs this
//   node scripts/test-farsight-package.mjs [build/farsight-cli-<v>.tgz]
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { npmConsumer } from './npm-consumer.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const artifact = resolve(process.argv[2] ?? join(root, 'build', `farsight-cli-${version}.tgz`));
if (!existsSync(artifact)) {
  console.error(`test-farsight-package: ${artifact} is missing. Run \`pnpm pack:cli\` first.`);
  process.exit(1);
}
const freePort = () => new Promise((ok, fail) => {
  const socket = createServer();
  socket.once('error', fail);
  socket.listen(0, '127.0.0.1', () => { const { port } = socket.address(); socket.close(() => ok(port)); });
});

const consumer = await npmConsumer('farsight-package-', [artifact]);
let server, client;
try {
  const installed = join(consumer.dir, 'node_modules', 'farsight-cli');
  const workspaceEngines = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).engines?.node;
  const packed = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
  assert.equal(packed.engines?.node, workspaceEngines, 'the tarball claims the workspace runtime floor');
  assert.equal(packed.dependencies?.['@modelcontextprotocol/sdk'], '^1.32.0', 'the installed CLI excludes SDK versions below the security floor');
  assert.equal(packed.dependencies?.zod, '^3.25.0', 'the installed CLI meets the SDK required peer floor');
  const bundle = readFileSync(join(installed, 'dist', 'farsight.mjs'), 'utf8');
  assert.doesNotMatch(bundle, /["'](?:@farsight\/sentinel|farsight-sentinel)["'/]/, 'the CLI bundle names no Sentinel module');
  const modules = readdirSync(join(consumer.dir, 'node_modules'));
  assert.ok(!modules.includes('farsight-sentinel') && !modules.includes('@farsight'), 'Sentinel is absent from the consumer');

  const farsight = consumer.bin('farsight');
  const line = (await consumer.exec(farsight, ['--version'])).stdout;
  assert.match(line, new RegExp(`farsight ${version.replaceAll('.', '\\.')}\\b`));

  // ingest from the consumer directory: snapshots are written relative to cwd
  const graph = join(consumer.dir, 'graph.json');
  await consumer.exec(farsight, ['ingest', join(root, 'examples', 'invoice-app'), '--repo', 'invoice-app', '--out', graph]);
  assert.ok(JSON.parse(readFileSync(graph, 'utf8')).nodes.length > 0, 'ingest wrote nodes');

  // Resolve the client from this npm installation, then drive the installed CLI over actual stdio.
  const require = createRequire(join(consumer.dir, 'package.json'));
  const clientEntry = require.resolve('@modelcontextprotocol/sdk/client/index.js');
  const sdkVersion = JSON.parse(readFileSync(resolve(dirname(clientEntry), '../../..', 'package.json'), 'utf8')).version;
  assert.ok(/^1\.(\d+)\./.test(sdkVersion) && Number(sdkVersion.split('.')[1]) >= 32, sdkVersion);
  const { Client } = await import(pathToFileURL(clientEntry).href);
  const { StdioClientTransport } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href);
  client = new Client({ name: 'farsight-installed-consumer', version: '1' }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: farsight, args: ['mcp', '--graph', graph], cwd: consumer.dir, env: consumer.env, stderr: 'pipe' });
  let mcpErrors = '';
  transport.stderr?.on('data', bytes => { mcpErrors = (mcpErrors + bytes).slice(-4000); });
  await client.connect(transport);
  assert.ok((await client.listTools()).tools.some(tool => tool.name === 'graph_overview'), mcpErrors);
  const overview = await client.callTool({ name: 'graph_overview', arguments: {} });
  assert.ok(!overview.isError, JSON.stringify(overview));
  assert.match(overview.content.filter(part => part.type === 'text').map(part => part.text).join('\n'), /invoice-app/);
  await client.close(); client = undefined;

  const port = await freePort();
  server = spawn(farsight, ['serve', graph, '--port', String(port), '--read-only'], { cwd: consumer.dir, env: consumer.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  server.stdout.on('data', (d) => { output += d; });
  server.stderr.on('data', (d) => { output += d; });
  let answer;
  for (let i = 0; i < 100 && !answer; i++) {
    if (server.exitCode !== null) break;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/version`);
      if (res.ok) answer = await res.json();
    } catch { /* not listening yet */ }
    if (!answer) await delay(200);
  }
  assert.ok(answer, `serve answered /api/version on ${port}\n${output}`);
  assert.equal(answer.farsight?.version, version);
  assert.equal(answer.session?.readOnly, true);
  console.log(`farsight package ok: ${line.trim()}, ingest, MCP stdio SDK ${sdkVersion}, serve on ${port}, no Sentinel in the bundle or the consumer`);
} finally {
  await client?.close();
  if (server && server.exitCode === null) {
    await new Promise((done) => {
      const timer = setTimeout(() => server.kill('SIGKILL'), 10_000);
      server.once('exit', () => { clearTimeout(timer); done(); });
      server.kill('SIGTERM');
    });
  }
  consumer.cleanup();
}
