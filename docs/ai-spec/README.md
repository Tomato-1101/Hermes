# Hermes AI仕様書（索引）

> 最終更新: 2026-05-31 ／ 対象コミット: b3d5fa6 (feat/phase-1-completion)

## このディレクトリは何か

**コーディングAI（将来のセッションの Claude 等）が、Hermes のソース全体を読まなくても「どこに何があり・どう動き・どこを変えればよいか」を把握するための仕様書**です。
コードベースが大きく、毎回フルスキャンするのは非効率なので、ここに構造・契約・不変条件・落とし穴を凝縮してあります。

**読む順番（AI向け）:**
1. まずこの README で全体像と該当ファイルの当たりを付ける。
2. 触る領域の専用ファイル（01〜08）を読む。
3. それでも足りない実装詳細だけ、該当ソースを開く。

人間向けの操作説明は別物（[../manual/operation-guide.md](../manual/operation-guide.md)）。こちらは「アプリの使い方」、本ディレクトリは「コードの設計」。

---

## ファイル索引

| ファイル | 内容 | 主なソース |
|---|---|---|
| [01-architecture.md](01-architecture.md) | monorepo の全体像。12プロジェクト一覧と状態、プロセス境界、ビルド/テスト/開発コマンド、tsconfig/electron-vite、record→IR→保存→replay のデータフロー、変更ガイド。 | `pnpm-workspace.yaml` / 各 `package.json` / `electron.vite.config.ts` |
| [02-ir-schema.md](02-ir-schema.md) | **最重要**。IR の全データ構造。Flow / Step（全26型）/ TargetRef / Selector（11種）/ WaitForKind（9種）/ 制御構造の入れ子表現 / 式 / 検証(ajv)。末尾にステップ型早見表。 | `packages/ir/src/*` |
| [03-engine.md](03-engine.md) | 実行エンジン。StepExecutor の実行ループ、ステップ・ディスパッチ、ターゲット解決の委譲、式評価、if/loop/try の実行、wait/wait_for、retry/onError/timeout、RunEvent。 | `packages/engine/src/*` |
| [04-adapters.md](04-adapters.md) | プロバイダ/アダプタ層。web-provider（Playwright）/ desktop-adapter（Swiftサイドカー）/ recorder-web（記録）/ excel-provider。StepHandler 契約、セレクタ解決、記録→IR変換。 | `packages/{web-provider,desktop-adapter,recorder-web,excel-provider}/src/*` |
| [05-app-electron.md](05-app-electron.md) | Electron アプリ。プロセスモデル、`window.hermes` ブリッジ、IPCチャネル完全カタログ（24本+pushイベント）、main 各ファイル、Zustand store、コンポーネント構成、変更ガイド。 | `apps/hermes/src/{main,preload,renderer,shared}/*` |
| [06-sidecar-macos.md](06-sidecar-macos.md) | macOS Swift サイドカー。JSON-RPC 全メソッド（23）、UDS トランスポート、ビルド/起動、必要権限（アクセシビリティ/画面収録/入力監視）、desktop-adapter との対応。python-vision の現状。 | `sidecars/macos-native/Sources/HermesNative/*` |
| [07-storage-vault.md](07-storage-vault.md) | 永続化。FlowStore（`flow.json`）/ MetaStore（better-sqlite3、※本体未使用）/ Vault（keytar/キーチェーン）。秘密情報の往復、keytar CJS 落とし穴。 | `packages/storage/src/*` |
| [08-glossary.md](08-glossary.md) | 横断リファレンス。用語集、プロジェクト全体の不変条件（環境/IR/操作/エンジン/アプリ/永続化）、**既知の不整合・未実装（要注意）**の集約。 | （全体） |

### まず押さえるべき不変条件（詳細は [08](08-glossary.md)）
- **Node 22 必須**（既定 Node 26 で better-sqlite3 が落ちる）。ビルドは `pnpm --filter @hermes/app build`、型は `tsc --noEmit -p apps/hermes/tsconfig.json`。
- import は `.js` 拡張子付き。Renderer に自動テスト無し。
- 秘密は IR にインライン禁止（`${secrets.*}` 参照のみ）。engine は Vault に触れない。
- keytar は `mod.default ?? mod` でアンラップ必須（怠ると実行時クラッシュ）。
- 新規 IPC は4点セット（`shared/ipc.ts` → main 登録 → preload 公開 → renderer 呼び出し）。

---

## 全体像（record → 保存 → replay）

```
[記録]
 Web:  ブラウザ(注入スクリプト, recorder-web) ──イベント──▶ main(desktop-recorder/run-controller)
 App:  Swiftサイドカー(recording.* poll) ───────────────▶ main
                                                           │ IR の Step に変換
                                                           ▼
[編集]  renderer(React/Zustand) ◀──IPC──▶ main ──▶ FlowStore(flow.json) に保存
                                                           │
[再生]  renderer ──run:start──▶ main(run-controller) が ${secrets.*} を解決し
                               engine(StepExecutor) を起動
                                  │ layer で振り分け
            web ──▶ web-provider(Playwright)
            desktop ─▶ desktop-adapter ──JSON-RPC/UDS──▶ Swiftサイドカー(hermes-native)
            screen ─▶ desktop-adapter(screen handlers) ─▶ サイドカー(capture/findImage/ocr)
                                  │ RunEvent(run:step 等)
                                  ▼
                          main ──hermes:event──▶ renderer(タイムライン強調・実行ログ)
```

詳細な責務分担は各ファイルへ。プロセス境界は [01](01-architecture.md) §2、IPC は [05](05-app-electron.md) §2、RPC は [06](06-sidecar-macos.md) §3。

---

## 更新ルール（重要 / このディレクトリの存在意義）

このドキュメントは**作業が進むたびに頻繁に更新する**前提の「生きた仕様書」です。古い仕様書はコードを読む以上に有害なので、次を徹底すること。

1. **コードを変えたら、同じ作業（PR/コミット）内で対応する仕様ファイルも更新する**。「あとでまとめて」はしない。
   - どのファイルを直すかは上の索引「主なソース」列で判断。例: `packages/engine/` を触ったら [03](03-engine.md)、新 IPC を足したら [05](05-app-electron.md)、新ステップ型なら [02](02-ir-schema.md) + 波及先（03/04/05）。
2. 変更した仕様ファイル先頭の `> 最終更新` 日付と、必要なら `対象コミット` を更新する。この README の日付も合わせる。
3. **不整合・未実装に気づいたら [08](08-glossary.md) §3「既知の不整合・未実装」に追記**。直したらその項目を消す。
4. 新しいパッケージ/サイドカー/プロセスを足したら、索引表に1行追加し、[01](01-architecture.md) のプロジェクト一覧にも反映する。
5. 「【未確認】」と書いた点は、確認できたら確定記述に書き換える。
6. 記述は必ず実コードに基づく。憶測でAPI/型/フラグを足さない。書けない推測は「【未確認】」のまま残す。

> AI へのお願い: Hermes のコードを変更するセッションでは、関連する仕様ファイルの更新を**タスクの一部**として扱うこと（別作業にしない）。
