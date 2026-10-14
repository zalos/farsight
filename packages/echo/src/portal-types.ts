import type { Counted } from '@farsight/core/dist/counts.js';
import type { EchoProfile } from './types.js';
import type { ExpandResult, ResearchMemory, ResearchStore, SubmindResult } from './submind-types.js';

export interface PortalBrowseInput { query?: string; since?: string; until?: string; cursor?: string }
export interface PortalMemory extends ResearchMemory { /** Actual saved concepts only; never inferred. */ topics?: string[] }
export interface PortalBrowseResult {
  schema: 'echo-portal/v1';
  profileId: string;
  identity: EchoProfile['identity'];
  query: string;
  since: string | null;
  until: string | null;
  memories: PortalMemory[];
  nextCursor: string | null;
  exhaustive: boolean;
  truncated: boolean;
  counts: { shown: Counted };
}
export interface PortalCallbacks {
  browse(input: PortalBrowseInput, signal?: AbortSignal): Promise<PortalBrowseResult>;
  expand(input: { id: string; revision: string }, signal?: AbortSignal): Promise<ExpandResult>;
  ask(input: { query: string }, signal?: AbortSignal): Promise<SubmindResult>;
}
/** Internal transport contract: continuation is owned by the pinned backend, not a browser. */
export interface ResearchCatalog extends ResearchStore {
  browse(input: { query: string; since: string | null; until: string | null; cursor?: string }, signal?: AbortSignal): Promise<{
    memories: PortalMemory[]; nextCursor: string | null; exhaustive: boolean; truncated: boolean;
  }>;
}
