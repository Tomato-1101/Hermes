# 06. macOSサイドカー / Swift・JSON-RPC・権限
> 最終更新: 2026-05-31 ／ 対象コミット: b3d5fa6 (feat/phase-1-completion)
> AI用仕様書。コードを読む前にまずこれを読む。該当コードを変更したら同じPRでこのファイルも更新すること。

関連: [README](README.md) ／ [01-architecture](01-architecture.md) ／ [02-ir-schema](02-ir-schema.md) ／ [03-engine](03-engine.md) ／ [04-adapters](04-adapters.md) ／ [05-app-electron](05-app-electron.md) ／ [07-storage-vault](07-storage-vault.md) ／ [08-glossary](08-glossary.md)

---

## 0. 一行サマリ

`hermes-native` は Swift製の単一実行バイナリ（`sidecars/macos-native/`）。Unix Domain Socket 上で**行区切りJSON-RPC 2.0**を喋り、macOSのネイティブ操作（AX要素取得・マウス/キー入力・スクショ/画像探索/OCR・クリップボード・CGEventTap録画）を Electron main 側へ提供する。Electron 側の対向は 04 の `MacosDesktopAdapter`（`packages/desktop-adapter/src/macos.ts`）と 05 の起動係 `apps/hermes/src/main/sidecar.ts`。将来Windowsは .NET/named-pipe で**同一プロトコル・同一メソッド名・同一座標/キー名規約**を再実装する想定（`packages/desktop-adapter/src/rpc-contract.ts` が両OS共通の契約の真実）。

---

## 1. ファイルマップ（Swiftソース パス→責務）

| パス | 責務 |
| --- | --- |
| `sidecars/macos-native/Package.swift` | SwiftPMマニフェスト。`swift-tools-version:5.9`、`platforms: [.macOS(.v13)]`、executable product `hermes-native`、target `HermesNative`（`Sources/HermesNative`）。依存パッケージなし（システムフレームワークのみ）。 |
| `Sources/HermesNative/main.swift` | エントリポイント。argv/env解析、**JSON-RPCディスパッチテーブル（全公開メソッドの定義箇所）**、`JSONValue` 型、行フレーミング、UDSサーバ（bind/listen/accept/read/write）、シグナルハンドラ。 |
| `Sources/HermesNative/Accessibility.swift` | AX系。権限チェック、アプリ一覧、frontmostアプリ、座標→AX要素スナップショット。AppKit/ApplicationServices。 |
| `Sources/HermesNative/Input.swift` | CGEventベースの入力。クリック/移動/スクロール/ドラッグ/スムーズ移動/カーソル位置/テキスト入力（Unicode）/キーコンボ、`mainScreenSize()`、キー名→仮想キーコード表 `virtualKeyMap`、修飾子表 `modifierMap`。 |
| `Sources/HermesNative/Screen.swift` | スクショ（`CGWindowListCreateImage`→PNG base64）、テンプレートマッチ（自前NCC）、OCR（Apple Vision `VNRecognizeTextRequest`）。ピクセル→論理点座標変換。 |
| `Sources/HermesNative/Recording.swift` | `CGEventTap` ベースのグローバル録画。`Recorder` シングルトン。クリック/ドラッグ判別、テキスト/スクロールのバッチ化、ポーリング用キュー。専用ワーカースレッド+CFRunLoop。 |
| `Sources/HermesNative/Clipboard.swift` | `NSPasteboard` プレーンテキスト read/write。 |

ビルド成果物（gitignore外＝コミットされない）: `sidecars/macos-native/.build/{debug,release}/hermes-native`。

---

## 2. トランスポート（UDS + 行区切りJSON-RPC）

### 2.1 ソケットパス決定（Swift側 `parseConfig()` in main.swift）
優先順:
1. `--socket <path>` argv
2. 環境変数 `HERMES_NATIVE_SOCKET`（非空のとき）
3. デフォルト `\(NSTemporaryDirectory())hermes-native-\(getpid()).sock`

