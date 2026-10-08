/**
 * 年次有給休暇管理簿（労基法施行規則24条の7）— 2026-10-05 に作り直し（代表依頼）。
 *
 * 旧（lib/export.ts generateLeaveLedger）: 全員を「付与1回＝1行」で1枚に並べ、取得日は別シート。内部用の列
 * （FY・ステータス・付与方法）が混ざり、罫線も無く、年5日の取得が一目で分からなかった。
 *
 * 新: 一般的な管理簿と同じ「1人1枚の個人票」＋先頭に「一覧表」。
 *   - 一覧表: 1人1行（今の期の基準日・付与・繰越・取得・残・年5日の取得）。未達は色つき
 *   - 個人票: 氏名・入社日／期ごとに 基準日・付与日数・繰越・有効期限／取得した日（1日ずつ）／取得・残・年5日
 *     法定の3項目（基準日・日数・時季）がこの1枚でそろう
 *   - 買取記録: 今までどおり（金額は給与を見られる人にだけ渡る＝呼び出し側で伏せる）
 *
 * 出し分け（scope）: 会社ごと（hibi / hfu）・日本人（jp・両社）・ベトナム人など外国人（vn・両社）・全社（all）。
 * 期の範囲（range）: recent＝今の期と前の期（既定）／all＝全期間（保存義務のある過去分）。
 *
 * **数字はすべて computeRecordBalance（申請の検証・休暇管理・賞与と同じ本体）から取る。ここで数え直さない。**
 * まず buildLeaveLedgerModel で中身（純粋なデータ）を作り、renderLeaveLedgerWorkbook が Excel にする
 * （罫線・色を付けるため xlsx-js-style を使う。書き出しも leaveLedgerToBuffer で。lib/export.ts の XLSX では装飾が落ちる）。
 */
import * as XLSX from 'xlsx-js-style'
import type { LeaveLedgerData, LeaveLedgerRecord, LeaveLedgerWorker } from './export'
import { computePeriodUsed, computeRecordBalance, selectCurrentPeriodRecord } from './leave-compute'
import { addMonthsSafe, calcLastUsableDayIso, isLeaveExpiredAsOf, todayJstIso } from './date-utils'
import { isAlreadyRetired } from './workers'

export type LedgerScope = 'all' | 'hibi' | 'hfu' | 'jp' | 'vn'
export type LedgerRange = 'recent' | 'all'

export const LEDGER_SCOPE_LABEL: Record<LedgerScope, string> = {
  all: '全社', hibi: '日比建設', hfu: 'HFU', jp: '日本人スタッフ', vn: 'ベトナム人スタッフ',
}

/**
 * 出面の有給の記録がそろっている最初の日。これより前に始まった期は、取得した日がシステムに無い（紙の管理簿にしかない）ので、
 * 「取得なし・年5日 未達」と決めつけず「紙の管理簿を参照」と出す（2026-10-05 本番の出力で確認: 2024年11月付与の期が
 * 取得0日・未達（5日不足）と出ていた）。システムの出面は実質 2025年の秋から（lib/leave-carry.ts の注記と同じ事情）
 */
export const LEDGER_ATT_FROM = '2025-09-01'

/** 年5日の取得義務の対象になる付与日数（労基法39条7項） */
const OBLIGATION_MIN_GRANT = 10
const OBLIGATION_DAYS = 5

export interface LedgerTakenDay {
  date: string
  /** 会社の時季指定で取った日 */
  designated: boolean
  note: string
  /** 今日より先（承認済みの予定） */
  planned: boolean
}

