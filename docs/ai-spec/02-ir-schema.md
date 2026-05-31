# 02. IRスキーマ / Flow・Step・TargetRef
> 最終更新: 2026-05-31 ／ 対象コミット: b3d5fa6 (feat/phase-1-completion)
> AI用仕様書。コードを読む前にまずこれを読む。該当コードを変更したら同じPRでこのファイルも更新すること。

関連: [README](./README.md) ／ [01 アーキテクチャ](./01-architecture.md) ／ **02 IRスキーマ(本書)** ／ [03 エンジン](./03-engine.md) ／ [04 アダプタ](./04-adapters.md) ／ [05 Electronアプリ](./05-app-electron.md) ／ [06 macOSサイドカー](./06-sidecar-macos.md) ／ [07 ストレージ・Vault](./07-storage-vault.md) ／ [08 用語集](./08-glossary.md)

---

## 0. この章の対象範囲と読み方

本書は `@hermes/ir`（`packages/ir/`）が定義する **中間表現(IR)** のデータ構造を、実ファイルに基づいて完全に文書化する。IR は「記録 → 編集 → 再生」の全工程で共有される唯一の正であり、`flow.json` としてディスクに永続化される（[07](./07-storage-vault.md)）。

カバーした主要ファイル（すべて `packages/ir/src/`）:

| ファイル | 役割 |
| --- | --- |
| `schema.ts` | TypeScript 型定義の本体（Flow / Step / TargetRef / Selector / Assertion / Expression 等）。**型の正は常にこれ**。 |
| `json-schema.ts` | 上記型に対応する JSON Schema (draft-07)。`flowJsonSchema` をエクスポート。ajv による厳格検証に使う。 |
| `validate.ts` | `validateFlow` / `assertValidFlow`。ajv + ajv-formats で `flowJsonSchema` をコンパイルして検証。 |
| `migrations.ts` | `migrateFlow` とマイグレーション枠組み。現状 v1.0 のみで実マイグレーションは空。 |
| `patch.ts` | `diffFlow` / `applyFlowPatch`（RFC 6902 JSON Patch, `fast-json-patch`）。 |
| `interpolate.ts` | `${var.x}` 等の文字列補間（`interpolate` / `interpolateParams` / `collectSecretRefs`）。 |
| `expr.ts` | jsep ベースの式評価器（`evaluateExpr` / `parseExpr` / `ExprError`）。 |
| `id.ts` | `newId`（ULID 生成）。 |
| `index.ts` | 公開 API の再エクスポート。 |

重要な前提（`schema.ts` 冒頭コメント）:
- すべての Flow / Step / TargetRef は **プレーンな JSON**。`flow.json` として永続化される。
- `schemaVersion` はトップレベル必須（前方互換マイグレーションのため）。
- **秘密情報を IR にインライン化してはならない**。許されるのは `${secrets.foo}` 参照のみ。

**型の二重管理に注意**: TypeScript 型(`schema.ts`)と JSON Schema(`json-schema.ts`)は手動で同期されている。片方だけ変えると検証が型とズレる。**両方を必ず同一 PR で更新すること。**

---

## 1. スキーマ定義方式・バージョニング・デフォルト値

### 1.1 定義方式

- TypeScript の `interface` / 判別共用体(discriminated union)で型を定義（`schema.ts`）。
- ランタイム検証は **ajv (JSON Schema draft-07)**。zod は**使っていない**。`json-schema.ts` の `flowJsonSchema` が唯一のスキーマ。
- `validate.ts` のコンパイル設定:
```ts
const ajv = new Ajv({ allErrors: true, strict: true });
addFormats(ajv);
const validator: ValidateFunction<Flow> = ajv.compile<Flow>(flowJsonSchema);
```
- `strict: true` のため、スキーマ自体の書き方が緩いと**コンパイル時に落ちる**。トップレベルおよびほぼ全 `$defs` で `additionalProperties: false`（後述の例外あり）。
- `validateFlow(data): ValidationResult` は `{ valid, errors }` を返す。`errors` は `{ path, message }` の配列で、`path` は ajv の `instancePath`（空なら `'(root)'`）、`message` は `` `${keyword}: ${message}` ``。
- `assertValidFlow(data): Flow` は不正なら `Invalid Flow:\n  <path> → <message>...` を throw、正なら `data as Flow` を返す。

### 1.2 バージョニング

```ts
export const CURRENT_SCHEMA_VERSION = '1.0' as const;
export type SchemaVersion = string;
```
- 現行スキーマは **1.0** 固定。JSON Schema 側でも `schemaVersion: { type: 'string', const: '1.0' }` で `'1.0'` 以外を拒否する。
- `migrations.ts` の `MIGRATIONS` 配列は**空**（コメントで `{ from: "1.0", to: "1.1", ... }` の置き場所だけ用意）。
- `migrateFlow(raw): Flow` は `schemaVersion` を見て `CURRENT_SCHEMA_VERSION` になるまでマイグレーションをチェーン適用し、最後に `assertValidFlow` を通す。
  - `schemaVersion` フィールドが無い/オブジェクトでない → `Migration failed: input does not look like a Flow (missing schemaVersion).`
  - そのバージョンからの移行先が見つからない → `No migration path from schemaVersion=<v> to 1.0.`

### 1.3 デフォルト値

**`schema.ts` / `json-schema.ts` 自体は構造の必須・任意のみを規定し、実行時デフォルト値（タイムアウトの具体秒数など）は持たない。** デフォルト値の供給元は2系統に分かれる:

