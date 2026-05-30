/**
 * Sidecar JSON-RPC contract — the single source of truth for the wire
 * protocol between the TS desktop adapter and the native sidecar
 * (macOS Swift today, Windows .NET later).
 *
 * Why this exists (Phase-1 groundwork A1): the contract used to live only
 * as ad-hoc `as` casts scattered across `macos.ts` and the Swift dispatch
 * table in `main.swift`. That made it possible for the two sides to drift
 * — a renamed param or a changed result shape would surface as a confusing
 * runtime failure, or worse, as a flow that "replays" differently on
 * Windows than it recorded on macOS. Pinning method names, params, results,
 * the coordinate-system convention and the key-name convention in one
 * zod-validated place is what protects the project's bit-for-bit
 * reproduction guarantee when the Windows sidecar is written against the
 * same contract.
 *
 * Conventions encoded here:
 *  - Coordinates (mouse.*, accessibility.elementAtPoint, screen regions) are
 *    SCREEN-ABSOLUTE, origin TOP-LEFT, in LOGICAL POINTS (not physical
 *    pixels). This matches CGEvent's Quartz space on macOS; the Windows
 *    sidecar must normalise SendInput's 0..65535 space to the same.
 *  - Key names (keyboard.combo) are LOGICAL, case-insensitive names — never
 *    OS virtual key codes. `primary` is the platform command modifier
 *    (Cmd on macOS, Ctrl on Windows). See MODIFIER_NAMES / KEY_NAMES.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Convention primitives
// ---------------------------------------------------------------------------

/** A screen coordinate: finite logical point. NaN/Infinity is always a bug. */
const Coord = z.number().finite();

/** Screen-absolute point (top-left origin, logical points). */
export const PointParams = z.object({ x: Coord, y: Coord });

/** A screen-absolute rectangle. */
export const RegionSchema = z.object({ x: Coord, y: Coord, w: Coord, h: Coord });

export const MouseButtonSchema = z.enum(['left', 'right', 'middle']);

/**
 * Logical modifier names the sidecar understands (case-insensitive). Kept in
 * lockstep with `modifierMap` in Input.swift. `primary` is the per-OS command
 * modifier.
 */
export const MODIFIER_NAMES = [
  'cmd', 'command', 'meta', 'primary',
  'ctrl', 'control',
  'alt', 'option',
  'shift',
  'fn',
] as const;

/**
 * Logical (non-modifier) key names. Kept in lockstep with `virtualKeyMap` in
 * Input.swift. Single printable characters map 1:1 to their key.
 */
export const KEY_NAMES = [
  'return', 'enter', 'tab', 'space', 'delete', 'backspace', 'escape', 'esc',
  'leftarrow', 'rightarrow', 'downarrow', 'uparrow', 'left', 'right', 'down', 'up',
  'home', 'end', 'pageup', 'pagedown',
  'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12',
  'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm',
  'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
  '=', '-', ']', '[', "'", ';', '\\', ',', '/', '.', '`',
] as const;

const KNOWN_KEY_TOKENS = new Set<string>([...MODIFIER_NAMES, ...KEY_NAMES]);

/** True when `token` is a key name the sidecar can resolve (case-insensitive). */
export function isKnownKeyToken(token: string): boolean {
  return KNOWN_KEY_TOKENS.has(token.toLowerCase());
}

const KeyTokenSchema = z
  .string()
  .refine((s) => isKnownKeyToken(s), { message: 'unknown key/modifier name' });

/** `keyboard.combo` params: a non-empty array of logical key tokens. */
export const KeyComboParams = z.object({ keys: z.array(KeyTokenSchema).min(1) });

/**
 * Methods that take no params. The client may send either `null` (e.g.
 * `call('ping', null)`) or omit params entirely (`call('mouse.position')`),
 * so both null and undefined are accepted.
 */
const NoParams = z.union([z.null(), z.undefined()]);

// ---------------------------------------------------------------------------
// Result primitives
// ---------------------------------------------------------------------------

