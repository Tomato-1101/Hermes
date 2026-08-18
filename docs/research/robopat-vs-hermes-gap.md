# ロボパットDX × Hermes ギャップ分析と追加機能提案

> `robopat-feature-catalog.md`（ロボパットDXの機能インプット）を Hermes の現状能力と突き合わせ、
> **何が足りないか / 何を追加すべきか** を優先度付きで示す。Hermes へ機能追加するときの起点。
>
> Hermes 現状の根拠は実コード読取り（2026-05-30 時点 / ブランチ `feat/phase-1-completion`）。

---

## 0. 要約（結論先行）

- ロボパットの**中核＝画像認識（テンプレートマッチ）＋OCR＋豊富な待機＋マウス操作網羅**。Hermes は IR 定義はあるが**実行系が未実装/未配線**の部分が多い。ここが最大のギャップ。
- 一方 Hermes は **構造化制御（if/loop/try/parallel/subflow）・AX/DOMセレクタ・AI判定層・Vault** でロボパットより**設計が上**。これらは「追わない（むしろ優位）」と整理する。
- **やるべき追加（優先順）**: ① screen層（画像/OCR）の実行系 → ② マウス操作の網羅（double/right/hover/drag/desktop-scroll）→ ③ 画像ベースの待機 → ④ クリップボード → ⑤ 通知/スケジュール/実行録画/入力割込み安全装置 → ⑥ Excel・ファイルDL（大物）。
- すべて **「AIは操作しない／決定論エンジンが実行」** の原則を崩さずに IR ステップとして表現できる。

---

## 1. Hermes 現状能力の棚卸し（実装確認済み）

### IR で定義済みのステップ型（`packages/ir/src/schema.ts`）
`open_url, click, type, key_combo, scroll, wait, wait_for, screenshot, extract, set_var, if, loop, try, parallel, subflow, ai_assert, ai_extract, log, manual_pause`

### セレクタ（`TargetRef.candidates` は候補配列でフォールバック可能 ＝ ロボパットより強い）
- web: `role / testid / label / css / xpath / text / url-anchor`
- desktop: `ax`（macOS AX）/ `uia`（Windows UIA, 将来）
- screen: `image`（`threshold`, `scaleInvariant`）/ `ocr`（`lang`, `regex`）/ `coords`（screen|window 基準）

### wait_for の種別（`WAIT_FOR_KINDS`）
`time / web.load / web.element / web.url / desktop.element / desktop.app_focus / desktop.window_title / desktop.screen_stable / expr`

### 実装済みハンドラ
- **web provider（Playwright）**: `open_url, click, type, key_combo, scroll, wait, wait_for, screenshot, extract, set_var`（`packages/web-provider/src/handlers.ts`）
- **desktop adapter（macOS）**: `click, type, key_combo, wait_for`（`packages/desktop-adapter/src/handlers.ts`）
- **executor 内の制御構文**: `if, loop, try, log, wait_for`（`packages/engine/src/executor.ts`）。その他は registry 経由で layer 別ハンドラへ委譲。
- **DesktopAdapter インターフェース**には `doubleClick / rightClick / hover / scroll / drag / findElement / screenshot / listApps / focusApp` 等が**既にある**が、**IRステップとしては未配線**（click/type/key_combo/wait_for のみ登録）。
- **AI 層**: `ai_assert`（vision yes/no）/ `ai_extract`（vision extract）＋ Step Library ＋ AllowList（`exec/http/file` は将来用に予約）＋ Vault（keytar, `${secrets.*}`）。
- **humanize**: `mouseSpeedPxPerSec`, `typeDelayMs`（ロボパットの MouseMoveSpeed 相当を既に内蔵）。

---

## 2. 対応表（ロボパット機能 → Hermes）

凡例: ✅実装済み / 🔶部分（IR定義のみ or 一部）/ ❌なし / 🟢Hermesが構造的に優位（追わない）

