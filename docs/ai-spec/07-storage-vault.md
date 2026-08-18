# 07. ストレージ / flow-store・Vault(キーチェーン)
> 最終更新: 2026-05-31 ／ 対象コミット: b3d5fa6 (feat/phase-1-completion)
> AI用仕様書。コードを読む前にまずこれを読む。該当コードを変更したら同じPRでこのファイルも更新すること。

関連: [README](README.md) ／ [01-architecture](01-architecture.md) ／ [02-ir-schema](02-ir-schema.md) ／ [03-engine](03-engine.md) ／ [04-adapters](04-adapters.md) ／ [05-app-electron](05-app-electron.md) ／ [06-sidecar-macos](06-sidecar-macos.md) ／ [08-glossary](08-glossary.md)

---

## 0. 一言で

`packages/storage` は **3つの独立した永続化レイヤ**を提供する。

1. **`FlowStore`** (`src/flow-store.ts`) — フロー1件 = 1ディレクトリ。`flow.json`(=IR本体) をファイルシステムに読み書き。バックエンドは素の `node:fs/promises`。
2. **`MetaStore`** (`src/sqlite.ts`) — `better-sqlite3` による project/flow/run のメタデータ用 SQLite ストア。**【重要】Phase 1 の Electron アプリ本体(`apps/hermes`)からはまだ一度もインスタンス化されていない**(後述 §8)。テストでのみ動作確認済み。
3. **`Vault`** (`src/vault.ts`) — 秘密情報を OS キーチェーン(`keytar`)に保管。テスト用に `InMemoryVaultBackend` を差し替え可能。

`src/index.ts` がこれらを公開する。SQLite に **フロー本体(steps等)は入らない** — SQLite は「メタ行 + インデックス」のみ、本体は常に `flow.json`(オンディスク)。

不変条件: **Node 22 必須**。既定の Node 26 では `better-sqlite3` のネイティブバインディングが落ちるため、`MetaStore` を触るビルド/テストは必ず Node 22 で走らせる(`@hermes/storage` の test も同様)。

---

## 1. ファイルマップ (パス → 責務)

| パス | 責務 |
|---|---|
| `packages/storage/src/index.ts` | 公開 re-export。後述 §6 |
| `packages/storage/src/flow-store.ts` | `FlowStore` クラス。フロー1件のディレクトリ構造・`flow.json` の原子的読み書き・asset 保存・削除・複製 |
| `packages/storage/src/sqlite.ts` | `MetaStore` クラス + 行の型(`ProjectRow`/`FlowRow`/`RunRow`)・SQL スキーマ・スキーマバージョン管理 |
| `packages/storage/src/vault.ts` | `VaultBackend` interface・`Vault` クラス・`InMemoryVaultBackend`・`lazyKeytarBackend()`(keytar の遅延・CJS アンラップ) |
| `packages/storage/test/storage.test.ts` | 上記3つの単体テスト(vitest)。Vault は InMemory backend で検証 |
| `packages/storage/package.json` | deps: `better-sqlite3@^11.7.0`, `keytar@^7.9.0`, `@hermes/ir`(workspace) |
| `packages/storage/vitest.config.ts` / `tsconfig.json` | テスト/型設定 |

`package.json` の `exports` はサブパス import を許す:
```jsonc
".": "./src/index.ts",
"./sqlite": "./src/sqlite.ts",
"./flow-store": "./src/flow-store.ts",
"./vault": "./src/vault.ts"
```
実際に `apps/hermes/src/main/run-controller.ts` は `@hermes/storage/flow-store` から `FlowStore` を、`@hermes/storage`(barrel) から `Vault` を import している。

---

## 2. FlowStore — フローのファイルシステム永続化

### 2.1 ディレクトリレイアウト

`FlowStore` は `rootDir`(= フロー群の親。アプリ側では `<dataRoot>/flows`)を受け取り、フロー1件 = `<rootDir>/<flowId>/` を以下の構造で管理する(冒頭コメントの通り):

