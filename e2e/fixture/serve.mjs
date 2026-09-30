// Playwright's webServer command: build the fixture workspace, then run the real
// `farsight serve` from it (cwd = the workspace, so /api/sync and snapshots stay there).
// Usage: node e2e/fixture/serve.mjs <port>
import { spawn } from 'node:child_process';
import { CLI, makeWorkspace } from './workspace.mjs';

const port = process.argv[2] ?? '4510';
const ws = makeWorkspace(`serve-${port}`, { fixed: true });
console.log(`[e2e] fixture workspace ${ws.dir}`);
const child = spawn(process.execPath, [CLI, 'serve', ws.graph, '--port', port], { cwd: ws.dir, stdio: 'inherit' });
const stop = () => { child.kill('SIGTERM'); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
child.on('exit', (code) => { ws.cleanup(); process.exit(code ?? 0); });
