# Firestore データ構造

## プロジェクト
- Firebase プロジェクト: dedura-kanri
- 旧アプリとの接続: **完全遮断済み**（旧アプリの保存機能を無効化）

## コレクション・ドキュメント

### demmen/main
メインドキュメント。全マスタデータを格納。

| フィールド | 型 | 説明 |
|-----------|-----|------|
| workers | array | スタッフ一覧（RawWorker[]） |
| sites | array | 現場一覧（RawSite[]） |
| subcons | array | 外注先一覧（RawSubcon[]） |
| assign | map | 現場→スタッフ配置 |
| massign | map | 月別配置（レガシー） |
| plData | map | 有給データ（workerId → PLRecord[]） |
| homeLeaves | array | 帰国期間レコード（後述） |
| billing | map | 売上データ |
| workDays | map | 月別所定日数 |
| siteWorkDays | map | 現場別月別所定日数 |
| locks | map | 月締め状態 |
| defaultRates | map | デフォルト単価 |
| mforeman | map | 月別代理職長 |
| nightDays | map | 夜勤が発生した日 `{ "siteId_YYYYMM": [11, 12] }`。出面画面で夜勤バッジを出す日を絞るUIフィルタ。給与計算・所定日数には影響しない（誰が夜勤したかはエントリの `ns`） |
| nextWorkerId | number | 次のワーカーID |
| companyProfile | map\|null | 応援の請求書の発行者情報（`CompanyProfile`。2026-09-25）。設定画面「請求書の自社情報」で編集。未設定なら請求書は発行できない（`docs/peer-invoice.md`） |

#### MainData.homeLeaves

```typescript
homeLeaves?: {
  id?: string
  workerId: number
  workerName?: string
  startDate: string   // YYYY-MM-DD
  endDate: string     // YYYY-MM-DD
  reason?: string
  note?: string
}[]
```

「本日の稼働状況」の休みリストから帰国中スタッフを除外する用途で参照。判定は `main.homeLeaves` と `homeLongLeave` コレクションの両方を OR で参照する（過渡期の二重管理）。

#### RawWorker フィールド（workers 配列の各要素）

| フィールド | 型 | 説明 |
|-----------|-----|------|
| id | number | ワーカーID |
| name | string | 名前 |
| org | string | 所属（hibi / hfu） |
| visa | string | 在留資格（none / jisshu1〜3 / tokutei1〜2） |
| job | string | 職種（yakuin / shokucho / tobi / doko / jimu） |
| rate | number | 日額単価 |
| hourlyRate | number? | 時給（外国人用） |
| otMul | number | 残業倍率（デフォルト1.25） |
| hireDate | string | 入社日（YYYY-MM-DD） |
| payrollNo | string? | キャシュモ（給与計算委託先）管理の従業員番号。社員番号(id)とは別。提出用帳票（月次集計Excel・出面一覧・勤務予定シフト・実労働時間明細・計算根拠PDF）に載せる（2026-09-17） |
| retired | string? | 退職日（YYYY-MM-DD） |
| salary | number? | 月給 |
| visaExpiry | string? | 在留期限（YYYY-MM-DD） |
| dispatchTo | string? | 出向先名（空=通常勤務、値あり=出向中） |
| dispatchFrom | string? | 出向開始月（YYYY-MM、空=全期間出向扱い） |

#### RawSite フィールド（sites 配列の各要素・主要項目）

| フィールド | 型 | 説明 |
|-----------|-----|------|
| id | string | 現場ID |
| name | string | 現場名 |
| workSchedule | map? | 現場別勤務時間（後述） |

##### Site.workSchedule

```typescript
workSchedule?: {
  startTime: string                                            // 例: '07:30'
  endTime: string                                              // 例: '16:30'
  morningBreak:   { enabled: boolean; minutes: number; mandatory: boolean }
  lunchBreak:     { enabled: boolean; minutes: number; mandatory: boolean }
  afternoonBreak: { enabled: boolean; minutes: number; mandatory: boolean }
}
```

未設定の現場は従来通り 8:00〜17:00、午前30分・昼60分・午後30分のデフォルト。IHI現場は 7:30〜16:30 で設定済み。`lib/compute.ts` の月次集計、`types/index.ts` の `calcActualHours` / `calcOvertimeHours` がこの値を参照する。

### demmen/att_YYYYMM
月別出面データ。