```
flows/<flowId>/
  flow.json            -- IR本体(@hermes/ir の Flow)
  meta.json            -- name, createdAt, updatedAt (SQLiteのミラー) ※【未確認】下記参照
  variables.json       -- ※【未確認】下記参照
  assets/              -- スクリーンショット・image-selector テンプレート等
  browser-profile/     -- Playwright/Chromium プロファイル(cookie, localStorage)
  history/
    run-<runId>.jsonl.gz
```

**【未確認】**: ソースコメントは `meta.json` / `variables.json` / `history/run-<id>.jsonl.gz` を列挙するが、`FlowStore` の**メソッドはこれらを生成・読み書きしていない**(`init()` が作るのは `assets/` `browser-profile/` `history/` の3ディレクトリのみで、`history` 内のファイル書き込みも本ファイルには無い)。これらはレイアウト予約(将来用)か、別モジュールが書く想定。現状コードで実際に書かれるのは `flow.json` と `assets/<name>` のみ。

### 2.2 パス算出メソッド(全て純粋・副作用なし)

```ts
class FlowStore {
  constructor(public readonly rootDir: string) {}
  flowDir(flowId: string): string          // <rootDir>/<flowId>
  flowJsonPath(flowId: string): string      // <flowDir>/flow.json
  assetsDir(flowId: string): string         // <flowDir>/assets
  browserProfileDir(flowId: string): string // <flowDir>/browser-profile
  historyDir(flowId: string): string        // <flowDir>/history
}
```

### 2.3 公開 CRUD API(関数シグネチャ)

```ts
async init(flowId: string): Promise<void>
async writeFlow(flow: Flow): Promise<void>
async readFlow(flowId: string): Promise<Flow>
async writeAsset(flowId: string, fileName: string, data: Buffer): Promise<string>
async deleteFlow(flowId: string): Promise<void>
async duplicateFlow(srcFlowId: string, dstFlow: Flow): Promise<Flow>
```

- **`init(flowId)`**: `flowDir` と `assets/` `browser-profile/` `history/` を `mkdir({recursive:true})` で作る。冪等。
- **`writeFlow(flow)`**: 内部で `init(flow.id)` を呼んでから、**原子的書き込み**(`flow.json.tmp` に `JSON.stringify(flow, null, 2)` を書き、`rename` で本体に差し替え)。書き込み途中クラッシュで壊れた `flow.json` を残さないため。フローID は `flow.id` を使う(引数のフローオブジェクトが持つ)。
- **`readFlow(flowId)`**: `flow.json` を読み `JSON.parse` → **`assertValidFlow(parsed)`**(`@hermes/ir`、[02](02-ir-schema.md))で検証してから `Flow` を返す。不正な JSON / スキーマ違反は throw。
- **`writeAsset(flowId, fileName, data)`**: `assets/` を `mkdir(recursive)` してから `data`(Buffer)を書く。**戻り値は `assets/<fileName>` という相対参照**(絶対パスではない)。IR の image-selector `assetRef` 等はこの相対形で保存され、実行時に `__hermes_assets_dir__`(= `store.flowDir(flowId)`)を基準に解決される(run-controller §490付近)。
- **`deleteFlow(flowId)`**: `rm(flowDir, {recursive:true, force:true})`。**冪等**(存在しなくても成功扱い。`force:true`)。
- **`duplicateFlow(srcFlowId, dstFlow)`**: `srcFlowId` の `flow.json` を読み、`{...original, id: dstFlow.id, name: dstFlow.name, metadata: {...original.metadata, ...dstFlow.metadata}}` で新フローを作り `writeFlow`。**`browser-profile/` と `history/` は意図的にコピーしない**(複製フローが元のセッション cookie / 実行ログを引き継いで「新規実行に見えるのに元のセッションが漏れる」事故を防ぐため)。`dstFlow` から消費するのは **id / name / metadata のみ**(他フィールドは無視。run-controller §203 のコメント参照)。

### 2.4 IR との (de)serialize

