# Hermes — 3-in-1 RPA アプリ 実装プラン

## Context

tomato さんが、決定論的な実行エンジン＋録画＋編集 UI を「土台」とし、その上に 3 つのモード（① 普通の RPA、② AI 判定組込 RPA、③ AI 生成エージェント）を段階的に積む RPA アプリ「Hermes」を作りたい。新規プロジェクト（空ディレクトリ `/Users/tomato/Project/Hermes`）。

**根本動機**：「AI は 100% 正解できない／プログラムは 100% 再現できる」を分離する。AI には**操作させない**。AI は判定役・生成役だけ。実機操作は決定論コードに固定する。

**配布形態の見立て**：自分＋仲間で使う。GitHub に **public で OSS リポジトリ**（フェーズ 0 から公開）として置き、利用者には**ソース配布 / 自前ビルド** で渡す方針。DMG や NSIS パッケージの一般配布はやらない。よって **コードサイン / Notarization は不要**（CI から関連ステップは外す）。

**MVP の到達点**：フェーズ 1 で「普通の RPA として、ブラウザ操作とデスクトップアプリ操作の両方が録画 → 編集 → 再生できる」状態（モード 1 完成）。その後にモード 2 → モード 3 と積み上げる。

**意図する成果**：
1. 土台が固まれば、上に層を足すだけでモード 2／3 が自然に乗る構造
2. モード 3 は「AI が任意のコードを書く」ではなく「**事前定義された Step Library から正しく組み合わせる**」モデル（tomato さんの強い指定）。将来 exec 等を許す場合も**ホワイトリスト機構**で必ず縛る
3. macOS で集中開発 → Windows へ移植する設計（OS 抽象化レイヤを最初から）

---

## ゴールと不変条件（全モード共通）

- **操作は Engine → Provider しか行わない**。AI モジュールは Provider への参照を持たない（構造で強制）。
- **IR は単一フォーマット**。録画でも AI 生成でも出口は `Flow IR (JSON)`。Editor から見て両者は同じ。
- **OS 依存コードは `DesktopAdapter` 配下に完全隔離**。Engine は OS を知らない。
- **シークレットは IR 本体に書かない**。録画時に `type=password` / AX secure を検出して自動 Vault 化、IR には `${secrets.foo}` 参照のみ。
- **AI 生成はホワイトリストされた Step Library からのみ**。任意コード実行・任意 HTTP・任意 JS は出力ボキャブラリに**存在しない**。将来追加するときも**フローごとに明示 ON + URL / コマンドのホワイトリスト**の三重制限。

---

## 確定事項（質問ラウンドで決まったもの）

| 項目 | 決定 |
|---|---|
| プロジェクト名 | **Hermes**（変更なし） |
| OS（MVP） | macOS のみ。最低バージョン **macOS 13 Ventura 以上**（ScreenCaptureKit が使える） |
| OS（後続） | Windows 移植（フェーズ 4）。最終的に Windows が主配布対象になる想定 |
| Desktop 自動化方針 | ハイブリッド：Accessibility (mac は AX / Win は UIA) を主、OCR / 画像認識をフォールバック |
| AI プロバイダ | OpenRouter（マルチプロバイダ切替、ユーザーが自分の API キーを設定） |
| GitHub 公開 | **フェーズ 0 から public** |
| OSS ライセンス | **後で決める**（実装優先、制限は最小寄り）。`LICENSE` は仮置きで `TBD` のままで開始 |
| 配布 | **ソース配布 / 自前ビルド**のみ。DMG / NSIS の一般配布はしない |
| コードサイン / Notarization | **やらない**（Apple Developer Program 加入もしない） |
| 録画ブラウザのコンテキスト | **フローごとの専用プロファイル**（Cookie / localStorage はフローディレクトリに保存。シークレットは Vault 経由で暗号化） |
| デフォルトブラウザ | **Chromium のみ DL**。Firefox / WebKit は UI から「追加 DL」ボタン |
| クラウド同期 | **なし（ローカル完結）**。Git バックエンド同期はフェーズ 5 で検討 |
| テレメトリ / クラッシュ報告 | **一切実装しない**（送信機構をコードに入れない）。デバッグはローカルログのみ |
| AI コスト機能 | **ダッシュボード可視化のみ**。自動停止 / 上限機能は v1 では作らない |
| OCR 言語パック | **初回利用時 DL**（日本語 + 英語、PaddleOCR） |
| 既存 RPA 互換 | **やらない**（Hermes 独自 IR のみ） |
| Step Library 拡張ポリシー | v1 は **exec / 任意 HTTP / 任意 JS なし**。将来許可するときも**ホワイトリスト機構**で縛る |
| IR 式言語 | **JS 風（jsep AST + ホワイトリスト関数）** |
| UI 言語 | **日本語のみ**（i18next フレームワークは入れる。中・英は将来 PR で追加可） |
| プラグイン / 拡張機構 | **v1 では作らない**。コアのみ。フェーズ 5 で議論 |

