/**
 * Renderer state — zustand store.
 *
 * Holds the currently open Flow plus run/recorder state, with a JSON
 * Patch-backed undo/redo history. Mutating actions take a snapshot of
 * the previous flow and push it onto the history stack; undo pops one
 * snapshot back, redo replays the last undo.
 *
 * Persistence happens via the `flow:save` IPC; we don't auto-save on
 * every keystroke, so the user presses Save to commit.
 */
import { create } from 'zustand';
import {
  diffFlow,
  applyFlowPatch,
  newId,
  type Flow as IRFlow,
  type FlowPatch,
} from '@hermes/ir';

export type FlowSummary = {
  id: string;
  name: string;
  updatedAt: string;
  stepCount: number;
};

export type Branch = { name: string; condition?: unknown; steps: Step[] };

export type Step = {
  id: string;
  type: string;
  enabled: boolean;
  label?: string;
  target?: unknown;
  params?: Record<string, unknown>;
  meta?: Record<string, unknown>;
  children?: Step[];
  branches?: Branch[];
  [k: string]: unknown;
};

export type Flow = {
  schemaVersion: string;
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  inputs: unknown[];
  outputs: unknown[];
  variables: unknown[];
  defaults: Record<string, unknown>;
  steps: Step[];
  metadata: Record<string, unknown>;
};

export type LogEntry = {
  ts: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
};

type State = {
  flows: FlowSummary[];
  currentFlow: Flow | null;
  selectedStepId: string | null;
  dirty: boolean;
  recording: boolean;
  running: boolean;
  log: LogEntry[];
  /** History of "undo patches" — each entry is a patch that, applied to the
   *  current flow, returns to the prior state. Top is most recent. */
  undoStack: FlowPatch[];
  /** Symmetric: "redo patches" pushed by undo(), popped by redo(). */
  redoStack: FlowPatch[];
  loadFlows: () => Promise<void>;
  createFlow: (name: string) => Promise<Flow>;
  openFlow: (id: string) => Promise<void>;
  saveFlow: () => Promise<void>;
  selectStep: (id: string | null) => void;
  appendStep: (step: Step) => void;
  /** Insert a structural step (if/loop/try) with empty children at the top level. */
  addStructuralStep: (kind: 'if' | 'loop' | 'try') => void;
  /** Insert a no-op child step into the children of the given structural step. */
  addChildStep: (parentId: string) => void;
  /** Insert a no-op step into a named branch (e.g. "catch"/"finally" of a try,
   *  or "then" — the first branch — of an if). The branch is created if absent. */
  addBranchStep: (parentId: string, branchName: string) => void;
  updateStep: (id: string, patch: Partial<Step>) => void;
  removeStep: (id: string) => void;
  moveStep: (id: string, dir: -1 | 1) => void;
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
  setRecording: (running: boolean) => void;
  setRunning: (running: boolean) => void;
  appendLog: (entry: LogEntry) => void;
  clearLog: () => void;
};

const HISTORY_LIMIT = 100;

// ---------------------------------------------------------------------------
// Recursive step tree helpers
//
// Steps form a tree via `children` (loop/try body, if-else branch) and
// `branches[].steps` (if positive branch, try catch/finally). The renderer
// edits the tree in place, so the mutators below walk the whole structure
// rather than just the top-level array.
// ---------------------------------------------------------------------------

const updateInTree = (steps: Step[], id: string, patch: Partial<Step>): Step[] =>
  steps.map((s) => {
    if (s.id === id) return { ...s, ...patch };
    const next: Step = { ...s };
    if (s.children) next.children = updateInTree(s.children, id, patch);
    if (s.branches) {
      next.branches = s.branches.map((b) => ({ ...b, steps: updateInTree(b.steps, id, patch) }));
    }
    return next;
  });

const removeFromTree = (steps: Step[], id: string): Step[] => {
  const out: Step[] = [];
  for (const s of steps) {
    if (s.id === id) continue;
    const next: Step = { ...s };
    if (s.children) next.children = removeFromTree(s.children, id);
    if (s.branches) {
      next.branches = s.branches.map((b) => ({ ...b, steps: removeFromTree(b.steps, id) }));
    }
    out.push(next);
  }
  return out;
};

