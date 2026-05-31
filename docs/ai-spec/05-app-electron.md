# 05. Electronアプリ / main・preload・renderer・IPC
> 最終更新: 2026-05-31 ／ 対象コミット: b3d5fa6 (feat/phase-1-completion)
> AI用仕様書。コードを読む前にまずこれを読む。該当コードを変更したら同じPRでこのファイルも更新すること。

関連: [README](README.md) ・ [01-architecture](01-architecture.md) ・ [02-ir-schema](02-ir-schema.md) ・ [03-engine](03-engine.md) ・ [04-adapters](04-adapters.md) ・ [06-sidecar-macos](06-sidecar-macos.md) ・ [07-storage-vault](07-storage-vault.md) ・ [08-glossary](08-glossary.md)

---

## 0. このファイルの守備範囲

`apps/hermes`（パッケージ名 `@hermes/app`）の Electron 部分すべて。Electron 33 + React 19 + Zustand + TypeScript。Phase 1 = Mode1（決定的RPA「記録→編集→再生」）。

ビルド/型チェックの不変条件:
- ビルド: `pnpm --filter @hermes/app build`（electron-vite。`main` / `preload` / `renderer` の3ターゲットを束ねる）
- 型チェック: `tsc --noEmit -p apps/hermes/tsconfig.json`
- レンダラの import は `.js` 拡張子付きで書く（例: `import { useStore } from './store.js'`。実体は `.ts`/`.tsx`）。`@hermes/ir` 等のパッケージ import は拡張子なし。
- **レンダラに自動テストは無い**。検証は `tsc` + `build` + 目視のみ。main 側にのみ vitest テストがある（`*.test.ts`）。
- Node 22 必須（既定の Node 26 だと `better-sqlite3` 系が落ちる。MEMORY.md 参照）。

ファイルの実体パスはすべてルート相対で記載する。

---

## 1. プロセスモデル / 三層ブリッジ

```
┌─────────── main (Node) ───────────┐   ┌── preload ──┐   ┌──── renderer (React) ────┐
│ index.ts: BrowserWindow + IPC登録 │   │ index.ts:   │   │ App.tsx / store.ts(zustand)│
│ RunController: 統括(singleton)    │←→│ contextBridge│←→│ components/*               │
│ sidecar.ts: Swift子プロセス(UDS)  │   │ window.hermes│   │ window.hermes.* を呼ぶ      │
└────────────────────────────────────┘   └─────────────┘   └────────────────────────────┘
```