その他 argv: `--one-shot`（最初の接続クローズ後に終了。テスト用）、`--help`/`-h`。未知の argv は `exit(64)`。
ソケットパスは `sockaddr_un.sun_path` の容量未満が必須（`precondition` で `path too long` クラッシュ）。`bindAndListen` は起動時に `unlink(path)` で stale を消し、`chmod(path, 0o600)`（所有ユーザのみ接続可）。

### 2.2 起動アナウンス・ハンドシェイク
- bind/listen 成功後、**stdout に `hermes-native listening on <path>` を1行 print + fflush**。05の `sidecar.ts` はこの文字列を見て接続開始する（3秒タイムアウト）。
- 05側はソケットへ `createConnection`（2秒タイムアウト）。接続成立後にRPC開始。
- 1接続=1クライアント前提だが `listen(fd, 4)` でバックログ4。サーバは `accept` ループで逐次（同期）処理。`--one-shot` 無しなら無限ループ常駐。

### 2.3 フレーミング・メッセージ形式
- **改行（`\n`, 0x0A）区切りの1行1メッセージ**。各行は完結したJSONオブジェクト。
- リクエスト: `{ "jsonrpc": "2.0", "id": <JSONValue>, "method": "<name>", "params": {...}|null }`
- 成功レスポンス: `{ "jsonrpc": "2.0", "id": <同id>, "result": {...} }`
- エラーレスポンス: `{ "jsonrpc": "2.0", "id": <同id|null>, "error": { "code": <int>, "message": "..." } }`
- 空行はスキップ（リクエスト側もレスポンス側も無視）。
- レスポンスエンコードは `JSONEncoder` + `.withoutEscapingSlashes`（`/` をエスケープしない）。

### 2.4 エラーコード表現（Swift側で投げる code）
| code | 意味 / 発生箇所 |
| --- | --- |
| `-32700` | Parse error（非UTF8 or JSONデコード失敗）。`id` は null。 |
| `-32601` | Method not found（ディスパッチ表に無いメソッド）。 |
| `-32602` | Invalid params（必須params欠如、テンプレートbase64デコード失敗等）。 |
| `-32603` | Internal error（汎用 catch-all）。 |
| `-32001` | Accessibility 権限未付与（`accessibility.elementAtPoint`, `recording.start`）。 |
| `-32002` | AX error（`AXError.rawValue` 付き、`elementAtPoint`）。 |
| `-32010` | Recording already active（`recording.start`）。 |
| `-32011` | CGEventTap creation failed（Input Monitoring 不足の可能性、`recording.start`）。 |
| `-32012` | Screen capture failed（Screen Recording 不足の可能性。`screen.capture/findImage/ocr`）。 |

【事実】`-32011` のメッセージは "CGEventTap creation failed (Input Monitoring permission may be missing)"。ただし実装の tap は `.cgSessionEventTap` + `.listenOnly` で、起動前ガードは `axPermissionGranted()`（Accessibility）。タップ作成失敗の主因はAccessibility不足のケースもある（§6参照）。

### 2.5 TS側の対向（参考、05/04所管）
- `sidecar.ts`: `id` は数値 `nextId++`。レスポンスの `id` が数値でなければ無視。`error` は `Error("<code>: <message>")` に変換して reject。デフォルト呼び出しタイムアウト 5000ms。プロセス予期せぬ終了時は次回呼び出しで遅延再起動（lazy respawn）。
- `transport.ts`（`SocketTransport`）: `node:net` の `createConnection(path)`。UDS と Windows named pipe（`\\.\pipe\name`）を同一クラスで扱う設計（path だけ差し替え）。【未確認】`transport.ts` は seam として存在するが、現状 `sidecar.ts` 内 `Sidecar` クラスは `transport.ts` を経由せず `createConnection` を直接呼んでいる（二重実装、配線はまだ統合されていない）。

---

## 3. JSON-RPCメソッド完全カタログ

