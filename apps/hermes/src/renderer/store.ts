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
  type WaitForKind,
} from '@hermes/ir';

/**
 * Categories of step the inline-insert popup can spawn. `wait` is a
 * time-only block; the rest of the wait_for kinds collapse onto the
 * `wait_for` step type. Structural kinds (if/loop/try) follow the
 * existing factories.
 */
export type InsertKind =
  | 'wait'
  | { type: 'wait_for'; kind: WaitForKind }
  | 'if'
  | 'loop'
  | 'try';

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

export type BrowserProfileMode =
  | 'hermes-profile'
  | 'system-chrome'
  | 'system-chrome-import';

export type AppSettings = {
  browser: {
    mode: BrowserProfileMode;
    systemChromePath?: string;
    systemChromeProfileName?: string;
    channel?: 'chrome' | 'chromium';
  };
  humanize: {
    mouseSpeedPxPerSec: number;
    typeDelayMs: number;
    mouseMinSteps: number;
    mouseMaxSteps: number;
  };
};

const DEFAULT_APP_SETTINGS: AppSettings = {
  // main 側 DEFAULT_SETTINGS と既定を一致させる（settings:get 解決前の暫定表示が
  // 実際の既定と食い違わないように）。推奨モードは system-chrome-import。
  browser: { mode: 'system-chrome-import', channel: 'chrome' },
  humanize: {
    mouseSpeedPxPerSec: 800,
    typeDelayMs: 50,
    mouseMinSteps: 8,
    mouseMaxSteps: 60,
  },
};