- `webPreferences`: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: false`, `preload: <out>/preload/index.mjs`（`apps/hermes/src/main/index.ts:35-40`）。レンダラは `ipcRenderer` を直接触れない。**唯一の橋は `window.hermes`**。
- preload (`apps/hermes/src/preload/index.ts`) が `contextBridge.exposeInMainWorld('hermes', api)` で `window.hermes` を生やす。`api` の各メソッドは `IpcChannels.*` の1チャネルへ1対1で写像する。
- レンダラの型は `apps/hermes/src/renderer/types.d.ts` が `Window.hermes: HermesApi`（preload の `typeof api`）を宣言。
- main → renderer の一方向 push は1チャネル `'hermes:event'`（`IpcChannels.eventPush`）に集約。ペイロードは `EventPush` discriminated union（`type` で判別）。

### `window.hermes` で公開している API 一覧（preload）

`apps/hermes/src/preload/index.ts` の `api` オブジェクト。すべて Promise を返す（`onEvent` 以外）。

```ts
// System
ping(message?: string)
appInfo()
sidecarPing()
permissionStatus()
openSettingsPane(pane: string)
// App settings
settingsGet()
settingsSet(settings: unknown)
settingsPickChromeProfile()
// Flow CRUD
flowList()
flowCreate(name: string)
flowOpen(id: string)
flowSave(flow: unknown)
flowDelete(id: string)
flowDuplicate(id: string, name: string)
flowRename(id: string, name: string)
// Recorder
recorderStart(flowId: string, startUrl?: string, layer?: 'web' | 'desktop')
recorderStop()
recorderSetRecordWaits(enabled: boolean)
// Runner
runStart(flowId: string, inputs?: Record<string, unknown>)
runStop()
// Vault
vaultList()
vaultSet(account: string, value: string)
vaultDelete(account: string)
// Event subscription（戻り値は unsubscribe 関数）
onEvent(handler: (event: unknown) => void): () => void
```

`onEvent` は内部で `ipcRenderer.on(IpcChannels.eventPush, wrapped)` を張り、返した関数を呼ぶと `ipcRenderer.off` する。

---

## 2. IPCチャネル完全カタログ

チャネル名・引数/結果スキーマは `apps/hermes/src/shared/ipc.ts` の `IpcChannels` と `IpcContract`（zod）が単一の真実。main 側ハンドラは `apps/hermes/src/main/index.ts` の `registerIpcHandlers()` 内で `ipcMain.handle(IpcChannels.<x>, ...)` として全登録。push は `RunController.emit` / `index.ts` のホットキーが `webContents.send(IpcChannels.eventPush, ...)` する。

各 `ipcMain.handle` は受信 raw を `IpcContract[channel].args.parse(raw)`（zod）で検証してから controller へ委譲する（`args` が `z.void()` のものは parse 省略）。

| チャネル定数 | チャネル名 | 方向 | 引数型 (zod) | 結果型 (zod) | ハンドラ/発火元 | 用途 |
|---|---|---|---|---|---|---|
| `ping` | `app:ping` | invoke/handle | `PingArgs {message?}` | `PingResult {pong:true, echo}` | index.ts:70 | 疎通確認(echo) |
| `appInfo` | `app:info` | invoke/handle | `void` | `AppInfoResult {name,version,electron,node,platform,arch}` | index.ts:75 | 環境情報（Inspector表示） |
| `sidecarPing` | `sidecar:ping` | invoke/handle | `void` | `SidecarPingResult {ok,reply?,latencyMs?,error?}` | index.ts:86 → `pingSidecar()` | Swiftサイドカー疎通 |
| `permissionStatus` | `permission:status` | invoke/handle | `void` | `PermissionStatusResult {required,missing,granted}` | index.ts:90 | macOS権限の付与状況 |
| `openSettingsPane` | `permission:openSettings` | invoke/handle | `OpenSettingsArgs {pane}` | `OpenSettingsResult {opened}` | index.ts:108 | システム設定のディープリンクを開く |
| `settingsGet` | `settings:get` | invoke/handle | `void` | `SettingsGetResult {settings}` | index.ts:157 → `controller.getSettings()` | アプリ設定読込 |
| `settingsSet` | `settings:set` | invoke/handle | `SettingsSetArgs {settings}` | `SettingsSetResult {ok:true}` | index.ts:162 → `controller.setSettings()` | アプリ設定保存 |
| `settingsPickChromeProfile` | `settings:pickChromeProfile` | invoke/handle | `void` | `SettingsPickChromeProfileResult {picked,path?,name?}` | index.ts:168 | Chromeプロファイル選択ダイアログ |
| `flowList` | `flow:list` | invoke/handle | `void` | `FlowListResult {flows: FlowSummary[]}` | index.ts:116 | フロー一覧 |
| `flowCreate` | `flow:create` | invoke/handle | `FlowCreateArgs {name}` | `FlowCreateResult {flow}` | index.ts:121 | 新規フロー |
| `flowOpen` | `flow:open` | invoke/handle | `FlowOpenArgs {id}` | `FlowOpenResult {flow}` | index.ts:127 | フローを開く |
| `flowSave` | `flow:save` | invoke/handle | `FlowSaveArgs {flow}` | `FlowSaveResult {ok:true}` | index.ts:133 | フロー保存 |
| `flowDelete` | `flow:delete` | invoke/handle | `FlowDeleteArgs {id}` | `FlowDeleteResult {deleted}` | index.ts:139 | フロー削除 |
| `flowDuplicate` | `flow:duplicate` | invoke/handle | `FlowDuplicateArgs {id,name}` | `FlowDuplicateResult {flow}` | index.ts:145 | フロー複製 |
| `flowRename` | `flow:rename` | invoke/handle | `FlowRenameArgs {id,name}` | `FlowRenameResult {flow}` | index.ts:151 | フロー改名 |
| `recorderStart` | `recorder:start` | invoke/handle | `RecorderStartArgs {flowId,startUrl?,layer?}` | `RecorderStartResult {ok:true}` | index.ts:184 | 記録開始（web/desktop） |
| `recorderStop` | `recorder:stop` | invoke/handle | `void` | `RecorderStopResult {ok:true}` | index.ts:190 | 記録停止 |
| `recorderSetRecordWaits` | `recorder:setRecordWaits` | invoke/handle | `RecorderSetRecordWaitsArgs {enabled}` | `RecorderSetRecordWaitsResult {ok:true}` | index.ts:195 | 待機記録トグル |
| `runStart` | `run:start` | invoke/handle | `RunStartArgs {flowId,inputs?}` | `RunStartResult {runId}` | index.ts:201 | 再生開始（runId即返し、実行は非同期） |
| `runStop` | `run:stop` | invoke/handle | `void` | `RunStopResult {ok:true}` | index.ts:207 | 再生停止 |
| `vaultList` | `vault:list` | invoke/handle | `void` | `VaultListResult {entries:[{account}]}` | index.ts:212 | シークレット名一覧 |
| `vaultSet` | `vault:set` | invoke/handle | `VaultSetArgs {account,value}` | `VaultSetResult {ok:true}` | index.ts:217 | シークレット保存 |
| `vaultDelete` | `vault:delete` | invoke/handle | `VaultDeleteArgs {account}` | `VaultDeleteResult {deleted}` | index.ts:223 | シークレット削除 |
| `eventPush` | `hermes:event` | send/on | （結果なし。`EventPush` を push） | — | `RunController.emit`（run-controller.ts:110） / `index.ts:268`（停止ホットキー） | main→renderer 一方向push |

> 注意: `IpcContract` には `eventPush` のエントリは**無い**（handle ではなく send 専用のため）。push のペイロード型は `EventPush`（zod discriminatedUnion）でのみ定義。

### push イベント（`hermes:event` のペイロード = `EventPush`）

`shared/ipc.ts:218-242` の discriminated union（判別キー `type`）。renderer は `App.tsx` の `onEvent` ハンドラ内 switch で受ける。

| `type` | フィールド | 発火元 | rendererの処理(App.tsx) |
|---|---|---|---|
| `recorder:step` | `step` (IR Step) | startWebRecording/DesktopRecorder→RunController.emit | `store.appendStep(step)` |
| `recorder:state` | `running` | startRecording/stopRecording | `store.setRecording(running)` |
| `run:start` | `flowId`,`runId` | StepExecutor `run:start` 中継 | `setRunning(true)` + ログ |
| `run:end` | `flowId`,`runId`,`outcome('success'\|'failure'\|'aborted')` | StepExecutor `run:end` 中継 | `setRunning(false)` + ログ |
| `run:step` | `cursor`,`stepId`,`phase('start'\|'end')`,`outcome?`,`error?` | StepExecutor `step:start`/`step:end` 中継 | `phase==='start'`で`setActiveStep(stepId)`、`end`かつ`outcome!=='completed'`でログ |
| `log` | `level('debug'\|'info'\|'warn'\|'error')`,`message` | RunController各所/停止ホットキー/executor `log`中継 | `store.appendLog(...)` |

> `outcome` の値の出所が2系統あることに注意。`run:step.outcome` は engine の `step:end` の文字列をそのまま中継し、App.tsx は `'completed'` と比較する（【未確認】engine 側が成功時に `'completed'` を出す前提。engine 仕様は 03-engine.md 参照）。`run:end.outcome` は zod enum `success|failure|aborted`。

---

## 3. main ファイル別仕様

### 3.1 `apps/hermes/src/main/index.ts` — エントリポイント
- `createMainWindow()`: 1280x800（min 960x600）、`backgroundColor:'#0f1115'`、macOSは `titleBarStyle:'hiddenInset'`。devは `ELECTRON_RENDERER_URL` を loadURL + DevTools detach、prodは `<out>/renderer/index.html` を loadFile。
- `did-finish-load` で `document.body.classList.add('platform-<platform>')` を注入（macOS は CSS で左ペインヘッダを ~80px オフセットし信号機ボタンを避ける。styles.css `body.platform-darwin .pane-left .pane-header`）。
- `registerIpcHandlers()`: 上記カタログの全 `ipcMain.handle`。`controller`（`RunController` singleton）へ委譲。
- `checkMacPermission(name)`: `accessibility`=`systemPreferences.isTrustedAccessibilityClient(false)`、`screen-recording`=`getMediaAccessStatus('screen')==='granted'`、`input-monitoring`/`automation`=常に `true`（Electron 33にAPIなし。サイドカーが実態を報告）。
- `settingsDeepLink(pane)`: `x-apple.systempreferences:com.apple.preference.security?Privacy_*` を返す。
- `registerStopHotkey()`: グローバルショートカット `CommandOrControl+Shift+Escape`（macOSで未使用の組合せ）。押下で `controller.stopRun()` + `log` push。デスクトップ再生中はHermesが背面なのでrenderer側keylistenerでは捕まえられないためglobalShortcutを使う。
- ライフサイクル: `whenReady`→register/create/hotkey。`will-quit`→`globalShortcut.unregisterAll()`。`before-quit`→`disposeSidecar()` + `controller.dispose()`。

### 3.2 `apps/hermes/src/main/run-controller.ts` — 統括（singleton, ~1000行）
`RunController` クラス1個。`index.ts` で `const controller = new RunController()`。保持するもの: `store`(FlowStore), `vault`(Vault), `provider`(WebProvider|null), `desktop`(DesktopProvider|null), `excel`(ExcelProvider|null), `recorder`(WebRecorder|null), `desktopRecorder`(DesktopRecorder|null), `activeRun`, `window`, `recordWaits`(sticky), `settingsCache`。

- **emit**: `private emit = (event) => this.window?.webContents.send(IpcChannels.eventPush, event)`。全push経路の根。
- **設定**: `getSettings({force?})` はキャッシュ。`setSettings(partial)` はディスク状態+patchをmergeして`saveSettings`→キャッシュ更新→**provider破棄**（ブラウザflags/profile変更を反映）。
- **Flow CRUD**: `listFlows`（flowsRoot配下のディレクトリを総なめ、不正は skip、updatedAt降順）、`createFlow`/`openFlow`/`saveFlow`（updatedAt刻む）/`deleteFlow`（録画中/実行中は拒否、provider破棄してからディレクトリ削除）/`duplicateFlow`/`renameFlow`。
- **記録**: `startRecording(flowId,startUrl?,layer='web')` → `startWebRecording` or `startDesktopRecording`。`currentRecordingFlowId`/`currentRecordingLayer` を立て `recorder:state running:true` を emit。`metadata.targets` に layer を追記（**ただし再生時のprovider選択には使わない**=後述）。
  - `startWebRecording`: `ensureProviderFor(flowId)`→`WebRecorder.attach`→`on('step')`。passwordなど `isSecret` 入力は `vault.set(secretName, plaintext)`（secretName は `extractSecretName`= `${secrets.<name>}` から抽出）。`startUrl` 指定時は正規化（`normalizeStartUrl`: scheme無ければ `https://` 付与）して `open_url` step を1個 emit してから `provider.openUrl`。
  - `startDesktopRecording`: macOS限定。`DesktopRecorder` を生成し `on('step')`/`on('error')`→emit。
  - `setRecordWaits(enabled)`: `recordWaits` を更新し稼働中recorder両方に伝播。
  - `stopRecording`: layerで分岐して recorder.stop()、`currentRecordingFlowId=null`、`recorder:state running:false`。