全メソッドは `main.swift` の `let handlers: [String: Handler]` に定義（これが唯一の登録箇所）。座標は**全て論理点（logical points）・スクリーン絶対・原点左上**（Quartz座標系）。

### 3.1 ping / accessibility 系（Accessibility.swift）

| メソッド | params | result | 副作用 | 必要権限 |
| --- | --- | --- | --- | --- |
| `ping` | none(null) | `{ pong: bool, version: "0.0.1", platform: "darwin", ts: number }` | なし | なし |
| `accessibility.status` | none | `{ granted: bool }` | なし。`axPermissionGranted(prompt: false)`（プロンプト出さず照会のみ） | なし（照会のみ） |
| `accessibility.listApps` | none | `{ apps: [{ bundleId, name, pid, active }] }` | `NSWorkspace.runningApplications` のうち `.activationPolicy == .regular` のみ | なし |
| `accessibility.frontmostApp` | none | `{ bundleId, name, pid, windowTitle? }` または `null` | `windowTitle` は AX が許可済みのときのみ付与（focusedWindowTitle） | windowTitle取得に**Accessibility**（無ければ silently 省略） |
| `accessibility.elementAtPoint` | `{ x, y }` | ElementSnapshot（`{ role, subrole, title, description, value, identifier, position{x,y}, size{w,h}, app{bundleId,name,pid} }`）。失敗系は throw | `AXUIElementCopyElementAtPosition`（system-wide）で座標下の最深要素を取得 | **Accessibility**（無いと `-32001`） |

### 3.2 screen 系（Screen.swift）

| メソッド | params | result | 副作用 | 必要権限 |
| --- | --- | --- | --- | --- |
| `screen.mainSize` | none | `{ w, h, scale }` または `null`（`NSScreen.main` の frame と backingScaleFactor） | なし | なし（macOS 13ではScreen Recording不要） |
| `screen.capture` | `{ region?: {x,y,w,h} }`（省略=全仮想画面） | `{ data: base64PNG, w(px), h(px), format: "png" }` | `CGWindowListCreateImage`。`w/h` は**物理ピクセル** | **Screen Recording**（無いと `-32012`） |
| `screen.findImage` | `{ template: base64PNG, threshold?=0.8, scaleInvariant?=false, region? }` | 不一致: `{ found:false, score }` ／ 一致: `{ found:true, score, x, y, w, h, cx, cy }`（**論理点**、cx/cyは中心） | 画面キャプチャ→自前NCCテンプレートマッチ（640px縮小グレースケール、積分画像） | **Screen Recording** |
| `screen.ocr` | `{ region?, languages?: [..] | lang?: ".." }` | `{ text: 改行連結, observations: [{ text, confidence, x, y, w, h }] }`（rectは**論理点**） | 画面キャプチャ→Apple Vision `VNRecognizeTextRequest`（`.accurate`, `usesLanguageCorrection=true`） | **Screen Recording** |

座標変換の規約: キャプチャは retina **ピクセル**で返るが、findImage/ocr の出力は capture の pixels-per-point スケールで割り region 原点を足して**論理点**に直す。全画面（region=null）時は単一ディスプレイ（main screen）を仮定。

### 3.3 mouse 系（Input.swift）

