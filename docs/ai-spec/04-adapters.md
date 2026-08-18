# 04. アダプタ / プロバイダ層(web/desktop/recorder/excel)
> 最終更新: 2026-05-31 ／ 対象コミット: b3d5fa6 (feat/phase-1-completion)
> AI用仕様書。コードを読む前にまずこれを読む。該当コードを変更したら同じPRでこのファイルも更新すること。

関連: [README](README.md) / [01-architecture](01-architecture.md) / [02-ir-schema](02-ir-schema.md) / [03-engine](03-engine.md) / [05-app-electron](05-app-electron.md) / [06-sidecar-macos](06-sidecar-macos.md) / [07-storage-vault](07-storage-vault.md) / [08-glossary](08-glossary.md)

---

## 0. この層の位置づけ

エンジン(03)は「ステップを実行する」抽象だけを持ち、Web/デスクトップ/Excel の具体的な操作方法は**一切知らない**。具体は本層の4パッケージが担う。

| パッケージ | layer | 何を操作するか | 依存 |
|---|---|---|---|
| `@hermes/web-provider` | `web` (+`default`) | Chromium/Chrome をPlaywrightで操作 | `playwright-core` |
| `@hermes/desktop-adapter` | `desktop` / `screen` (+`default`) | macOSアプリ操作。Swiftサイドカー(06)へJSON-RPC | `zod`(契約検証) |
| `@hermes/recorder-web` | (記録専用、layer非該当) | ブラウザ操作の記録→IR Step化 | `playwright-core`, `mitt`, `ulid` |
| `@hermes/excel-provider` | `default` | `.xlsx` ファイル直読み書き(Excelアプリ不要) | `exceljs` |

デスクトップ操作の**記録**側 `DesktopRecorder` は `apps/hermes/src/main/desktop-recorder.ts` にあり(担当は05)、本層の `desktop-adapter` の `recording.*` RPC と `DesktopSelector` 型を消費する。本書では境界として軽く触れる。

### エンジンとの契約(03から呼ばれる形)

エンジン側 `packages/engine/src/types.ts` / `registry.ts` で定義される2つの仕組みで結合する。

1. **ProviderBag**(`RunContext.providers`): エンジンは構造的に `kind` フィールドだけで識別する不透明ハンドル。
```ts
export interface ProviderBag {
  web?: WebProviderHandle;      // { readonly kind: 'web' }
  desktop?: DesktopProviderHandle; // { readonly kind: 'desktop' }
  excel?: ExcelProviderHandle;  // { readonly kind: 'excel' }
  ai?: AiServiceHandle;
}
```
各プロバイダ実装(`WebProvider` / `DesktopProvider` / `ExcelProvider`)は対応する `kind` を持ち、ハンドラ側が `instanceof` で具象クラスへダウンキャストする。

2. **StepHandler + HandlerRegistry**: ステップ実行の本体。
```ts
export interface StepHandler<P = Record<string, unknown>> {
  type: StepType;
  execute(step: Step, ctx: RunContext): Promise<StepResult<P>>;
}
```
`registry.register(handler, layer)` でレイヤ別に登録。`registry.get(type, layer)` は「指定レイヤ → なければ `default`」の順で解決する(`registry.ts:33`)。`HandlerLayer = 'web' | 'desktop' | 'screen' | 'default'`。

**レイヤ割り当ての要点**:
- web ハンドラは `default` レイヤに登録される(`registerWebHandlers`)。`open_url`/`wait`/`set_var` のような `target.layer` を持たないステップと、`target.layer==='web'` の両方を web が拾う。
- desktop ハンドラは `desktop` レイヤ、screen ハンドラは `screen` レイヤに登録され、対応レイヤの target を持つステップだけが拾われる(同じ `click` 型でも web/desktop/screen で別実装)。
- clipboard / excel ハンドラは `default` レイヤ(target を持たないため)。これは web ハンドラと同じ `default` 名前空間だが、**ステップ型が重複しない**(`clipboard_read`/`excel_open` 等は web に無い)ので衝突しない。同一 `layer::type` を二重登録すると `register` が throw する。

**エラークラス規約**: ハンドラ/アダプタが投げる `Error` には `class` 文字列を付ける(`selector_not_found` / `timeout` / `network` / `any` など)。エンジンのリトライポリシーがこれを見て再試行可否を判定する。`DesktopAdapterError` は `errClass` を受け取り、`this.class` にも同値を立てる(`index.ts:207`)。

### 実行時の登録順(参考: app側 `run-controller.ts:454-459`)

```ts
registerWebHandlers(registry);                 // 常時
if (this.desktop) registerDesktopHandlers(registry);
if (this.desktop && needsScreen) registerScreenHandlers(registry);
if (this.desktop && needsClipboard) registerClipboardHandlers(registry);
if (this.excel && needsExcel) registerExcelHandlers(registry);
```
desktop/screen/clipboard/excel はフローが当該ステップを含むときだけ登録される(`needsX` フラグ)。CLI 側 `packages/cli/src/run-flow.ts` もほぼ同形。

---

## 1. web-provider — Web操作の実行とセレクタ解決

ファイルマップ:

| パス | 責務 |
|---|---|
| `packages/web-provider/src/web-provider.ts` | `WebProvider` クラス本体。Chromium起動・アクションプリミティブ群。 |
| `packages/web-provider/src/handlers.ts` | webステップハンドラ群と `registerWebHandlers`。 |
| `packages/web-provider/src/selector.ts` | `resolveSelector`(候補配列→Locator)と `candidateLabel`(UI表示用ラベル)。 |
| `packages/web-provider/src/index.ts` | 公開API再エクスポート。 |
| `test/handlers.test.ts` | type の `control:'select'` 分岐、`wait_for` の `kind` 分岐。 |
| `test/selector.test.ts` | `candidateLabel` の全 `kind` 出力。 |
| `test/e2e-chrome.integration.test.ts` | 実Chrome起動E2E。`HERMES_E2E=1` のときのみ実行。 |

### 1.1 WebProvider のブラウザ方式

- **Playwright `chromium.launchPersistentContext`** を使う。**CDPアタッチではなく**、フローごとに永続プロファイルディレクトリ(`opts.profileDir`、通例フローフォルダ内 `browser-profile/`)を起こす。Cookie/localStorage がそこに残るので記録時の続きから再生できる。
- `channel: 'chrome' | 'msedge' | 'chromium'` 指定可。`'chrome'` ならシステムのGoogle Chromeを使い、Playwrightブラウザバイナリのダウンロードが不要(E2Eテストもこれで動く)。
- デフォルト: `headless: false`、viewport `1280x800`、locale `ja-JP`、timezone `Asia/Tokyo`、`acceptDownloads: true`。
- **アンチ検出**: `HARDENING_ARGS`(launch args)+ `ANTI_FINGERPRINT_SCRIPT`(全ページ `addInitScript`)で `navigator.webdriver`/`plugins`/`languages`/`permissions.query`/`window.chrome` を実Chrome形状に偽装。WebGL/Canvas/UAは偽装しない(channel:chrome + 実プロファイルで本物の指紋が出るため、不整合の方が疑われる)。**【事実】これは低コストなシグナルのみを潰すもので、挙動スコアリングやIP評判は防げない**(コメントに明記)。
- マウス座標の連続性のため、`window.__hermesLastMousePos` をinitスクリプトで全ページに仕込み、`mousemove` で追従させる。ヒューマナイズ移動はここを起点に補間する。

ライフサイクル: `start()`(冪等)→ 操作 → `close()`。`page()` は直近にフォーカス/生成されたページ(`activePage`)を返す。`getContext()` はレコーダ接続用に `BrowserContext` を露出。

### 1.2 アクションプリミティブ(`WebProvider` のメソッド)

すべて `TargetRef` を受け、内部で `resolve()` → Locator にしてから操作する。

| メソッド | 署名(要約) | 振る舞い |
|---|---|---|
| `openUrl` | `(url, opts?:{waitUntil})` | `page.goto`。`waitUntil` 既定 `'load'`。 |
| `click` | `(target, opts?: HumanizedClickOpts)` | 直近マウス位置から対象中心まで線形補間移動してからクリック。`instant`/box無し/`speed<=0` ならプレーンな `locator.click`。ステップ数は距離・速度・±15%ジッタから算出。 |
| `typeInto` | `(target, text, opts?: HumanizedTypeOpts)` | 1文字ずつ `keyboard.type`(各打鍵±35%ジッタ)。`delayMs<=0` で `fill()` に退避。`clearFirst` で先に `fill('')`。 |
| `selectOption` | `(target, value)` | `<select>` 用。まず option value で、失敗したら label で選ぶ。 |
| `keyCombo` | `(keys: string[])` | `mapKeyCombo` で論理キー→Playwright形式(`primary`→mac:`Meta`/他:`Control`)へ変換し `keyboard.press`。 |
| `scroll` | `(target\|null, dx, dy)` | target有: 要素の `scrollBy`。null: `mouse.wheel`。 |
| `waitFor` | `({target?, url?, timeoutMs?, state?})` | `url` 指定なら `page.waitForURL(正規表現)`、`target` 指定なら解決後 `locator.waitFor({state})`(既定 `'visible'`)。どちらも無ければ throw。 |
| `waitForLoadState` | `(state='load', timeoutMs=10000)` | `page.waitForLoadState` の薄いラッパ。 |
| `screenshot` | `({fullPage?, clip?:Rect})` | `Buffer` を返す。`clip` の `w/h` を Playwright の `width/height` に変換。 |
| `extract` | `(target, attribute='innerText')` | `innerText`/`textContent`→trim済テキスト、`value`→`inputValue()`、他→`getAttribute`。 |
| `resolve` | `(target, opts?) → {locator, candidateIndex}` | `resolveSelector` を呼び、解決不能なら `Error{class:'selector_not_found'}`。 |

`HumanizedClickOpts`: `{ button?, clickCount?, speedPxPerSec?, minSteps?, maxSteps?, instant? }`。
`HumanizedTypeOpts`: `{ clearFirst?, delayMs? }`。

### 1.3 セレクタ解決(`selector.ts`)

`resolveSelector(page, target, opts?)`:
- `target.layer !== 'web'` なら throw(web専用)。
- **候補配列を順に試し、ちょうど1要素にマッチした最初の候補を採用**(`count()===1`)。これが「マルチストラテジセレクタ」の再生側。
- `target.preferIndex`(前回成功した候補)があればそれを先頭に並べ替える(`orderedCandidateIndexes`)— サイトがDOMをシャッフルしても学習効果が出る。
- どれもマッチしなければ `100ms`→`500ms` バックオフでデッドライン(既定 `5000ms`)まで再試行し、ダメなら `null`。