- **再生**: `startRun(flowId, inputs?)` が核心。
  1. 多重起動拒否（`activeRun`）。disk から flow を読む。
  2. **provider選択は steps から導出**（`metadata.targets` ではない。targetsはcreateFlowで`[]`、startRecordingで追記される*記述的ヒント*に過ぎず、過去にdesktop-onlyフローで不要なChromeが立った不具合の修正で steps 駆動に変更済み）。
     - `needsWeb` = `step.target.layer==='web'` か `open_url`（`WEB_IMPLIED_TYPES`）が存在。
     - `needsScreen` = `layer==='screen'` 存在 / `needsClipboard` = `clipboard_read|write` 存在 / `needsDesktop` = screen|clipboard|`layer==='desktop'`。
     - `needsExcel` = type が `excel_` prefix。
     - 判定は `stepNeedsLayer`/`stepUsesClipboard`/`stepUsesExcel` が children/branches を再帰。
  3. `needsDesktop` なら `absorbDesktopMovesIntoWaits(steps, mouseSpeedPxPerSec)`: `wait(N)→desktop click(@x,y)` 列をリライトし、クリックが録画リズムどおりに発火するよう移動を待ち時間へ吸収（移動が待ち時間に収まれば wait を縮め、収まらなければ wait を 0 にして `moveDurationMs` で移動を圧縮し速度をログ警告。元のStepは非破壊・shallow copy）。
  4. provider を ensure（web/desktop/excel）。`HandlerRegistry` に `registerWebHandlers` 常時 + desktop/screen/clipboard/excel を条件付き登録。
  5. `collectSecretRefsInFlow(flow)`（params の `${secrets.<name>}` を全再帰収集）で必要シークレットを vault から先読みし `secrets` に。
  6. `seededInputs` に `__hermes_humanize__`（AppSettings.humanize ← flow.defaults.humanize で上書き）と、screen/excel時に `__hermes_assets_dir__`（= `store.flowDir(flowId)`、image/excelの相対パス基点）を注入。
  7. `StepExecutor({registry,providers,secrets})` を生成。`executor.on` で engine イベント→push に中継（前掲表）。`executor.run(flow,{signal,inputs})` を **await せず** 起動し runId 即返し。finally で activeRun クリア+Excel破棄。
  - `stopRun()`: `activeRun.abort.abort()`。
