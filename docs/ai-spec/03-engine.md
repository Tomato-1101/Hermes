# 03. 実行エンジン / executor・評価器
> 最終更新: 2026-05-31 ／ 対象コミット: b3d5fa6 (feat/phase-1-completion)
> AI用仕様書。コードを読む前にまずこれを読む。該当コードを変更したら同じPRでこのファイルも更新すること。

関連: [README](./README.md) ／ [01 アーキ](./01-architecture.md) ／ [02 IRスキーマ](./02-ir-schema.md) ／ **03 エンジン(本書)** ／ [04 アダプタ](./04-adapters.md) ／ [05 Electronアプリ](./05-app-electron.md) ／ [06 macOSサイドカー](./06-sidecar-macos.md) ／ [07 ストレージ/Vault](./07-storage-vault.md) ／ [08 用語集](./08-glossary.md)

---

## 0. このパッケージの位置づけ（要約）

`packages/engine` は **Flow IR（[02](./02-ir-schema.md)で定義）を受け取り、ステップ配列を上から走査して実行するインタプリタ**である。エンジン自身は「クリックする」「タイプする」といった具体的な副作用を**一切持たない**。すべての実体ある操作は `HandlerRegistry` に登録された `StepHandler` 経由でアダプタ（[04](./04-adapters.md)）に委譲する。

エンジンが**自前で完結して処理する**のは次の「構造的ステップ」と一部の特殊ステップだけ:
- 制御構造: `if` / `loop` / `try`
- 待機の一部: `wait_for`（`kind=time` と `kind=expr` のみ。それ以外はハンドラへ委譲）
- ログ: `log`
- 手動チェックポイント: `manual_pause`（Phase-1ではログ出力して自動継続）

それ以外の全 `StepType`（`click` / `type` / `open_url` / `excel_*` / `screenshot` など）は `registry.get(type, layer)` で引いたハンドラに渡す。**ハンドラが無ければ実行時エラーで落ちる**（握り潰さない）。

対象ファイル（`packages/engine/src/`）:
- `executor.ts` — 本体。`StepExecutor` クラス、実行ループ、ディスパッチ、評価器ラッパ、タイムアウト。
- `registry.ts` — `HandlerRegistry`。layer 付きハンドラ表。
- `retry.ts` — `nextDelayMs` / `shouldRetry` / `sleep`。
- `types.ts` — `RunContext` / `RunEvent` / `StepHandler` / `ProviderBag` / `RunOptions` 他。
- `index.ts` — 公開バレル。
- `test/executor.test.ts` / `test/registry.test.ts` — 契約テスト。

評価器・補間そのものは **このパッケージではなく `@hermes/ir`** にある（`packages/ir/src/expr.ts`, `packages/ir/src/interpolate.ts`）。エンジンはそれを import して使う。詳細は本書 §6。

---

## 1. 公開API（`packages/engine/src/index.ts` がエクスポートするもの）

```ts
export { StepExecutor, type SecretsMap } from './executor.js';
export { HandlerRegistry, type HandlerLayer } from './registry.js';
export { nextDelayMs, shouldRetry, sleep } from './retry.js';
export {
  HermesAbortError,
  type AiServiceHandle, type DesktopProviderHandle, type ExcelProviderHandle,
  type ProviderBag, type RunContext, type RunEvent, type RunOptions,
  type StepHandler, type StepResult, type StepStatus, type WebProviderHandle,
} from './types.js';
```

### 1.1 `StepExecutor`（`executor.ts`）

エンジンの中心。1 つの Flow を 1 回実行する役割。

コンストラクタ:
```ts
constructor(opts: {
  registry: HandlerRegistry;
  providers?: ProviderBag;
  /** Pre-resolved secret values for `${secrets.<name>}` substitution. */
  secrets?: SecretsMap;
})
```
- `registry` 必須。`providers` 省略時は `{}`、`secrets` 省略時は `{}`。
- `SecretsMap = Record<string, string | undefined>`。**シークレットの解決済み平文**を呼び出し側（apps/hermes）が事前に詰める。エンジンは Vault/keytar を一切触らない（`${secrets.<name>}` を置換するだけ）。[07](./07-storage-vault.md) 参照。

メソッド:
```ts
on(listener: (e: RunEvent) => void): () => void
```
- 実行イベント購読。戻り値は購読解除関数。内部は `mitt` の単一イベント名 `'event'` に集約。

```ts
async run(flow: Flow, options: RunOptions = {}): Promise<'success' | 'failure' | 'aborted'>
```
- **入力**: `Flow`（[02](./02-ir-schema.md)）と `RunOptions`。
- **出力**: `'success' | 'failure' | 'aborted'` の文字列のみ（throw しない。内部 try/catch で吸収する）。
- **副作用**: ハンドラ経由のブラウザ/デスクトップ/Excel 操作、`RunEvent` の発火、`ctx.vars` の書き換え。
- 1 インスタンスを複数回 `run()` してよいかは設計上不明確。`apps/hermes` は run ごとに `new StepExecutor` する（`run-controller.ts:500`）。【未確認】再利用安全性は保証されていない。

