/**
 * 社労士提出用: 勤務予定シフト表・実労働時間明細・同意台帳
 * 2026-10-21 総点検で lib/export.ts から分離。帳票の中身は変えていない。
 */
import * as XLSX from 'xlsx-js-style'
import { RawWorker } from './compute'
import { isHiredByMonth, isStillActiveForMonth } from './workers'
import { orgKeyOf } from './locks'
import { setColWidths, ymLabel } from './export'
import { AttendanceEntry, calcActualHours } from '@/types'

// ────────────────────────────────────────
//  社労士提出用: 勤務予定シフト表 / 実労働時間明細 (2026-06-XX 追加)
//
//  変形労働時間制（1ヶ月単位）の遵守を社労士が確認するための法定保存書類。
//  - 勤務予定シフト: 月の労働日と所定時間の事前計画
//  - 実労働時間明細: 実際の始業・終業・残業の記録
//
//  どちらもベトナム人スタッフ(変形労働制対象者)のみ対象、スタッフ1名1シート。
// ────────────────────────────────────────

interface ShiftCalendarDay {
  /** 'work' | 'off' | 'holiday' (DayType) */
  type: string
}

export interface PlannedShiftData {
  ym: string  // YYYYMM
  workers: RawWorker[]  // 全ワーカー（フィルタは関数内で実施）
  assign: Record<string, { workers?: number[]; subcons?: string[] }>
  massign: Record<string, { workers?: number[]; subcons?: string[] }>
  sites: { id: string; name: string; archived?: boolean; workSchedule?: SiteWorkSchedule }[]
  /** siteId -> days map (key='1'..'31', value DayType). siteCalendar から取得 */
  siteCalendars: Record<string, Record<string, ShiftCalendarDay | string>>
  /** 2026-06-XX 追加: 会社別フィルタ (社労士が会社ごとに違うため) */
  org?: 'hibi' | 'hfu' | 'all'
}

interface SiteWorkSchedule {
  startTime?: string
  endTime?: string
  morningBreak?: { enabled?: boolean; minutes?: number }
  lunchBreak?: { enabled?: boolean; minutes?: number }
  afternoonBreak?: { enabled?: boolean; minutes?: number }
}

/**
 * workSchedule から「始業/終業/休憩(分)/所定労働時間(h)」を計算
 */
function computePrescribedFromSchedule(ws: SiteWorkSchedule | undefined): {
  start: string
  end: string
  breakMin: number
  workH: number
} {
  if (!ws?.startTime || !ws?.endTime) {
    // 標準値（システムデフォルト 8:00-17:00, 休憩 2h, 7h）
    return { start: '08:00', end: '17:00', breakMin: 120, workH: 7.0 }
  }
  const [sh, sm] = ws.startTime.split(':').map(Number)
  const [eh, em] = ws.endTime.split(':').map(Number)
  const startMin = sh * 60 + (sm || 0)
  const endMin = eh * 60 + (em || 0)
  let totalMin = endMin - startMin
  let breakMin = 0
  if (ws.morningBreak?.enabled !== false) breakMin += ws.morningBreak?.minutes ?? 30
  if (ws.lunchBreak?.enabled !== false) breakMin += ws.lunchBreak?.minutes ?? 60
  if (ws.afternoonBreak?.enabled !== false) breakMin += ws.afternoonBreak?.minutes ?? 30
  totalMin -= breakMin
  return {
    start: ws.startTime,
    end: ws.endTime,
    breakMin,
    workH: Math.max(0, Math.round(totalMin / 60 * 10) / 10),
  }
}

/**
 * 1スタッフの月の配置先（assign + massign）から主要現場を判定
 */
