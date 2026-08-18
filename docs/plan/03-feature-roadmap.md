# 機能一覧計画

> ユーザー指示: 「あなたが追加したい機能全部 ＋ あなたがRPAに必要と考える機能全部を、計画として入れて。」
> 本書はその全機能の計画リスト。**実装はしない。** 出典は ① ロボパット競合分析（`docs/research/`）② RPA製品一般要件 ③ 既存 `docs/PLAN.md`（モード2/3）④ 私の提案。
> すべて **「操作はEngine→Providerのみ／AIは操作しない／決定論IRでbit-for-bit再現／OS依存はDesktopAdapter配下」** の不変条件の中で表現する。

---

## 凡例

**優先度**: `P0`=基盤（これ無しに上が積めない地ならし） / `P1`=中核（RPAとして必須・競合パリティ） / `P2`=拡充（実用性を大きく上げる） / `P3`=発展（将来・差別化）

**由来**: 🟦ロボパット競合分析 / 🟩RPA製品一般 / ⬜既存PLAN.md / 🟪私の提案

**状態**: `定義`=IRに型はある / `部分`=一部実装 / `未`=未着手

---

## P0 — 横断基盤（機能追加の前提・最初にやる地ならし）

| 機能 | 由来 | なぜ必要 | 触る層 | 状態 |
|---|---|---|---|---|
| 実行体とUIの分離（CLIランナー `hermes run flow.json --vars=…`） | 🟩🟪 | 無人/サービス/スケジュール実行の土台。UI殻の差し替え余地も確保。 | engine切り出し / 新 `apps/cli` | 未 |
| サイドカーRPC契約のスキーマ化(zod)＋両OS適合テスト | 🟪 | bit-for-bit再現をWindows実装で割らないため。契約の口伝化を防ぐ。 | desktop-adapter / sidecar | 未 |
| Vault インターフェース化（keytar 依存を1ファイルに封じる） | 🟪 | コア可搬性（最大資産）の死守。CLI/将来移行でも動くように。 | storage/vault.ts | 未 |
| トランスポート抽象化（Unix socket ↔ named pipe） | 🟪 | Windows移行の前提。 | desktop-adapter/sidecar-client | 未 |
| **screen層実行系（image / ocr / coords）** | 🟦🟩 | 画像認識RPAの中核。UIA/AXが取れないアプリの本命フォールバック。**Windows忠実度の律速**。 | sidecar(Screen.swift/.NET) / desktop-adapter / engine registry | 定義のみ |

> `screen層` は IR に `Selector{image/ocr/coords}` が定義済みだが実行ハンドラが無い。**P0でありP1の中核**でもある最重要項目。

---

## P1 — 中核操作（デスクトップ自動化の幅）

| 機能 | 由来 | IR表現 / 方式 | 状態 |
|---|---|---|---|
| マウス網羅: ダブルクリック / 右クリック / ホバー / ドラッグ&ドロップ / デスクトップscroll | 🟦 | `click` に `button/clickCount` 追加 or 新ステップ（`drag`/`hover`）。adapter にメソッド実装済→配線のみ | 部分 |
| 画像認識クリック/入力（一致率・検索範囲・複数パターン） | 🟦 | `image` セレクタ（`threshold`,`scaleInvariant`）＋ `TargetRef.region`。候補配列がロボパットの「複数パターン」を内包 | 定義のみ |
| OCR読み取り / 文字判別 | 🟦 | `ocr` セレクタ（`lang`,`regex`）実行。PaddleOCR等 | 定義のみ |
| 座標フォールバック実行 | 🟦 | `coords`（screen/window基準） | 定義のみ |
| クリップボード read/write | 🟦 | `set_var{from:'clipboard'}` / `type{from:'clipboard'}` ＋反映待ち | 未 |
| アプリ/ファイル起動・フォルダを開く・ウィンドウ切替 | 🟦 | `launch_app{bundleId|path}` / `focusApp` 拡張。exec系は AllowList 管理 | 部分(focusApp) |
| 画像出現/消失/領域変化まで待機 | 🟦 | `wait_for` に `screen.image` / `screen.image_gone` / `screen.region_change` 追加 | 定義一部 |
| 入力割込み安全装置（実行中の人手操作検出→一時停止/警告） | 🟦🟩 | `input-monitoring` 権限で検出。誤検知時オフ可。run-controller | 未 |

