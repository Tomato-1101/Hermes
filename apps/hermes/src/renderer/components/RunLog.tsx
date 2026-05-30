import { useStore } from '../store.js';

// ---------------------------------------------------------------------------
// Run log — the bottom strip of the editor. Subscribes to the store's log
// buffer directly so the editor shell doesn't re-render on every log push.
// ---------------------------------------------------------------------------

export function RunLog() {
  const log = useStore((s) => s.log);
  const clearLog = useStore((s) => s.clearLog);

  return (
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
  );
}