`RunOptions`（`types.ts`）:
```ts
export interface RunOptions {
  /** Stop after each Step, awaiting `engine.resume()`. */
  mode?: 'run' | 'step';
  signal?: AbortSignal;
  /** Initial variable bindings. */
  inputs?: Record<string, unknown>;
}
```
- 【未確認 / 重要な落とし穴】`mode` と `resume()` は **型に宣言があるだけで executor.ts に実装が無い**。`run()` 本体は `options.mode` を参照せず、`resume()` メソッドも存在しない。ステップ単位の一時停止/再開は現状未実装。`manual_pause` も Phase-1 はログ出力して即継続（§4.4）。
- `signal` 省略時は `new AbortController().signal`（= abort されない使い捨て signal）。
- `inputs` は初期変数バインディング（§3 参照）。

### 1.2 `HandlerRegistry`（`registry.ts`）

```ts
export type HandlerLayer = 'web' | 'desktop' | 'screen' | 'default';

register(handler: StepHandler, layer: HandlerLayer = 'default'): void
get(type: StepType, layer?: HandlerLayer | string): StepHandler | undefined
has(type: StepType, layer?: HandlerLayer): boolean
list(): readonly StepType[]
```
- 内部キーは `` `${layer}::${handler.type}` ``。
- `register`: 同一 layer に同一 type を二重登録すると **throw**（`... already registered.`）。異なる layer なら同じ type を共存可。
- `get`: `layer` が指定かつ `'default'` 以外なら**まず layer 付きを引き、無ければ `default::` にフォールバック**する。これにより layer を意識せず登録した既存ハンドラがそのまま動く（§5 のディスパッチで多用）。
- `list`: キー `layer::type` から type 部分だけ返す（重複排除なし）。

### 1.3 `retry.ts`

```ts
export function nextDelayMs(policy: RetryPolicy, attemptIndex: number): number
export function shouldRetry(policy: RetryPolicy | undefined, errorClass: string | undefined): boolean
export async function sleep(ms: number, signal?: AbortSignal): Promise<void>
```
詳細な意味は §7（リトライ）。`sleep` は abort 連動の中断可能 sleep で、エンジン全体の待機（ステップ間 pad / wait_for / リトライ間隔）に使われる。`ms <= 0` なら即 resolve。abort 時は `reject(new Error('aborted'))`（`HermesAbortError` ではない素の Error。`run()` 側で `message === 'aborted'` を見て aborted 判定する → §2）。

### 1.4 `types.ts` の主要型

```ts
export interface RunContext {
  flow: Flow;
  vars: Record<string, unknown>;     // 実行中の変数スコープ（書き換え可能）
  inputs: Record<string, unknown>;   // run() に渡された inputs のコピー
  outputs: Record<string, unknown>;  // ${ctx.*} / 式の ctx ルートが指す先（現状エンジンは書かない）
  signal: AbortSignal;
  emit(event: RunEvent): void;
  providers: ProviderBag;
}

export interface ProviderBag {
  web?: WebProviderHandle;
  desktop?: DesktopProviderHandle;
  excel?: ExcelProviderHandle;
  ai?: AiServiceHandle;
}

export interface StepHandler<P = Record<string, unknown>> {
  type: StepType;
  execute(step: Step, ctx: RunContext): Promise<StepResult<P>>;
}

export interface StepResult<P = unknown> {
  outcome: StepStatus;   // 'started' | 'completed' | 'failed' | 'skipped' | 'paused'
  data?: P;
}

export class HermesAbortError extends Error { /* name='HermesAbortError' */ }
```
- `ProviderBag` の各 `*Handle` は `readonly kind: '...'` だけを持つ **opaque な型**。実体プロバイダ（PlaywrightWebProvider 等）は別パッケージ（[04](./04-adapters.md)）にあり、ハンドラが `ctx.providers.web` を自分でキャストして使う。エンジンは providers の中身を触らない。
- `StepStatus` に `'started'`/`'paused'` があるが、現状エンジンが `step:end` で発火するのは `'completed'`/`'failed'`/`'skipped'` のみ（§8）。

---

## 2. 実行ループ全体像（`run()` → `runSteps()` → `runStep()` → `executeOnce()`）

`run()`（`executor.ts:56`）の流れ:
1. `signal` を確定（未指定なら使い捨て）。
2. `RunContext` を構築。`vars` は `initialVars(flow, inputs)` で初期化（§3）。`outputs={}`。`emit` は mitt 発火。
3. `ctx.emit({ type: 'run:start', flowId })`。
4. `await this.runSteps(flow.steps, ctx, 'steps')` をトップレベルで呼ぶ（cursorPrefix は `'steps'`）。
5. 例外なく終われば `run:end (outcome:'success')` を発火し `'success'` を返す。
6. catch した場合: `e instanceof HermesAbortError || (e as Error).message === 'aborted'` なら `'aborted'`、それ以外は `'failure'`。`run:end` をその outcome で発火。failure のときだけ追加で `log(level:'error')` を出す。