- **Vault passthrough**: `vaultList/vaultSet/vaultDelete` をそのまま Vault へ。
- **provider生成**: `ensureProviderFor(flowId)` がブラウザモード分岐の本体。
  - `system-chrome`: `systemChromePath` 必須。Chrome 起動中(`isChromeRunning`)なら拒否、`SingletonLock`残存(`chromeSingletonLockExists`)でも拒否。profileDir=その path。
  - `system-chrome-import`: 起動中でも警告のみで続行。`flowProfileDir(flowId)` に `importChromeProfile`（Cookies/Login Data/Preferences/Local Storage…と root の `Local State`=Cookie復号鍵をコピー。Cache/Singleton*は除外）。
  - `hermes-profile`（else）: `flowProfileDir(flowId)`。
  - `createWebProvider({profileDir,headless:false,channel})`→`start()`。失敗時 `translatePlaywrightLaunchError`（SingletonLock衝突を日本語の実行可能なエラーに翻訳）。
  - `ensureDesktopProvider()`: macOS限定。`getSidecarClient()`→`MacosDesktopAdapter`→`DesktopProvider`。
  - `ensureExcelProvider()`: `createExcelProvider()`。
- `dispose()`: run停止→recorder/desktopRecorder/provider/desktop/excel を順に破棄。
- export 補助: `flowsExistOnDisk()`（一覧UI用診断）。

### 3.3 `apps/hermes/src/main/sidecar.ts` — Swiftサイドカー橋
- `Sidecar` クラス（singleton `const singleton = new Sidecar()`）。`hermes-native` Swift バイナリを子プロセスspawn、**Unix Domain Socket** で **行区切り JSON-RPC 2.0**。
- **UDSパス**: `join(tmpdir(), `hermes-native-${process.pid}-${Date.now()}.sock`)`（毎起動ユニーク）。`spawn(binary, ['--socket', sockPath], {env:{...,HERMES_NATIVE_SOCKET:sockPath}})`。
- **ハンドシェイク**: stdout に `hermes-native listening` が出るまで待つ（3s timeout）→ `createConnection(sockPath)`（2s timeout）→ `data` 受信を `onData`(改行で分割)→`handleLine`（JSON.parse、`id`一致のpendingをresolve/reject）。
- **バイナリ探索順** `locateBinary()`: ①packaged時 `process.resourcesPath/sidecars/hermes-native` ②`HERMES_NATIVE_BIN` env ③monorepo `.build/debug` と `.build/release` の**mtimeが新しい方**（古いdebugが勝つstale binaryバグ回避）。
- `call(method, params?, timeoutMs=5000)`: ensureStarted→id採番→`{jsonrpc:'2.0',id,method,params}`+`\n` を write。timeoutでreject。`exit`/`close` で全pending fail（次callでlazy再spawn）。
- `getSidecarClient()`: `{call,dispose}` ハンドルを返し、**`wrapWithContract(handle, {result:'warn'})`**（`@hermes/desktop-adapter`）で全desktop RPCをzod契約で監視（paramsは違反でthrow、resultは警告のみ）。06-sidecar-macos.md / 04-adapters.md と接続。
- `pingSidecar()`: 非macOSは `{ok:false,error}`。`call('ping',null,3000)` で `{pong,version}` を取り `latencyMs` 付きで返す。
- `disposeSidecar()`: singleton破棄。

