import type { WaitForKind } from '@hermes/ir';
import type { InsertKind } from './store.js';

/** Inline-insert menu rows + their canonical InsertKind payload. Keeps the
 *  popup, the Inspector's converter, and the Toolbar quick-add buttons in
 *  sync on labels and order. Split into the few everyday waits and an
 *  "advanced" group so the insert popup isn't a flat flood of nine options. */
export const INSERT_MENU_COMMON: Array<{ label: string; kind: InsertKind }> = [
  { label: '時間で待つ', kind: 'wait' },
  { label: 'ページのロード完了で次へ', kind: { type: 'wait_for', kind: 'web.load' } },
  { label: '要素の出現で次へ', kind: { type: 'wait_for', kind: 'web.element' } },
];

export const INSERT_MENU_ADVANCED: Array<{ label: string; kind: InsertKind }> = [
  { label: 'URL の一致で次へ', kind: { type: 'wait_for', kind: 'web.url' } },
  { label: 'アプリが前面になったら次へ', kind: { type: 'wait_for', kind: 'desktop.app_focus' } },
  { label: 'ウィンドウのタイトルで次へ', kind: { type: 'wait_for', kind: 'desktop.window_title' } },
  { label: '画面が落ち着いたら次へ', kind: { type: 'wait_for', kind: 'desktop.screen_stable' } },
  { label: 'アプリ要素の出現で次へ', kind: { type: 'wait_for', kind: 'desktop.element' } },
  { label: '条件式が成立したら次へ', kind: { type: 'wait_for', kind: 'expr' } },
];

export const WAIT_FOR_LABEL: Record<WaitForKind, string> = {
  time: '時間で待つ',
  'web.load': 'ページの読込完了',
  'web.element': '要素の出現',
  'web.url': 'URL の一致',
  'desktop.element': 'アプリ要素の出現',
  'desktop.app_focus': 'アプリが前面',
  'desktop.window_title': 'ウィンドウのタイトル',
  'desktop.screen_stable': '画面が落ち着いた',
  expr: '条件式の成立',
};
