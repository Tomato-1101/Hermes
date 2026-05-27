/**
 * Typed IPC contract shared between Main and Renderer.
 *
 * Each channel is one zod schema. Renderer calls `invoke(channel, args)`, the
 * Main process validates with the schema before dispatching.
 */
import { z } from 'zod';

export const IpcChannels = {
  ping: 'app:ping',
  appInfo: 'app:info',
  sidecarPing: 'sidecar:ping',
  permissionStatus: 'permission:status',
  permissionPrompt: 'permission:prompt',
  openSettingsPane: 'permission:openSettings',
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

export const IpcContract = {
  [IpcChannels.ping]: { args: PingArgs, result: PingResult },
  [IpcChannels.appInfo]: { args: z.void(), result: AppInfoResult },
  [IpcChannels.sidecarPing]: { args: z.void(), result: SidecarPingResult },
  [IpcChannels.permissionStatus]: { args: z.void(), result: PermissionStatusResult },
  [IpcChannels.openSettingsPane]: { args: OpenSettingsArgs, result: OpenSettingsResult },
} as const;