- **シリアライズ**: `JSON.stringify(flow, null, 2)` のみ。IR(`Flow`)は素の JSON 互換オブジェクトなので変換層は無い。インデント2スペースで人間が読める形。
- **デシリアライズ**: `JSON.parse` → `assertValidFlow`(zod ベースの検証、[02](02-ir-schema.md))。スキーマバージョンは IR 側の `CURRENT_SCHEMA_VERSION = '1.0'`(`packages/ir/src/schema.ts`)が `flow.schemaVersion` に入る。
- **マイグレーション/バージョニング**: `FlowStore` 自体には**マイグレーション機構は無い**。バージョン管理は (a) IR の `flow.schemaVersion`(前方互換のための予約)と (b) SQLite の `meta` テーブル(§3.4)に二分されている。`flow.json` の旧バージョン変換ロジックは現状存在しない(`schemaVersion` を見て分岐するコードは無い)。

---

## 3. MetaStore — SQLite メタストア (better-sqlite3)

> **【重要】このクラスは Phase 1 の Electron アプリ本体からは未使用**(§8)。テストでのみ動作。フロー一覧は実際には `FlowStore` の `flows/` ディレクトリ走査で作られている(run-controller の `listFlows`)。本節は「将来の配線先」と「テスト済みの契約」として読むこと。

### 3.1 役割と方針
冒頭コメント:「project/flow/run の行とインデックスを持つ。フロー本体(steps 等)は `flow.json`(ディスク)にあり、SQLite 行はメタデータのみ」。

### 3.2 行の型(公開)

```ts
interface ProjectRow { id; name; createdAt; updatedAt; }  // すべて string

interface FlowRow {
  id: string; projectId: string; name: string;
  description: string | null;
  origin: 'recorded' | 'ai-generated' | 'mixed';
  schemaVersion: string;
  createdAt: string; updatedAt: string;
  diskPath: string;   // flow ディレクトリへの絶対/相対パス。UNIQUE 制約
}

interface RunRow {
  id: string; flowId: string;
  startedAt: string; endedAt: string | null;
  outcome: 'running' | 'success' | 'failure' | 'aborted';
  logPath: string | null;
}
```

### 3.3 テーブル / スキーマ(`SCHEMA_SQL`)

- `projects(id PK, name, createdAt, updatedAt)`
- `flows(id PK, projectId → projects(id), name, description, origin, schemaVersion, createdAt, updatedAt, diskPath UNIQUE)` + `idx_flows_project(projectId)`
- `runs(id PK, flowId → flows(id), startedAt, endedAt, outcome, logPath)` + `idx_runs_flow(flowId)` + `idx_runs_started(startedAt)`
- `meta(key PK, value)` — KV(スキーマバージョン格納)

全テーブル `CREATE TABLE IF NOT EXISTS`。`FOREIGN KEY` は `pragma('foreign_keys = ON')` で有効化、WAL モード(`journal_mode = WAL`)。

### 3.4 スキーマバージョニング
```ts
const META_DB_VERSION_KEY = 'db.schemaVersion';
const META_DB_VERSION_VALUE = '1';
```
コンストラクタが `upsertMeta('db.schemaVersion', '1')` を毎回実行。**マイグレーション分岐は未実装**(現状は常に '1' を書くだけ)。将来スキーマを変えるなら、この値を読んで `if (current < N) migrate()` を入れる場所。

### 3.5 公開 API(シグネチャ)
```ts
class MetaStore {
  constructor(dbPath: string)   // dirname(dbPath) を mkdirSync(recursive) してから open
  close(): void

  upsertProject(row: ProjectRow): void   // ON CONFLICT(id) → name/updatedAt 更新
  listProjects(): ProjectRow[]            // ORDER BY updatedAt DESC

  upsertFlow(row: FlowRow): void          // ON CONFLICT(id) → name/description/origin/updatedAt/diskPath 更新
  listFlows(projectId?: string): FlowRow[] // projectId 指定で絞り込み。ORDER BY updatedAt DESC
  getFlow(id: string): FlowRow | undefined

  createRun(row: RunRow): void
  finishRun(id, outcome, endedAt, logPath?): void  // endedAt/outcome/logPath を UPDATE
  listRuns(flowId: string, limit = 50): RunRow[]    // ORDER BY startedAt DESC LIMIT

  getMeta(key: string): string | undefined
  // upsertMeta は private
}
```
注意: `upsertFlow` の `ON CONFLICT` は `createdAt` を**更新しない**(初回値を保持)。`schemaVersion` も更新句に無い。

