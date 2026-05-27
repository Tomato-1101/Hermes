/**
 * JSON Schema definitions matching the TypeScript types in ./schema.ts.
 * Used by ajv for strict validation of `flow.json` files.
 */

export const flowJsonSchema = {
  $id: 'https://hermes.dev/schemas/flow-1.0.json',
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Flow',
  type: 'object',
  required: [
    'schemaVersion',
    'id',
    'name',
    'createdAt',
    'updatedAt',
    'inputs',
    'outputs',
    'variables',
    'defaults',
    'steps',
    'metadata',
  ],
  additionalProperties: false,
  properties: {
    schemaVersion: { type: 'string', const: '1.0' },
    id: { type: 'string', minLength: 1 },
    name: { type: 'string', minLength: 1 },
    description: { type: 'string' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    inputs: { type: 'array', items: { $ref: '#/$defs/varDecl' } },
    outputs: { type: 'array', items: { $ref: '#/$defs/varDecl' } },
    variables: { type: 'array', items: { $ref: '#/$defs/varDecl' } },
    defaults: { $ref: '#/$defs/flowDefaults' },
    steps: { type: 'array', items: { $ref: '#/$defs/step' } },
    metadata: { $ref: '#/$defs/flowMetadata' },
  },
  $defs: {
    varDecl: {
      type: 'object',
      required: ['name', 'type'],
      additionalProperties: false,
      properties: {
        name: { type: 'string', minLength: 1 },
        type: { enum: ['string', 'number', 'boolean', 'json', 'secret'] },
        defaultValue: {},
        description: { type: 'string' },
      },
    },
    flowDefaults: {
      type: 'object',
      required: ['timeoutMs', 'retry', 'screenshotOnError', 'waitBetweenStepsMs'],
      additionalProperties: false,
      properties: {
        timeoutMs: { type: 'integer', minimum: 0 },
        retry: { $ref: '#/$defs/retryPolicy' },
        screenshotOnError: { type: 'boolean' },
        waitBetweenStepsMs: { type: 'integer', minimum: 0 },
        allowList: { $ref: '#/$defs/allowList' },
      },
    },
    flowMetadata: {
      type: 'object',
      required: ['origin', 'targets', 'requiredPermissions'],
      additionalProperties: false,
      properties: {
        origin: { enum: ['recorded', 'ai-generated', 'mixed'] },
        targets: {
          type: 'array',
          items: { enum: ['web', 'desktop'] },
        },
        requiredPermissions: { type: 'array', items: { type: 'string' } },
      },
    },
    retryPolicy: {
      type: 'object',
      required: ['attempts'],
      additionalProperties: false,
      properties: {
        attempts: { type: 'integer', minimum: 1 },
        backoff: {
          type: 'object',
          required: ['kind', 'initialMs'],
          additionalProperties: false,
          properties: {
            kind: { enum: ['fixed', 'exponential'] },
            initialMs: { type: 'integer', minimum: 0 },
            factor: { type: 'number', minimum: 1 },
            maxMs: { type: 'integer', minimum: 0 },
          },
        },
        retryOn: {
          type: 'array',
          items: { enum: ['selector_not_found', 'timeout', 'network', 'any'] },
        },
        betweenAttempts: { type: 'array', items: { $ref: '#/$defs/step' } },
      },
    },
    allowList: {
      type: 'object',
      additionalProperties: false,
      properties: {
        enabledStepTypes: { type: 'array', items: { type: 'string' } },
        execAllowedCommands: { type: 'array', items: { type: 'string' } },
        httpAllowedHosts: { type: 'array', items: { type: 'string' } },
        fileAllowedPaths: { type: 'array', items: { type: 'string' } },
      },
    },
    step: {
      type: 'object',
      required: ['id', 'type', 'enabled'],
      additionalProperties: false,
      properties: {
        id: { type: 'string', minLength: 1 },
        type: {
          enum: [
            'open_url',
            'click',
            'type',
            'key_combo',
            'scroll',
            'wait',
            'wait_for',
            'screenshot',
            'extract',
            'set_var',
            'if',
            'loop',
            'try',
            'parallel',
            'subflow',
            'ai_assert',
            'ai_extract',
            'log',
            'manual_pause',
          ],
        },
        label: { type: 'string' },
        enabled: { type: 'boolean' },
        target: { $ref: '#/$defs/targetRef' },
        params: { type: 'object' },
        timeoutMs: { type: 'integer', minimum: 0 },
        retry: { $ref: '#/$defs/retryPolicy' },
        assert: { type: 'array', items: { $ref: '#/$defs/assertion' } },
        onError: {
          oneOf: [
            { enum: ['fail', 'continue', 'retry'] },
            {
              type: 'object',
              required: ['goto'],
              additionalProperties: false,
              properties: { goto: { type: 'string' } },
            },
          ],
        },
        children: { type: 'array', items: { $ref: '#/$defs/step' } },
        branches: {
          type: 'array',
          items: {
            type: 'object',
            required: ['name', 'steps'],
            additionalProperties: false,
            properties: {
              name: { type: 'string' },
              condition: { $ref: '#/$defs/expression' },
              steps: { type: 'array', items: { $ref: '#/$defs/step' } },
            },
          },
        },
        meta: { $ref: '#/$defs/stepMeta' },
      },
    },
    stepMeta: {
      type: 'object',
      additionalProperties: false,
      properties: {
        recordedAt: { type: 'string', format: 'date-time' },
        recordedBy: { type: 'string' },
        generatedBy: { type: 'string' },
        screenshotRef: { type: 'string' },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        needsRecording: { type: 'boolean' },
        rationale: { type: 'string' },
        origin: { enum: ['recorded', 'ai-generated', 'manual'] },
      },
    },
    targetRef: {
      type: 'object',
      required: ['layer', 'candidates'],
      additionalProperties: false,
      properties: {
        layer: { enum: ['web', 'desktop', 'screen'] },
        candidates: {
          type: 'array',
          minItems: 1,
          items: { $ref: '#/$defs/selector' },
        },
        preferIndex: { type: 'integer', minimum: 0 },
        anchor: { $ref: '#/$defs/anchorRef' },
        region: { $ref: '#/$defs/rect' },
      },
    },
    anchorRef: {
      type: 'object',
      additionalProperties: false,
      properties: {
        description: { type: 'string' },
        nearTarget: { $ref: '#/$defs/targetRef' },
        inApp: { $ref: '#/$defs/appRef' },
      },
    },
    appRef: {
      type: 'object',
      additionalProperties: false,
      properties: {
        bundleId: { type: 'string' },
        processName: { type: 'string' },
        exePath: { type: 'string' },
        titlePattern: { type: 'string' },
      },
    },
    rect: {
      type: 'object',
      required: ['x', 'y', 'w', 'h'],
      additionalProperties: false,
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        w: { type: 'number', minimum: 0 },
        h: { type: 'number', minimum: 0 },
      },
    },
    selector: {
      oneOf: [
        {
          type: 'object',
          required: ['kind', 'role'],
          additionalProperties: false,
          properties: {
            kind: { const: 'role' },
            role: { type: 'string' },
            name: { type: 'string' },
            exact: { type: 'boolean' },
          },
        },
        {
          type: 'object',
          required: ['kind', 'value'],
          additionalProperties: false,
          properties: {
            kind: { const: 'testid' },
            value: { type: 'string' },
          },
        },
        {
          type: 'object',
          required: ['kind', 'text'],
          additionalProperties: false,
          properties: {
            kind: { const: 'label' },
            text: { type: 'string' },
          },
        },
        {
          type: 'object',
          required: ['kind', 'value'],
          additionalProperties: false,
          properties: {
            kind: { const: 'css' },
            value: { type: 'string' },
          },
        },
        {
          type: 'object',
          required: ['kind', 'value'],
          additionalProperties: false,
          properties: {
            kind: { const: 'xpath' },
            value: { type: 'string' },
          },
        },
        {
          type: 'object',
          required: ['kind', 'value'],
          additionalProperties: false,
          properties: {
            kind: { const: 'text' },
            value: { type: 'string' },
          },
        },
        {
          type: 'object',
          required: ['kind', 'pattern'],
          additionalProperties: false,
          properties: {
            kind: { const: 'url-anchor' },
            pattern: { type: 'string' },
          },
        },
        {
          type: 'object',
          required: ['kind', 'app', 'role'],
          additionalProperties: false,
          properties: {
            kind: { const: 'ax' },
            app: { type: 'string' },
            role: { type: 'string' },
            title: { type: 'string' },
            identifier: { type: 'string' },
            path: {
              type: 'array',
              items: {
                type: 'object',
                required: ['role'],
                additionalProperties: false,
                properties: {
                  role: { type: 'string' },
                  index: { type: 'integer', minimum: 0 },
                  title: { type: 'string' },
                },
              },
            },
          },
        },
        {
          type: 'object',
          required: ['kind', 'processName', 'controlType'],
          additionalProperties: false,
          properties: {
            kind: { const: 'uia' },
            processName: { type: 'string' },
            automationId: { type: 'string' },
            controlType: { type: 'string' },
            name: { type: 'string' },
          },
        },
        {
          type: 'object',
          required: ['kind', 'assetRef', 'threshold'],
          additionalProperties: false,
          properties: {
            kind: { const: 'image' },
            assetRef: { type: 'string' },
            threshold: { type: 'number', minimum: 0, maximum: 1 },
            scaleInvariant: { type: 'boolean' },
          },
        },
        {
          type: 'object',
          required: ['kind', 'text', 'lang'],
          additionalProperties: false,
          properties: {
            kind: { const: 'ocr' },
            text: { type: 'string' },
            lang: { type: 'string' },
            regex: { type: 'boolean' },
          },
        },
        {
          type: 'object',
          required: ['kind', 'x', 'y', 'anchor'],
          additionalProperties: false,
          properties: {
            kind: { const: 'coords' },
            x: { type: 'number' },
            y: { type: 'number' },
            anchor: { enum: ['screen', 'window'] },
          },
        },
      ],
    },
    assertion: {
      oneOf: [
        {
          type: 'object',
          required: ['kind', 'target'],
          additionalProperties: false,
          properties: {
            kind: { const: 'exists' },
            target: { $ref: '#/$defs/targetRef' },
          },
        },
        {
          type: 'object',
          required: ['kind', 'target', 'op', 'value'],
          additionalProperties: false,
          properties: {
            kind: { const: 'text' },
            target: { $ref: '#/$defs/targetRef' },
            op: { enum: ['eq', 'contains', 'regex'] },
            value: { type: 'string' },
          },
        },
        {
          type: 'object',
          required: ['kind', 'prompt', 'refs'],
          additionalProperties: false,
          properties: {
            kind: { const: 'vision_yes_no' },
            prompt: { type: 'string' },
            refs: { enum: ['before', 'after', 'both'] },
            modelHint: { type: 'string' },
          },
        },
        {
          type: 'object',
          required: ['kind', 'prompt', 'schema', 'into'],
          additionalProperties: false,
          properties: {
            kind: { const: 'vision_extract' },
            prompt: { type: 'string' },
            schema: {},
            into: { type: 'string' },
            modelHint: { type: 'string' },
          },
        },
        {
          type: 'object',
          required: ['kind', 'expr'],
          additionalProperties: false,
          properties: {
            kind: { const: 'expr' },
            expr: { $ref: '#/$defs/expression' },
          },
        },
      ],
    },
    expression: {
      oneOf: [
        { type: 'string' },
        {
          type: 'object',
          required: ['__ast'],
          additionalProperties: false,
          properties: { __ast: {} },
        },
      ],
    },
  },
} as const;
