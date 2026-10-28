// Copilot receives one piped, role-tagged prompt, not native role/system APIs. Vendor hidden instructions stay unobserved.
import { canonicalJsonBytes } from '../../store/objects.js';
import type { ChatMessage, ParsedReply } from './kinds.js';
import { fail, NativeCopilotError, type NativeCopilotDiagnostic, type ProviderErrorCode } from './errors.js';
import type { NativeReviewWire } from '../../contracts/instructions.js';
export function renderNativeCopilotWire(
  model: string,
  messages: readonly ChatMessage[],
  maxOutputTokens: number,
): NativeReviewWire {
  if (messages.length < 2 || messages[0]?.role !== 'system' || messages.slice(1).some((m) => m.role === 'system'))
    return fail(
      'sentinel.provider.invalidProfile',
      'Copilot wire requires exactly one leading Sentinel system message',
    );
  return Object.freeze({
    encoding: 'sentinel-copilot-chat/v1',
    system: messages[0].content,
    stdin: Buffer.from(
      canonicalJsonBytes({
        encoding: 'sentinel-copilot-chat/v1',
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        requestedMaxOutputTokens: maxOutputTokens,
      }),
    ).toString('utf8'),
    requestedModel: model,
  });
}
const obj = (v: unknown): Record<string, any> | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : undefined;
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
/** Pinned silent stdout is rendered visible text, not an event/session protocol. Caller requires clean process completion. */
export class NativeCopilotDecoder {
  #pending = Buffer.alloc(0);
  #total = 0;
  constructor(
    readonly maxBytes: number,
    readonly requestedModel: string,
  ) {}
  get bytes() {
    return this.#total;
  }
  observation() {
    return Object.freeze({
      bytes: this.#total,
      frames: 0,
      eventClass: this.#total ? ('visible' as const) : ('none' as const),
    });
  }
  #bad(
    reason: NativeCopilotDiagnostic['reason'],
    code: ProviderErrorCode = 'sentinel.provider.malformedResponse',
  ): never {
    throw new NativeCopilotError(code, 'possible', {
      schema: 'sentinel-copilot-failure/1',
      phase: reason.startsWith('usage-') ? 'usage' : 'stream',
      reason,
      exitCode: null,
      signal: null,
      eventClass: this.#total ? 'visible' : 'none',
      frames: 0,
      stdoutBytes: this.#total,
      stderrBytes: 0,
      connections: 0,
      upstreamBytes: 0,
      downstreamBytes: 0,
      proxyEnded: 'open',
    });
  }
  push(chunk: Uint8Array) {
    this.#total += chunk.byteLength;
    if (this.#total > this.maxBytes) this.#bad('response-bound', 'sentinel.provider.responseTooLarge');
    this.#pending = Buffer.concat([this.#pending, chunk]);
  }
  finish(usageBytes: Uint8Array): ParsedReply {
    if (this.#total + usageBytes.byteLength > this.maxBytes)
      this.#bad('response-bound', 'sentinel.provider.responseTooLarge');
    let content: string;
    try {
      content = new TextDecoder('utf8', { fatal: true, ignoreBOM: true }).decode(this.#pending);
    } catch {
      this.#bad('visible-message');
    }
    // Preserve rendered bytes as text; only one conventional final LF is removed. Never repair/strip terminal escapes.
    if (content!.endsWith('\n')) content = content!.slice(0, -1);
    // eslint-disable-next-line no-control-regex -- Visible Copilot messages reject control bytes while allowing tabs and line breaks.
    if (!content!.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(content!))
      this.#bad('visible-message');
    let metrics: Record<string, any> | undefined;
    try {
      metrics = obj(JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(usageBytes)));
    } catch {
      this.#bad('usage-shape');
    }
    const models = obj(metrics?.modelMetrics),
      names = models ? Object.keys(models) : [];
    if (
      names.length !== 1 ||
      names[0] !== this.requestedModel ||
      (metrics?.currentModel !== undefined && metrics.currentModel !== this.requestedModel) ||
      metrics?.totalUserRequests !== 1
    )
      this.#bad('usage-model', 'sentinel.provider.identityMismatch');
    const model = obj(models![names[0]!]),
      requests = obj(model?.requests),
      u = obj(model?.usage);
    if (
      requests?.count !== 1 ||
      !u ||
      ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'].some((k) => !count(u[k]))
    )
      this.#bad('usage-count');
    // Vendor total is preserved; cache counters are not assumed disjoint. Usage is not an audit of hidden activity.
    return {
      content: content!,
      returnedModel: names[0]!,
      usage: { inputTokens: u!.inputTokens, outputTokens: u!.outputTokens },
      finish: 'complete',
    };
  }
}

// Exact fixed pinned1.0.103 startup template. Compare streaming bytes; never collect or retain native stderr.
const noAuthTemplate = Buffer.from(
  "Error: No authentication information found.\n\nCopilot can be authenticated with GitHub using an OAuth Token or a Fine-Grained Personal Access Token.\n\nTo authenticate, you can use any of the following methods:\n  • Start 'copilot' and run the '/login' command\n  • Set the COPILOT_GITHUB_TOKEN, GH_TOKEN, or GITHUB_TOKEN environment variable\n  • Run 'gh auth login' to authenticate with the GitHub CLI\n",
  'utf8',
);
export class NativeCopilotStderrClassifier {
  #at = 0;
  #equal = true;
  push(bytes: Uint8Array): void {
    for (const byte of bytes) {
      if (this.#at >= noAuthTemplate.length || byte !== noAuthTemplate[this.#at]) this.#equal = false;
      this.#at = Math.min(4097, this.#at + 1);
    }
  }
  get noAuthenticationInformation(): boolean {
    return this.#equal && this.#at === noAuthTemplate.length;
  }
}