---

## 4. Vault — 秘密情報の OS キーチェーン保管

### 4.1 概念
- **service 文字列**(キーチェーンのサービス名)で名前空間を分ける。`DEFAULT_SERVICE = 'dev.hermes.app'`。
- **account 名**(キーチェーンのアカウント)= 秘密情報のスコープ名。例: `'openrouter.apiKey'`, `'password'`。
- `InMemoryVaultBackend` は内部 `Map` のキーを `` `${service}:${account}` `` で名前空間化する(キーチェーンの service/account 2軸を1つの文字列キーに畳む)。本物の keytar では service/account は別引数。

### 4.2 `VaultBackend` interface
```ts
interface VaultBackend {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, value: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
  findCredentials(service: string): Promise<Array<{ account: string; password: string }>>;
}
```
keytar の API シグネチャと一致(差し替え可能にするための薄い抽象)。

### 4.3 `Vault` クラス
```ts
interface VaultOptions { service?: string; backend?: VaultBackend; }

class Vault {
  constructor(opts: VaultOptions = {})   // service=DEFAULT_SERVICE, backend=lazyKeytarBackend()
  get(account: string): Promise<string | null>
  set(account: string, value: string): Promise<void>
  delete(account: string): Promise<boolean>
  list(): Promise<Array<{ account: string }>>   // findCredentials の結果から password を落とす
}
```
- `list()` は **account 名のみ**返す(password は含めない)。UI(`VaultPanel`)は値を一切表示しない設計と整合。
- backend 未指定なら `lazyKeytarBackend()`(本物のキーチェーン)。テストは `new Vault({ backend: new InMemoryVaultBackend() })`。

### 4.4 `InMemoryVaultBackend`(テスト/ヘッドレス用)
`Map<string,string>` 実装。キーは `` `${service}:${account}` ``。`findCredentials(service)` は `` `${service}:` `` プレフィックス一致で account を切り出す。テスト(`storage.test.ts`)は set→get→list→delete→get(null)の往復を検証済み。

### 4.5 【最重要・落とし穴】keytar の CJS default アンラップ
`lazyKeytarBackend()` 内:
```ts
const mod = (await import('keytar')) as unknown as { default?: VaultBackend } & VaultBackend;
loaded = (mod.default ?? mod) as VaultBackend;
```
- **keytar は CommonJS**(`module.exports = { ... }`)。ESM の `await import('keytar')` で読むと、メソッド群が namespace 直下ではなく **`.default` 配下**に来る(`cjs-module-lexer` が名前付き export を検出できないため)。
- したがって **`mod.default ?? mod` でアンラップ必須**。怠ると実行時に `findCredentials is not a function`(または `getPassword is not a function`)で落ちる。**過去に実際に発生・修正済み**(本コミット `b3d5fa6` のメッセージ "fix(storage): unwrap keytar's CJS default export in the lazy vault backend" がまさにこの修正)。
- `?? mod` のフォールバックは、CJS default を既にアンラップ済みのバンドラ環境向け保険。
- keytar は**遅延 import**(`ensure()` で初回アクセス時に1度だけ読む)。理由: テスト/ヘッドレス環境ではネイティブバインディングが無いことがあり、別 backend を注入する限り import 自体を発生させないため。

---

## 5. 秘密情報の往復(録画 → 保存 → 実行)

`apps/hermes` 側での Vault の使われ方([05](05-app-electron.md) の RunController と連動):