---

## アーキテクチャ全体図

```
+-------------------------------------------------------------------+
|              Electron Renderer (React + TS + zustand)             |
|  Editor UI | Timeline/Inspector | Mode1/2/3 Panels | Run Log      |
+-------------------------- typed IPC ------------------------------+
|                     Electron Main (Node.js + TS)                  |
|  Orchestrator (Project / Run Controller / Event Bus)              |
|      │              │                  │                          |
|  Execution    Recorder Service     AI Services                    |
|  Engine       (Web / Desktop)      (Judge / Generator)            |
|      │              │                  │                          |
|  Web Provider  Desktop Provider   OpenRouter Client               |
|  (Playwright)  (DesktopAdapter)   (model switch / cost dashboard) |
|                     │                                             |
+--- spawn / JSON-RPC over Unix Domain Socket ----------------------+
                      │
        +-------------v---------------+   +-------------------------+
        | Native Sidecar              |   | Python Sidecar (optional)|
        | mac: Swift (AX/CGEvent/SCK) |   | OpenCV / PaddleOCR       |
        | win: C#  (UIA/SendInput)    |   | image template / OCR     |
        +-----------------------------+   +-------------------------+

Storage: SQLite (meta) + FileSystem (flow.json + assets/*.png) + keytar Vault
```

**プロセス分割の意図**：
- Sidecar を別プロセスにすることで、Electron 本体のクラッシュとネイティブ機能の動作を分離
- Python は OCR / 画像認識のオプショナル機能としてのみ用意（**初回利用時にダウンロード**、コア機能は Python 無しで動く）

---

## 操作 IR（中間表現）の設計

### スキーマ概要（TypeScript 型イメージ）

```ts
type Flow = {
  schemaVersion: "1.0"
  id: string; name: string; description?: string
  inputs: VarDecl[]; outputs: VarDecl[]; variables: VarDecl[]
  defaults: { timeoutMs: number; retry: RetryPolicy; screenshotOnError: true }
  steps: Step[]
  metadata: { origin: "recorded" | "ai-generated" | "mixed"; targets: ("web"|"desktop")[]; requiredPermissions: string[] }
}

type Step = {
  id: string // ulid
  type: "click" | "type" | "wait" | "wait_for" | "open_url" | "key_combo"
      | "scroll" | "screenshot" | "set_var" | "extract"
      | "if" | "loop" | "try" | "parallel" | "subflow"
      | "ai_assert" | "ai_extract" | "log" | "manual_pause"
  label?: string; enabled: boolean
  target?: TargetRef
  params?: Record<string, unknown>
  timeoutMs?: number; retry?: RetryPolicy
  assert?: Assertion[]
  onError?: "fail" | "continue" | "retry" | { goto: string }
  children?: Step[]
  meta?: { recordedAt?: string; generatedBy?: string; screenshotRef?: string; confidence?: number; needsRecording?: boolean }
}
```

### **設計の心臓：`TargetRef` のセレクタ候補配列**

1 つの操作対象に **N 個の独立した識別戦略** を保存。再生時は上から試して**最初にユニーク 1 件**当たったものを採用。

