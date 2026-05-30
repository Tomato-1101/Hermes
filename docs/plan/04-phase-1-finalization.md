# フェーズ1 最終計画（確定版 / Phase 1 Finalization）

> 目的: **Mode 1（決定論RPA・AIなし）の「録画 → 編集 → 再生」を macOS 上で完成させ、土台として固める。**
> 本書は Q&A で**全決定を確定済み**。新しいチャットセッションは、会話履歴なしで本書だけ読めば着手できる。
> 関連: `00-tech-stack-decision` / `01-windows-migration` / `02-ui-overhaul` / `03-feature-roadmap` / `../research/robopat-feature-catalog` / `../research/robopat-vs-hermes-gap`。
> 決定日: 2026-05-30。ブランチ: `feat/phase-1-completion`。

---

## 1. 確定した決定（ユーザーQ&Aの結果）

| 論点 | 決定 |
|---|---|
| **スコープ** | 全部入り: ①Web録画→編集→再生の仕上げ ②デスクトップ録画→再生の仕上げ ③地ならし(CLI分離/RPC契約zod化/Vault IF) ④screen層(画像/OCR/座標) ⑤clipboard ⑥Excel(コード) |
| **対象OS** | **Mac で完成**。Windows 対応は別フェーズ（移行後）。 |
| **UI刷新** | **フェーズ1の最後**に実施。機能を全部終わらせてからやり直す。スキル(`find-skills`等)も使う。 |
| **Excel 方式** | キー送出方式（ロボパット基礎編式）＋ exceljs 専用ステップの**両用**。 |
| **Excel テスト** | exceljs の .xlsx ファイル操作 = **Mac で単体テスト**。キー送出の Excel アプリ操作 = **Windows 移行後に検証（保留）**。コードは両方フェーズ1で書く。 |
| **screen層エンジン** | **Swift サイドカー内**（画像マッチ=Vision/CoreImage、OCR=Apple Vision）。Python サイドカーは追加しない。 |
| **検収ライン** | 代表シナリオ録画→再生 ＋ 郵便番号並べ替え再現 ＋ 全テスト緑＋新規回帰テスト ＋ screen層の画像クリック/OCR読取 ＋ **ほぼ全機能を使ったメガフローが動くまで**（手動テストはユーザーが行ってよい / 方法を本書§7に詳述）。 |
| **実装順序** | 私（実装者）が依存関係で最適化（§4）。 |
| **引き継ぎ** | 計画/分析 doc を**今コミット**し `feat/phase-1-completion` で継続。新チャットは本書から再開。 |

---

## 2. 現状ベースライン（実測 2026-05-30）

- **テスト**: 全 141 件中 **140 緑 / 1 赤 / 3 skip**。
  - 唯一の赤 = `@hermes/storage` の `better-sqlite3` ネイティブ bindings 未ビルド（**環境要因、コード不具合ではない**）。
  - → **step 0**: `pnpm rebuild better-sqlite3`（または electron-rebuild）で解消してから着手。
  - 内訳: ir 30 / ai 9 / engine 22 / web-provider 22(+1skip) / desktop-adapter 29 / recorder-web 13(+1skip) / apps/hermes 11 / storage 5(+1赤)。
- **実装済み**:
  - web-provider: `open_url/click/type/key_combo/scroll/wait/wait_for/screenshot/extract/set_var`（10系統）。
  - desktop-adapter: **coords セレクタ経由**で `click/type/key_combo/wait_for`。`screen.capture` は Swift (`Screen.swift`) で実装済み（**未コミット**・フル/領域PNG）。
  - IR(`packages/ir/src/schema.ts`): `image`/`ocr`/`coords` セレクタと `screen` 層、双方の wait_for 種別を**定義済み**。
- **未実装（=フェーズ1で作る）**:
  - image/ocr セレクタ解決の**サイドカーRPC**（`macos.ts` に「image/ocr require sidecar RPCs that do not exist yet」のコメントあり）。
  - **未配線マウス操作**: `doubleClick/rightClick/hover/scroll/drag`（adapter interface に型はあるが IR ステップに未配線）。
  - **clipboard** ステップ、**Excel**（exceljs + キー送出レシピ）、**CLI ランナー**、**RPC契約 zod スキーマ＋適合テスト**、**Vault インターフェース化**。