| フィールド | 型 | 説明 |
|-----------|-----|------|
| d | map | 個人出面 key: `{siteId}_{workerId}_{ym}_{day}` → `{w, o, p, s}` |
| sd | map | 外注出面 key: `{siteId}_{subconId}_{ym}_{day}` → `{n, on}` |

### siteCalendar/{siteId}_{ym}
就業カレンダー。

| フィールド | 型 | 説明 |
|-----------|-----|------|
| siteId | string | 現場ID |
| ym | string | YYYY-MM |
| days | map | 日付→dayType（work/off/holiday） |
| status | string | draft/submitted/approved/rejected |

### calendarSign/{workerId}_{ym}_{siteId}
カレンダー署名。

### leaveRequests/{workerId}_{date}
有給申請。

| フィールド | 型 | 説明 |
|-----------|-----|------|
| workerId | number | 申請者ID |
| date | string | 取得希望日（YYYY-MM-DD） |
| status | string | `pending` / `approved` / `rejected` / `cancelled` |
| createdAt | string | 申請日時 |
| approvedBy | string? | 承認者 |
| approvedAt | string? | 承認日時 |
| cancelledAt | string? | 取り消し日時 |

- ドキュメントIDは `{workerId}_{date}` の固定キー（重複排除）
- `status=cancelled` または `status=rejected` のレコードは同じ日付で再申請時に上書きされる
- 重複チェック条件: `status !== 'rejected' && status !== 'cancelled'` の既存レコードがあるときのみエラー
- **Firestoreルール**: `allow read, write: if true`

### homeLongLeave/{auto}
帰国（長期休暇）申請。`leaveRequests` 同様に `status` に `cancelled` を含む。スタッフは pending のみスマホから取り消し可能。

### workerPhotos/{workerId}
スタッフの顔写真（2026-08-03 追加）。名前と顔が一致しない問題への対応。

| フィールド | 型 | 説明 |
|-----------|-----|------|
| dataUri | string | 正方形160px・WebP(不可ならJPEG)のデータURI。12〜25KB程度 |
| updatedAt | string | 更新日時（ISO） |
| bytes | number | dataUri の文字数（容量監視用） |

- **`demmen/main` の workers 配列には絶対に入れない。** main は全画面が高頻度で読む
  ドキュメント（`getMainData` の30秒キャッシュ越し）で、画像を混ぜると全ページの
  転送量が跳ね上がり、1ドキュメント1MBの上限にも当たる
- **公開URLを作らない。** 顔写真は個人情報。公開カレンダー・署名ページはログイン不要で
  誰でも開けるため、`public/` 配下や署名なしの Storage URL に置いてはいけない。
  読み書きは `/api/workers/photo`（要認証）経由のみ
- 縮小はブラウザ側（`lib/avatar-image.ts`）で行い、元の大きな写真は保存しない。
  容量だけでなく、必要以上の解像度の顔写真を持たないほうがプライバシー上も安全
- 表示は `components/WorkerAvatar.tsx`。写真が無い人は名前の先頭1文字を丸で表示するので
  全員分そろっていなくてもレイアウトが崩れない
- **日次バックアップの対象外**（`app/api/backup/snapshot` のコレクション一覧に入れていない）。
  写真は再取得できる一方、含めるとバックアップ容量が跳ね上がるため
- 退職者の写真は人員マスターの編集画面から手動で削除する（自動削除は誤消去のリスクがあるため入れていない）

### activityLog/{auto}
アクティビティログ。

### announcements/{auto}
お知らせ（ダッシュボード表示用）。

### evaluations/{workerId_evaluationDate}
評価データ（複数評価者対応）。

### peerInvoices/{auto}
応援の請求書（2026-09-25・`docs/peer-invoice.md`）。「発行」した瞬間の金額・出面明細・宛先・
自社情報をまるごと凍結したスナップショット。`demmen/main` には入れない独立コレクション。

