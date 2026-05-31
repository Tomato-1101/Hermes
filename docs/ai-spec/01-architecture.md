# 01. アーキテクチャ / monorepo構成
> 最終更新: 2026-05-31 ／ 対象コミット: b3d5fa6 (feat/phase-1-completion)
> AI用仕様書。コードを読む前にまずこれを読む。該当コードを変更したら同じPRでこのファイルも更新すること。

関連ファイル（`docs/ai-spec/` 内）: [README.md](README.md) / **01-architecture.md（本書）** / [02-ir-schema.md](02-ir-schema.md) / [03-engine.md](03-engine.md) / [04-adapters.md](04-adapters.md) / [05-app-electron.md](05-app-electron.md) / [06-sidecar-macos.md](06-sidecar-macos.md) / [07-storage-vault.md](07-storage-vault.md) / [08-glossary.md](08-glossary.md)

---

## 0. これは何か

Hermes は macOS 向けの決定的 RPA デスクトップアプリ。Phase 1（= Mode 1）は「記録 → 編集 → 再生」を AI 不使用・決定的に macOS 上で完成させる段階。
リポジトリは **pnpm workspace monorepo**（`pnpm-workspace.yaml` の `packages:` が `apps/*` と `packages/*` を取り込む）。構成は大きく3層：

1. **TypeScript コア**（`packages/*`）— IR・実行エンジン・各 Provider・記録器・ストレージ。OS非依存ロジックの本体。
2. **Electron アプリ**（`apps/hermes`, `@hermes/app`）— Main / Preload / Renderer の3プロセス。UI と全配線（orchestration）の中心。
3. **ネイティブサイドカー**（`sidecars/*`）— macOS は Swift 製 `hermes-native`（JSON-RPC over Unix Domain Socket）。Windows は将来 .NET + named pipe を同じ契約で差し込む想定。

---

## 1. 全プロジェクト一覧（12項目）

ワークスペースに実在するのは **`apps/hermes` + `packages/` 配下9個 = 10 npm パッケージ**。加えて `sidecars/macos-native`（Swift, npm 外）と `sidecars/python-vision`（**現状空ディレクトリ**）を合わせて「12プロジェクト」として扱う。`packages/ui-kit/` も**ディレクトリは存在するが中身が空**（`package.json` も `src` も無く、ワークスペースに認識されていない）。

「配線済みか」= 他から実際に `import` されているかを `grep` で確認した結果。