export interface LedgerPeriod {
  grantDate: string
  /** 期の最後の日（この日まで）。次の付与が1年より前に来た人は次の付与日の前日 */
  periodLastDay: string
  /** 有効期限（最後に使える日＝付与日+2年−1日） */
  lastUsableDay: string
  grantDays: number
  carryOver: number
  total: number
  /** 出面に無い取得（移行前の分など） */
  adjustment: number
  /** 取得した日（出面の有給・同じ日の2現場は1日・日付順） */
  taken: LedgerTakenDay[]
  /** 取得日数（出面の有給。承認済みの予定を含む） */
  periodUsed: number
  buyoutDays: number
  expiredDays: number
  remaining: number
  /** 今の期か（一覧表に出す期） */
  current: boolean
  /** 有効期限が過ぎた・時効の処理済み */
  expired: boolean
  /** システム導入前に始まった期（取得した日・残・年5日はシステムからは出せない＝紙の管理簿） */
  beforeSystem: boolean
  /** この期の途中で退職した（年5日の「あと◯日」を出さない） */
  retiredDuring: boolean
  /** 年5日の取得（付与10日以上の期だけ applies） */
  obligation: { applies: boolean; taken: number; met: boolean; shortfall: number; deadline: string }
}

export interface LedgerPerson {
  id: number
  name: string
  org: 'hibi' | 'hfu'
  isJp: boolean
  visaLabel: string
  hireDate: string
  retired: string
  periods: LedgerPeriod[]
  /** 今の期（無ければ null＝付与待ち・付与前） */
  current: LedgerPeriod | null
}

export interface LedgerBuyout { id: number; name: string; grantDate: string; at: string; days: number; amount: number | null; reason: string }

export interface LeaveLedgerModel {
  scope: LedgerScope
  range: LedgerRange
  todayIso: string
  people: LedgerPerson[]
  buyouts: LedgerBuyout[]
}

const orgOf = (o: string): 'hibi' | 'hfu' => (o === 'hfu' || o === 'HFU' ? 'hfu' : 'hibi')
const isJpVisa = (v?: string) => !v || v === 'none'

export function visaLabel(v: string): string {
  if (isJpVisa(v)) return '日本人'
  const m: Record<string, string> = {
    jisshu: '技能実習', tokutei: '特定技能',
    jisshu1: '技能実習1号', jisshu2: '技能実習2号', jisshu3: '技能実習3号', tokutei1: '特定技能1号', tokutei2: '特定技能2号',
  }
  return m[v] || v
}

/** 対象の人か（出し分け） */
function inScope(w: LeaveLedgerWorker, scope: LedgerScope): boolean {
  if (scope === 'all') return true
  if (scope === 'jp') return isJpVisa(w.visa)
  if (scope === 'vn') return !isJpVisa(w.visa)
  return orgOf(w.org) === scope
}

const validDate = (s?: string): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s)