```ts
type TargetRef = {
  layer: "web" | "desktop" | "screen"
  candidates: Selector[]   // 上から試す
  preferIndex?: number     // 直近成功した候補（学習用）
  anchor?: AnchorRef
  region?: Rect
}

type Selector =
  // Web
  | { kind: "role"; role: string; name?: string; exact?: boolean }
  | { kind: "testid"; value: string }
  | { kind: "label"; text: string }
  | { kind: "css"; value: string }
  | { kind: "xpath"; value: string }
  | { kind: "text"; value: string }
  // Desktop (macOS AX / Windows UIA)
  | { kind: "ax"; app: string; role: string; title?: string; identifier?: string; path?: AXPath }
  | { kind: "uia"; processName: string; automationId?: string; controlType: string; name?: string }
  // Screen fallback
  | { kind: "image"; assetRef: string; threshold: number; scaleInvariant?: boolean }
  | { kind: "ocr"; text: string; lang: string }
  | { kind: "coords"; x: number; y: number; anchor: "screen" | "window" }
```

録画時は 1 操作に対し、Web で 5〜7 種、Desktop で 3〜5 種の Selector を**全部スナップショット**して配列化。画像もアセット保存。これにより**サイトの軽微なレイアウト変更で簡単に壊れない**。

### フロー制御
- `if / loop / try / parallel / subflow` を `type` で表現、木構造
- **式言語: jsep AST + ホワイトリスト関数 / 演算子**（任意 JS の `eval` は不採用）。`var.price > 100 && contains(var.text, "OK")` のように JS 風に書ける
- 変数参照: `${var.x}`, `${env.HOME}`, `${secrets.token}`, `${ctx.lastResult}`

### アサーション（モード 2 の正規挿入点）
```ts
type Assertion =
  | { kind: "exists"; target: TargetRef }
  | { kind: "text"; target: TargetRef; op: "eq"|"contains"|"regex"; value: string }
  | { kind: "vision_yes_no"; prompt: string; refs: "before"|"after"|"both" }
  | { kind: "vision_extract"; prompt: string; schema: JsonSchema; into: string }
  | { kind: "expr"; expr: Expression }   // jsep 式
```

### ファイル形式
- JSON（厳密スキーマ、ajv で strict 検証）。YAML は採用しない（差分マージで順序保存が崩れやすい）
- 1 フロー = 1 ディレクトリ：`flows/<id>/{ flow.json, assets/*.png, variables.json, browser-profile/, history/*.jsonl.gz, meta.json }`
- `browser-profile/` がフロー専用のブラウザコンテキスト（Cookie / localStorage）。フロー間で共有しない

---

## 各モードの責務分担

### モード 1（土台）
- Recorder → Normalizer → IR → Engine → Provider
- AI 呼び出しゼロ
- 編集 UI で IR を読み書き

### モード 2（判定層）
- 既存 IR に `assert: [{ kind: "vision_yes_no", ... }]` または `wait_for` ステップを足すだけで成立
- Engine は AI 呼び出しを要するアサーションを `AI Judge` にディスパッチ
- **キャッシュ**: pHash(画像) + prompt + modelId をキーに 1 run 内で再呼出し回避（ループ境界でクリア）
- **コスト爆発対策**: ROI 差分監視で「変化が無ければ AI 呼ばない」、軽量モデル既定、**ダッシュボードで使用量を可視化**（自動停止はしない）
- **誤判定リカバリ**: 同モデル再試行 → 別モデル → exists 系フォールバック → 人手通知

### モード 3（生成層）

tomato さんの指定：「AI が一からコード書くんじゃなく、**常にある動作のセットを組み合わせる**」。Step Library 拡張は**ホワイトリスト制**で。

#### 3-1. Step Library（動作プリミティブ）

AI が出力できるのは「事前定義された Step type の組み合わせ」だけ。LLM の function calling / tool definition として **JSON Schema で完全に縛る**。

許可される Step（v1 セット）:
```
open_url, click, type, key_combo, scroll, wait, wait_for,
screenshot, extract, set_var,
if, loop, try, parallel, subflow,
ai_assert, ai_extract, manual_pause, log
```

**含めないもの**: 任意 JS / shell exec / 任意 HTTP / ファイル直書きなど。「AI が独自に発明する余地」を構造的にゼロにする。

#### 3-2. Step Library 拡張のホワイトリスト機構（将来用の枠組み）

将来 `exec` や `http_request` を追加したくなった場合に備え、設計時点で以下の三重制限機構を組み込んでおく（v1 ではこの機構自体は実装し、対応 Step 型は出さない）:

```ts
type AllowList = {
  enabledStepTypes: ("exec" | "http_request" | ...)[]   // フローごとに明示 ON が必要
  execAllowedCommands?: string[]                        // 完全一致のコマンド名 + 引数 pattern
  httpAllowedHosts?: string[]                           // ホスト名のホワイトリスト（部分一致禁止、完全一致）
  fileAllowedPaths?: string[]                           // 絶対パスの prefix リスト
}
```

- フローの `defaults.allowList` で明示的に列挙したものだけが使える
- Library 側ではこの AllowList を取らない `exec` 系の使い方は型エラーで弾く
- Validator は AllowList を超えた使用を deny

これにより「将来許可」が来ても、安全に拡張できる。

#### 3-3. 入力 → IR 生成パイプライン

```
[入力]
  - 自然言語の指示
  - URL (任意・複数)
  - スクショ / 画像 (任意・複数)
  - HTML スニペット (任意)
  - 既存フロー (修正モード時)
        │
        ▼
[Preprocessor]
  - URL: Playwright で開いて DOM + 全画面/要素スクショ + 簡約 a11y tree を取得
  - HTML: minify → 簡約 a11y tree
  - 画像: OCR で見出し抽出を補助コンテキストに
        │
        ▼
[Planner LLM]
  System: 「Hermes RPA の IR を作る設計者。許可された Step Library のみ使う」
  Tools : Step Library を function calling で定義（JSON Schema 強制）
  Output: Step[] (JSON)、各 Step に rationale を 1 行
        │
        ▼
[Selector Refiner]
  - Planner が出した「これをクリック」を、実 URL の DOM / a11y tree と突き合わせて
    具体的な Selector[] 候補配列に解決
  - 解決不能 → meta.needsRecording = true マーカー（赤い未確定 Step として UI 表示）
        │
        ▼
[Validator]
  - ajv で Flow schema strict 検証
  - 危険操作サニタイズ (AllowList 違反を deny)
  - 変数 / シークレット / アセット参照の解決
        │
        ▼
[Preview UI]
  - Editor のタイムラインに「未承認」状態（緑バッジ）で表示
  - Step-through Approval: 1 個ずつ実行 → スクショ確認 → Approve / Edit
  - 高信頼度ステップは一括承認
        │
        ▼
[本実行]
```

#### 3-4. 録画と AI 生成が同居しても壊れない設計

- 両者とも出力は `Step[]`。違いは `meta.origin = "recorded" | "ai-generated"` と `meta.confidence` だけ
- Editor は origin を「小さなバッジ」で出すだけで、それ以外は完全に同等に編集可
- 「録画した骨格に AI 生成のステップを差し込む」「AI 生成の一部を再録画で差し替える」が自然に動く
- 既存フローを AI に修正させる場合、JSON Patch を UI で diff レビュー

#### 3-5. AI が「分からない」を扱う

- 解決不能 / 不確かなステップは `manual_pause` または `meta.needsRecording = true` のプレースホルダで残す
- Editor で「ここから録画して埋める」ボタンを表示 → Recorder を起動して差分挿入

---

## OS 抽象化レイヤ

### `DesktopAdapter` インターフェイス（Engine が見るもの）

```ts
interface DesktopAdapter {
  findElement(sel: DesktopSelector, opts?: { timeoutMs?: number; region?: Rect }): Promise<ElementHandle | null>
  click(target: ElementHandle | Point, opts?: ClickOpts): Promise<void>
  type(text: string, opts?: { secret?: boolean; intervalMs?: number; clearFirst?: boolean }): Promise<void>
  keyCombo(keys: string[]): Promise<void>          // ["primary", "s"] が両 OS で「保存」
  scroll(target: ElementHandle | Point, dx: number, dy: number): Promise<void>
  screenshot(opts?: { region?: Rect }): Promise<Buffer>
  waitForState(predicate: () => boolean | Promise<boolean>, opts?: WaitOpts): Promise<void>
  listApps(): Promise<AppInfo[]>; focusApp(ref: AppRef): Promise<void>
  ensurePermissions(): Promise<PermissionStatus>
}
```