| パッケージ名 | パス | 役割 | Phase 1状態 | 主なエントリ | package.json `main`/`exports` | 依存（誰をimport） | 被参照（誰から） |
|---|---|---|---|---|---|---|---|
| `@hermes/ir` | `packages/ir` | Flow IR の型・JSON Schema・検証・マイグレーション・JSON Patch・式言語・補間 | **現役（土台）** | `src/index.ts` | `main: ./src/index.ts`。`exports`: `.`,`./schema`,`./json-schema`,`./validate`,`./id`,`./patch`,`./migrations`,`./expr`（※ index は `./interpolate.js` も再export するが exports マップに `./interpolate` の個別キーは無い。詳細 02） | 外部ランタイム依存なし（ajv, jsep, ulid 等のみ） | engine, web-provider, desktop-adapter, recorder-web, excel-provider, storage, ai, cli, app（**全員**） |
| `@hermes/engine` | `packages/engine` | IR 実行エンジン。ディスパッチャ・RunContext・retry/timeout・構造化制御フロー・HandlerRegistry | **現役** | `src/index.ts` | `main: ./src/index.ts`。`exports`: `.` のみ | `@hermes/ir`, `mitt` | web-provider, desktop-adapter, excel-provider, recorder-web(dev), cli, app |
| `@hermes/web-provider` | `packages/web-provider` | Playwright(`playwright-core`)製 Web Provider。フローごとの Chromium プロファイルを起動し web Step を実行 | **現役** | `src/web-provider.ts` | `main: ./src/index.ts`。`exports`: `.`,`./handlers`,`./provider`,`./selector` | `@hermes/engine`, `@hermes/ir`, `playwright-core` | recorder-web, cli, app |
| `@hermes/desktop-adapter` | `packages/desktop-adapter` | OS非依存の `DesktopAdapter` 契約＋macOS実装＋サイドカーJSON-RPC契約(zod)＋DesktopProvider＋ハンドラ | **現役** | `src/index.ts`（契約）/ `src/macos.ts`（実装） | `main: ./src/index.ts`。`exports`: `.`,`./macos`,`./sidecar-client`,`./transport`,`./desktop-provider`,`./handlers`,`./rpc-contract` | `@hermes/engine`, `@hermes/ir`, `zod` | cli, app（`./macos`,`./desktop-provider`,`./handlers`,`./rpc-contract` を個別 import） |
| `@hermes/recorder-web` | `packages/recorder-web` | Web 記録器。WebProvider の BrowserContext にフックし、ユーザー操作を捕捉して候補セレクタ配列付き IR Step を emit | **現役** | `src/recorder.ts` | `main: ./src/index.ts`。`exports`: `.`,`./script` | `@hermes/ir`, `@hermes/web-provider`, `mitt`, `playwright-core`, `ulid`（dev: `@hermes/engine`） | app のみ |
| `@hermes/excel-provider` | `packages/excel-provider` | `exceljs` 製 Excel Provider。ファイルベース .xlsx 読み書き（Excelアプリ不要・OS非依存・macで単体テスト可） | **現役** | `src/index.ts` | `main: ./src/index.ts`。`exports`: `.`,`./handlers` | `@hermes/engine`, `@hermes/ir`, `exceljs` | cli, app |
| `@hermes/storage` | `packages/storage` | SQLite メタストア・フローFSレイアウト・OSキーチェーン製 Vault | **現役** | `src/index.ts` | `main: ./src/index.ts`。`exports`: `.`,`./sqlite`,`./flow-store`,`./vault` | `@hermes/ir`, `better-sqlite3`, `keytar` | app（`@hermes/storage` と `@hermes/storage/flow-store`） |
| `@hermes/ai` | `packages/ai` | OpenRouter クライアント・Step Library JSON Schema（Mode 3用ツール定義）・AllowList | **スタブ（将来Mode 3）** | `src/index.ts` | `main: ./src/index.ts`。`exports`: `.`,`./openrouter`,`./step-library`,`./allow-list` | `@hermes/ir` のみ | **どこからも import されていない**（app の `package.json` には dependency 宣言があるが `apps/hermes/src` 内で実 import 0。CIでは `tsc -b` 対象） |
| `@hermes/cli` | `packages/cli` | ヘッドレス Flow ランナー `hermes run <flow.json>`。Engine→Provider を Electron UI 無しで実行 | **現役（独立ツール／本体未配線）** | `bin/hermes.mjs` → `src/cli.ts` | `main: ./src/index.ts`。`bin.hermes: ./bin/hermes.mjs`。`exports`: `.` | `@hermes/desktop-adapter`,`@hermes/engine`,`@hermes/excel-provider`,`@hermes/ir`,`@hermes/web-provider`（excel/desktop/sidecar は動的 import） | **どこからも import されていない**（独立 CLI。app は使わない） |
| `@hermes/ui-kit` | `packages/ui-kit` | （想定: 共有UI部品） | **未実装（空ディレクトリ）** | なし | なし | — | — |
| `hermes-native` | `sidecars/macos-native` | Swift 製 macOS ネイティブサイドカー。AX/CGEvent/ScreenCaptureKit を JSON-RPC over UDS で公開 | **現役** | `Sources/HermesNative/main.swift`（`Package.swift` の executable `hermes-native`） | npm 外（SwiftPM）。`Sources/HermesNative/`: main.swift, Accessibility.swift, Input.swift, Recording.swift, Screen.swift, Clipboard.swift | macOS フレームワークのみ | app（spawn）・cli（spawn） | 
| python-vision | `sidecars/python-vision` | （想定: 画面認識/OCR系の将来 Mode） | **未実装（空ディレクトリ）** | なし | なし | — | — |

**配線判定まとめ（grep 結果）**:
- `@hermes/ai`: 実コードからの import は 0。`apps/hermes/package.json` に dependency 宣言はあるが `src/` で未使用。`openrouter-client.ts` 内の「Keychain に保存」はコメントのみ（storage を実 import していない）。→ **スタブ**。
- `@hermes/cli`: 被 import 0。`hermes` バイナリとして独立動作（`vite-node` 経由で TS を直接実行）。app とは別系統。→ **現役だが本体アプリには未配線**。
- `@hermes/ui-kit` / `python-vision`: 実体が空。→ **未実装**。
- `@hermes/excel-provider`: app（`run-controller.ts`）と cli の両方に配線済み。→ **現役**。