const OkResult = z.object({ ok: z.boolean() });

const AppSnapshot = z.object({
  bundleId: z.string(),
  name: z.string(),
  pid: z.number(),
  active: z.boolean(),
});

const ElementSnapshot = z.object({
  role: z.string(),
  subrole: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  value: z.string().optional(),
  identifier: z.string().optional(),
  position: z.object({ x: z.number(), y: z.number() }).optional(),
  size: z.object({ w: z.number(), h: z.number() }).optional(),
  app: z
    .object({
      bundleId: z.string().optional(),
      name: z.string().optional(),
      pid: z.number(),
    })
    .optional(),
});

// Recorded events are parsed in detail by the DesktopRecorder; the contract
// only guarantees the envelope (a `kind` discriminator) and tolerates the
// per-kind payload so the recorder can evolve without a contract bump.
const RecordingEvent = z.object({ kind: z.string() }).passthrough();

// ---------------------------------------------------------------------------
// The contract: method name -> { params, result }
// ---------------------------------------------------------------------------

export const RPC_CONTRACT = {
  ping: {
    params: NoParams,
    result: z.object({
      pong: z.boolean(),
      version: z.string(),
      platform: z.string(),
      ts: z.number(),
    }),
  },

  'accessibility.status': {
    params: NoParams,
    result: z.object({ granted: z.boolean() }),
  },
  'accessibility.listApps': {
    params: NoParams,
    result: z.object({ apps: z.array(AppSnapshot) }),
  },
  'accessibility.frontmostApp': {
    params: NoParams,
    // Swift returns null when there is no frontmost app.
    result: z
      .object({
        bundleId: z.string(),
        name: z.string(),
        pid: z.number(),
        windowTitle: z.string().optional(),
      })
      .nullable(),
  },
  'accessibility.elementAtPoint': {
    params: PointParams,
    result: ElementSnapshot.nullable(),
  },

  'screen.mainSize': {
    params: NoParams,
    result: z.object({ w: z.number(), h: z.number(), scale: z.number() }).nullable(),
  },
  'screen.capture': {
    // `{}` or `{ region }`; null/undefined also tolerated.
    params: z.object({ region: RegionSchema.optional() }).nullish(),
    result: z.object({
      data: z.string(),
      w: z.number().optional(),
      h: z.number().optional(),
      format: z.string(),
    }),
  },

  'mouse.click': {
    params: z.object({
      x: Coord,
      y: Coord,
      button: MouseButtonSchema.optional(),
      clickCount: z.number().int().optional(),
    }),
    result: OkResult,
  },
  'mouse.move': {
    params: PointParams,
    result: OkResult,
  },
  'mouse.position': {
    params: NoParams,
    result: z.object({ x: z.number(), y: z.number() }),
  },
  'mouse.move_smooth': {
    params: z.object({
      toX: Coord,
      toY: Coord,
      durationMs: z.number().optional(),
      steps: z.number().optional(),
    }),
    // ok + timing measurements the adapter logs when the loop slips.
    result: z.object({
      ok: z.boolean().optional(),
      actualFps: z.number(),
      maxSlipMs: z.number(),
      steps: z.number(),
      durationMs: z.number(),
    }),
  },
  'mouse.scroll': {
    params: z.object({ x: Coord, y: Coord, dx: Coord, dy: Coord }),
    result: OkResult,
  },
  'mouse.drag': {
    params: z.object({
      fromX: Coord,
      fromY: Coord,
      toX: Coord,
      toY: Coord,
      durationMs: z.number().optional(),
      steps: z.number().optional(),
    }),
    result: OkResult,
  },

  'keyboard.type': {
    params: z.object({ text: z.string(), intervalMs: z.number().optional() }),
    result: OkResult,
  },
  'keyboard.combo': {
    params: KeyComboParams,
    result: OkResult,
  },

  'recording.start': {
    params: NoParams,
    result: OkResult,
  },
  'recording.stop': {
    params: NoParams,
    result: z.object({ ok: z.boolean(), wasActive: z.boolean().optional() }),
  },
  'recording.poll': {
    params: NoParams,
    result: z.object({ events: z.array(RecordingEvent), active: z.boolean() }),
  },
} as const satisfies Record<string, { params: z.ZodTypeAny; result: z.ZodTypeAny }>;