### macOS 実装（フェーズ 1 で完成、最低 macOS 13）
- **要素ツリー**: Swift で `AXUIElementCreateApplication` / `kAXChildrenAttribute` / `AXUIElementCopyElementAtPosition`
- **入力**: `CGEventCreateMouseEvent` + `CGEventPost`, `CGEventCreateKeyboardEvent`
- **スクリーン**: `ScreenCaptureKit`（macOS 13 で安定）
- **イベントフック（録画）**: `CGEventTap` でグローバルマウス / キー、`NSWorkspace` でアプリ切替
- **権限**: Accessibility / Screen Recording / Input Monitoring（起動時にプリチェック + 設定アプリ誘導）
- **同居しない**: `nut-js` / `robotjs` は権限と精度で不利。自前 Swift サイドカーで一本化

### Windows 実装（フェーズ 4 で差し替え）
- **要素ツリー**: C# / .NET で UI Automation (UIA3) 直叩き or FlaUI
- **入力**: `SendInput` (user32.dll)
- **スクリーン**: `Windows.Graphics.Capture` (WinRT) or GDI BitBlt
- **フック**: `SetWindowsHookEx` low-level mouse/keyboard

### 単一 IR が両 OS で動くための制約
- キーは仮想キーコードではなく**名前**で（`"cmd"`/`"ctrl"`、論理プライマリは `"primary"`）
- 座標は「ウィンドウ相対」と「画面絶対」を分けて保存
- Desktop Selector は AX / UIA を主、画像を fallback として**両 OS で必ず両方残す**
- アプリ識別は `AppRef = { bundleId?, processName?, exePath?, titlePattern? }`

---

## 技術選定

| レイヤ | 採用 | 理由 |
|---|---|---|
| アプリ | Electron + Vite + TS | Playwright と同居容易、UI 表現力 |
| パッケージマネージャ | pnpm（monorepo workspace） | 高速・サイドカー含む構造に最適 |
| UI | React 18 + TS + zustand + Radix/shadcn + dnd-kit | Tree DnD / Timeline に強い |
| 状態管理 | zustand + Immer + JSON Patch（Undo/Redo） | 履歴サイズ小 |
| 言語 | TS 全面 + Swift(mac) サイドカー + Python(オプション) | 領域ごとに最適 |
| Web 自動化 | Playwright (Node) | 録画基盤として現状最強、3 ブラウザ横断 |
| Desktop 自動化 | 自前 Swift サイドカー（JSON-RPC over Unix Socket） | nut-js は権限・精度・Apple Silicon で不利 |
| 画像認識 | OpenCV (Python オプション)、将来は onnxruntime-node | コア機能は Python 無しで動かす |
| OCR | PaddleOCR（日本語 + 英語）+ Tesseract バックアップ | 初回 DL でバンドル軽量化 |
| AI クライアント | OpenRouter（薄い自前 SDK） | モデル切替・コスト可視化・フォールバックを 1 か所 |
| DB | better-sqlite3 | 同期 API・トランザクション |
| バンドル | electron-vite + electron-builder | universal mac、ローカルビルド前提 |
| 自動更新 | **なし**（ソース配布・自前ビルドのため） | — |
| コードサイン / Notarization | **なし** | — |
| テスト | Vitest（UI/ロジック）+ Playwright（E2E）+ IR ゴールデン再生テスト | Engine 単体テストが容易 |
| ロギング | pino + ファイルローテート | 高速 JSON ログ・ローカル完結 |
| シークレット | keytar（OS Keychain） | パスワード／API キー保護 |
| 国際化 | i18next（日本語のみ、フレームワークは入れる） | 将来 PR で他言語追加可能 |
| テレメトリ / クラッシュ報告 | **なし**（コードに送信機構を入れない） | — |

### 大手 RPA との位置取り
- UiPath / Power Automate Desktop は .NET / WPF・Windows ネイティブで強いが macOS 不可
- Robocorp / Robot Framework は Python スクリプト主導で GUI が弱め
- Bardeen / Browserflow は Web 拡張に閉じる

→ 「Electron + TS + Playwright + ネイティブサイドカー」は、これら全部の欠点を埋めるための妥当解。

---

## ディレクトリ構造（想定）