1. **Flow 自身の `defaults`（`FlowDefaults`）**: ステップが `timeoutMs` 等を省いた時の既定。Flow 作者/エディタが値を入れる。テスト(`schema.test.ts`)が示す典型値: `timeoutMs: 30000`, `retry: { attempts: 1 }`, `screenshotOnError: true`, `waitBetweenStepsMs: 50`。**これらは「テストが使う例」であって IR が強制する値ではない**。
2. **`FlowDefaults.humanize` 不在時のフォールバック**（`schema.ts` のコメント記載・【事実】コメントのみ、IR にコード上の定数なし）: グローバル `AppSettings.humanize`（[05](./05-app-electron.md)）→ 組み込み既定 `mouseSpeedPxPerSec=800, typeDelayMs=50`。**この 800/50 はコメント上の記述で、実装は engine/app 側**（[03](./03-engine.md)・[05](./05-app-electron.md)）。

JSON Schema の数値制約（デフォルトではなく**下限/上限**）: `timeoutMs`/`waitBetweenStepsMs` は `integer, minimum:0`、`retry.attempts` は `integer, minimum:1`、`backoff.factor` は `number, minimum:1`、`confidence` は `number, 0〜1`、`Selector(image).threshold` は `number, 0〜1`。

---

## 2. Flow 型（フロー全体）

`schema.ts`:
```ts
export interface Flow {
  schemaVersion: SchemaVersion;
  id: string;
  name: string;
  description?: string;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
  inputs: VarDecl[];
  outputs: VarDecl[];
  variables: VarDecl[];
  defaults: FlowDefaults;
  steps: Step[];
  metadata: FlowMetadata;
}
```

| フィールド | 型 | 必須 | 意味 |
| --- | --- | --- | --- |
| `schemaVersion` | `string`（JSON Schema は `const: '1.0'`） | 必須 | IR バージョン。常に `'1.0'`。 |
| `id` | `string`（`minLength:1`） | 必須 | Flow の一意 ID。`newId()`（ULID）で生成。 |
| `name` | `string`（`minLength:1`） | 必須 | フロー表示名。 |
| `description` | `string` | 任意 | 説明文。 |
| `createdAt` | `string`（`format: date-time`） | 必須 | 作成日時 ISO 8601。 |
| `updatedAt` | `string`（`format: date-time`） | 必須 | 更新日時 ISO 8601。 |
| `inputs` | `VarDecl[]` | 必須（空配列可） | 実行時に外から渡す入力変数の宣言。 |
| `outputs` | `VarDecl[]` | 必須（空配列可） | 実行後に取り出す出力変数の宣言。 |
| `variables` | `VarDecl[]` | 必須（空配列可） | フロー内ローカル変数の宣言。 |
| `defaults` | `FlowDefaults` | 必須 | ステップ共通の既定（タイムアウト・リトライ等）。 |
| `steps` | `Step[]` | 必須（空配列可） | **トップレベルのステップ列。ネスト構造はここから `Step.children` / `Step.branches` で再帰**（§5）。 |
| `metadata` | `FlowMetadata` | 必須 | 由来・対象レイヤ・必要権限。 |

**ステップ配列の持ち方**: Flow は `steps: Step[]` を1本だけ持つ。制御構造の入れ子は配列の階層ではなく、各 `Step` の `children`（本体）と `branches`（条件付き枝）で表現する（§5）。

### 2.1 FlowDefaults

```ts
export interface FlowDefaults {
  timeoutMs: number;
  retry: RetryPolicy;
  screenshotOnError: boolean;
  waitBetweenStepsMs: number;
  allowList?: AllowList;
  humanize?: {
    mouseSpeedPxPerSec?: number;
    typeDelayMs?: number;
  };
}
```

| フィールド | 型 | 必須 | 意味 |
| --- | --- | --- | --- |
| `timeoutMs` | `number`（`integer, minimum:0`） | 必須 | ステップが `timeoutMs` を省略した時の既定タイムアウト(ms)。 |
| `retry` | `RetryPolicy` | 必須 | 既定リトライポリシー。 |
| `screenshotOnError` | `boolean` | 必須 | エラー時にスクショを撮るか。 |
| `waitBetweenStepsMs` | `number`（`integer, minimum:0`） | 必須 | ステップ間の待機(ms)。 |
| `allowList` | `AllowList` | 任意 | 危険ステップ種別のホワイトリスト（将来用）。 |
| `humanize` | `{ mouseSpeedPxPerSec?: number; typeDelayMs?: number }` | 任意 | フロー単位の人間らしさ既定。`json-schema.ts` の `flowDefaults` properties にも追加済み（2026-05-31 修正、回帰テスト `test/schema.test.ts` あり）。 |

### 2.2 FlowMetadata

```ts
export interface FlowMetadata {
  origin: 'recorded' | 'ai-generated' | 'mixed';
  targets: ReadonlyArray<'web' | 'desktop'>;
  requiredPermissions: string[];
}
```

| フィールド | 型 | 意味 |
| --- | --- | --- |
| `origin` | `'recorded' \| 'ai-generated' \| 'mixed'` | フローの由来。 |
| `targets` | `('web' \| 'desktop')[]` | 対象レイヤ。**`'screen'` は含まれない**（TargetRef.layer には `screen` があるが、metadata.targets は web/desktop のみ）。 |
| `requiredPermissions` | `string[]` | 必要 OS 権限の文字列配列（任意の文字列。列挙制約なし）。 |

### 2.3 VarDecl（入出力・変数の宣言）

```ts
export interface VarDecl {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'json' | 'secret';
  defaultValue?: unknown;
  description?: string;
}
```