/** 管理簿の中身（Excel にする前の純粋なデータ） */
export function buildLeaveLedgerModel(
  data: LeaveLedgerData, opts?: { scope?: LedgerScope; range?: LedgerRange; todayIso?: string },
): LeaveLedgerModel {
  const scope: LedgerScope = opts?.scope ?? (data.org === 'hibi' || data.org === 'hfu' ? data.org : 'all')
  const range: LedgerRange = opts?.range ?? 'recent'
  const todayIso = opts?.todayIso ?? todayJstIso()
  const allAtt = data.allAtt as Record<string, unknown>
  // 退職した人も、保存期間（退職から5年・労基則24条の7）のあいだは載せる（2026-10-02 代表決定）
  const keepFrom = addMonthsSafe(todayIso, -60)

  const people: LedgerPerson[] = []
  const buyouts: LedgerBuyout[] = []
  for (const w of data.workers) {
    if (!inScope(w, scope)) continue
    const retiredDone = isAlreadyRetired(w.retired, todayIso)
    if (retiredDone && (w.retired || '') < keepFrom) continue
    const isJp = isJpVisa(w.visa)
    const records = (data.plData[String(w.id)] || []) as LeaveLedgerRecord[]
    // 退職日より後の日付の付与は載せない（退職した人に次の期の付与の記録が残っていることがある・2026-10-05 本番の出力で確認）
    const dated = records.filter(r => validDate(r.grantDate) && !r._archived)
      .filter(r => !(retiredDone && w.retired && (r.grantDate as string) > w.retired))
      .sort((a, b) => (a.grantDate as string).localeCompare(b.grantDate as string))
    const currentRec = selectCurrentPeriodRecord(
      dated as Parameters<typeof selectCurrentPeriodRecord>[0], todayIso,
    ) as LeaveLedgerRecord | null

    const periods: LedgerPeriod[] = dated.map(r => {
      const grantDate = r.grantDate as string
      const b = computeRecordBalance(w.id, records as Parameters<typeof computeRecordBalance>[1],
        r as Parameters<typeof computeRecordBalance>[2], allAtt, { isJp, todayIso })
      const used = computePeriodUsed(w.id, grantDate, allAtt, todayIso, { periodEndExclusive: b.periodEndExclusive })
      const designated = new Map((r.designatedLeaves || []).map(d => [d.date, d.note || ''] as const))
      const taken: LedgerTakenDay[] = [...used.requestedDates].sort().map(date => ({
        date, designated: designated.has(date), note: designated.get(date) || '', planned: date > todayIso,
      }))
      // 年5日: 休暇管理・通知と同じ「申請ベース」（期の中の出面の有給）で数える
      const applies = b.grantDays >= OBLIGATION_MIN_GRANT
      const shortfall = applies ? Math.max(0, OBLIGATION_DAYS - b.periodUsed) : 0
      return {
        grantDate, periodLastDay: b.periodLastDay, lastUsableDay: calcLastUsableDayIso(grantDate),
        grantDays: b.grantDays, carryOver: b.carryOver, total: b.total, adjustment: b.adjustment,
        taken, periodUsed: b.periodUsed, buyoutDays: b.buyoutDays, expiredDays: r.expiredDays ?? 0,
        remaining: b.remaining, current: r === currentRec,
        expired: !!r.expiredAt || isLeaveExpiredAsOf(grantDate, todayIso),
        beforeSystem: grantDate < LEDGER_ATT_FROM,
        retiredDuring: retiredDone && !!w.retired && w.retired <= b.periodLastDay,
        obligation: { applies, taken: b.periodUsed, met: applies && shortfall === 0, shortfall, deadline: b.periodLastDay },
      }
    })
    // recent: 今の期と、その前の期（今の期が無い人は最後の2つ）
    let shown = periods
    if (range === 'recent' && periods.length > 2) {
      const ci = periods.findIndex(p => p.current)
      shown = ci >= 0 ? periods.slice(Math.max(0, ci - 1), ci + 1) : periods.slice(-2)
    }
    people.push({
      id: w.id, name: w.name, org: orgOf(w.org), isJp, visaLabel: visaLabel(w.visa),
      hireDate: w.hireDate || '', retired: retiredDone ? (w.retired || '') : '',
      periods: shown, current: periods.find(p => p.current) || null,
    })
    for (const r of dated) {
      for (const h of r.buyoutHistory || []) {
        buyouts.push({
          id: w.id, name: w.name, grantDate: r.grantDate as string, at: (h.at || '').slice(0, 10), days: h.days,
          amount: h.amount ?? null,
          reason: h.reason === 'year-end' ? '期末買取' : h.reason === 'retirement' ? '退職時精算'
            : h.reason === 'monthly-settle' ? `有給精算（${String((h as { ym?: string }).ym || '').replace(/^(\d{4})(\d{2})$/, '$1年$2月')}分の給与）` : h.reason || '',
        })
      }
    }
  }
  // 会社 → 日本人 → 外国人 → 社員番号 の順
  const orgRank = { hibi: 0, hfu: 1 } as const
  people.sort((a, b) => orgRank[a.org] - orgRank[b.org] || Number(b.isJp) - Number(a.isJp) || a.id - b.id)
  buyouts.sort((a, b) => a.at.localeCompare(b.at) || a.id - b.id)
  return { scope, range, todayIso, people, buyouts }
}

// ────────────────────────────────────────
//  Excel にする
// ────────────────────────────────────────