```
/Users/tomato/Project/Hermes/
├── package.json                    # workspace root
├── pnpm-workspace.yaml
├── README.md                       # ビルド手順（自前ビルド前提なので厚く書く）
├── LICENSE                         # TBD
├── .github/
│   └── workflows/
│       ├── ci.yml                  # lint / type / test （notarize なし）
│       └── build-mac.yml           # ローカルビルド検証用（artifact 化はしない）
├── apps/
│   └── hermes/                     # Electron app (Main + Renderer)
│       ├── src/main/               # Main process
│       ├── src/renderer/           # React UI
│       └── src/preload/
├── packages/
│   ├── ir/                         # Flow / Step / TargetRef 型・JSON Schema
│   ├── engine/                     # Step Executor
│   ├── recorder-web/               # Playwright ベース Web Recorder
│   ├── recorder-desktop/           # Swift サイドカー連携
│   ├── desktop-adapter/            # OS 抽象化（mac 実装含む）
│   ├── web-provider/               # Playwright Provider
│   ├── ai/                         # OpenRouter Client + Step Library + Generator
│   ├── storage/                    # SQLite + FileSystem + keytar Vault
│   └── ui-kit/                     # 共通コンポーネント
├── sidecars/
│   ├── macos-native/               # Swift package
│   │   ├── Package.swift
│   │   └── Sources/HermesNative/
│   └── python-vision/              # OpenCV / PaddleOCR (optional)
│       ├── pyproject.toml
│       └── hermes_vision/
└── tests/
    ├── ir-golden/                  # IR ゴールデン再生テスト
    └── e2e/                        # Playwright E2E
```

---

## フェーズロードマップ

> 期間は粒度感（フルタイム 1 名想定）。

### フェーズ 0: 基盤・権限・OSS リポジトリ整備（2〜3 週）
- Electron + Vite + TS のスキャフォルド（pnpm workspace）
- 型安全 IPC（zod スキーマで Main ↔ Renderer）
- Swift サイドカー雛形（Unix Socket JSON-RPC、ping/pong まで）
- 権限取得 UX（Accessibility / Screen Recording / Input Monitoring）— macOS 13 専用
- `flow.json` schema ver 1 + ajv バリデータ
- SQLite 初期化 + ファイル構造
- **GitHub public リポジトリ初期化**（README にビルド手順、CONTRIBUTING、Issue templates）
- **検収**:
  - `pnpm dev` で空アプリ起動
  - `hermes-native ping` で Sidecar 疎通
  - 権限 4 種チェック画面が動く
  - `pnpm build:mac` でローカル .app が生成 → 起動できる
  - GitHub public repo が立っており、README どおりに他人がビルドできる

### フェーズ 1: モード 1 完成（Web + Desktop の最小ループ）（6〜8 週）

**1a. Web (3〜4 週)**:
- Playwright を Main から起動、**フローごとの専用プロファイル**で録画
- `click` / `type` / `open_url` / `wait_for(url)` を IR 化
- Selector 候補配列（role/testid/label/css/xpath/text）を一括生成
- 編集 UI 最小版（Timeline 追加・削除・並べ替え、Inspector）
- Step 実行（ブレークポイント、変数ウォッチ）
- スクショ自動保存
- **検収**: テストサイト（自前 or DemoQA）のログイン → 遷移 → データ貼付を 10 回連続成功

**1b. Desktop (3〜4 週)**:
- Swift サイドカーで AX 要素取得 + CGEventPost + CGEventTap
- `DesktopAdapter` mac 実装
- Recorder：マウスダウン / キーから IR
- 画像 fallback（Python OpenCV テンプレマッチ）の最小実装
- **検収**: macOS の「メモ / 計算機 / Pages」で簡単操作を録画 → 再生成功、AX 取れないアプリで画像 fallback トリガを確認

**1c. 編集 UI 仕上げ (フェーズ 1 末に並行)**:
- `if` / `loop` / `try` の編集・実行（**式言語 = jsep + ホワイトリスト**）
- Vault UI（パスワード自動マスキングのデモ）
- Undo/Redo（JSON Patch スタック）
- **検収**: 「Web で CSV ダウンロード → ローカル Excel に貼付」が動く

