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
| テスト | 128 ファイル・1,469 件（点検前 1,388 件） |
| 最大のファイル | lib/compute.ts 3,608 行 → 3,330 行、app/(app)/evaluation/page.tsx 2,698 行 |

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

## 4. 代表の判断をお願いするもの

| # | 件 | 内容 | 影響 |
|---|---|---|---|
| 1 | 人員マスタの給与欄の変更に締めチェックがない | rateFrom / hourlyRateFrom / salaryFrom を締め済み月の途中日にすると、按分で締めた月の支給額が変わる。号俸の改定（jp-wage/revision）には同じチェックがある | 中。「締め済み月以前の *From は 409」にするか |
| 2 | 待機料だけの日は請求の承認ゲートの対象外 | invoiceApprovalGap は人工 > 0 の現場×日だけ見る。HFU → 日比建設 の待機料（0.6補・人工 0）の日は、職長承認・最終承認がなくても請求できる | 中。待機の日もゲートに含めるか |
| 3 | 経営コックピットの「確定」の意味 | integration の closed は「前月より前か」で、締め（locks）を見ない。帳票の【未確定】は締めで判定 | 中。locked を返す項目を足して docs/integration.md に約束を追記するか |
| 4 | ログイン API の試行回数制限 | 公開エンドポイントに回数制限がない。1 回の試行で保存済み全員分の scrypt を回す | 中。Vercel WAF のレート制限か、失敗回数を数えて 429 |
| 5 | SESSION_SECRET の設定確認 | 未設定だと通行証の鍵が「パスワードそのもの」。設定した瞬間に全員がログインし直しになる | /api/health に hasDedicatedSessionSecret を出して確認 |
| 6 | 月締めの前提に「有給精算の未処理申請」 | 締めは有給申請・帰国申請の pending は見るが、leaveSettle の pending は見ない | 低。⑥として同じ形で数えるか |
| 7 | 画面の role 直書き → 権限表 | calendar.page の `user.role === 'admin'` 18 行など 53 行。表では calendar.edit = 職長・代表なのに save-days/submit は事業責任者も通す | 権限の意味を 1 件ずつ確認する必要あり |

---

## 5. 次に進める作業（優先順）

| # | 作業 | 大きさ | 守り |
|---|---|---|---|
| 1 | 有給の承認・時季指定・帰国の出面書き込みを writeAttendanceEntry（変更履歴＋最終承認済みガード）に通す | 中 | attendanceWriteEntry.test の例外を外す |
| 2 | 退職日の自前比較（`w.retired && iso > w.retired` 10 か所）を isEmployedOn に。lint:retired に日付比較を足す | 小 | lint |
| 3 | 画面の生 fetch 154 行・localStorage 直読み 39 行 → fetchWithAuth / useAuthPassword（hook に saveAuth / clearAuth を足す） | 大（画面ごと） | 新しい lint:auth |
| 4 | 円表示 17 か所 → fmtYen、JST 手書き 8 か所 → date-utils、HFU 判定 25 ファイル → orgs.ts | 小〜中 | lint:utc に Asia/Tokyo を足す |
| 5 | 操作ログの actor 固定 'admin'（約 60 か所）→ 通行証から | 中 | — |
| 6 | 通知ベルの月の絞り込み（有効な付与期間だけ・13〜15 か月）と直列 getDocs の並列化、/api/leave の 48 か月読み | 中 | — |
| 7 | approvalGap を「現場×日ごとの getDoc」から範囲クエリ（現場×月）に。/api/monthly の直列 5 RTT を並列に | 中 | goldenSynthetic |
| 8 | 有給・欠勤だけの軽い索引ドキュメント（leaveIndex/{workerId}）で出面の大量読みを根治 | 大 | 移行スクリプト |
| 9 | 巨大ファイルの分割（compute.ts 5 本・evaluation/page.tsx タブごと・export.ts 5 本・attendance/[token] のフォーム共通化） | 大 | golden master |
| 10 | Next 15 / ESLint 9 / firebase 13 への更新 | 大（最後） | — |

---

## 6. 確かめて問題なかったもの（網羅性のため）

- **権限**: 76 本の API すべてに認証あり。給与を返す API はすべて pay.view 系。workers / sites / evaluation の GET は許可リスト方式。
  画面 27 本すべて PAGE_CAPS に載り、テストが足し忘れを落とす。Firestore / Storage ルール（本番の実物）は deny-by-default
- **通行証**: HMAC-SHA256・timingSafeEqual・期限付き。個人通行証はパスワードの指紋入りで変更・削除で失効。API はパスワードそのものを受け付けない
- **人工の数え方**: calcManDays 1 か所（p/r/h/hk/exam = 0・夜勤 1.5）を鳶換算・応援明細・山岡の検算が共有
- **承認ゲート**: 本人確認・月締め・応援/HFU/山岡の請求が同じ approvalGap と FINAL_APPROVAL_REQUIRED_FROM_YM を共有
- **期間**: 山岡は primePeriodOf（前月 21 日〜当月 20 日）1 か所、月単位は billingPeriodOf 1 か所
- **定数**: 85%・道具半額 2.5 万・精算の月 24 日・PAY_VIEWER は 1 か所定義
- **キャッシュ**: getMainData の無効化（registerMainWriteHook）、getAttDataCached の呼び出し 4 か所すべてが isClosedMonthYm で守られている
- **日付**: lint:utc の対象パターンは 0 件（手書きの JST 変換が 8 か所残る → §5-4）
