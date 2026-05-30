import type { WaitForKind } from '@hermes/ir';
import type { InsertKind } from './store.js';

/** Inline-insert menu rows + their canonical InsertKind payload. Keeps the
 *  popup, the Inspector's converter, and the Toolbar quick-add buttons in
 *  sync on labels and order. */
export const INSERT_MENU: Array<{ label: string; kind: InsertKind }> = [
  { label: '時間で待つ', kind: 'wait' },
  { label: 'ページのロード完了で次へ', kind: { type: 'wait_for', kind: 'web.load' } },
  { label: '要素の出現で次へ', kind: { type: 'wait_for', kind: 'web.element' } },
  { label: 'URL の一致で次へ', kind: { type: 'wait_for', kind: 'web.url' } },
  { label: 'アプリのフォーカスで次へ', kind: { type: 'wait_for', kind: 'desktop.app_focus' } },
  { label: 'ウィンドウタイトルで次へ', kind: { type: 'wait_for', kind: 'desktop.window_title' } },
  { label: '画面が落ち着いたら次へ', kind: { type: 'wait_for', kind: 'desktop.screen_stable' } },
  { label: 'AX 要素の出現で次へ (デスクトップ)', kind: { type: 'wait_for', kind: 'desktop.element' } },
  { label: 'カスタム条件式で次へ', kind: { type: 'wait_for', kind: 'expr' } },
];

export const WAIT_FOR_LABEL: Record<WaitForKind, string> = {
  time: '時間で待つ',
  'web.load': 'ページロード完了',
  'web.element': '要素の出現',
  'web.url': 'URL の一致',
  'desktop.element': 'AX 要素の出現',
  'desktop.app_focus': 'アプリのフォーカス',
  'desktop.window_title': 'ウィンドウタイトル',
  'desktop.screen_stable': '画面が落ち着いた',
  expr: 'カスタム条件式',
};
