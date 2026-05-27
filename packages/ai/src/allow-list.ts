/**
 * AllowList enforcement.
 *
 * For v1, this checks that no Step in a generated/edited flow uses a type
 * outside the safe Step Library set. When the Library is extended in the
 * future to include `exec` / `http_request`, the flow's `defaults.allowList`
 * must explicitly enable those step types AND pass the per-step argument
 * checks (allowed commands, allowed hosts, allowed paths).
 */

import type { AllowList, Flow, Step } from '@hermes/ir';
import { STEP_LIBRARY } from './step-library.js';

export const SAFE_STEP_TYPES = new Set(Object.keys(STEP_LIBRARY));
export const DANGEROUS_STEP_TYPES = new Set(['exec', 'http_request', 'file_write', 'file_read']);

export interface AllowListViolation {
  stepId: string;
  stepType: string;
  reason: string;
}

/** Recursively walk a step tree, yielding every Step. */
export function* walkSteps(steps: Step[]): Generator<Step> {
  for (const s of steps) {
    yield s;
    if (s.children?.length) yield* walkSteps(s.children);
    if (s.branches?.length) {
      for (const b of s.branches) yield* walkSteps(b.steps);
    }
    if (s.retry?.betweenAttempts?.length) yield* walkSteps(s.retry.betweenAttempts);
  }
}

/** Validate a Flow against the safe set + its own AllowList. */
export function checkAllowList(flow: Flow): AllowListViolation[] {
  const allow = flow.defaults.allowList;
  const enabled = new Set(allow?.enabledStepTypes ?? []);
  const violations: AllowListViolation[] = [];
  for (const s of walkSteps(flow.steps)) {
    if (SAFE_STEP_TYPES.has(s.type)) continue;
    if (DANGEROUS_STEP_TYPES.has(s.type)) {
      if (!enabled.has(s.type)) {
        violations.push({
          stepId: s.id,
          stepType: s.type,
          reason: `Step type "${s.type}" requires explicit defaults.allowList.enabledStepTypes opt-in`,
        });
        continue;
      }
      // Per-type arg checks would go here once exec/http are added.
      // For v1 we only validate the opt-in. Future PR adds command/host/path matchers.
    } else {
      violations.push({
        stepId: s.id,
        stepType: s.type,
        reason: `Unknown step type "${s.type}"`,
      });
    }
  }
  return violations;
}

/** Convenience: throws if any violation. */
export function assertAllowList(flow: Flow): void {
  const v = checkAllowList(flow);
  if (v.length > 0) {
    const detail = v.map((x) => `  ${x.stepId} (${x.stepType}): ${x.reason}`).join('\n');
    throw new Error(`AllowList violations:\n${detail}`);
  }
}

export type { AllowList };