> 結論: screen層は IR 定義済み＆ capture 実装済みなので、残りは「**画像マッチ/OCR の RPC 実装＋ハンドラ配線**」。IR スキーマ変更は最小。

---

## 3. 作業項目と分解

各項目は「触る場所 / 成果物 / 検証ゴール（CLAUDE.md の Goal-Driven）」で締める。

### A. 地ならし（基盤・挙動不変）
- **A1. RPC契約の zod スキーマ化＋適合テスト** — 触る: `packages/desktop-adapter`（`macos.ts` が呼ぶ約10メソッド= `mouse.*`/`keyboard.*`/`screen.capture`/`accessibility.*` ＋録画RPC）。成果物: メソッド名・params・座標系規約・キー名規約を zod で固定し、入出力を検証。検証: 既存テスト緑のまま、契約スキーマのユニットテスト追加。
- **A2. トランスポート抽象化** — 触る: `sidecar-client.ts`。成果物: Unix Domain Socket 接続を 1 箇所に隔離し、後で named pipe に差し替え可能な形へ。検証: 既存のデスクトップ系テスト緑。
- **A3. Vault インターフェース化** — 触る: `packages/storage/src/vault.ts`。成果物: keytar 依存を interface 背後に隔離（後で Windows Credential Manager 実装に差し替え可能）。検証: Vault 系テスト緑。
- **A4. CLI ランナー分離** — 触る: 新規 `hermes run <flow.json>`（Electron UI 非依存のヘッドレス実行体）。成果物: フロー JSON を読み Engine→Provider で実行する標準 Node CLI。検証: サンプルフロー JSON を CLI で再生し終了コード0。

### B. デスクトップ仕上げ（未配線マウス操作の配線）
- 触る: `packages/desktop-adapter`（handlers/macos）＋必要なら IR。成果物: `doubleClick/rightClick/hover/scroll/drag` を IR ステップ（`click` の variant か新規）として配線し、録画→再生で使えるように。検証: 各操作の単体/統合テスト＋録画再生で再現。

### C. screen層（画像マッチ / OCR / 座標）
- **C1. サイドカー RPC 追加（Swift）** — 触る: `sidecars/macos-native`（`Screen.swift` 拡張）。成果物: `screen.findImage`（テンプレートマッチ, Vision/CoreImage, threshold/scaleInvariant 対応）＋ `screen.ocr`（Apple Vision, lang/regex）＋ 既存 `screen.capture` をコミット。
- **C2. アダプタ配線** — 触る: `desktop-adapter`（`macos.ts` で image/ocr セレクタ解決、`handlers.ts` で screen 層解決）＋ engine registry に screen 層ハンドラ登録。成果物: `image`/`ocr` セレクタを持つステップが解決・実行される。
- 検証: 「画面上の既知画像を見つけてクリック」「指定領域を OCR 読取→変数」が**統合テスト**で通る（§6）。

### D. clipboard
- 触る: `packages/ir`（`clipboard_read`/`clipboard_write` ステップ、または `set_var{from:'clipboard'}` / `type{from:'clipboard'}` 拡張）＋ desktop-adapter（OS クリップボード API）。成果物: コピー→変数→ペーストの往復。`settleMs`（反映待ち）対応。検証: 往復テスト緑。

### E. Excel（**コードのみ**・§5 の方針厳守）
- **E1. exceljs 専用ステップ** — 触る: 新規 `packages/excel-provider`（exceljs）＋ `packages/ir`（`excel_open`/`excel_read`/`excel_write`/`excel_range` 等）＋ engine 登録（default 層・OS非依存）。成果物: .xlsx の読み/書き/範囲操作ステップ。検証: **Mac でフィクスチャ .xlsx を使った単体テスト**（読取値アサート / 書込結果検証）。
- **E2. キー送出レシピ** — 新規ステップ型は作らず、既存 `key_combo`/`type`/`clipboard` の列で Excel アプリ操作を構成（ロボパット基礎編式: Ctrl+Home→範囲選択→フィルタ→昇順→コピペ）。成果物: サンプルレシピ・フロー JSON ＋ ドキュメント。**機能検証は Windows 移行後（保留）**。

