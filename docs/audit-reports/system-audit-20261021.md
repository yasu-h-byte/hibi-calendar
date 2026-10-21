# システム全体総点検 2026-10-21（整合性・読み込み速度・古いコードの刷新）

代表の依頼:「機能を順次継ぎはぎで追加しているので、整合性が取れているかあらゆる角度から総点検したい。あわせて読み込みの高速化と、
古いコードのモダン化もしたい」

4 つの角度（権限と認証／サーバの読み込み／業務ロジックの整合性／古いコードとデッドコード）から全ファイルを読み、
点検の前後でテスト 1,469 件・型検査・ESLint・各 lint（firestore / utc / px / dialog / pay / tobi）が通ることを確かめた。
実在の人の給与額は書かない。

---

## 1. 結論（先に要点）

| 角度 | 結果 |
|---|---|
| 権限・認証 | **認証のない API は 0 本**。給与の三重の鍵（役割＋本人・画面の入口・許可リスト）は守られている。直したのは中 4 件・低 7 件 |
| 読み込み速度 | **画面の JS に Firebase Web SDK（約 100KB）が 14 画面で混ざっていた**のが最大の無駄。切り出して約 4 割減。サーバは人員マスタ（260KB）の読み直しを 1 回に |
| 業務ロジック | 人工の数え方・承認ゲート・請求の期間・85% などの定数は 1 か所に集約されていて一貫。ズレは「締めの判定の仕方」と「承認できる日」に集中（直した） |
| 古いコード | 使われていない関数 40 件・ファイル 3 本・API 3 本を削除。残る大物は「画面の生 fetch 154 行」「role 直書き 53 行」「巨大ファイル 5 本」 |

今回の PR で直したものは §3、代表の判断が要るものは §4、次に進める作業は §5。

---

## 2. 現状の規模

| 項目 | 数 |
|---|---|
| TypeScript ファイル | 315 本（約 93,000 行） |
| API ルート | 76 本 → 73 本（3 本削除） |
| 画面 | 34 画面 |
| テスト | 128 ファイル・1,471 件（点検前 1,388 件） |
| 最大のファイル | lib/compute.ts 3,608 行 → 4 本に分割（最大 1,585 行）、app/(app)/evaluation/page.tsx 2,698 行（未分割・§7） |

---

## 3. 直したもの（この PR）

### 3-1. 画面の読み込み（最大の効果）

**原因**: `lib/compute.ts`・`lib/workers.ts`・`lib/attendance.ts`・`lib/locks.ts` が「純粋な計算」と「Firestore を読む関数」を
同じファイルに持っていた。画面（'use client'）がこれらを import すると、使っていない Firestore 読みの関数ごと
Firebase Web SDK（圧縮後 約 100KB）がクライアント JS に載る。実際に画面で Firestore を読む所は一つも無い
（サーバーは Admin SDK・画面は API 経由）。`lib/fsdb.ts` 冒頭の「クライアントから絶対に import しない」が破られていた。

**対処**: Firestore を読む関数を `lib/*.server.ts` に切り出した（計算・型は元のまま。import 先だけ 58 ファイルで書き換え）。

| 元 | 切り出し先 | 移した関数 |
|---|---|---|
| lib/compute.ts | lib/compute.server.ts | getMainData・getAttData・getAttDataCached・getMultiMonthAttData・loadMonthlyAllowances |
| lib/workers.ts | lib/workers.server.ts | getWorkers・getWorkerByToken |
| lib/attendance.ts | lib/attendance.server.ts | setAttendanceEntry・承認の読み書き・getStaffSites など 13 本 |
| lib/locks.ts | lib/locks.server.ts | checkMonthLockedForWorkers・loadLockContext |

**効果**（`next build` の初回読み込み JS）:

| 画面 | 前 | 後 |
|---|---|---|
| 出面（PC） | 230KB | 140KB |
| 山岡への請求書 | 237KB | 129KB |
| 応援の請求書 | 225KB | 118KB |
| 人員マスタ | 215KB | 126KB |
| 評価 | 213KB | 124KB |
| スマホ出面（管理） | 202KB | 112KB |
| 設定・現場・書類庫・賃金・賃金分析・補償 | 195〜209KB | 106〜120KB |

**再発防止**: `__tests__/clientBundleIsolation.test.ts`。画面と部品 82 本の静的 import をたどり、firebase / xlsx / pdfjs / server-only に
届いたら落ちる。

### 3-2. サーバの読み込み

- **人員マスタ（demmen/main・約 260KB）の直読みを getMainData（30 秒キャッシュ）に統一**: getWorkers・getStaffSites・getForemanSite・
  getForeignWorkersForSite・getSites・heartbeat・subcons・tool-budget・calendar-matrix・foreman-todo・スマホ出面。
  スマホ出面・職長の画面・マイページが 1 リクエストで main を 2〜3 回読んでいたのが 1 回に。
  出面グリッドの保存（セルごと・4 並列）で呼ぶ締めの判定だけは、意図して読み直す（締めた直後に古い状態で通らないため）
- **スマホ出面の有給残**: 当月・前月の出面は既に読んだものを使い回し（同じ att を二度読まない）、確定月はキャッシュ版
- **通知ベル**: 5 分ごと → 10 分ごと、タブが隠れている間は止める。確定月の出面キャッシュを 5 分 → 30 分。
  旧はポーリングと TTL が同じ 5 分で、毎回最大 37 か月ぶん（約 2.5GB/日/台）を読み直していた。クォータ超過障害（2026-07-02）の再発リスクの筆頭だった

### 3-3. 守り（画面で止めている操作はサーバでも同じ判定で止める）

| 何を | 旧 | 新 |
|---|---|---|
| 職長スマホの 1 日承認 | 日付を見ていない（未来の有給が入った日を承認できた） | approvalDateError（先の日・実在しない日は承認しない） |
| まとめ承認（職長スマホ・マイページ） | 31 日までを無条件に通す | 同上（PC と同じ関数で判定） |
| 有給の承認・取消・日付変更の締め判定 | 30 秒キャッシュの人員マスタ（締めた直後は古い状態で通る） | 読み直して人の会社で判定 |
| 時季指定・帰国・長期帰国の締め判定 | 会社が undefined だと「両社とも締めたときだけ」拒否 | 人の会社で判定（loadLockContext・人員マスタは 1 回だけ読む） |
| 会社なしでも呼べた checkMonthLocked | 残っていた | 削除（呼べない） |
| 出面グリッドの GET | 職長が任意の現場を読めた（画面が絞っているだけ） | POST と同じ checkGridForemanScope |
| /api/settings の既定単価 | ログインしていれば職長でも読めた | masters.view（/api/sites の伏せ方とそろえた） |
| 就業カレンダーの承認・差し戻し・提出・取消の「誰が」 | 画面が送る body の値を記録（自己申告） | 通行証から決める（署名台帳・同意台帳の根拠） |
| ログイン画面 | 通行証が返らなければ生パスワードを保存する逃げ道 | 通行証が無ければログイン失敗 |
| lib/jp-wage-history.ts | 実在する社員の年収額を含むのに server-only の目印なし | .server.ts に改名（画面から import するとビルドが止まる・postbuild の検査対象） |

### 3-4. 依存・古い書き方

- next 14.2.28 → 14.2.35、eslint-config-next 14.2.35、firebase-admin 14.1 → 14.5（npm audit の指摘分）
- `xlsx` を外し `xlsx-js-style` に一本化（同じ SheetJS 0.18 系・API 互換・二重に同梱していた）
- app/layout.tsx の viewport を metadata から分離（Next 14 の書き方）
- 使われていない関数・定数 40 件、ファイル 3 本（lib/repositories の 2 本と index）、API 3 本（jp-wage/seed・calendar/reset・
  debug/inspect-home-leave）を削除。本番 ID 直書きの一回限りの移行スクリプト 4 本を scripts/archive/ へ

