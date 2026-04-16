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
| billing | map | 売上データ |
| workDays | map | 月別所定日数 |
| siteWorkDays | map | 現場別月別所定日数 |
| locks | map | 月締め状態 |
| defaultRates | map | デフォルト単価 |
| mforeman | map | 月別代理職長 |
| nextWorkerId | number | 次のワーカーID |

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