### F. Web 仕上げ
- 触る: `packages/web-provider`/`recorder-web`/renderer の録画・編集・再生経路。成果物: 取りこぼし・再現性の不具合を潰す（録画忠実度、セレクタ堅牢性、編集→再生の往復）。検証: 既存テスト緑＋気づいた不具合に再現テストを足して通す。

### G. 全機能メガフロー＋検収（§6/§7）
- 成果物: 下記をほぼ全部使う 1 本の Mac 実行可能フロー。**動くまで実装を直す**。

### H. UI 刷新（**最後**）
- 触る: renderer（`02-ui-overhaul.md` 準拠）。成果物: App.tsx 分解 → デザインシステム導入 → インスペクタ2段化（生JSON/ID/低レベルparam/技術用語を既定で隠す）→ 用語整理 → 動線磨き。**着手時に `find-skills` で UI/frontend 系スキルを探索**し、あれば活用。検証: 既存機能が回帰なく動き、既定画面から技術露出が消える。

---

## 4. 実装順序（依存最適化・確定）

> step 0: `pnpm rebuild better-sqlite3` で赤を解消し、**全テスト緑のベースライン**を作る。

1. **A1–A3 地ならし（契約zod化・トランスポート抽象化・Vault IF）** — 挙動不変の基盤固め。以降の全作業の土台で、回帰検知の網を先に張る。
2. **A4 CLI ランナー** — 以降の検証（メガフロー再生）を UI 非依存で自動化できるようにする。早めに用意すると C/E/G のテストが楽になる。
3. **B デスクトップ仕上げ（マウス配線）** — 小さく独立。録画→再生の操作網羅を先に埋める。
4. **C screen層（画像/OCR）** — Windows 忠実度の要・本フェーズの目玉。capture 実装済みなので RPC 追加＋配線。
5. **D clipboard** — E2 のキー送出 Excel と汎用コピペの前提。
6. **E Excel（コードのみ）** — D の後。E1 は Mac 単体テスト、E2 は Windows 保留。
7. **F Web 仕上げ** — 既存・低リスク。新機能が落ち着いてから不具合潰し。
8. **G メガフロー＋検収** — ①〜⑦を 1 本で通す。動くまで直す。
9. **H UI 刷新** — 機能が全部固まった最後に実施。

各段階の終わりに該当テストを緑にしてからコミット（細かい feature コミットを積む）。

---

## 5. Excel 方針（重要・**忘却防止メモ** / Windows まで保留）

> ⚠️ **このセクションは「忘れないように」とユーザーから明示依頼された記録。**

- **フェーズ1 でやること**: Excel のコードを書く。
  - **exceljs 専用ステップ**（`excel_open/read/write/range`）= ファイルベース。Excel アプリ不要なので **Mac で単体テストする**。
  - **キー送出レシピ**（既存 key_combo/type/clipboard の列で Excel アプリを操作）= コードとサンプルを用意する。
- **フェーズ1 でやらないこと（Windows 移行後に回す）**:
  - キー送出の **Excel アプリ実機操作の機能テスト**（Excel アプリが必要なため）。
  - **ロボパット郵便番号並べ替えの“キー送出”再現の実機検証**（Mac の Excel ショートカットは Windows と異なるため、本番相当は Windows で）。
  - Windows 固有の Excel ショートカット互換・実機での動作確認全般。
- 根拠: ロボパット基礎編の Excel = 画像認識に頼らず**キーボードショートカット送出で Excel アプリを直接操作**（専用 Excel コマンド群は資料のない別コース）。`docs/research/robopat-feature-catalog.md` §H 参照。

---

## 6. 検収（Definition of Done）

フェーズ1「固まった」と言える条件（**Excel アプリ操作の実機検証を除く**＝§5 で Windows 保留）:

1. **全テスト緑**: `pnpm rebuild better-sqlite3` 後、`pnpm -r run test:run` が全緑。新機能（screen層・clipboard・exceljs・地ならし）に**回帰テストを追加**して緑。
2. **screen層**: 「画面上の既知画像を見つけてクリック」「指定領域の OCR 読取→変数」が統合テストで通る。
3. **代表シナリオ録画→再生**: 以下を録画→（必要なら編集）→再生で再現。
   - Web ログイン 1 本（open_url→type→click→extract）。
   - デスクトップアプリ操作 1 本（click/doubleClick/rightClick/type/key_combo/scroll/drag）。
   - exceljs データ操作 1 本（フィクスチャ .xlsx 読取→加工→書込、**Mac 実行可**）。