| フィールド | 型 | 必須 | 意味 |
| --- | --- | --- | --- |
| `name` | `string`（`minLength:1`） | 必須 | 変数名。 |
| `type` | `'string'\|'number'\|'boolean'\|'json'\|'secret'` | 必須 | 変数型。`secret` は Vault 由来（[07](./07-storage-vault.md)）。 |
| `defaultValue` | `unknown`（JSON Schema は `{}` = 任意の値） | 任意 | 既定値。 |
| `description` | `string` | 任意 | 説明。 |

---

## 3. Step 型（共通構造）

**全ステップは単一の `interface Step` を共有する。** 「判別共用体」は `Step.type`（`StepType`）の値で区別され、ステップ固有のデータは `params: Record<string, unknown>`（自由形式）に入る。`json-schema.ts` でも `step.params` は `{ type: 'object' }` で中身を検証しない。**つまり params の具体フィールドは IR スキーマでは保証されず、engine/adapter 側のハンドラが解釈する**（型ごとの param 形は §6 と [03](./03-engine.md)・[04](./04-adapters.md)）。

```ts
export interface Step {
  id: string;
  type: StepType;
  label?: string;
  enabled: boolean;
  target?: TargetRef;
  params?: Record<string, unknown>;
  timeoutMs?: number;
  retry?: RetryPolicy;
  assert?: Assertion[];
  onError?: OnErrorPolicy;
  children?: Step[];
  branches?: { name: string; condition?: Expression; steps: Step[] }[];
  meta?: StepMeta;
}
```

JSON Schema の必須は `['id', 'type', 'enabled']` のみ。

| フィールド | 型 | 必須 | 意味 |
| --- | --- | --- | --- |
| `id` | `string`（`minLength:1`） | 必須 | ステップ一意 ID（ULID）。`onError.goto` や cursor 表現の参照先。 |
| `type` | `StepType` | 必須 | ステップ種別（§4 の判別子。enum で厳格制約）。 |
| `label` | `string` | 任意 | 表示用ラベル。 |
| `enabled` | `boolean` | 必須 | 無効化フラグ。 |
| `target` | `TargetRef` | 任意 | 操作対象のセレクタ群（§7）。click/type/wait_for(element系) 等で使う。 |
| `params` | `Record<string, unknown>` | 任意 | **ステップ固有パラメータ（自由形式）**。 |
| `timeoutMs` | `number`（`integer, minimum:0`） | 任意 | このステップのタイムアウト。省略時 `flow.defaults.timeoutMs`。 |
| `retry` | `RetryPolicy` | 任意 | このステップのリトライ。 |
| `assert` | `Assertion[]` | 任意 | アサーション（§8。Mode-2 の挿入点）。 |
| `onError` | `OnErrorPolicy` | 任意 | エラー時方針（§3.1）。 |
| `children` | `Step[]` | 任意 | **本体ステップ列**。loop の繰り返し本体、try の body、if の else に使う（§5）。 |
| `branches` | `{ name: string; condition?: Expression; steps: Step[] }[]` | 任意 | **名前付き枝**。if の then、try の catch/finally に使う（§5）。JSON Schema 必須は `name, steps`。 |
| `meta` | `StepMeta` | 任意 | 記録/生成メタデータ（§3.2）。 |

### 3.1 OnErrorPolicy

```ts
export type OnErrorPolicy = 'fail' | 'continue' | 'retry' | { goto: string };
```
- `'fail'`（既定。engine 側で `step.onError ?? 'fail'`）／`'continue'`（スキップ扱いで継続）／`'retry'`／`{ goto: <stepId> }`。
- JSON Schema は `oneOf`: enum `['fail','continue','retry']` または `{ goto: string }`（`goto` 必須・他不可）。

### 3.2 StepMeta

```ts
export interface StepMeta {
  recordedAt?: string;
  recordedBy?: string;
  generatedBy?: string;
  screenshotRef?: string;
  confidence?: number;
  needsRecording?: boolean;
  rationale?: string;
  origin?: 'recorded' | 'ai-generated' | 'manual';
}
```

| フィールド | 型 | 意味 |
| --- | --- | --- |
| `recordedAt` | `string`（`date-time`） | 記録日時。 |
| `recordedBy` | `string` | 記録者/レコーダ識別。 |
| `generatedBy` | `string` | 生成元（AI モデル名等）。 |
| `screenshotRef` | `string` | スクショ参照（資産 ID）。 |
| `confidence` | `number`（`0〜1`） | 生成・推定の確信度。 |
| `needsRecording` | `boolean` | 要再記録フラグ。 |
| `rationale` | `string` | 生成理由。 |
| `origin` | `'recorded'\|'ai-generated'\|'manual'` | ステップ単位の由来。 |

### 3.3 RetryPolicy

```ts
export interface RetryPolicy {
  attempts: number;
  backoff?: {
    kind: 'fixed' | 'exponential';
    initialMs: number;
    factor?: number;
    maxMs?: number;
  };
  retryOn?: ReadonlyArray<'selector_not_found' | 'timeout' | 'network' | 'any'>;
  betweenAttempts?: Step[];
}
```

| フィールド | 型 | 必須 | 意味 |
| --- | --- | --- | --- |
| `attempts` | `number`（`integer, minimum:1`） | 必須 | 試行回数。 |
| `backoff.kind` | `'fixed' \| 'exponential'` | backoff 内必須 | バックオフ方式。 |
| `backoff.initialMs` | `number`（`integer, minimum:0`） | backoff 内必須 | 初回待機。 |
| `backoff.factor` | `number`（`minimum:1`） | 任意 | 指数係数。 |
| `backoff.maxMs` | `number`（`integer, minimum:0`） | 任意 | 待機上限。 |
| `retryOn` | `('selector_not_found'\|'timeout'\|'network'\|'any')[]` | 任意 | リトライ対象のエラー分類。 |
| `betweenAttempts` | `Step[]` | 任意 | リトライ間に実行するステップ列（例: 再ロード）。 |