| フィールド | 型 | 説明 |
|---|---|---|
| `no` | string | `${接頭辞}-${ym}-${連番}`（例 `HC-202609-01`）。会社をまたいで月内で連番 |
| `companyId` / `companyName` | string | 宛先の同業者（取引先マスタの id） |
| `ym` | string | 対象月 YYYYMM |
| `period` | `{from,to}` | 請求対象期間（月初〜月末） |
| `company` | `{postal,address,honorific}` | 発行時点の宛先スナップショット |
| `issuer` | `CompanyProfile` | 発行時点の自社情報スナップショット（`main.companyProfile`） |
| `lines` | 配列 | 現場×鳶/土工の行（`siteId,siteName,role,days,rate,amount`） |
| `detail` | 配列 | 現場ごとの出面明細マトリクス（人×日） |
| `subtotal` / `tax` / `total` | number | 税抜・消費税（10%・円未満切り捨て）・税込 |
| `dueDate` | string | 支払期日（取引先の支払条件から算出・土日祝は前営業日） |
| `status` | `'issued'\|'void'` | 取り消しても行は残る（欠番のまま・再利用しない） |
| `issueDate` / `issuedAt` / `issuedBy` | | 発行日・発行時刻・発行者 |
| `voidedAt` / `voidedBy` / `voidReason` | | 取り消し時のみ |

読み書きは `lib/peer-invoice-store.ts`。日次バックアップ（`app/api/backup/snapshot`）の対象外
（他の業務系コレクションと同様。財務記録としての保全は Firestore 標準の耐久性に依る）。

## ロール判定
- workerId === 1 → approver（政仁さん、ハードコード）
- jobType === 'jimu' → jimu
- 現場のforemanに設定 → foreman
- それ以外 → admin

## 現場の単価と「受取割合」（2026-09-11 追記）

`sites[].rates[]`（期間別 `tobiRate`/`dokoRate`）は現場マスタ「単価」タブで入力する。
当社が実際に受け取る1人工の額（`tobiBase`/`dokoBase`）は `lib/compute.ts getSiteRates` が
`siteBaseRatio(site)` を掛けて返す。

| `siteType` | 単価タブの意味 | 受取割合 |
|---|---|---|
| `direct` / 未設定 | 常用単価（元請け・山岡経由） | 0.85（`INTERMEDIARY_BASE_RATIO`） |
| `support`（応援） | **受取単価**（元請けを介さない直接支払い。28,000・30,000 等をそのまま入力） | 1.0 |

`tobiBase` の使われ先: 原価・収益ページの請求単価基準（`billingPerManDayBaseline`）、
実売上未入力月の概算売上の単価（`avgSite || avgAll || tobiBase`）、現場マスタ一覧の表示。
月々の実売上（`billing`）は従来どおり手入力で、この係数は掛からない。

## 取引先マスタ・請負体制・工種サイト（2026-09-15）

### 取引先マスタ（`demmen/main.subcons`）
- 旧「外注先マスタ」をそのまま使う（id 不変）。`roles: ('gc'|'prime'|'peer'|'subcon')[]` を追加。未設定は `subcon` 扱い
- 元請=gc、一次=prime、同業（二次・人を貸し借り）=peer、外注（専門業者）=subcon。出面の外注に配置できるのは peer/subcon
- 定義と判定は `lib/companies.ts`
- `postal` / `address` / `honorific` / `paymentTerms`（2026-09-25）: 応援の請求書の宛名用。
  gc/prime/peer の編集画面にのみ表示。`paymentTerms = { closing: 'end', payMonthOffset: 1|2, payDay: number|'end' }`。
  詳細は `docs/peer-invoice.md`

### 現場の請負体制（`sites[]`）
| フィールド | 意味 |
|---|---|
| `gcId` / `primeId` | 元請・一次（取引先 id） |
| `ownerId` | 担当の二次。`'self'` = 自社、それ以外は同業者の取引先 id |
| `siteType` / `client` | 保存時に自動導出（self → direct・請求先=一次、同業 → support・請求先=同業者）。受取率 85%/100% は従来どおり `siteType` で決まる |

### 工種サイト（`sites[]` の `parentId` / `workType`）
- 単価が工事の種類（鉄骨・仮設など）で変わる現場だけ、親現場の下に作る。出面・配置・受取単価（`rates`）・借りる単価（`assign[id].subconRates`）は工種サイトの id で持つ
- **親から引き継ぐ**: 工期・職長（`foreman` と月別 `mforeman`）・勤務時間・請負体制 → `/api/sites` が親の保存時に子へ書き写す（`INHERITED_FIELDS`）
- **親のものを読む**: 就業カレンダー（`siteCalendar`・`siteWorkDays`）と署名 → `lib/site-hierarchy.ts` の `calendarSiteIdOf` / `withWorkTypeSiteCalendars`。
  適用箇所: `computeMonthly` の入口、`loadMainData` の siteWorkDays、`isScheduledWorkDay`、出面グリッド・スタッフ画面のカレンダー取得、
  カレンダー・署名の現場一覧（`buildSitesWithWorkers`・`loadCalendarMatrix`。工種サイトの配置者は親の署名対象）、通知・サイドバーの未作成／未署名カウント、勤務予定シフト Excel
