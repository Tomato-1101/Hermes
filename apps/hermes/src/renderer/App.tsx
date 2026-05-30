import { useEffect, useState } from 'react';
import { useStore, type Step } from './store.js';
import { PromptProvider, ConfirmProvider } from './components/modals.js';
import { FlowSidebar } from './components/FlowSidebar.js';
import { Editor } from './components/Editor.js';
import { Inspector, type AppInfo } from './components/Inspector.js';

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