1. **録画時(保存)**: WebRecorder が password 系入力を拾うと、`run-controller.ts` の `recorder.on('step')` で `extractSecretName(e.step)`(`params.text` が `^\$\{secrets\.([^}]+)\}$` 正規表現にマッチするときその name)を取り、`vault.set(secretName, e.raw.value)` で**平文値をキーチェーンへ**書く。IR の step には参照 `${secrets.<name>}` だけが残る(値は IR に入らない)。
2. **実行時(読込)**: `runStart` → `collectSecretRefsInFlow(flow)` で flow 全体(steps/children/branches)を走査し参照名を集め、各 `name` について `vault.get(name)` で値を取得して `secrets: Record<string,string>` を作り、`new StepExecutor({ registry, providers, secrets })` に渡す(run-controller §461–504)。Executor が dispatch 時に `${secrets.<name>}` を補間([03](03-engine.md))。未登録の秘密は空文字に解決され、ステップ自体は走る(何もタイプしないだけ)。

---

## 6. 公開 exports (`src/index.ts`)
```ts
export { MetaStore, type FlowRow, type ProjectRow, type RunRow } from './sqlite.js';
export { FlowStore } from './flow-store.js';
export { Vault, InMemoryVaultBackend, type VaultBackend, type VaultOptions } from './vault.js';
```
(import 拡張子は `.js` だが `package.json` の `exports`/`main` は `./src/*.ts` を指す = TS ソース直 import 構成)

---

## 7. アプリ(05 main)との対応 — Vault IPC

| 層 | 識別子 |
|---|---|
| IPC チャンネル(`shared/ipc.ts`) | `vault:list` / `vault:set` / `vault:delete`(定数 `IpcChannels.vaultList` 等) |
| IPC 契約(zod) | `VaultListResult = { entries: [{account}] }` / `VaultSetArgs = {account(1..256), value}` → `{ok:true}` / `VaultDeleteArgs = {account(1..256)}` → `{deleted:boolean}` |
| preload(`preload/index.ts`) | `window.hermes.vaultList()` / `vaultSet(account, value)` / `vaultDelete(account)` |
| main handler(`main/index.ts`) | `ipcMain.handle(vault:list/set/delete, …)` → `controller.vaultList/Set/Delete` |
| RunController passthrough(`run-controller.ts`) | `vaultList(): Promise<{account}[]>` / `vaultSet(account,value)` / `vaultDelete(account)` → 内部 `this.vault.*` |
| renderer UI | `renderer/components/VaultPanel.tsx`(account 名一覧のみ表示。値は出さない。追加/削除は in-app prompt) |

注意: `vault:list` の戻りは Vault クラスの `[{account}]` を main 側で `{ entries: [...] }` に包んでいる(IPC 契約 `VaultListResult` に合わせるため)。

### データ保存先パス(アプリ側 `main/flow-paths.ts`)
`FlowStore` の `rootDir` は `flowsRoot() = join(dataRoot(), 'flows')`。`dataRoot()` の解決順:
1. `process.env.HERMES_DATA_DIR`(テスト用 override)
2. パッケージ済みなら `join(app.getPath('userData'), 'data')`
3. 開発時(dev)は `resolve(process.cwd(), '.hermes-dev')`

つまり開発時の実体は `apps/hermes/.hermes-dev/flows/<flowId>/{flow.json, assets/, browser-profile/, history/}`(実ディレクトリで確認済み)。`.hermes-dev/` と `.hermes/` は `.gitignore` 済み。`.hermes-dev/settings.json` はアプリ設定([05](05-app-electron.md) の app-settings)で、storage パッケージの管轄外。**Vault の値は一切ディスクに出ない**(OS キーチェーンのみ)。

---

## 8. 変更ガイド(どこを触るか)

**新しい保存項目をフローに足す(flow.json 内)**
- IR スキーマ([02](02-ir-schema.md))を変える。`FlowStore.writeFlow/readFlow` は素の JSON なので通常**追加変更不要**(`assertValidFlow` が通れば良い)。破壊的変更なら `CURRENT_SCHEMA_VERSION`(`packages/ir/src/schema.ts`)を上げ、必要なら `readFlow` 内に旧→新変換を追加(現状マイグレーション層は無い=新設になる)。

**フロー以外のオンディスク成果物(meta.json/variables.json/history ログ等)を実装する**
- `FlowStore` にメソッドを追加(現状これらは write されていない、§2.1【未確認】)。`init()` が作るのは `assets/ browser-profile/ history/` のみ。