4. **郵便番号並べ替えの再現**: exceljs 版（範囲読取→ソート→書込）を Mac で。※“キー送出”版の実機再現は Windows 保留（§5）。
5. **メガフロー**: §7 の「ほぼ全機能フロー」が**最後まで成功**するまで実装を直す。

---

## 7. 検収テストの実施方法（ユーザー向け詳細手順）

> ユーザーが手動で検証する場合の手順。実装者は**このフローを組み、成功するまで直す**こと。

### 7.1 メガフローが使う機能（Mac 実行可能な“ほぼ全部”）
1 本のフローに以下を盛り込む:
- **Web**: `open_url` → `type`（入力）→ `click` → `extract`（値取得）→ `set_var`
- **待機**: `wait` / `wait_for`（web.element, desktop.element, screen.screen_stable, expr）
- **screen層**: 画像を探して `click`（image セレクタ）＋ 領域 `ocr` 読取 → `set_var`
- **デスクトップ**: 対象アプリで `click/doubleClick/rightClick/type/key_combo/scroll/drag`
- **clipboard**: コピー → 変数 → ペースト
- **制御フロー**: `if` / `loop` / `try`
- **Excel(exceljs)**: `excel_read`（フィクスチャ）→ 加工 → `excel_write`（出力）※ファイルベースなので Mac 可
- `log` / 必要なら `manual_pause`
- ※**除外**: キー送出による Excel アプリ操作（§5 で Windows 保留）

### 7.2 実行手順
1. **準備**: `pnpm install` → `pnpm rebuild better-sqlite3` → サイドカービルド（`sidecars/macos-native` を `swift build` 等、プロジェクトの既定手順に従う）。
2. **権限**: macOS のアクセシビリティ / 画面収録 / 入力監視 の権限を Hermes（または開発実行プロセス）に付与。
3. **自動テスト**: `pnpm -r run test:run` が全緑であることを確認。
4. **メガフロー再生（2通り）**:
   - **CLI（推奨・A4 完成後）**: `hermes run <megaflow.json>` を実行し、終了コード0・ログで各ステップ成功を確認。
   - **UI**: アプリ起動 → メガフローを開く/録画 → 実行 → タイムラインで各ステップが緑、Run ログにエラーなしを確認。
5. **合否**: 全ステップ成功＝合格。途中失敗時はログの該当ステップを実装者に共有（実装者が直して再実行）。

### 7.3 サンプル資産の置き場所（実装時に用意）
- `megaflow.json`（検収用フロー）と Excel フィクスチャ（`*.xlsx`）はリポジトリ内のフィクスチャ置き場に置き、CLI/テストから参照できるようにする。

---

## 8. 引き継ぎ / ブランチ / コミット

- ブランチは `feat/phase-1-completion` を継続。
- 本書を含む計画/分析 doc（`docs/plan/*`, `docs/research/*`, `docs/references/README.md`, `.gitignore`）を**先にコミット**（チャットをクリアしても決定が残るように）。
  - `docs/references/` の生資料は `.gitignore` 済み（第三者著作物、README のみコミット）。
- 作業ツリーには既存の未コミット Phase 1 ソース変更（`Screen.swift` 新規ほか）が存在する。**これらは本コミットに含めない**（doc のみ）。実装は新セッションで継続。
- 新セッションの再開手順: 本書 §1〜§7 を読む → step 0（rebuild）→ §4 の順に着手。

---

## 9. フェーズ1スコープ外（やらないこと）

- Windows 実機対応・実機テスト（別フェーズ＝`01-windows-migration.md`）。
- **キー送出 Excel アプリ操作の機能テスト**（§5、Windows 保留）。
- AI 判定層（フェーズ2）・AI 生成層（フェーズ3）。
- スケジューラ/プラグイン等（フェーズ5）。
- 大規模 UI 刷新は H で着手するが、磨き込みの継続はフェーズ1完了後も可。
