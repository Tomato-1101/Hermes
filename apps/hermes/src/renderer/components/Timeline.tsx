import type { MouseEvent as ReactMouseEvent } from 'react';
import { Fragment, useState } from 'react';
import { type WaitForKind } from '@hermes/ir';
import { useStore, type InsertKind, type Step } from '../store.js';
import { INSERT_MENU, WAIT_FOR_LABEL } from '../constants.js';

// ---------------------------------------------------------------------------
// Recursive timeline — renders nested if/loop/try children + branches.
// `depth` controls indent; `pathPrefix` shows the human-readable cursor like
// "1.then[0]" so the user can match log lines to timeline rows.
// ---------------------------------------------------------------------------

export function Timeline({
  steps,
  depth,
  pathPrefix,
}: {
  steps: Step[];
  depth: number;
  pathPrefix: string;
}) {
  return (
    <ol className="timeline-list">
      {steps.map((step, i) => (
        <Fragment key={step.id}>
          <InsertHandle beforeStepId={step.id} />
          <StepNode
            step={step}
            depth={depth}
            path={pathPrefix ? `${pathPrefix}.${i + 1}` : `${i + 1}`}
          />
        </Fragment>
      ))}
      {/* Trailing handle only at the top level — child branches keep their
          existing "+ ステップ" buttons for end-of-branch insertion, so we
          don't double up. */}
      {depth === 0 && <InsertHandle beforeStepId={null} />}
    </ol>
  );
}

/**
 * Hover-target between two timeline rows. Click expands a small popup of
 * `wait` / `wait_for` / structural options that get spliced in at the
 * position via `insertStepAt(beforeStepId, ...)`.
 *
 * `beforeStepId === null` means "append at the top-level end".
 */
function InsertHandle({ beforeStepId }: { beforeStepId: string | null }) {
  const [open, setOpen] = useState(false);
  const insertStepAt = useStore((s) => s.insertStepAt);
  const choose = (kind: InsertKind): void => {
    insertStepAt(beforeStepId, kind);
    setOpen(false);
  };
  return (
    <li className="step-divider" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className="divider-add"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        title={beforeStepId ? 'ここにブロックを挿入' : '末尾にブロックを追加'}
      >
        +
      </button>
      {open && (
        <div className="divider-menu" onClick={(e) => e.stopPropagation()}>
          <div className="divider-section">待機・条件</div>
          {INSERT_MENU.map((it) => (
            <button
              type="button"
              key={typeof it.kind === 'string' ? it.kind : `wf-${it.kind.kind}`}
              onClick={() => choose(it.kind)}
            >
              {it.label}
            </button>
          ))}
          <div className="divider-section">構造</div>
          <button type="button" onClick={() => choose('if')}>+ if</button>
          <button type="button" onClick={() => choose('loop')}>+ loop</button>
          <button type="button" onClick={() => choose('try')}>+ try</button>
        </div>
      )}
    </li>
  );
}