**新テーブル / 新カラムを SQLite に足す**
- `src/sqlite.ts` の `SCHEMA_SQL` に `CREATE TABLE IF NOT EXISTS …` を追加。既存テーブルのカラム追加は `IF NOT EXISTS` では効かないので `META_DB_VERSION_VALUE` を上げてコンストラクタにマイグレーション分岐(`ALTER TABLE`)を実装する。対応する `*Row` 型と `upsert*/list*` も更新。
- **前提**: そもそも `MetaStore` をアプリに配線する作業が先(現状 `apps/hermes` で `new MetaStore(...)` は存在しない)。配線するなら DB パスは `join(dataRoot(), 'meta.db')` 等が自然(`flow-paths.ts` に追加)。

**新しい秘密情報スコープを足す**
- 値は触らずに **account 名(文字列)を決めるだけ**。Vault 側は汎用 KV なのでコード変更不要。書く側(録画パスなら `extractSecretName` の正規表現/`run-controller`、手動なら `VaultPanel`)と、読む側(`collectSecretRefsInFlow` が `${secrets.<name>}` を拾える形で IR の params に入っていること)を合わせる。`account` は IPC で 1..256 文字制限。
- service を分けたい(別ネームスペース)なら `new Vault({ service: '...' })` で渡す。既定は `dev.hermes.app`。

**keytar 周りを触る**
- `lazyKeytarBackend()` の `mod.default ?? mod` を**絶対に外さない**(§4.5)。keytar をバージョンアップ/別ライブラリ(`@napi-rs/keychain` 等)に差し替える場合も、ESM/CJS interop を必ず実機(Electron)で確認すること。テストの InMemory backend は通っても本番で落ちる典型ポイント。

---

## 9. テストの状況(`test/storage.test.ts`、vitest)
- **FlowStore**: write/read 往復 / `writeAsset` の相対参照 / `deleteFlow` 冪等 / `duplicateFlow`(新 id・新 name で書かれ、元フローは不変)を検証。`tmpdir()` に `mkdtempSync` で隔離。
- **MetaStore**: project/flow/run の upsert→list→`finishRun` で outcome が `success` になることを検証。`join(tmp, 'meta.db')`。
- **Vault**: `InMemoryVaultBackend` で get(null)→set→get→list→delete→get(null)。**本物の keytar 経路(`lazyKeytarBackend`)はユニットテスト対象外**(ネイティブ依存のため)。§4.5 の回帰はテストで検知できない → 変更時は手動確認必須。

---

## 10. 不変条件・落とし穴(08-glossary 候補)
- **Node 22 必須**: `better-sqlite3` のネイティブバインディングは既定 Node 26 で落ちる。`@hermes/storage` のビルド/テストは Node 22 で。
- **keytar CJS アンラップ**(最重要・回帰実績あり): `await import('keytar')` はメソッドが `.default` 配下に来る → `mod.default ?? mod` でアンラップ必須。怠ると `findCredentials is not a function` で実行時クラッシュ(修正コミット `b3d5fa6`)。
- **Vault の値はディスクに出ない**: フロー(`flow.json`)には参照 `${secrets.<name>}` だけ。実値は OS キーチェーンのみ。`Vault.list()` も account 名しか返さない。
- **`duplicateFlow` は browser-profile / history を複製しない**(セッション漏洩防止の意図的設計)。
- **`writeFlow` は原子的**(tmp→rename)。`deleteFlow` は冪等(force)。
- **MetaStore は Phase 1 アプリ未配線**: フロー一覧は `flows/` ディレクトリ走査で動いている。SQLite を前提に何かを足す前に「実際に new されているか」を確認すること。

---

## 11. 【未確認】まとめ
- `meta.json` / `variables.json` / `history/run-<runId>.jsonl.gz` は `FlowStore` のレイアウトコメントに在るが、**現状コードでは生成・読み書きされていない**(§2.1)。レイアウト予約か別モジュール担当かは未確認。
- `MetaStore` を本番で初期化する箇所・DB ファイルパスは現状コードに存在しない(§8)。`.hermes-dev/` 配下に `meta.db` は実在しなかった。配線方針は未確定。