`runSteps(steps, ctx, cursorPrefix)`（`:98`）:
- `padMs = max(0, flow.defaults.waitBetweenStepsMs ?? 0)`。
- `for i in steps`: `step.enabled === false` のステップは **continue でスキップ**（イベントも出ない）。
- ステップ間 padding は「**実行された**ステップ同士の間にだけ」入る。先頭の前・無効ステップ直後には入れない（`firstRan` フラグで制御）。先頭が全部無効でも無駄に sleep しない。
- 各反復で `assertNotAborted(ctx)`（abort 済みなら `HermesAbortError` を throw）→ `runStep(step, ctx, `${cursorPrefix}[${i}]`)`。
- **cursor の形式**: `steps[0]`, `steps[1].children[2]`, `steps[3].branches[0].steps[0]` のようなパス文字列。ネストごとに §4 の各 executor がプレフィックスを付け足す。これは UI のハイライト（§8 activeStep）やログ表示に使う安定 ID。

`runStep(step, ctx, cursor)`（`:114`）= **リトライ + onError の層**。詳細 §7。
`executeOnce(step, ctx, cursor)`（`:152`）= **補間 + ディスパッチの層**。詳細 §5。

---

## 3. 変数スコープと初期化（`initialVars`, `ctx.vars`）

`initialVars(flow, inputs)`（`:89`）:
1. `flow.variables`（`VarDecl[]`）を走査し、`decl.defaultValue !== undefined` のものを `vars[decl.name]` に入れる。
2. その後 `inputs` を `Object.assign` で上書き（inputs が defaultValue より優先）。

実行中の変数アクセス:
- 式評価（`if`/`while`/`wait_for expr`）では `var.x` で `ctx.vars` を、`ctx.x` で `ctx.outputs` を参照（§6）。
- 文字列補間（params 内 `${var.x}` 等）も同じ `ctx.vars` / `ctx.outputs`（§5.1）。
- `loop forEach` は反復ごとに `ctx.vars[asVar] = items[i]` を**直接書き込む**（ループ後も残る。スコープは関数ローカルではない）。
- `try` の `catch` 突入時、`ctx.vars['__error__'] = (error).message` を書き込む（§4.5）。catch 内ステップから `${var.__error__}` で参照可能。
- 【落とし穴】変数スコープはフラットでブロックローカルが無い。`forEach` の `asVar` や `__error__` がグローバルに残るので名前衝突に注意。

---

## 4. 構造的ステップの実行時挙動

`executeOnce` の `switch (resolved.type)` で分岐（補間後のステップ `resolved` を使う）。`if`/`loop`/`try` は子ステップ実行に **再び `runSteps` を再帰呼び出し**するので、ステップ間 padding・abort チェック・enabled スキップ・リトライ等がネスト内でも同様に効く。

### 4.1 `if`（`executeIf`, `:286`）
- `passed = evalCondition(step.params?.['condition'], ctx)`（§6.1）。
- `passed === true`: `step.branches[0].steps` を実行（cursor 末尾 `.branches[0].steps`）。`branches` が空/未定義なら何もしない。
- `passed === false`: `step.children` があればそれを **else 節**として実行（cursor 末尾 `.children`）。
- 【設計メモ】**then は `branches[0].steps`、else は `step.children`** という非対称な置き方。branch 名（"then" 等）は if では見ておらず、添字 0 固定。Editor 側がこの配置で書き込む前提。
- 戻り値は常に `{ outcome: 'completed' }`（条件不成立でも completed）。

### 4.2 `loop`（`executeLoop`, `:301`）
`kind = step.params?.['kind'] ?? 'for'`。子は `step.children`。
- `kind='for'`: `count = Number(params.count ?? 0)`。`for i in 0..count` 各回 `assertNotAborted` → `runSteps(children, cursor.children[i])`。
- `kind='forEach'`: `items = params.items`（配列リテラル or `${var.x}` 補間後の実配列）。配列でなければ throw。`asVar = params.asVar ?? 'item'`。各回 `ctx.vars[asVar] = items[i]` してから子実行。
- `kind='while'`: `condition = params.condition`、`maxIter = Number(params.maxIterations ?? 1000)`。`while (evalCondition(condition))` ループ。**反復数が `maxIter` 以上になると throw**（無限ループ防止。`exceeded maxIterations`）。各回 `assertNotAborted`。
- 上記以外の kind は `Unsupported loop kind "..."` で throw。
- 戻り値 `{ outcome: 'completed' }`。

### 4.3 `try`（`executeTry`, `:341`）
- 子 = `step.children`、分岐 = `step.branches`。
- `catchBranch = branches.find(b => b.name === 'catch')`、`finallyBranch = branches.find(b => b.name === 'finally')`（**名前で探す**。if と違い添字ではない）。
- `try { runSteps(children, cursor.children) } catch(e) { ... } finally { ... }`。
  - catch 時: `catchBranch` があれば `ctx.vars['__error__'] = e.message` して `runSteps(catchBranch.steps, cursor.catch)`。無ければ `throw e`（= try で握らず上へ）。
  - finally: `finallyBranch` があれば `runSteps(finallyBranch.steps, cursor.finally)`。