---

## P1 — 制御・信頼性

| 機能 | 由来 | 内容 | 状態 |
|---|---|---|---|
| エラー処理の拡充 | 🟩 | `try`/catch/finally の表現力、`onError {goto}`、リトライ条件（retryOn）、`betweenAttempts`（待ってから再試行） | 部分 |
| 分岐・ループの強化 | 🟩 | `if` のUI/式、`loop` の種類（回数 / コレクション反復 / 条件 while / until） | 部分 |
| 実行ヘルスチェック/自動復帰 | 🟩⬜ | Playwright/サイドカーの health-check と自動再起動（長時間運用の安定性） | 未 |
| 決定論アサーション拡充 | 🟪⬜ | `exists` / `text(eq/contains/regex)` / スクショ比較。モード2の手前の決定論検証 | 定義 |
| デバッグ体験 | 🟪 | ステップ実行 / ブレークポイント / 変数ウォッチ / ドライラン（既存を強化） | 部分 |

---

## P2 — データ・ファイル操作

| 機能 | 由来 | IR表現 / 方式 | 状態 |
|---|---|---|---|
| Excel操作（読み書き/範囲/フィルタ/シート） | 🟦🟩 | 新 `packages/excel-provider`（exceljs等, ファイルベース）or キー送出。`excel_read/write/range` ステップ族 | 未 |
| CSV / テキスト / ファイル読み書き | 🟩 | `file_read/write`（AllowList: fileAllowedPaths） | 未 |
| ダウンロード（Web画像/ファイル） | 🟦 | `download{target, saveTo}`（AllowList管理） | 未 |
| 変数・式の拡充 | 🟩 | jsep ホワイトリストに 日付/文字列/数値/正規表現 関数追加 | 部分 |
| データテーブル反復 | 🟩 | 表データ（Excel/CSV/抽出結果）を行ごとに `loop` | 未 |
| HTTP request | 🟩⬜ | `http_request`（AllowList: httpAllowedHosts 必須。モード3でも厳格） | 枠のみ |

---

## P2 — 運用・無人実行（本気のRPAに必須）

| 機能 | 由来 | 内容 | 状態 |
|---|---|---|---|
| スケジューラ | 🟦🟩 | cron / Windowsタスクスケジューラ・サービス連携。CLIランナー（P0）と一体 | 未 |
| 無人実行・ロック画面/RDP越し実行 | 🟩 | UAC/セッション分離設計（Windows移行と連動） | 未 |
| 多重起動・並列ロボ | 🟩 | 複数フロー同時実行 / ジョブキュー | 未 |
| 実行録画（動画） | 🟦🟩 | ScreenCaptureKit/WinRT で実行を録画。`defaults.recordVideo` | 未 |
| 通知（デスクトップ/メール） | 🟦🟩 | `notify` ステップ＋実行完了/失敗の通知 | 未 |
| 実行ログ/監査・履歴・ダッシュボード | 🟦🟩 | 既存 `history/*.jsonl.gz` 拡充、結果/スクショ/所要時間の可視化 | 部分 |
| トリガ起動 | 🟩🟪 | ファイル監視 / Webhook / グローバルホットキー起動 | 未 |
| グローバル実行制御ホットキー | 🟦 | 終了/中止/再開（ロボパットの Ctrl+Alt+U/M 相当） | 未 |

---

## P2 — 録画・編集体験

| 機能 | 由来 | 内容 | 状態 |
|---|---|---|---|
| デスクトップ録画の拡充 | 🟦 | 右クリック/ダブルクリック/ドラッグの記録 | 部分 |
| Web録画の拡充 | 🟩 | より多くのイベント種別の記録 | 部分 |
| セレクタ候補のヘルス表示・学習 | 🟪 | 候補配列の成否表示、`preferIndex` 学習の可視化 | 定義 |
| Undo/Redo・diff・バージョン | ⬜ | JSON Patch スタック、フロー履歴 | 部分 |
| サブフロー/部品化・共有ライブラリ | 🟩⬜ | `subflow` の再利用、共有 | 定義 |
| 秘密情報の徹底 | 🟪⬜ | 録画時の自動マスク、スクショ該当領域の自動ブラー | 部分 |

---

## P1–P2 — AI層（既存設計の実装前進）