候補 `Selector.kind` → Playwright Locator のマッピング(`candidateToLocator`):

| kind | Locator |
|---|---|
| `role` | `page.getByRole(role, {name?, exact?})` |
| `testid` | `page.getByTestId(value)` |
| `label` | `page.getByLabel(text)` |
| `text` | `page.getByText(value)` |
| `css` | `page.locator(value)` |
| `xpath` | `page.locator('xpath='+value)` |
| `url-anchor` | `null`(要素解決には使わない。ページ自体のマッチ用) |
| `ax`/`uia`/`image`/`ocr`/`coords` | `null`(web では非対応) |

`candidateLabel(sel)` は全 `kind`(`ax`/`uia`/`image`/`ocr`/`coords` 含む)に対しUI表示用の短い文字列を返す。`text` は40字で切る。

### 1.4 webステップハンドラ(`handlers.ts`)

`registerWebHandlers` が登録する型(`default` レイヤ)。`webStepHandlers.test.ts` がこの一覧をアサート:

`open_url` / `click` / `type` / `key_combo` / `scroll` / `wait_for` / `wait` / `screenshot` / `extract` / `set_var`

各ハンドラの要点:
- `provider(ctx)`: `ctx.providers.web` を取り、`WebProvider` インスタンスでなければ throw。
- **ヒューマナイズ設定**(`humanizeSettings`): `ctx.vars.__hermes_humanize__`(RunControllerがAppSettingsから注入)→既定値(`mouseSpeedPxPerSec:800, typeDelayMs:50, mouseMinSteps:8, mouseMaxSteps:60`)。`step.params` の個別上書きが最優先。
- `click`: `params.button/clickCount/mouseSpeedPxPerSec/instant` を読み、ヒューマナイズ引数を組んで `provider.click`。
- `type`: **`params.control==='select'` なら `selectOption` に分岐**(記録された `<select>` 変更の再生)。それ以外は `clearFirst`/`delayMs` を渡して `typeInto`。
- `key_combo`: `params.keys[]` 必須。
- `wait_for`: `params.kind` で分岐。`web.load`→`waitForLoadState`、`web.url`(または kind無し+url有り)→ `waitFor({url})`、`web.element`(または kind無し+target有り)→ `waitFor({target, state})`。`timeoutMs` は `step.timeoutMs ?? params.timeoutMs`。
- `wait`: `params.ms` だけ `setTimeout`。
- `screenshot`: base64を `ctx.vars['__screenshot_${id}__']` に置き、`{type:'screenshot'}` イベントをemit。ファイルIOはオーケストレータ(app)に委ねる。`assetRef` は `step.meta.screenshotRef ?? 'step-${id}.png'`。
- `extract`: `params.attribute`(既定innerText)で抽出し、`params.into` があれば `ctx.vars[into]` に格納。
- `set_var`: `params.name`/`params.value` を `ctx.vars` に設定。

---

## 2. desktop-adapter — macOSアプリ操作(Swiftサイドカー連携)

ファイルマップ:

| パス | 責務 |
|---|---|
| `packages/desktop-adapter/src/index.ts` | クロスOS契約。`DesktopAdapter` インターフェース、`DesktopSelector` 型、`ClickOpts`/`TypeOpts`/`ElementHandle`/`PermissionStatus` 等、`DesktopAdapterError`。`rpc-contract.js` を再エクスポート。 |
| `packages/desktop-adapter/src/macos.ts` | `MacosDesktopAdapter`。`DesktopAdapter` のmacOS実装。サイドカーへRPCを投げる。 |
| `packages/desktop-adapter/src/handlers.ts` | desktop / screen / clipboard の3群のステップハンドラと各 `registerXHandlers`。 |
| `packages/desktop-adapter/src/desktop-provider.ts` | `DesktopProvider`(`kind:'desktop'` でアダプタを包む薄いラッパ)。 |
| `packages/desktop-adapter/src/sidecar-client.ts` | JSON-RPC over UDS のクライアント(行区切り・id対応・タイムアウト)。 |
| `packages/desktop-adapter/src/transport.ts` | `Transport` シーム + `SocketTransport`(`node:net`)。 |
| `packages/desktop-adapter/src/rpc-contract.ts` | **zod検証のRPC契約**(メソッド名・params・result・座標/キー名規約)+ `wrapWithContract`。 |
| `test/macos.test.ts` | 各メソッド→RPC変換のアサート(フェイククライアント)。 |
| `test/handlers.test.ts` | desktop/screen/clipboard ハンドラの分岐。 |
| `test/rpc-contract.test.ts` | 契約のメソッド集合・実payload受理・不正payload拒否・`wrapWithContract`。 |
| `test/transport.test.ts` | フレーミング/再アセンブル/id振り分け/実UDS往復。 |

### 2.1 DesktopAdapter 契約(`index.ts`)

エンジン(とハンドラ)が見る唯一の面。全メソッド async。実装はmacOS(Swift)/将来Windows(.NET)で差し替える。

