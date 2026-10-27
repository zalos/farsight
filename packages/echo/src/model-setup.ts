import { ECHO_UI_STRINGS } from '@farsight/core/dist/strings-echo-ui.js';
import { validateModelSettings } from './config.js';
import { generateSubmind, listModels } from './models.js';
import { ModelBusyError, withModelOperation } from './model-gate.js';
import type { EchoProfile } from './types.js';
import type {
  ModelDiscoveryResult,
  ModelSetupDependencies,
  ModelSetupIdentity,
  ModelTestResult,
} from './model-setup-types.js';

export class ModelSetupFailure extends Error {
  constructor(readonly code: 'failed' | 'invalid_response' | 'timeout' | 'busy') {
    super(code);
  }
}

export function modelSetupMessage(error: ModelSetupFailure): string {
  const keys = {
    failed: 'modelSetupFailed',
    invalid_response: 'modelSetupInvalidResponse',
    timeout: 'modelSetupTimeout',
    busy: 'modelSetupBusy',
  };
  return ECHO_UI_STRINGS[`echo.ui.${keys[error.code]}`]!.professional;
}

function identity(profileId: string, profile: EchoProfile): ModelSetupIdentity {
  const model = validateModelSettings(profile.model);
  return {
    schema: 'echo-model-setup/v1',
    profileId,
    provider: model.provider,
    origin: new URL(model.baseUrl).origin,
    model: model.model,
  };
}
function failure(error: unknown): ModelSetupFailure {
  return new ModelSetupFailure(
    error instanceof ModelBusyError
      ? 'busy'
      : error instanceof Error && error.name === 'TimeoutError'
        ? 'timeout'
        : 'failed',
  );
}
function tokens(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Discovery is explicit, bounded metadata only, and cannot generate or download a model. */
export async function discoverSetupModels(
  profileId: string,
  profile: EchoProfile,
  signal: AbortSignal,
  dependencies: ModelSetupDependencies = {},
): Promise<ModelDiscoveryResult> {
  signal.throwIfAborted();
  const selected = identity(profileId, profile);
  if (selected.provider !== 'ollama') return { ...selected, status: 'unsupported', models: [], truncated: false };
  let names: string[];
  try {
    names = await (dependencies.list ?? listModels)(profile, { signal });
  } catch (error) {
    throw failure(error);
  }
  signal.throwIfAborted();
  if (
    !Array.isArray(names) ||
    names.some((name) => typeof name !== 'string' || !name.trim() || name.length > 256 || /[\x00-\x1f\x7f]/.test(name))
  )
    throw new ModelSetupFailure('invalid_response');
  const unique = [...new Set(names)].sort();
  return { ...selected, status: 'ready', models: unique.slice(0, 256), truncated: unique.length > 256 };
}

/** Exactly one generation over fixed synthetic evidence; no memory store or user prompt is read. */
export async function testSetupModel(
  profileId: string,
  profile: EchoProfile,
  signal: AbortSignal,
  dependencies: ModelSetupDependencies = {},
): Promise<ModelTestResult> {
  signal.throwIfAborted();
  const selected = identity(profileId, profile);
  const started = performance.now();
  let response;
  try {
    response = await withModelOperation(() =>
      (dependencies.generate ?? generateSubmind)(profile, {
        messages: [
          { role: 'system', content: ECHO_UI_STRINGS['echo.ui.modelSetupPrompt']!.professional },
          { role: 'user', content: ECHO_UI_STRINGS['echo.ui.modelSetupEvidence']!.professional },
        ],
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['status', 'evidenceId'],
          properties: {
            status: { type: 'string', enum: ['ready'] },
            evidenceId: { type: 'string', enum: ['echo-model-test'] },
          },
        },
        maxOutputTokens: profile.budget.modelMaxTokens,
        signal,
      }),
    );
  } catch (error) {
    throw failure(error);
  }
  signal.throwIfAborted();
  const value = response.content;
  if (
    response.finishReason !== 'stop' ||
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== 2 ||
    !Object.hasOwn(value, 'status') ||
    !Object.hasOwn(value, 'evidenceId') ||
    (value as Record<string, unknown>).status !== 'ready' ||
    (value as Record<string, unknown>).evidenceId !== 'echo-model-test'
  )
    throw new ModelSetupFailure('invalid_response');
  // Identity always comes from trusted saved settings, never a provider's model/response fields.
  return {
    ...selected,
    status: 'ready',
    usage: {
      modelCalls: 1,
      inputTokens: tokens(response.usage?.inputTokens),
      outputTokens: tokens(response.usage?.outputTokens),
    },
    elapsedMs: Math.max(0, Math.round(performance.now() - started)),
  };
}
