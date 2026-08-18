# 08. 用語集・不変条件・既知の不整合

> 最終更新: 2026-05-31 ／ 対象コミット: b3d5fa6 (feat/phase-1-completion)
> AI用仕様書。コードを読む前にまずこれを読む。該当コードを変更したら同じPRでこのファイルも更新すること。

このファイルは横断的なリファレンス。個別の詳細は各専用ファイル（[01](01-architecture.md)〜[07](07-storage-vault.md)）を参照。
ここには「プロジェクト全体で守られている前提（不変条件）」と「踏みやすい落とし穴」、そして調査で判明した「既知の不整合・未実装（要注意）」を集約する。

---

## 1. 用語集（term → 意味 / 詳細リンク）

| 用語 | 意味 | 詳細 |
|---|---|---|
| **Mode 1** | 決定的RPA（AI不使用）。「記録→編集→再生」。Phase 1 のスコープ。 | [01](01-architecture.md) |
| **IR** | 中間表現（Intermediate Representation）。フローのデータ構造。`@hermes/ir` が定義。 | [02](02-ir-schema.md) |
| **Flow** | 1つの自動化手順全体。`steps[]` とメタ（id/name/version/metadata/defaults）を持つ。 | [02](02-ir-schema.md) |
| **Step** | フローの1操作。`type` で判別する共用体（全26種）。`params` は free-form object。 | [02](02-ir-schema.md) |
| **StepType** | `open_url / click / type / key_combo / scroll / drag / wait / wait_for / screenshot / extract / clipboard_read / clipboard_write / excel_open / excel_read / excel_write / excel_range / set_var / if / loop / try / parallel / subflow / ai_assert / ai_extract / log / manual_pause`（26種） | [02](02-ir-schema.md) |
| **構造的ステップ** | `if / loop / try`（および `log / manual_pause`）。engine が直接解釈し、子を再帰実行する。 | [03](03-engine.md) |
| **WaitForKind** | `wait_for` の判定種別（9種）: `time / web.load / web.element / web.url / desktop.element / desktop.app_focus / desktop.window_title / desktop.screen_stable / expr` | [02](02-ir-schema.md) §6 |
| **TargetRef** | 操作対象の指定。`{ layer, candidates, preferIndex?, anchor?, region? }`。 | [02](02-ir-schema.md) §7 |
| **layer** | 対象の世界。`web` / `desktop` / `screen`。どの provider が処理するかを決める。 | [02](02-ir-schema.md) / [04](04-adapters.md) |
| **Selector** | 対象の探し方。kind 共用体（11種）: `role / testid / label / css / xpath / text / url-anchor`(web) / `ax / uia`(desktop) / `image / ocr / coords`(screen) | [02](02-ir-schema.md) §8 |
| **executor / StepExecutor** | 実行エンジン本体。Flow を走査し、構造を解釈し、通常ステップを handler へ委譲。 | [03](03-engine.md) |
| **HandlerRegistry** | `layer::type` → StepHandler の登録表。layer 無しは `default` にフォールバック。 | [03](03-engine.md) / [04](04-adapters.md) |
| **StepHandler / provider** | 実際の操作を行う関数群。web-provider / desktop-adapter / excel-provider 等。 | [04](04-adapters.md) |
| **ProviderBag** | 実行時に registry へ登録される handler 群の束。app の `run-controller.ts` が組み立てる。 | [04](04-adapters.md) / [05](05-app-electron.md) |
| **sidecar（サイドカー）** | OSネイティブ操作を担う別プロセス。macOS は Swift 製 `hermes-native`、JSON-RPC over Unix Domain Socket。将来 Windows は .NET/named-pipe。 | [06](06-sidecar-macos.md) |
| **recorder** | 操作の記録器。Web は `@hermes/recorder-web`（注入スクリプト）、Desktop は sidecar の `recording.*` を poll。 | [04](04-adapters.md) / [05](05-app-electron.md) §3 |
| **Vault** | 秘密情報（パスワード等）を OS キーチェーンに保管する仕組み。`@hermes/storage`。 | [07](07-storage-vault.md) |
| **FlowStore** | フローのファイルシステム永続化（`flow.json`）。 | [07](07-storage-vault.md) |
| **MetaStore** | better-sqlite3 のメタ DB。※Phase 1 本体では未使用（§3 参照）。 | [07](07-storage-vault.md) |
| **cursor** | 実行位置を表す文字列パス（例 `steps[2].children[0]`）。UI のステップハイライト ID と一致させる。 | [03](03-engine.md) |
| **humanize** | 人間らしい動作（マウス速度・タイプ遅延）の設定。`Flow.defaults.humanize`。 | [02](02-ir-schema.md) / [04](04-adapters.md) |
| **secrets** | 実行時にエンジンへ注入される秘密の解決済み値。IR には `${secrets.<name>}` 参照だけが残る。 | [03](03-engine.md) / [07](07-storage-vault.md) |
| **RunEvent** | 実行中に発火するイベント（`run:start / run:step(start/end) / run:end / log`）。UI へ中継。 | [03](03-engine.md) §8 / [05](05-app-electron.md) §2 |
| **IpcChannels** | `apps/hermes/src/shared/ipc.ts` が定義する IPC チャネル名の唯一の真実。 | [05](05-app-electron.md) §2 |

