import { applyPatch, compare, type Operation } from 'fast-json-patch';
import type { Flow } from './schema.js';

export type FlowPatch = Operation[];

/** Compute a JSON Patch (RFC 6902) describing the change from `before` to `after`. */
export function diffFlow(before: Flow, after: Flow): FlowPatch {
  return compare(before, after);
}

/** Apply a JSON Patch to a Flow, returning a new Flow. The input flow is not mutated. */
export function applyFlowPatch(flow: Flow, patch: FlowPatch): Flow {
  const cloned = structuredClone(flow);
  const result = applyPatch(cloned, patch, /* validate */ true);
  return result.newDocument as Flow;
}
