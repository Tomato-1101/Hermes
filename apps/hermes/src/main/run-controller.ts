/**
 * RunController — Main-process orchestrator for Hermes.
 *
 * Holds the currently active WebProvider / WebRecorder / StepExecutor and
 * brokers calls from the IPC layer. One RunController instance per Hermes
 * app process (singleton).
 */
import { readdir, stat } from 'node:fs/promises';
import type { BrowserWindow } from 'electron';
import {
  CURRENT_SCHEMA_VERSION,
  newId,
  type Flow,
  type Step,
} from '@hermes/ir';
import { HandlerRegistry, StepExecutor } from '@hermes/engine';
import {
  WebProvider,
  createWebProvider,
  registerWebHandlers,
} from '@hermes/web-provider';
import { WebRecorder } from '@hermes/recorder-web';
import { FlowStore } from '@hermes/storage/flow-store';
import { Vault } from '@hermes/storage';
import { collectSecretRefs } from '@hermes/ir';
import { MacosDesktopAdapter } from '@hermes/desktop-adapter/macos';
import { DesktopProvider } from '@hermes/desktop-adapter/desktop-provider';
import { registerDesktopHandlers } from '@hermes/desktop-adapter/handlers';
import { flowProfileDir, flowsRoot } from './flow-paths.js';
import { getSidecarClient } from './sidecar.js';
import { DesktopRecorder } from './desktop-recorder.js';
import type { EventPushPayload } from '../shared/ipc.js';
import { IpcChannels } from '../shared/ipc.js';

type EmitFn = (event: EventPushPayload) => void;

export class RunController {
  private readonly store: FlowStore;
  private readonly vault: Vault;
  private provider: WebProvider | null = null;
  private desktop: DesktopProvider | null = null;
  private recorder: WebRecorder | null = null;
  private desktopRecorder: DesktopRecorder | null = null;
  private currentRecordingFlowId: string | null = null;
  private currentRecordingLayer: 'web' | 'desktop' = 'web';
  private activeRun: { runId: string; abort: AbortController } | null = null;
  private window: BrowserWindow | null = null;

  constructor() {
    this.store = new FlowStore(flowsRoot());
    this.vault = new Vault();
  }

  attachWindow(window: BrowserWindow): void {
    this.window = window;
  }

  private emit: EmitFn = (event) => {
    this.window?.webContents.send(IpcChannels.eventPush, event);
  };

  // ---- Flow CRUD ----