残る npm audit の指摘: next の「self-hosted の Image Optimizer」（Vercel で next/image を使っていないので該当しない）、
firebase Web SDK の grpc（サーバーのフォールバック専用・本番は Admin SDK）。どちらもメジャー更新が要るので §5 の Next 15 と一緒に。

---

## 4. 代表の判断（2026-10-21「全部おすすめで」→ すべて実施・PR #131）

| # | 件 | 決定と実施内容 |
|---|---|---|
| 1 | 人員マスタの給与欄の適用開始日に締めチェック | ✅ 時給・日額・月給の「この日から」が締め済みの月以降なら 409（先に締めを解除）。号俸の改定と同じ判定を lib/locks.server.ts lockedMonthsFrom に集約 |
| 2 | 待機料だけの日も請求の承認ゲートに | ✅ invoiceDaysOf（人工のある日＋待機料の日）。発行・承認は承認をキャッシュなしで読み直す |
| 3 | 経営コックピットの「確定」 | ✅ `locked: { hibi, hfu }`（月次の締め）を渡す項目を追加。closed はそのまま。docs/integration.md に追記 |
| 4 | ログイン API の試行回数制限 | ✅ 15 分で 10 回失敗したら 15 分 429（lib/login-throttle.server.ts・Firestore `loginThrottle`・IP はハッシュ・読めなければ止めない） |
| 5 | SESSION_SECRET の設定確認 | ✅ /api/health に `sessionSecret`（専用の鍵が使われているか）を出す。未設定なら代表が Vercel で設定（全員ログインし直し） |
| 6 | 月締めに有給精算の未処理 | ✅ ④⑤と同じ形で ⑥ として止める（先に承認・却下してから締める） |
| 7 | 画面の role 直書き・直接承認 | ✅ 権限表に calendar.forceApprove（代表）を足し、画面もサーバも同じ判定に。旧はサーバが事業責任者でも通していた。見せ方の判定はそのまま |

## 5. 第 2 弾（同じ PR・2026-10-21 夜）で済ませたもの

| # | 作業 | 結果 |
|---|---|---|
| 1 | 有給の承認・日付変更・時季指定の出面書き込みを writeAttendanceEntry に | ✅ 変更履歴に残り、最終承認済みの日は事業責任者・代表だけ。テストの「未移行」例外を外した。帰国（home-leave-sync）は月まとめの reconcile なので対象外のまま |
| 2 | 退職日の自前比較 → isEmployedOn / isAlreadyRetired | ✅ 7 か所。lint:retired に日付比較の検出を追加 |
| 3 | 画面の生 fetch → fetchWithAuth | ✅ 150 か所・41 ファイル。lint:auth（新設）で再発を落とす。localStorage 直読み 39 行は未着手（§6） |
| 4 | 重複ヘルパー | ✅ 円表示 17 か所 → fmtYen / fmtYenOrDash、JST 変換 12 か所 → jstIsoOf / jstYmOf / jstWallClock（lint:utc に検出追加）。HFU 判定は未着手（§6） |
| 5 | 操作ログの actor | ✅ 固定 'admin' 約 50 か所 → actorLabel(request)（通行証から） |
| 6 | 通知ベル | ✅ 読む月を「使う月」だけに（37 → 13〜16 か月）。直列 getDocs の並列化と /api/leave の 48 か月読みは未着手 |
| 7 | approvalGap・/api/monthly | ✅ 承認を「現場×月」の範囲クエリ 1 回に（テスト 2 件追加）。/api/monthly の読みを並列に |

## 6. 第 3 弾（同じ PR・2026-10-22）で済ませたもの