### 3.4 `apps/hermes/src/main/desktop-recorder.ts` — デスクトップ記録のmain側制御
- `DesktopRecorder`（`EventEmitter`ベース、`on('step'|'error')`）。`getSidecarClient()` を保持。
- `start()`: `client.call('recording.start')`→`setInterval(POLL_INTERVAL_MS=150)` で `pollOnce`（overlap防止フラグ）。`stop()`: clearInterval→最後の `pollOnce` でflush→`recording.stop`。
- `pollOnce()`: `client.call('recording.poll')` で `{events,active}` を取得。`ev.seq<=lastSeq` は古いセッションのstragglerとしてskip。`toStep(ev)` で IR Step化。`recordWaits` 有効時は前イベントからの差分≥`minRecordedWaitMs`(=200) なら `wait` step を間に emit。
- **イベント→Step写像**（kind→type, すべて `target.layer:'desktop'`）:
  - `click`→`click`（候補: element があれば `ax`、必ず `coords{anchor:'screen'}`。`button!=='left'`なら `params.button`）
  - `key`→`key_combo`（`params.keys`、coordsはダミー`{0,0}`）
  - `type`→`type`（`params.text,clearFirst:false`、coordsダミー。replay時はOSフォーカス依存）
  - `scroll`→`scroll`（`params.dx,dy`、coords=ポイント）
  - `drag`→`drag`（`params.to{x,y}`、from は coords候補。axあれば先頭）
- テスト: `desktop-recorder.test.ts`（sidecar.jsをmockしpollOnceを直接叩いてStep写像を検証。scroll/drag/click/right-click）。

### 3.5 `apps/hermes/src/main/app-settings.ts` — アプリ設定の永続化
- 保存先: `join(dataRoot(), 'settings.json')`（`flow-paths.ts` の `dataRoot()`。flows/ ツリーの隣）。
- 型 `AppSettings`: `browser{mode, systemChromePath?, systemChromeProfileName?, channel?}` + `humanize{mouseSpeedPxPerSec, typeDelayMs, mouseMinSteps, mouseMaxSteps}`。`BrowserProfileMode = 'hermes-profile'|'system-chrome'|'system-chrome-import'`。
- `DEFAULT_SETTINGS`: **mode=`system-chrome-import`**, channel=`chrome`, mouseSpeedPxPerSec=800, typeDelayMs=50, mouseMinSteps=16, mouseMaxSteps=1200。
- `loadSettings()`: 読み込み→`mergeDeep(DEFAULT_SETTINGS, parsed)`→`migrateSettings`（古いビルドの `mouseMaxSteps<200`/`mouseMinSteps<8` を現defaultへ**引き上げのみ**。変更時は即flush）。ファイル無/壊れ→DEFAULT。
- `saveSettings(deepPartial)`: ディスク現状とmergeしてから**atomic write**（`.tmp`へ書いてrename）。未知キーを保存（前方互換）。
- テスト: `app-settings.test.ts`（default mode検証、round-trip、未知キー保存、partial patch保持、atomic=`.tmp`残らない）。

### 3.6 `apps/hermes/src/main/chrome-process.ts` — Chrome検出（macOS限定）
- `isChromeRunning()`: `pgrep -f "/Applications/Google Chrome.app"`（Helper等も含む広めのマッチ）。非macOS/不一致は `false`。
- `chromeSingletonLockExists(profilePath)`: profile dir と親（user-data-dir）両方で `SingletonLock`/`SingletonSocket`/`SingletonCookie` を探す。
- `defaultChromeUserDataDir()`: `~/Library/Application Support/Google/Chrome`（pickerの初期ディレクトリ）。
- テスト: `chrome-process.test.ts`（SingletonLock検出を tmp で検証）。

### 3.7 `apps/hermes/src/main/flow-paths.ts` — パス解決
1フロー=1ディレクトリ `<root>/flows/<id>/`（`flow.json`, `browser-profile/`, `assets/`, `history/`）。`<root>` = `HERMES_DATA_DIR`(env, test用) ▸ packaged時 `<userData>/data` ▸ dev時 `<repo>/.hermes-dev`。export: `dataRoot`/`flowsRoot`/`flowDir`/`flowProfileDir`/`flowExists`。

> 補足: 07-storage-vault.md と重複領域。実際の flow.json 読み書きは `@hermes/storage` の FlowStore。

---

## 4. renderer 状態 / Zustand store

`apps/hermes/src/renderer/store.ts`。`useStore = create<State>(...)`。**自動保存しない**（`flow:save` IPCで明示commit）。Undo/Redoは `@hermes/ir` の `diffFlow`/`applyFlowPatch`（JSON Patch）で実装。

### State 形状（抜粋・実体は store.ts:108-173）
- データ: `flows: FlowSummary[]`, `currentFlow: Flow|null`, `selectedStepId: string|null`, `dirty: boolean`, `appSettings: AppSettings`。
- 実行/記録: `recording`, `running`, `activeStepId`（run:step駆動。タイムラインの現在地ハイライト。runが終わると `setRunning(false)` が null化）, `log: LogEntry[]`（500行cap）, `recordWaits`。
- 履歴: `undoStack: FlowPatch[]`, `redoStack: FlowPatch[]`（`HISTORY_LIMIT=100`）。
- `DEFAULT_APP_SETTINGS`（store内）は **mode=`system-chrome`, mouseMinSteps=8, mouseMaxSteps=60** で、main の `DEFAULT_SETTINGS` と**値がズレている**（=初回 `loadAppSettings()` 前の暫定値。読込後はmain側が上書き）。