export type RpcMethodName = keyof typeof RPC_CONTRACT;

/** Every method name the contract knows about. */
export const RPC_METHODS = Object.keys(RPC_CONTRACT) as RpcMethodName[];

export function isRpcMethod(method: string): method is RpcMethodName {
  return Object.prototype.hasOwnProperty.call(RPC_CONTRACT, method);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export class RpcContractError extends Error {
  constructor(
    readonly method: string,
    readonly phase: 'params' | 'result',
    readonly detail: string,
  ) {
    super(`RPC contract violation [${phase}] ${method}: ${detail}`);
    this.name = 'RpcContractError';
  }
}

function formatZodError(err: z.ZodError): string {
  return err.issues
    .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
    .join('; ');
}

/** Throw RpcContractError if `params` don't satisfy the method's contract. */
export function validateRpcParams(method: string, params: unknown): void {
  if (!isRpcMethod(method)) {
    throw new RpcContractError(method, 'params', 'unknown method');
  }
  const r = RPC_CONTRACT[method].params.safeParse(params);
  if (!r.success) throw new RpcContractError(method, 'params', formatZodError(r.error));
}

/** Throw RpcContractError if `result` doesn't satisfy the method's contract. */
export function validateRpcResult(method: string, result: unknown): void {
  if (!isRpcMethod(method)) {
    throw new RpcContractError(method, 'result', 'unknown method');
  }
  const r = RPC_CONTRACT[method].result.safeParse(result);
  if (!r.success) throw new RpcContractError(method, 'result', formatZodError(r.error));
}

// ---------------------------------------------------------------------------
// Opt-in validating wrapper for a sidecar client
// ---------------------------------------------------------------------------

export type RpcCallFn = (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown>;

export interface SidecarLikeClient {
  call: RpcCallFn;
  dispose: () => void;
}

/** How aggressively to police RESULT shapes. Params are always thrown on. */
export type ResultPolicy = 'off' | 'warn' | 'throw';

export interface ContractWrapOptions {
  /** Result policy. Default 'warn' — never break a live run on an extra/odd field. */
  result?: ResultPolicy;
  /** Validate params before sending (throws on violation). Default true. */
  validateParams?: boolean;
  /** Sink for 'warn'-mode result violations. Default console.warn. */
  onIssue?: (err: RpcContractError) => void;
}

/**
 * Wrap a `{ call, dispose }` client so every known-method call is checked
 * against the contract. Params are validated before the send (a violation is
 * our own bug, so it throws); results are validated after (default 'warn'
 * because breaking a run over a benign extra field is worse than the drift).
 *
 * Unknown methods pass straight through, so adding a sidecar method before
 * the contract entry doesn't hard-fail.
 */
export function wrapWithContract(
  client: SidecarLikeClient,
  options: ContractWrapOptions = {},
): SidecarLikeClient {
  const resultPolicy = options.result ?? 'warn';
  const doParams = options.validateParams ?? true;
  const onIssue =
    options.onIssue ??
    ((err: RpcContractError) => {
      // eslint-disable-next-line no-console
      console.warn(`[hermes:rpc-contract] ${err.message}`);
    });

  const call: RpcCallFn = async (method, params, timeoutMs) => {
    if (doParams && isRpcMethod(method)) {
      validateRpcParams(method, params);
    }
    const result = await client.call(method, params, timeoutMs);
    if (resultPolicy !== 'off' && isRpcMethod(method)) {
      const check = RPC_CONTRACT[method].result.safeParse(result);
      if (!check.success) {
        const err = new RpcContractError(method, 'result', formatZodError(check.error));
        if (resultPolicy === 'throw') throw err;
        onIssue(err);
      }
    }
    return result;
  };

  return { call, dispose: () => client.dispose() };
}
