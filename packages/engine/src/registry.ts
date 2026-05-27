import type { StepType } from '@hermes/ir';
import type { StepHandler } from './types.js';

export class HandlerRegistry {
  private readonly handlers = new Map<StepType, StepHandler>();

  register(handler: StepHandler): void {
    if (this.handlers.has(handler.type)) {
      throw new Error(`StepHandler for type "${handler.type}" already registered.`);
    }
    this.handlers.set(handler.type, handler);
  }

  get(type: StepType): StepHandler | undefined {
    return this.handlers.get(type);
  }

  has(type: StepType): boolean {
    return this.handlers.has(type);
  }

  list(): readonly StepType[] {
    return [...this.handlers.keys()];
  }
}