### フェーズ 2: モード 2（AI 判定層）（2〜3 週）
- OpenRouter Client（モデル切替・**コスト可視化ダッシュボード**・ストリーミング・function calling）
- `ai_assert` / `wait_for(vision_yes_no)` Engine 実装
- pHash + ROI 差分監視によるキャッシュ
- 失敗時の階層リカバリ（再試行 → 別モデル → exists fallback → 人手通知）
- 実行ログでの判定可視化（スクショ + 結果 + reason）
- **検収**: 「SaaS にログイン → ダッシュボードが見えるまで AI で待機」が安定動作、ループ内で課金が爆発しないこと、ダッシュボードに使用量が反映されること

### フェーズ 3: モード 3（AI 生成層）（4〜6 週）
- **Step Library 確定**（ホワイトリスト型の function calling tools 定義）
- **AllowList 機構の枠だけ実装**（v1 では exec / http は出さない）
- Planner LLM（OpenRouter 経由、function calling で IR 強制）
- Preprocessor（URL → Playwright DOM スナップショット、HTML → a11y tree 簡約、画像 → OCR）
- Selector Refiner（実 DOM と突き合わせて Selector[] 解決、不能なら `needsRecording` マーカー）
- Validator（schema 検証、AllowList チェック、JSON Patch diff）
- Preview UI（未承認ステップ表示、Step-through Approval）
- **検収**: 「自然言語：『○○の SaaS にサインアップして、初期設定をスキップ、設定でメール通知をオフに』」が概ね通る or 詰まる箇所だけ手動録画で補完可能

### フェーズ 4: Windows 移植（3〜4 週）
- C# / .NET サイドカー（UIA3 + SendInput + WinRT Capture）
- `DesktopAdapter` Windows 実装
- 抽象キー / 修飾キーマッピングの動作確認
- ローカルビルド手順を README に追記（**Windows もコードサインなし、自前ビルド**）
- **検収**: macOS で作ったシンプルフローを Windows 上で再生成功

### フェーズ 5（後続）: 拡張議論
- スケジューラ / CLI ランナー（`hermes run flow.json --vars=...`）
- サブフローライブラリ・共有
- プラグイン / 拡張機構の設計
- Git 同期（GitHub repo を 1 ディレクトリ = 1 フローとして使う）
- 既存 RPA 互換（必要があれば）

---

## 重要な設計ファイル（最初に固める基幹）

- `/Users/tomato/Project/Hermes/packages/ir/src/schema.ts` — Flow / Step / TargetRef / Selector の TS 型 + JSON Schema + バージョニング
- `/Users/tomato/Project/Hermes/packages/ir/src/expr.ts` — jsep ベース式評価器（ホワイトリスト演算子・関数）
- `/Users/tomato/Project/Hermes/packages/engine/src/executor.ts` — Step Executor の dispatch / context / abort / event emit
- `/Users/tomato/Project/Hermes/packages/desktop-adapter/src/index.ts` — `DesktopAdapter` インターフェイス
- `/Users/tomato/Project/Hermes/packages/recorder-web/src/index.ts` — Playwright ベース Web Recorder のイベント → IR 正規化
- `/Users/tomato/Project/Hermes/packages/ai/src/openrouter-client.ts` — モデル切替・コスト可視化・function calling
- `/Users/tomato/Project/Hermes/packages/ai/src/step-library.ts` — モード 3 で AI に渡す Step Library JSON Schema（**生成の安全性の核**）
- `/Users/tomato/Project/Hermes/packages/ai/src/allow-list.ts` — 将来用のホワイトリスト機構（v1 では枠だけ）
- `/Users/tomato/Project/Hermes/sidecars/macos-native/Sources/HermesNative/` — Swift サイドカー（AX / CGEvent / SCK / CGEventTap）

---

## 主要リスクと対策