---

## 4. StepType 判別共用体（全ステップ型）

```ts
export type StepType =
  | 'open_url' | 'click' | 'type' | 'key_combo' | 'scroll' | 'drag'
  | 'wait' | 'wait_for' | 'screenshot' | 'extract'
  | 'clipboard_read' | 'clipboard_write'
  | 'excel_open' | 'excel_read' | 'excel_write' | 'excel_range'
  | 'set_var' | 'if' | 'loop' | 'try' | 'parallel' | 'subflow'
  | 'ai_assert' | 'ai_extract' | 'log' | 'manual_pause';
```
JSON Schema(`json-schema.ts` の `step.type`)の enum はこの全26種を**完全一致で列挙**している（両者を同期すること）。未知の `type` は `validateFlow` で `enum` エラーになる（`schema.test.ts` の `launch_rocket` 例）。

各ステップ型の `params`/`target` の解釈は IR では規定されず、engine（組込み型）または adapter（layer 付き型）が解釈する。以下は **実コードで確認できた解釈**のみ記載し、未確認は明示する。adapter が解釈する `click`/`type`/`open_url`/`scroll`/`drag`/`key_combo`/`screenshot`/`extract`/`clipboard_*`/`excel_*` 等の詳細 param は [04 アダプタ](./04-adapters.md) を参照。

### 4.1 engine がインラインで解釈する型（`packages/engine/src/executor.ts`、【事実】コード確認済み）

| type | 解釈する params / フィールド | 意味 |
| --- | --- | --- |
| `if` | `params.condition`（式・truthy）／`branches[0].steps`（then）／`children`（else） | 条件分岐（§5.1）。 |
| `loop` | `params.kind`(`'for'`\|`'forEach'`\|`'while'`、既定`'for'`)／`for`: `params.count`／`forEach`: `params.items`(配列), `params.asVar`(既定`'item'`)／`while`: `params.condition`, `params.maxIterations`(既定 1000)／本体は `children` | 繰り返し（§5.2）。 |
| `try` | `children`(body)／`branches[name==='catch'].steps`／`branches[name==='finally'].steps`。catch 進入時 `ctx.vars['__error__']` にメッセージ格納 | 例外処理（§5.3）。 |
| `log` | `params.level`(`'debug'\|'info'\|'warn'\|'error'`、既定 `'info'`)／`params.message`(文字列化) | ログ出力。 |
| `manual_pause` | `params.message` | 人手チェックポイント。**Phase-1 のヘッドレス/CLI 実行では resume チャネルが無いため、警告ログを出して自動継続**（クラッシュしない）。 |
| `wait` | engine では専用分岐なし。`Step.timeoutMs`/`params` 経由でハンドラへ。【未確認】`wait` の正確な param 名は engine 本体未掲載部または adapter に依存（[03](./03-engine.md)） | 固定時間待機。 |
| `wait_for` | §6 で詳述。`params.kind`(WaitForKind)／`params.timeoutMs`／`params.pollIntervalMs`(最小10, 既定100)／`time`: `params.ms`(または `params.timeoutMs`)／`expr`: `params.expr` | 条件待機。 |

### 4.2 ハンドラレジストリ経由で adapter が解釈する型（engine に分岐なし）

`set_var`・`extract`・`screenshot`・`clipboard_read`・`clipboard_write`・`open_url`・`click`・`type`・`key_combo`・`scroll`・`drag`・`excel_*`・`parallel`・`subflow`・`ai_assert`・`ai_extract` は executor の `switch` に専用 case が無く、`registry.get(type, target?.layer)` で解決される（無ければ `No handler registered for step type "<type>"` を throw）。**これらの params 仕様は [04 アダプタ](./04-adapters.md)（web/desktop/screen provider）と [03 エンジン](./03-engine.md) を参照。** IR は「params は object」までしか保証しない。

---

## 5. 制御構造（if / loop / try）の入れ子表現

入れ子は `Step.children`（無名の本体列）と `Step.branches`（名前付き枝）で表す。**engine の解釈規約**（`executor.ts`、【事実】）:

### 5.1 if（`executeIf`）

- 真偽判定: `evalCondition(step.params.condition)`。
- 真 → `branches[0].steps` を実行（添字 **0** 固定。`branches[0]` が「then」枝）。
- 偽 → `children` を実行（`children` が「else」枝。空なら何もしない）。
- カーソル: then は `<cursor>.branches[0].steps`、else は `<cursor>.children`。

例:
```jsonc
{
  "id": "...", "type": "if", "enabled": true,
  "params": { "condition": "var.price > 100" },
  "branches": [ { "name": "then", "steps": [ /* 真のとき */ ] } ],
  "children": [ /* 偽(else)のとき */ ]
}
```
（`branches[0].name` の文字列値は engine では参照されず、添字0で取る。`condition` は `branches[].condition` ではなく `params.condition` を見る点に注意。）

### 5.2 loop（`executeLoop`）

- 共通: 本体は `children`。`params.kind` で 3 モード:
  - `'for'`（既定）: `params.count` 回繰り返す。
  - `'forEach'`: `params.items`（配列。`${var.x}` は補間後に実配列であること）を走査し、各要素を `ctx.vars[params.asVar ?? 'item']` に束縛。配列でなければ throw。
  - `'while'`: `evalCondition(params.condition)` が真の間。`params.maxIterations`（既定 1000）超過で throw。
