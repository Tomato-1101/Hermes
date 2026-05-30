/**
 * Programmatic surface of the headless runner. The executable entry lives in
 * cli.ts (which runs on import and must not be pulled in here).
 */
export {
  loadFlow,
  runFlow,
  runFlowFile,
  type RunFlowOptions,
  type RunFlowResult,
} from './run-flow.js';
export { collectLayers, type LayerUsage } from './layers.js';
export { buildProviders, type BuildProviderOptions, type ProviderHandles } from './providers.js';
export { spawnSidecar, type SpawnSidecarOptions, type SidecarHandle } from './sidecar-spawn.js';
