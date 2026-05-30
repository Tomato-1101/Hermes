import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import { Fragment, createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { WAIT_FOR_KINDS, type WaitForKind } from '@hermes/ir';
import { useStore, type AppSettings, type FlowSummary, type InsertKind, type Step } from './store.js';

/** Inline-insert menu rows + their canonical InsertKind payload. Keeps the
 *  popup, the Inspector's converter, and the Toolbar quick-add buttons in
 *  sync on labels and order. */
const INSERT_MENU: Array<{ label: string; kind: InsertKind }> = [
  { label: '時間で待つ', kind: 'wait' },
  { label: 'ページのロード完了で次へ', kind: { type: 'wait_for', kind: 'web.load' } },
  { label: '要素の出現で次へ', kind: { type: 'wait_for', kind: 'web.element' } },
  { label: 'URL の一致で次へ', kind: { type: 'wait_for', kind: 'web.url' } },
  { label: 'アプリのフォーカスで次へ', kind: { type: 'wait_for', kind: 'desktop.app_focus' } },
  { label: 'ウィンドウタイトルで次へ', kind: { type: 'wait_for', kind: 'desktop.window_title' } },
  { label: '画面が落ち着いたら次へ', kind: { type: 'wait_for', kind: 'desktop.screen_stable' } },
  { label: 'AX 要素の出現で次へ (デスクトップ)', kind: { type: 'wait_for', kind: 'desktop.element' } },
  { label: 'カスタム条件式で次へ', kind: { type: 'wait_for', kind: 'expr' } },
];

const WAIT_FOR_LABEL: Record<WaitForKind, string> = {
  time: '時間で待つ',
  'web.load': 'ページロード完了',
  'web.element': '要素の出現',
  'web.url': 'URL の一致',
  'desktop.element': 'AX 要素の出現',
  'desktop.app_focus': 'アプリのフォーカス',
  'desktop.window_title': 'ウィンドウタイトル',
  'desktop.screen_stable': '画面が落ち着いた',
  expr: 'カスタム条件式',
};

// ---------------------------------------------------------------------------
// Prompt modal
//
// Electron 33 disables window.prompt / alert / confirm in the renderer
// (they block the renderer's event loop). We provide an async replacement
// via context — call sites do `const v = await prompt({ title, defaultValue })`.
// ---------------------------------------------------------------------------

type PromptOpts = { title: string; defaultValue?: string; placeholder?: string };
type PromptFn = (opts: PromptOpts) => Promise<string | null>;

const PromptContext = createContext<PromptFn | null>(null);

function usePrompt(): PromptFn {
  const fn = useContext(PromptContext);
  if (!fn) throw new Error('usePrompt must be used inside <PromptProvider>');
  return fn;
}

function PromptProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<{
    opts: PromptOpts;
    resolve: (v: string | null) => void;
  } | null>(null);
  const [value, setValue] = useState('');

  const prompt = useCallback<PromptFn>((opts) => {
    setValue(opts.defaultValue ?? '');
    return new Promise<string | null>((resolve) => setRequest({ opts, resolve }));
  }, []);

  const close = (result: string | null): void => {
    request?.resolve(result);
    setRequest(null);
  };

  return (
    <PromptContext.Provider value={prompt}>
      {children}
      {request && (
        <div className="modal-overlay" onClick={() => close(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{request.opts.title}</h3>
            <input
              autoFocus
              value={value}
              placeholder={request.opts.placeholder ?? ''}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') close(value);
                if (e.key === 'Escape') close(null);
              }}
            />
            <div className="modal-actions">
              <button onClick={() => close(null)}>キャンセル</button>
              <button className="primary" onClick={() => close(value)}>OK</button>
            </div>
          </div>
        </div>
      )}
    </PromptContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Confirm modal
//
// The PromptProvider's sibling. We need an async confirm() for destructive
// flow-list actions (delete) where a free-text input feels wrong. Same
// modal styling, just a message + OK/Cancel.
// ---------------------------------------------------------------------------

type ConfirmOpts = {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
};
type ConfirmFn = (opts: ConfirmOpts) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

function useConfirm(): ConfirmFn {
  const fn = useContext(ConfirmContext);
  if (!fn) throw new Error('useConfirm must be used inside <ConfirmProvider>');
  return fn;
}

function ConfirmProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<{
    opts: ConfirmOpts;
    resolve: (v: boolean) => void;
  } | null>(null);

  const confirm = useCallback<ConfirmFn>((opts) => {
    return new Promise<boolean>((resolve) => setRequest({ opts, resolve }));
  }, []);

  const close = (result: boolean): void => {
    request?.resolve(result);
    setRequest(null);
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {request && (
        <div className="modal-overlay" onClick={() => close(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{request.opts.title}</h3>
            {request.opts.message && <p className="muted">{request.opts.message}</p>}
            <div className="modal-actions">
              <button onClick={() => close(false)}>
                {request.opts.cancelLabel ?? 'キャンセル'}
              </button>
              <button
                className={request.opts.danger ? 'danger' : 'primary'}
                autoFocus
                onClick={() => close(true)}
              >
                {request.opts.confirmLabel ?? 'OK'}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}

type AppInfo = {
  name: string;
  version: string;
  electron: string;
  node: string;
  platform: string;
  arch: string;
};

type EventPush =
  | { type: 'recorder:step'; step: Step }
  | { type: 'recorder:state'; running: boolean }
  | { type: 'run:start'; flowId: string; runId: string }
  | { type: 'run:end'; flowId: string; runId: string; outcome: string }
  | { type: 'run:step'; cursor: string; stepId: string; phase: 'start' | 'end'; outcome?: string; error?: string }
  | { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string };

export function App() {
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    void window.hermes.appInfo().then(setAppInfo as never);
  }, []);

  // Global Undo/Redo keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        useStore.getState().undo();
      } else if ((e.key === 'z' && e.shiftKey) || e.key === 'y') {
        e.preventDefault();
        useStore.getState().redo();
      } else if (e.key === 's') {
        e.preventDefault();
        void useStore.getState().saveFlow();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    void useStore.getState().loadFlows();
    void useStore.getState().loadAppSettings();
    const unsub = window.hermes.onEvent((raw) => {
      const e = raw as EventPush;
      const s = useStore.getState();
      switch (e.type) {
        case 'recorder:step':
          s.appendStep(e.step);
          return;
        case 'recorder:state':
          s.setRecording(e.running);
          return;
        case 'run:start':
          s.setRunning(true);
          s.appendLog({ ts: Date.now(), level: 'info', message: `Run ${e.runId.slice(-6)} started` });
          return;
        case 'run:end':
          s.setRunning(false);
          s.appendLog({
            ts: Date.now(),
            level: e.outcome === 'success' ? 'info' : 'error',
            message: `Run ${e.runId.slice(-6)} ${e.outcome}`,
          });
          return;
        case 'run:step':
          if (e.phase === 'end' && e.outcome !== 'completed') {
            s.appendLog({
              ts: Date.now(),
              level: 'warn',
              message: `Step ${e.cursor} ${e.outcome}${e.error ? `: ${e.error}` : ''}`,
            });
          }
          return;
        case 'log':
          s.appendLog({ ts: Date.now(), level: e.level, message: e.message });
          return;
      }
    });
    return unsub;
  }, []);

  return (
    <PromptProvider>
      <ConfirmProvider>
        <div className="app">
          <FlowSidebar />
          <Editor />
          <Inspector appInfo={appInfo} />
        </div>
      </ConfirmProvider>
    </PromptProvider>
  );
}

// ---------------------------------------------------------------------------
// Sidebar: list of flows + Create button
// ---------------------------------------------------------------------------

function FlowSidebar() {
  const flows = useStore((s) => s.flows);
  const currentId = useStore((s) => s.currentFlow?.id ?? null);
  const openFlow = useStore((s) => s.openFlow);
  const createFlow = useStore((s) => s.createFlow);
  const duplicateFlow = useStore((s) => s.duplicateFlow);
  const renameFlow = useStore((s) => s.renameFlow);
  const deleteFlow = useStore((s) => s.deleteFlow);
  const prompt = usePrompt();
  const confirm = useConfirm();

  const [menu, setMenu] = useState<{ x: number; y: number; flow: FlowSummary } | null>(null);

  const onNew = async (): Promise<void> => {
    const name = await prompt({ title: '新しいフローの名前は？', defaultValue: 'Untitled flow' });
    if (!name) return;
    try {
      await createFlow(name);
    } catch {
      // Store already logged the error via appendLog; swallow here so the
      // unhandled rejection doesn't bubble to the console.
    }
  };

  const onContextMenu = (e: ReactMouseEvent<HTMLLIElement>, f: FlowSummary): void => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, flow: f });
  };

  const closeMenu = (): void => setMenu(null);

  const onMenuOpen = async (): Promise<void> => {
    const f = menu?.flow;
    closeMenu();
    if (f) await openFlow(f.id);
  };

  const onMenuDuplicate = async (): Promise<void> => {
    const f = menu?.flow;
    closeMenu();
    if (!f) return;
    const newName = await prompt({
      title: '複製後の名前',
      defaultValue: `${f.name} (copy)`,
    });
    if (!newName) return;
    try {
      await duplicateFlow(f.id, newName);
    } catch {
      // appendLog already surfaced the error
    }
  };

  const onMenuRename = async (): Promise<void> => {
    const f = menu?.flow;
    closeMenu();
    if (!f) return;
    const newName = await prompt({ title: '新しい名前', defaultValue: f.name });
    if (!newName || newName === f.name) return;
    try {
      await renameFlow(f.id, newName);
    } catch {
      // appendLog already surfaced the error
    }
  };

  const onMenuExport = async (): Promise<void> => {
    const f = menu?.flow;
    closeMenu();
    if (!f) return;
    try {
      const { flow } = (await window.hermes.flowOpen(f.id)) as { flow: unknown };
      const blob = new Blob([JSON.stringify(flow, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${sanitizeFileName(f.name)}.flow.json`;
      a.click();
      // The object URL lives until the document is unloaded; release it
      // after the click so we don't leak across many exports per session.
      setTimeout(() => URL.revokeObjectURL(url), 5_000);
    } catch (e) {
      useStore.getState().appendLog({
        ts: Date.now(),
        level: 'error',
        message: `エクスポートに失敗: ${(e as Error).message}`,
      });
    }
  };

  const onMenuDelete = async (): Promise<void> => {
    const f = menu?.flow;
    closeMenu();
    if (!f) return;
    const ok = await confirm({
      title: `「${f.name}」を削除しますか？`,
      message: 'このフロー（ステップ・履歴・ブラウザプロファイル）が完全に削除されます。元に戻せません。',
      confirmLabel: '削除',
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteFlow(f.id);
    } catch {
      // appendLog already surfaced the error
    }
  };

  return (
    <aside className="pane pane-left">
      <header className="pane-header">
        <span>フロー</span>
        <button type="button" onClick={onNew} className="primary">
          新規
        </button>
      </header>
      <div className="pane-body">
        {flows.length === 0 && <p className="muted">まだフローがありません。</p>}
        <ul className="flow-list">
          {flows.map((f) => (
            <li
              key={f.id}
              className={currentId === f.id ? 'active' : ''}
              onClick={() => openFlow(f.id)}
              onContextMenu={(e) => onContextMenu(e, f)}
            >
              <div className="flow-name">{f.name}</div>
              <div className="flow-meta muted">
                {f.stepCount} ステップ · {new Date(f.updatedAt).toLocaleString('ja-JP')}
              </div>
            </li>
          ))}
        </ul>
      </div>
      {menu && (
        <FlowContextMenu
          x={menu.x}
          y={menu.y}
          onClose={closeMenu}
          onOpen={() => void onMenuOpen()}
          onDuplicate={() => void onMenuDuplicate()}
          onRename={() => void onMenuRename()}
          onExport={() => void onMenuExport()}
          onDelete={() => void onMenuDelete()}
        />
      )}
    </aside>
  );
}

function FlowContextMenu(props: {
  x: number;
  y: number;
  onClose: () => void;
  onOpen: () => void;
  onDuplicate: () => void;
  onRename: () => void;
  onExport: () => void;
  onDelete: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  // Close on outside click, Escape, or window blur so the menu never gets
  // stuck open when focus moves elsewhere. Depend only on onClose — using
  // the whole `props` object would rebind every parent render, since the
  // parent creates a fresh onOpen/onDuplicate/... closure each pass.
  const onClose = props.onClose;
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('blur', onClose);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  // Best-effort viewport clamping: if the menu would overflow the right /
  // bottom edge of the window, nudge it back inside on first paint.
  const [pos, setPos] = useState({ x: props.x, y: props.y });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let { x, y } = props;
    if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 4;
    if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 4;
    setPos({ x: Math.max(0, x), y: Math.max(0, y) });
  }, [props.x, props.y]);

  return (
    <div
      ref={ref}
      className="context-menu"
      style={{ left: pos.x, top: pos.y }}
      onClick={(e) => e.stopPropagation()}
    >
      <button type="button" onClick={props.onOpen}>開く</button>
      <button type="button" onClick={props.onDuplicate}>複製</button>
      <button type="button" onClick={props.onRename}>名前を変更</button>
      <button type="button" onClick={props.onExport}>JSON をエクスポート</button>
      <div className="context-menu-sep" />
      <button type="button" className="danger" onClick={props.onDelete}>削除</button>
    </div>
  );
}

function sanitizeFileName(name: string): string {
  // Strip characters that misbehave on macOS / Windows filesystems and trim
  // whitespace; collapse the rest into a sensible default so we never hand
  // the browser an empty download name.
  const cleaned = name.replace(/[\\/:*?"<>|]/g, '_').trim();
  return cleaned.length ? cleaned : 'flow';
}

// ---------------------------------------------------------------------------
// Editor: Timeline + Toolbar + Log
// ---------------------------------------------------------------------------

function Editor() {
  const flow = useStore((s) => s.currentFlow);
  const dirty = useStore((s) => s.dirty);
  const recording = useStore((s) => s.recording);
  const running = useStore((s) => s.running);
  const saveFlow = useStore((s) => s.saveFlow);
  const log = useStore((s) => s.log);
  const clearLog = useStore((s) => s.clearLog);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const undoStackLen = useStore((s) => s.undoStack.length);
  const redoStackLen = useStore((s) => s.redoStack.length);
  const addStructuralStep = useStore((s) => s.addStructuralStep);
  const appendQuickStep = useStore((s) => s.appendQuickStep);
  const recordWaits = useStore((s) => s.recordWaits);
  const setRecordWaits = useStore((s) => s.setRecordWaits);
  const appendLog = useStore((s) => s.appendLog);
  const prompt = usePrompt();

  if (!flow) {
    return (
      <main className="pane pane-center">
        <header className="pane-header">エディタ</header>
        <div className="pane-body empty">
          <p className="muted">左から既存フローを選ぶか、「新規」で新しいフローを作成してください。</p>
        </div>
      </main>
    );
  }

  const onRecordWeb = async (): Promise<void> => {
    if (recording) {
      await window.hermes.recorderStop();
      try { await saveFlow(); } catch { /* logged via store */ }
      return;
    }
    const url = await prompt({
      title: '開始 URL（省略可、空白なら録画のみ開始）',
      defaultValue: 'https://example.com',
    });
    if (url === null) return; // user cancelled
    try {
      await window.hermes.recorderStart(flow.id, url || undefined, 'web');
    } catch (e) {
      appendLog({ ts: Date.now(), level: 'error', message: `Web 録画開始に失敗: ${(e as Error).message}` });
    }
  };

  const onRecordDesktop = async (): Promise<void> => {
    if (recording) {
      await window.hermes.recorderStop();
      try { await saveFlow(); } catch { /* logged via store */ }
      return;
    }
    try {
      await window.hermes.recorderStart(flow.id, undefined, 'desktop');
      appendLog({
        ts: Date.now(),
        level: 'info',
        message:
          'Desktop 録画開始。クリック・修飾キーがグローバルに記録されます。停止するまで他のアプリで操作してください。',
      });
    } catch (e) {
      appendLog({ ts: Date.now(), level: 'error', message: `Desktop 録画開始に失敗: ${(e as Error).message}` });
    }
  };

  const onRun = async (): Promise<void> => {
    if (running) {
      await window.hermes.runStop();
      return;
    }
    try {
      // Persist any unsaved edits before running — the engine reads the
      // flow from disk, so an in-memory-only flow would execute as the
      // last-saved (often empty) version and silently no-op.
      if (dirty) await saveFlow();
      await window.hermes.runStart(flow.id);
    } catch (e) {
      appendLog({ ts: Date.now(), level: 'error', message: `再生に失敗: ${(e as Error).message}` });
    }
  };

  return (
    <main className="pane pane-center">
      <header className="pane-header">
        <span>{flow.name}</span>
        <div className="toolbar">
          {recording ? (
            <button
              type="button"
              className="danger"
              onClick={onRecordWeb}
              disabled={running}
            >
              ■ 録画停止
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={onRecordWeb}
                disabled={running}
                title="ブラウザで操作を録画"
              >
                ● Web 録画
              </button>
              <button
                type="button"
                onClick={onRecordDesktop}
                disabled={running}
                title="アプリ（macOS）の操作を録画"
              >
                ● App 録画
              </button>
            </>
          )}
          <button
            type="button"
            className={running ? 'danger' : 'primary'}
            onClick={onRun}
            disabled={recording || flow.steps.length === 0}
            title="再生中は ⌘⇧Esc でどこからでも停止できます"
          >
            {running ? '■ 停止' : '▶ 再生'}
          </button>
          {running && (
            <span
              className="toolbar-hint"
              title="再生中はいつでも ⌘+Shift+Esc で中断できます"
            >
              中断: <kbd>⌘</kbd>+<kbd>⇧</kbd>+<kbd>Esc</kbd>
            </span>
          )}
          <span className="toolbar-sep" />
          <button
            type="button"
            onClick={() => appendQuickStep('wait')}
            title="時間待機ブロックを末尾に追加"
          >
            + 待機
          </button>
          <button
            type="button"
            onClick={() => appendQuickStep({ type: 'wait_for', kind: 'web.load' })}
            title="ロード完了など条件待機ブロックを末尾に追加"
          >
            + 条件待機
          </button>
          <button type="button" onClick={() => addStructuralStep('if')} title="if 分岐を追加">
            + if
          </button>
          <button type="button" onClick={() => addStructuralStep('loop')} title="繰り返しを追加">
            + loop
          </button>
          <button type="button" onClick={() => addStructuralStep('try')} title="try/catch を追加">
            + try
          </button>
          <span className="toolbar-sep" />
          <label className="toolbar-toggle" title="録画中、ユーザーが空けた間を wait として記録">
            <input
              type="checkbox"
              checked={recordWaits}
              onChange={(e) => setRecordWaits(e.target.checked)}
            />
            録画待機
          </label>
          <span className="toolbar-sep" />
          <button type="button" onClick={undo} disabled={undoStackLen === 0} title="Undo (Cmd+Z)">
            ↶
          </button>
          <button type="button" onClick={redo} disabled={redoStackLen === 0} title="Redo (Cmd+Shift+Z)">
            ↷
          </button>
          <button type="button" onClick={() => void saveFlow()} disabled={!dirty}>
            保存{dirty ? '*' : ''}
          </button>
        </div>
      </header>
      <div className="pane-body editor-body">
        <section className="timeline">
          {flow.steps.length === 0 ? (
            <p className="muted">
              録画ボタンを押すとブラウザが開き、操作がここに記録されます。
              <br />
              または「+ if / + loop / + try」で制御ステップを追加できます。
            </p>
          ) : (
            <Timeline steps={flow.steps} depth={0} pathPrefix="" />
          )}
        </section>

        <section className="log">
          <header>
            <span>ログ</span>
            <button onClick={clearLog} disabled={log.length === 0}>クリア</button>
          </header>
          <div className="log-body">
            {log.length === 0 && <p className="muted">ログはまだありません。</p>}
            {log.map((l, i) => (
              <div key={i} className={`log-entry ${l.level}`}>
                <span className="ts">{new Date(l.ts).toLocaleTimeString('ja-JP')}</span>
                <span className="msg">{l.message}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Recursive timeline — renders nested if/loop/try children + branches.
// `depth` controls indent; `pathPrefix` shows the human-readable cursor like
// "1.then[0]" so the user can match log lines to timeline rows.
// ---------------------------------------------------------------------------

function Timeline({
  steps,
  depth,
  pathPrefix,
}: {
  steps: Step[];
  depth: number;
  pathPrefix: string;
}) {
  return (
    <ol className="timeline-list">
      {steps.map((step, i) => (
        <Fragment key={step.id}>
          <InsertHandle beforeStepId={step.id} />
          <StepNode
            step={step}
            depth={depth}
            path={pathPrefix ? `${pathPrefix}.${i + 1}` : `${i + 1}`}
          />
        </Fragment>
      ))}
      {/* Trailing handle only at the top level — child branches keep their
          existing "+ ステップ" buttons for end-of-branch insertion, so we
          don't double up. */}
      {depth === 0 && <InsertHandle beforeStepId={null} />}
    </ol>
  );
}

/**
 * Hover-target between two timeline rows. Click expands a small popup of
 * `wait` / `wait_for` / structural options that get spliced in at the
 * position via `insertStepAt(beforeStepId, ...)`.
 *
 * `beforeStepId === null` means "append at the top-level end".
 */
function InsertHandle({ beforeStepId }: { beforeStepId: string | null }) {
  const [open, setOpen] = useState(false);
  const insertStepAt = useStore((s) => s.insertStepAt);
  const choose = (kind: InsertKind): void => {
    insertStepAt(beforeStepId, kind);
    setOpen(false);
  };
  return (
    <li className="step-divider" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className="divider-add"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        title={beforeStepId ? 'ここにブロックを挿入' : '末尾にブロックを追加'}
      >
        +
      </button>
      {open && (
        <div className="divider-menu" onClick={(e) => e.stopPropagation()}>
          <div className="divider-section">待機・条件</div>
          {INSERT_MENU.map((it) => (
            <button
              type="button"
              key={typeof it.kind === 'string' ? it.kind : `wf-${it.kind.kind}`}
              onClick={() => choose(it.kind)}
            >
              {it.label}
            </button>
          ))}
          <div className="divider-section">構造</div>
          <button type="button" onClick={() => choose('if')}>+ if</button>
          <button type="button" onClick={() => choose('loop')}>+ loop</button>
          <button type="button" onClick={() => choose('try')}>+ try</button>
        </div>
      )}
    </li>
  );
}

function StepNode({
  step,
  depth,
  path,
}: {
  step: Step;
  depth: number;
  path: string;
}) {
  const selectedStepId = useStore((s) => s.selectedStepId);
  const selectStep = useStore((s) => s.selectStep);
  const removeStep = useStore((s) => s.removeStep);
  const moveStep = useStore((s) => s.moveStep);
  const addChildStep = useStore((s) => s.addChildStep);
  const addBranchStep = useStore((s) => s.addBranchStep);

  const isStructural =
    step.type === 'if' || step.type === 'loop' || step.type === 'try';

  return (
    <li
      className={`step-node ${selectedStepId === step.id ? 'active' : ''} depth-${depth}`}
      onClick={(e) => {
        e.stopPropagation();
        selectStep(step.id);
      }}
    >
      <div className="step-row">
        <span className="step-index">{path}</span>
        <span className="step-type">{step.type}</span>
        <span className="step-label">{describeStep(step)}</span>
        <span className="step-actions">
          <button
            onClick={(e) => {
              e.stopPropagation();
              moveStep(step.id, -1);
            }}
            title="上へ"
          >
            ↑
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              moveStep(step.id, 1);
            }}
            title="下へ"
          >
            ↓
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              removeStep(step.id);
            }}
            title="削除"
          >
            ×
          </button>
        </span>
      </div>
      {isStructural && (
        <div className="step-children">
          {step.type === 'if' && (
            <>
              <BranchSection
                title={`then (条件成立時) — ${(step.branches?.[0]?.steps.length ?? 0)} 個`}
                steps={step.branches?.[0]?.steps ?? []}
                depth={depth + 1}
                pathPrefix={`${path}.then`}
                onAdd={(e) => {
                  e.stopPropagation();
                  addBranchStep(step.id, step.branches?.[0]?.name ?? 'then');
                }}
                addLabel="+ then ステップ"
              />
              <BranchSection
                title={`else (条件不成立時) — ${(step.children?.length ?? 0)} 個`}
                steps={step.children ?? []}
                depth={depth + 1}
                pathPrefix={`${path}.else`}
                onAdd={(e) => {
                  e.stopPropagation();
                  addChildStep(step.id);
                }}
                addLabel="+ else ステップ"
              />
            </>
          )}
          {step.type === 'loop' && (
            <BranchSection
              title={`本体 — ${(step.children?.length ?? 0)} 個`}
              steps={step.children ?? []}
              depth={depth + 1}
              pathPrefix={`${path}.body`}
              onAdd={(e) => {
                e.stopPropagation();
                addChildStep(step.id);
              }}
              addLabel="+ ループ本体ステップ"
            />
          )}
          {step.type === 'try' && (
            <>
              <BranchSection
                title={`try 本体 — ${(step.children?.length ?? 0)} 個`}
                steps={step.children ?? []}
                depth={depth + 1}
                pathPrefix={`${path}.try`}
                onAdd={(e) => {
                  e.stopPropagation();
                  addChildStep(step.id);
                }}
                addLabel="+ try ステップ"
              />
              <BranchSection
                title={`catch — ${(findBranch(step, 'catch')?.steps.length ?? 0)} 個`}
                steps={findBranch(step, 'catch')?.steps ?? []}
                depth={depth + 1}
                pathPrefix={`${path}.catch`}
                onAdd={(e) => {
                  e.stopPropagation();
                  addBranchStep(step.id, 'catch');
                }}
                addLabel="+ catch ステップ"
              />
              <BranchSection
                title={`finally — ${(findBranch(step, 'finally')?.steps.length ?? 0)} 個`}
                steps={findBranch(step, 'finally')?.steps ?? []}
                depth={depth + 1}
                pathPrefix={`${path}.finally`}
                onAdd={(e) => {
                  e.stopPropagation();
                  addBranchStep(step.id, 'finally');
                }}
                addLabel="+ finally ステップ"
              />
            </>
          )}
        </div>
      )}
    </li>
  );
}

function BranchSection({
  title,
  steps,
  depth,
  pathPrefix,
  onAdd,
  addLabel,
}: {
  title: string;
  steps: Step[];
  depth: number;
  pathPrefix: string;
  onAdd: (e: ReactMouseEvent) => void;
  addLabel: string;
}) {
  return (
    <div className="branch-section">
      <div className="branch-header muted">{title}</div>
      {steps.length > 0 && <Timeline steps={steps} depth={depth} pathPrefix={pathPrefix} />}
      <button
        type="button"
        className="branch-add"
        onClick={onAdd}
        title="子ステップを追加（wait 500ms）"
      >
        {addLabel}
      </button>
    </div>
  );
}

function findBranch(step: Step, name: string): { name: string; steps: Step[] } | undefined {
  return step.branches?.find((b) => b.name === name);
}

/**
 * One-line summary of a step shown in the timeline row. Structural steps
 * carry their condition/count so the timeline reads at a glance.
 */
function describeStep(step: Step): string {
  if (step.label) return step.label;
  const p = step.params ?? {};
  if (step.type === 'if') return `条件: ${p['condition'] ? String(p['condition']) : '(未設定)'}`;
  if (step.type === 'loop') {
    const kind = String(p['kind'] ?? 'for');
    if (kind === 'for') return `for ${p['count'] ?? 0} 回`;
    if (kind === 'forEach') return `forEach (${p['asVar'] ?? 'item'})`;
    return kind;
  }
  if (step.type === 'try') return 'try / catch / finally';
  if (step.type === 'wait') {
    const ms = Number(p['ms'] ?? 0);
    if (ms >= 60000) return `${round2(ms / 60000)}分 待機`;
    if (ms >= 1000) return `${round2(ms / 1000)}秒 待機`;
    return `${ms}ms 待機`;
  }
  if (step.type === 'wait_for') {
    const kind = String(p['kind'] ?? '');
    const label = WAIT_FOR_LABEL[kind as WaitForKind] ?? kind ?? '条件待機';
    return `条件待機: ${label}`;
  }
  if (step.type === 'open_url') return String(p['url'] ?? '');
  if (step.type === 'type' && typeof p['text'] === 'string') {
    const t = p['text'] as string;
    if (t.startsWith('${secrets.')) return '(シークレット)';
    return t.length > 40 ? t.slice(0, 40) + '…' : t;
  }
  return '';
}

// ---------------------------------------------------------------------------
// Inspector: selected step properties + app diagnostic
// ---------------------------------------------------------------------------

function Inspector({ appInfo }: { appInfo: AppInfo | null }) {
  const flow = useStore((s) => s.currentFlow);
  const selectedId = useStore((s) => s.selectedStepId);
  const updateStep = useStore((s) => s.updateStep);

  const step = selectedId && flow ? findStepRecursive(flow.steps, selectedId) : null;

  return (
    <aside className="pane pane-right">
      <header className="pane-header">インスペクタ</header>
      <div className="pane-body">
        {step ? <StepEditor step={step} onChange={(patch) => updateStep(step.id, patch)} /> : (
          <p className="muted">タイムラインからステップを選択するとここに表示されます。</p>
        )}

        <hr />

        <AppSettingsPanel />

        <hr />

        <VaultPanel />

        <hr />

        <section className="diag">
          <h3>環境</h3>
          {appInfo ? (
            <ul className="kv">
              <li><span className="kv-key">バージョン</span><span className="kv-value">v{appInfo.version}</span></li>
              <li><span className="kv-key">プラットフォーム</span><span className="kv-value">{appInfo.platform} {appInfo.arch}</span></li>
              <li><span className="kv-key">Node</span><span className="kv-value">{appInfo.node}</span></li>
              <li><span className="kv-key">Electron</span><span className="kv-value">{appInfo.electron}</span></li>
            </ul>
          ) : <p className="muted">...</p>}
        </section>
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Vault panel: list secrets stored in the OS keychain. Values are never
// shown — only the account names. Add/delete via in-app prompts.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// App settings panel — browser profile mode + humanize defaults
// ---------------------------------------------------------------------------

function AppSettingsPanel() {
  const appSettings = useStore((s) => s.appSettings);
  const setAppSettings = useStore((s) => s.setAppSettings);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Persist a section patch immediately. Radio buttons / picker → 1 IPC per
  // user action, no save button needed.
  const persist = useCallback(
    async <K extends keyof AppSettings>(
      section: K,
      patch: Partial<AppSettings[K]>,
    ): Promise<void> => {
      try {
        await setAppSettings({
          ...appSettings,
          [section]: { ...appSettings[section], ...patch },
        });
        setSavedAt(Date.now());
      } catch {
        // store.setAppSettings already appendLog'd the error.
      }
    },
    [appSettings, setAppSettings],
  );

  // Numeric inputs use a local controlled value so typing "120" doesn't fire
  // three IPCs (1, 12, 120). A 300ms debounce after the last keystroke
  // commits to the store / disk.
  const [mouseSpeedInput, setMouseSpeedInput] = useState(String(appSettings.humanize.mouseSpeedPxPerSec));
  const [typeDelayInput, setTypeDelayInput] = useState(String(appSettings.humanize.typeDelayMs));

  // Pull store changes back into the local input (e.g. an initial load races
  // with the first paint, or another panel/test resets the value).
  useEffect(() => {
    setMouseSpeedInput(String(appSettings.humanize.mouseSpeedPxPerSec));
  }, [appSettings.humanize.mouseSpeedPxPerSec]);
  useEffect(() => {
    setTypeDelayInput(String(appSettings.humanize.typeDelayMs));
  }, [appSettings.humanize.typeDelayMs]);

  const mouseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const commitMouseSpeed = useCallback(
    (raw: string): void => {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) return;
      if (n === appSettings.humanize.mouseSpeedPxPerSec) return;
      void persist('humanize', { mouseSpeedPxPerSec: n });
    },
    [appSettings.humanize.mouseSpeedPxPerSec, persist],
  );
  const commitTypeDelay = useCallback(
    (raw: string): void => {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) return;
      if (n === appSettings.humanize.typeDelayMs) return;
      void persist('humanize', { typeDelayMs: n });
    },
    [appSettings.humanize.typeDelayMs, persist],
  );

  useEffect(() => {
    return () => {
      if (mouseTimer.current) clearTimeout(mouseTimer.current);
      if (typeTimer.current) clearTimeout(typeTimer.current);
    };
  }, []);

  const pickChromeProfile = async (): Promise<void> => {
    try {
      const res = (await window.hermes.settingsPickChromeProfile()) as {
        picked: boolean;
        path?: string;
        name?: string;
      };
      if (!res.picked || !res.path) return;
      await persist('browser', {
        systemChromePath: res.path,
        systemChromeProfileName: res.name ?? '',
      });
    } catch (e) {
      useStore.getState().appendLog({
        ts: Date.now(),
        level: 'error',
        message: `プロファイル選択に失敗: ${(e as Error).message}`,
      });
    }
  };

  return (
    <section className="settings-panel">
      <div className="section-header">
        <h3>アプリ設定</h3>
        {savedAt && (
          <span className="muted small">
            保存しました: {new Date(savedAt).toLocaleTimeString('ja-JP')}
          </span>
        )}
      </div>

      <div className="settings-row">
        <label className="kv-key">ブラウザ起動</label>
        <div className="settings-radio-group">
          <label>
            <input
              type="radio"
              name="browser-mode"
              checked={appSettings.browser.mode === 'system-chrome-import'}
              onChange={() => void persist('browser', { mode: 'system-chrome-import' })}
            />
            実 Chrome の Cookie/ログインを Hermes にコピー（推奨）
          </label>
          <label>
            <input
              type="radio"
              name="browser-mode"
              checked={appSettings.browser.mode === 'system-chrome'}
              onChange={() => void persist('browser', { mode: 'system-chrome' })}
            />
            実 Chrome プロファイルをそのまま使う
          </label>
          <label>
            <input
              type="radio"
              name="browser-mode"
              checked={appSettings.browser.mode === 'hermes-profile'}
              onChange={() => void persist('browser', { mode: 'hermes-profile' })}
            />
            Hermes 専用プロファイル（クリーン起動）
          </label>
        </div>
      </div>

      {appSettings.browser.mode !== 'hermes-profile' && (
        <div className="settings-row">
          <label className="kv-key">Chrome プロファイル</label>
          <div className="settings-control">
            <button type="button" className="small" onClick={() => void pickChromeProfile()}>
              フォルダを選ぶ…
            </button>
            <span className="muted small" style={{ marginLeft: 8 }}>
              {appSettings.browser.systemChromePath
                ? `${appSettings.browser.systemChromeProfileName || ''} (${appSettings.browser.systemChromePath})`
                : '未選択'}
            </span>
          </div>
          {appSettings.browser.mode === 'system-chrome' && (
            <p className="warn small" style={{ fontWeight: 600 }}>
              ※ 「system-chrome」モードは Chrome が起動している間は再生できません。
              再生前に必ず <kbd>Cmd</kbd>+<kbd>Q</kbd> で Chrome を完全終了してください。
            </p>
          )}
          {appSettings.browser.mode === 'system-chrome-import' && (
            <p className="muted small">
              Chrome を終了せずに再生できます（Cookie / ログイン / ブックマークを Hermes にコピーして使用）。
              reCAPTCHA が頻発する場合のみ上の「実 Chrome プロファイル」を試してください。
            </p>
          )}
        </div>
      )}

      <div className="settings-row">
        <label className="kv-key">マウス速度 (px/秒)</label>
        <input
          type="number"
          min={0}
          step={50}
          value={mouseSpeedInput}
          onChange={(e) => {
            const v = e.target.value;
            setMouseSpeedInput(v);
            if (mouseTimer.current) clearTimeout(mouseTimer.current);
            mouseTimer.current = setTimeout(() => commitMouseSpeed(v), 300);
          }}
          onBlur={() => {
            if (mouseTimer.current) clearTimeout(mouseTimer.current);
            commitMouseSpeed(mouseSpeedInput);
          }}
        />
      </div>
      <div className="settings-row">
        <label className="kv-key">タイプ間隔 (ms/文字)</label>
        <input
          type="number"
          min={0}
          step={5}
          value={typeDelayInput}
          onChange={(e) => {
            const v = e.target.value;
            setTypeDelayInput(v);
            if (typeTimer.current) clearTimeout(typeTimer.current);
            typeTimer.current = setTimeout(() => commitTypeDelay(v), 300);
          }}
          onBlur={() => {
            if (typeTimer.current) clearTimeout(typeTimer.current);
            commitTypeDelay(typeDelayInput);
          }}
        />
      </div>
      <p className="muted small">
        推奨: マウス 800 px/秒・タイプ 50ms/文字。マウス速度を 0 にすると瞬間移動、タイプ間隔を 0 にするとペースト相当の一括入力に戻ります。
      </p>
    </section>
  );
}

function VaultPanel() {
  const [entries, setEntries] = useState<Array<{ account: string }>>([]);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const prompt = usePrompt();

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const { entries } = (await window.hermes.vaultList()) as {
        entries: Array<{ account: string }>;
      };
      setEntries(entries);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onAdd = async (): Promise<void> => {
    const account = await prompt({
      title: 'シークレット名（例: password、openrouter_api_key）',
      placeholder: 'password',
    });
    if (!account) return;
    const value = await prompt({
      title: `「${account}」の値`,
      placeholder: '****',
    });
    if (value === null) return;
    await window.hermes.vaultSet(account, value);
    await refresh();
  };

  const onDelete = async (account: string): Promise<void> => {
    const confirm = await prompt({
      title: `「${account}」を削除しますか？削除するなら DELETE と入力`,
      placeholder: 'DELETE',
    });
    if (confirm !== 'DELETE') return;
    await window.hermes.vaultDelete(account);
    await refresh();
  };

  return (
    <section className="vault-panel">
      <div className="section-header">
        <h3>シークレット</h3>
        <button type="button" onClick={onAdd} className="small">+ 追加</button>
      </div>
      {!loaded && <p className="muted small">読み込み中...</p>}
      {err && <p className="small" style={{ color: 'var(--err)' }}>読込失敗: {err}</p>}
      {loaded && !err && entries.length === 0 && (
        <p className="muted small">まだシークレットがありません。パスワード欄を録画すれば自動で保存されます。</p>
      )}
      {entries.length > 0 && (
        <ul className="vault-list">
          {entries.map((e) => (
            <li key={e.account}>
              <span className="mono">{e.account}</span>
              <button onClick={() => void onDelete(e.account)} title="削除">×</button>
            </li>
          ))}
        </ul>
      )}
      <p className="muted small">
        IR には参照 <code>{`\${secrets.<name>}`}</code> だけが残ります。値は macOS Keychain に保存。
      </p>
    </section>
  );
}

function findStepRecursive(steps: Step[], id: string): Step | null {
  for (const s of steps) {
    if (s.id === id) return s;
    if (s.children) {
      const found = findStepRecursive(s.children, id);
      if (found) return found;
    }
    if (s.branches) {
      for (const b of s.branches) {
        const found = findStepRecursive(b.steps, id);
        if (found) return found;
      }
    }
  }
  return null;
}

function StepEditor({ step, onChange }: { step: Step; onChange: (patch: Partial<Step>) => void }) {
  const params = (step.params ?? {}) as Record<string, unknown>;
  const setParam = (key: string, value: unknown): void => {
    onChange({ params: { ...params, [key]: value } });
  };

  return (
    <section className="step-editor">
      <h3>ステップ #{step.id.slice(-6)}</h3>
      <ul className="kv">
        <li><span className="kv-key">タイプ</span><span className="kv-value mono">{step.type}</span></li>
        <li>
          <span className="kv-key">ラベル</span>
          <input
            className="kv-value"
            value={step.label ?? ''}
            onChange={(e) => onChange({ label: e.target.value })}
          />
        </li>
        <li>
          <span className="kv-key">有効</span>
          <input
            type="checkbox"
            checked={step.enabled}
            onChange={(e) => onChange({ enabled: e.target.checked })}
          />
        </li>
      </ul>

      {step.type === 'if' && (
        <>
          <h4>if 条件</h4>
          <ul className="kv">
            <li>
              <span className="kv-key">condition</span>
              <input
                className="kv-value"
                placeholder='例: var.score > 50 / contains(var.text, "OK")'
                value={String(params['condition'] ?? '')}
                onChange={(e) => setParam('condition', e.target.value)}
              />
            </li>
          </ul>
          <p className="muted small">
            JS 風の式言語。<code>var.x</code>, <code>secrets.x</code>, <code>env.X</code>, 比較 / 論理演算子, <code>contains/startsWith/endsWith/length/match</code> 等が使えます。
            式として解釈できない文字列は truthy/falsy 判定。
          </p>
        </>
      )}

      {step.type === 'loop' && (
        <>
          <h4>ループ設定</h4>
          <ul className="kv">
            <li>
              <span className="kv-key">kind</span>
              <select
                className="kv-value"
                value={String(params['kind'] ?? 'for')}
                onChange={(e) => setParam('kind', e.target.value)}
              >
                <option value="for">for (回数)</option>
                <option value="forEach">forEach (配列)</option>
              </select>
            </li>
            {String(params['kind'] ?? 'for') === 'for' && (
              <li>
                <span className="kv-key">count</span>
                <input
                  className="kv-value"
                  type="number"
                  min={0}
                  value={Number(params['count'] ?? 0)}
                  onChange={(e) => setParam('count', Number(e.target.value))}
                />
              </li>
            )}
            {String(params['kind']) === 'forEach' && (
              <>
                <li>
                  <span className="kv-key">items (JSON)</span>
                  <input
                    className="kv-value"
                    placeholder='["a","b","c"]'
                    value={
                      Array.isArray(params['items'])
                        ? JSON.stringify(params['items'])
                        : String(params['items'] ?? '')
                    }
                    onChange={(e) => {
                      try {
                        setParam('items', JSON.parse(e.target.value));
                      } catch {
                        setParam('items', e.target.value);
                      }
                    }}
                  />
                </li>
                <li>
                  <span className="kv-key">asVar</span>
                  <input
                    className="kv-value"
                    placeholder="item"
                    value={String(params['asVar'] ?? 'item')}
                    onChange={(e) => setParam('asVar', e.target.value)}
                  />
                </li>
              </>
            )}
          </ul>
        </>
      )}

      {step.type === 'try' && (
        <p className="muted small">
          try 本体が失敗したら catch 内のステップが、最後に必ず finally が実行されます。
        </p>
      )}

      {step.type === 'wait' && <WaitEditor step={step} onChange={onChange} />}
      {step.type === 'wait_for' && <WaitForEditor step={step} onChange={onChange} />}

      {!isStructuralType(step.type) &&
        step.type !== 'wait' &&
        step.type !== 'wait_for' && (
        <>
          <h4>パラメータ</h4>
          {Object.keys(params).length === 0 && <p className="muted">なし</p>}
          <ul className="kv">
            {Object.entries(params).map(([k, v]) => (
              <li key={k}>
                <span className="kv-key">{k}</span>
                <input
                  className="kv-value"
                  value={typeof v === 'string' ? v : JSON.stringify(v)}
                  onChange={(e) => setParam(k, e.target.value)}
                />
              </li>
            ))}
          </ul>
        </>
      )}

      {step.target !== undefined && (
        <>
          <h4>ターゲット</h4>
          <pre className="json">{JSON.stringify(step.target, null, 2)}</pre>
        </>
      )}
    </section>
  );
}

function isStructuralType(t: string): boolean {
  return t === 'if' || t === 'loop' || t === 'try';
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * `wait` step editor. Stores ms in the IR (single source of truth) but lets
 * the user enter the value in ms / 秒 / 分 — the unit is local UI state, so
 * switching units re-displays the same ms value in the new scale.
 */
function WaitEditor({
  step,
  onChange,
}: {
  step: Step;
  onChange: (patch: Partial<Step>) => void;
}) {
  const params = (step.params ?? {}) as Record<string, unknown>;
  const ms = Number(params['ms'] ?? 0);
  const [unit, setUnit] = useState<'ms' | 's' | 'min'>(
    ms >= 60_000 ? 'min' : ms >= 1_000 ? 's' : 'ms',
  );
  const convertWaitKind = useStore((s) => s.convertWaitKind);
  const display = unit === 'ms' ? ms : unit === 's' ? ms / 1_000 : ms / 60_000;
  const stepSize = unit === 'ms' ? 50 : unit === 's' ? 0.1 : 0.01;
  const onValue = (v: number): void => {
    const newMs = unit === 'ms' ? v : unit === 's' ? v * 1_000 : v * 60_000;
    onChange({ params: { ...params, ms: Math.max(0, Math.round(newMs)) } });
  };

  return (
    <>
      <h4>時間待機</h4>
      <ul className="kv">
        <li>
          <span className="kv-key">時間</span>
          <span className="kv-value wait-row">
            <input
              type="number"
              min={0}
              step={stepSize}
              value={display}
              onChange={(e) => onValue(Number(e.target.value))}
            />
            <select
              value={unit}
              onChange={(e) => setUnit(e.target.value as 'ms' | 's' | 'min')}
            >
              <option value="ms">ms</option>
              <option value="s">秒</option>
              <option value="min">分</option>
            </select>
          </span>
        </li>
      </ul>
      <h4>条件型に変換</h4>
      <p className="muted small">
        待機の根拠を時間以外（ロード完了・要素出現・画面の安定など）に切り替えます。
      </p>
      <div className="convert-row">
        {WAIT_FOR_KINDS.filter((k) => k !== 'time').map((k) => (
          <button
            type="button"
            key={k}
            className="small"
            onClick={() => convertWaitKind(step.id, k)}
          >
            {WAIT_FOR_LABEL[k]}
          </button>
        ))}
      </div>
    </>
  );
}

/**
 * `wait_for` step editor. The `kind` selector flips the rendered params
 * fields and the IR params shape via `convertWaitKind` (so existing values
 * carry across where they make sense — e.g. timeoutMs is preserved).
 */
function WaitForEditor({
  step,
  onChange,
}: {
  step: Step;
  onChange: (patch: Partial<Step>) => void;
}) {
  const params = (step.params ?? {}) as Record<string, unknown>;
  const kind = (params['kind'] as WaitForKind | undefined) ?? 'web.element';
  const convertWaitKind = useStore((s) => s.convertWaitKind);
  const setParam = (k: string, v: unknown): void => {
    onChange({ params: { ...params, [k]: v } });
  };

  return (
    <>
      <h4>条件待機</h4>
      <ul className="kv">
        <li>
          <span className="kv-key">条件種別</span>
          <select
            className="kv-value"
            value={kind}
            onChange={(e) => convertWaitKind(step.id, e.target.value as WaitForKind)}
          >
            {WAIT_FOR_KINDS.map((k) => (
              <option key={k} value={k}>
                {WAIT_FOR_LABEL[k]}
              </option>
            ))}
          </select>
        </li>

        {kind === 'web.load' && (
          <li>
            <span className="kv-key">load state</span>
            <select
              className="kv-value"
              value={String(params['state'] ?? 'load')}
              onChange={(e) => setParam('state', e.target.value)}
            >
              <option value="load">load (全リソース)</option>
              <option value="domcontentloaded">domcontentloaded (DOM のみ)</option>
              <option value="networkidle">networkidle (通信が止まる)</option>
            </select>
          </li>
        )}

        {kind === 'web.element' && (
          <li>
            <span className="kv-key">state</span>
            <select
              className="kv-value"
              value={String(params['state'] ?? 'visible')}
              onChange={(e) => setParam('state', e.target.value)}
            >
              <option value="attached">attached</option>
              <option value="visible">visible</option>
              <option value="hidden">hidden</option>
              <option value="detached">detached</option>
            </select>
          </li>
        )}

        {kind === 'web.url' && (
          <li>
            <span className="kv-key">URL パターン</span>
            <input
              className="kv-value"
              placeholder="例: example.com/checkout"
              value={String(params['url'] ?? '')}
              onChange={(e) => setParam('url', e.target.value)}
            />
          </li>
        )}

        {kind === 'desktop.app_focus' && (
          <li>
            <span className="kv-key">Bundle ID</span>
            <input
              className="kv-value"
              placeholder="com.apple.finder"
              value={String(params['appBundleId'] ?? '')}
              onChange={(e) => setParam('appBundleId', e.target.value)}
            />
          </li>
        )}

        {kind === 'desktop.window_title' && (
          <li>
            <span className="kv-key">タイトル正規表現</span>
            <input
              className="kv-value"
              placeholder="^Untitled.*$"
              value={String(params['titlePattern'] ?? '')}
              onChange={(e) => setParam('titlePattern', e.target.value)}
            />
          </li>
        )}

        {kind === 'desktop.screen_stable' && (
          <li>
            <span className="kv-key">安定とみなす ms</span>
            <input
              className="kv-value"
              type="number"
              min={100}
              step={100}
              value={Number(params['stableMs'] ?? 800)}
              onChange={(e) => setParam('stableMs', Number(e.target.value))}
            />
          </li>
        )}

        {kind === 'expr' && (
          <li>
            <span className="kv-key">式 (jsep)</span>
            <input
              className="kv-value"
              placeholder="var.ready === true"
              value={String(params['expr'] ?? '')}
              onChange={(e) => setParam('expr', e.target.value)}
            />
          </li>
        )}

        <li>
          <span className="kv-key">タイムアウト (ms)</span>
          <input
            className="kv-value"
            type="number"
            min={0}
            step={100}
            value={Number(params['timeoutMs'] ?? 10_000)}
            onChange={(e) => setParam('timeoutMs', Number(e.target.value))}
          />
        </li>

        {(kind === 'desktop.app_focus' ||
          kind === 'desktop.window_title' ||
          kind === 'desktop.screen_stable' ||
          kind === 'desktop.element' ||
          kind === 'expr') && (
          <li>
            <span className="kv-key">ポーリング (ms)</span>
            <input
              className="kv-value"
              type="number"
              min={50}
              step={50}
              value={Number(params['pollIntervalMs'] ?? 100)}
              onChange={(e) => setParam('pollIntervalMs', Number(e.target.value))}
            />
          </li>
        )}
      </ul>
      <button
        type="button"
        className="small"
        onClick={() => convertWaitKind(step.id, 'time')}
      >
        時間待機に戻す
      </button>
    </>
  );
}
