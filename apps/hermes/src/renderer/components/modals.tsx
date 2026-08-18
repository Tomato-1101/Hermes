import type { ReactNode } from 'react';
import { createContext, useCallback, useContext, useState } from 'react';

// ---------------------------------------------------------------------------
// Prompt modal
//
// Electron 33 disables window.prompt / alert / confirm in the renderer
// (they block the renderer's event loop). We provide an async replacement
// via context — call sites do `const v = await prompt({ title, defaultValue })`.
// ---------------------------------------------------------------------------

type PromptOpts = { title: string; defaultValue?: string; placeholder?: string };
type PromptFn = (opts: PromptOpts) => Promise<string | null>;

const PromptContext = createContext<PromptFn | null>(null);

export function usePrompt(): PromptFn {
  const fn = useContext(PromptContext);
  if (!fn) throw new Error('usePrompt must be used inside <PromptProvider>');
  return fn;
}

export function PromptProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<{
    opts: PromptOpts;
    resolve: (v: string | null) => void;
  } | null>(null);
  const [value, setValue] = useState('');

  const prompt = useCallback<PromptFn>((opts) => {
    setValue(opts.defaultValue ?? '');
    return new Promise<string | null>((resolve) => setRequest({ opts, resolve }));
  }, []);

  const close = (result: string | null): void => {
    request?.resolve(result);
    setRequest(null);
  };

  return (
    <PromptContext.Provider value={prompt}>
      {children}
      {request && (
        <div className="modal-overlay" onClick={() => close(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{request.opts.title}</h3>
            <input
              autoFocus
              value={value}
              placeholder={request.opts.placeholder ?? ''}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') close(value);
                if (e.key === 'Escape') close(null);
              }}
            />
            <div className="modal-actions">
              <button onClick={() => close(null)}>キャンセル</button>
              <button className="primary" onClick={() => close(value)}>OK</button>
            </div>
          </div>
        </div>
      )}
    </PromptContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Confirm modal
//
// The PromptProvider's sibling. We need an async confirm() for destructive
// flow-list actions (delete) where a free-text input feels wrong. Same
// modal styling, just a message + OK/Cancel.
// ---------------------------------------------------------------------------

type ConfirmOpts = {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
};
type ConfirmFn = (opts: ConfirmOpts) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

export function useConfirm(): ConfirmFn {
  const fn = useContext(ConfirmContext);
  if (!fn) throw new Error('useConfirm must be used inside <ConfirmProvider>');
  return fn;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<{
    opts: ConfirmOpts;
    resolve: (v: boolean) => void;
  } | null>(null);

  const confirm = useCallback<ConfirmFn>((opts) => {
    return new Promise<boolean>((resolve) => setRequest({ opts, resolve }));
  }, []);

  const close = (result: boolean): void => {
    request?.resolve(result);
    setRequest(null);
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {request && (
        <div className="modal-overlay" onClick={() => close(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{request.opts.title}</h3>
            {request.opts.message && <p className="muted">{request.opts.message}</p>}
            <div className="modal-actions">
              <button onClick={() => close(false)}>
                {request.opts.cancelLabel ?? 'キャンセル'}
              </button>
              <button
                className={request.opts.danger ? 'danger' : 'primary'}
                autoFocus
                onClick={() => close(true)}
              >
                {request.opts.confirmLabel ?? 'OK'}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}
