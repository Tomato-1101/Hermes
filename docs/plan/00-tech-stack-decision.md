# 技術スタック再評価と決定（計画）

> 問い（ユーザー）: 「今はWebアプリをローカル(Electron)に落としただけ。複雑化＋Windows主戦場化に、本当にこの技術スタックで良いのか。ちゃんと考えて。」
>
> 本書はその判断。**実装はしない。** 判定は5レンズの独立アーキテクト評価（自動化忠実度 / 移行コスト・TS再利用 / 長期保守性 / 配布・運用 / RPA製品要件）＋実コード実測に基づく。

---

## 結論（先に）

**現行スタックを維持する（選択肢A）。土台は既に正しい。書き直さない。**

判定パネルは **満場一致でA**（平均 4.5/5・推薦4/4票、B/C/D は推薦0票）。

そのうえで、**3つの戦略的補強**を「機能を増やす前の地ならし」として行う:

1. **実行体とUIの分離** — Engine/IR を Electron から切り離し、単独の Node CLI ランナー（`hermes run flow.json`）として動くようにする。→ ヘッドレス/無人/サービス/スケジュール実行の土台になり、将来のUI殻差し替えも可能になる。
2. **サイドカーRPC契約のスキーマ化** — JSON-RPC 契約を zod で版管理し、両OSの適合テストを置く。→ 「bit-for-bit再現」をWindows実装で割らないため。
3. **Vault のインターフェース化** — `keytar`/Electron 依存を1ファイルに封じる。→ コアの可搬性（最大の資産）を死守し、CLIランナーでも動くように。

---

## ユーザーの問題意識への直接回答

「Webアプリをローカルに落としただけ」— **半分正しい。が、見るべきは"層"の分離。**

Hermes は2層でできている:

| 層 | 中身 | 性質 | 評価 |
|---|---|---|---|
| **外側の殻** | Electron + React UI | OS非依存だが重い。差し替え可能。 | ここが「Webアプリ感」の正体。後でTauri/WebView2に載せ替え可能。**今は変えない。** |
| **内側の頭脳** | 決定論IR + Engine + Provider + AI層（TS） | OS非依存・言語非依存の状態機械。**製品の魂。** | ここが本当の資産。UiPath/PADが持たない差別化点。**絶対に壊さない。** |

ユーザーの直感「Windows主戦場ならネイティブ(.NET)に寄せるべき」は、**このレンズでは逆**。
Windows自動化の忠実度を実際に縛るのは**サイドカー内部の問題**（後述の3点）であって、UIシェルの言語ではない。だから .NET 全面移行が得る忠実度の上積みはほぼゼロで、代わりに頭脳（Engine/IR/Playwright）を失う。

→ **「Windowsに寄せる ＝ ネイティブ化」ではなく「Windowsに寄せる ＝ .NETサイドカーだけネイティブ、頭脳はTSのまま」が正解。**

---

## 実測で裏づけられた事実（なぜAが正しいか）

- **可搬TSコアは 5,105 行**（ir 1,160 / engine 572 / web-provider 863 / recorder-web 593 / ai 628 / storage 378 / desktop-adapter 911）。このうち **Electron/keytar に依存するのは `packages/storage/src/vault.ts` ただ1ファイル**。コアはほぼ完全にOS・シェル非依存。
- **Engine は OS を知らない**（`packages/engine/src/executor.ts` の import は mitt / @hermes/ir / registry / retry のみ）。Provider は opaque handle 経由で構造分離。
- **OS依存はサイドカー境界の外に隔離済み**。`packages/desktop-adapter/src/sidecar-client.ts` が JSON-RPC over Unix Domain Socket、`macos.ts` は薄いRPCクライアントに過ぎない。Windowsが実装すべきメソッドは約10個に局所化されている（`mouse.click/move/position`, `keyboard.type/combo`, `screen.capture`, `accessibility.elementAtPoint/listApps/frontmostApp/status`）。
- **`DesktopAdapter` インターフェース**（`packages/desktop-adapter/src/index.ts`）と **`uia` セレクタ枝**（`packages/ir/src/schema.ts`）は最初からOS差し替え点として設計済み。これは PLAN.md フェーズ4そのもの。

→ Windows対応で**新規に書く価値があるのは .NETサイドカーだけ**。IR/Engine/Provider/recorder/ai の書き直しはゼロ。ゴールデンIR再生テストもそのまま使える。

---

## 選択肢比較（A〜D）

| | A: Electron維持+Winサイドカー | B: Tauri移行 | C: .NETネイティブ全面 | D: ハイブリッド |
|---|---|---|---|---|
| 自動化忠実度 | ◎（サイドカー次第で天井=C同等） | ○ | ◎ | ○ |
| TS資産再利用/移行速度 | ◎（書き直しゼロ） | △ | ✕（全移植） | ○ |
| 長期保守性 | ◎ | ○ | △ | △（多プロセス境界） |
| 配布/フットプリント | △（Electron肥大） | ○ | ○ | ○ |
| クロスプラットフォーム | ◎ | ○ | ✕（mac放棄） | △ |
| リスク | 低 | 中 | 高（魂の再証明） | 中 |
| 判定平均(5点) | **4.5** | 2.5 | 1.75 | 2.75 |

