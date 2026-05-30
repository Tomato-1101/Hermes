import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore, type AppSettings } from '../store.js';

// ---------------------------------------------------------------------------
// App settings panel — browser profile mode + humanize defaults
// ---------------------------------------------------------------------------

export function AppSettingsPanel() {
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
