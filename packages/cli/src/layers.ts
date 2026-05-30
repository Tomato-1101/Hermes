import type { Flow, Step } from '@hermes/ir';

export interface LayerUsage {
  web: boolean;
  desktop: boolean;
  /** Screen-layer steps (image / OCR). They ride the desktop sidecar, so
   * `desktop` is also set, but the runner needs this to register the screen
   * handlers in addition to the desktop ones. */
  screen: boolean;
}

/**
 * Walk the whole step tree (children + branch steps) and record which
 * provider layers the flow touches. The runner builds only the providers it
 * needs — a log/wait/if/loop flow needs neither Chrome nor the macOS sidecar,
 * so it must not pay to launch them. `screen` steps ride the desktop sidecar,
 * so they set `desktop` too.
 */
export function collectLayers(flow: Flow): LayerUsage {
  const usage: LayerUsage = { web: false, desktop: false, screen: false };
  const walk = (steps: Step[]): void => {
    for (const step of steps) {
      // Widen to string so comparing against 'screen' stays legal even if the
      // TargetRef.layer union doesn't list it.
      const layer: string | undefined = step.target?.layer;
      if (layer === 'screen') {
        usage.screen = true;
        usage.desktop = true;
      } else if (layer === 'desktop') usage.desktop = true;
      else if (layer === 'web') usage.web = true;
      else if (step.type === 'open_url') usage.web = true;
      if (step.children) walk(step.children);
      if (step.branches) for (const b of step.branches) walk(b.steps);
    }
  };
  walk(flow.steps);
  return usage;
}