function inferPrimarySiteId(workerId: number, ym: string, assign: PlannedShiftData['assign'], massign: PlannedShiftData['massign']): string | null {
  // 2026-06-XX 修正 (社労士監査): massign のキー形式は `${siteId}_${ym}` (例: ihi_202605)
  //   旧バグ: massign[ym] (例: massign['202605']) を参照 → 常に undefined → 月次配置替えが効かず
  //           デフォルト assign にフォールバックし、別現場のカレンダーを表示していた
  //   新: 全現場について massign[`${siteId}_${ym}`] を走査し、当月配置現場を特定。
  //       月次オーバーライドがあればそれを優先、なければデフォルト assign。
  const allSiteIds = new Set<string>([
    ...Object.keys(assign),
    ...Object.keys(massign).map(k => k.replace(new RegExp(`_${ym}$`), '')).filter(k => massign[`${k}_${ym}`]),
  ])

  // 月次オーバーライド (massign) を優先
  for (const sid of allSiteIds) {
    const mOver = massign[`${sid}_${ym}`]
    if (mOver?.workers?.includes(workerId)) return sid
  }
  // デフォルト assign にフォールバック
  for (const [sid, sa] of Object.entries(assign)) {
    if (sa.workers?.includes(workerId)) return sid
  }
  return null
}

/**
 * #1: 勤務予定シフト表 Excel を生成
 */