- 未知 `kind` → `Unsupported loop kind "<kind>"`。

例:
```jsonc
{ "id":"...", "type":"loop", "enabled":true,
  "params": { "kind":"forEach", "items":"${var.rows}", "asVar":"row" },
  "children": [ /* 各 row に対する処理 */ ] }
```

### 5.3 try（`executeTry`）

- body = `children`。
- catch = `branches` のうち `name === 'catch'` の枝。body が throw したとき、`ctx.vars['__error__']` にエラーメッセージを入れて `catch.steps` を実行。catch が無ければ再 throw。
- finally = `branches` のうち `name === 'finally'` の枝。常に最後に実行。
- カーソル: `<cursor>.children` / `<cursor>.catch` / `<cursor>.finally`。

例:
```jsonc
{ "id":"...", "type":"try", "enabled":true,
  "children": [ /* body */ ],
  "branches": [
    { "name":"catch", "steps": [ /* 失敗時 */ ] },
    { "name":"finally", "steps": [ /* 後始末 */ ] }
  ] }
```

**規約まとめ**: `branches[].name` は if では無視（添字0）、try では `'catch'`/`'finally'` で識別。`children` は if=else / loop=本体 / try=body と、型ごとに意味が違う。これは IR スキーマには現れない **engine 側の約束**なので、新しい制御構造を足すなら 03 と本節を両方更新する。

---

## 6. wait_for（条件待機）の判定種別

```ts
export const WAIT_FOR_KINDS = [
  'time', 'web.load', 'web.element', 'web.url',
  'desktop.element', 'desktop.app_focus', 'desktop.window_title',
  'desktop.screen_stable', 'expr',
] as const;
export type WaitForKind = (typeof WAIT_FOR_KINDS)[number];
```

`wait_for` ステップは `params.kind`（上記いずれか）でディスパッチする。`json-schema.ts` は `params` を自由 object のままにしているので、`kind` の追加はスキーマの破壊的変更を伴わない（`schema.ts` のコメント明記。`ai.*` ファミリは Phase-2 のビジョン/AI 判定向けに予約）。

| kind | 判定対象（`schema.ts` コメント）／使う params・target | レイヤ |
| --- | --- | --- |
| `time` | 数値 ms タイムアウト（`wait` と同形）。`params.ms`（無ければ `params.timeoutMs`）ミリ秒スリープ。engine がインライン処理（provider 不要）。 | なし |
| `web.load` | ページ読込段階。`params.state`: `load`\|`domcontentloaded`\|`networkidle`。 | web |
| `web.element` | DOM 要素出現。`Step.target` + `params.state` を使う。 | web |
| `web.url` | 現ページ URL が `params.url` に一致（部分一致 or パターン）。 | web |
| `desktop.element` | AX 要素出現。`Step.target` を使う。 | desktop |
| `desktop.app_focus` | 最前面アプリの bundleId が `params.appBundleId` と一致。 | desktop |
| `desktop.window_title` | 最前面ウィンドウタイトルが `params.titlePattern` に一致。 | desktop |
| `desktop.screen_stable` | 画面ピクセルが `params.stableMs` の間安定（adapter のスクショ使用）。 | desktop |
| `expr` | jsep 式 `params.expr` が truthy になる。engine がインライン処理（provider 不要）。 | なし |

**engine のディスパッチ規約**（`executeWaitFor`、【事実】）:
- `params.kind` が明示されればそれ。無ければ `inferWaitForKind`（後方互換）で推論: `params.expr` が文字列→`expr`／`params.url` が文字列かつ `target` 無し→`web.url`／`target.layer==='desktop'`→`desktop.element`／`target` あり→`web.element`／それ以外→`time`。
- `time`・`expr` は engine 内で完結。それ以外は `kind` の接頭辞(`web.`/`desktop.`)からレイヤを決め、`registry.get('wait_for', layer)` のハンドラへ委譲（無ければ throw）。
- 共通 params: `params.timeoutMs`（既定 `step.timeoutMs ?? flow.defaults.timeoutMs`）、`params.pollIntervalMs`（最小10・既定100）。

**新しい `wait_for` 種別を足す手順**: `WAIT_FOR_KINDS` に値を追加 → コメントに対象を追記 → web/desktop どちらかなら対応する provider の `wait_for` ハンドラを実装（[04](./04-adapters.md)）。JSON Schema は触らなくてよい（params が free-form なため）。

---

## 7. TargetRef（セレクタ候補配列）

設計の核。`schema.ts` コメントでも "the heart of the design"。

```ts
export interface TargetRef {
  layer: 'web' | 'desktop' | 'screen';
  candidates: Selector[];
  preferIndex?: number;
  anchor?: AnchorRef;
  region?: Rect;
}
```

| フィールド | 型 | 必須 | 意味・用途 |
| --- | --- | --- | --- |
| `layer` | `'web' \| 'desktop' \| 'screen'` | 必須 | 対象レイヤ。どの provider/セレクタ群を使うかを決める。 |
| `candidates` | `Selector[]`（JSON Schema は `minItems:1`） | 必須 | **セレクタ候補の優先順配列**。1つでも要素が必要。先頭から順に試し、ダメなら次へフォールバックする想定（解決ロジックは [04](./04-adapters.md)）。 |
| `preferIndex` | `number`（`integer, minimum:0`） | 任意 | 優先的に使う候補の添字。 |
| `anchor` | `AnchorRef` | 任意 | 相対位置の手がかり（近傍要素・所属アプリ等）。 |
| `region` | `Rect` | 任意 | 探索を限定する矩形領域。 |

