// Loaded only by `mcp`. Real SDK stdio; a client of the existing owner socket, never a store owner.
// Negotiated controls dispatch to that service; its existing admission and coordinator own execution.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { STRINGS } from '@farsight/core/dist/strings.js';
import { sentinelServiceWord } from '@farsight/core/dist/strings-sentinel-service.js';
import { connectService } from './owner-service.js';
import type { Workspace } from './local.js';
import type { ServiceClient } from '../transport/ipc.js';
import { validateEnvelope } from '../validate.js';
import { OUTCOME_EXIT_CODES } from '../cli/outcome.js';
import { RUN_STATES } from '../contracts/index.js';
import { ID_PATTERN } from '../kernel/ids.js';
import { CONTROL_OPERATIONS, controlOutcome } from './controls.js';
import {
  PREPARATION_OPERATIONS,
  PREPARATION_WRITES,
  preparationCapabilities,
  configurationPreview,
  preparationOutcome,
  checkPreparationArguments,
} from './preparation-projection.js';
const id = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' };
const integer = (minimum: number, maximum: number) => ({ type: 'integer', minimum, maximum });
const tools = [
  ['sentinel_service_info', 'service.capabilities', {}, [], 'servicecapabilities'],
  ['sentinel_run_describe', 'run.describe', { runId: id }, ['runId'], null],
  ['sentinel_run_status', 'run.status', { runId: id }, ['runId'], null],
  ['sentinel_run_wait', 'run.wait', { runId: id, timeoutMs: integer(0, 25000) }, ['runId'], null],
  [
    'sentinel_run_inspect',
    'run.inspect',
    { runId: id, planRevision: integer(1, 2147483647) },
    ['runId'],
    'runinspection',
  ],
  [
    'sentinel_view_page',
    'view.page',
    {
      viewId: id,
      collection: { enum: ['works', 'attempts', 'inputs', 'outputs'] },
      workKey: id,
      attemptKey: id,
      cursor: id,
      limit: integer(1, 128),
    },
    ['viewId', 'collection'],
    'inspectionpage',
  ],
  [
    'sentinel_report_open',
    'report.open',
    { runId: id, baselineRunId: id, format: { enum: ['json', 'md', 'html', 'sarif'] } },
    ['runId', 'format'],
    'reportdelivery',
  ],
  [
    'sentinel_delivery_read',
    'delivery.read',
    { deliveryId: id, offset: integer(0, 32 * 1024 * 1024), maxBytes: integer(1, 65536) },
    ['deliveryId', 'offset'],
    'deliverychunk',
  ],
] as const;
const controls = [
  ['sentinel_run_start', 'run.start', { planId: id }, ['planId'], 'controloutcome'],
  ['sentinel_run_pause', 'run.pause', { runId: id }, ['runId'], 'controloutcome'],
  ['sentinel_run_cancel', 'run.cancel', { runId: id }, ['runId'], 'controloutcome'],
] as const;
const requestKey = { type: 'string', pattern: '^[A-Za-z0-9_-]{16,128}$' };
const preparations = [
  [
    'sentinel_configuration_preview',
    'configuration.preview',
    { requestKey, parentId: id },
    ['requestKey'],
    'configurationpreview',
  ],
  [
    'sentinel_prepare_accept',
    'prepare.accept',
    { requestKey, previewId: { type: 'string', pattern: '^prepare-preview-[a-f0-9]{32}$' } },
    ['requestKey', 'previewId'],
    'preparationoutcome',
  ],
  ['sentinel_prepare_status', 'prepare.status', { requestKey }, ['requestKey'], 'preparationoutcome'],
  ['sentinel_prepare_resume', 'prepare.resume', { requestKey }, ['requestKey'], 'preparationoutcome'],
  ['sentinel_prepare_cancel', 'prepare.cancel', { requestKey }, ['requestKey'], 'preparationoutcome'],
] as const;
const isPreparation = (op: string) => PREPARATION_OPERATIONS.includes(op as any);
const isWrite = (op: string) => CONTROL_OPERATIONS.includes(op as any) || PREPARATION_WRITES.includes(op as any);
const fail = (code: string) => Object.assign(new Error(code), { code });
const knownCode = (v: unknown) =>
  v === 'sentinel.service.unknownOperation'
    ? 'sentinel.service.operationUnavailable'
    : typeof v === 'string' && Object.hasOwn(STRINGS, v)
      ? v
      : 'sentinel.service.operationUnavailable';