export function generatePlannedShiftExcel(data: PlannedShiftData): XLSX.WorkBook {
  const { ym, workers, assign, massign, sites, siteCalendars, org } = data
  const wb = XLSX.utils.book_new()

  // 対象: ベトナム人スタッフ + 当月在籍 + (org フィルタ指定があれば該当会社のみ)
  // 2026-06-12 修正 (監査): isHiredByMonth を追加（入社前月のスタッフが社労士提出書類に載る横展開漏れ）
  const foreignWorkers = workers.filter(w => {
    if (!(w.visa && w.visa !== 'none' && w.visa !== '')) return false
    if (!isStillActiveForMonth(w.retired, ym)) return false
    if (!isHiredByMonth(w.hireDate, ym)) return false
    if (org === 'hibi' && w.org !== 'hibi') return false
    if (org === 'hfu' && orgKeyOf(w.org) !== 'hfu') return false
    return true
  })

  const y = parseInt(ym.slice(0, 4))
  const m = parseInt(ym.slice(4, 6))
  const daysInMonth = new Date(y, m, 0).getDate()
  const legalLimit = Math.round((daysInMonth * 40 / 7) * 10) / 10

  for (const w of foreignWorkers) {
    const siteId = inferPrimarySiteId(w.id, ym, assign, massign)
    const site = siteId ? sites.find(s => s.id === siteId) : undefined
    const schedule = computePrescribedFromSchedule(site?.workSchedule)
    const dayMap = siteId ? (siteCalendars[siteId] || {}) : {}

    // 月曜起算の週番号（変形労働の週所定を示すため）
    const firstDow = new Date(y, m - 1, 1).getDay()
    const firstMondayOffset = (firstDow + 6) % 7
    const weekOf = (d: number) => Math.floor((d - 1 + firstMondayOffset) / 7) + 1

    const rows: unknown[][] = []
    // ヘッダー
    rows.push([`勤務予定シフト表 ${ymLabel(ym)} - ${w.name}`])
    rows.push([`スタッフ ID: ${w.id}  /  従業員番号: ${(w as { payrollNo?: string }).payrollNo || '—'}  /  雇用区分: ${w.visa}`])
    rows.push([`配置現場: ${site?.name || '未確定'}`])
    rows.push([`勤務時間 (標準): ${schedule.start}-${schedule.end} / 休憩 ${schedule.breakMin}分 / 所定 ${schedule.workH}h`])
    rows.push([`制度: 1ヶ月単位の変形労働時間制 / 月の所定総枠 ${legalLimit}h (暦日数${daysInMonth}÷7×40)`])
    rows.push([])
    rows.push(['週', '日', '曜', '予定', '始業', '終業', '休憩(分)', '所定労働時間(h)', '備考'])

    let totalWork = 0
    let totalH = 0
    // 週別所定: weekNum -> { days, hours }
    const weekly: Record<number, { days: number; hours: number }> = {}
    for (let d = 1; d <= daysInMonth; d++) {
      const dow = new Date(y, m - 1, d).getDay()
      const dowLabel = ['日', '月', '火', '水', '木', '金', '土'][dow]
      const wn = weekOf(d)
      const dayEntry = dayMap[String(d)]
      // dayEntry が文字列 ('work'/'off'/'holiday') or オブジェクト
      const dayType = typeof dayEntry === 'string' ? dayEntry : (dayEntry?.type || (dow === 0 ? 'off' : 'work'))
      const isWork = dayType === 'work'

      const note = dayType === 'holiday' ? '祝日' : (dayType === 'off' && dow === 0 ? '法定休日' : (dayType === 'off' ? '所定休日' : ''))

      if (!weekly[wn]) weekly[wn] = { days: 0, hours: 0 }
      if (isWork) {
        totalWork++
        totalH += schedule.workH
        weekly[wn].days++
        weekly[wn].hours += schedule.workH
        rows.push([
          `第${wn}週`, d, dowLabel, '出勤',
          schedule.start, schedule.end, schedule.breakMin, schedule.workH, note,
        ])
      } else {
        rows.push([`第${wn}週`, d, dowLabel, '休', '-', '-', '-', '-', note])
      }
    }
    // 合計
    rows.push([])
    rows.push(['', '', '', '所定出勤日数', '', '', '', totalWork + '日', ''])
    rows.push(['', '', '', '所定労働時間 合計', '', '', '', Math.round(totalH * 10) / 10 + 'h', `月の所定総枠 ${legalLimit}h ${totalH <= legalLimit ? '✓ 枠内' : '⚠ 超過'}`])
    // 週別の所定（変形労働：週40h超の週は「週所定」が残業判定の基準になる）
    rows.push([])
    const weeklyTitle = '【週別 所定労働時間】変形労働時間制では、この週所定を超えた分が時間外労働になります'
    rows.push([weeklyTitle])
    rows.push(['週', '所定出勤日数', '週所定労働時間', '残業判定の基準', '', '', '', '', ''])
    for (const wn of Object.keys(weekly).map(Number).sort((a, b) => a - b)) {
      const wk = weekly[wn]
      if (wk.days === 0) continue
      const wh = Math.round(wk.hours * 10) / 10
      const basis = wh > 40
        ? `週所定 ${wh}h 超で時間外（40hではない）`
        : `週40h 超で時間外`
      rows.push([`第${wn}週`, wk.days + '日', wh + 'h', basis, '', '', '', '', ''])
    }

    // シート名: 30文字以内（Excel制限31文字、安全マージン）
    const sheetName = w.name.slice(0, 28) + (w.name.length > 28 ? '..' : '')
    const sheet = XLSX.utils.aoa_to_sheet(rows)
    const weeklyHeaderRow = rows.findIndex(r => r[0] === weeklyTitle)
    sheet['!merges'] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: 8 } },
      { s: { r: 1, c: 0 }, e: { r: 1, c: 8 } },
      { s: { r: 2, c: 0 }, e: { r: 2, c: 8 } },
      { s: { r: 3, c: 0 }, e: { r: 3, c: 8 } },
      { s: { r: 4, c: 0 }, e: { r: 4, c: 8 } },
      ...(weeklyHeaderRow >= 0 ? [{ s: { r: weeklyHeaderRow, c: 0 }, e: { r: weeklyHeaderRow, c: 8 } }] : []),
    ]
    setColWidths(sheet, [8, 6, 6, 8, 8, 8, 10, 16, 30])
    XLSX.utils.book_append_sheet(wb, sheet, sheetName)
  }

  if (wb.SheetNames.length === 0) {
    const emptySheet = XLSX.utils.aoa_to_sheet([[`勤務予定シフト ${ymLabel(ym)} — 対象スタッフがいません`]])
    XLSX.utils.book_append_sheet(wb, emptySheet, '対象なし')
  }
  return wb
}

// ────────────────────────────────────────

