# Windows 移行計画

> 前提: `00-tech-stack-decision.md` で **選択肢A（Electron+TSコア維持＋.NETサイドカー追加）** を決定済み。
> 本書は移行の計画。**実装はしない。** 移行は「.NETサイドカー1本 ＋ adapter の uia 実装 ＋ トランスポート差し替え」に局所化される。

---

## 結論（先に）

Windows対応で**書き直すのは OS 依存の最外殻だけ**。IR/Engine/Provider/recorder/ai（可搬TSコア 5,105行）は一切触らない。

新規・変更の範囲:

| 区分 | 対象 | 内容 |
|---|---|---|
| **触らない** | `packages/ir`, `engine`, `web-provider`, `recorder-web`, `ai` | そのまま Windows でも動く |
| **新規** | `sidecars/windows-native/`（C#/.NET） | UIA3 + SendInput + WinRT Capture でRPCサーバ実装 |
| **変更** | `packages/desktop-adapter` | `windows.ts` 実装、`uia` セレクタ解決、`sidecar-client` のトランスポート抽象化 |
| **変更** | `packages/storage/src/vault.ts` | keytar → Windows Credential Manager（補強3のインターフェース化が前提） |
| **変更** | `apps/hermes` ビルド | electron-builder に nsis/msi ターゲット追加 |

---

## サイドカーが実装すべきメソッド集合（macOS版と完全一致させる）

`packages/desktop-adapter/src/macos.ts` が呼ぶ RPC メソッド = Windows サイドカーが実装すべき契約（実測・約10個）:

| RPCメソッド | macOS実装 | Windows実装 |
|---|---|---|
| `mouse.click` / `mouse.move` / `mouse.position` | CGEvent | SendInput (MOUSEINPUT) |
| `keyboard.type` / `keyboard.combo` | CGEvent | SendInput (KEYBDINPUT) |
| `screen.capture` | ScreenCaptureKit | Windows.Graphics.Capture (WinRT) / BitBlt |
| `accessibility.elementAtPoint` | AXUIElementCopyElementAtPosition | UIA `ElementFromPoint` |
| `accessibility.listApps` / `frontmostApp` | NSWorkspace | EnumWindows / GetForegroundWindow |
| `accessibility.status` | AX権限チェック | UIA可用性チェック |

> 録画（CGEventTap 相当）は Windows では `SetWindowsHookEx`（低レベルマウス/キーフック）。録画用の追加メソッド群も同じ契約に載せる。

---

## Windows特有の難所と対策（判定パネルの key_risks より）

### 1. トランスポート: Unix Domain Socket → Named Pipe
- 現状 `sidecar-client.ts` は `node:net` の Unix Domain Socket 前提（`createConnection(socketPath)`）。
- Windows は **Named Pipe（`\\.\pipe\hermes-native`）** へ差し替え。`node:net` は named pipe も同API（パス形式が違うだけ）で扱えるため、**トランスポート抽象化を1箇所に集約**すれば吸収できる。
- → 補強2（RPC契約スキーマ化）と同時に、トランスポート層をOS分岐で抽象化する。

### 2. DPI / マルチモニタの座標整合（最優先で潰す）
- **Per-Monitor DPI v2** を宣言（manifest）。
- 3つの座標系を整合させる:
  - SendInput の絶対座標 = 0..65535 正規化（仮想デスクトップ基準）
  - WinRT Capture / スクショのピクセル座標
  - UIA `BoundingRectangle`（物理ピクセル）
- 「ウィンドウ相対座標 + DPI補正」を**両OSでユニットテスト**（PLAN.md が元々要求）。macOS先行のため現状Windows検証コードは無い → 移行の最初の山。