---

## 2. プロセス境界図とIPC手段

```
┌──────────────────────────── Electron app (@hermes/app) ────────────────────────────┐
│                                                                                     │
│  Renderer (React19/Zustand)        Preload (contextBridge)        Main (Node)        │
│  src/renderer/                     src/preload/index.ts           src/main/          │
│  ┌──────────────┐                  ┌────────────────────┐         ┌───────────────┐ │
│  │ App.tsx /    │  window.hermes   │ exposeInMainWorld  │ ipcMain │ index.ts      │ │
│  │ store.ts /   │ ───invoke──────► │ 各チャネルを       │ ◄.invoke│ RunController │ │
│  │ components/  │ ◄──event push─── │ ipcRenderer.invoke │ ─push──►│ (singleton)   │ │
│  └──────────────┘  (hermes:event)  │ + .on(eventPush)   │         └──────┬────────┘ │
│   ※ contextIsolation:true,                                                │          │
│     nodeIntegration:false, sandbox:false                                  │          │
└───────────────────────────────────────────────────────────────────────────┼────────┘
                                                                              │
            Main プロセス内で 3 系統の外部プロセス/ライブラリを駆動:           │
                                                                              │
   ┌──────────────────────────────────┬───────────────────────────────┬──────┴────────┐
   ▼ (A) Web 系                        ▼ (B) Desktop/Screen 系          ▼ (C) Excel 系  │
 playwright-core が                  hermes-native (Swift)            exceljs           │
 Chromium/Chrome を spawn            別プロセスを child_process.spawn   （ライブラリ・   │
 ＋ CDP で制御                       ＋ Unix Domain Socket            別プロセス無し）   │
 (launchPersistentContext)           line-delimited JSON-RPC 2.0                        │
   │                                   │ (src/main/sidecar.ts)                          │
   │ WebProvider/WebRecorder           │ MacosDesktopAdapter→SidecarClient              │
   ▼                                   ▼                                                │
 ［ブラウザ］                        ［AX / CGEvent / ScreenCaptureKit］                 │
```

**IPC手段の整理**:
- **Renderer ↔ Main**: Electron IPC。`ipcRenderer.invoke` ⇔ `ipcMain.handle`（リクエスト/レスポンス）と、Main→Renderer の push（`webContents.send(IpcChannels.eventPush, ...)`、Renderer は `ipcRenderer.on('hermes:event')` で購読）。契約は `apps/hermes/src/shared/ipc.ts` の `IpcChannels` / `IpcContract`（zod スキーマ）に集約。Preload（`src/preload/index.ts`）が `window.hermes.*` として安全に橋渡し。
- **Main ↔ Chrome**: 直接 IPC は無い。`@hermes/web-provider` が `playwright-core` の `chromium.launchPersistentContext(profileDir, …)` で Chromium/system-chrome を起動し、Playwright が内部的に CDP で制御する。記録は `BrowserContext.addInitScript`（注入スクリプト `INJECT_SCRIPT`）＋ `context.exposeBinding`（ページ→Node コールバック）で行う（`packages/recorder-web/src/recorder.ts`）。
- **Main ↔ Swift サイドカー**: `apps/hermes/src/main/sidecar.ts` が `hermes-native` を `child_process.spawn` し、ユーザーの tmp 配下に作った **Unix Domain Socket** へ `net.createConnection` で接続。**改行区切り JSON-RPC 2.0**（1行1メッセージ）。異常終了時は次回呼び出しで遅延再起動。`@hermes/desktop-adapter` 側は `SidecarClient`（`transport.ts` の `Transport` seam 経由、UDS=`SocketTransport`、Windows は named pipe を後で差す）。
- **Main ↔ python-vision**: 未実装（プロセス自体が無い）。

---

## 3. ビルド / 開発 / テスト コマンド

ターボ/nx 等のタスクランナーは**無し**。ルート `package.json` の scripts が `pnpm -r`（再帰）と `pnpm -F`（filter）で各パッケージ scripts を呼ぶ。