### 全アクション
- 非同期(IPC): `loadFlows`, `createFlow`, `openFlow`, `saveFlow`, `deleteFlow`, `duplicateFlow`, `renameFlow`, `loadAppSettings`, `setAppSettings`（楽観更新→`settingsSet`）。
- ステップ編集（すべて `recordEdit(prev,next)` でundoパッチを積む→`dirty:true`）: `appendStep`（記録イベント受信時）, `addStructuralStep('if'|'loop'|'try')`, `addChildStep(parentId)`, `addBranchStep(parentId,branchName)`, `insertStepAt(beforeStepId|null, InsertKind)`, `appendQuickStep(kind)`, `convertWaitKind(stepId, WaitForKind)`（wait↔wait_for相互変換、ms↔timeoutMsを引継ぎ）, `updateStep(id,patch)`, `removeStep(id)`, `moveStep(id,dir)`。
- 選択/記録/実行/ログ: `selectStep`, `setRecordWaits`（fire-and-forget IPC）, `setRecording`, `setRunning`, `setActiveStep`, `appendLog`, `clearLog`。
- Undo/Redo: `undo`, `redo`, `canUndo`, `canRedo`。
- ツリー走査ヘルパ（module-private）: `updateInTree`/`removeFromTree`/`moveInTree`/`insertChildInTree`/`insertBranchStepInTree`/`findStepInTree`/`insertBeforeInTree`（すべて children + branches を再帰）。
- ステップ生成: `buildStepFromKind`/`newWaitStep`/`newWaitForStep`/`newStructuralStep`/`defaultsForWaitForKind`。
- `InsertKind = 'wait' | {type:'wait_for', kind:WaitForKind} | 'if' | 'loop' | 'try'`。

> if step の構造: `branches[0]`(name='then') が条件成立側、`children` が else 側（`newStructuralStep('if')` と Timeline の描画が一致）。try: `children`=try本体, `branches`=catch/finally。loop: `children`=本体。

---

## 5. コンポーネント構成

### ツリー（`main.tsx`→`App.tsx`）
```
App
└ PromptProvider                 modals.tsx: async prompt() を提供
  └ ConfirmProvider              modals.tsx: async confirm() を提供
    └ div.app（3ペイン横並び）
       ├ FlowSidebar             左: フロー一覧 + 右クリックメニュー(開く/複製/改名/JSONエクスポート/削除)
       ├ Editor                  中央: ヘッダ(ツールバー) + Timeline + RunLog
       │  ├ Timeline             再帰的ステップツリー（InsertHandle/StepNode/BranchSection）
       │  └ RunLog               下部ログストリップ
       └ Inspector               右: StepEditor + AppSettingsPanel + VaultPanel + 環境情報
          ├ StepEditor           選択ステップの編集（WaitEditor/WaitForEditor 内包）
          ├ AppSettingsPanel     ブラウザモード + humanize
          └ VaultPanel           シークレット名一覧
```
- `App.tsx`: マウント時 `appInfo()` 取得、`loadFlows()`/`loadAppSettings()`、`onEvent` 購読（第2節の表どおりにpushを store へ反映）。グローバルキー: ⌘Z=undo, ⌘⇧Z/⌘Y=redo, ⌘S=saveFlow。
- `Editor.tsx`: ツールバーが**記録/再生/保存/Undo-Redo/構造ステップ追加の起点**。
  - `onRecordWeb`: 記録中なら `recorderStop()`+`saveFlow()`、停止中なら開始URLをprompt→`recorderStart(flow.id, url, 'web')`。
  - `onRecordDesktop`: `recorderStart(flow.id, undefined, 'desktop')`。
  - `onRun`: 記録中は不可。**`dirty`なら先に`saveFlow()`**（engineはdiskから読むため。これをしないと未保存編集が無視される）→`runStart(flow.id)`。実行中は`runStop()`。再生ボタンは `steps.length===0` で無効。⌘⇧Escでも停止可（ヒント表示）。
  - クイック追加ボタン: `appendQuickStep('wait')`, `appendQuickStep({type:'wait_for',kind:'web.load'})`, `addStructuralStep('if'|'loop'|'try')`。録画待機トグル=`setRecordWaits`。
- `Timeline.tsx`: `<ol>` を depth/pathPrefix で再帰。`InsertHandle`（行間の `+`、共通/高度待機 + 構造を `insertStepAt`）、`StepNode`（行表示・選択・↑↓×・構造ステップはbranch展開）、`BranchSection`（then/else/body/try/catch/finally）。`describeStep` が1行サマリ生成。activeStepId と一致する行に `.running`。
- `StepEditor.tsx`: ラベル/有効トグル + type別エディタ。`if`=条件式(`CONDITION_HELP`)、`loop`=for/forEach、`try`=説明、`wait`=`WaitEditor`（ms/秒/分の単位はローカルUI state。IRはms保持）、`wait_for`=`WaitForEditor`（kindで入力欄が切替、timeoutMs/pollIntervalMs）。汎用 action step は params を primary/advanced(`ADVANCED_PARAM_KEYS`)に分割、`<details>詳細`にステップID/生target JSON。`describeTarget`/`summarizeSelector` がセレクタ候補を日本語化（role/testid/label/css/xpath/text/url-anchor/ax/uia/image/ocr/coords）。
- `Inspector.tsx`: 選択ステップ(`findStepRecursive`)→StepEditor。区切り線で AppSettingsPanel / VaultPanel / 環境情報（appInfo）。
- `RunLog.tsx`: store.log を表示。新着で自動スクロール末尾。クリアボタン。
- `FlowSidebar.tsx`: 一覧 + `FlowContextMenu`（外側クリック/Esc/blurで閉じる、viewportクランプ）。エクスポートは `flowOpen`→Blob→`<a download>`（`sanitizeFileName`）。削除は `useConfirm`。
- `modals.tsx`: Electron 33 は `window.prompt/alert/confirm` を無効化するので async な `usePrompt`/`useConfirm` を context で提供。
- `HelpTip.tsx`: `title` 属性ベースの `?` バッジ。
- `AppSettingsPanel.tsx`: ブラウザモード3択（radio、即`persist`=1アクション1 IPC）+ Chromeプロファイル選択(`settingsPickChromeProfile`)。マウス速度/タイプ間隔は**ローカルcontrolled値+300msデバウンス**でIPC連発を防ぐ。
- `VaultPanel.tsx`: `vaultList`で名前だけ表示（値は出さない）。`onAdd`=name+valueをprompt→`vaultSet`。`onDelete`=`DELETE`入力確認→`vaultDelete`。