| 機能 | 由来 | 内容 | 状態 |
|---|---|---|---|
| モード2: `ai_assert` / `ai_extract`（vision判定）実装 | ⬜ | 「ダッシュボードが見えるまでAIで待機」等。AIは判定のみ・操作しない | 定義 |
| 判定キャッシュ / 階層リカバリ | ⬜ | pHash+ROI差分でコスト抑制、再試行→別モデル→exists→人手 | 未 |
| コスト可視化ダッシュボード | ⬜ | 使用量の可視化（自動停止はしない） | 未 |
| モード3: Planner/Generator | ⬜ | Step Library を function calling で強制、IR生成 | 未 |
| Selector Refiner / Preview承認UI | ⬜ | 実DOMと突き合わせ、`needsRecording` マーカー、Step-through承認 | 未 |

---

## P3 — 発展・差別化

| 機能 | 由来 | 内容 |
|---|---|---|
| プラグイン/拡張機構 | 🟦⬜ | AllowList 枠の上で安全に拡張（PLAN.mdフェーズ5） |
| 画像フォールバック時の拡大率/DPI吸収 | 🟦🟪 | `scaleInvariant` 活用でロボパットの「端末ごと作り直し」問題を回避 |
| Git同期（1ディレクトリ=1フロー） | ⬜ | GitHub をフロー共有バックエンドに |
| クロスフローのデータ受け渡し | 🟩 | 変数の永続化/フロー間共有 |
| 既存RPA互換 | ⬜ | 必要があれば（現状は非対応方針） |
| スクリプトのパスワード保護 | 🟦 | OSS方針上は低優先 |

---

## 統合ロードマップ（順序・既存PLAN.md / Windows移行と整合）

> 各フェーズは「再現テストを書いて通す」をゴールに（CLAUDE.md の Goal-Driven）。

| 段階 | 主眼 | 含む項目 |
|---|---|---|
| **F1: 地ならし** | 土台の健全化 | P0 全部（CLIランナー分離 / RPC契約スキーマ化 / Vault IF化 / トランスポート抽象化） |
| **F2: screen層 + 操作網羅** | 画像認識RPAの中核 | screen層実行系（image/ocr/coords）/ マウス網羅 / 画像待機 / クリップボード / アプリ起動 |
| **F3: 制御・信頼性** | 実運用に耐える | エラー処理拡充 / 分岐ループ強化 / ヘルスチェック自動復帰 / デバッグ体験 |
| **F4: Windows移行** | 主戦場へ | `01-windows-migration.md`（.NETサイドカー / UIA / DPI / UAC / 配布） |
| **F5: 運用・無人実行** | RPA製品化 | スケジューラ / 無人・サービス / 並列 / 録画 / 通知 / 監査ダッシュボード |
| **F6: データ・ファイル** | 業務自動化の幅 | Excel / CSV / ダウンロード / データテーブル / HTTP(AllowList) |
| **F7: AI層前進** | モード2→3 | ai_assert/extract 実装 / コスト可視化 / Planner / Preview承認 |
| **F8: 発展** | 差別化 | プラグイン / Git同期 / DPI吸収 / 共有 |

> UI刷新（`02-ui-overhaul.md`）は F1〜F3 と並行で進めるのが望ましい（機能を足すたびにInspectorが膨れるため、段階開示の枠を先に作る）。

---

## 設計上の不変条件（全機能で守る）

- 新しい操作はすべて **決定論エンジンが実行する IR ステップ/セレクタ** として足す。AIは生成・判定のみ。
- 危険操作（exec / http / file / download）は **AllowList でフローごとに明示オプトイン**。Step Library の既定ボキャブラリには入れない。
- OS依存の実体は **サイドコ（サイドカー）側**に置く。Electron Main 側へ滲み出させない（判定パネルが警告した侵食リスク）。
- IR スキーマ変更は `schemaVersion` ＋ migration ＋ ゴールデンIR再生テストで回帰を防ぐ。

---

## 次アクション（提案）

1. この計画群（`00`〜`03`）の方向性レビュー。特に **F1（地ならし）から着手**で良いか。
2. F1 の最初の一手は **screen層実行系（P0/P1中核）** か **CLIランナー分離（無人実行の土台）** のどちらを先にするか。
3. UI刷新の方向は、フェーズ5前に主要画面モックで一度すり合わせ。

> どこから着手するか指示があれば、その項目の実装計画（Plan）に進む。