| ロボパット機能 | Hermes 状況 | 補足 |
|---|---|---|
| クリック（画像/座標） | 🔶 | `click` は web実装済・desktop実装済だが **screen層(image/coords)の探索実行が未実装**。AX/DOM対象なら可。 |
| ダブルクリック / 右クリック | 🔶 | adapter にメソッドあり、IRステップ未配線。`click` の `params.button/clickCount` か新ステップで対応。 |
| ポインター移動 / ホバー | 🔶 | adapter `hover` あり、IR未配線。 |
| 上下スクロール（デスクトップ） | 🔶 | web `scroll` 実装済、desktop `scroll` 未配線。 |
| 画像から画像へD&D | 🔶 | adapter `drag` あり、IRに `drag` ステップなし。 |
| キー操作 / ショートカット送出 | ✅ | `key_combo`（web/desktop実装済）。 |
| 押しキーの繰り返し | 🔶 | `loop` + `key_combo` で表現可。専用糖衣なし。 |
| 文字列入力（画像指定/直接） | ✅/🔶 | `type` 実装済。画像指定先クリックは screen層待ち。 |
| タイピング入力（1文字ずつ） | 🔶 | `type` の `params.delayMs`/humanize で近似。挙動差は要確認。 |
| パスワード非表示入力 | 🟢 | `VarDecl.type:'secret'` + `${secrets.*}` + Vault。マスクより堅牢。 |
| 文字列コピー（クリップボード） | ❌ | クリップボード read/write ステップなし。 |
| 画像キャプチャ＋一致率＋画像検索テスト | 🔶 | `image` セレクタに `threshold/scaleInvariant` 定義済だが**マッチング実行系が未実装**。 |
| 文字判別 / 文字読み取り（OCR） | 🔶 | `ocr` セレクタ定義済だが**OCR実行未実装**。 |
| 複数パターン画像 | 🟢 | `candidates` 配列が元々マルチ候補（より一般化）。 |
| 消える画像のキャプチャ | ❌ | 録画/キャプチャUX上の機能。該当なし。 |
| アプリ起動 | ❌ | アプリ/プロセス起動ステップなし（`focusApp` はあるが起動は別）。 |
| フォルダを開く / ウィンドウ切替 | 🔶 | `focusApp` で前面化は可。フォルダ開くは未。 |
| 指定秒数待機 | ✅ | `wait` / `wait_for time`。 |
| 画像出現/消失まで待機 | ❌ | screen層の画像待ちが未実装（`desktop.element`=AX のみ）。 |
| 画面部分変化まで待機 | 🔶 | `desktop.screen_stable`（stableMs）が近い。「変化が起きるまで」方向は未。 |
| 画面変化完了まで待機 | ✅ | `wait_for desktop.screen_stable`。 |
| 検索タイムアウト/既定一致率 | 🔶 | `timeoutMs` あり。画像探索の既定一致率/タイムアウトは screen層実装時に。 |
| タブ + GoTo | 🟢 | `if/loop/try/subflow/branches` が構造的に優位。GoToは追わない（`OnErrorPolicy {goto}` のみ存在）。 |
| 繰り返し（ループ） | ✅ | `loop`。 |
| リトライ条件 | ✅ | `RetryPolicy`（attempts/backoff/retryOn/betweenAttempts）。ロボパット RetryIf 相当以上。 |
| 変数 / 変数一覧 | ✅ | `set_var` + jsep式 + `extract`。 |
| Excel特化コマンド | ❌ | Excel操作の専用系なし。 |
| Web操作記録 | ✅ | `packages/recorder-web`（click/input/key/navigate を記録）。 |
| Webテキスト取得 | ✅ | `extract`（web）。 |
| Web画像/ファイルダウンロード | ❌ | ダウンロードステップなし。 |
| Webモジュール（ドライバ）管理 | 🟢 | Playwright がブラウザ/ドライバを内包。バージョン整合運用が不要（優位）。 |
| 画面録画（実行録画） | ❌ | `screenshot`/`screenshotOnError` のみ。動画録画なし。 |
| メール/通知 | ❌ | `log` のみ。通知ステップ/実行完了通知なし。 |
| スケジュール実行 | ❌ | フロー予約実行の仕組みなし（ランタイムのみ）。 |
| 実行中ユーザー操作検出→中断警告 | ❌ | `manual_pause` はあるが入力割込みガードなし。`input-monitoring` 権限は定義済。 |
| 終了/中止/再開ホットキー | ❌ | グローバル実行制御ホットキーなし。 |
| スクリプトのパスワード保護 | ❌ | flow.json は平文。OSS方針上、優先度低。 |
| プラグイン | 🔶 | Step Library + AllowList(exec/http/file 予約) が拡張の受け皿。別モデル。 |
| 環境前提（背景色/拡大率/パフォーマンス） | 🟢 | AX/DOM中心なので基本不要。画像フォールバック時のみ `scaleInvariant` で吸収。 |

---

## 3. 追加機能の提案（優先度付き）

