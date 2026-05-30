import { useState } from 'react';
import { WAIT_FOR_KINDS, type WaitForKind } from '@hermes/ir';
import { useStore, type Step } from '../store.js';
import { WAIT_FOR_LABEL } from '../constants.js';

export function StepEditor({ step, onChange }: { step: Step; onChange: (patch: Partial<Step>) => void }) {
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
                placeholder='例: var.score > 50 / contains(var.text, "OK")'
                value={String(params['condition'] ?? '')}
                onChange={(e) => setParam('condition', e.target.value)}
              />
            </li>
          </ul>
          <p className="muted small">
            JS 風の式言語。<code>var.x</code>, <code>secrets.x</code>, <code>env.X</code>, 比較 / 論理演算子, <code>contains/startsWith/endsWith/length/match</code> 等が使えます。
            式として解釈できない文字列は truthy/falsy 判定。
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

      {step.type === 'wait' && <WaitEditor step={step} onChange={onChange} />}
      {step.type === 'wait_for' && <WaitForEditor step={step} onChange={onChange} />}

      {!isStructuralType(step.type) &&
        step.type !== 'wait' &&
        step.type !== 'wait_for' && (
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

/**
 * `wait` step editor. Stores ms in the IR (single source of truth) but lets
 * the user enter the value in ms / 秒 / 分 — the unit is local UI state, so
 * switching units re-displays the same ms value in the new scale.
 */
function WaitEditor({
  step,
  onChange,
}: {
  step: Step;
  onChange: (patch: Partial<Step>) => void;
}) {
  const params = (step.params ?? {}) as Record<string, unknown>;
  const ms = Number(params['ms'] ?? 0);
  const [unit, setUnit] = useState<'ms' | 's' | 'min'>(
    ms >= 60_000 ? 'min' : ms >= 1_000 ? 's' : 'ms',
  );
  const convertWaitKind = useStore((s) => s.convertWaitKind);
  const display = unit === 'ms' ? ms : unit === 's' ? ms / 1_000 : ms / 60_000;
  const stepSize = unit === 'ms' ? 50 : unit === 's' ? 0.1 : 0.01;
  const onValue = (v: number): void => {
    const newMs = unit === 'ms' ? v : unit === 's' ? v * 1_000 : v * 60_000;
    onChange({ params: { ...params, ms: Math.max(0, Math.round(newMs)) } });
  };

  return (
    <>
      <h4>時間待機</h4>
      <ul className="kv">
        <li>
          <span className="kv-key">時間</span>
          <span className="kv-value wait-row">
            <input
              type="number"
              min={0}
              step={stepSize}
              value={display}
              onChange={(e) => onValue(Number(e.target.value))}
            />
            <select
              value={unit}
              onChange={(e) => setUnit(e.target.value as 'ms' | 's' | 'min')}
            >
              <option value="ms">ms</option>
              <option value="s">秒</option>
              <option value="min">分</option>
            </select>
          </span>
        </li>
      </ul>
      <h4>条件型に変換</h4>
      <p className="muted small">
        待機の根拠を時間以外（ロード完了・要素出現・画面の安定など）に切り替えます。
      </p>
      <div className="convert-row">
        {WAIT_FOR_KINDS.filter((k) => k !== 'time').map((k) => (
          <button
            type="button"
            key={k}
            className="small"
            onClick={() => convertWaitKind(step.id, k)}
          >
            {WAIT_FOR_LABEL[k]}
          </button>
        ))}
      </div>
    </>
  );
}

/**
 * `wait_for` step editor. The `kind` selector flips the rendered params
 * fields and the IR params shape via `convertWaitKind` (so existing values
 * carry across where they make sense — e.g. timeoutMs is preserved).
 */
function WaitForEditor({
  step,
  onChange,
}: {
  step: Step;
  onChange: (patch: Partial<Step>) => void;
}) {
  const params = (step.params ?? {}) as Record<string, unknown>;
  const kind = (params['kind'] as WaitForKind | undefined) ?? 'web.element';
  const convertWaitKind = useStore((s) => s.convertWaitKind);
  const setParam = (k: string, v: unknown): void => {
    onChange({ params: { ...params, [k]: v } });
  };

  return (
    <>
      <h4>条件待機</h4>
      <ul className="kv">
        <li>
          <span className="kv-key">条件種別</span>
          <select
            className="kv-value"
            value={kind}
            onChange={(e) => convertWaitKind(step.id, e.target.value as WaitForKind)}
          >
            {WAIT_FOR_KINDS.map((k) => (
              <option key={k} value={k}>
                {WAIT_FOR_LABEL[k]}
              </option>
            ))}
          </select>
        </li>

        {kind === 'web.load' && (
          <li>
            <span className="kv-key">load state</span>
            <select
              className="kv-value"
              value={String(params['state'] ?? 'load')}
              onChange={(e) => setParam('state', e.target.value)}
            >
              <option value="load">load (全リソース)</option>
              <option value="domcontentloaded">domcontentloaded (DOM のみ)</option>
              <option value="networkidle">networkidle (通信が止まる)</option>
            </select>
          </li>
        )}

        {kind === 'web.element' && (
          <li>
            <span className="kv-key">state</span>
            <select
              className="kv-value"
              value={String(params['state'] ?? 'visible')}
              onChange={(e) => setParam('state', e.target.value)}
            >
              <option value="attached">attached</option>
              <option value="visible">visible</option>
              <option value="hidden">hidden</option>
              <option value="detached">detached</option>
            </select>
          </li>
        )}

        {kind === 'web.url' && (
          <li>
            <span className="kv-key">URL パターン</span>
            <input
              className="kv-value"
              placeholder="例: example.com/checkout"
              value={String(params['url'] ?? '')}
              onChange={(e) => setParam('url', e.target.value)}
            />
          </li>
        )}

        {kind === 'desktop.app_focus' && (
          <li>
            <span className="kv-key">Bundle ID</span>
            <input
              className="kv-value"
              placeholder="com.apple.finder"
              value={String(params['appBundleId'] ?? '')}
              onChange={(e) => setParam('appBundleId', e.target.value)}
            />
          </li>
        )}

        {kind === 'desktop.window_title' && (
          <li>
            <span className="kv-key">タイトル正規表現</span>
            <input
              className="kv-value"
              placeholder="^Untitled.*$"
              value={String(params['titlePattern'] ?? '')}
              onChange={(e) => setParam('titlePattern', e.target.value)}
            />
          </li>
        )}

        {kind === 'desktop.screen_stable' && (
          <li>
            <span className="kv-key">安定とみなす ms</span>
            <input
              className="kv-value"
              type="number"
              min={100}
              step={100}
              value={Number(params['stableMs'] ?? 800)}
              onChange={(e) => setParam('stableMs', Number(e.target.value))}
            />
          </li>
        )}

        {kind === 'expr' && (
          <li>
            <span className="kv-key">式 (jsep)</span>
            <input
              className="kv-value"
              placeholder="var.ready === true"
              value={String(params['expr'] ?? '')}
              onChange={(e) => setParam('expr', e.target.value)}
            />
          </li>
        )}

        <li>
          <span className="kv-key">タイムアウト (ms)</span>
          <input
            className="kv-value"
            type="number"
            min={0}
            step={100}
            value={Number(params['timeoutMs'] ?? 10_000)}
            onChange={(e) => setParam('timeoutMs', Number(e.target.value))}
          />
        </li>

        {(kind === 'desktop.app_focus' ||
          kind === 'desktop.window_title' ||
          kind === 'desktop.screen_stable' ||
          kind === 'desktop.element' ||
          kind === 'expr') && (
          <li>
            <span className="kv-key">ポーリング (ms)</span>
            <input
              className="kv-value"
              type="number"
              min={50}
              step={50}
              value={Number(params['pollIntervalMs'] ?? 100)}
              onChange={(e) => setParam('pollIntervalMs', Number(e.target.value))}
            />
          </li>
        )}
      </ul>
      <button
        type="button"
        className="small"
        onClick={() => convertWaitKind(step.id, 'time')}
      >
        時間待機に戻す
      </button>
    </>
  );
}
