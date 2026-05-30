import { useCallback, useEffect, useState } from 'react';
import { usePrompt } from './modals.js';

// ---------------------------------------------------------------------------
// Vault panel: list secrets stored in the OS keychain. Values are never
// shown — only the account names. Add/delete via in-app prompts.
// ---------------------------------------------------------------------------

export function VaultPanel() {
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
