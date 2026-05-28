/**
 * Typed IPC contract shared between Main and Renderer.
 *
 * Each channel is one zod schema. Renderer calls `invoke(channel, args)`, the
 * Main process validates with the schema before dispatching.
 *
 * One-way pushes from Main → Renderer use `'hermes:event'` with an
 * `EventPush` payload.
 */
import { z } from 'zod';

export const IpcChannels = {
  // System
  ping: 'app:ping',
  appInfo: 'app:info',
  sidecarPing: 'sidecar:ping',
  permissionStatus: 'permission:status',
  openSettingsPane: 'permission:openSettings',
  // Flow lifecycle
  flowList: 'flow:list',
  flowCreate: 'flow:create',
  flowOpen: 'flow:open',
  flowSave: 'flow:save',
  // Recorder
  recorderStart: 'recorder:start',
  recorderStop: 'recorder:stop',
  // Runner
  runStart: 'run:start',
  runStop: 'run:stop',
  // Vault
  vaultList: 'vault:list',
  vaultSet: 'vault:set',
  vaultDelete: 'vault:delete',
  // Event push channel name (renderer subscribes via ipcRenderer.on)
  eventPush: 'hermes:event',
} as const;

export type IpcChannel = (typeof IpcChannels)[keyof typeof IpcChannels];

// --- ping ---
export const PingArgs = z.object({ message: z.string().optional() });
export const PingResult = z.object({ pong: z.literal(true), echo: z.string() });

// --- app:info ---
export const AppInfoResult = z.object({
  name: z.string(),
  version: z.string(),
  electron: z.string(),
  node: z.string(),
  platform: z.string(),
  arch: z.string(),
});

// --- sidecar:ping ---
export const SidecarPingResult = z.object({
  ok: z.boolean(),
  reply: z.string().optional(),
  latencyMs: z.number().optional(),
  error: z.string().optional(),
});

// --- permission:status ---
export const PermissionName = z.enum([
  'accessibility',
  'screen-recording',
  'input-monitoring',
  'automation',
]);
export type PermissionName = z.infer<typeof PermissionName>;

export const PermissionStatusResult = z.object({
  required: z.array(PermissionName),
  missing: z.array(PermissionName),
  granted: z.array(PermissionName),
});

// --- permission:openSettings ---
export const OpenSettingsArgs = z.object({ pane: PermissionName });
export const OpenSettingsResult = z.object({ opened: z.boolean() });

// --- flow types ---
// The renderer doesn't get the IR validated zod-side (the IR ships its own
// ajv schema in @hermes/ir). We pass it through as an opaque JSON record.
const JsonValue: z.ZodType<unknown> = z.unknown();
const FlowSchema = z.object({
  schemaVersion: z.string(),
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  inputs: z.array(JsonValue),
  outputs: z.array(JsonValue),
  variables: z.array(JsonValue),
  defaults: JsonValue,
  steps: z.array(JsonValue),
  metadata: JsonValue,
});

export const FlowSummary = z.object({
  id: z.string(),
  name: z.string(),
  updatedAt: z.string(),
  stepCount: z.number(),
});
export const FlowListResult = z.object({ flows: z.array(FlowSummary) });

export const FlowCreateArgs = z.object({
  name: z.string().min(1).max(128),
});
export const FlowCreateResult = z.object({ flow: FlowSchema });

export const FlowOpenArgs = z.object({ id: z.string() });
export const FlowOpenResult = z.object({ flow: FlowSchema });

export const FlowSaveArgs = z.object({ flow: FlowSchema });
export const FlowSaveResult = z.object({ ok: z.literal(true) });

// --- recorder ---
// startUrl is validated leniently here so the renderer doesn't have to ship a
// URL parser to its prompt; the controller does the actual normalization
// (prepending https:// if missing) before handing it to Playwright.
// `layer` chooses between the Playwright-based web recorder and the
// CGEventTap-based desktop recorder; defaults to 'web'.
export const RecorderStartArgs = z.object({
  flowId: z.string(),
  startUrl: z.string().min(1).optional(),
  layer: z.enum(['web', 'desktop']).optional(),
});
export const RecorderStartResult = z.object({ ok: z.literal(true) });

export const RecorderStopArgs = z.void();
export const RecorderStopResult = z.object({ ok: z.literal(true) });

// --- runner ---
export const RunStartArgs = z.object({
  flowId: z.string(),
  inputs: z.record(z.unknown()).optional(),
});
export const RunStartResult = z.object({ runId: z.string() });

export const RunStopArgs = z.void();
export const RunStopResult = z.object({ ok: z.literal(true) });

// --- vault ---
export const VaultListResult = z.object({
  entries: z.array(z.object({ account: z.string() })),
});

export const VaultSetArgs = z.object({
  account: z.string().min(1).max(256),
  value: z.string(),
});
export const VaultSetResult = z.object({ ok: z.literal(true) });

export const VaultDeleteArgs = z.object({ account: z.string().min(1).max(256) });
export const VaultDeleteResult = z.object({ deleted: z.boolean() });

// --- push events (Main → Renderer) ---
export const EventPush = z.discriminatedUnion('type', [
  z.object({ type: z.literal('recorder:step'), step: JsonValue }),
  z.object({ type: z.literal('recorder:state'), running: z.boolean() }),
  z.object({ type: z.literal('run:start'), flowId: z.string(), runId: z.string() }),
  z.object({
    type: z.literal('run:end'),
    flowId: z.string(),
    runId: z.string(),
    outcome: z.enum(['success', 'failure', 'aborted']),
  }),
  z.object({
    type: z.literal('run:step'),
    cursor: z.string(),
    stepId: z.string(),
    phase: z.enum(['start', 'end']),
    outcome: z.string().optional(),
    error: z.string().optional(),
  }),
  z.object({
    type: z.literal('log'),
    level: z.enum(['debug', 'info', 'warn', 'error']),
    message: z.string(),
  }),
]);
export type EventPushPayload = z.infer<typeof EventPush>;

export const IpcContract = {
  [IpcChannels.ping]: { args: PingArgs, result: PingResult },
  [IpcChannels.appInfo]: { args: z.void(), result: AppInfoResult },
  [IpcChannels.sidecarPing]: { args: z.void(), result: SidecarPingResult },
  [IpcChannels.permissionStatus]: { args: z.void(), result: PermissionStatusResult },
  [IpcChannels.openSettingsPane]: { args: OpenSettingsArgs, result: OpenSettingsResult },
  [IpcChannels.flowList]: { args: z.void(), result: FlowListResult },
  [IpcChannels.flowCreate]: { args: FlowCreateArgs, result: FlowCreateResult },
  [IpcChannels.flowOpen]: { args: FlowOpenArgs, result: FlowOpenResult },
  [IpcChannels.flowSave]: { args: FlowSaveArgs, result: FlowSaveResult },
  [IpcChannels.recorderStart]: { args: RecorderStartArgs, result: RecorderStartResult },
  [IpcChannels.recorderStop]: { args: RecorderStopArgs, result: RecorderStopResult },
  [IpcChannels.runStart]: { args: RunStartArgs, result: RunStartResult },
  [IpcChannels.runStop]: { args: RunStopArgs, result: RunStopResult },
  [IpcChannels.vaultList]: { args: z.void(), result: VaultListResult },
  [IpcChannels.vaultSet]: { args: VaultSetArgs, result: VaultSetResult },
  [IpcChannels.vaultDelete]: { args: VaultDeleteArgs, result: VaultDeleteResult },
} as const;