```ts
export interface DesktopAdapter {
  findElement(selector: DesktopSelector, opts?: FindOpts): Promise<ElementHandle | null>;
  click(target: ElementHandle | Point, opts?: ClickOpts): Promise<void>;
  doubleClick(target, opts?): Promise<void>;
  rightClick(target, opts?): Promise<void>;
  hover(target, opts?): Promise<void>;
  type(text: string, opts?: TypeOpts): Promise<void>;
  keyCombo(keys: ReadonlyArray<string>): Promise<void>;
  scroll(target, dx: number, dy: number): Promise<void>;
  drag(from, to): Promise<void>;
  screenshot(opts?: ScreenshotOpts): Promise<Buffer>;
  findImageOnScreen(template: Buffer, opts?: FindImageOpts): Promise<ImageMatch>;
  readScreenText(opts?: OcrOpts): Promise<OcrResult>;
  waitForState(predicate: () => boolean|Promise<boolean>, opts?: WaitOpts): Promise<void>;
  readClipboard(): Promise<string>;
  writeClipboard(text: string): Promise<void>;
  listApps(): Promise<AppInfo[]>;
  focusApp(ref: AppRef): Promise<void>;
  getFocusedApp(): Promise<AppInfo | null>;
  ensurePermissions(): Promise<PermissionStatus>;
  dispose(): Promise<void>;
}
```

`DesktopSelector`(IRの `Selector` のデスクトップ/スクリーン部分のサブセット):
```ts
type DesktopSelector =
  | { kind: 'ax'; app: string; role: string; title?; identifier?; path?: {role,index?,title?}[] }
  | { kind: 'uia'; processName: string; automationId?; controlType: string; name? }   // Windows用、未使用
  | { kind: 'image'; assetRef: string; threshold: number; scaleInvariant? }
  | { kind: 'ocr'; text: string; lang: string; regex? }
  | { kind: 'coords'; x: number; y: number; anchor: 'screen' | 'window' };
```
`Point = {x,y}`。`ElementHandle = { selectorEcho, bbox:Rect, role, title?, value?, identifier?, app? }`。
`ClickOpts = { button?, clicks?:1|2|3, modifiers?, speedPxPerSec?, minSteps?, maxSteps?, instant?, durationMsOverride? }`。
`durationMsOverride`: フロー前処理が「直前 `wait` を移動に畳み込む」ときに使い、距離/速度計算を無視して移動時間を固定する(録画リズムでクリックを着地させる)。

### 2.2 MacosDesktopAdapter の実装範囲(Phase 1)

`macos.ts` 冒頭コメントの通り:
- **実装済み**: coords系の `click/doubleClick/rightClick/hover`、`type`、`keyCombo`、`scroll`、`drag`、`screenshot`、`listApps`、`getFocusedApp`、`ensurePermissions`、`dispose`、スクリーン層(`findImageOnScreen`/`readScreenText`)、`readClipboard`/`writeClipboard`、`waitForState`。
- **スタブ(未実装で throw)**: AXセレクタ探索 — `findElement` は `coords` のみ解決し、`ax`/`uia`/`image`/`ocr` は `DesktopAdapterError('not yet implemented', 'selector_not_found')`。`focusApp` も `DesktopAdapterError`(`NSWorkspace.activate` RPC待ち)。
- `ensurePermissions` は **Accessibility のみ実チェック**(`accessibility.status`)。`screen-recording`/`input-monitoring` は常に `missing` に積む(ScreenCaptureKit/CGEventTap のステータスRPC未着のため、呼び出し側がユーザーに促す前提)。

### 2.3 各メソッド → どのRPCを投げるか

| アダプタメソッド | サイドカーRPC | 備考 |
|---|---|---|
| `findElement({coords})` | `accessibility.elementAtPoint {x,y}` | snapshot を `ElementHandle` に変換。 |
| `click` (非instant) | `mouse.position` → `mouse.move_smooth` → `mouse.click` | instant時は `mouse.click` のみ。 |
| `click` (instant) | `mouse.click {x,y,button,clickCount}` | ヒューマナイズ移動を飛ばす。 |
| `hover` | `mouse.move`(instant) / `mouse.move_smooth`(通常) | 押下なしの移動のみ。 |
| `type` | (clearFirst時 `keyboard.combo[primary,a]`→`keyboard.combo[delete]`) → `keyboard.type {text,intervalMs}` | intervalMs既定50。 |
| `keyCombo` | `keyboard.combo {keys}` | 論理キー名をそのまま渡す。 |
| `scroll` | `mouse.scroll {x,y,dx,dy}` | target中心点で。 |
| `drag` | `mouse.drag {fromX,fromY,toX,toY}` | |
| `screenshot` | `screen.capture {region?}` | base64 → Buffer。 |
| `findImageOnScreen` | `screen.findImage {template(base64),threshold?,scaleInvariant?,region?}` | hit を `{found,score,center,bbox}` に。 |
| `readScreenText` | `screen.ocr {region?,languages?}` | observations を bbox 形に正規化。 |
| `listApps` | `accessibility.listApps` | |
| `getFocusedApp` | `accessibility.frontmostApp` | |
| `ensurePermissions` | `accessibility.status` | |

**`moveSmoothlyTo` の肝**: `mouse.position` で現在地を取り、距離/速度から `durationMs`/`steps` を算出して `mouse.move_smooth` を投げる。`mouse.position` が無い/throw なら単発 `mouse.move` にフォールバック(新RPC未デプロイ環境への保険)。フレーム間隔目標は `DEFAULT_MOUSE_FRAME_INTERVAL_S=0.006`(~166fps)。`move_smooth` のタイムアウトは `durationMs + 4000ms`。返却 `actualFps`/`maxSlipMs` が目標の70%未満 or slip>4ms のとき `console.warn` で記録(throw はしない=品質問題であって失敗ではない)。デフォルトステップ境界は **desktop は `minSteps:16, maxSteps:1200`**(webの 8/60 とは別)。