**ルート `package.json` scripts**:
```
dev              = pnpm sidecar:mac:build:debug && pnpm -F @hermes/app dev   # サイドカーをdebugビルドしてからElectron dev
build:mac        = pnpm sidecar:mac:build && pnpm -F @hermes/app build:mac    # サイドカーrelease＋.app(unsigned)
lint             = pnpm -r --parallel run lint
typecheck        = pnpm -r --parallel run typecheck
test             = pnpm -r --parallel run test
test:run         = pnpm -r --parallel run test:run
clean            = pnpm -r --parallel run clean
format           = prettier --write .
sidecar:mac:build       = swift build --package-path sidecars/macos-native -c release
sidecar:mac:build:debug = swift build --package-path sidecars/macos-native
```

**各 package 共通 scripts**（`lint`=eslint src, `typecheck`=tsc --noEmit, `test`=vitest, `test:run`=vitest run, `clean`=rm -rf dist 等）。例外:
- `desktop-adapter` / `cli` の `test:run` は `--passWithNoTests` 付き。
- `cli` は追加で `hermes` script（`node bin/hermes.mjs`）。
- `@hermes/app` scripts: `dev`=`electron-vite dev`, `build`=`electron-vite build`, `build:mac`=`pnpm build && electron-builder --mac --config electron-builder.yml`, `preview`=`electron-vite preview`, `typecheck`=`tsc --noEmit`, `test`/`test:run`=`vitest [run] --passWithNoTests`。

**手動ビルドの定石（CLAUDE.md 由来の不変条件）**:
- アプリビルド: `pnpm --filter @hermes/app build`（= electron-vite）。
- 型チェック: `tsc --noEmit -p apps/hermes/tsconfig.json`。
- **`npx electron-vite build` は使わない**（グローバル版を誤って引くため）。

**Node 22 必須**: ルート `engines.node` は `>=20`、`.nvmrc` は `22`。ただし**ビルド/テストは Node 22 で行う**こと（既定の Node 26 だと `better-sqlite3` がネイティブ層で落ちる）。実行前に `export PATH="/opt/homebrew/opt/node@22/bin:$PATH"`。

**CI**（`.github/workflows/`）:
- `ci.yml`（push to main / PR、`macos-14`）: pnpm setup → `setup-node`（`node-version-file: .nvmrc` = 22）→ `pnpm install --frozen-lockfile` → **composite を順に `tsc -b`**（ir → engine → storage → ai → web-provider → desktop-adapter → recorder-web。cli/app は composite ではないので含まない）→ `pnpm lint` → `pnpm typecheck` → `pnpm test:run`。別ジョブ `sidecar` で `swift build … -c release` ＋ `--one-shot` ping スモーク（`nc -U` で UDS に ping を投げ `"pong":true` を確認）。
- `build-mac.yml`（`workflow_dispatch` 手動のみ）: サイドカー release → `tsc -b`（ir）→ `pnpm build:mac`（`CSC_IDENTITY_AUTO_DISCOVERY=false`）→ `Hermes.app` 存在確認。署名/公証はしない。

**pnpm-workspace.yaml の `allowBuilds` / `onlyBuiltDependencies`**:
pnpm 11 は postinstall ビルドスクリプトを**パッケージ毎に明示許可**する必要がある。`allowBuilds`（`better-sqlite3`/`electron`/`esbuild`/`keytar` = true）が無いと CI の `pnpm install --frozen-lockfile`（runner に事前承認が無い）が `ERR_PNPM_IGNORED_BUILDS` で落ちる。`onlyBuiltDependencies`（esbuild, better-sqlite3, keytar, electron, electron-winstaller）はレガシー許可リストで互換のため残置。**ネイティブ依存（better-sqlite3, keytar, electron）を足したら両方を更新**すること。

---

## 4. tsconfig / electron-vite / モジュール解決

**`tsconfig.base.json`（全 package が extends）の要点**:
```
target: ES2022 / module: ESNext / moduleResolution: bundler
strict: true / noUncheckedIndexedAccess: true / noImplicitOverride: true
isolatedModules: true / verbatimModuleSyntax: true
jsx: react-jsx / declaration+declarationMap+sourceMap: true
```
- `moduleResolution: bundler` ＋ `verbatimModuleSyntax: true` が「**import に `.js` 拡張子を付ける**」慣習の根拠。型は型のみ import（`import type`）を強制し、ランタイム import は `.js` specifier で書く（TS ソースを指しても解決される）。これは ESM 出力時の相対 import 拡張子要件に合わせるため。

