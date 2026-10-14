import type { EchoProfile } from './types.js';
import type { SubmindModelRequest, SubmindModelResponse } from './submind-types.js';

/** Setup actions read the saved profile; the browser never supplies a provider request. */
export interface ModelSetupDependencies {
  list?: (profile: EchoProfile, options: { signal?: AbortSignal }) => Promise<string[]>;
  generate?: (profile: EchoProfile, request: SubmindModelRequest) => Promise<SubmindModelResponse>;
}

export interface ModelSetupIdentity {
  schema: 'echo-model-setup/v1';
  profileId: string;
  provider: EchoProfile['model']['provider'];
  origin: string;
  model: string;
}
export interface ModelDiscoveryResult extends ModelSetupIdentity {
  status: 'ready' | 'unsupported';
  models: string[];
  truncated: boolean;
}
export interface ModelTestResult extends ModelSetupIdentity {
  status: 'ready';
  usage: { modelCalls: 1; inputTokens: number | null; outputTokens: number | null };
  elapsedMs: number;
}
