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
  type Flow as IRFlow,
  type FlowPatch,
} from '@hermes/ir';

export type FlowSummary = {
  id: string;
  name: string;
  updatedAt: string;
  stepCount: number;
};

export type Step = {
  id: string;
  type: string;
  enabled: boolean;
  label?: string;
  target?: unknown;
  params?: Record<string, unknown>;
  meta?: Record<string, unknown>;
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
      const { flows } = (await window.hermes.flowList()) as { flows: FlowSummary[] };
      set({ flows });
    },

    async createFlow(name: string) {
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
    },

    async openFlow(id: string) {
      const { flow } = (await window.hermes.flowOpen(id)) as { flow: Flow };
      set({
        currentFlow: flow,
        selectedStepId: null,
        dirty: false,
        undoStack: [],
        redoStack: [],
      });
    },

    async saveFlow() {
      const flow = get().currentFlow;
      if (!flow) return;
      await window.hermes.flowSave(flow);
      set({ dirty: false });
      await get().loadFlows();
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

    updateStep(id: string, patch: Partial<Step>) {
      const flow = get().currentFlow;
      if (!flow) return;
      const steps = flow.steps.map((s) => (s.id === id ? { ...s, ...patch } : s));
      const next = { ...flow, steps };
      recordEdit(flow, next);
      set({ currentFlow: next, dirty: true });
    },

    removeStep(id: string) {
      const flow = get().currentFlow;
      if (!flow) return;
      const next = { ...flow, steps: flow.steps.filter((s) => s.id !== id) };
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
      const idx = flow.steps.findIndex((s) => s.id === id);
      if (idx < 0) return;
      const nextIdx = idx + dir;
      if (nextIdx < 0 || nextIdx >= flow.steps.length) return;
      const steps = [...flow.steps];
      const tmp = steps[idx]!;
      steps[idx] = steps[nextIdx]!;
      steps[nextIdx] = tmp;
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