### `constants.ts`
- `INSERT_MENU_COMMON`: 時間で待つ / ページのロード完了で次へ / 要素の出現で次へ（InsertHandleの基本3つ）。
- `INSERT_MENU_ADVANCED`: URL一致 / アプリ前面(desktop.app_focus) / ウィンドウタイトル / 画面が落ち着く(screen_stable) / アプリ要素出現(desktop.element) / 条件式(expr)。
- `WAIT_FOR_LABEL`: `WaitForKind`→日本語ラベルの全網羅マップ（StepEditor/Timeline/InsertHandleが共有）。

### `styles.css`（構造のみ）
- `:root` に CSS変数トークン: 色(`--bg`系/`--accent`/`--ok`/`--warn`/`--err`)、タイポ(`--font-sans/mono`, `--text-*`, `--weight-*`)、spacing(`--space-1..10`、4px基調)、radius、elevation(`--shadow-*`)、motion(`--transition-fast`)。Radix/Tailwind/shadcn等は不採用（自前トークン＋軽量部品。MEMORY.md「UI刷新の方針」）。
- 主要セレクタ: `.app`/`.pane`(`.pane-left/center/right`)、`.pane-header`/`.toolbar`、`.status-pill(.running/.recording)`、`.flow-list`、`.timeline-list`/`.step-node(.active/.running)`/`.step-row`/`.step-children`/`.branch-section`、`.step-divider`/`.divider-menu`、`.log`/`.log-entry`、`.modal-overlay`/`.modal`、`.context-menu`、`.settings-panel`/`.settings-row`、`.vault-panel`/`.vault-list`、`.kv`/`.kv-key`/`.kv-value`、`.advanced-details`、`.help-tip`。`body.platform-darwin .pane-left .pane-header` で信号機ボタン回避。

---

## 6. 変更ガイド

### 新IPCチャネルを足す（4点セット）
1. `apps/hermes/src/shared/ipc.ts`: `IpcChannels` に `xxx: 'group:action'` を追加 → 引数/結果の zod スキーマを定義 → `IpcContract` に `[IpcChannels.xxx]: {args, result}` を登録（push専用なら IpcContract には足さず `EventPush` に variant 追加）。
2. `apps/hermes/src/main/index.ts` `registerIpcHandlers()`: `ipcMain.handle(IpcChannels.xxx, async (_e, raw) => { const args = IpcContract[IpcChannels.xxx].args.parse(raw); return controller.<method>(...); })`。`controller` に実処理メソッドを足す。
3. `apps/hermes/src/preload/index.ts` `api`: `xxx: (...) => ipcRenderer.invoke(IpcChannels.xxx, {...})` を1行追加（`HermesApi` は `typeof api` なので型は自動伝播）。
4. renderer: `window.hermes.xxx(...)` を呼ぶ（store.ts のアクション or コンポーネント）。push を追加した場合は `App.tsx` の `onEvent` switch に case を足す。

### 新ステップUI / 新 wait_for kind を足す
- IR側に新 type/kind を追加（02-ir-schema.md）。
- `constants.ts`: `WAIT_FOR_LABEL` に日本語ラベル（全kind網羅必須）、必要なら `INSERT_MENU_*` に行追加。
- `store.ts`: `defaultsForWaitForKind` にデフォルト params、構造ステップなら `newStructuralStep`。
- `StepEditor.tsx`: `WaitForEditor` の kind分岐に入力欄、汎用action paramなら `ADVANCED_PARAM_KEYS`/`summarizeSelector`/`describeTarget` を更新。
- `Timeline.tsx`: `describeStep` に1行サマリ。
- 記録由来なら `desktop-recorder.ts`(`toStep`/`buildXxxStep`) や recorder-web 側の写像も。

### 新コンポーネントを足す
- `apps/hermes/src/renderer/components/Xxx.tsx` を作り、`Inspector.tsx` か `Editor.tsx` から差し込む。import は `./Xxx.js`（.js拡張子）。状態は `useStore((s)=>s.field)` で購読。modal が要るなら `usePrompt`/`useConfirm`。スタイルは `styles.css` に CSS変数トークンで追記。

---

## 7. ファイルマップ

### main（`apps/hermes/src/main/`）
| パス | 責務 |
|---|---|
| `index.ts` | Electronエントリ。BrowserWindow生成、IPC handle全登録、macOS権限照会、停止ホットキー、ライフサイクル |
| `run-controller.ts` | 統括singleton。Flow CRUD / 記録 / 再生 / provider・recorder・vault管理 / push emit |
| `sidecar.ts` | Swift `hermes-native` 子プロセス管理。UDS + 行区切りJSON-RPC 2.0。`getSidecarClient`/`pingSidecar`/`disposeSidecar` |
| `desktop-recorder.ts` | デスクトップ記録main側。sidecarをpollしイベント→IR Step写像 |
| `app-settings.ts` | settings.json 永続化（atomic write + migrate + mergeDeep）。`DEFAULT_SETTINGS` |
| `chrome-process.ts` | Chrome起動検出 / SingletonLock検出 / default user-data-dir |
| `flow-paths.ts` | データルート/フローディレクトリのパス解決 |
| `*.test.ts` | vitest: app-settings / chrome-process / desktop-recorder |

