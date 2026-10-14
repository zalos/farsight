import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ECHO_DEMO_STRINGS } from '@farsight/core/dist/strings-echo-demo.js';
import { echoSubmindWord } from '@farsight/core/dist/strings-echo-submind.js';
import { defaultConfig, loadContext, saveConfig } from './config.js';
import { startMemoryBridge, memoryRequest } from './memory.js';
import { createMemoryPortal } from './portal.js';
import { startWeb } from './web.js';
import type { PortalMemory, ResearchCatalog } from './portal-types.js';

const word = (key: string) => ECHO_DEMO_STRINGS[`echo.demo.${key}`]!.professional;
let demoActive = false;
/** Isolated synthetic preview: no runtime startup, endpoint discovery, real memories or generation. */
export async function startPortalDemo(port = 4491): Promise<{ url: string; close(): Promise<void> }> {
  if (demoActive || !Number.isInteger(port) || port !== 0 && (port < 1024 || port > 65535)) throw new Error(echoSubmindWord('input'));
  demoActive = true;
  const previousState = process.env.XDG_STATE_HOME;
  let directory: string | undefined;
  let web: Awaited<ReturnType<typeof startWeb>> | undefined;
  let bridge: Awaited<ReturnType<typeof startMemoryBridge>> | undefined;
  let closed = false;
  const close = async () => {
    if (closed) return; closed = true;
    try { await web?.close(); await bridge?.close(); }
    finally {
      if (directory) await rm(directory, { recursive: true, force: true });
      if (previousState === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previousState;
      demoActive = false;
    }
  };
  try {
    directory = await mkdtemp(join(tmpdir(), 'echo-portal-demo-'));
    // This process owns a disposable trust registry. Nothing is enrolled in the user's real state.
    process.env.XDG_STATE_HOME = join(directory, 'state');
    const config = defaultConfig();
    const profile = config.profiles.personal!;
    config.profiles = { personal: profile };
    profile.identity = { individual: 'example-person', project: 'synthetic-preview' };
    profile.submind!.mode = 'mock';
    profile.budget.briefMaxChars = 2400;
    profile.web.port = port || 4491;
    const configPath = join(directory, 'settings.json');
    await saveConfig(configPath, config);
    const ctx = loadContext(configPath);
    ctx.profile.web.port = port;
    const keys = ['cold', 'duplicate', 'build', 'handoff', 'container', 'search'];
    const topics = [['shipping', 'cold-storage'], ['shipping', 'reliability'], ['release', 'testing'], ['team', 'decisions'], ['shipping', 'cold-storage'], ['memory', 'search']];
    const ages = [0, 0, 1, 2, 5, 10];
    const records: PortalMemory[] = keys.map((key, index) => {
      const title = word(`${key}Title`), content = word(key);
      const timestamp = new Date(Date.now() - ages[index]! * 86400000 - index * 60000).toISOString();
      return { id: `synthetic_${key}`, revision: createHash('sha256').update(JSON.stringify([key, title, content, timestamp])).digest('hex'), title, content, timestamp, truncated: false, topics: topics[index],
        ...(index < 3 ? { provenance: { workspace: `/workspace/example/${index === 2 ? 'release' : 'shipping'}`, commit: 'a'.repeat(40), savedAt: timestamp } } : {}) };
    });
    const matched = (query: string) => records.filter(record => `${record.title} ${record.content} ${record.topics?.join(' ')}`.toLowerCase().includes(query.toLowerCase()));
    const clipped = (record: PortalMemory, max: number): PortalMemory => {
      const title = record.title.slice(0, Math.min(240, Math.floor(max / 3)));
      const content = record.content.slice(0, Math.max(0, max - title.length));
      return { ...record, title, content, truncated: title !== record.title || content !== record.content };
    };
    const store: ResearchCatalog = {
      async browse(input, signal) {
        signal?.throwIfAborted();
        const offset = input.cursor ? Number(Buffer.from(input.cursor, 'base64url').toString()) : 0;
        if (!Number.isSafeInteger(offset) || offset < 0) throw new Error(echoSubmindWord('input'));
        const all = matched(input.query);
        const batch = all.slice(offset, offset + 3);
        const memories = batch.filter(row => (!input.since || row.timestamp >= input.since) && (!input.until || row.timestamp <= input.until)).map(row => clipped(row, 700));
        return { memories, nextCursor: offset + 3 < all.length ? Buffer.from(String(offset + 3)).toString('base64url') : null, exhaustive: false, truncated: memories.some(row => row.truncated) };
      },
      async search(input, signal) {
        signal?.throwIfAborted();
        const all = matched(input.query).filter(row => row.timestamp >= input.since);
        const selected = all.slice(0, input.limit);
        const memories = selected.map(row => clipped(row, Math.floor(input.maxChars / Math.max(1, selected.length))));
        return { memories, inspected: selected.length, truncated: all.length > memories.length || memories.some(row => row.truncated), exhaustive: false };
      },
      async read(input, signal) {
        signal?.throwIfAborted();
        const memory = records.find(row => row.id === input.id);
        return memory ? { status: memory.revision === input.revision ? 'ready' : 'changed', memory: clipped(memory, input.maxChars) } : { status: 'missing' };
      },
    };
    const connection = { url: 'http://127.0.0.1:1', secret: 'synthetic-unused', close: async () => {} };
    bridge = await startMemoryBridge(ctx, connection, { store, generate: async () => { throw new Error('Synthetic preview cannot generate'); } });
    web = await startWeb(ctx, { demo: true, portal: {
      ...createMemoryPortal(ctx, connection, store),
      ask: (input, signal) => memoryRequest(ctx, 'ask', input, { signal }),
      expand: (input, signal) => memoryRequest(ctx, 'expand', input, { signal }),
    } });
    return { url: web.url, close };
  } catch (error) { await close(); throw error; }
}