export interface ActualHoursData {
  ym: string  // YYYYMM
  workers: RawWorker[]
  attD: Record<string, AttendanceEntry>
  sites: { id: string; name: string; workSchedule?: SiteWorkSchedule }[]
  /** 2026-06-XX 追加: 会社別フィルタ (社労士が会社ごとに違うため) */
  org?: 'hibi' | 'hfu' | 'all'
}

/**
 * #2: 実労働時間明細 Excel を生成
 */
/**
 * ⚠️ 夜勤（2026-08〜）の未対応事項 — 実際にベトナム人の夜勤が発生した時点で対応する
 *
 * 実労働時間は calcActualHours() から出すため夜勤ブロックを含むが、この帳票の
 * 始業・終業列は日勤の st/et しか出さない。そのためベトナム人スタッフが夜勤した日は
 * 「始業08:00 / 終業17:00 なのに実労働15時間」という行になり、社労士が照合できない。
 * （日本人は st/et を持たないため推定表示になり、この齟齬は出ない）
 *
 * 対応方針: 終業列に夜勤の時刻を併記する（例「17:00 ＋ 22:00〜翌5:00」）。
 *           既存の列構成を崩さないためこちらが安全。別行に分ける案は列設計の変更が大きい。
 * 詳細: docs/attendance.md「未対応（今後の課題）」
 */