**各 `packages/*/tsconfig.json`**: base を extends、`outDir: ./dist`, `rootDir: ./src`, `composite: true`, `incremental: true`, `include: ["src/**/*"]`。`references` でビルド依存を宣言（engine→ir、web-provider→ir,engine、desktop-adapter→ir,engine、recorder-web→ir,web-provider、excel-provider→ir,engine、storage→ir、ai→ir）。**cli だけ composite ではない**（`noEmit: true`, `rootDir: "."`, `include: ["src","test"]`、`references` 無し）。

**`apps/hermes/tsconfig.json`**: base を extends、`baseUrl: "."`、`paths`（`@/*`,`@main/*`,`@renderer/*`,`@shared/*`）、`types: ["node","electron-vite/node"]`、`noEmit: true`、`include: ["src/**/*", "electron.vite.config.ts", "electron-builder.yml"]`。**`tsconfig.node.json` / `tsconfig.web.json` は存在しない**（1ファイルで Main/Preload/Renderer を一括型チェック）。

**`apps/hermes/electron.vite.config.ts`**（3ターゲット）:
- `main`: entry `src/main/index.ts` → `out/main`。`external` = `electron`, `node:*`, **`better-sqlite3` / `keytar`**（ネイティブ、runtime `require()`、packaged 時は `process.resourcesPath` から解決）, **`playwright-core`**（独自ブラウザ解決を esbuild にバンドルできないため外部化）。それ以外の workspace 依存は `out/main/index.js` に**バンドル**（`node_modules` を同梱せず .app を配れるようにするため）。alias: `@main`, `@shared`。
- `preload`: entry `src/preload/index.ts` → `out/preload`。external = `electron`, `node:*`。出力は `index.mjs`（Main は `preload/index.mjs` を参照）。alias: `@shared`。
- `renderer`: root `src/renderer`, entry `index.html` → `out/renderer`。`@vitejs/plugin-react` 使用。alias: `@renderer`, `@shared`。**Renderer の import は `.js` 拡張子付き／自動テストは無い**（検証は tsc + build + 目視）。

**`apps/hermes/electron-builder.yml`**: `appId: dev.hermes.app`, `productName: Hermes`。mac arch=arm64・target=`dir`・`identity: null`・`hardenedRuntime: false`（**署名/公証しない**＝ソース配布前提）。`files: out/**, package.json`（`node_modules` は同梱しない、`asar: true`）。`extraResources` で Swift サイドカー `sidecars/macos-native/.build/release/hermes-native` を `.app` 内 `sidecars/hermes-native` へコピー。`npmRebuild/buildDependenciesFromSource/nodeGypRebuild` は全 false。

---

## 5. データの流れ（record → IR → 保存 → replay）

**記録（record）**:
1. Renderer が `window.hermes.recorderStart(flowId, startUrl, layer)` を invoke（`layer`: `'web' | 'desktop'`）。
2. Main の `RunController`（`src/main/run-controller.ts`、app あたり1インスタンスの singleton）が layer で分岐:
   - **web**: `@hermes/web-provider`（`WebProvider`）で Chromium を起動 → `@hermes/recorder-web`（`WebRecorder`）が `addInitScript`＋`exposeBinding` でページ操作を捕捉 → 候補セレクタ配列付き IR Step を emit。
   - **desktop**: `src/main/desktop-recorder.ts`（`DesktopRecorder`、Swift CGEventTap 記録器の TS 側）が `hermes-native` をポーリング（≈150ms）して mouse/key イベントを受け取り IR Step 化（少なくとも `coords` 候補）。
3. emit された Step は Main → Renderer に `EventPush`（`type:'recorder:step'`）として push され、Renderer の Zustand store がタイムラインに追加。

**IR**: Flow/Step の型・スキーマは `@hermes/ir`（詳細 02）。`CURRENT_SCHEMA_VERSION` を持ち、`migrateFlow` で旧バージョンを移行。

**保存（save）**:
- Renderer `flowSave(flow)` → Main → `@hermes/storage` の `FlowStore`（ファイルシステム上のフローレイアウト）＋ `MetaStore`（SQLite メタ）。秘密値は `Vault`（OSキーチェーン=keytar）。詳細 07。
- 記録停止後／実行前に自動保存する慣習あり（コミット履歴 092e7c0 参照）。