- 戻り値 `{ outcome: 'completed' }`。
- 【注意】catch 自体や finally 内ステップが投げた場合は通常の JS try/finally 意味論で上へ伝播する。

### 4.4 `log`（`executeOnce` 内 inline, `:165`）
- ハンドラを介さずエンジンが直接 `ctx.emit({ type:'log', level, message })`。
- `level = params.level ?? 'info'`、`message = String(params.message ?? '')`。
- params は補間済みなので `${var.x}` が展開された文字列が出る（テスト `interpolates variables inside a log step message` が保証）。

### 4.5 `manual_pause`（`executeOnce` 内 inline, `:172`）
- Phase-1 のヘッドレス/CLI 実行には resume チャネルが無いため、**`log(level:'warn')` を出して即 `completed` で継続**（throw しない）。
- メッセージ: `` `manual_pause: ${params.message ?? '(no message)'}（フェーズ1のヘッドレス実行では自動継続）` ``。
- 【未実装】対話的な一時停止/再開は UI 作業と一緒に来る予定（コメント `:177`）。

---

## 5. 通常ステップのディスパッチとターゲット解決の委譲

### 5.1 補間（`resolveStep`, `:373`）— 全ステップ共通の前処理
`executeOnce` の冒頭で **必ず**呼ばれる（構造ステップ含む全 type）。
```ts
private resolveStep(step: Step, ctx: RunContext): Step
```
- `step.params` が無ければ step をそのまま返す。
- あれば `interpolateParams(step.params, interpCtx)`（`@hermes/ir`）で `${var.*}` `${env.*}` `${secrets.*}` `${ctx.*}` を再帰的に置換した **新しい params を持つ浅いコピー** `{ ...step, params }` を返す。**元の Flow は不変**（解決済みシークレットをディスクに書き戻さないため）。
- `interpCtx = { var: ctx.vars, env: process.env, secrets: this.secrets, ctx: ctx.outputs }`。
- 補間は `if` の condition、`loop` の count/items、`log` の message にも効く（コメント `:153`）。

### 5.2 ハンドラ解決（`executeOnce` の default 分岐, `:186`）
```ts
const handler = this.registry.get(resolved.type, resolved.target?.layer);
if (!handler) throw new Error(`No handler registered for step type "${resolved.type}"${layerSuffix}`);
const promise = handler.execute(resolved, ctx);
return await withTimeout(promise, resolved.timeoutMs ?? ctx.flow.defaults.timeoutMs, ctx.signal);
```
- **layer 選択**: `resolved.target?.layer`（`'web' | 'desktop' | 'screen'`、[02](./02-ir-schema.md) の `TargetRef.layer`）を `registry.get` に渡す。layer 付きハンドラ優先、無ければ default にフォールバック（§1.2）。これが「web の click と desktop の click を別ハンドラに振り分ける」核。
- **ターゲット（セレクタ候補列）の解決はエンジンが行わない**。`handler.execute(resolved, ctx)` の中で、ハンドラが `resolved.target.candidates` を見て `ctx.providers.web/desktop/screen` を使い実解決する（[04](./04-adapters.md)）。エンジンは「どの layer のハンドラに渡すか」だけを決める。
- ハンドラ未登録は **throw**（握り潰さない）。layer 指定があればメッセージに付く。
- タイムアウトは `resolved.timeoutMs ?? flow.defaults.timeoutMs`（§7.3）。

### 5.3 アプリ側の実際の配線（参考: `apps/hermes/src/main/run-controller.ts:454`〜）
エンジン外だが理解に必須。run ごとに新規 `HandlerRegistry` を作り、必要な layer のハンドラ群を条件付き登録する:
```
registerWebHandlers(registry);
if (this.desktop) registerDesktopHandlers(registry);
if (this.desktop && needsScreen) registerScreenHandlers(registry);
if (this.desktop && needsClipboard) registerClipboardHandlers(registry);
if (this.excel && needsExcel) registerExcelHandlers(registry);
```
そして `new StepExecutor({ registry, providers, secrets })`。`secrets` は `collectSecretRefsInFlow(flow)` で集めた名前を Vault から事前取得（[07](./07-storage-vault.md)）。`humanize` 設定や assets ディレクトリは `seededInputs` 経由で `ctx.vars.__hermes_humanize__` / `__hermes_assets_dir__` として注入され、ハンドラが拾う。`executor.run(flow, { signal, inputs: seededInputs })` を await せず投げ、`RunEvent` を IPC に転送する（§8）。

---

## 6. 式評価（評価器）と補間 — 実体は `@hermes/ir`

エンジンは評価ロジックを**持たず** `@hermes/ir` の 2 系統を使い分ける:
- **jsep 評価器** `evaluateExpr`（`packages/ir/src/expr.ts`）— boolean/制御フロー条件用。
- **文字列補間** `interpolate` / `interpolateParams`（`packages/ir/src/interpolate.ts`）— params の `${...}` 用（§5.1）。