const ORG_LABEL = { hibi: '日比建設', hfu: 'HFU' } as const
const fmt = (iso: string) => (validDate(iso) ? `${iso.slice(0, 4)}/${iso.slice(5, 7)}/${iso.slice(8, 10)}` : '')
const md = (iso: string) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`
const WEEK = ['日', '月', '火', '水', '木', '金', '土']
const dow = (iso: string) => WEEK[new Date(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)))).getUTCDay()]

type Style = NonNullable<XLSX.CellObject['s']>
const LINE = { style: 'thin', color: { rgb: 'B8C0CC' } } as const
const BORDER = { top: LINE, bottom: LINE, left: LINE, right: LINE }
const FONT = 'Yu Gothic'
const S = {
  title: { font: { name: FONT, sz: 14, bold: true } } as Style,
  sub: { font: { name: FONT, sz: 9, color: { rgb: '5B6472' } } } as Style,
  head: { font: { name: FONT, sz: 9, bold: true, color: { rgb: '1B2A4A' } }, fill: { fgColor: { rgb: 'EAF0FA' } }, border: BORDER, alignment: { horizontal: 'center', vertical: 'center', wrapText: true } } as Style,
  label: { font: { name: FONT, sz: 9, bold: true, color: { rgb: '1B2A4A' } }, fill: { fgColor: { rgb: 'F2F4F9' } }, border: BORDER, alignment: { vertical: 'center' } } as Style,
  cell: { font: { name: FONT, sz: 10 }, border: BORDER, alignment: { vertical: 'center', wrapText: true } } as Style,
  num: { font: { name: FONT, sz: 10 }, border: BORDER, alignment: { horizontal: 'right', vertical: 'center' } } as Style,
  strong: { font: { name: FONT, sz: 11, bold: true }, border: BORDER, alignment: { horizontal: 'right', vertical: 'center' } } as Style,
  ok: { font: { name: FONT, sz: 10, bold: true, color: { rgb: '15803D' } }, fill: { fgColor: { rgb: 'ECFDF3' } }, border: BORDER, alignment: { horizontal: 'center', vertical: 'center' } } as Style,
  ng: { font: { name: FONT, sz: 10, bold: true, color: { rgb: 'B91C1C' } }, fill: { fgColor: { rgb: 'FEF2F2' } }, border: BORDER, alignment: { horizontal: 'center', vertical: 'center' } } as Style,
  na: { font: { name: FONT, sz: 9, color: { rgb: '5B6472' } }, border: BORDER, alignment: { horizontal: 'center', vertical: 'center' } } as Style,
  band: { font: { name: FONT, sz: 10, bold: true, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: '1B2A4A' } }, alignment: { vertical: 'center' } } as Style,
}

type Cell = { v: string | number; s?: Style }
const c = (v: string | number, s: Style = S.cell): Cell => ({ v, s })

function sheetOf(rows: (Cell | null)[][], widths: number[], merges: XLSX.Range[] = []): XLSX.WorkSheet {
  const ws: XLSX.WorkSheet = {}
  let maxC = 0
  rows.forEach((row, r) => row.forEach((cell, ci) => {
    if (!cell) return
    maxC = Math.max(maxC, ci)
    ws[XLSX.utils.encode_cell({ r, c: ci })] = { v: cell.v, t: typeof cell.v === 'number' ? 'n' : 's', s: cell.s }
  }))
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(0, rows.length - 1), c: Math.max(maxC, widths.length - 1) } })
  ws['!cols'] = widths.map(wch => ({ wch }))
  ws['!merges'] = merges
  ws['!margins'] = { left: 0.5, right: 0.5, top: 0.6, bottom: 0.6, header: 0.3, footer: 0.3 }
  return ws
}

/** 年5日の取得の欄。期が終わっていて足りなければ「未達」、まだ途中なら「あと◯日」 */
const obligationCell = (p: LedgerPeriod | null, todayIso: string): Cell => {
  if (!p) return c('—', S.na)
  if (p.beforeSystem) return c('紙の管理簿', S.na)
  if (!p.obligation.applies) return c('対象外', S.na)
  if (p.obligation.met) return c('達成', S.ok)
  if (p.retiredDuring) return c('退職', S.na)
  return p.obligation.deadline < todayIso
    ? c(`未達（${p.obligation.shortfall}日不足）`, S.ng)
    : c(`あと${p.obligation.shortfall}日`, S.ng)
}

/** 先頭の一覧表: 1人1行（今の期） */
function summarySheet(m: LeaveLedgerModel): XLSX.WorkSheet {
  const showVisa = m.scope !== 'jp'
  const showCarry = m.scope !== 'jp'
  const rows: (Cell | null)[][] = []
  rows.push([c(`年次有給休暇管理簿　一覧表（${LEDGER_SCOPE_LABEL[m.scope]}）`, S.title)])
  rows.push([c(`作成日 ${fmt(m.todayIso)}　／　今の期の状況。取得日数は出面の有給（承認済みの予定を含む）。年5日の取得は付与10日以上の人が対象`, S.sub)])
  rows.push([])
  const head = ['番号', '氏名', '会社', ...(showVisa ? ['区分'] : []), '入社日', '基準日（付与日）', '付与', ...(showCarry ? ['繰越'] : []),
    '取得', '残', '年5日の取得', '取得の期限', '有効期限', '個人票']
  rows.push(head.map(h => c(h, S.head)))
  m.people.forEach((p, i) => {
    const cur = p.current
    rows.push([
      c(p.id, S.num), c(p.retired ? `${p.name}（退職 ${fmt(p.retired)}）` : p.name), c(ORG_LABEL[p.org]),
      ...(showVisa ? [c(p.visaLabel)] : []),
      c(fmt(p.hireDate)),
      cur ? c(fmt(cur.grantDate)) : c('今の期の付与なし', S.na),
      cur ? c(cur.grantDays, S.num) : c('', S.cell),
      ...(showCarry ? [cur ? c(cur.carryOver, S.num) : c('', S.cell)] : []),
      cur ? c(cur.periodUsed + cur.adjustment, S.num) : c('', S.cell),
      cur ? c(cur.remaining, S.strong) : c('', S.cell),
      obligationCell(cur, m.todayIso),
      cur && cur.obligation.applies ? c(fmt(cur.obligation.deadline)) : c('', S.cell),
      cur ? c(fmt(cur.lastUsableDay)) : c('', S.cell),
      c(sheetName(p, i)),
    ])
  })
  const widths = [6, 24, 10, ...(showVisa ? [13] : []), 12, 15, 7, ...(showCarry ? [7] : []), 7, 7, 13, 12, 12, 18]
  return sheetOf(rows, widths, [{ s: { r: 0, c: 0 }, e: { r: 0, c: widths.length - 1 } }, { s: { r: 1, c: 0 }, e: { r: 1, c: widths.length - 1 } }])
}

/** シート名（31文字まで・使えない記号を除く・重複しないよう番号を頭に） */
function sheetName(p: LedgerPerson, _i: number): string {
  return `${p.id}_${p.name}`.replace(/[\\/?*[\]:]/g, '').slice(0, 31)
}

/** 取得した日を1行に何日並べるか（個人票） */
const DAYS_PER_ROW = 6

/** 1人1枚の個人票 */
function personSheet(p: LedgerPerson, m: LeaveLedgerModel): XLSX.WorkSheet {
  const COLS = 6
  const rows: (Cell | null)[][] = []
  const merges: XLSX.Range[] = []
  const full = (r: number) => merges.push({ s: { r, c: 0 }, e: { r, c: COLS - 1 } })
  const span = (r: number, c0: number, c1: number) => merges.push({ s: { r, c: c0 }, e: { r, c: c1 } })
  const blank = (s: Style) => c('', s)

  rows.push([c('年次有給休暇管理簿', S.title)]); full(0)
  rows.push([c(`作成日 ${fmt(m.todayIso)}`, S.sub)]); full(1)
  rows.push([])
  // 上段: 本人
  rows.push([c('氏名', S.label), c(p.name), blank(S.cell), c('社員番号', S.label), c(p.id, S.num), blank(S.cell)])
  span(3, 1, 2); span(3, 4, 5)
  rows.push([c('会社', S.label), c(ORG_LABEL[p.org]), blank(S.cell), c('入社日', S.label), c(fmt(p.hireDate)), blank(S.cell)])
  span(4, 1, 2); span(4, 4, 5)
  if (!p.isJp || p.retired) {
    const r = rows.length
    rows.push([c(p.isJp ? '' : '在留資格', S.label), c(p.isJp ? '' : p.visaLabel), blank(S.cell),
      c(p.retired ? '退職日' : '', S.label), c(p.retired ? fmt(p.retired) : ''), blank(S.cell)])
    span(r, 1, 2); span(r, 4, 5)
  }

  if (p.periods.length === 0) {
    rows.push([])
    rows.push([c('有給休暇の付与の記録がありません（入社6か月前など）', S.sub)]); full(rows.length - 1)
  }

  // 新しい期を上に
  for (const pd of p.periods.slice().reverse()) {
    rows.push([])
    let r = rows.length
    rows.push([c(`${fmt(pd.grantDate)} 付与分（${fmt(pd.grantDate)} 〜 ${fmt(pd.periodLastDay)}）${pd.current ? '　今の期' : ''}`, S.band),
      blank(S.band), blank(S.band), blank(S.band), blank(S.band), blank(S.band)]); full(r)
    // 付与
    r = rows.length
    rows.push([c('基準日（付与日）', S.head), c('付与日数', S.head), c(p.isJp ? '—' : '前期からの繰越', S.head), c('合計', S.head), c('有効期限', S.head), blank(S.head)])
    span(r, 4, 5)
    r = rows.length
    rows.push([c(fmt(pd.grantDate)), c(pd.grantDays, S.num), p.isJp ? c('', S.cell) : c(pd.carryOver, S.num), c(pd.total, S.strong),
      c(`${fmt(pd.lastUsableDay)}${pd.expired ? '（期限切れ）' : ''}`), blank(S.cell)])
    span(r, 4, 5)
    // 取得した日
    r = rows.length
    rows.push([c(pd.beforeSystem ? '取得した日' : `取得した日（${pd.taken.length}日）　◆＝会社の時季指定　（予）＝承認済みの予定`, S.label),
      blank(S.label), blank(S.label), blank(S.label), blank(S.label), blank(S.label)]); full(r)
    if (pd.beforeSystem) {
      r = rows.length
      rows.push([c('この期はシステムを使い始める前に始まったため、取得した日は紙の管理簿を見てください', S.na),
        blank(S.na), blank(S.na), blank(S.na), blank(S.na), blank(S.na)]); full(r)
    } else if (pd.taken.length === 0) {
      r = rows.length
      rows.push([c('取得なし', S.na), blank(S.na), blank(S.na), blank(S.na), blank(S.na), blank(S.na)]); full(r)
    }
    for (let i = 0; i < pd.taken.length && !pd.beforeSystem; i += DAYS_PER_ROW) {
      const chunk = pd.taken.slice(i, i + DAYS_PER_ROW)
      rows.push(Array.from({ length: COLS }, (_, k) => {
        const t = chunk[k]
        if (!t) return blank(S.cell)
        // 年をまたぐ期があるので、年が変わる最初の日だけ年を付ける
        const prev = pd.taken[i + k - 1]
        const withYear = !prev || prev.date.slice(0, 4) !== t.date.slice(0, 4)
        return c(`${withYear ? `${t.date.slice(0, 4)}/` : ''}${md(t.date)}（${dow(t.date)}）${t.designated ? '◆' : ''}${t.planned ? '（予）' : ''}`)
      }))
    }
    if (pd.adjustment > 0) {
      r = rows.length
      rows.push([c(`ほかに、出面に記録の無い取得が ${pd.adjustment}日 あります（システム移行前の分など。日付は紙の管理簿）`, S.sub),
        null, null, null, null, null]); full(r)
    }
    // 下段: 集計
    r = rows.length
    const showBuyout = !p.isJp || pd.buyoutDays > 0   // 日本人は退職時の精算などで買取があるときだけ
    rows.push([c('取得日数', S.head), c(showBuyout ? '買取日数' : '—', S.head), c('失効日数', S.head), c('残日数', S.head), c('年5日の取得', S.head), c('取得の期限', S.head)])
    rows.push([
      pd.beforeSystem ? c('紙の管理簿', S.na) : c(pd.periodUsed + pd.adjustment, S.num),
      showBuyout ? c(pd.buyoutDays, S.num) : c('', S.cell),
      c(pd.expiredDays, S.num),
      pd.beforeSystem ? c('紙の管理簿', S.na) : c(pd.remaining, S.strong),
      obligationCell(pd, m.todayIso),
      pd.obligation.applies ? c(fmt(pd.obligation.deadline)) : c('', S.cell),
    ])
  }
  rows.push([])
  const anyBuyout = !p.isJp || p.periods.some(x => x.buyoutDays > 0)
  rows.push([c(`※ 取得日数は出面の有給の記録から数えています。残日数 ＝ 付与${p.isJp ? '' : ' ＋ 繰越'} − 取得${anyBuyout ? ' − 買取' : ''}。`, S.sub)])
  full(rows.length - 1)
  rows.push([c('※ 年5日の取得は、付与日数が10日以上の期が対象です（労働基準法39条7項）。', S.sub)])
  full(rows.length - 1)
  return sheetOf(rows, [17, 15, 17, 15, 15, 15], merges)
}

function buyoutSheet(m: LeaveLedgerModel): XLSX.WorkSheet {
  const rows: (Cell | null)[][] = []
  rows.push([c('有給休暇の買取の記録', S.title)])
  rows.push([c(`作成日 ${fmt(m.todayIso)}`, S.sub)])
  rows.push([])
  rows.push(['番号', '氏名', '対象の付与日', '買取日', '日数', '金額（円）', '理由'].map(h => c(h, S.head)))
  for (const b of m.buyouts) {
    rows.push([c(b.id, S.num), c(b.name), c(fmt(b.grantDate)), c(fmt(b.at)), c(b.days, S.num), b.amount === null ? c('', S.cell) : c(b.amount, S.num), c(b.reason)])
  }
  if (m.buyouts.length === 0) rows.push([c('記録はありません', S.na)])
  return sheetOf(rows, [6, 22, 14, 12, 7, 12, 14], [{ s: { r: 0, c: 0 }, e: { r: 0, c: 6 } }])
}

export function renderLeaveLedgerWorkbook(m: LeaveLedgerModel): XLSX.WorkBook {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, summarySheet(m), '一覧表')
  const used = new Set<string>(['一覧表', '買取記録'])
  m.people.forEach((p, i) => {
    let name = sheetName(p, i)
    while (used.has(name)) name = `${name.slice(0, 28)}_${used.size}`
    used.add(name)
    XLSX.utils.book_append_sheet(wb, personSheet(p, m), name)
  })
  // 日本人だけの出力は、買取（退職時の精算など）の記録があるときだけ付ける
  if (m.scope !== 'jp' || m.buyouts.length > 0) XLSX.utils.book_append_sheet(wb, buyoutSheet(m), '買取記録')
  return wb
}

/** 管理簿の Excel（中身を作って Excel にする。書き出しは leaveLedgerToBuffer で） */
export function generateLeaveLedger(
  data: LeaveLedgerData, opts?: { scope?: LedgerScope; range?: LedgerRange; todayIso?: string },
): XLSX.WorkBook {
  return renderLeaveLedgerWorkbook(buildLeaveLedgerModel(data, opts))
}

/** 装飾を残して書き出す（lib/export.ts の workbookToBuffer は装飾を落とすので使わない） */
export function leaveLedgerToBuffer(wb: XLSX.WorkBook): Buffer {
  return Buffer.from(XLSX.write(wb, { bookType: 'xlsx', type: 'buffer', cellStyles: true }))
}

/** ファイル名（例: 有給管理簿_日比建設_20261005.xlsx） */
export function leaveLedgerFilename(scope: LedgerScope, range: LedgerRange, todayIso: string): string {
  const s = scope === 'all' ? '' : `_${LEDGER_SCOPE_LABEL[scope].replace('スタッフ', '')}`
  return `有給管理簿${s}${range === 'all' ? '_全期間' : ''}_${todayIso.replace(/-/g, '')}.xlsx`
}

export const parseLedgerScope = (v: string | null | undefined): LedgerScope =>
  (v === 'hibi' || v === 'hfu' || v === 'jp' || v === 'vn' ? v : 'all')
export const parseLedgerRange = (v: string | null | undefined): LedgerRange => (v === 'all' ? 'all' : 'recent')
