/**
 * RunController — Main-process orchestrator for Hermes.
 *
 * Holds the currently active WebProvider / WebRecorder / StepExecutor and
 * brokers calls from the IPC layer. One RunController instance per Hermes
 * app process (singleton).
 */
import { cp, readdir, stat } from 'node:fs/promises';
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
import {
  registerClipboardHandlers,
  registerDesktopHandlers,
  registerScreenHandlers,
} from '@hermes/desktop-adapter/handlers';
import { flowProfileDir, flowsRoot } from './flow-paths.js';
import { getSidecarClient } from './sidecar.js';
import { DesktopRecorder } from './desktop-recorder.js';
import {
  loadSettings,
  saveSettings,
  type AppSettings,
} from './app-settings.js';
import { chromeSingletonLockExists, isChromeRunning } from './chrome-process.js';
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
  /** Persists across recording sessions so the renderer's toggle is sticky. */
  private recordWaits = true;

  private settingsCache: AppSettings | null = null;

  constructor() {
    this.store = new FlowStore(flowsRoot());
    this.vault = new Vault();
  }

  // ---- App settings ----

  /**
   * Lazily read settings.json from disk. We cache the parsed object so the
   * hot path (every run/recording start) doesn't pay the file-read cost, but
   * `getSettings({ force: true })` and any setSettings() call invalidate the
   * cache so renderer-driven edits propagate without an app restart.
   */
  async getSettings(opts?: { force?: boolean }): Promise<AppSettings> {
    if (this.settingsCache && !opts?.force) return this.settingsCache;
    this.settingsCache = await loadSettings();
    return this.settingsCache;
  }

  async setSettings(next: Partial<AppSettings>): Promise<void> {
    // Base merge on disk state (not DEFAULT_SETTINGS) so a partial patch like
    // { browser: { systemChromePath: '/x' } } doesn't blow away unrelated
    // fields the user previously set. saveSettings() does its own
    // mergeDeep-with-disk, but doing the merge here too keeps settingsCache
    // self-consistent without a second loadSettings() round-trip.
    const current = await this.getSettings();
    const merged: AppSettings = {
      browser: { ...current.browser, ...(next.browser ?? {}) },
      humanize: { ...current.humanize, ...(next.humanize ?? {}) },
    };
    await saveSettings(merged);
    this.settingsCache = merged;
    // Force any active provider to be rebuilt on next use — the browser
    // flags / user-data-dir may have changed.
    if (this.provider) {
      await this.provider.close().catch(() => undefined);
      this.provider = null;
    }
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
        // Empty until something is actually recorded; startRun infers from
        // steps so this hint can stay descriptive without controlling
        // provider selection.
        targets: [],
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

  async deleteFlow(id: string): Promise<void> {
    if (this.currentRecordingFlowId === id) {
      throw new Error('Cannot delete the flow that is currently being recorded.');
    }
    if (this.activeRun) {
      throw new Error('Cannot delete a flow while a run is in progress.');
    }
    // Drop any provider tied to the deleted profile dir before nuking the
    // directory — otherwise Playwright keeps the file handles open and
    // Chrome may rewrite Preferences during teardown, recreating the dir.
    if (this.provider) {
      await this.provider.close().catch(() => undefined);
      this.provider = null;
    }
    await this.store.deleteFlow(id);
  }

  async duplicateFlow(srcId: string, newName: string): Promise<Flow> {
    const now = new Date().toISOString();
    const dstId = newId();
    const copy = await this.store.duplicateFlow(srcId, {
      // FlowStore.duplicateFlow only consumes id/name/meta from this skeleton —
      // every other field is taken from the source flow on disk.
      schemaVersion: CURRENT_SCHEMA_VERSION,
      id: dstId,
      name: newName,
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
      metadata: { origin: 'recorded', targets: [], requiredPermissions: [] },
    });
    // Stamp fresh timestamps so the duplicate sorts to the top of the list
    // and doesn't impersonate the source's creation date.
    copy.createdAt = now;
    copy.updatedAt = now;
    await this.store.writeFlow(copy);
    return copy;
  }

  async renameFlow(id: string, newName: string): Promise<Flow> {
    const flow = await this.store.readFlow(id);
    flow.name = newName;
    flow.updatedAt = new Date().toISOString();
    await this.store.writeFlow(flow);
    return flow;
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
    // steps land. Keep metadata.targets in sync as a descriptive hint
    // (the runner derives needsWeb/needsDesktop from steps directly, so
    // this hint is no longer load-bearing — but stays useful for UI badges).
    flow.updatedAt = new Date().toISOString();
    if (!flow.metadata.targets.includes(layer)) {
      flow.metadata = {
        ...flow.metadata,
        targets: [...flow.metadata.targets, layer],
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
      recorder.setRecordWaits(this.recordWaits);
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
      recorder.setRecordWaits(this.recordWaits);
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

  /** UI toggle — applied to any active or future recorder instance. */
  setRecordWaits(enabled: boolean): void {
    this.recordWaits = enabled;
    this.recorder?.setRecordWaits(enabled);
    this.desktopRecorder?.setRecordWaits(enabled);
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
    // Drive provider selection from the actual recorded steps, not from
    // metadata.targets. metadata.targets is a stale hint — createFlow seeds
    // it as ['web'] and startRecording only ADDs to it, so a desktop-only
    // recording ends up tagged ['web','desktop'] and used to spin up a
    // Playwright Chrome the user never asked for. The steps themselves are
    // the source of truth: WebRecorder emits target.layer='web' (or an
    // open_url step), DesktopRecorder emits target.layer='desktop'.
    const needsWeb = flow.steps.some(stepNeedsLayer('web'));
    // Screen-layer steps (image / OCR / coords) ride the desktop sidecar, so
    // they imply the desktop provider too — but they additionally need the
    // screen handlers registered and an assets dir for image templates.
    const needsScreen = flow.steps.some(stepNeedsLayer('screen'));
    // Clipboard steps are targetless but also ride the sidecar.
    const needsClipboard = flow.steps.some(stepUsesClipboard);
    const needsDesktop =
      needsScreen || needsClipboard || flow.steps.some(stepNeedsLayer('desktop'));

    // Log the decision so the user can see in the log panel WHY a provider
    // is (or isn't) about to start. If "browser opens on a desktop-only
    // flow", this line proves whether the fix is actually live.
    this.emit({
      type: 'log',
      level: 'info',
      message: `再生: needsWeb=${needsWeb} needsDesktop=${needsDesktop} (steps=${flow.steps.length})`,
    });

    // Fold pre-click mouse moves INTO the preceding `wait` step so the
    // click fires at the recorded rhythm instead of "wait, then sudden
    // teleport-fast move, then click" with the move duration tacked on
    // top. See absorbDesktopMovesIntoWaits() for the rewrite rules.
    if (needsDesktop) {
      const settings = await this.getSettings();
      const absorbed = absorbDesktopMovesIntoWaits(
        flow.steps,
        settings.humanize.mouseSpeedPxPerSec,
      );
      if (absorbed.rewrites > 0) {
        flow.steps = absorbed.steps;
        this.emit({
          type: 'log',
          level: 'info',
          message: `wait→click ${absorbed.rewrites} 件で移動を待ち時間に吸収しました`,
        });
        if (absorbed.compressed > 0) {
          // Wait-time priority: when natural move > recorded wait, the
          // move gets compressed into the wait window so the click
          // lands on the recorded beat. Surface the worst-case ratio
          // so the user sees their mouseSpeedPxPerSec was overridden.
          this.emit({
            type: 'log',
            level: 'warn',
            message: `うち ${absorbed.compressed} 件は待ち時間が短いため、録画リズム優先でマウスを最大 ${absorbed.maxCompressionRatio.toFixed(1)}× に加速しました`,
          });
        }
      }
    }

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
    if (this.desktop && needsScreen) registerScreenHandlers(registry);
    if (this.desktop && needsClipboard) registerClipboardHandlers(registry);

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

    // Inject AppSettings.humanize as a pseudo-input. Web/desktop handlers
    // pick it up under the same key (ctx.vars.__hermes_humanize__), so the
    // step.params override path keeps working unchanged. Flow-level
    // defaults.humanize wins over AppSettings when present.
    const settings = await this.getSettings();
    const flowHumanize = flow.defaults['humanize'] as
      | Partial<typeof settings.humanize>
      | undefined;
    const humanize = { ...settings.humanize, ...(flowHumanize ?? {}) };
    const seededInputs: Record<string, unknown> = {
      ...(inputs ?? {}),
      __hermes_humanize__: humanize,
      // Image-selector assetRefs are stored relative to the flow dir
      // (e.g. "assets/btn.png"); the screen handlers resolve them against
      // this base. Mirrors runFlowFile's dirname(flow file) in the CLI.
      ...(needsScreen ? { __hermes_assets_dir__: this.store.flowDir(flowId) } : {}),
    };

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
      .run(flow, { signal: abort.signal, inputs: seededInputs })
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
    const settings = await this.getSettings();
    const channel = settings.browser.channel ?? 'chrome';
    let profileDir = flowProfileDir(flowId);

    if (settings.browser.mode === 'system-chrome') {
      const chromePath = settings.browser.systemChromePath;
      if (!chromePath) {
        throw new Error(
          'ブラウザモードが「system-chrome」ですが Chrome プロファイルが未設定です。「アプリ設定」からプロファイルを選択してください。',
        );
      }
      if (await isChromeRunning()) {
        const msg =
          'Google Chrome がまだ起動しています。共有プロファイルを使う前に Cmd-Q で完全終了してください。';
        this.emit({ type: 'log', level: 'error', message: msg });
        throw new Error(msg);
      }
      // SingletonLock survives crashes / forced kills. If Chrome is "not
      // running" by pgrep but the lock file is still on disk, Playwright
      // will fail with a confusing "Target page closed" — bail out with a
      // user-actionable error instead.
      if (chromeSingletonLockExists(chromePath)) {
        const msg =
          'Chrome のロックファイル (SingletonLock) がまだ残っています。Chrome を一度起動して正常終了するか、プロファイル内の SingletonLock を削除してください。';
        this.emit({ type: 'log', level: 'error', message: msg });
        throw new Error(msg);
      }
      profileDir = chromePath;
    } else if (settings.browser.mode === 'system-chrome-import') {
      const chromePath = settings.browser.systemChromePath;
      if (!chromePath) {
        throw new Error(
          'ブラウザモードが「system-chrome-import」ですが Chrome プロファイルが未設定です。「アプリ設定」からプロファイルを選択してください。',
        );
      }
      // import モードは Chrome が起動中でも衝突しない（コピーするだけ）が、
      // Cookies の SQLite を Chrome が WAL モードで書いている最中だと
      // 整合性が崩れたコピーになる。動作中の Chrome があれば一言警告だけ
      // 出して続行する（強行できる方が利便性が高い）。
      if (await isChromeRunning()) {
        this.emit({
          type: 'log',
          level: 'warn',
          message: 'Chrome が起動中のままインポートします。Cookies の整合性が崩れる可能性があります。',
        });
      }
      profileDir = flowProfileDir(flowId);
      await importChromeProfile(chromePath, profileDir).catch((err) => {
        this.emit({
          type: 'log',
          level: 'warn',
          message: `Chrome profile import failed: ${(err as Error).message}`,
        });
      });
    }

    this.provider = createWebProvider({
      profileDir,
      headless: false,
      channel,
    });
    try {
      await this.provider.start();
    } catch (err) {
      this.provider = null;
      throw translatePlaywrightLaunchError(err, settings.browser.mode);
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

/**
 * Returns true when `step` (or one of its nested children / branch bodies)
 * requires the given provider to be running. We look at `step.target.layer`
 * first, then fall back to type-based heuristics for steps that carry no
 * target — `open_url` is web-only by design, since only WebProvider knows
 * how to navigate. `if`/`loop` containers recurse into their children.
 */
const WEB_IMPLIED_TYPES = new Set(['open_url']);

function stepNeedsLayer(layer: 'web' | 'desktop' | 'screen'): (s: Step) => boolean {
  return (step) => {
    if (step.target?.layer === layer) return true;
    if (layer === 'web' && WEB_IMPLIED_TYPES.has(step.type)) return true;
    if (step.children && step.children.some(stepNeedsLayer(layer))) return true;
    if (step.branches && step.branches.some((b) => b.steps.some(stepNeedsLayer(layer)))) {
      return true;
    }
    return false;
  };
}

/** Clipboard steps are targetless, so detection is by step type (recursive). */
function stepUsesClipboard(step: Step): boolean {
  if (step.type === 'clipboard_read' || step.type === 'clipboard_write') return true;
  if (step.children && step.children.some(stepUsesClipboard)) return true;
  if (step.branches && step.branches.some((b) => b.steps.some(stepUsesClipboard))) return true;
  return false;
}

/**
 * Rewrite a `wait(N) → click(@x,y)` sequence (when the click is desktop-
 * layer with coords) so the cursor STARTS MOVING during the wait and
 * arrives at the click target exactly when the click fires. The recorded
 * inter-click rhythm is preserved.
 *
 * Concretely, for each such pair we:
 *   - Compute the natural move duration M = distance / mouseSpeedPxPerSec.
 *   - If M ≤ waitMs: shrink the wait to (waitMs − M); the click's own
 *     pre-move (at the user's configured speed) consumes the residual M.
 *     Net wall-clock time from previous action: still waitMs.
 *   - If M > waitMs: the natural move can't fit. Compress the move into
 *     waitMs (faster effective speed for this hop) and zero out the wait.
 *     The click STILL fires waitMs after the previous action — the user's
 *     "don't shift click timing" rule wins over the "move slower than the
 *     recording" rule.
 *
 * Mouse-position tracking is purely static: each desktop click moves the
 * cursor to its coords, so we follow along by remembering the last clicked
 * coords. If we lose track (non-coord step, web layer, etc.) we wait until
 * the next click to start tracking again — that click's move runs at
 * natural duration with no wait absorption.
 *
 * Returns a possibly-new steps array and a rewrites count for the log.
 * Original Step objects are NOT mutated — affected steps are shallow-copied.
 */
function absorbDesktopMovesIntoWaits(
  steps: Step[],
  speedPxPerSec: number,
): { steps: Step[]; rewrites: number; compressed: number; maxCompressionRatio: number } {
  const out = steps.slice();
  let knownPos: { x: number; y: number } | null = null;
  let rewrites = 0;
  // Separate counter for the wait-priority compression path: the move
  // would naturally take longer than the recorded wait, so we squeeze
  // it into the wait window so the click still lands at the recorded
  // rhythm. Surfaced in the log so the user can tell when their
  // configured mouseSpeedPxPerSec is being violated to honour timing.
  let compressed = 0;
  let maxCompressionRatio = 1;
  const safeSpeed = Math.max(50, speedPxPerSec);

  for (let i = 0; i < out.length; i++) {
    const cur = out[i]!;
    const prev = i > 0 ? out[i - 1] : null;
    if (cur.type !== 'click' || cur.target?.layer !== 'desktop') {
      // Anything else either resets our positional knowledge (a wait alone,
      // a key combo, a type) or we just don't model it. Update knownPos
      // only on desktop clicks below.
      continue;
    }
    const coordCand = cur.target.candidates.find((c) => c.kind === 'coords');
    if (!coordCand || coordCand.kind !== 'coords') {
      knownPos = null;
      continue;
    }
    const dst = { x: coordCand.x, y: coordCand.y };

    if (prev && prev.type === 'wait' && knownPos) {
      const waitMs = Number(prev.params?.['ms'] ?? 0);
      if (waitMs > 0) {
        const dx = dst.x - knownPos.x;
        const dy = dst.y - knownPos.y;
        const distance = Math.hypot(dx, dy);
        const naturalMoveMs = (distance / safeSpeed) * 1000;
        if (naturalMoveMs <= waitMs) {
          // Wait covers the move. Shrink wait by exactly the natural move
          // duration; the click does its own move at natural speed.
          const remainingWait = Math.max(0, Math.round(waitMs - naturalMoveMs));
          const newPrev: Step = {
            ...prev,
            params: { ...(prev.params ?? {}), ms: remainingWait },
          };
          // Mark the wait so user can see in the IR what was absorbed.
          newPrev.label = `${remainingWait}ms 待機（うち ${Math.round(naturalMoveMs)}ms は移動と重ね）`;
          out[i - 1] = newPrev;
          rewrites++;
        } else {
          // Move at the configured speed wouldn't fit in the recorded
          // wait. User policy is "wait time priority": the click must
          // land at the same beat as the recording, so we squeeze the
          // move into exactly waitMs by passing durationMsOverride.
          // This temporarily violates mouseSpeedPxPerSec — the move
          // runs at an EFFECTIVE speed of (distance / waitMs) px/s,
          // which can be faster than the setting. We log the ratio so
          // the user knows their setting was overridden.
          const ratio = naturalMoveMs / waitMs;
          if (ratio > maxCompressionRatio) maxCompressionRatio = ratio;
          const newPrev: Step = {
            ...prev,
            params: { ...(prev.params ?? {}), ms: 0 },
            label: `${waitMs}ms 待機（移動に置換 ×${ratio.toFixed(1)} 速度）`,
          };
          const newCur: Step = {
            ...cur,
            params: { ...(cur.params ?? {}), moveDurationMs: waitMs },
          };
          out[i - 1] = newPrev;
          out[i] = newCur;
          rewrites++;
          compressed++;
        }
      }
    }

    knownPos = dst;
  }

  return { steps: out, rewrites, compressed, maxCompressionRatio };
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

/**
 * Copy the user-visible parts of a Chrome profile (cookies, localStorage,
 * IndexedDB, Preferences) into a Hermes-managed profile directory.
 *
 * We deliberately skip Chrome's caches and per-process Singleton* locks so
 * the embedded Chromium doesn't fight the original Chrome over file
 * ownership, and so the copy completes in a fraction of a second instead of
 * gigabytes worth of cache.
 */
async function importChromeProfile(srcChromePath: string, dstProfileDir: string): Promise<void> {
  // Source layout: <userDataDir>/<ProfileFolder>/{Cookies,Login Data,...}
  // We accept either a path that already points at a profile folder
  // ("Default", "Profile 1", ...) or the parent user-data-dir; if the latter
  // we look for ./Default. `userDataDir` is always the parent — `Local State`
  // and other root-level files live there, NOT inside `Default/`.
  const { existsSync } = await import('node:fs');
  if (!existsSync(srcChromePath)) {
    throw new Error(`Chrome profile path does not exist: ${srcChromePath}`);
  }
  const { join, basename } = await import('node:path');
  let fromProfile = srcChromePath;
  let fromUserDataDir = join(srcChromePath, '..');
  if (existsSync(join(srcChromePath, 'Default')) && !existsSync(join(srcChromePath, 'Cookies'))) {
    // Caller passed the user-data-dir. Profile is one level deeper.
    fromProfile = join(srcChromePath, 'Default');
    fromUserDataDir = srcChromePath;
  }

  // Per-profile state — login cookies, history, preferences, local storage.
  const wantedProfile = [
    'Cookies',
    'Cookies-journal',
    'Login Data',
    'Login Data-journal',
    'Preferences',
    'Secure Preferences',
    'Local Storage',
    'IndexedDB',
    'Session Storage',
    'Web Data',
    'History',
    'Bookmarks',
    'Favicons',
    'Top Sites',
    'Network',
  ];
  // user-data-dir level state. `Local State` holds the AES-GCM key used to
  // decrypt Cookies — without it Chrome can't decrypt the cookie values it
  // just copied, so the user appears logged out and reCAPTCHA fires.
  const wantedRoot = ['Local State'];

  const { mkdir } = await import('node:fs/promises');
  await mkdir(dstProfileDir, { recursive: true });
  // Mirror Chrome's layout: profile data inside `Default/`, root-level files
  // (Local State) at the user-data-dir root that the embedded Chromium
  // launches against.
  const dstProfile = join(dstProfileDir, 'Default');
  await mkdir(dstProfile, { recursive: true });

  for (const name of wantedProfile) {
    const src = join(fromProfile, name);
    const dst = join(dstProfile, name);
    if (!existsSync(src)) continue;
    await cp(src, dst, { recursive: true, force: true, errorOnExist: false }).catch(() => undefined);
  }
  for (const name of wantedRoot) {
    const src = join(fromUserDataDir, name);
    const dst = join(dstProfileDir, name);
    if (!existsSync(src)) continue;
    await cp(src, dst, { recursive: true, force: true, errorOnExist: false }).catch(() => undefined);
  }
  // Track which source profile we cloned, in case we want a "re-import" UI
  // later. Cheap to write, harmless if absent.
  void basename;
}

/**
 * Playwright's launchPersistentContext throws cryptic errors when Chrome's
 * SingletonLock blocks it — "Target page, context or browser has been closed"
 * or the Chrome stdout "既存のブラウザ セッションで開いています". Both mean
 * the same thing to the user: "quit Chrome first". Translate them so the
 * renderer log shows actionable text instead of Playwright internals.
 */
function translatePlaywrightLaunchError(err: unknown, mode: AppSettings['browser']['mode']): Error {
  const original = err instanceof Error ? err : new Error(String(err));
  const msg = original.message || '';
  const looksLikeSingletonContention =
    /Target (page|context|browser) (has been )?closed/i.test(msg) ||
    /既存のブラウザ\s*セッション/.test(msg) ||
    /SingletonLock/i.test(msg) ||
    /ProcessSingleton/i.test(msg);
  if (looksLikeSingletonContention) {
    const hint =
      mode === 'system-chrome'
        ? 'Chrome がまだ起動しています。Cmd-Q で完全終了してから再生してください。それでも続く場合は「アプリ設定」でモードを「system-chrome-import」に切り替えてください。'
        : 'ブラウザの起動に失敗しました。Chrome が完全終了しているか、選択したプロファイルが他のプロセスから使われていないか確認してください。';
    const wrapped = new Error(hint);
    (wrapped as { cause?: unknown }).cause = original;
    return wrapped;
  }
  return original;
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
