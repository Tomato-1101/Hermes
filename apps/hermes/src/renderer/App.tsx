import { useEffect, useState } from 'react';

type AppInfo = {
  name: string;
  version: string;
  electron: string;
  node: string;
  platform: string;
  arch: string;
};

type PermissionStatus = {
  required: string[];
  missing: string[];
  granted: string[];
};

type SidecarPing = {
  ok: boolean;
  reply?: string;
  latencyMs?: number;
  error?: string;
};

const PERMISSION_LABELS: Record<string, string> = {
  accessibility: 'アクセシビリティ',
  'screen-recording': '画面収録',
  'input-monitoring': '入力監視',
  automation: 'オートメーション',
};

export function App() {
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [permission, setPermission] = useState<PermissionStatus | null>(null);
  const [sidecar, setSidecar] = useState<SidecarPing | null>(null);

  useEffect(() => {
    void window.hermes.appInfo().then(setAppInfo);
    void window.hermes.permissionStatus().then(setPermission);
    void window.hermes.sidecarPing().then(setSidecar);
  }, []);

  return (
    <div className="app">
      <aside className="pane pane-left">
        <header className="pane-header">パレット</header>
        <div className="pane-body muted">
          ステップライブラリは Phase 1 で実装します。
        </div>
      </aside>

      <main className="pane pane-center">
        <header className="pane-header">
          <span>Hermes</span>
          <small className="muted">
            {appInfo
              ? `${appInfo.name} v${appInfo.version} · ${appInfo.platform}/${appInfo.arch}`
              : '...'}
          </small>
        </header>
        <div className="pane-body">
          <section className="card">
            <h2>セットアップ状況（Phase 0）</h2>
            <ul className="kv">
              <li>
                <span className="kv-key">Electron</span>
                <span className="kv-value">{appInfo?.electron ?? '...'}</span>
              </li>
              <li>
                <span className="kv-key">Node</span>
                <span className="kv-value">{appInfo?.node ?? '...'}</span>
              </li>
              <li>
                <span className="kv-key">プラットフォーム</span>
                <span className="kv-value">
                  {appInfo ? `${appInfo.platform} ${appInfo.arch}` : '...'}
                </span>
              </li>
            </ul>
          </section>

          <section className="card">
            <h2>権限</h2>
            {permission ? (
              permission.required.length === 0 ? (
                <p className="muted">この OS では権限要求はありません。</p>
              ) : (
                <ul className="permissions">
                  {permission.required.map((p) => {
                    const ok = permission.granted.includes(p);
                    return (
                      <li key={p} className={ok ? 'ok' : 'missing'}>
                        <span className="dot" aria-hidden />
                        <span>{PERMISSION_LABELS[p] ?? p}</span>
                        {!ok && (
                          <button
                            type="button"
                            onClick={() => window.hermes.openSettingsPane(p)}
                          >
                            設定を開く
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )
            ) : (
              <p className="muted">読み込み中...</p>
            )}
          </section>

          <section className="card">
            <h2>ネイティブサイドカー</h2>
            {sidecar ? (
              sidecar.ok ? (
                <p className="ok">
                  接続 OK
                  {typeof sidecar.latencyMs === 'number'
                    ? ` (${sidecar.latencyMs.toFixed(1)}ms)`
                    : ''}
                </p>
              ) : (
                <p className="muted">{sidecar.error ?? '未接続'}</p>
              )
            ) : (
              <p className="muted">確認中...</p>
            )}
          </section>
        </div>
      </main>

      <aside className="pane pane-right">
        <header className="pane-header">インスペクタ</header>
        <div className="pane-body muted">
          ステップを選択するとここにプロパティが表示されます（Phase 1）。
        </div>
      </aside>
    </div>
  );
}