### 3. UAC / UIPI・セッション分離
- 非昇格プロセスは昇格アプリ（タスクマネージャ・一部業務系・インストーラ）へ SendInput/UIA が届かない（UIPI）。
- 無人実行（RPAの核）・ロック画面/RDP越し実行では、サイドカーの**昇格・常駐・セッション設計**が忠実度を左右する。
- 対策の方向: サイドカーを必要時に昇格起動 / Windowsサービスとして常駐 / セッション分離に対応した入力注入経路。詳細設計は移行フェーズで詰める。

### 4. UIAが取れないアプリ → 画像/OCRフォールバックが本命
- 古いWin32・Electron系・Javaアプリは UIA でツリーが取れない。
- → **screen層(image/ocr/coords)の実行系（機能ロードマップ P1）を移行前に用意するのが必須**。これが無いとWindows忠実度は「行儀の良いアプリ」に限定される。

### 5. キー / 修飾キーの論理マッピング
- キーは仮想キーコードではなく**名前**で保持（PLAN.md準拠）。`primary` = Windowsでは Ctrl、macでは Cmd。
- サイドカー側で論理名 → OS仮想キーへの変換テーブルを持つ。

### 6. ネイティブモジュールの Windows ビルド
- `better-sqlite3` / `keytar` は Windows でも動くが ABI リビルドが要る（electron-builder が処理）。`keytar` は Vault インターフェース化（補強3）で Credential Manager 実装に差し替え可能にしておく。

---

## サイドカー契約の適合テスト（bit-for-bit再現を守る要）

- RPC契約（メソッド名・params・座標系規約・キー名規約）を **zod スキーマで固定**。
- **両OSで同一RPC入力に同一の意味の応答**を返すことを保証する適合テスト（conformance test）を CI に積む。
- これが無いと、Windowsサイドカーが微妙にズレて「macで作ったフローがWinで再現しない」回帰として表面化する。

---

## 移行フェーズ（順序）

> 各フェーズのゴールは「動く証拠 / 再現テスト」で締める（CLAUDE.md の Goal-Driven）。

| # | フェーズ | 内容 | 検収ゴール |
|---|---|---|---|
| 0 | 地ならし | 補強2（RPC契約 zod化＋適合テスト）／補強3（Vaultインターフェース化）／トランスポート抽象化 | macOSで既存全テスト緑のまま、契約スキーマが両OS分岐を吸収 |
| 1 | screen層実行系（両OS） | image/ocr/coords の探索実行（機能ロードマップ P1）。macで先行実装し契約確定 | macで画像クリック/OCR読取の統合テストが通る |
| 2 | .NETサイドカー雛形 | C#プロジェクト、Named Pipe、ping/pong、権限/可用性チェック | `hermes-native ping` がWindowsで疎通 |
| 3 | 入力・キャプチャ | SendInput（mouse/keyboard）、WinRT Capture、UIA elementAtPoint | 単一アプリで click/type/capture がWindowsで動く |
| 4 | UIA要素ツリー | UIA3 でツリー取得、`uia` セレクタ解決、`desktop-adapter/windows.ts` | AXで作ったフローのuia版がWindowsで要素を引ける |
| 5 | DPI/マルチモニタ/UAC | 座標整合・DPI補正・昇格/セッション設計 | マルチモニタ＋高DPIでクリック座標が正しい、昇格アプリ対応方針確定 |
| 6 | 録画（Windows） | SetWindowsHookEx で録画 → IR | Windowsで簡単な操作を録画→再生 |
| 7 | 配布 | electron-builder nsis/msi、（無人運用なら）サービス常駐ラッパ | Windowsインストーラ生成、自前ビルド手順をREADMEに追記 |
| ✓ | 検収 | macOSで作った素のフローをWindows実機で再生成功 | bit-for-bit 近い再現を確認 |

---

## 触らないことの確認（不変条件）

- 「操作はEngine→Providerのみ／AIは操作しない／決定論IRでbit-for-bit再現／OS依存はDesktopAdapter配下に隔離」は移行後も保持。
- Windows実装は **DesktopAdapter契約の実装差し替え**であり、Engine/IRには触れない。