/** No raw legacy events/facts/digests/diagnostics cross this new MCP metadata boundary. */
function legacyProjection(op: string, value: any): unknown {
  if (op === 'run.describe')
    return value && ['analysis', 'bootstrap'].includes(value.kind) && Number.isSafeInteger(value.revision)
      ? { kind: value.kind, revision: value.revision }
      : null;
  if (!value || !Object.hasOwn(OUTCOME_EXIT_CODES, value.outcome)) throw fail('sentinel.service.operationUnavailable');
  const state = value.facts?.state;
  return {
    outcome: value.outcome,
    exitCode: OUTCOME_EXIT_CODES[value.outcome as keyof typeof OUTCOME_EXIT_CODES],
    ...(value.reasonCode ? { reasonCode: knownCode(value.reasonCode) } : {}),
    state:
      typeof state === 'string' && [...RUN_STATES, 'interrupted', 'awaiting-first-execution'].includes(state as any)
        ? state
        : null,
  };
}
/**
 * The MCP server over stdio for this workspace: a read-and-control channel to the running owner service, never the
 * owner. Each tool forwards one operation the service's negotiated capabilities offer and returns its projection;
 * without a running service a tool answers `sentinel.service.operationUnavailable`.
 */
export async function runMcp(ws: Workspace): Promise<number> {
  let client: ServiceClient | undefined;
  const connection = async () => {
    if (!client || client.closed) {
      client = await connectService(ws, 'mcp');
      if (!client) throw fail('sentinel.service.operationUnavailable');
    }
    return client;
  };
  const capabilities = async () => {
    try {
      const value = await (await connection()).request('service.capabilities', {});
      const checked = validateEnvelope('servicecapabilities', value);
      if (!checked.ok) throw fail('sentinel.service.operationUnavailable');
      return checked.value;
    } catch {
      throw fail('sentinel.service.operationUnavailable');
    }
  };
  let initial: Awaited<ReturnType<typeof capabilities>>;
  try {
    initial = await capabilities();
  } catch {
    client?.close();
    throw fail('sentinel.service.operationUnavailable');
  }
  let negotiatedControls = false;
  try {
    const value = await (await connection()).request('service.control-capabilities', {});
    const checked = validateEnvelope('controlcapabilities', value);
    negotiatedControls =
      checked.ok && checked.value.storeId === initial.storeId && checked.value.epoch === initial.epoch;
  } catch {
    /* Older services keep their existing reads; a control negotiation grants no authority. */
  }
  let negotiatedPreparation = false;
  try {
    const offered = preparationCapabilities(await (await connection()).request('service.preparation-capabilities', {}));
    negotiatedPreparation = offered.storeId === initial.storeId && offered.epoch === initial.epoch;
  } catch {
    /* Additive negotiation never starts a service or grants permission. */
  }
  const available = [
    ...tools.filter((t) => initial.operations.includes(t[1])),
    ...(negotiatedControls ? controls : []),
    ...(negotiatedPreparation ? preparations : []),
  ];
  const server = new Server(
    { name: 'farsight-sentinel', version: '0.0.0-draft.1' },
    { capabilities: { tools: {} }, instructions: sentinelServiceWord('sentinel.service.mcpInstructions') },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: available.map(([name, op, properties, required]) => ({
      name,
      description: sentinelServiceWord(`sentinel.service.tool.${name}`),
      inputSchema: { type: 'object' as const, properties, required: [...required], additionalProperties: false },
      annotations: {
        readOnlyHint: !isWrite(op),
        destructiveHint: isWrite(op),
        idempotentHint: !isWrite(op) && !['run.inspect', 'report.open'].includes(op),
        openWorldHint: false,
      },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const tool = available.find((t) => t[0] === request.params.name);
    let controlDispatched = false,
      preparationDispatched = false;
    try {
      if (!tool) throw fail('sentinel.service.operationUnavailable');
      const args = request.params.arguments ?? {};
      // SDK advertisements are not enforcement. In particular, a client cannot smuggle an owner receipt
      // accepted by the legacy CLI socket operation through these agent-only tools.
      if (CONTROL_OPERATIONS.includes(tool[1] as any)) {
        const required = tool[3][0]!;
        if (
          !args ||
          typeof args !== 'object' ||
          Array.isArray(args) ||
          Object.keys(args).length !== 1 ||
          !Object.hasOwn(args, required) ||
          typeof args[required] !== 'string' ||
          !ID_PATTERN.test(args[required] as string)
        )
          throw fail('sentinel.service.requestInvalid');
      }
      if (isPreparation(tool[1])) checkPreparationArguments(tool[1], args);
      // This tool deliberately returns status only; the legacy CLI retains its separate event pagination.
      if (tool[1] === 'run.status' && Object.keys(args).some((k) => k !== 'runId'))
        throw fail('sentinel.service.requestInvalid');
      const connected = await connection();
      if (CONTROL_OPERATIONS.includes(tool[1] as any)) {
        // Reconnect can reach an older service. Never replay a mutation or assume its old negotiation survives.
        const offered = validateEnvelope(
          'controlcapabilities',
          await connected.request('service.control-capabilities', {}),
        );
        if (!offered.ok || offered.value.storeId !== initial.storeId || offered.value.storeId !== connected.storeId)
          throw fail('sentinel.service.operationUnavailable');
      }
      if (isPreparation(tool[1])) {
        const offered = preparationCapabilities(await connected.request('service.preparation-capabilities', {}));
        if (offered.storeId !== initial.storeId || offered.storeId !== connected.storeId)
          throw fail('sentinel.service.operationUnavailable');
      }
      if (PREPARATION_WRITES.includes(tool[1] as any)) {
        if (extra.signal.aborted) throw fail('sentinel.ipc.canceled');
        preparationDispatched = true;
      }
      if (CONTROL_OPERATIONS.includes(tool[1] as any)) {
        if (extra.signal.aborted) throw fail('sentinel.ipc.canceled');
        controlDispatched = true;
      }
      const value = await connected.request(tool[1], args, { signal: extra.signal, timeoutMs: 30000 });
      let safe: unknown;
      if (tool[4]) {
        const checked = validateEnvelope(
          tool[4],
          tool[4] === 'controloutcome'
            ? controlOutcome(value)
            : tool[4] === 'preparationoutcome'
              ? preparationOutcome(value)
              : tool[4] === 'configurationpreview'
                ? configurationPreview(value)
                : value,
        );
        if (!checked.ok) throw fail('sentinel.service.operationUnavailable');
        safe = checked.value;
      } else safe = legacyProjection(tool[1], value);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(safe) }],
        ...(safe && typeof safe === 'object' ? { structuredContent: safe as Record<string, unknown> } : {}),
      };
    } catch (error) {
      const code = preparationDispatched
          ? 'sentinel.preparation.outcomeUnknown'
          : controlDispatched
            ? 'sentinel.service.controlOutcomeUnknown'
            : knownCode((error as any)?.code),
        retryable = [
          'sentinel.service.viewChanged',
          'sentinel.report.viewChanged',
          'sentinel.service.deliveryBusy',
          'sentinel.service.inspectBusy',
        ].includes(code);
      const safe = { error: { code, retryable } };
      return {
        isError: true,
        content: [{ type: 'text' as const, text: sentinelServiceWord(code) }],
        structuredContent: safe,
      };
    }
  });
  const ended = new Promise<void>((resolve) => {
    server.onclose = () => {
      client?.close();
      resolve();
    };
  });
  const onEnd = () => {
    void server.close();
  };
  process.stdin.once('end', onEnd);
  try {
    await server.connect(new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 1024 * 1024 }));
    await ended;
    return 0;
  } finally {
    process.stdin.removeListener('end', onEnd);
    client?.close();
  }
}
