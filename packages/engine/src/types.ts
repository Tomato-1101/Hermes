import type { Flow, Step, StepType } from '@hermes/ir';

export interface RunOptions {
  /** Stop after each Step, awaiting `engine.resume()`. */
  mode?: 'run' | 'step';
  signal?: AbortSignal;
  /** Initial variable bindings. */
  inputs?: Record<string, unknown>;
}

export interface RunContext {
  flow: Flow;
  vars: Record<string, unknown>;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  signal: AbortSignal;
  emit(event: RunEvent): void;
  providers: ProviderBag;
}

export interface ProviderBag {
  web?: WebProviderHandle;
  desktop?: DesktopProviderHandle;
  ai?: AiServiceHandle;
}

/** Opaque handle types — actual providers are in their own packages. */
export interface WebProviderHandle {
  readonly kind: 'web';
}
export interface DesktopProviderHandle {
  readonly kind: 'desktop';
}
export interface AiServiceHandle {
  readonly kind: 'ai';
}

export type StepStatus = 'started' | 'completed' | 'failed' | 'skipped' | 'paused';

export type RunEvent =
  | { type: 'run:start'; flowId: string }
  | { type: 'run:end'; flowId: string; outcome: 'success' | 'failure' | 'aborted' }
  | { type: 'step:start'; cursor: string; step: Step }
  | { type: 'step:end'; cursor: string; step: Step; outcome: StepStatus; error?: string }
  | { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string; data?: unknown }
  | { type: 'screenshot'; cursor: string; assetRef: string };

export interface StepHandler<P = Record<string, unknown>> {
  type: StepType;
  execute(step: Step, ctx: RunContext): Promise<StepResult<P>>;
}

export interface StepResult<P = unknown> {
  outcome: StepStatus;
  data?: P;
}

export class HermesAbortError extends Error {
  constructor(message = 'Run aborted') {
    super(message);
    this.name = 'HermesAbortError';
  }
}
