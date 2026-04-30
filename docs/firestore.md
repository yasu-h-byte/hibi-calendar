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
| nextWorkerId | number | 次のワーカーID |

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
  endTime: string                                              // 例: '17:30'
  morningBreak:   { enabled: boolean; minutes: number; mandatory: boolean }
  lunchBreak:     { enabled: boolean; minutes: number; mandatory: boolean }
  afternoonBreak: { enabled: boolean; minutes: number; mandatory: boolean }
}
```

未設定の現場は従来通り 8:00〜17:00、午前30分・昼60分・午後30分のデフォルト。IHI現場は 7:30〜17:30 で設定済み。`lib/compute.ts` の月次集計、`types/index.ts` の `calcActualHours` / `calcOvertimeHours` がこの値を参照する。

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

### activityLog/{auto}
アクティビティログ。

### announcements/{auto}
お知らせ（ダッシュボード表示用）。

### evaluations/{workerId_evaluationDate}
評価データ（複数評価者対応）。

## ロール判定
- workerId === 1 → approver（政仁さん、ハードコード）
- jobType === 'jimu' → jimu
- 現場のforemanに設定 → foreman
- それ以外 → admin