| リスク | 影響 | 対策 |
|---|---|---|
| macOS 権限取得 UX が辛い | フェーズ 0〜2 全部 | プリチェック → 設定アプリ深部リンク + 動画案内、ダミー API コールで権限ダイアログ発火、再ログイン要否を明記 |
| ローカルビルドが他人 PC で通らない | OSS 配布のキモ | README にビルド手順を厚く記載、`pnpm install && pnpm build:mac` の 1〜2 コマンドに収める、CI で同じ手順を回す |
| ネイティブモジュールの cross-arch ビルド | リリース全般 | electron-builder `--mac=universal`、Sidecar はアーキ別バイナリを Resources に同梱・起動時自動選択 |
| バンドルサイズ肥大（Python 同梱で 300MB 級） | UX | Python と OCR モデルはオプショナル / 初回 DL、コアは Python 無しで動く |
| Playwright ブラウザバイナリ重い | 配布 | 初回起動時に Chromium だけ DL、Firefox/WebKit は UI から追加 |
| AI コスト爆発（ループ内毎秒判定） | 運用 | ROI 差分 + pHash キャッシュ + ループ境界明示制御 + 軽量モデル既定 + **ダッシュボード可視化**（自動停止はないので人間が見る） |
| セレクタ崩れ | モード 1 全般 | 候補配列 + 画像 fallback + AX/UIA 同時保存 + `preferIndex` で学習 |
| AI 生成 IR が破壊操作を含む | モード 3 | Step Library に危険型を入れない（fail safe）+ AllowList 機構 + Validator で deny + Step-through Approval |
| パスワード等の漏洩 | プライバシ | 録画時に password input / AX secure 検出 → 自動 Vault 化、IR に生文字列残さず、スクショの該当領域を自動ブラ |
| 長時間動作の安定性 | 運用 | Playwright を一定期間で再起動、Sidecar に health-check + 自動再起動 |
| マルチモニタ / DPI | フェーズ 4 | ウィンドウ相対座標 + DPI 補正をフェーズ 1〜2 から両 OS でユニットテスト |
| IR スキーマ変更で過去フローが壊れる | バージョン管理 | `schemaVersion` + migration 関数列、CI で migration テスト必須 |
| macOS CI でのテスト容易性 | 開発 | 実機テスト + IR ゴールデン再生（DOM スナップショットへの再生）+ GitHub Actions macOS runner |
| ライセンス未確定の状態で OSS 公開 | 法務 | `LICENSE` を `TBD` のまま置く、README に「ライセンスは確定後に追加します。それまで第三者の派生 / 再配布は推奨しません」と明記 |

---

## 実装中に決めれば足りる残論点（メモ）

以下は plan 段階で決め切らなくても、実装の途中で自然に判断できる項目：

1. **OpenRouter デフォルトモデル**：Vision 既定はコスト重視の軽量モデル（Gemini Flash 系 / Claude Haiku 系）。実装時に最新を選ぶ
2. **AI 判定の信頼度しきい値**：初期は 0.7 で開始、実運用で調整
3. **録画イベント Normalizer のデフォルト挙動**：暗黙 `wait_for` 挿入は ON / OFF 切替可
4. **スクショ保存ポリシー**：フローごとに「過去 N 実行分だけ保存」「合計 X MB 超えたら古いものから削除」のデフォルトを置く
5. **LICENSE 確定**：実装が走り始めたタイミングで再相談

---

## 検証方法（フェーズごとの「動く証拠」）

- **フェーズ 0**: `pnpm dev` で空アプリ起動、`hermes-native ping` で Sidecar 疎通、`pnpm build:mac` でローカル .app が起動、GitHub public repo の README どおりに第三者がビルド可能
- **フェーズ 1a**: テストサイトでログインフローを 10 回連続実行 → スクショ＋ログ確認
- **フェーズ 1b**: macOS の 3 アプリ（メモ・計算機・Pages）で録画 → 再生 10 回連続 → 画像 fallback トリガ確認
- **フェーズ 1c**: 「Web ↔ Desktop ハイブリッド」シナリオを E2E
- **フェーズ 2**: ループ内 AI 判定でコスト爆発しないこと（pHash キャッシュ動作）、判定外れの自動リカバリ動作、ダッシュボードに使用量反映
- **フェーズ 3**: 自然言語入力 → 生成 → Preview → Approve → 実行のフルパス、AllowList 違反が Validator で deny されること
- **フェーズ 4**: macOS 生成フローを Windows 実機で再生

各フェーズで **ゴールデン IR テスト**（保存済みフロー → 期待される実行ログ）を CI に積み、回帰を防ぐ。
