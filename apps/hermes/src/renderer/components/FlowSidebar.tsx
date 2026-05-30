import type { MouseEvent as ReactMouseEvent } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useStore, type FlowSummary } from '../store.js';
import { usePrompt, useConfirm } from './modals.js';

// ---------------------------------------------------------------------------
// Sidebar: list of flows + Create button
// ---------------------------------------------------------------------------

export function FlowSidebar() {
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
