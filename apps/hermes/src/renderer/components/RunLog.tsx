import { useEffect, useRef } from 'react';
import { useStore } from '../store.js';

// ---------------------------------------------------------------------------
// Run log — the bottom strip of the editor. Subscribes to the store's log
// buffer directly so the editor shell doesn't re-render on every log push.
// ---------------------------------------------------------------------------

export function RunLog() {
  const log = useStore((s) => s.log);
  const clearLog = useStore((s) => s.clearLog);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // Keep the newest entry in view as a run streams in. Anchors to the bottom
  // on every append; cheap because the buffer is capped at 500 lines.
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log.length]);

  return (
    <section className="log">
      <header>
        <span>ログ</span>
        <button onClick={clearLog} disabled={log.length === 0}>クリア</button>
      </header>
      <div className="log-body" ref={bodyRef}>
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
