/**
 * 就業カレンダーの「誰が・いつ」提出し、最終承認したか（2026-10-22）
 *
 * 承認の流れは「職長が作成・提出 → 事業責任者（政仁さん）が最終承認」（CLAUDE.md）。
 * siteCalendar には submittedBy/At・approvedBy/At・rejectedBy/At・revertedBy/At・updatedBy/At が
 * 前から記録されていたが、画面には状態の札（承認済み・提出済み…）しか出していなかった。
 * このファイルは **純粋な整形だけ**（Firestore は読まない。画面と API とテストが同じものを使う）。
 *
 * - 画面の1行: buildApprovalTrailLines → 「提出: 大川 10/21 18:05 ／ 最終承認: 政仁 10/22 09:10」
 * - 履歴（時系列）: calendarStatusLog（append-only・lib/calendar-status-log.server.ts）が正本。
 *   ログを書き始める前の月は siteCalendar の項目から synthesizeTrailFromDoc で起こし、
 *   mergeTrailHistory でログより古い分だけ補う（古い月は「記録なし」が残る）
 * - 時刻は日本時間で出す（サーバ＝UTC・lib/date-utils.ts と同じ +9 時間の考え方）
 */

/** 状態が変わる出来事（calendarStatusLog の event） */
export type CalendarTrailEvent = 'submit' | 'approve' | 'reject' | 'unapprove' | 'unsubmit' | 'revise'

export const TRAIL_EVENT_LABEL: Record<CalendarTrailEvent, string> = {
  submit: '提出',
  approve: '最終承認',
  reject: '差し戻し',
  unapprove: '承認の取り消し',
  unsubmit: '提出の取り消し',
  revise: '承認後の修正',
}

/** siteCalendar の「誰が・いつ」の項目（API が名前を添えて返す） */
export interface CalendarTrailFields {
  status?: string | null
  submittedBy?: number | null
  submittedAt?: string | null
  submittedByName?: string | null
  approvedBy?: number | null
  approvedAt?: string | null
  approvedByName?: string | null
  rejectedBy?: number | null
  rejectedAt?: string | null
  rejectedByName?: string | null
  rejectedReason?: string | null
  revertedBy?: number | null
  revertedAt?: string | null
  revertedByName?: string | null
  updatedBy?: number | null
  updatedAt?: string | null
  updatedByName?: string | null
}

/** 履歴の1行（ログ由来 or siteCalendar の項目から起こしたもの） */
export interface CalendarTrailEntry {
  event: CalendarTrailEvent
  /** ISO（UTC） */
  at: string
  by: number | null
  byName: string | null
  reason?: string | null
  /** 「一括確定」「提出なしで直接承認」などの補足 */
  note?: string | null
  /** log = calendarStatusLog（正本）／ doc = siteCalendar の項目から起こした（ログ開始前の月） */
  source: 'log' | 'doc'
}

export type TrailTone = 'green' | 'blue' | 'red' | 'amber' | 'gray'

export interface TrailLine {
  /** 「提出」「最終承認」「差し戻し」 */
  label: string
  /** 「大川 10/21 18:05」「承認待ち」「記録なし」 */
  text: string
  tone: TrailTone
}

/** ISO の時刻を日本時間の「M/D HH:MM」にする。読めなければ '' */
export function fmtJstStamp(iso: string | null | undefined): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const d = new Date(t + 9 * 60 * 60 * 1000)   // utc-ok: +9 時間して UTC の目盛りを日本時間として読む
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

/** ISO の時刻を日本時間の「YYYY/M/D HH:MM」にする（履歴用・年が要る） */
export function fmtJstStampLong(iso: string | null | undefined): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const d = new Date(t + 9 * 60 * 60 * 1000)   // utc-ok: 同上
  return `${d.getUTCFullYear()}/${fmtJstStamp(iso)}`
}