### 2.4 desktopハンドラ(`handlers.ts`、`desktop` レイヤ)

`registerDesktopHandlers` が登録: `click` / `type` / `key_combo` / `scroll` / `drag` / `wait_for`。

- `adapter(ctx)`: `ctx.providers.desktop` を `DesktopProvider` から取り出し `.adapter` を返す。
- `coordsFromTarget`: target候補から `kind:'coords'` を探して `Point` に。無ければ `DesktopAdapterError('selector_not_found')`。**現状 desktop ステップは coords セレクタ必須**(AX解決は未実装)。
- `humanizeSettings` は web と同形だが既定 `mouseMinSteps:16, mouseMaxSteps:1200`。
- `click`: `params.action==='hover'` なら押下なしの `adapter.hover`。それ以外は `buildClickOpts`(button/clicks/speed/instant/`moveDurationMs`→`durationMsOverride`)で `adapter.click`。
- `type`: `params.intervalMs ?? params.delayMs ?? humanize.typeDelayMs`、`clearFirst` を `adapter.type`。
- `scroll`/`drag`: coords + `params.dx/dy` または `params.to={x,y}`。
- `wait_for`: `params.kind`(既定 `desktop.element`)で分岐 —
  - `desktop.element`: `adapter.findElement(selectorFromTarget(target))`、null なら `selector_not_found`。
  - `desktop.app_focus`: `params.appBundleId` 必須。`getFocusedApp().bundleId` 一致を `waitForState` でポーリング。
  - `desktop.window_title`: `params.titlePattern` を正規表現として `getFocusedApp().title` に対しポーリング。
  - `desktop.screen_stable`: `params.stableMs`(既定500) 連続で `screenshot` がバイト一致するまで待つ。`prev.equals(shot)` の厳密比較。タイムアウトで `class:'timeout'`。
  - 未知kind は `Error('Unsupported desktop wait_for kind')`。

### 2.5 screenハンドラ(`screen` レイヤ)

`registerScreenHandlers` が登録: `click` / `extract`。**画像テンプレート / OCR / coords でクリック点を解決**する(AXに依存しない画面操作)。

- `resolveScreenPoint(step, ctx)`: target候補を順に —
  - `coords` → そのまま点。
  - `image` → `resolveAssetBytes`(assetRefを `ctx.vars.__hermes_assets_dir__` 基準でロード、絶対パスはそのまま) → `adapter.findImageOnScreen(tmpl, {threshold, scaleInvariant?, region?})`。`found && center` なら center を返す。未検出は `selector_not_found`。
  - `ocr` → `adapter.readScreenText({region?, languages:[lang]?})` → `ocrFind`(substring または `regex`)で一致行 → bboxの中心。
- `extract`: `ocr` セレクタがあればその一致行、無ければ全認識テキストを `params.into` に格納し `data.value` で返す。

### 2.6 clipboardハンドラ(`default` レイヤ)

`registerClipboardHandlers` が登録: `clipboard_read` / `clipboard_write`。target を持たない(クリップボードは単一システム資源)。

- `clipboard_read`: `params.settleMs`(既定0)だけ**読む前に**待ち、`adapter.readClipboard()` を `params.into` に格納。
- `clipboard_write`: `adapter.writeClipboard(params.value)` の後に `settleMs` 待つ(Cmd+V がペースト前に新内容を見るため)。

### 2.7 サイドカー通信(`sidecar-client.ts` / `transport.ts` / `rpc-contract.ts`)

詳細は06。ここでは契約の要点のみ。

**SidecarClient**: 行区切りJSON(1リクエスト1行+`\n`)。`call(method, params?, timeoutMs?)` が `id` を採番して `Promise` を返し、`id` 一致のレスポンスで解決(到着順ではなく `id` で振り分け)。既定タイムアウト5000ms。**サイドカーのspawnはしない**(呼び出し側=apps/hermes Mainの責務)。チャネル切断時は全pending callをreject。

**Transport シーム**: `SocketTransport`(`node:net`)が UDS(macOS)と名前付きパイプ(Windows)の両方を `path` 文字列だけで扱う。テストはフェイクtransportを注入。

**RPC契約**(`rpc-contract.ts`、不変条件): メソッド名・params・result を zod で固定する単一の真実。座標は**スクリーン絶対・左上原点・論理ポイント**(物理ピクセルではない)。キー名は**論理・大小無視の名前**(OS仮想キーコードではない)で、`primary`=OSのコマンド修飾子(mac:Cmd / Win:Ctrl)。`MODIFIER_NAMES`/`KEY_NAMES` が許容トークン、`Input.swift` の対応表とロックステップ。

契約メソッド集合(`RPC_METHODS`、`rpc-contract.test.ts` で**Swiftディスパッチ表と完全一致**を保証):
```
ping
accessibility.status / .listApps / .frontmostApp / .elementAtPoint
screen.mainSize / .capture / .findImage / .ocr
mouse.click / .move / .position / .move_smooth / .scroll / .drag
keyboard.type / .combo
clipboard.read / .write
recording.start / .stop / .poll
```
`wrapWithContract(client, opts)`: paramsは送信前に検証(違反は自分のバグなので throw)、resultは送信後に検証(既定 `'warn'`=ログのみ。`'throw'`/`'off'` 可)。**未知メソッドは素通し**(契約追加前にサイドカーへメソッドを足してもハードフェイルしない)。

