import type { SubmindSettings } from './submind-types.js';

/** Versioned setup contract. Identity labels are local routing metadata, not team authorization. */
export interface EchoConfig {
  version: 1;
  defaultProfile: string;
  profiles: Record<string, EchoProfile>;
}

/** Native Ollama resource limits; character budgets remain separate from model token capacity. */
export interface OllamaSettings {
  contextTokens: number;
  keepAliveSeconds: number;
}

export interface EchoProfile {
  identity: { individual: string; team?: string; project: string };
  backend: { mode: 'managed' | 'external'; url: string; secretRef?: string };
  model: { provider: 'ollama' | 'openai-compatible'; baseUrl: string; model: string; secretRef?: string; allowInsecureHttp?: boolean; ollama?: OllamaSettings };
  submind?: SubmindSettings;
  web: { port: number; farsightOrigin?: string };
  hooks: { claude: boolean; codex: boolean; vscode?: boolean };
  skills: { directories: string[] };
  budget: { briefMaxChars: number; modelMaxTokens: number; timeoutMs: number };
}

export interface EchoContext {
  configPath: string;
  config: EchoConfig;
  profileId: string;
  profile: EchoProfile;
  /** Memory stores live here; trust receipts and the executable cache are user-owned elsewhere. */
  directory: string;
  dataDirectory: string;
}

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

export interface BackendConnection {
  url: string;
  secret: string;
  /** Closes only processes this instance owns. External connections are never stopped. */
  close(): Promise<void>;
}
