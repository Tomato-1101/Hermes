/**
 * Renderer state — zustand store.
 *
 * Holds the currently open Flow plus run/recorder state. Keeps the API
 * minimal: load / select / mutate steps. Persistence happens via the
 * `flow:save` IPC; we don't auto-save on every keystroke, so the user
 * presses Save to commit.
 */
import { create } from 'zustand';

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
  loadFlows: () => Promise<void>;
  createFlow: (name: string) => Promise<Flow>;
  openFlow: (id: string) => Promise<void>;
  saveFlow: () => Promise<void>;
  selectStep: (id: string | null) => void;
  appendStep: (step: Step) => void;
  updateStep: (id: string, patch: Partial<Step>) => void;
  removeStep: (id: string) => void;
  moveStep: (id: string, dir: -1 | 1) => void;
  setRecording: (running: boolean) => void;
  setRunning: (running: boolean) => void;
  appendLog: (entry: LogEntry) => void;
  clearLog: () => void;
};

export const useStore = create<State>((set, get) => ({
  flows: [],
  currentFlow: null,
  selectedStepId: null,
  dirty: false,
  recording: false,
  running: false,
  log: [],

  async loadFlows() {
    const { flows } = (await window.hermes.flowList()) as { flows: FlowSummary[] };
    set({ flows });
  },

  async createFlow(name: string) {
    const { flow } = (await window.hermes.flowCreate(name)) as { flow: Flow };
    set({ currentFlow: flow, selectedStepId: null, dirty: false });
    await get().loadFlows();
    return flow;
  },

  async openFlow(id: string) {
    const { flow } = (await window.hermes.flowOpen(id)) as { flow: Flow };
    set({ currentFlow: flow, selectedStepId: null, dirty: false });
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
    set({
      currentFlow: { ...flow, steps: [...flow.steps, step] },
      dirty: true,
    });
  },

  updateStep(id: string, patch: Partial<Step>) {
    const flow = get().currentFlow;
    if (!flow) return;
    const steps = flow.steps.map((s) => (s.id === id ? { ...s, ...patch } : s));
    set({ currentFlow: { ...flow, steps }, dirty: true });
  },

  removeStep(id: string) {
    const flow = get().currentFlow;
    if (!flow) return;
    set({
      currentFlow: { ...flow, steps: flow.steps.filter((s) => s.id !== id) },
      dirty: true,
      selectedStepId: get().selectedStepId === id ? null : get().selectedStepId,
    });
  },

  moveStep(id: string, dir: -1 | 1) {
    const flow = get().currentFlow;
    if (!flow) return;
    const idx = flow.steps.findIndex((s) => s.id === id);
    if (idx < 0) return;
    const next = idx + dir;
    if (next < 0 || next >= flow.steps.length) return;
    const steps = [...flow.steps];
    const tmp = steps[idx]!;
    steps[idx] = steps[next]!;
    steps[next] = tmp;
    set({ currentFlow: { ...flow, steps }, dirty: true });
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
}));