両者の使い分けは意図的: 補間は**ドットパスのみ**（演算子・関数なし）、jsep は式全体（演算子・whitelist 関数）。

### 6.1 `evalCondition`（`executor.ts:262`）— エンジン側の薄いラッパ
`if` / `loop while` / `wait_for expr` の条件はすべてこの 1 メソッドを通る。
```ts
private evalCondition(condition: unknown, ctx: RunContext): boolean
```
評価順:
1. `undefined`/`null` → `false`。`boolean` → そのまま。`number` → `!== 0`。`string` 以外の truthy → `Boolean(condition)`。
2. `string` を `trim`。空文字 → `false`。
3. `evaluateExpr(trimmed, exprCtx)` を呼び、結果を `Boolean(...)`。
   - `exprCtx = { var: ctx.vars, env: process.env, secrets: {}, ctx: ctx.outputs }`。**条件式では `secrets` は常に空オブジェクト**（条件に平文シークレットを使わせない設計）。
4. throw された場合: `ExprError`（=構文として不正な式）なら **`Boolean(trimmed)` にフォールバック**（非エンジニアが `"yes"` と書いても truthy になる）。`ExprError` 以外（評価中の実行時エラー）は re-throw。

### 6.2 `evaluateExpr` / jsep（`packages/ir/src/expr.ts`）の許容範囲
`eval`/`Function` を使わず jsep の AST を allow-list で walk する。

```ts
export function evaluateExpr(source: string | { __ast: unknown }, context: ExprContext): unknown
export function parseExpr(source: string): unknown
export class ExprError extends Error
export interface ExprContext {
  var?: Record<string, unknown>;
  env?: Record<string, string | undefined>;
  secrets?: Record<string, string | undefined>;
  ctx?: Record<string, unknown>;
  locals?: Record<string, unknown>;   // forEach の item 等の自由変数
}
```
許容ノード/演算子（コメント & `walk` 実装より）:
- リテラル: number / string / boolean / null。
- 識別子ルート: `var` `env` `secrets` `ctx` の 4 つだけ（`ALLOWED_ROOTS`）。未知ルートは `ExprError`。`locals` に存在する名前は自由変数として解決（エンジンの `evalCondition` は `locals` を渡していない点に注意）。
- メンバアクセス `a.b` / `a["b"]`。`__proto__`/`constructor`/`prototype`/`toString`/`valueOf` へのアクセスは **禁止**（`ExprError`）。
- 二項: `+ - * / % === !== == != > >= < <= & | ^`。`+` は片方が string なら文字列連結。`& | ^` は `>>> 0` で符号なし化。
- 論理: `&& || ??`（短絡評価あり。`??` は jsep に `addBinaryOp('??', 1)` で追加登録）。
- 単項: `+ - ! typeof`。
- 三項 `? :`、配列リテラル `[...]`。
- 関数: **whitelist のみ** `ALLOWED_FUNCTIONS`: `contains, startsWith, endsWith, length, lower, upper, trim, regexTest, min, max, abs, round, floor, ceil, not, and, or`。トップレベル識別子呼び出しのみ（`a.b()` は不可）。未知関数は `ExprError`。
- それ以外（代入/new/throw 等）は `unsupported node type` で `ExprError`。

### 6.3 `interpolate` / `interpolateParams`（`packages/ir/src/interpolate.ts`）
- `${root.path.to.value}` 形式のみ。root は `var|env|secrets|ctx` の 4 つ。
- **未知 root はプレースホルダをそのまま残す**（`${foo.bar}` → `${foo.bar}`）。「secret 参照が壊れた」と「secret 未設定」を区別できるように。
- 既知 root だが値が `undefined`/`null` → **空文字列**に置換（エラーは出さない）。
- 解決値は `String(cur)` で文字列化。`interpolateParams` は params を**ディープクローン**しつつ全 string 値を補間（配列/ネストオブジェクトも再帰）。
- `collectSecretRefs(params)` は `${secrets.<name>}` の name 一覧を返す（apps/hermes がプリフェッチに使う、§5.3）。

---

## 7. リトライ・onError・タイムアウト（`runStep` と `retry.ts`）

`runStep`（`executor.ts:114`）の構造:

### 7.1 リトライループ
- `policy = step.retry ?? ctx.flow.defaults.retry`。`attempts = max(1, policy.attempts)`。
- `for attempt in 0..attempts`: `executeOnce` を試す。
  - 成功 → `step:end (outcome: result.outcome)` を発火して return。
  - 失敗 → `errorClass = (e as {class?}).class` を読む。`canRetry = attempt < attempts-1 && shouldRetry(policy, errorClass)`。
    - retry する場合: `delay = nextDelayMs(policy, attempt)`、`log(warn)` を出して `await sleep(delay, signal)`、次の attempt へ。
    - しない場合: break。
- 【重要】`step.retry`/`defaults.retry` は **必ず存在する前提**（`RetryPolicy` は `FlowDefaults.retry` で必須。`retry: { attempts: 1 }` が最小）。