export function generateActualHoursExcel(data: ActualHoursData): XLSX.WorkBook {
  const { ym, workers, attD, sites, org } = data
  const wb = XLSX.utils.book_new()

  const foreignWorkers = workers.filter(w => {
    if (!(w.visa && w.visa !== 'none' && w.visa !== '')) return false
    if (!isStillActiveForMonth(w.retired, ym)) return false
    if (!isHiredByMonth(w.hireDate, ym)) return false  // 2026-06-12 (監査): 入社前月除外の横展開
    if (org === 'hibi' && w.org !== 'hibi') return false
    if (org === 'hfu' && orgKeyOf(w.org) !== 'hfu') return false
    return true
  })

  const y = parseInt(ym.slice(0, 4))
  const m = parseInt(ym.slice(4, 6))
  const daysInMonth = new Date(y, m, 0).getDate()

  const siteMap = new Map(sites.map(s => [s.id, s]))

  for (const w of foreignWorkers) {
    const rows: unknown[][] = []
    rows.push([`実労働時間明細 ${ymLabel(ym)} - ${w.name}`])
    rows.push([`スタッフ ID: ${w.id}  /  従業員番号: ${(w as { payrollNo?: string }).payrollNo || '—'}  /  雇用区分: ${w.visa}`])
    rows.push([`※ 実労働(h) = 始業〜終業 − 実際に取得した休憩。給与計算と完全に同一の算出方法です`])
    rows.push([`※ 休憩(分)は実際に取得した分のみ。現場・作業内容により休憩を取れなかった場合は労働時間に算入されます`])
    rows.push([`※ 所定外(h) = 実労働 − 当日所定時間。始業/終業に「(推定)」がある日は時刻未記録のため標準時刻で推定`])
    rows.push([])
    rows.push(['日', '曜', '状態', '現場', '始業', '終業', '休憩(分)', '実労働(h)', '所定外(h)', '備考'])

    let totalActual = 0
    let totalOT = 0
    let workDays = 0
    let pDays = 0
    let rDays = 0

    for (let d = 1; d <= daysInMonth; d++) {
      const dow = new Date(y, m - 1, d).getDay()
      const dowLabel = ['日', '月', '火', '水', '木', '金', '土'][dow]

      // 該当スタッフのその日のエントリを全現場分検索
      const entriesForDay: { siteId: string; entry: AttendanceEntry }[] = []
      for (const site of sites) {
        const key = `${site.id}_${w.id}_${ym}_${d}`
        if (attD[key]) entriesForDay.push({ siteId: site.id, entry: attD[key] })
      }

      if (entriesForDay.length === 0) {
        rows.push([d, dowLabel, '-', '', '', '', '', '', '', ''])
        continue
      }

      // 各エントリを別行で出力（同日複数現場対応）
      for (const { siteId, entry } of entriesForDay) {
        const site = siteMap.get(siteId)
        const e = entry as { w?: number; o?: number; p?: number; r?: number; h?: number; hk?: number; exam?: number; st?: string; et?: string; b1?: number; b2?: number; b3?: number }

        // 状態判定
        let status = ''
        if (e.p) { status = '有給'; pDays++ }
        else if (e.hk) status = '帰国中'
        else if (e.exam) status = '試験'
        else if (e.r) { status = '欠勤'; rDays++ }
        else if (e.h) status = '現場休'
        else if (e.w === 0.6) status = '補償日'
        else if ((e.w || 0) > 0) { status = e.w === 0.5 ? '半日' : '出勤'; workDays++ }
        else status = '-'

        // 始業/終業 (st/et が無ければ workSchedule 標準時刻 + 推定マーク)
        // 2026-06-XX 修正 (社労士監査): 給与計算 (calcActualHours) と完全に同一ロジックに統一
        //   旧バグ: computePrescribedFromSchedule で「所定休憩を全部固定控除」していた
        //     → 休憩を実際は取っていない日 (b1/b3未設定) でも7hと表示し、給与計算の8hと食い違う
        //     → 社労士が「実労働明細7h なのに残業1hが別途出る」と照合不能になった
        //   新: calcActualHours(entry, workSchedule) を使用。休憩フラグ b1/b2/b3 が立っている
        //       分のみ控除 = 給与計算と同じ実労働時間になる
        const ws = site?.workSchedule
        const schedule = computePrescribedFromSchedule(ws)
        let startTime = ''
        let endTime = ''
        let breakMin = 0
        let actualH = 0
        let prescribedH = schedule.workH  // 所定労働時間 (この日)
        let nonStatOT = 0                 // 所定外 (実労働 − 所定、当日分)
        let isEstimated = false
        if ((e.w || 0) > 0 && e.w !== 0.6) {
          if (e.st && e.et) {
            startTime = e.st
            endTime = e.et
            // 実際に取得した休憩のみ集計 (フラグ連動・給与計算と同じ)
            const wsTyped = ws as SiteWorkSchedule | undefined
            const mMin = wsTyped?.morningBreak?.enabled === false ? 0 : (wsTyped?.morningBreak?.minutes ?? 30)
            const lMin = wsTyped?.lunchBreak?.enabled === false ? 0 : (wsTyped?.lunchBreak?.minutes ?? 60)
            const aMin = wsTyped?.afternoonBreak?.enabled === false ? 0 : (wsTyped?.afternoonBreak?.minutes ?? 30)
            breakMin = (e.b1 ? mMin : 0) + (e.b2 ? lMin : 0) + (e.b3 ? aMin : 0)
            // 給与計算と同一の calcActualHours で実労働を算出
            actualH = calcActualHours(entry, ws as Parameters<typeof calcActualHours>[1])
            // 所定外 = 実労働 − 所定 (当日。負なら0)
            nonStatOT = Math.max(0, Math.round((actualH - prescribedH) * 10) / 10)
          } else {
            // レガシー入力: 標準時刻 + o で推定
            startTime = schedule.start + ' (推定)'
            endTime = schedule.end + ' (推定)'
            breakMin = schedule.breakMin
            actualH = schedule.workH + (e.o || 0)
            nonStatOT = e.o || 0
            isEstimated = true
          }
          totalActual += actualH
          totalOT += nonStatOT
        }

        rows.push([
          d, dowLabel, status,
          site?.name || siteId,
          startTime || '-',
          endTime || '-',
          breakMin || '-',
          actualH > 0 ? actualH : '-',
          nonStatOT > 0 ? nonStatOT : '-',
          isEstimated ? '時刻未記録（標準時刻で推定）'
            : (breakMin < schedule.breakMin && actualH > prescribedH ? '休憩未取得分を労働時間に算入' : ''),
        ])
      }
    }

    // 合計
    rows.push([])
    rows.push(['', '', '出勤実日数', '', '', '', '', '', workDays + '日', ''])
    rows.push(['', '', '有給日数', '', '', '', '', '', pDays + '日', ''])
    if (rDays > 0) rows.push(['', '', '欠勤日数', '', '', '', '', '', rDays + '日', ''])
    rows.push(['', '', '実労働時間 合計', '', '', '', '', Math.round(totalActual * 10) / 10 + 'h', '', ''])
    rows.push(['', '', '所定外 合計', '', '', '', '', '', Math.round(totalOT * 10) / 10 + 'h', ''])

    const sheetName = w.name.slice(0, 28) + (w.name.length > 28 ? '..' : '')
    const sheet = XLSX.utils.aoa_to_sheet(rows)
    sheet['!merges'] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: 9 } },
      { s: { r: 1, c: 0 }, e: { r: 1, c: 9 } },
      { s: { r: 2, c: 0 }, e: { r: 2, c: 9 } },
      { s: { r: 3, c: 0 }, e: { r: 3, c: 9 } },
      { s: { r: 4, c: 0 }, e: { r: 4, c: 9 } },
    ]
    setColWidths(sheet, [5, 5, 8, 14, 12, 12, 8, 9, 8, 22])
    XLSX.utils.book_append_sheet(wb, sheet, sheetName)
  }

  if (wb.SheetNames.length === 0) {
    const emptySheet = XLSX.utils.aoa_to_sheet([[`実労働時間明細 ${ymLabel(ym)} — 対象スタッフがいません`]])
    XLSX.utils.book_append_sheet(wb, emptySheet, '対象なし')
  }
  return wb
}

