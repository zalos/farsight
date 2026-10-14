import type { MemoryProvenance } from './memory-provenance.js';

/** Read-only, request-bounded research. Absent settings retain the existing raw-recall behavior. */
export interface SubmindSettings {
  mode: 'off' | 'mock' | 'model';
  /** Explicit opt-in to research after each host prompt; old profiles keep manual lookup. */
  hookResearch: 'manual' | 'background';
  maxSteps: number;
  maxSearches: number;
  maxCandidates: number;
  evidenceMaxChars: number;
  inputMaxChars: number;
  lookbackDays: number;
  timeoutMs: number;
  expandedMaxChars: number;
}

export interface ResearchMemory {
  id: string;
  /** A content-bound revision, not a promise that the backend retains historical versions. */
  revision: string;
  title: string;
  content: string;
  timestamp: string;
  provenance?: MemoryProvenance;
  truncated: boolean;
}
export interface ResearchSearch {
  memories: ResearchMemory[];
  truncated: boolean;
  /** This backend ranks a bounded global set before exact scope filtering. */
  exhaustive: false;
  inspected: number;
}
export interface ResearchStore {
  search(input: { query: string; limit: number; maxChars: number; since: string }, signal?: AbortSignal): Promise<ResearchSearch>;
  read(input: { id: string; revision: string; maxChars: number }, signal?: AbortSignal): Promise<{ status: 'ready' | 'changed' | 'missing'; memory?: ResearchMemory }>;
}
export interface ModelMessage { role: 'system' | 'user' | 'assistant'; content: string }
export interface SubmindModelRequest {
  messages: ModelMessage[];
  schema: Record<string, unknown>;
  signal?: AbortSignal;
  maxOutputTokens?: number;
}
export interface SubmindModelResponse {
  content: unknown;
  model: string;
  finishReason: string;
  usage: { inputTokens: number | null; outputTokens: number | null };
}
export interface SubmindCitation {
  id: string;
  revision: string;
  /** Echo attaches source metadata from the inspected record, never from model output. */
  title?: string;
  timestamp?: string;
  provenance?: MemoryProvenance;
}
export interface SubmindFinding {
  problem: string;
  fix: string;
  why: string | null;
  citations: SubmindCitation[];
}
export interface ExpandAction {
  rel: 'read_more';
  operation: 'memory.expand';
  arguments: SubmindCitation;
}
export interface SubmindResult {
  schema: 'echo-memory/v1';
  requestId: string;
  status: 'ready' | 'partial' | 'empty' | 'disabled' | 'unavailable';
  mode: SubmindSettings['mode'];
  findings: SubmindFinding[];
  actions: ExpandAction[];
  coverage: {
    exhaustive: false;
    since: string;
    inspected: number;
    stopReason: 'complete' | 'no_matches' | 'disabled' | 'budget' | 'timeout' | 'model_unavailable' | 'invalid_response' | 'store_unavailable';
    truncated: boolean;
  };
  usage: {
    modelCalls: number;
    searches: number;
    evidenceChars: number;
    inputChars: number;
    inputTokens: number | null;
    outputTokens: number | null;
    elapsedMs: number;
  };
}
export interface ExpandResult {
  schema: 'echo-memory/v1';
  status: 'ready' | 'changed' | 'missing';
  memory?: ResearchMemory;
  actions: ExpandAction[];
}