### 7.2 `shouldRetry` / `nextDelayMs`（`retry.ts`）
- `shouldRetry(policy, errorClass)`:
  - `policy` 無し → `false`。
  - `retryOn` 無し/空 → `true`（**既定で全エラー再試行**）。
  - `retryOn` に `'any'` 含む → `true`。
  - `errorClass` が無い → `false`。
  - `retryOn` に `errorClass` が含まれれば `true`。
  - `errorClass` は `'selector_not_found' | 'timeout' | 'network' | 'any'`（[02](./02-ir-schema.md) `RetryPolicy.retryOn`）。エンジンが自前で `class:'timeout'` を付ける箇所が 2 つある: タイムアウト（§7.3）と `wait_for expr` タイムアウト（§7.4）。
- `nextDelayMs(policy, attemptIndex)`:
  - `backoff` 無し → `0`。
  - `kind='fixed'` → `initialMs`。
  - `kind='exponential'` → `initialMs * factor^attemptIndex`（`factor` 既定 2）、`maxMs`（既定 Infinity）で上限クリップ。
- 【未実装】`RetryPolicy.betweenAttempts`（再試行間に実行するステップ群、[02](./02-ir-schema.md)）は **executor で参照されていない**。スキーマにあるが現状無視。

### 7.3 onError（リトライ全敗後, `:141`）
- `policyOnError = step.onError ?? 'fail'`（`OnErrorPolicy = 'fail' | 'continue' | 'retry' | { goto: string }`）。
- `'continue'`: `step:end (outcome:'skipped', error: lastError.message)` を発火して return（**ラン全体は続行**。テスト `honors onError = "continue"` が保証）。
- それ以外（`'fail'` 含む）: `step:end (outcome:'failed', error)` を発火し `throw lastError`（上へ伝播 → 最終的に `run()` が catch して `'failure'`）。
- 【未実装/落とし穴】`onError = 'retry'` と `{ goto: string }` は **専用処理が無い**。`'continue'` 以外は全部 fail 扱いになる。`'retry'` を期待しても実行時はリトライ追加されず即 fail する。

### 7.4 タイムアウト（`withTimeout`, `executor.ts:385`）
```ts
function withTimeout<T>(promise: Promise<T>, ms: number, signal: AbortSignal): Promise<T>
```
- `ms <= 0`（falsy）なら **タイムアウト無効**で promise をそのまま返す。
- そうでなければ `setTimeout` でレースし、超過時 `reject(new Error(... timed out after Nms, { class: 'timeout' }))`。abort 時は `reject(new HermesAbortError())`。決着後はタイマと abort リスナを cleanup。
- 通常ステップは `step.timeoutMs ?? flow.defaults.timeoutMs` で包む（§5.2）。`wait_for` の非エンジン処理ぶんは `executeWaitFor` 内で別途 `withTimeout`（§7.5）。
- 【注意】タイムアウトはハンドラの promise をレースするだけで、ハンドラ内の処理を強制中断はしない（ハンドラが signal を見るかどうか次第）。

### 7.5 abort（`HermesAbortError` / `sleep` の 'aborted'）
- `assertNotAborted` は `signal.aborted` 時に `HermesAbortError` を throw。`runSteps` の各ステップ前、`loop`/`wait_for` の各反復で呼ぶ。
- `sleep`（§1.3）と `withTimeout` は signal 連動で即 reject。`sleep` は素の `Error('aborted')`、`withTimeout` は `HermesAbortError`。`run()` はどちらも aborted と判定（`message === 'aborted'` も拾う、`:75`）。
- テスト `aborts immediately on AbortSignal` が `'aborted'` を保証。

---

## 8. 実行イベント（`RunEvent`）と activeStep 通知

`RunEvent` 定義（`types.ts:44`）:
```ts
export type RunEvent =
  | { type: 'run:start'; flowId: string }
  | { type: 'run:end'; flowId: string; outcome: 'success' | 'failure' | 'aborted' }
  | { type: 'step:start'; cursor: string; step: Step }
  | { type: 'step:end'; cursor: string; step: Step; outcome: StepStatus; error?: string }
  | { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string; data?: unknown }
  | { type: 'screenshot'; cursor: string; assetRef: string };
```
発火箇所まとめ:
- `run:start` — `run()` 開始時（`:68`）。
- `run:end` — `run()` 終了時、成否いずれも（`:72`/`:77`）。
- `step:start` — `runStep` 冒頭（`:115`）。`step` 全体と `cursor` を載せる。
- `step:end` — `runStep` で 1 ステップが決着したとき。`outcome` は `'completed'`（成功）/ `'skipped'`（onError=continue）/ `'failed'`（fail）。`error?` は失敗時のみ。**`'started'`/`'paused'` は現状発火しない**。
- `log` — `log` ステップ、`manual_pause`、リトライ警告、run failure 時のエラー、各種ハンドラ（ハンドラが `ctx.emit` する）。
- `screenshot` — **エンジンコアからは発火しない**。web の `screenshot` ハンドラが `ctx.emit({ type:'screenshot', cursor: step.id, assetRef })` で出す（`packages/web-provider/src/handlers.ts:174`、[04](./04-adapters.md)）。