`recording.*` はデスクトップ**記録**(05の `DesktopRecorder`)が使う。`recording.poll` の `events` は `{kind:string}` のpassthroughで、per-kindペイロードは契約に縛られない(レコーダが独自にパース)。

---

## 3. recorder-web — ブラウザ操作の記録

ファイルマップ:

| パス | 責務 |
|---|---|
| `packages/recorder-web/src/recorder.ts` | `WebRecorder` クラス。BrowserContextに接続し、ページからのイベントをIR Stepへ変換・emit。 |
| `packages/recorder-web/src/inject-script.ts` | `INJECT_SCRIPT`(ページ内で動く生JS文字列)。DOMイベント捕捉とElementSnapshot生成。 |
| `packages/recorder-web/src/selector-builder.ts` | `buildSelectorCandidates`(ElementSnapshot→`Selector[]`)。 |
| `packages/recorder-web/src/index.ts` | 公開API。 |
| `test/recorder-wait-emit.test.ts` | 自然な間→`wait`ステップ化のタイミング演算。 |
| `test/recorder-controls.test.ts` | `<select>`/checkbox/radio のフォーム分類。 |
| `test/selector-builder.test.ts` | 候補配列の優先順位・dedupe・escape。 |
| `test/e2e-record-replay.integration.test.ts` | 記録→IR→再生の全チェーンE2E(`HERMES_E2E=1`時のみ)。 |

### 3.1 捕捉するイベント(`inject-script.ts`)

`BrowserContext.addInitScript` で全ページに注入。`window.__hermes_record(payload)`(`exposeBinding` で公開)経由でオーケストレータへ送る。`window.__hermes_recorder_installed__` で二重注入防止。

捕捉する3つのDOMイベント(すべて `capture:true`):
- **`click`**: `ascendInteractive`(対象から最大8階層上に登りインタラクティブ祖先を探す)した要素の `snapshot` を `kind:'click'` で送る。button は `e.button`(2→right/1→middle/他→left)。
- **`change`**: `INPUT`/`TEXTAREA`/`SELECT` のみ。**最終値**(`t.value`)を `kind:'input'` で送る(キーストローク単位では記録しない)。`type==='password'` なら `isSecret:true`。
- **`keydown`**: 修飾キー併用(`metaKey||ctrlKey||altKey`)かつ修飾キー単独でないもの(Cmd+S等)を `kind:'key'` で送る。`document.activeElement` のsnapshotを添える。

`ElementSnapshot`(snapshot関数の出力): `tag, role(inferRole), ariaName(getAccessibleName), testid(data-testid系), id, name, type, classList(先頭4), text(80字), href, placeholder, label, cssPath(buildCssPath), xpath(buildXPath), rect`。`inferRole` はタグ→ARIAロール推定(A→link, BUTTON→button, INPUT→type別, SELECT→combobox 等)。`buildCssPath` はid優先で `>` 連結・`nth-of-type` 付与、`buildXPath` はid優先で `/html/body/...[idx]`。

### 3.2 ペイロード → IR Step 変換(`recorder.ts`)

`WebRecorder` ライフサイクル: `attach(provider)` → `start()` → `on('step', ...)` → `stop()` → `detach()`。`attach` で `exposeBinding('__hermes_record')` と initスクリプト注入、各ページに `framenavigated` リスナを張る。

`handlePayload(payload)` の分類(`running` 中のみ):
- `click`: 対象が `<select>` なら**ドロップ**(ネイティブoption listは再生不能。値は `change` 側が拾う)。それ以外は `buildClickStep`。
- `input`: `checkbox`/`radio` は**ドロップ**(click ステップがトグルを担うので、change を `type` 再生すると非テキスト要素に `fill()` して落ちる)。それ以外は `buildInputStep`。
- `key`: `buildKeyStep`。
- `navigate`(`framenavigated` 由来): `buildNavigateStep`(`open_url`)。`about:` や同URL重複は無視。

Step構築:
- `buildClickStep` → `type:'click'`、`elementToTarget` で `TargetRef`(`layer:'web'`, candidates, `region`=rect, `anchor`=URL短縮)。labelは ariaName/text。左以外のbuttonのみ `params.button`。
- `buildInputStep` → `type:'type'`。`<select>` は `params:{text:value, control:'select'}`(再生時 `selectOption` へ)。テキスト入力は `{text, clearFirst:true}`。**secret は値ではなく `${secrets.<label|name|'value'>}` を入れる**(IRに平文を残さない)。
- `buildKeyStep` → `type:'key_combo'`、`params.keys`。focused要素があれば target も付ける。

`elementToTarget` は `buildSelectorCandidates(snap)` を candidates に詰める。

### 3.3 録画中の `wait` 挿入(recorder-wait-emit)

`emitStep(step, raw)` が、前回emit時刻 `lastEmitTs` との差分を見て、**人間の自然な待ち時間を `wait` ステップとして挟む**(再生時に録画のリズムを再現)。

