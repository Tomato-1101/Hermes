# Excel キー送出レシピ: 郵便番号の昇順並べ替え

ロボパット基礎編のサンプル「郵便番号並べ替え」を Hermes IR に写経した、**キーボードショートカット送出だけで Excel アプリを操作する**レシピ。画像認識に頼らず、Excel 標準のショートカットを `key_combo` で送る方式（ロボパットの Excel 操作の中核）。

- フロー: [`packages/cli/fixtures/excel-keysend-postal-sort.flow.json`](../../packages/cli/fixtures/excel-keysend-postal-sort.flow.json)
- 出典: `docs/research/robopat-feature-catalog.md` §H / §4（`.bwn` サンプル解析）

## 重要な前提（計画書04 §5）

- **Windows の Excel ショートカット前提**。macOS の Excel はショートカットが異なる（修飾キーが Cmd 系、フィルタやソートのキー操作も別）ため、**このレシピの機能検証は Windows 移行後に行う（フェーズ1では保留）**。
- フェーズ1 で「Mac でもファイルベースで動く」Excel 操作が必要なら、**exceljs 版**（`excel_open` / `excel_read` / `excel_range` / `excel_write`）を使う。こちらは Excel アプリ不要で、`packages/excel-provider` に実装済み・Mac で単体テスト済み。
- このレシピ JSON は**構造的に妥当な Flow であること**と、`key_combo` が `target.layer="desktop"`（サイドカー経由でOSにキー送出）へルーティングされることのみ自動テストで担保する（`packages/cli/test/run-flow.test.ts`）。実際のキー送出による Excel の挙動は検証対象外。

## キー送出シーケンス

| # | ステップ | キー | 意味 |
|---|---|---|---|
| 0 | `manual_pause` | — | Excel を開きシートをアクティブにする（人手） |
| 1 | `key_combo` | Ctrl+Home | 先頭セル A1 へ移動 |
| 2 | `key_combo` | Ctrl+Shift+→ | 右端まで範囲選択 |
| 3 | `key_combo` | Ctrl+Shift+↓ | 下端まで範囲選択 |
| 4 | `key_combo` | Ctrl+Shift+L | オートフィルタを ON |
| 5 | `key_combo` | Ctrl+Home | 並べ替えキー列の見出しセルへ戻る |
| 6 | `key_combo` | Alt+↓ | フィルタのドロップダウンを開く |
| 7 | `key_combo` | S | 昇順で並べ替え |
| 8 | `key_combo` | Ctrl+S | 上書き保存 |
| 9 | `log` | — | 完了ログ |

> ※ ソートのキー操作（手順 5〜7）はアクティブセルの列に依存し、Excel のバージョン・UI 言語で挙動が変わりやすい。Windows 実機での調整前提。

## キー名の規約

`key_combo.params.keys` は**論理キー名**（OS 仮想キーコードではない）。`packages/desktop-adapter/src/rpc-contract.ts` の `MODIFIER_NAMES` / `KEY_NAMES` と一致させる。

- このレシピは Windows Excel を狙うため、修飾キーは `ctrl` を**リテラルで**指定している（`primary` は OS 既定の Command 修飾＝Win では Ctrl／Mac では Cmd に解決される抽象名。クロス OS にしたい場合は `primary` を使う）。
- 使用キー: `ctrl` `shift` `alt` `home` `right` `down` `l` `s`。

## 実行方法（Windows 移行後）

```sh
hermes run packages/cli/fixtures/excel-keysend-postal-sort.flow.json
```

手順 0 の `manual_pause` で Excel の準備を促し、再開後にキー送出列が流れる。Mac で実行するとショートカットが Excel に効かない／別動作になるため、本番相当は Windows で。

## exceljs 版との使い分け

| | キー送出レシピ（本書） | exceljs 版 |
|---|---|---|
| 対象 | Excel アプリ本体 | .xlsx ファイル |
| Excel 必要 | 必要 | 不要 |
| OS | Windows（Mac はキー差で保留） | OS 非依存（Mac 可） |
| 並べ替え | フィルタ→昇順のキー操作 | 範囲読取→JS でソート→範囲書込 |
| 検証 | Windows 実機（保留） | Mac 単体テスト済み |

郵便番号並べ替えの exceljs 版の実装例は `packages/excel-provider/test/excel.test.ts` の「excel_range reads into a variable, and writes a 2-D array back」を参照（範囲読取→`Number` 昇順ソート→範囲書込の往復）。