| メソッド | params | result | 副作用 | 必要権限 |
| --- | --- | --- | --- | --- |
| `mouse.click` | `{ x, y, button?="left"(left/right/middle), clickCount?=1 }` | `{ ok: true }` | CGEvent down/up を `.cghidEventTap` に post。各クリック間 20ms sleep。`mouseEventClickState` 設定 | **Accessibility**（他アプリへ効かせるため） |
| `mouse.move` | `{ x, y }` | `{ ok: true }` | `.mouseMoved` を post | Accessibility |
| `mouse.position` | none | `{ x, y }`（Quartz座標、原点左上に変換済み） | `NSEvent.mouseLocation`（Cocoa）をQuartzへY反転 | なし |
| `mouse.move_smooth` | `{ toX, toY, durationMs?=200, steps?=16 }` | `{ ok:true, actualFps, maxSlipMs, steps, durationMs }`（実測値。TS側がslip検出に使う） | 現在位置から等速線形補間で1ステップ1イベントpost。QoS .userInteractive 昇格、単一CGEvent再利用、明示delta、ハイブリッドsleep（mach_wait_until+busy-spin） | Accessibility |
| `mouse.scroll` | `{ x, y, dx, dy }` | `{ ok: true }` | (x,y)へ移動後 `scrollWheelEvent2`（pixel単位, wheel1=縦,wheel2=横）。caller の dy/dx を**符号反転**して post（dy>0で下スクロール規約） | Accessibility |
| `mouse.drag` | `{ fromX, fromY, toX, toY, durationMs?=300, steps?=24 }` | `{ ok: true }` | leftMouseDown→補間 leftMouseDragged×steps→leftMouseUp | Accessibility |

### 3.4 keyboard 系（Input.swift）

| メソッド | params | result | 副作用 | 必要権限 |
| --- | --- | --- | --- | --- |
| `keyboard.type` | `{ text, intervalMs?=0 }` | `{ ok: true }` | 文字ごとに `keyboardSetUnicodeString` で down/up post（レイアウト非依存・日本語/絵文字対応、サロゲートペア処理）。`intervalMs>0` で文字間 sleep | Accessibility |
| `keyboard.combo` | `{ keys: [<logical key names>] }`（min1, 大小無視） | `{ ok: true }` | `modifierMap`/`virtualKeyMap` で解決し、修飾子flags付き down/up を1回post。非修飾キーが1つも解決できないと `eventCreationFailed`→`-32603` | Accessibility |

修飾子名（`modifierMap`）: `cmd/command/meta/primary`→Cmd, `ctrl/control`→Control, `alt/option`→Option, `shift`→Shift, `fn`→SecondaryFn。`primary` はOS共通の「コマンド修飾子」（mac=Cmd, Win=Ctrl予定）。
キー名（`virtualKeyMap`）の対応は `rpc-contract.ts` の `KEY_NAMES`/`MODIFIER_NAMES` と**lockstep**で維持すること（片方だけ変えると契約ドリフト）。

### 3.5 clipboard 系（Clipboard.swift）

| メソッド | params | result | 副作用 | 必要権限 |
| --- | --- | --- | --- | --- |
| `clipboard.read` | none | `{ text }`（テキスト無し時は `""`） | `NSPasteboard.general.string(forType:.string)` | なし |
| `clipboard.write` | `{ text }`（省略時 `""`） | `{ ok: true }` | `clearContents()` 後 `setString`。失敗で `-32603` | なし |

### 3.6 recording 系（Recording.swift）

| メソッド | params | result | 副作用 | 必要権限 |
| --- | --- | --- | --- | --- |
| `recording.start` | none | `{ ok: true }` | 専用ワーカースレッド+CFRunLoopにCGEventTap（`.cgSessionEventTap`, `.listenOnly`）を設置しグローバル録画開始。既に録画中=`-32010`、AX未許可=`-32001`、tap作成失敗=`-32011` | **Accessibility**（必須ガード）+ **Input Monitoring**（tap実動作に必要な場合あり、§6） |
| `recording.stop` | none | `{ ok: true }` または `{ ok:true, wasActive:false }`（録画してなかった場合） | バッファ（text/scroll/pending press）をflush→tap無効化→RunLoop停止 | なし（停止のみ） |
| `recording.poll` | none | `{ events: [RecordingEvent], active: bool }` | スレッドセーフキューをdrain（消費）して返す。pushではなくpoll方式 | なし |