const moveInTree = (steps: Step[], id: string, dir: -1 | 1): Step[] => {
  const idx = steps.findIndex((s) => s.id === id);
  if (idx >= 0) {
    const nextIdx = idx + dir;
    if (nextIdx < 0 || nextIdx >= steps.length) return steps;
    const out = [...steps];
    const tmp = out[idx]!;
    out[idx] = out[nextIdx]!;
    out[nextIdx] = tmp;
    return out;
  }
  return steps.map((s) => {
    const next: Step = { ...s };
    if (s.children) next.children = moveInTree(s.children, id, dir);
    if (s.branches) {
      next.branches = s.branches.map((b) => ({ ...b, steps: moveInTree(b.steps, id, dir) }));
    }
    return next;
  });
};

const insertChildInTree = (steps: Step[], parentId: string, child: Step): Step[] =>
  steps.map((s) => {
    if (s.id === parentId) {
      return { ...s, children: [...(s.children ?? []), child] };
    }
    const next: Step = { ...s };
    if (s.children) next.children = insertChildInTree(s.children, parentId, child);
    if (s.branches) {
      next.branches = s.branches.map((b) => ({
        ...b,
        steps: insertChildInTree(b.steps, parentId, child),
      }));
    }
    return next;
  });

const insertBranchStepInTree = (
  steps: Step[],
  parentId: string,
  branchName: string,
  child: Step,
): Step[] =>
  steps.map((s) => {
    if (s.id === parentId) {
      const existing = s.branches ?? [];
      const idx = existing.findIndex((b) => b.name === branchName);
      const branches =
        idx >= 0
          ? existing.map((b, i) =>
              i === idx ? { ...b, steps: [...b.steps, child] } : b,
            )
          : [...existing, { name: branchName, steps: [child] }];
      return { ...s, branches };
    }
    const next: Step = { ...s };
    if (s.children) next.children = insertBranchStepInTree(s.children, parentId, branchName, child);
    if (s.branches) {
      next.branches = s.branches.map((b) => ({
        ...b,
        steps: insertBranchStepInTree(b.steps, parentId, branchName, child),
      }));
    }
    return next;
  });

/** Build an empty structural step. Branches/children mirror what the engine expects. */
const newStructuralStep = (kind: 'if' | 'loop' | 'try'): Step => {
  const id = newId();
  if (kind === 'if') {
    return {
      id,
      type: 'if',
      enabled: true,
      params: { condition: '' },
      branches: [{ name: 'then', steps: [] }],
      children: [],
    };
  }
  if (kind === 'loop') {
    return {
      id,
      type: 'loop',
      enabled: true,
      params: { kind: 'for', count: 3 },
      children: [],
    };
  }
  return {
    id,
    type: 'try',
    enabled: true,
    children: [],
    branches: [
      { name: 'catch', steps: [] },
      { name: 'finally', steps: [] },
    ],
  };
};

