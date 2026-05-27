/**
 * Hermes Flow IR — TypeScript type definitions.
 *
 * Conventions:
 *  - All Flow / Step / TargetRef instances are plain JSON. Persisted as `flow.json`.
 *  - schemaVersion is required at the top level for forward-compatible migration.
 *  - Secrets must NEVER be inlined in IR; only `${secrets.foo}` references are allowed.
 */

export const CURRENT_SCHEMA_VERSION = '1.0' as const;

export type SchemaVersion = string;

// ---------------------------------------------------------------------------
// Top-level Flow
// ---------------------------------------------------------------------------

export interface Flow {
  schemaVersion: SchemaVersion;
  id: string;
  name: string;
  description?: string;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
  inputs: VarDecl[];
  outputs: VarDecl[];
  variables: VarDecl[];
  defaults: FlowDefaults;
  steps: Step[];
  metadata: FlowMetadata;
}

export interface FlowDefaults {
  timeoutMs: number;
  retry: RetryPolicy;
  screenshotOnError: boolean;
  waitBetweenStepsMs: number;
  allowList?: AllowList;
}

export interface FlowMetadata {
  origin: 'recorded' | 'ai-generated' | 'mixed';
  targets: ReadonlyArray<'web' | 'desktop'>;
  requiredPermissions: string[];
}

export interface VarDecl {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'json' | 'secret';
  defaultValue?: unknown;
  description?: string;
}

// ---------------------------------------------------------------------------
// Step
// ---------------------------------------------------------------------------

export type StepType =
  | 'open_url'
  | 'click'
  | 'type'
  | 'key_combo'
  | 'scroll'
  | 'wait'
  | 'wait_for'
  | 'screenshot'
  | 'extract'
  | 'set_var'
  | 'if'
  | 'loop'
  | 'try'
  | 'parallel'
  | 'subflow'
  | 'ai_assert'
  | 'ai_extract'
  | 'log'
  | 'manual_pause';

export interface Step {
  id: string;
  type: StepType;
  label?: string;
  enabled: boolean;
  target?: TargetRef;
  params?: Record<string, unknown>;
  timeoutMs?: number;
  retry?: RetryPolicy;
  assert?: Assertion[];
  onError?: OnErrorPolicy;
  children?: Step[];
  branches?: { name: string; condition?: Expression; steps: Step[] }[];
  meta?: StepMeta;
}

export interface StepMeta {
  recordedAt?: string;
  recordedBy?: string;
  generatedBy?: string;
  screenshotRef?: string;
  confidence?: number;
  needsRecording?: boolean;
  rationale?: string;
  origin?: 'recorded' | 'ai-generated' | 'manual';
}

export type OnErrorPolicy = 'fail' | 'continue' | 'retry' | { goto: string };

export interface RetryPolicy {
  attempts: number;
  backoff?: {
    kind: 'fixed' | 'exponential';
    initialMs: number;
    factor?: number;
    maxMs?: number;
  };
  retryOn?: ReadonlyArray<'selector_not_found' | 'timeout' | 'network' | 'any'>;
  betweenAttempts?: Step[];
}

// ---------------------------------------------------------------------------
// TargetRef — the selector candidate array (the heart of the design)
// ---------------------------------------------------------------------------

export interface TargetRef {
  layer: 'web' | 'desktop' | 'screen';
  candidates: Selector[];
  preferIndex?: number;
  anchor?: AnchorRef;
  region?: Rect;
}

export interface AnchorRef {
  description?: string;
  nearTarget?: TargetRef;
  inApp?: AppRef;
}

export interface AppRef {
  bundleId?: string;
  processName?: string;
  exePath?: string;
  titlePattern?: string;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Selector =
  // --- Web ---
  | { kind: 'role'; role: string; name?: string; exact?: boolean }
  | { kind: 'testid'; value: string }
  | { kind: 'label'; text: string }
  | { kind: 'css'; value: string }
  | { kind: 'xpath'; value: string }
  | { kind: 'text'; value: string }
  | { kind: 'url-anchor'; pattern: string }
  // --- Desktop (macOS AX / Windows UIA) ---
  | {
      kind: 'ax';
      app: string; // bundleId
      role: string;
      title?: string;
      identifier?: string;
      path?: AXPathSegment[];
    }
  | {
      kind: 'uia';
      processName: string;
      automationId?: string;
      controlType: string;
      name?: string;
    }
  // --- Screen fallback ---
  | {
      kind: 'image';
      assetRef: string;
      threshold: number;
      scaleInvariant?: boolean;
    }
  | { kind: 'ocr'; text: string; lang: string; regex?: boolean }
  | {
      kind: 'coords';
      x: number;
      y: number;
      anchor: 'screen' | 'window';
    };

export interface AXPathSegment {
  role: string;
  index?: number;
  title?: string;
}

// ---------------------------------------------------------------------------
// Assertion (Mode-2 insertion point)
// ---------------------------------------------------------------------------

export type Assertion =
  | { kind: 'exists'; target: TargetRef }
  | {
      kind: 'text';
      target: TargetRef;
      op: 'eq' | 'contains' | 'regex';
      value: string;
    }
  | {
      kind: 'vision_yes_no';
      prompt: string;
      refs: 'before' | 'after' | 'both';
      modelHint?: string;
    }
  | {
      kind: 'vision_extract';
      prompt: string;
      schema: unknown; // JSON Schema
      into: string;
      modelHint?: string;
    }
  | { kind: 'expr'; expr: Expression };

// ---------------------------------------------------------------------------
// Expression (jsep-based)
// ---------------------------------------------------------------------------

/** A parsed jsep expression stored as a JSON-serializable AST, or a string source to be parsed at eval time. */
export type Expression = string | { __ast: unknown };

// ---------------------------------------------------------------------------
// AllowList — future-use whitelist for dangerous Step types (exec, http, file)
// ---------------------------------------------------------------------------

export interface AllowList {
  enabledStepTypes?: string[];
  execAllowedCommands?: string[];
  httpAllowedHosts?: string[];
  fileAllowedPaths?: string[];
}
