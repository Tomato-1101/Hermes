/**
 * Step Library — the white-listed set of Step types that the Mode-3 generator
 * is allowed to emit. Each entry is a JSON Schema (for ajv validation) and
 * a function-calling Tool definition (for the LLM).
 *
 * Critically: this list does NOT include `exec`, arbitrary HTTP, arbitrary
 * JS, or file-write primitives. Those can be added later via the AllowList
 * mechanism, but they are absent from the v1 library so the model has no
 * way to produce them.
 */

import type { ToolDefinition } from './openrouter-client.js';

const TARGET_REF_SCHEMA = {
  type: 'object',
  required: ['layer', 'candidates'],
  additionalProperties: false,
  properties: {
    layer: { enum: ['web', 'desktop', 'screen'] },
    candidates: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['kind'],
        properties: { kind: { type: 'string' } },
      },
    },
  },
} as const;

const STEP_OPEN_URL = {
  name: 'open_url',
  description: 'Navigate the active web browser to a URL.',
  parameters: {
    type: 'object',
    required: ['url'],
    additionalProperties: false,
    properties: {
      url: { type: 'string', format: 'uri' },
      newTab: { type: 'boolean' },
    },
  },
} as const;

const STEP_CLICK = {
  name: 'click',
  description: 'Click a UI element (web or desktop). Provide a TargetRef.',
  parameters: {
    type: 'object',
    required: ['target'],
    additionalProperties: false,
    properties: {
      target: TARGET_REF_SCHEMA,
      button: { enum: ['left', 'right', 'middle'] },
      clicks: { enum: [1, 2, 3] },
      modifiers: { type: 'array', items: { type: 'string' } },
    },
  },
} as const;

const STEP_TYPE = {
  name: 'type',
  description: 'Type text into a UI element. Use ${secrets.foo} for sensitive values.',
  parameters: {
    type: 'object',
    required: ['target', 'value'],
    additionalProperties: false,
    properties: {
      target: TARGET_REF_SCHEMA,
      value: { type: 'string' },
      clearFirst: { type: 'boolean' },
      secret: { type: 'boolean' },
    },
  },
} as const;

const STEP_KEY_COMBO = {
  name: 'key_combo',
  description: 'Press a key combination (e.g. ["primary","s"] = Save on both macOS and Windows).',
  parameters: {
    type: 'object',
    required: ['keys'],
    additionalProperties: false,
    properties: {
      keys: { type: 'array', items: { type: 'string' }, minItems: 1 },
    },
  },
} as const;

const STEP_SCROLL = {
  name: 'scroll',
  description: 'Scroll within a target (or the active viewport).',
  parameters: {
    type: 'object',
    required: ['dx', 'dy'],
    additionalProperties: false,
    properties: {
      target: TARGET_REF_SCHEMA,
      dx: { type: 'number' },
      dy: { type: 'number' },
    },
  },
} as const;

const STEP_WAIT = {
  name: 'wait',
  description: 'Sleep for a fixed number of milliseconds (use sparingly; prefer wait_for).',
  parameters: {
    type: 'object',
    required: ['ms'],
    additionalProperties: false,
    properties: {
      ms: { type: 'integer', minimum: 0 },
    },
  },
} as const;

const STEP_WAIT_FOR = {
  name: 'wait_for',
  description: 'Wait until a condition becomes true: an element exists, a URL pattern, or an AI yes/no judgment.',
  parameters: {
    type: 'object',
    required: ['condition'],
    additionalProperties: false,
    properties: {
      condition: {
        oneOf: [
          {
            type: 'object',
            required: ['kind', 'target'],
            properties: { kind: { const: 'exists' }, target: TARGET_REF_SCHEMA },
          },
          {
            type: 'object',
            required: ['kind', 'pattern'],
            properties: { kind: { const: 'url_matches' }, pattern: { type: 'string' } },
          },
          {
            type: 'object',
            required: ['kind', 'prompt'],
            properties: { kind: { const: 'vision_yes_no' }, prompt: { type: 'string' } },
          },
        ],
      },
      timeoutMs: { type: 'integer', minimum: 0 },
      intervalMs: { type: 'integer', minimum: 50 },
    },
  },
} as const;

const STEP_SCREENSHOT = {
  name: 'screenshot',
  description: 'Capture a screenshot for later reference (also useful for AI assertions).',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: { type: 'string' },
      targetRegion: TARGET_REF_SCHEMA,
    },
  },
} as const;

const STEP_EXTRACT = {
  name: 'extract',
  description: 'Read text or attribute from a UI element into a variable.',
  parameters: {
    type: 'object',
    required: ['target', 'into'],
    additionalProperties: false,
    properties: {
      target: TARGET_REF_SCHEMA,
      attr: { type: 'string' },
      into: { type: 'string' },
    },
  },
} as const;

const STEP_SET_VAR = {
  name: 'set_var',
  description: 'Set a flow variable to a constant or expression result.',
  parameters: {
    type: 'object',
    required: ['name'],
    additionalProperties: false,
    properties: {
      name: { type: 'string' },
      value: {},
      expr: { type: 'string' },
    },
  },
} as const;