録画イベント（`events[]`）の `kind` と形状（DesktopRecorderが消費、`desktop-recorder.ts`）:
- `click`: `{ seq, kind:"click", button, x, y, ts, element? }`（element=押下点のAXスナップショット）
- `drag`: `{ seq, kind:"drag", x, y, toX, toY, ts, element? }`（押下→DRAG_THRESHOLD=5pt超移動で drag、それ未満で click に解決）
- `type`: `{ seq, kind:"type", text, ts }`（修飾子なしキー入力を TEXT_IDLE_MS=600ms 無入力でバッチflush）
- `key`: `{ seq, kind:"key", keys:[..], ts }`（修飾子コンボ、または Enter/Tab/Esc/矢印等の特殊キー）
- `scroll`: `{ seq, kind:"scroll", x, y, dx, dy, ts }`（SCROLL_IDLE_MS=300ms でバッチflush、符号は replay 規約に変換済み）

`seq` は単調増加（DesktopRecorderが古いセッションの残りをスキップする鍵）。`ts` は Unix秒（小数、`Date().timeIntervalSince1970`）。

---

## 4. desktop-adapter（04）との対応関係

`packages/desktop-adapter/src/macos.ts` の `MacosDesktopAdapter` 各メソッド → 06のRPC:

| Adapterメソッド | 呼ぶRPC |
| --- | --- |
| `findElement({kind:'coords'})` | `accessibility.elementAtPoint` （`ax`/`uia`/`image`/`ocr` selectorは未実装→throw） |
| `click` / `doubleClick`(clicks=2) / `rightClick`(button=right) | `mouse.move_smooth`（`instant`でなければ）→ `mouse.click` |
| `hover` | `mouse.move`（instant）または `mouse.move_smooth` |
| `moveSmoothlyTo`（内部） | `mouse.position`（現在位置取得、失敗時は `mouse.move` フォールバック）→ `mouse.move_smooth` |
| `type` | `clearFirst` 時 `keyboard.combo(['primary','a'])`+`keyboard.combo(['delete'])` → `keyboard.type` |
| `keyCombo` | `keyboard.combo` |
| `scroll` | `mouse.scroll` |
| `drag` | `mouse.drag` |
| `screenshot` | `screen.capture` |
| `findImageOnScreen` | `screen.findImage` |
| `readScreenText` | `screen.ocr` |
| `readClipboard` / `writeClipboard` | `clipboard.read` / `clipboard.write` |
| `listApps` | `accessibility.listApps` |
| `getFocusedApp` | `accessibility.frontmostApp` |
| `ensurePermissions` | `accessibility.status`（screen-recording/input-monitoringは現状「missing扱い」※Adapterレベル） |
| `focusApp` | **未実装**（`NSWorkspace.activate` RPC が無い→throw） |
| 録画（Adapter外、`apps/hermes/src/main/desktop-recorder.ts`） | `recording.start` / `recording.poll`（150ms間隔） / `recording.stop` |

契約検証: `sidecar.ts` の `getSidecarClient()` は `wrapWithContract(handle, { result: 'warn' })` で全RPCを `rpc-contract.ts` の zod でガード。**params違反は throw（自分のバグ）／result違反は warn のみ**（生runを壊さない）。未知メソッドは素通し。

---

## 5. ビルド・起動・梱包

### 5.1 ビルド
- リリース: `pnpm sidecar:mac:build` = `swift build --package-path sidecars/macos-native -c release`
- デバッグ: `pnpm sidecar:mac:build:debug` = `swift build --package-path sidecars/macos-native`
- 成果物: `.build/release/hermes-native` ／ `.build/debug/hermes-native`
- `pnpm dev` は内部で debug ビルド後にアプリを起動。`pnpm build:mac` は release ビルド後にアプリをパッケージ。

### 5.2 Electron(05)からの起動（`sidecar.ts`）
- `locateBinary()` 探索順:
  1. `app.isPackaged` 時: `process.resourcesPath/sidecars/hermes-native`
  2. env `HERMES_NATIVE_BIN`（明示パス）
  3. monorepoビルド: `.build/{debug,release}/hermes-native` のうち **mtime が新しい方**（stale binary バグ回避）