- 既定しきい値 `DEFAULT_MIN_RECORDED_WAIT_MS = 200`(`minRecordedWaitMs` で変更可)。
- 差分 `>= しきい値` のときだけ、実ステップの**前に** `type:'wait'`, `params:{ms:diff}`, `label:'<diff>ms 待機（録画）'` を挿入。
- `recordWaits`(既定true)を `setRecordWaits(false)` で切ると一切挿入しない(編集側で手動追加する運用)。
- `start()`/`stop()` は `lastEmitTs=0` にリセット → **次の録画が前回末尾との巨大ギャップをback-fillしない**。
- 最初のイベントの前には wait を出さない(`lastEmitTs>0` 条件)。

`DesktopRecorder`(05、`apps/hermes`)も同じ `wait` 挿入ロジックを持つ(Step形状をWebRecorderと揃えてある)。

### 3.4 セレクタ候補の優先順位(`selector-builder.ts`)

`buildSelectorCandidates(snap)` が出す順(dedupe済、`selector-builder.test.ts` が順序を保証):
1. `role` + `name`(両方あれば `exact:true`)。roleのみなら name無し。
2. `testid`
3. `label`(input用、関連 `<label>` テキスト)
4. `css`(`#<escaped id>`)
5. `text`(1〜60字のとき)
6. `css`(cssPath)
7. `xpath`

`cssEscape` は `a-zA-Z0-9_-` 以外をバックスラッシュエスケープ。この順序が再生時 `orderedCandidateIndexes`/`preferIndex` の初期順になる。

---

## 4. excel-provider — .xlsx 直接読み書き

ファイルマップ:

| パス | 責務 |
|---|---|
| `packages/excel-provider/src/index.ts` | `ExcelProvider`(exceljsラッパ)、`parseRange`、`createExcelProvider`、`ExcelCellValue` 型。 |
| `packages/excel-provider/src/handlers.ts` | excelステップハンドラ(`excel_open`/`excel_read`/`excel_write`/`excel_range`)と `registerExcelHandlers`。 |
| `packages/excel-provider/test/excel.test.ts` | プロバイダ・ハンドラ・`parseRange` のユニットテスト。 |

### 4.1 Phase 1 での扱い(コード/テストの実態)

- **コードもテストも揃っており、macOS上で完結して動く**。`exceljs` でファイルベース(`.xlsx`)に直接読み書きするため、**Excelアプリ不要・OS非依存**でユニットテスト可能(冒頭コメント明記)。memoryの「Excelはコードのみ/テストはWin保留」はExcel**アプリ操作(COM/UIA経由)**のことで、この**ファイルベースexcel-providerは別物・テスト有効**。
- 実行時は `run-controller.ts:459` で「フローが excel ステップを含むとき(`needsExcel`)」だけ `registerExcelHandlers` される。
- ワークブックは解決後パスをキーに**メモリ保持**(1フロー内の read-modify-write が一貫)。書き込み系ハンドラは**即ディスクへflush**(Phase1に独立saveステップは無い)。

### 4.2 ExcelProvider API

- `openWorkbook(path)`: 既存なら `readFile`、無ければ `Sheet1` 付き新規。既オープンはno-op。
- `readCell(path, cell, sheet?) → ExcelCellValue` / `writeCell(path, cell, value, sheet?)`。
- `readRange(path, range, sheet?) → ExcelCellValue[][]` / `writeRange(path, range, values, sheet?)`(rangeの左上から2-D配列を書く)。
- `save(path)` / `dispose()`(全ワークブッククリア)。
- `parseRange(range)`: `"A1"` / `"A1:C3"` を1-based `{c1,r1,c2,r2}` に。逆順や複数文字カラム(`Z1:AB2`)も正規化。
- `cellToValue`: 数式は `result`(キャッシュ値)優先、リッチテキストは run連結、ハイパーリンクは表示テキスト、Dateは ISO文字列。
- `ExcelCellValue = string | number | boolean | null`。

### 4.3 excelハンドラ(`default` レイヤ)

`registerExcelHandlers` が登録(target不要):
- `excel_open {path}`
- `excel_read {path, cell, sheet?, into}` — セル→変数。
- `excel_write {path, cell, value, sheet?}` — 変数/値→セル(+即save)。
- `excel_range {path, range, sheet?, into}` — 範囲→変数(2-D配列)。
- `excel_range {path, range, sheet?, values}` — 2-D配列→範囲(+即save)。`values` 有無でread/writeを分岐。

`resolvePath`: 相対パスは `ctx.vars.__hermes_assets_dir__`(フローディレクトリ)基準。絶対はそのまま。screen層の画像assetと同じ規約。`provider(ctx)` は `ExcelProvider` でなければ throw。

---

## 5. 変更ガイド(よくある拡張で触る場所)

### 新しいセレクタ `kind` を追加して解決させたい
1. IRに型追加: `packages/ir/src/schema.ts` の `Selector` union(02参照)。
2. web対応なら `web-provider/src/selector.ts` の `candidateToLocator` に case 追加。`candidateLabel` にも case 追加(全kind網羅必須、漏れると型エラー)。
3. desktop/screen対応なら `desktop-adapter/src/handlers.ts` の `resolveScreenPoint`(screen)や `coordsFromTarget`/`selectorFromTarget`(desktop)、必要なら `MacosDesktopAdapter.findElement` の分岐と対応RPC・契約(`rpc-contract.ts`)を追加。
4. 記録側で出すなら `recorder-web/src/selector-builder.ts` の `buildSelectorCandidates` に生成ロジックを足す(優先順位とテストも)。