// ────────────────────────────────────────
// 変形労働時間制 カレンダー周知・同意台帳（2026-06 追加）
//   1ヶ月単位の変形労働時間制では「事前に確定した休日カレンダーを各スタッフへ周知し
//   本人の同意を得た」記録が法的に重要。calendarSign の電子署名を台帳化して
//   社労士・労基署提出に使える形で出力する。
// ────────────────────────────────────────

/** UTC ISO → JST 表示 "YYYY/MM/DD HH:mm"（サーバTZに依存しない） */
function isoToJst(iso?: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const j = new Date(d.getTime() + 9 * 3600 * 1000)   // utc-ok: 時刻つきの表示（UTC の getter で日本時間を読む）
  const p = (n: number) => String(n).padStart(2, '0')
  return `${j.getUTCFullYear()}/${p(j.getUTCMonth() + 1)}/${p(j.getUTCDate())} ${p(j.getUTCHours())}:${p(j.getUTCMinutes())}`
}

/** 承認方法コード → 表示ラベル */
function signMethodLabel(method?: string): string {
  if (method === 'self_tap') return '本人認証(個人リンク)'
  if (method === 'tap') return '名前選択(旧方式)'
  return method || '—'
}

export interface ConsentLedgerData {
  ym: string                 // YYYYMM
  generatedAt?: string       // 出力日時(ISO)。サーバ側で new Date().toISOString()
  approvedSites: { siteId: string; siteName: string; approvedAt: string | null; approvedBy: number | null }[]
  workers: { id: number; name: string }[]   // 署名対象の外国人スタッフ
  /** key: `${workerId}_${siteId}` → 署名レコード（calendarSignLog の最新イベント） */
  signs: Record<string, { signedAt?: string; method?: string; ipHash?: string; resignCount?: number; workCount?: number | null; consentName?: string }>
}

/**
 * 変形労働時間制 カレンダー周知・同意台帳 Excel を生成。
 *  Sheet1「同意台帳」: 承認済みカレンダー一覧 + スタッフ×現場の署名日時マトリクス
 *  Sheet2「署名明細」: 1署名=1行の監査ログ（方法・再署名履歴・端末ハッシュ）
 */