**activeStep 通知の流れ**（エンジン → UI、[05](./05-app-electron.md)）:
1. エンジンが `step:start { cursor, step }` を発火。
2. `run-controller.ts:513` がそれを IPC イベント `run:step { cursor, stepId: step.id, phase:'start' }` に変換して renderer へ送る（`step:end` は `phase:'end', outcome, error?`）。
3. renderer `App.tsx:68` が `phase==='start'` で `store.setActiveStep(stepId)` を呼ぶ。`store.ts` の `activeStepId` が更新され、`Timeline.tsx` が `activeStepId === step.id` の行をハイライト。
4. `phase==='end'` かつ `outcome !== 'completed'` のときログに警告を積む。`run:end` で `activeStepId` を null に戻す。
- つまり **エンジンの安定 cursor + step.id が UI ハイライトの ID** になる。cursor の付け方を変えると UI/ログ表示に波及する。

---

## 9. `wait_for` の詳細（`executeWaitFor`, `:206`）

`wait_for` は `executeOnce` で専用分岐される（通常ハンドラに丸投げしない）。
- `params.kind`（`WaitForKind`、[02](./02-ir-schema.md) §`WAIT_FOR_KINDS`）で分岐。`kind` 未指定の旧フローは `inferWaitForKind`（§9.1）で推定。
- 共通パラメータ:
  - `timeoutMs = Number(params.timeoutMs ?? step.timeoutMs ?? flow.defaults.timeoutMs)`。
  - `pollIntervalMs = max(10, Number(params.pollIntervalMs ?? 100))`（**既定 100ms、下限 10ms**）。

分岐:
- `kind='time'`: `ms = Number(params.ms ?? params.timeoutMs ?? 0)` 分 `sleep` して `completed`（固定待機。`wait` と同形）。テスト `wait_for kind=time` が保証。
- `kind='expr'`: `deadline = now + max(0, timeoutMs)`。`while (now < deadline)`: `assertNotAborted` → `evalCondition(params.expr)` が truthy なら `completed`、でなければ `sleep(pollIntervalMs)`。期限切れで `throw Error('wait_for expr timed out after Nms', { class:'timeout' })`（→ §7.2 で `timeout` クラス retry 対象）。テスト 2 本（truthy/timeout）が保証。
- それ以外（`web.*` / `desktop.*`）: layer を導出（`web.` 始まり→`'web'`、`desktop.` 始まり→`'desktop'`、それ以外は `step.target?.layer`）し、`registry.get('wait_for', layer)` で **layer 別ハンドラへ委譲**。ハンドラ無しは throw。`withTimeout(promise, timeoutMs, signal)` で包む。
- 【ポイント】`time`/`expr` を**エンジン内で完結**させるのは、web/desktop プロバイダが無い CLI/ヘッドレス環境でも純粋待機が動くようにするため（コメント `:198`）。

### 9.1 `inferWaitForKind`（旧フロー互換, `:246`）
`params.kind` が無い古い `wait_for` の解釈:
- `params.expr` が string → `'expr'`。
- `params.url` が string かつ `step.target===undefined` → `'web.url'`。
- `step.target?.layer==='desktop'` → `'desktop.element'`。
- `step.target` がある → `'web.element'`。
- どれでもない → `'time'`。

---

## 10. テストが保証している契約（`test/executor.test.ts`, `test/registry.test.ts`）

executor.test.ts（要点）:
- 登録済みステップを 1 回完走、`step:start`/`step:end` 各 1 回。
- `manual_pause` は **ハンドラ無しでも** log を出して `completed`、ラン `success`（回帰テスト）。
- リトライ: `retry.attempts=3, backoff fixed 0ms` で 3 回目に成功 → `success`、`tries===3`。
- リトライ全敗 → `failure`。
- `enabled:false` のステップは実行されない。
- `onError:'continue'` で失敗ステップを飛ばし後続が走る、ラン `success`。
- abort: 待機中ステップを `controller.abort()` → `'aborted'`。
- `loop for count=5` → 子が 5 回。
- `${var.x}`/`${secrets.x}` 補間: `inputs.greeting='hi'` + `secrets.token='s3cret'` → params が `{ text:'hi s3cret' }`。
- `if`: `var.score>50` で then / else 分岐（then は `branches[0].steps`、else は `children`）。
- `loop while`: 開始時から condition false なら 0 回。
- `log` メッセージ内 `${var.name}` が補間される。
- `try`: 子が throw → catch ブランチ（name='catch'）実行、ラン `success`。
- `waitBetweenStepsMs=60`: 先頭前には sleep 無し、ステップ間に約 60ms。
- `wait_for time`/`expr`（成功/タイムアウト）。

registry.test.ts:
- default ハンドラは layer 未指定/指定どちらでも引ける（フォールバック）。
- layer 付きは default より優先。
- layer 指定で未登録なら default にフォールバック。
- 同一 layer での重複登録は throw。異 layer は OK。

---

## 11. 変更ガイド（このコードを触るとき）

