import { createHash } from 'node:crypto';
import { echoSubmindWord } from '@farsight/core/dist/strings-echo-submind.js';
import { defaultConfig, submindSettings } from './config.js';
import { research, expandMemory } from './submind.js';
import type { ResearchMemory, ResearchStore } from './submind-types.js';

/** Deliberately has no configuration, socket, network, runtime or persistence dependency. */
export async function submindDemo(query = echoSubmindWord('demoQuestion')) {
  const profile = defaultConfig().profiles.personal!;
  profile.submind = { ...submindSettings(profile), mode: 'mock' };
  const memory: ResearchMemory = {
    id: 'synthetic_cold_shipping',
    title: echoSubmindWord('demoTitle'),
    content: echoSubmindWord('demoContent'),
    revision: createHash('sha256').update(echoSubmindWord('demoContent')).digest('hex'),
    timestamp: new Date().toISOString(),
    truncated: false,
  };
  const store: ResearchStore = {
    async search() {
      return { memories: [memory], inspected: 1, truncated: false, exhaustive: false };
    },
    async read(input) {
      if (input.id !== memory.id) return { status: 'missing' };
      return { status: input.revision === memory.revision ? 'ready' : 'changed', memory: { ...memory } };
    },
  };
  const brief = await research(profile, store, { query });
  const action = brief.actions[0];
  return {
    synthetic: true,
    brief,
    ...(action ? { expanded: await expandMemory(profile, store, action.arguments) } : {}),
  };
}