const STEP_AI_ASSERT = {
  name: 'ai_assert',
  description: 'Run a vision yes/no judgment using an AI model. The step succeeds if the model answers yes.',
  parameters: {
    type: 'object',
    required: ['prompt'],
    additionalProperties: false,
    properties: {
      prompt: { type: 'string' },
      refs: { enum: ['before', 'after', 'both'] },
      modelHint: { type: 'string' },
    },
  },
} as const;

const STEP_AI_EXTRACT = {
  name: 'ai_extract',
  description: 'Extract structured JSON from the current screen using a vision model.',
  parameters: {
    type: 'object',
    required: ['prompt', 'schema', 'into'],
    additionalProperties: false,
    properties: {
      prompt: { type: 'string' },
      schema: {},
      into: { type: 'string' },
      modelHint: { type: 'string' },
    },
  },
} as const;

const STEP_MANUAL_PAUSE = {
  name: 'manual_pause',
  description: 'Pause the run and ask the human to perform a manual action, then click Continue.',
  parameters: {
    type: 'object',
    required: ['message'],
    additionalProperties: false,
    properties: { message: { type: 'string' } },
  },
} as const;

const STEP_IF = {
  name: 'if',
  description: 'Branch: run `then` steps if condition is true, otherwise `else`.',
  parameters: {
    type: 'object',
    required: ['condition', 'then'],
    additionalProperties: false,
    properties: {
      condition: { type: 'string', description: 'jsep expression' },
      then: { type: 'array', items: { type: 'object' } },
      else: { type: 'array', items: { type: 'object' } },
    },
  },
} as const;

const STEP_LOOP = {
  name: 'loop',
  description: 'Repeat steps a fixed number of times (kind=for, count) or over an array (kind=forEach, items, asVar).',
  parameters: {
    type: 'object',
    required: ['kind', 'children'],
    additionalProperties: false,
    properties: {
      kind: { enum: ['for', 'forEach'] },
      count: { type: 'integer', minimum: 0 },
      items: { type: 'array' },
      asVar: { type: 'string' },
      children: { type: 'array', items: { type: 'object' } },
    },
  },
} as const;

const STEP_TRY = {
  name: 'try',
  description: 'Try steps; on failure run `catch`; always run `finally` (optional).',
  parameters: {
    type: 'object',
    required: ['children'],
    additionalProperties: false,
    properties: {
      children: { type: 'array', items: { type: 'object' } },
      catch: { type: 'array', items: { type: 'object' } },
      finally: { type: 'array', items: { type: 'object' } },
    },
  },
} as const;

const STEP_PARALLEL = {
  name: 'parallel',
  description: 'Run independent step tracks concurrently (web-only safe; desktop tracks are serialized internally).',
  parameters: {
    type: 'object',
    required: ['tracks'],
    additionalProperties: false,
    properties: {
      maxConcurrency: { type: 'integer', minimum: 1 },
      tracks: { type: 'array', items: { type: 'array', items: { type: 'object' } } },
    },
  },
} as const;

const STEP_SUBFLOW = {
  name: 'subflow',
  description: 'Call another saved flow as a reusable sub-routine.',
  parameters: {
    type: 'object',
    required: ['flowId'],
    additionalProperties: false,
    properties: {
      flowId: { type: 'string' },
      args: { type: 'object' },
    },
  },
} as const;

const STEP_LOG = {
  name: 'log',
  description: 'Write a log message (visible in the run timeline).',
  parameters: {
    type: 'object',
    required: ['message'],
    additionalProperties: false,
    properties: {
      message: { type: 'string' },
      level: { enum: ['debug', 'info', 'warn', 'error'] },
    },
  },
} as const;

export const STEP_LIBRARY = {
  open_url: STEP_OPEN_URL,
  click: STEP_CLICK,
  type: STEP_TYPE,
  key_combo: STEP_KEY_COMBO,
  scroll: STEP_SCROLL,
  wait: STEP_WAIT,
  wait_for: STEP_WAIT_FOR,
  screenshot: STEP_SCREENSHOT,
  extract: STEP_EXTRACT,
  set_var: STEP_SET_VAR,
  ai_assert: STEP_AI_ASSERT,
  ai_extract: STEP_AI_EXTRACT,
  manual_pause: STEP_MANUAL_PAUSE,
  if: STEP_IF,
  loop: STEP_LOOP,
  try: STEP_TRY,
  parallel: STEP_PARALLEL,
  subflow: STEP_SUBFLOW,
  log: STEP_LOG,
} as const;

export type StepLibraryName = keyof typeof STEP_LIBRARY;

/** Build OpenAI-compatible tool definitions for the generator LLM. */
export function buildStepTools(): ToolDefinition[] {
  return Object.values(STEP_LIBRARY).map((entry) => ({
    type: 'function',
    function: {
      name: entry.name,
      description: entry.description,
      parameters: entry.parameters as unknown as Record<string, unknown>,
      strict: true,
    },
  }));
}