type State = {
  flows: FlowSummary[];
  currentFlow: Flow | null;
  selectedStepId: string | null;
  dirty: boolean;
  recording: boolean;
  running: boolean;
  /** Step currently executing during a run (driven by run:step events), so
   *  the timeline can highlight where the engine is. Null when idle. */
  activeStepId: string | null;
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
  deleteFlow: (id: string) => Promise<void>;
  duplicateFlow: (id: string, newName: string) => Promise<Flow>;
  renameFlow: (id: string, newName: string) => Promise<void>;
  appSettings: AppSettings;
  loadAppSettings: () => Promise<void>;
  setAppSettings: (next: AppSettings) => Promise<void>;
  selectStep: (id: string | null) => void;
  appendStep: (step: Step) => void;
  /** Insert a structural step (if/loop/try) with empty children at the top level. */
  addStructuralStep: (kind: 'if' | 'loop' | 'try') => void;
  /** Insert a no-op child step into the children of the given structural step. */
  addChildStep: (parentId: string) => void;
  /** Insert a no-op step into a named branch (e.g. "catch"/"finally" of a try,
   *  or "then" — the first branch — of an if). The branch is created if absent. */
  addBranchStep: (parentId: string, branchName: string) => void;
  /**
   * Insert a step before the given step id (anywhere in the tree). When
   * `beforeStepId` is null the new step is appended at the top level.
   * Used by the timeline's hover-handle popup to inline new wait/wait_for
   * blocks between recorded actions.
   */
  insertStepAt: (beforeStepId: string | null, kind: InsertKind) => void;
  /** Append a wait or wait_for at the very end of the top-level steps. */
  appendQuickStep: (kind: InsertKind) => void;
  /**
   * Convert a wait ↔ wait_for step in place. Preserves whatever can be
   * reused (ms ↔ timeoutMs) and fills the rest with sensible defaults
   * for the new kind.
   */
  convertWaitKind: (stepId: string, kind: WaitForKind) => void;
  updateStep: (id: string, patch: Partial<Step>) => void;
  removeStep: (id: string) => void;
  moveStep: (id: string, dir: -1 | 1) => void;
  /** UI toggle: capture human think-time as `wait` steps during recording. */
  recordWaits: boolean;
  setRecordWaits: (enabled: boolean) => void;
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
  setRecording: (running: boolean) => void;
  setRunning: (running: boolean) => void;
  setActiveStep: (id: string | null) => void;
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

/** Walk the tree (children + branches) and return the first step with the
 *  given id, or null. Used by mutators that need to read existing params
 *  before patching. */
const findStepInTree = (steps: Step[], id: string): Step | null => {
  for (const s of steps) {
    if (s.id === id) return s;
    if (s.children) {
      const c = findStepInTree(s.children, id);
      if (c) return c;
    }
    if (s.branches) {
      for (const b of s.branches) {
        const c = findStepInTree(b.steps, id);
        if (c) return c;
      }
    }
  }
  return null;
};

/**
 * Insert `newStep` immediately before the step identified by `beforeStepId`
 * anywhere in the tree. When `beforeStepId` is null, the step is appended
 * at the top level (the renderer treats that as "add to end"). Walks
 * children and branches so the insertion works inside if/loop/try bodies.
 */
const insertBeforeInTree = (
  steps: Step[],
  beforeStepId: string | null,
  newStep: Step,
): Step[] => {
  if (beforeStepId === null) return [...steps, newStep];

  const idx = steps.findIndex((s) => s.id === beforeStepId);
  if (idx >= 0) {
    const out = [...steps];
    out.splice(idx, 0, newStep);
    return out;
  }

  return steps.map((s) => {
    const next: Step = { ...s };
    if (s.children) next.children = insertBeforeInTree(s.children, beforeStepId, newStep);
    if (s.branches) {
      next.branches = s.branches.map((b) => ({
        ...b,
        steps: insertBeforeInTree(b.steps, beforeStepId, newStep),
      }));
    }
    return next;
  });
};

/** Default params for each wait_for kind. Kept in one place so the
 *  inline-insert popup and the Inspector's kind switcher emit the same
 *  shape regardless of how the user got there. */
const defaultsForWaitForKind = (
  kind: WaitForKind,
  carry?: Record<string, unknown>,
): Record<string, unknown> => {
  const timeoutMs = Number(carry?.['timeoutMs'] ?? 10_000);
  switch (kind) {
    case 'time':
      // Falls through to the `wait` step elsewhere, but if asked for as
      // a wait_for kind we still emit a usable params shape.
      return { kind, ms: Number(carry?.['ms'] ?? carry?.['timeoutMs'] ?? 500) };
    case 'web.load':
      return { kind, state: String(carry?.['state'] ?? 'load'), timeoutMs };
    case 'web.element':
      return { kind, state: String(carry?.['state'] ?? 'visible'), timeoutMs };
    case 'web.url':
      return { kind, url: String(carry?.['url'] ?? ''), timeoutMs };
    case 'desktop.element':
      return { kind, timeoutMs };
    case 'desktop.app_focus':
      return { kind, appBundleId: String(carry?.['appBundleId'] ?? ''), timeoutMs };
    case 'desktop.window_title':
      return { kind, titlePattern: String(carry?.['titlePattern'] ?? ''), timeoutMs };
    case 'desktop.screen_stable':
      return {
        kind,
        stableMs: Number(carry?.['stableMs'] ?? 800),
        pollIntervalMs: Number(carry?.['pollIntervalMs'] ?? 200),
        timeoutMs,
      };
    case 'expr':
      return {
        kind,
        expr: String(carry?.['expr'] ?? ''),
        timeoutMs,
        pollIntervalMs: Number(carry?.['pollIntervalMs'] ?? 100),
      };
  }
};

const newWaitStep = (ms = 500): Step => ({
  id: newId(),
  type: 'wait',
  enabled: true,
  params: { ms },
});

const newWaitForStep = (kind: WaitForKind): Step => ({
  id: newId(),
  type: 'wait_for',
  enabled: true,
  params: defaultsForWaitForKind(kind),
});

/** Build any inline-insert step kind into a concrete Step. */
const buildStepFromKind = (kind: InsertKind): Step => {
  if (kind === 'wait') return newWaitStep();
  if (kind === 'if' || kind === 'loop' || kind === 'try') return newStructuralStep(kind);
  return newWaitForStep(kind.kind);
};

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
    activeStepId: null,
    log: [],
    undoStack: [],
    redoStack: [],
    recordWaits: true,
    appSettings: DEFAULT_APP_SETTINGS,

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

    async deleteFlow(id: string) {
      try {
        await window.hermes.flowDelete(id);
        const current = get().currentFlow;
        if (current?.id === id) {
          // The open flow just got nuked; clear it so the editor doesn't
          // keep referencing a vanished disk path.
          set({ currentFlow: null, selectedStepId: null, dirty: false, undoStack: [], redoStack: [] });
        }
        await get().loadFlows();
      } catch (e) {
        get().appendLog({
          ts: Date.now(),
          level: 'error',
          message: `削除に失敗: ${(e as Error).message}`,
        });
        throw e;
      }
    },

    async duplicateFlow(id: string, newName: string) {
      try {
        const { flow } = (await window.hermes.flowDuplicate(id, newName)) as { flow: Flow };
        await get().loadFlows();
        return flow;
      } catch (e) {
        get().appendLog({
          ts: Date.now(),
          level: 'error',
          message: `複製に失敗: ${(e as Error).message}`,
        });
        throw e;
      }
    },

    async renameFlow(id: string, newName: string) {
      try {
        const { flow } = (await window.hermes.flowRename(id, newName)) as { flow: Flow };
        // If the renamed flow is currently open, keep the editor's copy in sync.
        const current = get().currentFlow;
        if (current?.id === id) {
          set({ currentFlow: { ...current, name: flow.name, updatedAt: flow.updatedAt } });
        }
        await get().loadFlows();
      } catch (e) {
        get().appendLog({
          ts: Date.now(),
          level: 'error',
          message: `名前変更に失敗: ${(e as Error).message}`,
        });
        throw e;
      }
    },

    async loadAppSettings() {
      try {
        const { settings } = (await window.hermes.settingsGet()) as { settings: AppSettings };
        set({ appSettings: settings });
      } catch (e) {
        get().appendLog({
          ts: Date.now(),
          level: 'error',
          message: `アプリ設定の読み込みに失敗: ${(e as Error).message}`,
        });
      }
    },

    async setAppSettings(next: AppSettings) {
      // Update the local cache eagerly so the form feels instant; if the
      // round-trip fails we surface the error in the log but leave the
      // optimistic value in place — the next read will reconcile.
      set({ appSettings: next });
      try {
        await window.hermes.settingsSet(next);
      } catch (e) {
        get().appendLog({
          ts: Date.now(),
          level: 'error',
          message: `アプリ設定の保存に失敗: ${(e as Error).message}`,
        });
        throw e;
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

    insertStepAt(beforeStepId, kind) {
      const flow = get().currentFlow;
      if (!flow) return;
      const newStep = buildStepFromKind(kind);
      const steps = insertBeforeInTree(flow.steps, beforeStepId, newStep);
      const next = { ...flow, steps };
      recordEdit(flow, next);
      set({ currentFlow: next, dirty: true, selectedStepId: newStep.id });
    },

    appendQuickStep(kind) {
      const flow = get().currentFlow;
      if (!flow) return;
      const newStep = buildStepFromKind(kind);
      const next = { ...flow, steps: [...flow.steps, newStep] };
      recordEdit(flow, next);
      set({ currentFlow: next, dirty: true, selectedStepId: newStep.id });
    },

    convertWaitKind(stepId, targetKind) {
      const flow = get().currentFlow;
      if (!flow) return;
      // Pull the current step out so we can carry the existing ms /
      // timeoutMs into the new shape — preserves the user's intent when
      // they flip "1500ms wait" into "wait for page load (1500ms timeout)".
      const current = findStepInTree(flow.steps, stepId);
      if (!current) return;
      const carry = current.params ?? {};

      let patch: Partial<Step>;
      if (targetKind === 'time') {
        const ms = Number(carry['ms'] ?? carry['timeoutMs'] ?? 500);
        patch = { type: 'wait', params: { ms } };
      } else {
        patch = {
          type: 'wait_for',
          params: defaultsForWaitForKind(targetKind, carry),
        };
      }

      const steps = updateInTree(flow.steps, stepId, patch);
      const next = { ...flow, steps };
      recordEdit(flow, next);
      set({ currentFlow: next, dirty: true });
    },

    setRecordWaits(enabled: boolean) {
      set({ recordWaits: enabled });
      // Fire-and-forget IPC so the main-process recorder picks it up;
      // we don't await because the UI shouldn't block on a toggle.
      void window.hermes.recorderSetRecordWaits(enabled).catch(() => {
        // best-effort — if the recorder isn't running yet, the next
        // start will pick up the renderer's value via a separate path.
      });
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
      // When a run ends, drop the active-step highlight so the timeline
      // doesn't keep a stale "currently here" marker.
      set(running ? { running } : { running, activeStepId: null });
    },

    setActiveStep(id: string | null) {
      set({ activeStepId: id });
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
