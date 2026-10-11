/** Versioned setup contract. Identity labels are local routing metadata, not team authorization. */
export interface EchoConfig {
  version: 1;
  defaultProfile: string;
  profiles: Record<string, EchoProfile>;
}

export interface EchoProfile {
  identity: { individual: string; team?: string; project: string };
  backend: { mode: 'managed' | 'external'; url: string; secretRef?: string };
  model: { provider: 'ollama' | 'openai-compatible'; baseUrl: string; model: string; secretRef?: string };
  web: { port: number; farsightOrigin?: string };
  hooks: { claude: boolean; codex: boolean };
  skills: { directories: string[] };
  budget: { briefMaxChars: number; modelMaxTokens: number; timeoutMs: number };
}

export interface EchoContext {
  configPath: string;
  config: EchoConfig;
  profileId: string;
  profile: EchoProfile;
  /** All state lives next to this local, ignored configuration file. */
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