各提案は「目的 / 触るpackage / IR表現 / 検証ゴール / AIは操作しない原則との整合」を記す。
原則: 新コマンドはすべて **決定論エンジンが実行する IR ステップ/セレクタ** として足す。AIは生成・判定のみ。

### P1. screen層の実行系（画像テンプレートマッチ + OCR） 🔴最優先
- **目的**: ロボパットの中核を取り込む。AX/DOMで取れない対象（独自描画アプリ、Canvas、リモート画面）に対応。
- **触る**: `sidecars/macos-native`（`Screen.swift` が新規追加済 → ScreenCaptureKit でキャプチャ、テンプレートマッチ実装。OCRは Vision framework）/ `packages/desktop-adapter`（screen層 `findElement` 実装、`image`/`ocr`/`coords` セレクタ解決）/ `packages/engine`（screen層ハンドラ登録）。
- **IR表現**: 既存の `Selector{kind:'image', threshold, scaleInvariant}` / `{kind:'ocr', lang, regex}` / `{kind:'coords'}` をそのまま使う（**スキーマ追加不要**）。`TargetRef.region` で探索範囲限定（ロボパットの「検索範囲指定」相当）。既定一致率は `threshold`、既定タイムアウトは `step.timeoutMs`/`defaults`。
- **検証ゴール**: 既知スクショ画像を画面に出し、`image` セレクタでクリックが当たる統合テスト。一致率しきい値の境界テスト。OCRで既知テキスト領域を読む。
- **整合**: 純粋に決定論。AIは関与しない。

### P2. マウス操作の網羅（double/right/hover/drag/desktop-scroll） 🔴
- **目的**: ロボパットのマウス系コマンド網羅に追従。adapter には実装が**既にある**ので配線とIR表現だけ。
- **触る**: `packages/engine`（ハンドラ登録）/ `packages/desktop-adapter/handlers.ts`（`makeHandler('double_click'/'right_click'/'hover'/'drag'/'scroll')`）/ `packages/ir`（最小スキーマ拡張）。
- **IR表現の選択肢（要決定）**:
  - 案A: `click` ステップに `params.button:'left'|'right'|'middle'` と `params.clickCount:1|2` を足し、`hover`/`drag` は新ステップ。
  - 案B: `double_click` / `right_click` / `hover` / `drag` を独立ステップ型として追加。
  - → recorder/エディタUI/AI Step Library の表現一貫性で決める（§5 の確認事項）。
- **検証ゴール**: 各操作の adapter 単体テスト＋recorderが右クリック/ダブルクリックを記録できる。
- **整合**: 決定論。

### P3. 画像ベースの待機（出現/消失/部分変化） 🟠
- **目的**: 「画像が出るまで/消えるまで/領域が変わるまで」待つ。ロボパットの安定稼働思想の中核。
- **触る**: `packages/ir`（`WAIT_FOR_KINDS` に `screen.image` / `screen.image_gone` / `screen.region_change` 追加）/ `packages/desktop-adapter`（screen層 wait_for ハンドラ、P1依存）。
- **IR表現**: `wait_for` の新 kind。`Step.target`（image セレクタ）＋ `params.region`。既存の `desktop.screen_stable`（落ち着くまで）と相補。
- **検証ゴール**: 画像出現/消失を疑似してタイムアウト/検出を検証。
- **整合**: 決定論。**P1 の後に着手**（依存）。

### P4. クリップボード操作 🟠
- **目的**: ロボパットの「文字列コピー（クリップボード経由）」。コピペ業務の定番。
- **触る**: `packages/ir`（`clipboard_read`/`clipboard_write` ステップ、または `set_var` の source 拡張）/ desktop adapter（OSクリップボードAPI）/ web provider（必要なら）。
- **IR表現**: 案 `set_var{ params.from:'clipboard' }` と `type{ params.from:'clipboard' }`、または独立ステップ。クリップボード反映待ち（ロボパットの「クリップボード反映待ち時間」）を `params.settleMs` で。
- **検証ゴール**: コピー→変数→ペーストの往復テスト。
- **整合**: 決定論。

### P5. アプリ/ファイル起動・フォルダを開く・ダウンロード 🟠
- **目的**: ロボパットの「アプリ起動/フォルダを開く/Web画像DL」。
- **触る**: desktop adapter（プロセス/シェル起動 → **AllowList 管理下**）/ web provider（ダウンロード待ち受け）/ `packages/ir`（`launch_app` / `open_path` / `download` ステップ、`exec`/`file`/`http` は AllowList で要オプトイン）。
- **IR表現**: `launch_app{ params:{ bundleId|path } }`、`download{ target, params:{ saveTo } }`。`exec` 相当は `defaults.allowList.execAllowedCommands` 必須（既存の安全設計に乗せる）。
- **検証ゴール**: AllowList 未許可時に拒否、許可時に起動するテスト。
- **整合**: 決定論＋AllowListで安全側。