| # | 作業 | 結果 |
|---|---|---|
| 1 | localStorage の 'hibi_auth' 直読み 39 行 | ✅ readAuth / saveAuth / clearAuth（lib/hooks/useAuthPassword.ts）に。lint:auth で直読みも落とす |
| 2 | HFU 判定の自前実装 | ✅ 20 か所＋同じ関数の定義 4 か所 → lib/locks.ts orgKeyOf |
| 3 | /api/leave GET の 48 か月読み | ✅ 確定月は 30 分キャッシュ（getMultiMonthAttData に cachedForClosed）。残数の検証は読み直したまま |
| 5 | 巨大ファイルの分割 | ✅ lib/compute.ts 3,330 行 → 4 本（compute / compute-monthly / compute-overtime / compute-vn-salary）、lib/export.ts 1,959 行 → 5 本（export / export-attendance / export-subcon / export-monthly / export-labor）。計算・帳票の中身は変えず、golden master を含むテストは変更なしで合格 |
| 7 | 画面の role 直書き | ✅ 権限表と完全に同じ組み合わせの 7 か所を can() に（invoice.approve / calendar.approve / wage.view / wage.decide）。残りは「職長の画面の見せ方」の判定で、権限ではない |

## 7. 残っているもの（性質が違うので別に進める）

| # | 件 | なぜ今回やらなかったか | 進め方 |
|---|---|---|---|
| 1 | 有給・欠勤だけの索引ドキュメント（leaveIndex） | Firestore に新しいコレクションを作り、全出面から一度作る移行を本番で流す必要がある（本番データの書き換え＝代表の OK が要る）。索引と出面がずれたときの直し方も決めてから | 設計を 1 枚にして代表の OK → 移行スクリプト → 書き込み側（writeAttendanceEntry）で二重更新 → 読む側を順に切り替え |
| 2 | app/(app)/evaluation/page.tsx（2,698 行）のタブ分割・app/attendance/[token]/page.tsx のフォーム共通化 | 画面の中身を動かす変更で、Preview で実際に触って確かめないと安全と言えない（テストは画面を見ない） | 画面ごとに 1 PR。Preview で代表が一通り触る |
| 3 | Next 15 / ESLint 9 / firebase 13 | メジャー更新で、動き（キャッシュ・リクエストの扱い）が変わる。今回の整理が本番で落ち着いてから | 別 PR・Preview で全画面確認 |
| 4 | 就業カレンダーの「提出なしで直接承認」（canForceApprove）の権限表への追加 | 権限表に該当する能力が無い（代表だけの操作）。能力を増やすかは代表の判断 | §4-7 と一緒に |
| 5 | 通知ベルの直列 getDocs の並列化 | 10 分ごとの裏の処理で、人の待ち時間に効かない | 気が向いたときで可 |

## 8. Preview での動作確認（2026-10-21・代表の Chrome で Claude が実施）

代表でログインした Preview（PR #130）で、全 23 画面を開いて API の応答（すべて 200）・画面のエラー表示（なし）・コンソールのエラー（なし）を確かめた。
操作: 現場マスタと人員マスタの保存（変更なしで保存 → 閉じる）、出面の「変更履歴」「一括入力」「配置」のモーダル、帳票 10 種類の出力
（出面一覧 日比/HFU・月次集計 Excel・歩掛・有給管理簿・現場別・勤務予定・実労働・同意台帳・管理簿 Excel）、スタッフのスマホ API、
マイページの最終承認（先の日 → 「先の日なので、まだ承認できません」・実在しない日 → 「実在しない日です」で止まる）、
職長スマホの 1 日承認（同じ 2 つの判定で止まる）、就業カレンダーの承認ボタン（代表に出る）。

**見つけて直したもの**: 出面の「変更履歴」が月を指定すると 500（本文なし）になっていた。`where('ym') + orderBy('at')` に要る
Firestore の複合インデックスが無いため。**本番でも同じ**（production で再現）。月の絞り込みだけで読んで手元で並べ替える形に直した
（コミット 417b64a）。

**代表に残す確認**: 出面のセルを 1 つ保存する（本番データが変わるので Claude はしなかった）、休暇管理の時季指定を 1 件、締め・発行はしない。