- 工種サイトが残っている親現場は削除できない。工種の下に工種は作れない
- 同業者別の請求・支払一覧: `lib/peer-statement.ts`・`/api/peer-statement`・画面 `/peer-statement`（相殺しない。請求=応援現場の工種ごとの人工×受取単価、支払=外注原価）

### 工種の出し分け（出面入力で工種を選ぶ・2026-09-25）

同じ現場でも担当する工事によって単価が違うケース（鉄骨と仮設で単価が違う畠山組・川崎の応援など）向けに、
出面入力（`/attendance` の PC グリッド・スマホの職長画面）は親現場を選んだまま、日ごとに「どの工種か」を
選んで入力できる。工種ごとに別グリッドを開いて配置し直す必要はない。

- **既定の工種**（`demmen/main.assign[親現場id]` の下）:
  - `defaultWorkType: Record<workerId(文字列), 工種サイトid>` … 作業員ごとの既定の入力先
  - `defaultWorkTypeSubcon: Record<subconId, 工種サイトid>` … 外注先ごとの既定の入力先
  - 未設定（マップに無い）の作業員・外注先は、これまでどおり親現場 id にそのまま保存される（後方互換）
  - 保存は `POST /api/attendance/grid { action: 'saveDefaultWorkType', siteId: 親現場id, workerId または subconId, workTypeSiteId }`。
    `assign.{親現場id}.defaultWorkType.{workerId}` へのドット記法の狭い更新（`workTypeSiteId` を送らなければ `deleteField()` で「親に戻す」）。
    配置の保存（`saveAssign`）は `assign[siteId]` を read-and-preserve で更新するのでこのマップを壊さないが、
    それとは無関係に単独でも安全に効くよう、あえて独立したドット記法にしてある
- **1日分の切り替え（移動）**: `POST /api/attendance/grid { action: 'moveWorkType', siteId: 親現場id, ym, day, workerId または subconId, toSiteId }`。
  `app/api/attendance/foreman/route.ts` の `fix_site`（現場違い修正）と同じ考え方で、
  `setAttendanceEntry` + `computeAttendanceDeleteFields` で移動先へ書き込み、移動元は `d.{key}`（外注なら `sd.{key}`）を `deleteField()` で消す。
  月次ロック中は拒否。移動先に既にエントリがあれば拒否（上書き事故防止）
- **表示（GET）**: 選択中の現場が非アーカイブの工種サイトを持つ親なら、配置は親のものを使ったまま、
  出面エントリは「親 + 工種サイトの全 id」を合わせて見せる（union）。追加の Firestore 読み取りは発生しない
  （同一リクエストで読んだ `att_YYYYMM` をそのままなぞるだけ）。レスポンスに `workTypeSites` / `defaultWorkType` /
  `defaultWorkTypeSubcon` / `entrySiteByWorkerDay` / `entrySiteBySubconDay` / `workTypeDuplicates` を追加。
  工種の無い現場・工種サイト自身を選んだ場合はこれらが空になり、画面は完全に従来どおり
- **重複ガード**: 同じ人・同じ日が2つ以上の工種に入力されている状態は `lib/site-hierarchy.ts` の
  `findWorkTypeDuplicates`（純関数・`__tests__/site-hierarchy.test.ts`）で検出し、画面に警告を出す。
  `moveWorkType` は移動先に既にエントリがあれば拒否、移動元が2箇所以上に見つかった場合も
  「先に重複を解消してください」で拒否する（サーバ側で必ず見る。クライアントの事前チェックだけに頼らない）
- 工種を**後から**足した現場（既に親 id で出面が入っている状態から工種サイトを作った場合）は、
  過去分は親 id のまま union に混ざって表示され、`moveWorkType` でいつでも工種サイト側へ移動できる。
  データの移行処理は無い（自然に union に入るので追加対応は不要）

