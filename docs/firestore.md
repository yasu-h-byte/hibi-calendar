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
| nextWorkerId | number | 次のワーカーID |

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

## ロール判定
- workerId === 1 → approver（政仁さん、ハードコード）
- jobType === 'jimu' → jimu
- 現場のforemanに設定 → foreman
- それ以外 → admin