export function generateConsentLedger(data: ConsentLedgerData): XLSX.WorkBook {
  const { ym, generatedAt, approvedSites, workers, signs } = data
  const wb = XLSX.utils.book_new()
  const sitesSorted = [...approvedSites].sort((a, b) => a.siteName.localeCompare(b.siteName, 'ja'))
  const workersSorted = [...workers].sort((a, b) => a.id - b.id)

  // ── Sheet1: 同意台帳（サマリー + マトリクス） ──
  const s1: unknown[][] = []
  s1.push([`変形労働時間制 カレンダー周知・同意台帳　${ymLabel(ym)}`])
  s1.push(['1ヶ月単位の変形労働時間制において、事前に確定した休日カレンダーを各スタッフへ周知し、本人の電子署名で同意を得た記録です。'])
  s1.push([`出力日時: ${isoToJst(generatedAt) || '—'}（JST）`])
  s1.push([])
  s1.push(['【承認（確定）済みカレンダー】'])
  s1.push(['現場', 'カレンダー確定（承認）日時', '承認者ID'])
  if (sitesSorted.length === 0) {
    s1.push(['（承認済みの現場がありません）', '', ''])
  } else {
    for (const st of sitesSorted) {
      s1.push([st.siteName, isoToJst(st.approvedAt) || '未記録', st.approvedBy ?? '—'])
    }
  }
  s1.push([])
  s1.push(['【署名状況マトリクス】セル＝署名日時（JST）／空欄＝未署名'])
  const matrixHeaderRowIdx = s1.length
  s1.push(['スタッフID', '氏名', ...sitesSorted.map(s => s.siteName), '署名済 / 対象'])
  for (const w of workersSorted) {
    const cells: unknown[] = [w.id, w.name]
    let signed = 0
    for (const st of sitesSorted) {
      const rec = signs[`${w.id}_${st.siteId}`]
      if (rec?.signedAt) { signed++; cells.push(isoToJst(rec.signedAt)) }
      else cells.push('未署名')
    }
    cells.push(`${signed} / ${sitesSorted.length}`)
    s1.push(cells)
  }
  const sheet1 = XLSX.utils.aoa_to_sheet(s1)
  const lastCol = Math.max(2, 2 + sitesSorted.length) // 氏名列以降
  sheet1['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: lastCol } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: lastCol } },
    { s: { r: 2, c: 0 }, e: { r: 2, c: lastCol } },
  ]
  setColWidths(sheet1, [10, 20, ...sitesSorted.map(() => 18), 12])
  XLSX.utils.book_append_sheet(wb, sheet1, '同意台帳')
  void matrixHeaderRowIdx

  // ── Sheet2: 署名明細（1署名=1行の監査ログ） ──
  const s2: unknown[][] = []
  s2.push([`署名明細（監査ログ）　${ymLabel(ym)}`])
  s2.push(['スタッフID', '氏名', '現場', '対象月', '署名状況', '署名日時(JST)', '承認方法', '本人記入氏名', '署名回数', '同意した稼働日数', '端末ハッシュ'])
  for (const w of workersSorted) {
    for (const st of sitesSorted) {
      const rec = signs[`${w.id}_${st.siteId}`]
      if (rec?.signedAt) {
        s2.push([
          w.id, w.name, st.siteName, ymLabel(ym), '署名済',
          isoToJst(rec.signedAt), signMethodLabel(rec.method),
          rec.consentName || '—',
          (rec.resignCount ?? 0) + 1,
          rec.workCount != null ? `${rec.workCount}日` : '—',
          rec.ipHash || '',
        ])
      } else {
        s2.push([w.id, w.name, st.siteName, ymLabel(ym), '未署名', '', '', '', '', '', ''])
      }
    }
  }
  const sheet2 = XLSX.utils.aoa_to_sheet(s2)
  sheet2['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 10 } }]
  setColWidths(sheet2, [10, 20, 18, 10, 10, 18, 20, 18, 10, 16, 12])
  XLSX.utils.book_append_sheet(wb, sheet2, '署名明細')

  return wb
}