- `spawn(binary, ['--socket', sockPath], { env: { ...process.env, HERMES_NATIVE_SOCKET: sockPath }})`。`sockPath = tmpdir()/hermes-native-<pid>-<Date.now()>.sock`。
- stdout の `hermes-native listening` でハンドシェイク（§2.2）。

### 5.3 梱包（`apps/hermes/electron-builder.yml`）
- `extraResources`: `../../sidecars/macos-native/.build/release/hermes-native` → `sidecars/hermes-native`。
- **コード署名・notarize なし**（`identity: null`, `hardenedRuntime: false`, `gatekeeperAssess: false`, `afterSign: null`）。ユーザはローカルビルド配布前提。target は `dir`/arm64 のみ。

---

## 6. 必要なmacOS権限（どのメソッドにどれが要るか）

| 権限 | 必要なメソッド | 備考 |
| --- | --- | --- |
| **Accessibility（アクセシビリティ）** | `accessibility.elementAtPoint`、`accessibility.frontmostApp`(windowTitle)、`mouse.*`、`keyboard.*`、`recording.start`（必須ガード） | CGEvent を他アプリへ効かせる/AX読取りに必須。`recording.start` は `axPermissionGranted()` を明示チェック |
| **Screen Recording（画面収録）** | `screen.capture`、`screen.findImage`、`screen.ocr` | 不足時 `-32012`。`screen.mainSize` は不要 |
| **Input Monitoring（入力監視）** | `recording.start`（CGEventTap） | 【推測・根拠1行】`.cgSessionEventTap`+`.listenOnly` のグローバルタップはInput Monitoringを要する場合がある。コード上の起動前ガードはAccessibilityのみで、Input Monitoring の直接チェックAPIは呼んでいない（`-32011` メッセージは推測的）。 |

開発時の権限付与先（重要な落とし穴）: 入力/AX/録画は**子プロセス `hermes-native` 自身ではなく、それを起動した親アプリ**に紐づく。`pnpm dev` 起動時は **Electron（開発時は実体の Electron.app / ターミナル）** に各権限を与える必要がある。パッケージ後は **Hermes.app** に付与。署名なしのため OS の権限記憶がビルドごとにリセットされやすい点に注意。

Electron main 側の権限照会・案内（`apps/hermes/src/main/index.ts`、05所管）:
- `checkMacPermission`: accessibility=`systemPreferences.isTrustedAccessibilityClient(false)`、screen-recording=`getMediaAccessStatus('screen')`、input-monitoring/automation=**常に true（Electron33に直接APIなし）**。実際の input-monitoring 状況はサイドカーの実動作で判明する。
- System Settings ディープリンク `settingsDeepLink`: accessibility→`Privacy_Accessibility`、screen-recording→`Privacy_ScreenCapture`、input-monitoring→`Privacy_ListenEvent`、automation→`Privacy_Automation`。

---

## 7. python-vision サイドカー（Phase1での扱い）

- パス: `sidecars/python-vision/` は**空ディレクトリ（ファイルなし）**。
- 役割: 【未確認】将来のビジョン系（高度な画像認識/OCR等）を Python で実装する予約枠と推測されるが、ソースが一切ないため断定不可。
- 起動方式: なし（実装なし）。
- Phase1で配線済みか: **未配線**。Phase1の画像探索/OCRは macOS-native 側（`screen.findImage` 自前NCC ／ `screen.ocr` Apple Vision）で完結している。TS/Electron から python-vision を起動・参照するコードは存在しない。

---

## 8. 変更ガイド（新RPCメソッドを足すとき）

新しいネイティブ操作を1つ足す手順（Swift側 + 04/desktop-adapter側）:

1. **Swift実装**: 該当責務のファイル（Input/Screen/Accessibility 等）に `func newThing(...) throws -> JSONValue` を書く。入出力は `JSONValue` で。座標は論理点・原点左上を守る。
2. **ディスパッチ登録**: `main.swift` の `handlers` 辞書に `"namespace.method": { params in ... }` を追加。paramsは `paramsObject`/`stringValue`/`intValue`/`doubleValue`/`boolValue`/`requireXY`/`regionFromParams` ヘルパで取り出す。エラーは `RpcDispatchError.applicationError(code:message:)` で投げる（新規codeは§2.4の表に追記）。
3. **再ビルド**: `pnpm sidecar:mac:build`（or debug）。`locateBinary` は mtime優先なので、release を直したのに debug が拾われる事故は起きない。
4. **契約追加**: `packages/desktop-adapter/src/rpc-contract.ts` の `RPC_CONTRACT` に同名エントリ（params/result の zod スキーマ）を追加。キー名/修飾子を増やすなら `KEY_NAMES`/`MODIFIER_NAMES` を Input.swift の表と lockstep で。
5. **Adapter配線**: `packages/desktop-adapter/src/macos.ts` の `MacosDesktopAdapter` に呼び出しメソッドを追加（`this.client.call('namespace.method', {...})`）。必要なら `index.ts` の型（`DesktopAdapter` interface）も更新（→04）。
6. **権限**: 新権限が要るなら §6 の表と `apps/hermes/src/main/index.ts` の `checkMacPermission`/`settingsDeepLink` を更新（→05）。
7. **Windows整合**: メソッド名/params/result/座標規約/キー名規約は将来の .NET サイドカーが同一実装する前提。`rpc-contract.ts` のコメント規約（座標=論理点/原点左上、キー名=論理名）を破らない。
8. 本ファイル（06）を同じPRで更新。

---

## 9. 08-glossary に載せるべき不変条件・落とし穴

- **座標は常に論理点（logical points）・スクリーン絶対・原点左上（Quartz）**。物理ピクセルではない。例外は `screen.capture` の result `w/h`（これはピクセル）。findImage/ocr の出力はピクセルから論理点へ変換済み。
- **スクロール符号規約**: `dy > 0` で下スクロール。Swift側（postScroll / 録画 accumulateScroll）が CGEvent wheel軸の逆符号を吸収済み。adapter/IR は変換不要。
- **キー名は論理名（OS仮想キーコードではない）**。`primary` = OS共通コマンド修飾子（mac=Cmd）。`KEY_NAMES`/`MODIFIER_NAMES`（rpc-contract.ts）と `virtualKeyMap`/`modifierMap`（Input.swift）は lockstep。
- **権限は子プロセスでなく親（Electron/Hermes.app）に付与**。署名なし配布のため権限記憶がビルドごとに切れやすい。
- **録画はpush型でなくpoll型**: `recording.poll` をTS側が150ms間隔でdrain。`seq` は単調増加で古いセッション残骸の取りこぼし/重複を防ぐ。
- **録画のclick/drag判別は遅延解決**: leftMouseDownはバッファされ、leftMouseUp時に移動量5pt超でdrag・以下でclick。録画停止時の宙吊りpressはclickとしてflush。
- **契約のresult違反はwarnのみ**（生runを壊さない設計）。params違反はthrow。
- **`-32011` メッセージはInput Monitoring言及だが起動ガードはAccessibilityのみ**。tap作成失敗の真因はメッセージ通りとは限らない。

---

## 10. 【未確認】点まとめ

- python-vision の意図された役割（ディレクトリが空のため断定不可）。
- Input Monitoring が `recording.start`（`.cgSessionEventTap`/`.listenOnly`）に実際に必須かどうか（コードはAccessibilityのみガード。macOSバージョン/設定依存の可能性）。
- `transport.ts`（`SocketTransport`）が現状の本番経路で使われているか。`sidecar.ts` の `Sidecar` クラスは `createConnection` を直接呼んでおり、`transport.ts` は seam として存在するが配線統合は未確認（二重実装に見える）。
- `accessibility.elementAtPoint` 以外のAXセレクタ解決（`ax`/`uia` selector）に必要な「AXツリー走査」RPCは**未実装**（Adapter側でthrow）。将来サブフェーズ予定。
- `focusApp` 用 `NSWorkspace.activate` RPC は未実装。