/** 誰がやったかの表示名。名前が引けなければ ID、ID も無ければ「記録なし」 */
export function actorLabel(id: number | null | undefined, name: string | null | undefined): string {
  if (name) return name
  if (id === null || id === undefined) return '記録なし'
  return `ID:${id}`
}

/** 「名前 M/D HH:MM」。時刻が無ければ名前だけ、両方無ければ「記録なし」 */
function whoWhen(id: number | null | undefined, name: string | null | undefined, at: string | null | undefined): string {
  const stamp = fmtJstStamp(at)
  if (!stamp && (id === null || id === undefined) && !name) return '記録なし'
  return stamp ? `${actorLabel(id, name)} ${stamp}` : actorLabel(id, name)
}

/** 承認後に修正されたか（approvedAt より後に updatedAt が動いた） */
export function wasRevisedAfterApproval(cal: CalendarTrailFields): boolean {
  return cal.status === 'approved' && !!cal.approvedAt && !!cal.updatedAt && cal.updatedAt > cal.approvedAt
}

/**
 * 月×現場の見出しに出す行を作る。
 *   承認済み: 提出 / 最終承認 (/ 承認後の修正)
 *   提出済み: 提出 / 最終承認: 承認待ち（承認を取り消して戻した場合はその旨）
 *   差し戻し: 提出 / 差し戻し: 名前 時刻（理由）
 *   作成中・未作成: 提出: まだ（提出を取り消した場合はその旨）
 * 古いデータで項目が無いときは「記録なし」。
 */
export function buildApprovalTrailLines(cal: CalendarTrailFields | null | undefined): TrailLine[] {
  const c = cal || {}
  const status = c.status || null
  const lines: TrailLine[] = []
  const hasSubmit = !!c.submittedAt || c.submittedBy !== null && c.submittedBy !== undefined
  const hasApprove = !!c.approvedAt || c.approvedBy !== null && c.approvedBy !== undefined
  // 取り消し（revert）が提出より後なら、その取り消しは今の状態に効いている
  const revertAfterSubmit = !!c.revertedAt && (!c.submittedAt || c.revertedAt > c.submittedAt)

  // 提出
  if (status === 'approved' || status === 'submitted' || status === 'rejected') {
    lines.push({ label: '提出', text: hasSubmit ? whoWhen(c.submittedBy, c.submittedByName, c.submittedAt) : '記録なし', tone: hasSubmit ? 'blue' : 'gray' })
  } else if (hasSubmit) {
    // draft に戻した後も提出の記録が残っている（旧データ）
    lines.push({ label: '提出', text: `${whoWhen(c.submittedBy, c.submittedByName, c.submittedAt)}（取り消し）`, tone: 'gray' })
  } else if (c.revertedAt && status === 'draft') {
    lines.push({ label: '提出', text: `取り消し ${whoWhen(c.revertedBy, c.revertedByName, c.revertedAt)}`, tone: 'amber' })
  } else {
    lines.push({ label: '提出', text: 'まだ', tone: 'gray' })
  }

  // 最終承認・差し戻し
  if (status === 'approved') {
    lines.push({ label: '最終承認', text: hasApprove ? whoWhen(c.approvedBy, c.approvedByName, c.approvedAt) : '記録なし', tone: hasApprove ? 'green' : 'gray' })
    if (wasRevisedAfterApproval(c)) {
      lines.push({ label: '承認後の修正', text: whoWhen(c.updatedBy, c.updatedByName, c.updatedAt), tone: 'amber' })
    }
  } else if (status === 'submitted') {
    const unapproved = revertAfterSubmit && !!c.revertedAt
    lines.push({
      label: '最終承認',
      text: unapproved ? `承認待ち（承認の取り消し ${whoWhen(c.revertedBy, c.revertedByName, c.revertedAt)}）` : '承認待ち',
      tone: 'amber',
    })
  } else if (status === 'rejected') {
    const reason = c.rejectedReason ? `（${c.rejectedReason}）` : ''
    const has = !!c.rejectedAt || c.rejectedBy !== null && c.rejectedBy !== undefined
    lines.push({ label: '差し戻し', text: has ? `${whoWhen(c.rejectedBy, c.rejectedByName, c.rejectedAt)}${reason}` : `記録なし${reason}`, tone: 'red' })
  } else {
    lines.push({ label: '最終承認', text: 'まだ', tone: 'gray' })
  }
  return lines
}