`layer` の値と用途:
- `web` … ブラウザ DOM。web 系 Selector（role/testid/label/css/xpath/text/url-anchor）。
- `desktop` … ネイティブ UI（macOS AX / Windows UIA）。desktop 系 Selector（ax/uia）。
- `screen` … 画面ピクセルへのフォールバック。screen 系 Selector（image/ocr/coords）。

`metadata.targets` は `web`/`desktop` のみで `screen` を含まない点に注意（§2.2）。

### 7.1 AnchorRef / AppRef / Rect

```ts
export interface AnchorRef {
  description?: string;
  nearTarget?: TargetRef;   // 近傍の別ターゲット（再帰）
  inApp?: AppRef;
}
export interface AppRef {
  bundleId?: string;        // macOS
  processName?: string;     // Windows
  exePath?: string;
  titlePattern?: string;
}
export interface Rect {
  x: number; y: number; w: number; h: number;  // w,h は minimum:0
}
```
すべて JSON Schema 上 `additionalProperties:false`。`AnchorRef`/`AppRef` は全フィールド任意、`Rect` は4つとも必須。

---

## 8. Selector 判別共用体（全 kind）

```ts
export type Selector =
  // --- Web ---
  | { kind: 'role'; role: string; name?: string; exact?: boolean }
  | { kind: 'testid'; value: string }
  | { kind: 'label'; text: string }
  | { kind: 'css'; value: string }
  | { kind: 'xpath'; value: string }
  | { kind: 'text'; value: string }
  | { kind: 'url-anchor'; pattern: string }
  // --- Desktop (macOS AX / Windows UIA) ---
  | { kind: 'ax'; app: string; role: string; title?: string; identifier?: string; path?: AXPathSegment[] }
  | { kind: 'uia'; processName: string; automationId?: string; controlType: string; name?: string }
  // --- Screen fallback ---
  | { kind: 'image'; assetRef: string; threshold: number; scaleInvariant?: boolean }
  | { kind: 'ocr'; text: string; lang: string; regex?: boolean }
  | { kind: 'coords'; x: number; y: number; anchor: 'screen' | 'window' };
```
JSON Schema(`selector`)は `oneOf` で各 kind を `additionalProperties:false` 付きで列挙。判別子は `kind`。

| kind | レイヤ | 必須フィールド | 任意フィールド | 意味 |
| --- | --- | --- | --- | --- |
| `role` | web | `role:string` | `name?:string`, `exact?:boolean` | ARIA ロール（+アクセシブル名）。 |
| `testid` | web | `value:string` | — | `data-testid` 等の値。 |
| `label` | web | `text:string` | — | ラベルテキスト。 |
| `css` | web | `value:string` | — | CSS セレクタ。 |
| `xpath` | web | `value:string` | — | XPath。 |
| `text` | web | `value:string` | — | 表示テキスト一致。 |
| `url-anchor` | web | `pattern:string` | — | URL パターン（ページ同定用のアンカー）。 |
| `ax` | desktop | `app:string`(bundleId), `role:string` | `title?:string`, `identifier?:string`, `path?:AXPathSegment[]` | macOS Accessibility 要素。`app` は bundleId。 |
| `uia` | desktop | `processName:string`, `controlType:string` | `automationId?:string`, `name?:string` | Windows UI Automation 要素（将来）。 |
| `image` | screen | `assetRef:string`, `threshold:number`(0〜1) | `scaleInvariant?:boolean` | テンプレート画像マッチ。 |
| `ocr` | screen | `text:string`, `lang:string` | `regex?:boolean` | OCR テキスト一致。 |
| `coords` | screen | `x:number`, `y:number`, `anchor:'screen'\|'window'` | — | 絶対座標（最終手段）。 |

```ts
export interface AXPathSegment { role: string; index?: number; title?: string; }
```
`ax.path` の各セグメント。`role` 必須、`index`(minimum:0)/`title` 任意。AX ツリーを root から辿る経路を表す。

例（web click のセレクタ群、`schema.test.ts` より）:
```jsonc
"target": {
  "layer": "web",
  "candidates": [
    { "kind": "role", "role": "button", "name": "Save" },
    { "kind": "testid", "value": "save-btn" },
    { "kind": "css", "value": "button.primary[data-id=\"42\"]" }
  ]
}
```

---

## 9. Assertion / Expression / AllowList

### 9.1 Assertion（Mode-2 の挿入点）

```ts
export type Assertion =
  | { kind: 'exists'; target: TargetRef }
  | { kind: 'text'; target: TargetRef; op: 'eq' | 'contains' | 'regex'; value: string }
  | { kind: 'vision_yes_no'; prompt: string; refs: 'before' | 'after' | 'both'; modelHint?: string }
  | { kind: 'vision_extract'; prompt: string; schema: unknown; into: string; modelHint?: string }
  | { kind: 'expr'; expr: Expression };
```
`Step.assert: Assertion[]`。JSON Schema(`assertion`)は `oneOf`、判別子 `kind`。

| kind | 必須 | 任意 | 意味 |
| --- | --- | --- | --- |
| `exists` | `target:TargetRef` | — | 対象要素が存在すること。 |
| `text` | `target`, `op`(`eq`\|`contains`\|`regex`), `value:string` | — | 対象テキストの比較。 |
| `vision_yes_no` | `prompt:string`, `refs`(`before`\|`after`\|`both`) | `modelHint?:string` | ビジョン AI の Yes/No 判定（Phase-2）。`refs` は判定に使うスクショ（実行前/後/両方）。 |
| `vision_extract` | `prompt:string`, `schema:unknown`(JSON Schema), `into:string` | `modelHint?:string` | ビジョン AI で構造抽出し `into` 変数へ格納（Phase-2）。 |
| `expr` | `expr:Expression` | — | jsep 式が truthy であること。 |

