/**
 * Headless flow execution: load → validate → wire Engine + providers → run.
 *
 * `loadFlow` reads and schema-validates a Flow JSON file. `runFlow` takes an
 * already-typed Flow (used by tests and embedders); `runFlowFile` is the
 * load-then-run convenience the CLI calls.
 */
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { HandlerRegistry, StepExecutor } from '@hermes/engine';
import type { RunEvent } from '@hermes/engine';
import { assertValidFlow } from '@hermes/ir';
import type { Flow } from '@hermes/ir';
import { collectLayers, type LayerUsage } from './layers.js';
import { buildProviders, type BuildProviderOptions } from './providers.js';

export interface RunFlowOptions {
  /** Seed variable bindings (`${var.*}`). */
  inputs?: Record<string, unknown>;
  /** Pre-resolved values for `${secrets.*}`. */
  secrets?: Record<string, string | undefined>;
  signal?: AbortSignal;
  onEvent?: (e: RunEvent) => void;
  /** Provider construction knobs (web headless/profile, sidecar binary). */
  providers?: BuildProviderOptions;
  /**
   * Base directory that screen-layer `image` selector assetRefs resolve
   * against. Exposed to handlers as `vars.__hermes_assets_dir__`. Defaults to
   * the flow file's directory in `runFlowFile`.
   */
  assetsDir?: string;
}

export interface RunFlowResult {
  outcome: 'success' | 'failure' | 'aborted';
  flowId: string;
  layers: LayerUsage;
}

export async function loadFlow(filePath: string): Promise<Flow> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (e) {
    throw new Error(`Cannot read flow file '${filePath}': ${(e as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Flow file '${filePath}' is not valid JSON: ${(e as Error).message}`);
  }
  return assertValidFlow(json); // throws "Invalid Flow:\n …" with field detail
}

export async function runFlow(flow: Flow, opts: RunFlowOptions = {}): Promise<RunFlowResult> {
  const layers = collectLayers(flow);

  const registry = new HandlerRegistry();
  if (layers.web) {
    const { registerWebHandlers } = await import('@hermes/web-provider');
    registerWebHandlers(registry);
  }
  if (layers.desktop) {
    const { registerDesktopHandlers, registerScreenHandlers, registerClipboardHandlers } =
      await import('@hermes/desktop-adapter/handlers');
    registerDesktopHandlers(registry);
    if (layers.screen) registerScreenHandlers(registry);
    if (layers.clipboard) registerClipboardHandlers(registry);
  }

  const handles = await buildProviders(layers, opts.providers);
  try {
    const executor = new StepExecutor({
      registry,
      providers: handles.providers,
      secrets: opts.secrets,
    });
    if (opts.onEvent) executor.on(opts.onEvent);
    // Screen-layer image assets resolve against assetsDir; surface it to the
    // handlers as a magic var (mirrors how humanize settings are injected).
    const inputs = opts.assetsDir
      ? { ...(opts.inputs ?? {}), __hermes_assets_dir__: opts.assetsDir }
      : opts.inputs;
    const outcome = await executor.run(flow, { signal: opts.signal, inputs });
    return { outcome, flowId: flow.id, layers };
  } finally {
    await handles.dispose();
  }
}

export async function runFlowFile(
  filePath: string,
  opts: RunFlowOptions = {},
): Promise<RunFlowResult> {
  const flow = await loadFlow(filePath);
  // Image assetRefs in a file-loaded flow are relative to the flow file.
  const assetsDir = opts.assetsDir ?? dirname(resolve(filePath));
  return runFlow(flow, { ...opts, assetsDir });
}