function StepNode({
  step,
  depth,
  path,
}: {
  step: Step;
  depth: number;
  path: string;
}) {
  const selectedStepId = useStore((s) => s.selectedStepId);
  const selectStep = useStore((s) => s.selectStep);
  const removeStep = useStore((s) => s.removeStep);
  const moveStep = useStore((s) => s.moveStep);
  const addChildStep = useStore((s) => s.addChildStep);
  const addBranchStep = useStore((s) => s.addBranchStep);

  const isStructural =
    step.type === 'if' || step.type === 'loop' || step.type === 'try';

  return (
    <li
      className={`step-node ${selectedStepId === step.id ? 'active' : ''} depth-${depth}`}
      onClick={(e) => {
        e.stopPropagation();
        selectStep(step.id);
      }}
    >
      <div className="step-row">
        <span className="step-index">{path}</span>
        <span className="step-type">{step.type}</span>
        <span className="step-label">{describeStep(step)}</span>
        <span className="step-actions">
          <button
            onClick={(e) => {
              e.stopPropagation();
              moveStep(step.id, -1);
            }}
            title="上へ"
          >
            ↑
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              moveStep(step.id, 1);
            }}
            title="下へ"
          >
            ↓
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              removeStep(step.id);
            }}
            title="削除"
          >
            ×
          </button>
        </span>
      </div>
      {isStructural && (
        <div className="step-children">
          {step.type === 'if' && (
            <>
              <BranchSection
                title={`then (条件成立時) — ${(step.branches?.[0]?.steps.length ?? 0)} 個`}
                steps={step.branches?.[0]?.steps ?? []}
                depth={depth + 1}
                pathPrefix={`${path}.then`}
                onAdd={(e) => {
                  e.stopPropagation();
                  addBranchStep(step.id, step.branches?.[0]?.name ?? 'then');
                }}
                addLabel="+ then ステップ"
              />
              <BranchSection
                title={`else (条件不成立時) — ${(step.children?.length ?? 0)} 個`}
                steps={step.children ?? []}
                depth={depth + 1}
                pathPrefix={`${path}.else`}
                onAdd={(e) => {
                  e.stopPropagation();
                  addChildStep(step.id);
                }}
                addLabel="+ else ステップ"
              />
            </>
          )}
          {step.type === 'loop' && (
            <BranchSection
              title={`本体 — ${(step.children?.length ?? 0)} 個`}
              steps={step.children ?? []}
              depth={depth + 1}
              pathPrefix={`${path}.body`}
              onAdd={(e) => {
                e.stopPropagation();
                addChildStep(step.id);
              }}
              addLabel="+ ループ本体ステップ"
            />
          )}
          {step.type === 'try' && (
            <>
              <BranchSection
                title={`try 本体 — ${(step.children?.length ?? 0)} 個`}
                steps={step.children ?? []}
                depth={depth + 1}
                pathPrefix={`${path}.try`}
                onAdd={(e) => {
                  e.stopPropagation();
                  addChildStep(step.id);
                }}
                addLabel="+ try ステップ"
              />
              <BranchSection
                title={`catch — ${(findBranch(step, 'catch')?.steps.length ?? 0)} 個`}
                steps={findBranch(step, 'catch')?.steps ?? []}
                depth={depth + 1}
                pathPrefix={`${path}.catch`}
                onAdd={(e) => {
                  e.stopPropagation();
                  addBranchStep(step.id, 'catch');
                }}
                addLabel="+ catch ステップ"
              />
              <BranchSection
                title={`finally — ${(findBranch(step, 'finally')?.steps.length ?? 0)} 個`}
                steps={findBranch(step, 'finally')?.steps ?? []}
                depth={depth + 1}
                pathPrefix={`${path}.finally`}
                onAdd={(e) => {
                  e.stopPropagation();
                  addBranchStep(step.id, 'finally');
                }}
                addLabel="+ finally ステップ"
              />
            </>
          )}
        </div>
      )}
    </li>
  );
}

function BranchSection({
  title,
  steps,
  depth,
  pathPrefix,
  onAdd,
  addLabel,
}: {
  title: string;
  steps: Step[];
  depth: number;
  pathPrefix: string;
  onAdd: (e: ReactMouseEvent) => void;
  addLabel: string;
}) {
  return (
    <div className="branch-section">
      <div className="branch-header muted">{title}</div>
      {steps.length > 0 && <Timeline steps={steps} depth={depth} pathPrefix={pathPrefix} />}
      <button
        type="button"
        className="branch-add"
        onClick={onAdd}
        title="子ステップを追加（wait 500ms）"
      >
        {addLabel}
      </button>
    </div>
  );
}

function findBranch(step: Step, name: string): { name: string; steps: Step[] } | undefined {
  return step.branches?.find((b) => b.name === name);
}

/**
 * One-line summary of a step shown in the timeline row. Structural steps
 * carry their condition/count so the timeline reads at a glance.
 */
function describeStep(step: Step): string {
  if (step.label) return step.label;
  const p = step.params ?? {};
  if (step.type === 'if') return `条件: ${p['condition'] ? String(p['condition']) : '(未設定)'}`;
  if (step.type === 'loop') {
    const kind = String(p['kind'] ?? 'for');
    if (kind === 'for') return `for ${p['count'] ?? 0} 回`;
    if (kind === 'forEach') return `forEach (${p['asVar'] ?? 'item'})`;
    return kind;
  }
  if (step.type === 'try') return 'try / catch / finally';
  if (step.type === 'wait') {
    const ms = Number(p['ms'] ?? 0);
    if (ms >= 60000) return `${round2(ms / 60000)}分 待機`;
    if (ms >= 1000) return `${round2(ms / 1000)}秒 待機`;
    return `${ms}ms 待機`;
  }
  if (step.type === 'wait_for') {
    const kind = String(p['kind'] ?? '');
    const label = WAIT_FOR_LABEL[kind as WaitForKind] ?? kind ?? '条件待機';
    return `条件待機: ${label}`;
  }
  if (step.type === 'open_url') return String(p['url'] ?? '');
  if (step.type === 'type' && typeof p['text'] === 'string') {
    const t = p['text'] as string;
    if (t.startsWith('${secrets.')) return '(シークレット)';
    return t.length > 40 ? t.slice(0, 40) + '…' : t;
  }
  return '';
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