  async listFlows(): Promise<Array<{ id: string; name: string; updatedAt: string; stepCount: number }>> {
    const root = flowsRoot();
    try {
      const entries = await readdir(root, { withFileTypes: true });
      const out = [];
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        try {
          const flow = await this.store.readFlow(e.name);
          out.push({
            id: flow.id,
            name: flow.name,
            updatedAt: flow.updatedAt,
            stepCount: flow.steps.length,
          });
        } catch {
          // Skip directories that aren't valid flows.
        }
      }
      out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return out;
    } catch {
      return [];
    }
  }

  async createFlow(name: string): Promise<Flow> {
    const now = new Date().toISOString();
    const flow: Flow = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      id: newId(),
      name,
      createdAt: now,
      updatedAt: now,
      inputs: [],
      outputs: [],
      variables: [],
      defaults: {
        timeoutMs: 30_000,
        retry: { attempts: 1 },
        screenshotOnError: true,
        waitBetweenStepsMs: 0,
      },
      steps: [],
      metadata: {
        origin: 'recorded',
        targets: ['web'],
        requiredPermissions: [],
      },
    };
    await this.store.writeFlow(flow);
    return flow;
  }

  async openFlow(id: string): Promise<Flow> {
    return this.store.readFlow(id);
  }

  async saveFlow(flow: Flow): Promise<void> {
    flow.updatedAt = new Date().toISOString();
    await this.store.writeFlow(flow);
  }

  // ---- Recorder lifecycle ----

  async startRecording(
    flowId: string,
    startUrl?: string,
    layer: 'web' | 'desktop' = 'web',
  ): Promise<void> {
    if (this.currentRecordingFlowId) {
      throw new Error(`Recording already active for flow ${this.currentRecordingFlowId}`);
    }

    const flow = await this.store.readFlow(flowId);
    this.currentRecordingLayer = layer;

    if (layer === 'desktop') {
      await this.startDesktopRecording(flowId);
    } else {
      await this.startWebRecording(flowId, startUrl);
    }

    this.currentRecordingFlowId = flowId;
    this.emit({ type: 'recorder:state', running: true });

    // Bump updatedAt so the sidebar shows fresh activity even before any
    // steps land.
    flow.updatedAt = new Date().toISOString();
    if (layer === 'desktop' && !flow.metadata.targets.includes('desktop')) {
      flow.metadata = {
        ...flow.metadata,
        targets: [...flow.metadata.targets, 'desktop'],
      };
    }
    await this.store.writeFlow(flow);
  }

  private async startWebRecording(flowId: string, startUrl?: string): Promise<void> {
    await this.ensureProviderFor(flowId);
    if (!this.provider) throw new Error('failed to start web provider');

    if (!this.recorder) {
      // Build the recorder locally first and only assign to this.recorder
      // after attach() succeeds — otherwise a failed attach would leave
      // this.recorder set to a half-attached instance and the next
      // startRecording() call would skip re-initialization.
      const recorder = new WebRecorder();
      await recorder.attach(this.provider);
      this.recorder = recorder;
      this.recorder.on('step', (e) => {
        // For password-style inputs, persist the plaintext into the Vault
        // under the name the recorder picked (e.g. "password" or the
        // input's label). The IR step's params.text already carries the
        // `${secrets.<name>}` reference, so we just need the vault entry.
        if (e.raw.kind === 'input' && e.raw.isSecret && e.raw.value) {
          const secretName = extractSecretName(e.step);
          if (secretName) {
            void this.vault.set(secretName, e.raw.value).catch((err) => {
              this.emit({
                type: 'log',
                level: 'warn',
                message: `failed to write secret "${secretName}" to vault: ${(err as Error).message}`,
              });
            });
          }
        }
        // Append in-memory; the renderer is responsible for committing the
        // edited list back via flowSave.
        this.emit({ type: 'recorder:step', step: e.step });
      });
    }

    this.recorder.start();

    if (startUrl) {
      const normalized = normalizeStartUrl(startUrl);
      // Emit a navigation step so the IR starts with an open_url.
      const navStep: Step = {
        id: newId(),
        type: 'open_url',
        enabled: true,
        label: shortenUrl(normalized),
        params: { url: normalized, waitUntil: 'load' },
        meta: {
          recordedAt: new Date().toISOString(),
          recordedBy: 'web-recorder',
          origin: 'recorded',
        },
      };
      this.emit({ type: 'recorder:step', step: navStep });
      await this.provider.openUrl(normalized);
    }
  }

  private async startDesktopRecording(_flowId: string): Promise<void> {
    if (process.platform !== 'darwin') {
      throw new Error('Desktop recording is currently only supported on macOS');
    }
    // Reuse a single DesktopRecorder across sessions; it's stateful but
    // idempotent across start/stop.
    if (!this.desktopRecorder) {
      const recorder = new DesktopRecorder();
      this.desktopRecorder = recorder;
      recorder.on('step', (e) => {
        this.emit({ type: 'recorder:step', step: e.step });
      });
      recorder.on('error', (e) => {
        this.emit({
          type: 'log',
          level: 'warn',
          message: `desktop recorder: ${e.message}`,
        });
      });
    }
    await this.desktopRecorder.start();
  }

  async stopRecording(): Promise<void> {
    if (this.currentRecordingLayer === 'desktop') {
      if (this.desktopRecorder) await this.desktopRecorder.stop();
      this.currentRecordingFlowId = null;
      this.emit({ type: 'recorder:state', running: false });
      return;
    }
    if (!this.recorder) return;
    this.recorder.stop();
    this.currentRecordingFlowId = null;
    this.emit({ type: 'recorder:state', running: false });
  }

  // ---- Runner ----

  async startRun(flowId: string, inputs?: Record<string, unknown>): Promise<string> {
    if (this.activeRun) throw new Error('Another run is already in progress');

    const flow = await this.store.readFlow(flowId);
    const needsWeb = flow.metadata.targets.includes('web') || flow.steps.some(stepHitsLayer('web'));
    const needsDesktop = flow.metadata.targets.includes('desktop') || flow.steps.some(stepHitsLayer('desktop'));

    if (needsWeb) {
      await this.ensureProviderFor(flowId);
      if (!this.provider) throw new Error('failed to start web provider');
    }
    if (needsDesktop) {
      this.ensureDesktopProvider();
    }

    const registry = new HandlerRegistry();
    registerWebHandlers(registry);
    if (this.desktop) registerDesktopHandlers(registry);

    // Pre-fetch every secret the flow references so the engine can
    // interpolate without itself touching keytar. Unknown secrets resolve
    // to empty string — the step still runs, just types nothing.
    const secrets: Record<string, string> = {};
    for (const name of collectSecretRefsInFlow(flow)) {
      const value = await this.vault.get(name).catch(() => null);
      if (value !== null) secrets[name] = value;
    }

    const abort = new AbortController();
    const runId = newId();
    this.activeRun = { runId, abort };

    const providers: { web?: WebProvider; desktop?: DesktopProvider } = {};
    if (this.provider) providers.web = this.provider;
    if (this.desktop) providers.desktop = this.desktop;

    const executor = new StepExecutor({
      registry,
      providers,
      secrets,
    });
    executor.on((e) => {
      switch (e.type) {
        case 'run:start':
          this.emit({ type: 'run:start', flowId: e.flowId, runId });
          return;
        case 'run:end':
          this.emit({ type: 'run:end', flowId: e.flowId, runId, outcome: e.outcome });
          return;
        case 'step:start':
          this.emit({
            type: 'run:step',
            cursor: e.cursor,
            stepId: e.step.id,
            phase: 'start',
          });
          return;
        case 'step:end':
          this.emit({
            type: 'run:step',
            cursor: e.cursor,
            stepId: e.step.id,
            phase: 'end',
            outcome: e.outcome,
            ...(e.error ? { error: e.error } : {}),
          });
          return;
        case 'log':
          this.emit({ type: 'log', level: e.level, message: e.message });
          return;
      }
    });

    // run async; don't await — the IPC handler returns immediately with runId.
    void executor
      .run(flow, { signal: abort.signal, ...(inputs ? { inputs } : {}) })
      .finally(() => {
        if (this.activeRun?.runId === runId) this.activeRun = null;
      });

    return runId;
  }

  async stopRun(): Promise<void> {
    if (!this.activeRun) return;
    this.activeRun.abort.abort();
    this.activeRun = null;
  }

  // ---- Vault passthrough ----

  vaultList(): Promise<Array<{ account: string }>> {
    return this.vault.list();
  }

  vaultSet(account: string, value: string): Promise<void> {
    return this.vault.set(account, value);
  }

  vaultDelete(account: string): Promise<boolean> {
    return this.vault.delete(account);
  }

  // ---- Provider lifecycle ----

  private async ensureProviderFor(flowId: string): Promise<void> {
    if (this.provider && this.provider.isStarted()) return;
    const profile = flowProfileDir(flowId);
    // Prefer the system-installed Google Chrome over Playwright's bundled
    // Chromium so we don't have to download a separate browser binary. If
    // Chrome isn't installed the WebProvider will fall back to Chromium —
    // user can install Chrome from the official site or invoke
    // `npx playwright install chromium` themselves.
    this.provider = createWebProvider({
      profileDir: profile,
      headless: false,
      channel: 'chrome',
    });
    try {
      await this.provider.start();
    } catch (err) {
      this.provider = null;
      throw err;
    }
  }

  private ensureDesktopProvider(): void {
    if (this.desktop) return;
    if (process.platform !== 'darwin') {
      throw new Error('Desktop automation is currently only supported on macOS');
    }
    const client = getSidecarClient();
    const adapter = new MacosDesktopAdapter({ client });
    this.desktop = new DesktopProvider(adapter);
  }

  async dispose(): Promise<void> {
    await this.stopRun();
    await this.recorder?.detach();
    this.recorder = null;
    if (this.desktopRecorder) {
      await this.desktopRecorder.stop().catch(() => undefined);
      this.desktopRecorder = null;
    }
    await this.provider?.close();
    this.provider = null;
    if (this.desktop) {
      await this.desktop.adapter.dispose();
      this.desktop = null;
    }
    this.currentRecordingFlowId = null;
  }
}