### preload / shared
| パス | 責務 |
|---|---|
| `preload/index.ts` | `contextBridge` で `window.hermes` を公開（channel↔メソッド1対1） |
| `shared/ipc.ts` | IPC契約の単一真実。`IpcChannels`/`IpcContract`(zod)/`EventPush`/各種スキーマ |

### renderer（`apps/hermes/src/renderer/`）
| パス | 責務 |
|---|---|
| `main.tsx` | React root mount（StrictMode）、styles.css読込 |
| `App.tsx` | レイアウト3ペイン、push購読、グローバルショートカット |
| `store.ts` | Zustand store（state + 全アクション + ツリー走査ヘルパ + undo/redo） |
| `constants.ts` | INSERT_MENU_COMMON/ADVANCED, WAIT_FOR_LABEL |
| `types.d.ts` | `Window.hermes: HermesApi` グローバル宣言 |
| `index.html` | CSPメタ + `#root` + main.tsx読込 |
| `styles.css` | CSS変数トークン + 全コンポーネントスタイル |
| `components/FlowSidebar.tsx` | フロー一覧 + コンテキストメニュー(エクスポート/削除等) |
| `components/Editor.tsx` | ツールバー（記録/再生/保存/Undo-Redo/構造追加）+ Timeline + RunLog |
| `components/Timeline.tsx` | 再帰ステップツリー / InsertHandle / StepNode / BranchSection / describeStep |
| `components/StepEditor.tsx` | 選択ステップ編集 / WaitEditor / WaitForEditor / describeTarget |
| `components/Inspector.tsx` | StepEditor + AppSettingsPanel + VaultPanel + 環境情報 |
| `components/RunLog.tsx` | ログストリップ（自動スクロール） |
| `components/AppSettingsPanel.tsx` | ブラウザモード + humanize（デバウンス保存） |
| `components/VaultPanel.tsx` | シークレット名一覧 + 追加/削除 |
| `components/modals.tsx` | async prompt/confirm（Electron無効化の代替） |
| `components/HelpTip.tsx` | `?` ツールチップバッジ |

---

## 8. 落とし穴・不変条件（08-glossaryへ寄せる候補）

- **provider選択は steps 駆動。`metadata.targets` は記述的ヒントで再生に使わない**（過去にdesktop-onlyでChromeが立った不具合の修正）。
- **再生前に dirty なら必ず saveFlow**。engine はディスクの flow.json を読むので未保存編集は無視される（`Editor.onRun`）。
- **記録停止時にも自動 saveFlow される**（`Editor.onRecordWeb/onRecordDesktop`）。記録中の step は in-memory append のみ。
- IPC は **全引数を zod でパース**してから処理。チャネル追加時は `IpcContract` 登録を忘れると `args.parse` で落ちる。
- preload の api メソッドと `IpcChannels` は 1対1。チャネル名は `shared/ipc.ts` が唯一の真実、**直書きしない**。
- main `DEFAULT_SETTINGS`(mode=system-chrome-import) と renderer `DEFAULT_APP_SETTINGS`(mode=system-chrome) は値がズレているが、後者は loadAppSettings 前の暫定値。
- settings.json は atomic write（`.tmp`→rename）+ 未知キー保存（前方互換）。`mouseMaxSteps<200` 等は loadSettings で自動引き上げ migrate。
- グローバル停止ホットキー = `CommandOrControl+Shift+Escape`（デスクトップ再生中はHermesが背面なのでrenderer keylistenerでは捕まらない）。
- サイドカーUDSパスは `tmpdir()/hermes-native-<pid>-<ts>.sock`。バイナリ探索はdebug/releaseの**mtime新しい方**。
- レンダラ import は `.js` 拡張子付き / レンダラに自動テストなし（tsc+build+目視）。
- if step: `branches[0]`(then)=成立側 / `children`=else側。try: children=本体, branches=catch/finally。
- vault に保存されるのは値、flow に入るのは `${secrets.<name>}` 参照のみ。記録時の password 入力が自動で vault.set される。

## 9. 【未確認】点
- `run:step.outcome` の成功判定が App.tsx で `'completed'` 比較。engine の `step:end` が成功時に出す具体的文字列は本ファイル範囲外（03-engine.md で要確認）。
- `recording.start`/`recording.poll`/`recording.stop` の sidecar 側JSON-RPCの厳密なparams/result形は Swift側（06-sidecar-macos.md）。本ファイルは TS側が送受信する shape のみ記載。
- `FlowSchema`(shared/ipc.ts) は IR を opaque JSON（`z.unknown()`）として通す。IR本体の検証は `@hermes/ir` の ajv（02-ir-schema.md）。renderer の `Step`/`Flow` 型は緩い独自定義で IR と完全一致は保証していない。
- `automation`/`input-monitoring` 権限は main では常に granted 扱い（実態はサイドカー報告。本コミット時点でその報告経路がUIに繋がっているかは未確認）。
- prod の index.html CSP は `unsafe-inline`/`unsafe-eval` を含む（Vite dev都合）。コメントに「Phase 1d以降で締め直す予定」とあり本コミットでは未対応。
