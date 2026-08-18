import { useStore, type Step } from '../store.js';
import { StepEditor } from './StepEditor.js';
import { AppSettingsPanel } from './AppSettingsPanel.js';
import { VaultPanel } from './VaultPanel.js';

export type AppInfo = {
  name: string;
  version: string;
  electron: string;
  node: string;
  platform: string;
  arch: string;
};

// ---------------------------------------------------------------------------
// Inspector: selected step properties + app diagnostic
// ---------------------------------------------------------------------------

export function Inspector({ appInfo }: { appInfo: AppInfo | null }) {
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
