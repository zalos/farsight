// Provider registry — the shape of parsers/src/index.ts's adapters array.
// packages/work cannot import its own plugins (they depend on it), so the
// consumer (CLI, server, MCP) registers the providers it ships at start-up.
// A provider is one directory and one registerProvider() line.
import type { WorkProvider } from './provider.js';

const providers = new Map<string, WorkProvider>();

export function registerProvider(p: WorkProvider): void {
  providers.set(p.id, p);
}

export function providerFor(id: string): WorkProvider | undefined {
  return providers.get(id);
}

export function listProviders(): string[] {
  return [...providers.keys()].sort();
}