export const useStore = create<State>((set, get) => {
  /**
   * Capture an undo patch for the transition from `prev` to `next` and
   * push it on the undo stack. Clears the redo stack (any pending redo
   * is invalidated by a new edit).
   */
  const recordEdit = (prev: Flow, next: Flow): void => {
    const undoPatch = diffFlow(next as unknown as IRFlow, prev as unknown as IRFlow);
    const undoStack = [...get().undoStack, undoPatch].slice(-HISTORY_LIMIT);
    set({ undoStack, redoStack: [] });
  };

  return {
    flows: [],
    currentFlow: null,
    selectedStepId: null,
    dirty: false,
    recording: false,
    running: false,
    log: [],
    undoStack: [],
    redoStack: [],

    async loadFlows() {
      try {
        const { flows } = (await window.hermes.flowList()) as { flows: FlowSummary[] };
        set({ flows });
      } catch (e) {
        get().appendLog({
          ts: Date.now(),
          level: 'error',
          message: `フロー一覧の取得に失敗: ${(e as Error).message}`,
        });
      }
    },

    async createFlow(name: string) {
      try {
        const { flow } = (await window.hermes.flowCreate(name)) as { flow: Flow };
        set({
          currentFlow: flow,
          selectedStepId: null,
          dirty: false,
          undoStack: [],
          redoStack: [],
        });
        await get().loadFlows();
        return flow;
      } catch (e) {
        get().appendLog({
          ts: Date.now(),
          level: 'error',
          message: `フロー作成に失敗: ${(e as Error).message}`,
        });
        throw e;
      }
    },

    async openFlow(id: string) {
      try {
        const { flow } = (await window.hermes.flowOpen(id)) as { flow: Flow };
        set({
          currentFlow: flow,
          selectedStepId: null,
          dirty: false,
          undoStack: [],
          redoStack: [],
        });
      } catch (e) {
        get().appendLog({
          ts: Date.now(),
          level: 'error',
          message: `フローを開けませんでした: ${(e as Error).message}`,
        });
      }
    },

    async saveFlow() {
      const flow = get().currentFlow;
      if (!flow) return;
      try {
        await window.hermes.flowSave(flow);
        set({ dirty: false });
        await get().loadFlows();
      } catch (e) {
        get().appendLog({
          ts: Date.now(),
          level: 'error',
          message: `保存に失敗: ${(e as Error).message}`,
        });
      }
    },

    selectStep(id: string | null) {
      set({ selectedStepId: id });
    },

    appendStep(step: Step) {
      const flow = get().currentFlow;
      if (!flow) return;
      const next = { ...flow, steps: [...flow.steps, step] };
      recordEdit(flow, next);
      set({ currentFlow: next, dirty: true });
    },

    addStructuralStep(kind) {
      const flow = get().currentFlow;
      if (!flow) return;
      const step = newStructuralStep(kind);
      const next = { ...flow, steps: [...flow.steps, step] };
      recordEdit(flow, next);
      set({ currentFlow: next, dirty: true, selectedStepId: step.id });
    },

    addChildStep(parentId: string) {
      const flow = get().currentFlow;
      if (!flow) return;
      const child: Step = {
        id: newId(),
        type: 'wait',
        enabled: true,
        params: { ms: 500 },
      };
      const steps = insertChildInTree(flow.steps, parentId, child);
      const next = { ...flow, steps };
      recordEdit(flow, next);
      set({ currentFlow: next, dirty: true, selectedStepId: child.id });
    },

    addBranchStep(parentId: string, branchName: string) {
      const flow = get().currentFlow;
      if (!flow) return;
      const child: Step = {
        id: newId(),
        type: 'wait',
        enabled: true,
        params: { ms: 500 },
      };
      const steps = insertBranchStepInTree(flow.steps, parentId, branchName, child);
      const next = { ...flow, steps };
      recordEdit(flow, next);
      set({ currentFlow: next, dirty: true, selectedStepId: child.id });
    },

    updateStep(id: string, patch: Partial<Step>) {
      const flow = get().currentFlow;
      if (!flow) return;
      const steps = updateInTree(flow.steps, id, patch);
      const next = { ...flow, steps };
      recordEdit(flow, next);
      set({ currentFlow: next, dirty: true });
    },

    removeStep(id: string) {
      const flow = get().currentFlow;
      if (!flow) return;
      const steps = removeFromTree(flow.steps, id);
      const next = { ...flow, steps };
      recordEdit(flow, next);
      set({
        currentFlow: next,
        dirty: true,
        selectedStepId: get().selectedStepId === id ? null : get().selectedStepId,
      });
    },

    moveStep(id: string, dir: -1 | 1) {
      const flow = get().currentFlow;
      if (!flow) return;
      const steps = moveInTree(flow.steps, id, dir);
      if (steps === flow.steps) return;
      const next = { ...flow, steps };
      recordEdit(flow, next);
      set({ currentFlow: next, dirty: true });
    },

    undo() {
      const flow = get().currentFlow;
      const undoStack = get().undoStack;
      if (!flow || undoStack.length === 0) return;
      const top = undoStack[undoStack.length - 1]!;
      const restored = applyFlowPatch(flow as unknown as IRFlow, top) as unknown as Flow;
      const redoPatch = diffFlow(restored as unknown as IRFlow, flow as unknown as IRFlow);
      set({
        currentFlow: restored,
        undoStack: undoStack.slice(0, -1),
        redoStack: [...get().redoStack, redoPatch].slice(-HISTORY_LIMIT),
        dirty: true,
      });
    },

    redo() {
      const flow = get().currentFlow;
      const redoStack = get().redoStack;
      if (!flow || redoStack.length === 0) return;
      const top = redoStack[redoStack.length - 1]!;
      const next = applyFlowPatch(flow as unknown as IRFlow, top) as unknown as Flow;
      const undoPatch = diffFlow(next as unknown as IRFlow, flow as unknown as IRFlow);
      set({
        currentFlow: next,
        redoStack: redoStack.slice(0, -1),
        undoStack: [...get().undoStack, undoPatch].slice(-HISTORY_LIMIT),
        dirty: true,
      });
    },

    canUndo() {
      return get().undoStack.length > 0;
    },

    canRedo() {
      return get().redoStack.length > 0;
    },

    setRecording(running: boolean) {
      set({ recording: running });
    },

    setRunning(running: boolean) {
      set({ running });
    },

    appendLog(entry: LogEntry) {
      const log = [...get().log, entry].slice(-500);
      set({ log });
    },

    clearLog() {
      set({ log: [] });
    },
  };
});
