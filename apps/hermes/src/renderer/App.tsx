import type { MouseEvent as ReactMouseEvent } from 'react';
import { useEffect, useState } from 'react';
import { useStore, type Step } from './store.js';

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
    <div className="app">
      <FlowSidebar />
      <Editor />
      <Inspector appInfo={appInfo} />
    </div>
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

  const onNew = async () => {
    const name = window.prompt('新しいフローの名前は？', 'Untitled flow');
    if (!name) return;
    await createFlow(name);
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
            >
              <div className="flow-name">{f.name}</div>
              <div className="flow-meta muted">
                {f.stepCount} ステップ · {new Date(f.updatedAt).toLocaleString('ja-JP')}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
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

  const onRecord = async () => {
    if (recording) {
      await window.hermes.recorderStop();
      return;
    }
    const url = window.prompt('開始 URL（省略可、空白なら録画のみ開始）', 'https://example.com');
    try {
      await window.hermes.recorderStart(flow.id, url || undefined);
    } catch (e) {
      alert(`録画開始に失敗: ${(e as Error).message}`);
    }
  };

  const onRun = async () => {
    if (running) {
      await window.hermes.runStop();
      return;
    }
    try {
      await window.hermes.runStart(flow.id);
    } catch (e) {
      alert(`再生に失敗: ${(e as Error).message}`);
    }
  };

  return (
    <main className="pane pane-center">
      <header className="pane-header">
        <span>{flow.name}</span>
        <div className="toolbar">
          <button
            type="button"
            className={recording ? 'danger' : ''}
            onClick={onRecord}
            disabled={running}
          >
            {recording ? '■ 録画停止' : '● 録画'}
          </button>
          <button
            type="button"
            className={running ? 'danger' : 'primary'}
            onClick={onRun}
            disabled={recording || flow.steps.length === 0}
          >
            {running ? '■ 停止' : '▶ 再生'}
          </button>
          <span className="toolbar-sep" />
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
        <StepNode
          key={step.id}
          step={step}
          depth={depth}
          path={pathPrefix ? `${pathPrefix}.${i + 1}` : `${i + 1}`}
        />
      ))}
    </ol>
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
  if (step.type === 'wait') return `${p['ms'] ?? '?'}ms 待機`;
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
                placeholder="例: ${var.flag} または true"
                value={String(params['condition'] ?? '')}
                onChange={(e) => setParam('condition', e.target.value)}
              />
            </li>
          </ul>
          <p className="muted small">
            真と評価されたら then 側、偽なら else 側のステップが実行されます。
            式評価器は今後実装予定です（v1 は文字列の truthy 判定のみ）。
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

      {!isStructuralType(step.type) && (
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