/** 画面の1行にする（「提出: 大川 10/21 18:05 ／ 最終承認: 政仁 10/22 09:10」） */
export function approvalTrailText(cal: CalendarTrailFields | null | undefined): string {
  return buildApprovalTrailLines(cal).map(l => `${l.label}: ${l.text}`).join(' ／ ')
}

/**
 * siteCalendar の項目から履歴を起こす（calendarStatusLog を書き始める前の月の分）。
 * 取り消し（revertedAt）は「承認の取り消し」か「提出の取り消し」か項目だけでは分からないので、
 * 今の状態で見分ける（submitted なら承認の取り消し・draft なら提出の取り消し）。
 */
export function synthesizeTrailFromDoc(cal: CalendarTrailFields | null | undefined): CalendarTrailEntry[] {
  const c = cal || {}
  const out: CalendarTrailEntry[] = []
  const push = (event: CalendarTrailEvent, at: string | null | undefined, by: number | null | undefined, byName: string | null | undefined, extra?: Partial<CalendarTrailEntry>) => {
    if (!at) return
    out.push({ event, at, by: by ?? null, byName: byName ?? null, source: 'doc', ...extra })
  }
  push('submit', c.submittedAt, c.submittedBy, c.submittedByName)
  push('approve', c.approvedAt, c.approvedBy, c.approvedByName)
  push('reject', c.rejectedAt, c.rejectedBy, c.rejectedByName, { reason: c.rejectedReason ?? null })
  if (c.revertedAt) {
    const ev: CalendarTrailEvent = c.status === 'submitted' ? 'unapprove' : 'unsubmit'
    push(ev, c.revertedAt, c.revertedBy, c.revertedByName)
  }
  if (wasRevisedAfterApproval(c)) push('revise', c.updatedAt, c.updatedBy, c.updatedByName)
  return out.sort((a, b) => a.at.localeCompare(b.at))
}

/**
 * ログ（正本）と、siteCalendar の項目から起こしたものを1本の時系列にする。
 * ログがあれば、ログの最初より古い doc 由来だけ補う（同じ出来事を二重に出さない）。
 * ログが無ければ doc 由来だけ。
 */
export function mergeTrailHistory(logEntries: CalendarTrailEntry[], docEntries: CalendarTrailEntry[]): CalendarTrailEntry[] {
  const log = [...logEntries].sort((a, b) => a.at.localeCompare(b.at))
  if (log.length === 0) return [...docEntries].sort((a, b) => a.at.localeCompare(b.at))
  const first = log[0].at
  const older = docEntries.filter(e => e.at < first)
  return [...older, ...log].sort((a, b) => a.at.localeCompare(b.at))
}

/** 履歴の1行の文（「10/21 18:05 提出 大川」「10/22 09:10 差し戻し 政仁（第2土曜を出勤に）」） */
export function trailEntryText(e: CalendarTrailEntry): string {
  const parts = [fmtJstStampLong(e.at), TRAIL_EVENT_LABEL[e.event], actorLabel(e.by, e.byName)]
  if (e.reason) parts.push(`（${e.reason}）`)
  if (e.note) parts.push(`〔${e.note}〕`)
  return parts.join(' ')
}

export function trailEventTone(event: CalendarTrailEvent): TrailTone {
  switch (event) {
    case 'approve': return 'green'
    case 'submit': return 'blue'
    case 'reject': return 'red'
    case 'revise': return 'amber'
    default: return 'gray'
  }
}
