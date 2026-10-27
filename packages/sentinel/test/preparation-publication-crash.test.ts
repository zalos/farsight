// Actual process death in the private journal writer, before canonical association. No forged accepted state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { preparationFixture } from './helpers/preparation-fixture.ts';
import { needsStore } from './snapshot-helpers.ts';
import { openStore } from '../dist/store/index.js';
import { OwnerService, connectService } from '../dist/service/owner-service.js';
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url)),
  exec = promisify(execFile),
  by = { principal: 'agent' as const, channel: 'local-service' as const },
  key = 'journal_crash_request_original_0001';
for (const cut of ['record-before-link', 'record-linked', 'update-before-rename', 'bundle-linked'])
  test(
    `real owned service SIGKILL at ${cut} preserves canonical authority and leaves other service operations usable`,
    { ...needsStore, timeout: 60000 },
    async (t) => {
      const f = await preparationFixture(t);
      f.store.close();
      const records = join(f.ws.storePath, 'preparation', 'records'),
        bundles = join(f.ws.storePath, 'preparation', 'bundles'),
        preload = join(f.dir, 'hold.mjs');
      writeFileSync(
        preload,
        `import fs from 'node:fs';import{syncBuiltinESMExports}from'node:module';import{dirname,basename}from'node:path';const cut=${JSON.stringify(cut)},records=${JSON.stringify(records)},bundles=${JSON.stringify(bundles)};const hold=()=>{fs.writeSync(3,'journal-checkpoint\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);};const link=fs.linkSync,rename=fs.renameSync;fs.linkSync=function(...a){const p=String(a[1]),record=dirname(p)===records&&/^[a-f0-9]{64}\\.json$/.test(basename(p)),bundle=dirname(p)===bundles&&/^prep-[a-f0-9]{32}\\.config\\.json$/.test(basename(p));if(record&&cut==='record-before-link')hold();const value=link.apply(this,a);if(record&&cut==='record-linked'||bundle&&cut==='bundle-linked')hold();return value;};fs.renameSync=function(...a){const p=String(a[1]);if(cut==='update-before-rename'&&dirname(p)===records&&/^[a-f0-9]{64}\\.json$/.test(basename(p))&&JSON.parse(fs.readFileSync(String(a[0]),'utf8')).phase==='discovering')hold();return rename.apply(this,a);};syncBuiltinESMExports();`,
      );
      const env = { ...process.env, XDG_STATE_HOME: join(f.dir, 'owner') },
        child = spawn(
          process.execPath,
          ['--import', preload, cli, 'serve', '--workspace', f.ws.path, '--idle-ms', '0'],
          { env, stdio: ['ignore', 'ignore', 'pipe', 'pipe'] },
        );
      let errors = '';
      child.stderr!.on('data', (b) => (errors += b));
      const exited = new Promise<void>((r) => child.once('exit', () => r()));
      t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
          await exited;
        }
      });
      let hit!: () => void;
      const observed = new Promise<void>((r) => (hit = r));
      child.stdio[3]!.on('data', (b) => {
        if (b.toString() === 'journal-checkpoint\n') hit();
      });
      for (let i = 0; ; i++) {
        const c = await connectService(f.ws, 'cli');
        if (c) {
          c.close();
          break;
        }
        assert.ok(i < 200, errors);
        await new Promise((r) => setTimeout(r, 20));
      }
      const pending = exec(
        process.execPath,
        [cli, 'prepare', '--confirm', '--request-key', key, '--workspace', f.ws.path, '--json'],
        { env, timeout: 30000 },
      );
      void pending.catch(() => {});
      await Promise.race([
        observed,
        new Promise((_, reject) => setTimeout(() => reject(Error('checkpoint not reached: ' + errors)), 15000).unref()),
      ]);
      const canonical = readdirSync(records).filter((n) => /^[a-f0-9]{64}\.json$/.test(n)),
        before = canonical.length ? JSON.parse(readFileSync(join(records, canonical[0]!), 'utf8')) : null;
      child.kill('SIGKILL');
      await exited;
      await pending.catch(() => {});
      const reopened = await openStore(f.ws.storePath);
      const cleanup: { service?: OwnerService } = {};
      t.after(async () => {
        await cleanup.service?.stop();
        reopened.close();
      });
      const service = new OwnerService(reopened, f.ws, { registry: f.registry });
      cleanup.service = service;
      assert.ok(await service.handle('service.capabilities', {}, by));
      assert.ok(await service.handle('service.info', {}, by));
      const status: any = await service.handle('prepare.status', { requestKey: key }, by);
      if (before) {
        assert.equal(status.facts.phase, 'interrupted');
        assert.equal(status.facts.acceptedAt, before.acceptedAt);
        assert.equal(status.facts.captured, false);
      } else assert.equal(status.facts.found, false);
      for (const dir of [records, bundles])
        assert.equal(
          readdirSync(dir).filter((n) => n.startsWith('.')).length,
          0,
          'only owned inert/alias temporaries are settled',
        );
      assert.equal(
        reopened.ledger.readEvents({ after: 0, limit: 100 }).events.some((e) => e.kind === 'snapshot-admitted'),
        false,
      );
    },
  );
