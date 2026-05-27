import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { flowJsonSchema } from './json-schema.js';
import type { Flow } from './schema.js';

const ajv = new Ajv({ allErrors: true, strict: true });
addFormats(ajv);

const validator: ValidateFunction<Flow> = ajv.compile<Flow>(flowJsonSchema);

export interface ValidationResult {
  valid: boolean;
  errors: { path: string; message: string }[];
}

/** Validate a Flow against the strict JSON Schema. */
export function validateFlow(data: unknown): ValidationResult {
  const valid = validator(data);
  if (valid) return { valid: true, errors: [] };
  const errors = (validator.errors ?? []).map((e) => ({
    path: e.instancePath || '(root)',
    message: `${e.keyword}: ${e.message ?? ''}`.trim(),
  }));
  return { valid: false, errors };
}

/** Throws if invalid; returns the value cast to Flow if valid. */
export function assertValidFlow(data: unknown): Flow {
  const result = validateFlow(data);
  if (!result.valid) {
    const detail = result.errors.map((e) => `  ${e.path} → ${e.message}`).join('\n');
    throw new Error(`Invalid Flow:\n${detail}`);
  }
  return data as Flow;
}