---

## 2. プロジェクト全体の不変条件（守られている前提）

### 2.1 環境・ビルド
- **Node 22 必須**。既定の Node 26 では `better-sqlite3` がネイティブビルド不整合で落ちる。実行前に `export PATH="/opt/homebrew/opt/node@22/bin:$PATH"`。`.nvmrc` は `22`（ただし `package.json` の `engines.node` は `>=20` で乖離あり → §4）。
- **アプリビルドは `pnpm --filter @hermes/app build`**（内部で electron-vite）。**`npx electron-vite build` は禁止**（グローバルの別バージョンを引き「Cannot find module 'electron/package.json'」になる）。
- **型チェックは `tsc --noEmit -p apps/hermes/tsconfig.json`**（単一 tsconfig）。
- import は **`.js` 拡張子付き**（`moduleResolution: bundler` + `verbatimModuleSyntax`）。`.ts`/`.tsx` ソースでも拡張子は `.js` と書く。
- **Renderer（`apps/hermes/src/renderer/`）に自動テストは無い**。検証は tsc + build + 目視。
- `pnpm-workspace.yaml` の `allowBuilds`（better-sqlite3 / electron / esbuild / keytar）が無いと CI の `pnpm install --frozen-lockfile` が `ERR_PNPM_IGNORED_BUILDS` で落ちる。ネイティブ依存を足したら要更新。
- electron-vite が main で external にするのは `electron` / `node:*` / `better-sqlite3` / `keytar` / `playwright-core` のみ。それ以外は `out/main/index.js` にバンドルされる。

### 2.2 IR・スキーマ
- `schemaVersion` は常に `'1.0'`。
- **秘密情報を IR にインラインしてはいけない**。`${secrets.<name>}` 参照のみ許可。
- **TS 型（`schema.ts`）と JSON Schema（`json-schema.ts`）は手動同期**。検証は ajv draft-07 strict（zod は IR では不使用）。
- `Step.params` は free-form（IR が保証するのは「object であること」まで）。各 type の具体 param は engine/adapter 側の約束（[03](03-engine.md)/[04](04-adapters.md)）。
- ID は **ULID**。式評価は **jsep の allow-list**（`eval` 不使用、`__proto__` 等禁止、関数は whitelist のみ）。
- 制御構造の意味づけは **engine 側の約束**: `if` の then = `branches[0].steps` / else = `children`、`loop` 本体 = `children`、`try` の catch・finally = `branches` の name で判別。