例（`schema.test.ts`）: `{ "kind": "vision_yes_no", "prompt": "保存に成功した?", "refs": "after" }`

### 9.2 Expression（式）

```ts
/** A parsed jsep expression stored as a JSON-serializable AST, or a string source to be parsed at eval time. */
export type Expression = string | { __ast: unknown };
```
- **文字列**（jsep ソース。評価時にパース）または **`{ __ast: <jsep AST> }`**（パース済み AST を JSON として保持）。
- JSON Schema(`expression`)は `oneOf`: `{ type:'string' }` または `{ __ast: {} }`（`__ast` 必須・他不可）。

**評価器**（`expr.ts`、`evaluateExpr(source, context)`）— jsep を使い、`eval`/`Function` は**使わない**。AST を allow-list で walk:
- リテラル: number / string / boolean / null。
- 識別子のルートは **`var` / `env` / `secrets` / `ctx` のみ**（`ALLOWED_ROOTS`）。加えて `ctx.locals` にあるフリー変数（例: forEach の `item`）。それ以外の識別子は `unknown identifier` で throw。
- 二項: `+ - * / % === !== == != > >= < <= && || ?? & | ^`（`??` は `jsep.addBinaryOp('??', 1)` で追加）。`&&`/`||`/`??` は短絡評価。`&|^` は `>>> 0` で符号なし32bit化。
- 単項: `+ - ! typeof`。
- メンバアクセス: `a.b` / `a["b"]`。**`__proto__`/`constructor`/`prototype`/`toString`/`valueOf` へのアクセスは `forbidden property access` で throw**（プロトタイプ汚染対策）。
- 呼び出し: **トップレベルのホワイトリスト関数のみ**。メソッド呼び出し（`a.b()`）は callee が MemberExpression なので `only top-level whitelisted function calls are allowed` で throw。
  - ホワイトリスト関数: `contains, startsWith, endsWith, length, lower, upper, trim, regexTest, min, max, abs, round, floor, ceil, not, and, or`。
- 三項 `? :`、配列リテラル `[...]` 対応。それ以外のノード型は `unsupported node type` で throw。
- `ExprContext`:
```ts
export interface ExprContext {
  var?: Record<string, unknown>;
  env?: Record<string, string | undefined>;
  secrets?: Record<string, string | undefined>;
  ctx?: Record<string, unknown>;
  locals?: Record<string, unknown>;
}
```

**補間（`interpolate.ts`）は式評価とは別物**。`${var.x}` / `${env.X}` / `${secrets.token}` / `${ctx.lastResult}` のドット参照のみを文字列置換する（演算子・関数なし）。ルートは `var/env/secrets/ctx`。未知ルートは**プレースホルダをそのまま残す**（`${unknown.x}` → `${unknown.x}`）。解決できない `${var.foo}` は**空文字**を返しエラーにしない。`interpolateParams` は params を再帰的に deep-clone しつつ全文字列を補間（元 Step を変更しないので解決済み secret を永続化しない）。`collectSecretRefs(params)` は `${secrets.<name>}` 参照の name 一覧を返す（Vault プリフェッチ用）。

### 9.3 AllowList（将来用ホワイトリスト）

```ts
export interface AllowList {
  enabledStepTypes?: string[];
  execAllowedCommands?: string[];
  httpAllowedHosts?: string[];
  fileAllowedPaths?: string[];
}
```
`FlowDefaults.allowList`。危険なステップ種別（exec / http / file 等）の許可リスト。全フィールド任意。**現状の StepType には exec/http/file は無い**（将来用の枠）。JSON Schema は `additionalProperties:false`。

---

## 10. JSON Schema と TS 型の差分・既知の注意点

- ~~**`humanize` 不整合**: `FlowDefaults.humanize` が `json-schema.ts` の `flowDefaults` に未列挙で検証拒否される~~ → **2026-05-31 修正済み**。`flowDefaults.properties.humanize`（`mouseSpeedPxPerSec`/`typeDelayMs`）を追加し、回帰テスト（`test/schema.test.ts` の "accepts a Flow whose defaults include humanize overrides"）で固定。
- `step.params` は JSON Schema で `{ type:'object' }` のみ（中身ノーチェック）。型安全性は engine/adapter ハンドラ責務。
- `metadata.targets` は web/desktop のみ（screen 不可）だが TargetRef.layer は screen を許す。記録時に screen ターゲットを使った場合の metadata 扱いは【未確認】。
- 検証は `strict: true` の ajv。スキーマ自体が不正だと `ajv.compile` 時（モジュール読み込み時）に例外。

---

## 11. 変更ガイド: 新ステップ型 / 新セレクタ / 新待機種別を足すとき

### 11.1 新しい StepType を追加

IR 側（`packages/ir/`）:
1. `src/schema.ts` の `StepType` 共用体に値を追加。
2. `src/json-schema.ts` の `step.type` enum に**同じ値を追加**（同期必須。漏れると検証で弾かれる）。
3. params に固定構造が必要でも、原則 `step.params` は free-form のままにしておく（破壊的変更回避）。厳格化したい場合のみ schema を分岐。
4. `test/schema.test.ts` に検証ケースを足す。

