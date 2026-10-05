// The perf suite's webServer: write the synthetic workspace (scripts/synth-graph.mjs) into a temp
// directory — never a checkout's graph.json — then run the real `farsight serve` on it, from that
// directory, so /api/* reads the same workspace a person's server would.
// Usage: node e2e/perf/serve.mjs <port> <preset>
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { synthesize, writeGraph, writeSettings, parseArgs } from '../../scripts/synth-graph.mjs';
import { CLI } from '../fixture/workspace.mjs';

const port = process.argv[2] ?? '4535';
const preset = process.argv[3] ?? 'full';
const dir = join(tmpdir(), `farsight-perf-${preset}-${port}`);
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const graph = join(dir, 'graph.json');
const g = synthesize(parseArgs(['--preset', preset]));
const bytes = writeGraph(g, graph);
writeSettings(dir, g);
console.log(`[perf] ${preset}: ${g.nodes.length} nodes · ${g.edges.length} edges · ${(bytes / 1e6).toFixed(1)} MB → ${graph}`);
// a full-preset graph is parsed into a few GB of objects: give the server's heap the room a real one would get
const child = spawn(process.execPath, ['--max-old-space-size=8192', CLI, 'serve', graph, '--port', port], { cwd: dir, stdio: 'inherit' });
const stop = () => { child.kill('SIGTERM'); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
child.on('exit', (code) => { rmSync(dir, { recursive: true, force: true }); process.exit(code ?? 0); });