### 2.3 操作・座標・キー（adapter / sidecar 共通）
- 座標は **スクリーン絶対・原点左上・論理ポイント**（物理 px ではない）。例外: `screen.capture` の返す width/height はピクセル。
- スクロールは **`dy>0` で下方向**（Swift 側が wheel 軸の符号差を吸収済み）。
- キー名は **論理名・大小区別なし**。`primary` = OS 共通のコマンド修飾子（macOS では Cmd、Windows では Ctrl 想定）。
- **lockstep**: Swift の `virtualKeyMap`/`modifierMap` と `rpc-contract.ts` の `KEY_NAMES`/`MODIFIER_NAMES` は一致させること。RPC 契約（`rpc-contract.ts` ↔ Swift）は TS↔Swift 間の単一の真実で、メソッド集合一致テストで強制される。
- Web の `<select>` は `type` ステップ + `{control:'select'}` で記録/再生。checkbox/radio の change はドロップ（[04](04-adapters.md)）。
- ヒューマナイズのステップ境界が web（8/60）と desktop（16/1200）で異なる。

### 2.4 実行エンジン
- **engine は副作用ゼロ**。実操作もターゲット解決も全て handler へ委譲。engine は layer 振り分けと制御構造の解釈のみ。
- **engine は Vault に触れない**。`${secrets.*}` は呼び出し側（app）が事前解決して `secrets` で注入。条件式の中では `secrets:{}` 固定で参照不可。
- `retryOn` 既定は全エラー再試行（空/未指定で true）。エラー分類は `error.class`（`timeout` 等）。
- タイムアウトは promise レースのみで、実行中の処理を強制中断はしない。`timeoutMs <= 0` で無効。
- 変数スコープはフラット（`forEach` の `asVar`、`try` の `__error__` が以降も残留する）。

### 2.5 アプリ（Electron）
- **provider 選択は steps 駆動**であって `metadata.targets` ではない。
- **再生前に dirty なら必ず saveFlow**（engine は disk から読むため）。記録停止時も自動保存する。
- IPC は全引数を **zod パース**。チャネル名は `shared/ipc.ts` が唯一の真実（文字列直書き禁止）。**新規 IPC は4点セットで追加**: ① `shared/ipc.ts` にチャネル定義 → ② main にハンドラ登録 → ③ preload で公開 → ④ renderer から呼ぶ。
- 再生の停止ホットキーは `CommandOrControl+Shift+Escape`（globalShortcut）。

### 2.6 永続化・秘密
- **keytar の CJS アンラップ（最重要・回帰実績あり）**: keytar は CommonJS（`module.exports = {...}`）なので `await import('keytar')` するとメソッドが `.default` 配下に来る（cjs-module-lexer が名前付き export を検出できない）。**`mod.default ?? mod` でアンラップ必須**。怠ると実行時に `findCredentials is not a function` でクラッシュ（本コミット b3d5fa6 がこの修正。`packages/storage/src/vault.ts` の `lazyKeytarBackend` 参照）。
- Vault の実値はディスクに出ない。`flow.json` には `${secrets.<name>}` 参照のみ、`Vault.list()` は account 名だけを返す。`DEFAULT_SERVICE = 'dev.hermes.app'`、account 名で名前空間化。
- `writeFlow` は原子的（tmp → rename）、`deleteFlow` は冪等。
- `duplicateFlow` は browser-profile / history を複製しない（セッション漏洩防止）。

---

## 3. 既知の不整合・未実装（要注意 / 将来の修正候補）

> ここは「コードを読むと面食らう箇所」「型はあるが動かない箇所」を集約する。**新たに気づいたら追記し、直したら消す**こと。
> ※これらは本仕様書作成時点（b3d5fa6）の観察。Phase 1 を止めるブロッカーではないが、AI が誤って「実装済み」と仮定しないための注意書き。

