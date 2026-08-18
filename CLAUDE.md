# Hermes プロジェクト指示（Claude Code 用）

このファイルは Hermes リポジトリ固有の規約。グローバルの `~/.claude/CLAUDE.md`（言語=日本語、結論先行、曖昧な指示は AskUserQuestion で聞く、Surgical Changes、勝手に commit しない等）を**前提として継承**し、矛盾しない範囲で Hermes 固有の事項を足す。

---

## 0. 最初に読むもの（最重要）

**コードを読み始める前に、まず [`docs/ai-spec/README.md`](docs/ai-spec/README.md) を読むこと。**
Hermes はコードベースが大きい。`docs/ai-spec/` に、全体像・各サブシステムの構造・契約・不変条件・既知の落とし穴を凝縮した「AI仕様書」がある。これを読めば、ソース全体をフルスキャンせずに「どこに何があり・どう動き・どこを変えるか」が分かる。

- 全体像と索引: `docs/ai-spec/README.md`
- 用語・不変条件・既知の不整合: `docs/ai-spec/08-glossary.md`
- 触る領域に応じて 01〜07 の該当ファイルを読む（索引参照）。

## 1. 仕様書の更新義務（このプロジェクト固有）

`docs/ai-spec/` は**頻繁に更新する生きた仕様書**。古い仕様はコードを読む以上に有害。

- **コードを変更したら、同じ作業（PR/コミット）内で対応する仕様ファイルも更新する。** 別作業にしない。タスクの一部として扱う。
  - どのファイルを直すかは `docs/ai-spec/README.md` の索引「主なソース」列で判断。
  - 例: `packages/engine/` を触ったら `03-engine.md`、新 IPC を足したら `05-app-electron.md`、新ステップ型なら `02-ir-schema.md` + 波及先（03/04/05）。
- 不整合・未実装に気づいたら `08-glossary.md` §3 に追記。直したらその項目を消す。
- 変更した仕様ファイル先頭の `> 最終更新` 日付（と必要なら対象コミット）を更新する。

## 2. ビルド・テスト・型チェック（必ずこの形で）

- **Node 22 必須。** 既定の Node 26 では `better-sqlite3` が落ちる。各コマンド実行前に:
  ```
  export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
  ```
- アプリのビルド: `pnpm --filter @hermes/app build`（electron-vite）。**`npx electron-vite build` は禁止**（グローバルの別バージョンを引いて失敗する）。
- アプリの型チェック: `tsc --noEmit -p apps/hermes/tsconfig.json`（単一 tsconfig）。
- パッケージのテスト: 各 package で `pnpm --filter <name> test`（例 `@hermes/engine` / `@hermes/storage` 等、vitest）。
- 開発起動: `pnpm --filter @hermes/app dev`（electron-vite dev、renderer devserver は http://localhost:5173）。
- **Renderer（`apps/hermes/src/renderer/`）に自動テストは無い。** 検証は tsc + build + 目視（実機確認はユーザーが行う）。

## 3. すぐ踏む落とし穴（詳細は `docs/ai-spec/08-glossary.md`）

- **import は `.js` 拡張子付き**で書く（`moduleResolution: bundler` + `verbatimModuleSyntax`）。`.ts`/`.tsx` ソースでも `.js`。
- **keytar は CommonJS。** `await import('keytar')` するとメソッドが `.default` 配下に来るので **`mod.default ?? mod` でアンラップ必須**。怠ると実行時に `findCredentials is not a function` でクラッシュ（`packages/storage/src/vault.ts` 参照）。
- **新規 IPC は4点セット**で追加: ① `apps/hermes/src/shared/ipc.ts` にチャネル定義 → ② main にハンドラ登録 → ③ preload で公開 → ④ renderer から呼ぶ。チャネル名文字列の直書きは禁止（`ipc.ts` が唯一の真実）。
- **秘密情報を IR にインラインしない**。`${secrets.<name>}` 参照のみ。実値は Vault（OS キーチェーン）にのみ保存。engine は Vault に触れない（app が事前解決して注入）。
- macOS ネイティブ操作は Swift サイドカー（`hermes-native`、JSON-RPC over Unix Domain Socket）経由。RPC 契約は `packages/desktop-adapter/src/rpc-contract.ts` と Swift 側を lockstep で保つ。
- ネイティブ依存（better-sqlite3/keytar/electron 等）を足したら `pnpm-workspace.yaml` の `allowBuilds` を更新（CI が `ERR_PNPM_IGNORED_BUILDS` で落ちる）。

## 4. スコープ・現在地

- 現在は **Phase 1 = Mode 1**（決定的 RPA・AI 不使用・「記録→編集→再生」を macOS で完成）。計画は `docs/plan/04-phase-1-finalization.md`、全体計画は `docs/PLAN.md`。
- `@hermes/ai` / `@hermes/cli` / `@hermes/ui-kit` / `sidecars/python-vision` は Phase 1 では未配線/スタブ（`08-glossary.md` §3 参照）。「実装済み」と仮定しない。
- 競合分析等の参考資料は `docs/research/`（コミット可）と `docs/references/`（gitignore）。

## 5. Git（グローバル規約に加えて）

- 既定ブランチは `main`。`main` への直接 push 禁止（feature ブランチ経由）。`git commit` はユーザーが明示依頼したときのみ。
- `git add -A` / `git add .` は避け、対象ファイルを明示する。
