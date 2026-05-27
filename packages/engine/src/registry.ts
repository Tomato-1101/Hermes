import type { StepType } from '@hermes/ir';
import type { StepHandler } from './types.js';

/**
 * Layer label used to disambiguate handlers when more than one provider
 * implements the same Step type (e.g. `click` for web vs desktop).
 *
 * - `default` — used when no layer is specified at lookup time, or when a
 *   handler is registered without a layer.
 * - `web` / `desktop` / `screen` — match TargetRef.layer.
 */
export type HandlerLayer = 'web' | 'desktop' | 'screen' | 'default';

export class HandlerRegistry {
  private readonly handlers = new Map<string, StepHandler>();

  register(handler: StepHandler, layer: HandlerLayer = 'default'): void {
    const key = `${layer}::${handler.type}`;
    if (this.handlers.has(key)) {
      throw new Error(
        `StepHandler for type "${handler.type}" (layer="${layer}") already registered.`,
      );
    }
    this.handlers.set(key, handler);
  }

  /**
   * Lookup a handler by step type and (optionally) the target's layer.
   * Tries the layer-specific handler first, then falls back to a
   * default-layer one. This means handlers without a layer registration
   * keep working unchanged for callers that didn't update.
   */
  get(type: StepType, layer?: HandlerLayer | string): StepHandler | undefined {
    if (layer && layer !== 'default') {
      const layered = this.handlers.get(`${layer}::${type}`);
      if (layered) return layered;
    }
    return this.handlers.get(`default::${type}`);
  }

  has(type: StepType, layer?: HandlerLayer): boolean {
    return this.get(type, layer) !== undefined;
  }

  list(): readonly StepType[] {
    return [...this.handlers.keys()].map((k) => k.split('::', 2)[1] as StepType);
  }
}