### スキーマ/型の不整合
- ~~**`FlowDefaults.humanize`**: `json-schema.ts` の `flowDefaults` に列挙漏れで検証拒否~~ → **2026-05-31 修正済み**（`flowDefaults.properties.humanize` 追加 + 回帰テスト）。（[02](02-ir-schema.md) §10）
- **`metadata.targets`** は web/desktop のみ対応で screen 不可だが、`TargetRef.layer` は screen を許す。screen ターゲットを記録したときの metadata 扱いが未定義。（[02](02-ir-schema.md) §10）
- renderer の `Step`/`Flow` 型は IR と完全一致を保証していない（`FlowSchema` は IR を `z.unknown()` で opaque に通し、検証は `@hermes/ir` の ajv に委ねる）。（[05](05-app-electron.md)）
- ~~main `DEFAULT_SETTINGS`（`system-chrome-import`）と renderer `DEFAULT_APP_SETTINGS`（`system-chrome`）で mode がズレる~~ → **2026-05-31 修正済み**（renderer 側を `system-chrome-import` に統一）。なお humanize の `mouseMinSteps/mouseMaxSteps` は main(16/1200) と renderer暫定値(8/60) で依然ズレ（loadAppSettings で上書きされるため実害は軽微）。（[05](05-app-electron.md) §8）
- 【非欠陥】`packages/ir` の `index.ts` は `./interpolate.js` を再 export するため、`interpolate` はパッケージルート（`@hermes/ir`）から利用可能。`@hermes/ir/interpolate` のサブパス import はリポジトリ内に存在せず、`package.json` の `exports` にサブパスキーが無いのは問題ではない。

### 型はあるが未配線/未実装
- **engine**: `mode:'step'` / `resume()` は型のみで未実装。`onError:'retry'` と `{goto}` は未処理（`'continue'` 以外は実質 fail 扱い）。`RetryPolicy.betweenAttempts` は engine が参照しない。（[03](03-engine.md)）
- **`${ctx.*}`** は常に空を引く。`RunContext.outputs` への書き込み箇所がリポジトリ全体に存在しない（将来の設計余地）。（[03](03-engine.md)）
- **desktop**: `ClickOpts.modifiers` / `TypeOpts.paste` / `TypeOpts.secret` は型のみで未配線（`macos.ts`/`handlers.ts` 未参照）。desktop の `ax`/`uia` セレクタ解決 RPC と `focusApp`（NSWorkspace.activate）は未実装で adapter 側が throw。desktop ステップは現状 `coords` 必須。（[04](04-adapters.md)/[06](06-sidecar-macos.md)）
- **`@hermes/ai`**: app の dependency 宣言だけで実 import 0 のスタブ。`@hermes/cli` は本体から独立（将来取り込むかは未定）。`@hermes/ui-kit` は `package.json`/`src` が無く**ワークスペース未認識**（実質未実装）。`sidecars/python-vision` はディレクトリが空で役割断定不可・Phase 1 未配線。（[01](01-architecture.md)/[06](06-sidecar-macos.md)）

### 二重実装/未使用の疑い
- **`MetaStore`（better-sqlite3）は Phase 1 本体で一度も `new` されていない**。フロー一覧は `flows/` ディレクトリ走査で動作し、`.hermes-dev/` に `meta.db` は実在しなかった。本番 DB パスも未定。（[07](07-storage-vault.md)）
- **`packages/desktop-adapter/src/transport.ts`（`SocketTransport`）が本番経路で未使用に見える**。`apps/hermes/src/main/sidecar.ts` は `createConnection` を直呼びしており、UDS 接続の実装が二重化している疑い。（[06](06-sidecar-macos.md)）
- `FlowStore` が実際に書くのは `flow.json` と `assets/<name>` のみ。レイアウトコメントにある `meta.json` / `variables.json` / `history/run-<runId>.jsonl.gz` は未生成（予約か別モジュール担当かは不明）。（[07](07-storage-vault.md)）
- prod CSP に `unsafe-inline` / `unsafe-eval` が残る（Phase 1d 以降で締め直す予定、とコメント）。（[05](05-app-electron.md)）

---

関連: 全ファイルの索引と更新ルールは [README](README.md) を参照。