### 新しい**通常ステップ型**の実行を足す
1. [02](./02-ir-schema.md) `StepType` に type 追加（+ JSON Schema / validate）。
2. **エンジンは原則変更不要**。アダプタ側（[04](./04-adapters.md)）で `StepHandler` を実装し、`registerXxxHandlers` で `registry.register(handler, layer)`。
3. `apps/hermes/src/main/run-controller.ts` の登録ブロック（§5.3）に必要なら条件追加。
4. layer が複数あるなら layer 付きで登録（web/desktop で同 type を共存させる）。

### 新しい**構造的ステップ**（エンジン内処理が要る）を足す
1. `executeOnce`（`executor.ts:158`）の `switch` に case 追加し、`executeXxx` private メソッドを実装。
2. 子ステップを走らせるなら `runSteps(children, ctx, `${cursor}....`)` を呼ぶ（cursor プレフィックス規約 §2 を踏襲、UI ハイライトが効く）。
3. 反復/長時間処理なら各反復で `assertNotAborted(ctx)` を呼ぶ。
4. テストを `executor.test.ts` に追加。

### 新しい**評価関数**を足す
- whitelist 関数なら `packages/ir/src/expr.ts` の `ALLOWED_FUNCTIONS` に追加（純粋関数・副作用なし・引数は `unknown`）。
- 新しい識別子ルート（`var/env/secrets/ctx` 以外）を足すなら `ALLOWED_ROOTS`（expr.ts）と `ROOTS`（interpolate.ts）の両方、加えて `evalCondition`/`resolveStep` が組む `ExprContext`/`InterpolateContext` を更新。エンジン側（executor.ts）の `exprCtx`/`interpCtx` も同期。

### 新しい `wait_for` の **kind** を足す
1. [02](./02-ir-schema.md) `WAIT_FOR_KINDS` に追加。
2. エンジン内完結（純待機/式系）なら `executeWaitFor`（`:206`）に分岐追加。プロバイダ依存なら layer 別ハンドラを `registry.register('wait_for', layer)` 相当で登録し、`executeWaitFor` 末尾の委譲経路（`web.*`/`desktop.*` 導出）に乗るよう kind 名を `web.`/`desktop.` プレフィックスにする。

### イベント/UI 連携を変える
- `RunEvent`（`types.ts`）を変えたら `run-controller.ts` のマッピング（§8）と renderer（`App.tsx`/`store.ts`/`Timeline.tsx`、[05](./05-app-electron.md)）を同 PR で更新。

---

## 12. 既知の落とし穴・不変条件（[08 用語集](./08-glossary.md) にも転記推奨）

- **Node 22 必須**（リポジトリ不変条件）。ビルド/テストは node@22 で。既定の新しい Node では better-sqlite3 等が落ちる（ストレージ層）。
- **エンジンは副作用を持たない**: 実操作は全てハンドラ（[04](./04-adapters.md)）。ターゲット解決もハンドラ。エンジンは layer 振り分けとフロー制御のみ。
- **シークレットは事前解決**: `${secrets.*}` はコンストラクタ `secrets` から置換。条件式（`evalCondition`）では `secrets:{}` 固定で参照不可。
- **`mode:'step'` / `resume()` は未実装**（型のみ）。`manual_pause` は Phase-1 自動継続。
- **`onError:'retry'` と `{goto}` は未実装**。`'continue'` 以外は実質 `'fail'`。
- **`RetryPolicy.betweenAttempts` は未参照**（スキーマにあるが engine が見ない）。
- **`retryOn` 既定は全エラー再試行**（空/未指定なら true）。エラー分類は `error.class`（`'timeout'` 等）。timeout は engine が自前付与。
- **else は `branches[0]` ではなく `step.children`**。if の then は `branches[0].steps`。try の catch/finally は branch 名で探す。命名規約に依存。
- **変数スコープはフラット**。`forEach` の asVar / try の `__error__` がグローバルに残る。
- **cursor 文字列が UI ハイライトと結合**。形式（`steps[i].children[j]` 等）を変えると activeStep/ログ表示に波及。
- **`'started'` / `'paused'` step outcome は engine から発火しない**（型にはある）。`screenshot` イベントは engine コアではなく web ハンドラが発火（[04](./04-adapters.md)）。
- **タイムアウトは強制中断しない**。promise レースのみ。`timeoutMs <= 0` で無効。
- **評価器は jsep allow-list**（`eval` 不使用）。`__proto__` 等のプロパティアクセス禁止、関数は whitelist のみ。

---

## 13. 【未確認】事項
- `StepExecutor` インスタンスの**複数回 `run()` 再利用**が安全か（emitter リスナや内部状態の観点）。apps/hermes は毎回 new するので実運用上は問題化していない。
- `RunContext.outputs`（`${ctx.*}` の参照先）に**誰が書き込むか**。リポジトリ全体を grep しても `outputs[...] = ` の書き込みは engine にもアダプタにも**存在しない**（常に空 `{}`）。`${ctx.*}` / 条件式の `ctx` ルートは現状常に空オブジェクトを引く。将来ハンドラが書く設計余地として用意されているだけと思われる。
