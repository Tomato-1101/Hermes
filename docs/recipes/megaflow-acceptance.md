# メガフロー検収（フェーズ1・ほぼ全機能）

計画書 `docs/plan/04-phase-1-finalization.md` §6/§7 の検収用フロー。Mode 1 の主要機能を 1 本に詰め込み、「最後まで成功する」ことを確認するためのもの。

- フロー: [`packages/cli/fixtures/megaflow.flow.json`](../../packages/cli/fixtures/megaflow.flow.json)（32 ステップ）
- 自動テスト: [`packages/cli/test/run-flow.test.ts`](../../packages/cli/test/run-flow.test.ts)

## このフローが使う機能（§7.1）

| 区分 | ステップ | 備考 |
|---|---|---|
| log / manual_pause | `mf-00`, `mf-01`, `mf-31` | manual_pause はヘッドレスでは記録のみで自動継続（後述） |
| Web | `open_url` → `wait_for(web.load)` → `type` → `type(control:select)` → `click` → `wait_for(web.element)` → `extract` → `set_var` | ターゲットは自己完結の `data:` URL フォーム（外部サイト不要） |
| 待機 | `wait`(time) / `wait_for`(expr) | |
| 制御フロー | `if` / `loop`(for) / `try`(catch+finally) | |
| clipboard | `clipboard_write` → `clipboard_read` | サイドカー経由 |
| screen層 | `click`(image セレクタ) / `extract`(ocr 読取) | **プレースホルダ**。実機で対象に合わせ調整 |
| デスクトップ | `click` / ダブルクリック(`clickCount:2`) / 右クリック(`button:right`) / `type` / `key_combo` / `scroll` / `drag` | **プレースホルダ座標**。実機で調整 |
| Excel(exceljs) | `excel_open`(自己生成) → `excel_write` → `excel_read` → `excel_range`(範囲書込) | ファイルベース・Mac 実行可 |

> ※ §5 のとおり「キー送出による Excel アプリ操作」は Windows 保留のため本フローには含めない（exceljs 版のみ）。

## 何が自動検証され、何が手動か

- **自動（CI / `pnpm -r run test:run`）**:
  - メガフローが**構造的に妥当な Flow** であること、レイヤ検出が web/desktop/screen/clipboard/excel を全点灯すること。
  - **exceljs スライスの実機往復**（読取→加工→書込）が Mac で成功すること（`runs an exceljs flow end-to-end on Mac`）。CLI→engine→excel-provider→ディスクの全経路を通す。
- **手動（ユーザーが実施・§7.2）**: Web/screen/デスクトップの実再生。これらは Chrome・サイドカー・OS 権限・対象アプリに依存するため、CI では実行しない。

## 実行方法（§7.2）

### 前提
1. `pnpm install` → `pnpm rebuild better-sqlite3`
2. サイドカービルド（`sidecars/macos-native` を `swift build`）
3. macOS 権限付与: アクセシビリティ / 画面収録 / 入力監視（Hermes または開発実行プロセスに）

### CLI（推奨）
```sh
hermes run packages/cli/fixtures/megaflow.flow.json
```
- 相対パス（`megaflow-out.xlsx`, `assets/target.png`）は**フロー JSON のあるディレクトリ基準**で解決される。screen の画像テンプレートを使う場合は `packages/cli/fixtures/assets/target.png` を置く。
- 終了コード 0・ログで各ステップ成功を確認。

### UI
アプリ起動 → メガフローを開く/録画 → 実行 → タイムラインで各ステップが緑、Run ログにエラーなしを確認。アプリ側も Excel プロバイダを配線済み（`RunController`）なので exceljs ステップは UI からも動く。

## screen / デスクトップのプレースホルダ調整

- `mf-17`（image クリック）: `assets/target.png` を実画面に存在するボタン画像に差し替え、`threshold` を調整。
- `mf-18`（OCR）: `region` と検索 `text`（既定「合計」）を対象に合わせる。
- `mf-19`〜`mf-25`（デスクトップ）: `coords`(400,300) と drag の `to`(600,500) を対象ウィンドウ内の実座標に差し替える。

## manual_pause のフェーズ1 挙動

`manual_pause` はエンジンコアで**ログ出力して自動継続**する（ヘッドレス/CLI には再開チャネルがないため、未処理ステップ型でクラッシュさせない）。対話的な一時停止/再開は UI 作業（H）で実装予定。本番でユーザー操作を挟みたい場合は、UI 実行時にこのステップで実際に手を動かしてから次へ進める運用とする。

## 合否（§6.5）

全ステップ成功＝合格。途中失敗時はログの該当ステップを実装者へ共有し、実装者が直して再実行する（「動くまで直す」）。