### 新しい記録イベントに対応したい(web)
1. `recorder-web/src/inject-script.ts` に DOMリスナと送信payload(新 `kind`)を追加。
2. `recorder.ts` に `RecorderXPayload` 型と `handlePayload` の分岐、`buildXStep`(IR Step化)を追加。
3. 対応する再生ハンドラが無ければ `web-provider/src/handlers.ts` に StepHandler を追加し `registerWebHandlers` の配列に入れる(+ `WebProvider` にプリミティブ)。
4. `handlers.test.ts` の登録型一覧アサートも更新。

### 新しいサイドカーRPCを足したい(desktop)
1. `rpc-contract.ts` の `RPC_CONTRACT` に params/result schema を追加(座標は論理ポイント・キー名は論理名の規約厳守)。
2. `rpc-contract.test.ts` の `EXPECTED_METHODS` と REAL_PARAMS/REAL_RESULTS を更新(**Swiftディスパッチ表との一致テストが落ちるので06も同PRで**)。
3. `macos.ts` の `MacosDesktopAdapter` にメソッド追加 → RPC呼び出し。
4. Swift側(06)に dispatch を実装。

### 新しいプロバイダ(layer)を追加したい
1. エンジン `types.ts` の `ProviderBag` に `kind` ハンドルを追加、`registry.ts` の `HandlerLayer` にレイヤ名を追加(該当する場合)。
2. 新パッケージ `packages/<name>-provider` を作り、`kind` を持つ具象クラス + `registerXHandlers` を実装(既存パッケージのファイル構成・命名に合わせる)。
3. `apps/hermes/src/main/run-controller.ts` と `packages/cli/src/run-flow.ts` の登録ブロックに `needsX` ガード付きで足す。

---

## 6. 不変条件・落とし穴(08-glossaryに載せる候補)

- **座標は常にスクリーン絶対・左上原点・論理ポイント**(物理ピクセルではない)。mouse.*/elementAtPoint/screen region すべて共通。Windowsサイドカーも SendInput の 0..65535 空間をこれに正規化する義務がある。
- **キー名は論理・大小無視の名前**。OS仮想キーコード禁止。`primary`=Cmd(mac)/Ctrl(Win)。許容トークンは `MODIFIER_NAMES`/`KEY_NAMES`(`rpc-contract.ts`)で、`Input.swift` とロックステップ。
- **RPC契約 = TS↔Swift の単一の真実**。メソッド集合は `rpc-contract.test.ts` がSwiftディスパッチ表との完全一致を強制。片側だけ変えるとテストが落ちる。
- **web の `<select>` は click ではなく `type{control:'select'}` で記録・再生**する(ネイティブoption listはクリック再生不能)。checkbox/radio の `change` はドロップし click がトグルを担う。
- **secret はIRに平文で残らない**。記録時に `${secrets.<name>}` 参照へ置換(`buildInputStep`)。
- **デスクトップステップは現状 coords セレクタ必須**(AX/image/ocrでの `findElement` は未実装で throw)。screen層は image/ocr/coords を解決できる(別経路)。
- **ヒューマナイズのステップ境界が web と desktop で違う**: web=`minSteps:8/maxSteps:60`、desktop=`minSteps:16/maxSteps:1200`。`ctx.vars.__hermes_humanize__` が無いとこの既定が効く。
- **excel-provider はファイルベースでテスト有効**(Excelアプリ操作の「Win保留」とは別物)。書き込みは即flush、Phase1にsaveステップ無し。
- **WebProvider はCDPアタッチではなく `launchPersistentContext`**。プロファイルがフローごとに永続。
- **アンチ検出は低コストシグナルのみ**。挙動スコアリング/IP評判は防げない(過信禁物)。
- ハンドラのエラーは `class` 文字列を持たせる(`selector_not_found`/`timeout`/`permission`/`sidecar`/`unknown`)。エンジンのリトライ判定がこれを見る。
- **SidecarClient はサイドカーをspawnしない**。spawnは apps/hermes Mainの責務。クライアントは既知ソケットに接続するだけ。

---

## 7. 【未確認】点

- `ClickOpts.modifiers`(`index.ts`)は型に存在するが、`MacosDesktopAdapter.click` も desktop ハンドラの `buildClickOpts` も**読んでいない**。修飾子付きクリックは未配線の可能性が高い(コードに使用箇所が見当たらない)。【推測・根拠: macos.ts/handlers.ts に `modifiers` 参照なし】
- `TypeOpts.paste`/`TypeOpts.secret`(`index.ts`)も型のみで、`MacosDesktopAdapter.type` は参照していない(`clearFirst`/`intervalMs` のみ使用)。IME/多バイト用のpaste経路は未実装。【推測・根拠: macos.ts の type 実装に paste 分岐なし】
- `WebProvider.click` の humanized 経路で `setLastMousePos` 後の `__hermesLastMousePos` がページ遷移後に再シードされる挙動は initスクリプト依存。遷移直後の最初のクリックはビューポート中央起点になる(`getLastMousePos` のフォールバック)。実害の有無は【未確認】。
- desktop の `wait_for kind=desktop.screen_stable` のバイト厳密比較は、ScreenCaptureKit/CGWindowList出力が真にidleなら frame間でバイト同一という前提に立つ(コメント記載)。実機での安定性は【未確認】(handlers.tsコメントの主張をそのまま採用)。
