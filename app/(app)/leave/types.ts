// 有給管理画面で共有する型定義

export interface PLWorker {
  id: number; name: string; org: string; visa: string; hireDate: string
  grantDays: number; carryOver: number; adjustment: number; periodUsed: number; actualPeriodUsed: number; remainingActual: number; used: number
  asOfUsed?: number; asOfRemaining?: number  // 基準日時点の消化・残数（月末残高突合用）
  total: number; remaining: number; rate: number; grantMonth?: number
  grantDate: string; expiryDate: string; expiryStatus: 'ok' | 'warning' | 'expired'; inferredFromDefault?: boolean
  legalPL: number; fiveDayShortfall: number
  monthlyUsage: Record<string, number>
  // 監査情報
  grantedAt?: string
  grantedBy?: number | string
  method?: string
  lastEditedAt?: string
  lastEditedBy?: number | string
  adjustmentHistory?: Array<{ at: string; by: number | string; field: string; before: string; after: string }>
  // Phase 5: 時季指定
  designatedLeaves?: Array<{ date: string; designatedAt: string; designatedBy: number | string; note?: string; siteId: string; kind?: string; overwroteHomeLeave?: boolean }>
  // Phase 6: 買取
  buyoutDays?: number
  buyoutHistory?: Array<{ at: string; by: number | string; days: number; amount?: number; reason?: string }>
  // Phase 8: FIFO内訳
  carryOverRemaining?: number
  carryOverExpiryDate?: string
  carryOverExpiryStatus?: 'ok' | 'warning' | 'expired'
  carryOverSourceGrantDate?: string
  grantRemaining?: number
  grantExpiryDate?: string
  grantExpiryStatus?: 'ok' | 'warning' | 'expired'
}

export type OrgFilter = 'all' | 'hibi' | 'hfu'

export type LeaveTab = 'list' | 'grantdates' | 'requests' | 'monthly' | 'calendar' | 'homeleave'

// 帰国情報（旧 home-leave ページから統合）
export interface HomeLeave {
  id: string; workerId: number; workerName: string
  startDate: string; endDate: string; reason: string; note?: string; createdAt: string
  returnUndecided?: boolean  // 2026-07-18: 復帰未定（番兵終了日）。endDate は番兵値が入る
}

// 半自動付与（未付与検知）
export interface PendingGrant {
  workerId: number; name: string; visa: string; hireDate: string
  tenureText: string; nextGrantDate: string; fy: string; legalDays: number
  reason: string; needsAttention?: boolean; attentionNote?: string
}

export type PendingGrantForm = Record<number, { grantDate: string; grantDays: string; include: boolean }>

// 有給申請
export interface LeaveRequest {
  id: string; workerId: number; workerName: string; date: string; siteId: string
  reason: string; status: string; requestedAt: string
  foremanApprovedAt?: string; foremanApprovedBy?: number
  reviewedAt?: string; rejectedReason?: string
  dateModifyHistory?: { previousDate: string; newDate: string; modifiedAt: string; modifiedBy: number }[]
}

export interface SiteOption { id: string; name: string; foreman?: number }

// 月別職長オーバーライド ("siteId_ym" -> { wid: workerId })
export type MforemanMap = Record<string, { wid: number }>