**再生（replay）**:
1. Renderer `runStart(flowId, inputs)` → Main `RunController`。
2. `RunController` が必要な Provider を用意（`WebProvider` / `DesktopProvider`(=`MacosDesktopAdapter`+sidecar) / `ExcelProvider`）し、各 `register*Handlers` で `HandlerRegistry` に Step ハンドラを登録（layer 付き: `web`/`desktop`/`screen`/`default`）。
3. Vault から `collectSecretRefs(flow)` 分の秘密値を解決して `SecretsMap` を作り、`@hermes/engine` の `StepExecutor`（`registry` + `providers` + `secrets`）を構築。
4. `StepExecutor` が Flow を逐次ディスパッチ（`mitt` で `RunEvent` を発火）。エンジンは Vault に触れず `${secrets.<name>}` を事前解決値で置換するだけ。`${vars.*}`/式は `interpolateParams` / `evaluateExpr`（詳細 03）。
5. `RunEvent` は Main で `EventPush`（`run:start`/`run:step`/`run:end`/`log`）に変換し Renderer へ push。RunLog/Timeline が表示。

ヘッドレス経路（CLI）: `hermes run <flow.json>` → `bin/hermes.mjs`（vite-node で TS 実行）→ `src/run-flow.ts` が `buildProviders`（`src/providers.ts`）で web/desktop/excel を組み、`@hermes/engine` で実行。**Electron を介さない独立経路**（app とコードは共有するが配線は別）。

---

## 6. 変更ガイド（どこを触るか）

- **新しいパッケージを足す**: `packages/<name>/` に `package.json`（`name: @hermes/<name>`, `type: module`, `main`/`exports`, 共通 scripts）と `tsconfig.json`（base を extends、composite、`references`）を作る。`pnpm-workspace.yaml` の glob `packages/*` で自動取り込み。consumer 側 `package.json` に `"@hermes/<name>": "workspace:*"` を追加。composite なら CI `ci.yml` の `tsc -b` 列にも追加。ネイティブ依存があれば `pnpm-workspace.yaml` の `allowBuilds`/`onlyBuiltDependencies` も更新。
- **新しい Step 型を足す**: ① `@hermes/ir`（`schema.ts` の `StepType`/スキーマ、必要なら `json-schema.ts`・migration）。② 該当 Provider にハンドラ実装（例: web=`web-provider/src/handlers.ts`、desktop=`desktop-adapter/src/handlers.ts`、excel=`excel-provider/src/handlers.ts`）＋ `register*Handlers` で `HandlerRegistry` に layer 付き登録。③ Renderer の StepEditor/Inspector を更新。詳細は 02（IR）/ 03（エンジン）/ 04（アダプタ）。
- **新しい IPC を足す**: `apps/hermes/src/shared/ipc.ts` に ① `IpcChannels` のキー、② args/result の zod スキーマ、③ `IpcContract` のエントリ（必要なら `EventPush` の variant）を追加 → `src/preload/index.ts` の `window.hermes.*` に橋渡し関数 → `src/main/index.ts`（または `RunController`）に `ipcMain.handle` 実装 → Renderer `store.ts`/コンポーネントから呼ぶ。詳細 05。
- **サイドカー RPC を足す**: TS 側 `@hermes/desktop-adapter` の `rpc-contract.ts`（zod）＋ `macos.ts`（`MacosDesktopAdapter`）と、Swift 側 `sidecars/macos-native/Sources/HermesNative/main.swift`（ディスパッチ）＋各機能ファイル。詳細 06。

---

## 7. 【未確認】事項

- `@hermes/ai` が将来どのプロセスから配線される予定か（app の dependency 宣言はあるが現状未使用）。実配線は Mode 3 で行われる想定だが本書時点のコードからは確定できない。【未確認】
- `python-vision` の言語/依存/RPC 方式（ディレクトリが空のため一切不明）。【未確認】
- `@hermes/cli` を本体アプリが将来取り込むか（現状は完全独立）。【未確認】
- Renderer 側の各コンポーネント（`Editor.tsx` 等）と Step 型の対応関係は本書の範囲外（05 で詳述）。【未確認: 本ファイルでは未調査】