/**
 * Walk an entire Flow (steps, children, branches) and return every
 * `${secrets.<name>}` placeholder referenced anywhere in params.
 */
function collectSecretRefsInFlow(flow: Flow): string[] {
  const names = new Set<string>();
  const visit = (s: Step): void => {
    for (const n of collectSecretRefs(s.params)) names.add(n);
    if (s.children) s.children.forEach(visit);
    if (s.branches) s.branches.forEach((b) => b.steps.forEach(visit));
  };
  flow.steps.forEach(visit);
  return [...names];
}

/**
 * Extract the secret name from a recorder-emitted step whose params.text
 * is the `${secrets.<name>}` placeholder. Returns null if the step is
 * not in that shape.
 */
function extractSecretName(step: Step): string | null {
  const t = step.params?.['text'];
  if (typeof t !== 'string') return null;
  const m = t.match(/^\$\{secrets\.([^}]+)\}$/);
  return m && m[1] ? m[1] : null;
}

function stepHitsLayer(layer: 'web' | 'desktop'): (s: Step) => boolean {
  return (step) => {
    if (step.target?.layer === layer) return true;
    if (step.children) return step.children.some(stepHitsLayer(layer));
    if (step.branches) {
      return step.branches.some((b) => b.steps.some(stepHitsLayer(layer)));
    }
    return false;
  };
}

function shortenUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.host + u.pathname;
  } catch {
    return url.slice(0, 40);
  }
}

/**
 * Accept `example.com`, `https://example.com`, `http://127.0.0.1:8080`,
 * or `localhost:5173` and return something Playwright can navigate to.
 * Throws if the input is so malformed that no URL can be derived.
 */
function normalizeStartUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('empty start URL');
  const hasScheme = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(trimmed);
  const candidate = hasScheme ? trimmed : `https://${trimmed}`;
  try {
    return new URL(candidate).toString();
  } catch {
    throw new Error(`invalid URL: ${input}`);
  }
}

/** Diagnostic helper for the flow listing UI. */
export async function flowsExistOnDisk(): Promise<boolean> {
  try {
    const s = await stat(flowsRoot());
    if (!s.isDirectory()) return false;
    const entries = await readdir(flowsRoot());
    return entries.length > 0;
  } catch {
    return false;
  }
}