### P6. 通知 / スケジュール / 実行録画 / 入力割込みガード（運用系） 🟡
- **目的**: ロボパットの運用機能（メール通知・予約実行・録画・実行中ユーザー操作で中断警告）。
- **触る**: 主に `apps/hermes`（Main/Renderer のアプリ層）。一部 IR（`notify` ステップ）。
  - **通知**: `notify` ステップ（デスクトップ通知/メール）。実行完了/失敗のアプリ通知。
  - **スケジュール**: アプリ層のスケジューラ（cron的）でフローを起動。IRではなく run-controller 側。
  - **実行録画**: ScreenCaptureKit で実行中を録画（P1のキャプチャ基盤を流用）。`defaults.recordVideo`。
  - **入力割込みガード**: `input-monitoring` 権限（定義済）でユーザー操作を検出し、実行を一時停止/警告（ロボパットの「中断警告」、誤検知時オフも踏襲）。
- **検証ゴール**: スケジューラが指定時刻にフロー起動 / 実行中の人手操作で停止する。
- **整合**: 決定論。AIは無関係。

### P7. Excel・ファイルデータ操作（大物・将来） 🟡
- **目的**: ロボパットの「Excel特化コマンド群」。表データの読み書きはRPA需要が大きい。
- **触る**: 新規 provider（例 `packages/excel-provider`、`xlsx`/`exceljs` でファイルベース操作）or デスクトップのショートカット送出（`key_combo`列）で近似。
- **IR表現**: `excel_read` / `excel_write` / `excel_range` 等の専用ステップ族（スコープ大、別途設計）。
- **検証ゴール**: セル読取/書込/範囲操作の単体テスト。
- **整合**: 決定論。**スコープが大きいので独立フェーズで設計**。

---

## 4. Hermes が既に優位な領域（＝追わない / むしろ強みとして打ち出す）

| 領域 | Hermes | ロボパット |
|---|---|---|
| 制御フロー | 構造化（if/loop/try/parallel/subflow/branches） | GoTo + タブ（素朴） |
| セレクタ | 候補配列でAX/DOM/画像/座標を**フォールバック** | 画像認識中心（単一方式寄り） |
| 機密情報 | Vault(keytar) + `${secrets.*}` + `secret`型 | パスワード非表示入力（マスクのみ） |
| 環境依存 | AX/DOM主体で背景色/拡大率に非依存 | 背景色単色化・拡大率固定が必須 |
| ブラウザ | Playwright内包（ドライバ整合不要） | Webモジュール（ドライバ）版数整合の運用負荷 |
| AI層 | Mode2(判定)/Mode3(生成)、AIは操作しない原則 | AI判定/生成層なし |
| 再現性 | 決定論IRでbit-for-bit再生 | （明示なし） |
| OS | macOS先行・将来クロス | Windows専用 |

> ロボパットの「環境前提・ドライバ管理・GoTo」は**弱点の裏返し**。Hermesはそこを追わず、画像認識は「最後のフォールバック」として P1 で足すのが筋。

---

## 5. 次アクション / 着手前に決めたい確認事項

1. **着手対象の優先**: まず **P1（画像/OCR実行系）** から着手で良いか？（ロボパット中核・`Screen.swift` 追加済みで地ならしあり）。それとも配線が軽い **P2（マウス操作網羅）** から早く価値を出すか。
2. **IR表現の方針（P2）**: マウス操作を `click` の `params` 拡張（案A）にするか、独立ステップ型（案B）にするか。recorder/エディタ/AI Step Library の一貫性に影響。
3. **スコープ**: P6（運用系: 通知/スケジュール/録画/入力ガード）と P7（Excel）は大きい。今フェーズに含めるか次フェーズか。
4. **応用編教材**: 本インプットは「基礎編」のみ。条件分岐(IF)・エラー処理・より高度なExcel/Webコマンドは**応用編資料**にある可能性。あれば `docs/references/` に追加投下を。

> 提案: **P1 → P2 → P3 → P4** を Phase 1 完了の延長として順に。各 P は「再現テストを書いて通す」をゴールに設定（CLAUDE.md の Goal-Driven）。どの P から着手するか指示があれば、その実装計画（Plan）に進む。
