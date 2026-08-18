import { useStore } from '../store.js';
import { usePrompt } from './modals.js';
import { Timeline } from './Timeline.js';
import { RunLog } from './RunLog.js';

// ---------------------------------------------------------------------------
// Editor: Timeline + Toolbar + Log
// ---------------------------------------------------------------------------

export function Editor() {
  const flow = useStore((s) => s.currentFlow);
  const dirty = useStore((s) => s.dirty);
  const recording = useStore((s) => s.recording);
  const running = useStore((s) => s.running);
  const saveFlow = useStore((s) => s.saveFlow);
  const createFlow = useStore((s) => s.createFlow);
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
    const onNewFlow = async (): Promise<void> => {
      const name = await prompt({ title: '新しいフローの名前は？', defaultValue: 'Untitled flow' });
      if (!name) return;
      try {
        await createFlow(name);
      } catch {
        // store already surfaced the error via appendLog
      }
    };
    return (
      <main className="pane pane-center">
        <header className="pane-header">エディタ</header>
        <div className="pane-body empty">
          <div className="empty-cta">
            <p className="muted">フローを選ぶか、新しく作成しましょう。</p>
            <button type="button" className="primary" onClick={() => void onNewFlow()}>
              + 新規フロー
            </button>
          </div>
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
        <span className="pane-title">
          {flow.name}
          {recording && <span className="status-pill recording">● 録画中</span>}
          {running && <span className="status-pill running">● 実行中</span>}
        </span>
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

        <RunLog />
      </div>
    </main>
  );
}