波及（別パッケージ。本書では型のみ規定）:
- **engine**（[03](./03-engine.md)）: 組込み処理が必要なら `executor.ts` の `switch` に case 追加。そうでなければハンドラレジストリ経由になるので、
- **adapter**（[04](./04-adapters.md)）: 対応レイヤの provider に `StepHandler`（`type` + `layer`）を実装・登録。未登録だと実行時 `No handler registered for step type "<type>"`。
- **renderer/app**（[05](./05-app-electron.md)）: エディタ UI に新ステップの編集 UI・既定 params 生成を追加。

### 11.2 新しい Selector kind を追加
1. `schema.ts` の `Selector` 共用体に新メンバ（`kind` 判別子 + フィールド）。
2. `json-schema.ts` の `selector.oneOf` に対応する `{ const: '<kind>' }` ブランチを `additionalProperties:false` 付きで追加。
3. 対応レイヤの provider 解決ロジックを更新（[04](./04-adapters.md)）。

### 11.3 新しい wait_for 種別を追加
§6 末尾参照（`WAIT_FOR_KINDS` 追加 + provider ハンドラ。JSON Schema は不要）。

### 11.4 スキーマバージョンを上げるとき
1. `CURRENT_SCHEMA_VERSION` を更新。
2. `json-schema.ts` の `schemaVersion.const` を更新。
3. `migrations.ts` の `MIGRATIONS` に `{ from, to, migrate }` を追加。
4. `migrateFlow` は自動でチェーンを辿る（呼び出し側変更不要）。

---

## 12. ステップ型 早見表（type → 1行責務 → 主フィールド）

| type | 1行責務 | 主フィールド / params（※params は IR では free-form。確認できたものを記載） |
| --- | --- | --- |
| `open_url` | URL を開く | `target?`(web), params: URL（[04](./04-adapters.md)） |
| `click` | 要素クリック | `target`（layer 別 candidates） |
| `type` | テキスト入力 | `target`, params: 入力文字列・`delayMs`（[04](./04-adapters.md)） |
| `key_combo` | キー組合せ送信 | params: キー指定（[04](./04-adapters.md)） |
| `scroll` | スクロール | `target?`, params（[04](./04-adapters.md)） |
| `drag` | ドラッグ操作 | `target?`, params（[04](./04-adapters.md)） |
| `wait` | 固定時間待機 | params: 待機ms（[03](./03-engine.md)・[04](./04-adapters.md)） |
| `wait_for` | 条件成立まで待機 | `params.kind`(WaitForKind), `params.timeoutMs`, `params.pollIntervalMs`, `target?`（§6） |
| `screenshot` | スクショ取得 | params/`target?`（[04](./04-adapters.md)） |
| `extract` | 値抽出→変数 | `target`, params: 抽出先（[04](./04-adapters.md)） |
| `clipboard_read` | クリップボード読取 | params（[04](./04-adapters.md)） |
| `clipboard_write` | クリップボード書込 | params（[04](./04-adapters.md)） |
| `excel_open` | Excel ファイルを開く | params（[04](./04-adapters.md)） |
| `excel_read` | Excel セル読取 | params（[04](./04-adapters.md)） |
| `excel_write` | Excel セル書込 | params（[04](./04-adapters.md)） |
| `excel_range` | Excel 範囲操作 | params（[04](./04-adapters.md)） |
| `set_var` | 変数へ代入 | params: 変数名・値（[03](./03-engine.md)・[04](./04-adapters.md)） |
| `if` | 条件分岐 | `params.condition`, `branches[0]`=then, `children`=else（§5.1） |
| `loop` | 繰り返し | `params.kind`(for/forEach/while), `params.count`/`items`/`asVar`/`condition`/`maxIterations`, `children`=本体（§5.2） |
| `try` | 例外処理 | `children`=body, `branches[name='catch'/'finally']`（§5.3） |
| `parallel` | 並列実行（将来） | `children`／params（[03](./03-engine.md)）【未確認】 |
| `subflow` | 別フロー呼び出し | params: 参照（[03](./03-engine.md)）【未確認】 |
| `ai_assert` | AI による合否判定（Phase-2） | params/`assert`（[04](./04-adapters.md)）【未確認】 |
| `ai_extract` | AI による抽出（Phase-2） | params（[04](./04-adapters.md)）【未確認】 |
| `log` | ログ出力 | `params.level`(debug/info/warn/error), `params.message`（§4.1） |
| `manual_pause` | 人手チェックポイント | `params.message`（Phase-1 は自動継続）（§4.1） |

---

## 13. 08 用語集に載せるべき不変条件（要点）

- **schemaVersion は常に `'1.0'`**（JSON Schema `const`）。バージョン変更は §11.4 の手順必須。
- **秘密情報を IR にインライン化しない**。`${secrets.foo}` 参照のみ可。`collectSecretRefs` で参照名を収集。
- **TS 型(`schema.ts`)と JSON Schema(`json-schema.ts`)は手動同期**。`StepType` enum・`Selector` oneOf 等を片方だけ変えない。
- **`Step.params` は IR では free-form**（object のみ保証）。型保証は engine/adapter ハンドラ。
- **検証は ajv (draft-07, strict)**。zod 不使用。
- **ID は ULID**（`newId()`、`/^[0-9A-HJKMNP-TV-Z]{26}$/`）。
- **式評価は jsep の allow-list walk**。`eval`/`Function` 不使用、ルートは `var/env/secrets/ctx`(+locals)、ホワイトリスト関数のみ、危険プロパティ禁止。
- **制御構造の意味は engine 側の約束**: if=`branches[0]`/`children`(else)、loop 本体=`children`、try=`children`(body)+`branches.name`(catch/finally)。