### なぜ C（.NET全面移行）が罠か
- Engine/IR/jsep式/Step Library/recorder/ai（5,105行）を C# へ移植 = **決定論IRの bit-for-bit 再現を別言語ランタイムで再実装・再証明する純損失**。
- 移植バグが「bit-for-bit再現」という不変条件を静かに破壊する。CIのゴールデンIRテストも積み直し。
- Playwright級のWeb録画資産を失う。mac を捨てる前提も方針と衝突。
- **得る忠実度の上積みはほぼゼロ**（忠実度はサイドカーで決まるため）。代償だけ甚大。

### なぜ B（Tauri）が費用対効果低いか
- 主目的は「フットプリント削減」だが、Tauri(Rust)は Node を内包しないため、**Playwright(Node)・better-sqlite3・keytar というネイティブNode資産を同梱せざるを得ず、削減目的が骨抜き**。
- 検証済みのTS信頼性をシェル移行でリセットする分、忠実度に何も足さずリスクだけ増える。
- ソース配布/自前ビルド方針（PLAN.md）では配布最適化の優先度がそもそも低い。

### なぜ D（ハイブリッド）が中途半端か
- .NETホスト ⇔ TSサービス ⇔ webview の**三層プロセス境界**が増える。入力割込みガード（低レベルフック）・録画・フォーカス制御がプロセスを跨ぐと、レース条件とデバッグ難度が最も上がる。Aの「JSON-RPC一線」より境界が多い。

---

## Windows忠実度の真の律速（シェルではなくサイドカー内部）

判定パネルが繰り返し指摘した、**どの選択肢でも残る**3つの本質課題。Windows移行の主戦場はここ（詳細は `01-windows-migration.md`）:

1. **UIAが取れないアプリ向けの画像/OCRフォールバック品質** — 古いWin32・Electron系・Javaアプリは UIA でツリーが取れない。→ **screen層(image/ocr/coords)の実行系が事実上の本命**。これは IR定義済みだが**未実装**＝現状の最大の律速（`docs/research/robopat-vs-hermes-gap.md` の P1）。
2. **DPI/マルチモニタの座標整合** — SendInput の正規化座標(0..65535/仮想デスクトップ基準)、WinRT Capture、UIA BoundingRectangle が別々のDPIスケール。整合させないと「画像で見つけた座標が別モニタを叩く」。
3. **UAC/UIPI・セッション分離下の入力注入** — 昇格アプリへは非昇格プロセスから SendInput/UIA が届かない。無人実行・ロック画面・RDP越しでの注入は、サイドカーの昇格/常駐設計が忠実度を左右する。

---

## 補強1の意義: 実行体とUIの分離（最重要の前向き提言）

判定パネル（配布・運用レンズ）の結論: **配布の本当の勝ち筋は「殻の言語選定」ではなく「実行体とUIの分離」。**

- Engine/IR/web-provider を Electron から切り離し、単独 Node CLI ランナー（`hermes run flow.json --vars=...`）として切り出す。
- これにより:
  1. **無人実行・サービス常駐・スケジュール実行**を UI と無関係に提供できる（RPA製品の核）。
  2. 将来 **Tauri でも WebView2 でも殻を載せ替え可能**になる（Electron肥大が嫌になっても安全に逃げられる）。
  3. 配布の本命＝**軽量ヘッドレス実行体**を、UI殻の重さと独立に最適化できる。
- これは PLAN.md フェーズ5の「スケジューラ / CLIランナー」を**前倒しで土台化**する位置づけ。

---

## 決定事項のまとめ

| 項目 | 決定 |
|---|---|
| シェル | **Electron 維持**（変えない） |
| コア | **TS Engine/IR/Provider/ai を維持**（一切移植しない） |
| Windows自動化 | **.NET(C#)サイドカーを新規追加**（UIA3 + SendInput + WinRT Capture） |
| 補強1 | 実行体(Engine)とUI(Electron)を分離 → CLIランナー化 |
| 補強2 | サイドカーRPC契約を zod でスキーマ化＋両OS適合テスト |
| 補強3 | Vault をインターフェース化（keytar依存を封じる） |
| 投資先 | シェル論争ではなく**サイドカーの深さ**（UIA→画像→OCRフォールバック階層、DPI補正、UAC対応） |
| 将来の逃げ道 | 実行体分離さえしておけば、UI殻だけ後で Tauri/WebView2 に載せ替え可能（今はやらない） |

→ 次は `01-windows-migration.md`（移行計画）、`02-ui-overhaul.md`（UI刷新）、`03-feature-roadmap.md`（機能一覧計画）。
