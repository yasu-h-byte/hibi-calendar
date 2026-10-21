/**
 * 月次集計 Excel（キャシュモ提出）・現場別出面一覧
 * 2026-10-21 総点検で lib/export.ts から分離。帳票の中身は変えていない（__tests__/reportConsistency / exportUnconfirmed）。
 */
import * as XLSX from 'xlsx-js-style'
import { SubconMonthly, WorkerMonthly } from './compute-monthly'
import { orgKeyOf } from './locks'
import { JP_MONTHLY_ABSENCE_DEDUCTION_FROM_YM } from './constants'
import { type PayrollSnapshot, validatePayrolls } from './payroll-validator'
import { dayLabel, daysInMonth, setColWidths, ymLabel } from './export'
import { RawWorker, parseDKey } from './compute'
import { AttendanceEntry, calcManDays } from '@/types'
import { isHiredByMonth, isStillActiveForMonth } from './workers'
import { isWorkingDay } from './attendance'

// ────────────────────────────────────────
//  6. 月次集計Excel
// ────────────────────────────────────────

export interface MonthlyExcelData {
  ym: string
  workers: WorkerMonthly[]
  subcons: SubconMonthly[]
  siteNames: Record<string, string>
  prescribedDays: number
}

/**
 * 月次集計 Excel（2026-05-12 改訂: 1シート統合）
 *
 * 旧構成（〜2026-05-12）: Sheet 1「月次集計」+ Sheet 2「給与計算詳細」で
 *   ほぼ同じデータを2回出力していたため、列の食い違いが頻発していた。
 *
 * 新構成: 1シート、4ブロック構造で重複ゼロ。給与計算担当者が1枚で完結。
 *   ベトナム人と日本人で給与計算方式が根本的に違う（特に5月以降は3層構造化）ため、
 *   会社 × 雇用区分の組み合わせでブロックを分ける。
 *
 * 構成:
 *   【日比建設・ベトナム人】 [外国人テーブル（給与関連17列）]
 *   【日比建設・日本人】     [日本人テーブル（日額系8列）]
 *   【HFU・ベトナム人】      [外国人テーブル]
 *   【HFU・日本人】          [日本人テーブル]
 *   【協力業者】             [外注テーブル]
 *
 * 月による列名切替（同じフィールドだが意味が違うため）:
 *   4月以前（旧ルール）: 所定日数 / 所定時間(h) / 基本給     / 休業補償
 *   5月以降（新ルール）: ベース日数 / 法定上限(h) / 基本給(固定) / 追加所定手当
 */
/** 月次集計Excel でベトナム人の新旧ルールを 1 シートにまとめる最初の月（キャシュモ両社委託・代表決定 2026-09-17） */
export const UNIFIED_VN_SHEET_FROM_YM = '202609'

export function generateMonthlyExcel(data: MonthlyExcelData): XLSX.WorkBook {
  const { ym, workers, subcons, siteNames, prescribedDays } = data
  const wb = XLSX.utils.book_new()

  // 2026-06-XX 全面リライト:
  //   旧: 1シート内に5ブロック縦並び
  //   新: タブ別シート構成（給与計算者の作業効率向上）
  //     - 日比建設・日本人
  //     - 日比建設・ベトナム人(新ルール)
  //     - 日比建設・ベトナム人(旧ルール)  ← フン (104) 等
  //     - HFU・ベトナム人(新ルール)
  //     - HFU・日本人 (該当者がいれば)
  //     - 協力業者(外注)
  //   加えて以下を同時修正:
  //     A. legalHolidayDays を compute.ts 出力 (w.legalHolidayDays) から取得
  //        （旧: actualWorkDays - regularWorkDays で独自計算 → 補償日があるとズレ）
  //     B. 所定日数列を workerPrescribedDays (スタッフ個別) で表示
  //        （旧: prescribedDays = UI入力の全社値で固定）
  //     C. validatePayrolls の検算結果を各シート末尾に追加

  const useNewRulesByMonth = ym >= '202605'
  // 遠方現場日当・運転手当（2026-10 施行）。施行前の月は列自体を出さない
  //   （過去月のExcelの列構成・列幅を1ミリも変えない＝奥寺さんの既存の見方を壊さない）
  // 2026-08-28: 日当は保留・運転手当のみ施行のため、月ではなく「該当者がいるか」で列を出す。
  //   日当が再開されたら自動的に列が復活する（ゲート定数を追わなくてよい）
  const withAllowance = workers.some(w => (w.siteAllowance || 0) > 0 || (w.driveAllowance || 0) > 0)
  // 休憩短縮手当（2026-09〜）: 該当者がいる月だけ列を出す（現状フンさんのみ）
  const withBreakShorten = workers.some(w => ((w as { breakShortenAllowance?: number }).breakShortenAllowance || 0) > 0)
  const isWorkerOldRules = (w: WorkerMonthly): boolean => {
    if (!useNewRulesByMonth) return true  // 月全体が旧ルール
    return (w as { useOldRules?: boolean }).useOldRules === true
  }

  // 雇用区分 × 会社 でグルーピング
  const isHibi = (w: WorkerMonthly) => w.org === '日比' || w.org === 'hibi'
  const isHfu = (w: WorkerMonthly) => orgKeyOf(w.org) === 'hfu'
  const isForeign = (w: WorkerMonthly) => w.visa !== 'none'
  const isJapanese = (w: WorkerMonthly) => w.visa === 'none'

  // 外国人を新旧ルールに分割
  const hibiForeignNew = workers.filter(w => isHibi(w) && isForeign(w) && !isWorkerOldRules(w))
  const hibiForeignOld = workers.filter(w => isHibi(w) && isForeign(w) && isWorkerOldRules(w))
  const hibiJapanese = workers.filter(w => isHibi(w) && isJapanese(w))
  const hfuForeignNew = workers.filter(w => isHfu(w) && isForeign(w) && !isWorkerOldRules(w))
  const hfuForeignOld = workers.filter(w => isHfu(w) && isForeign(w) && isWorkerOldRules(w))
  const hfuJapanese = workers.filter(w => isHfu(w) && isJapanese(w))

  // ── 列定義 ──
  // 新ルール: 25列（法定休日日数 と 法定休日労働h を別列で持つ詳細版）
  const foreignHeadersNew = ['名前', '現場', '単価種別', '単価', '所定日数', '法定上限(h)',
    '通常出勤', '法休出勤', '補償日', '有給日数',
    '実労働h', '所定外労働h', '法定残業h', '法休労働h', '深夜労働h',
    '基本給(固定)', '追加所定手当', '有給日給', '所定外労働手当', '法定外残業手当', '法定休日手当', '深夜手当', '休業手当',
    ...(withAllowance ? ['遠方日当', '運転手当'] : []),
    '欠勤日数', '欠勤控除', '支給額合計']
  // 旧ルール: 18列（補償日控除を欠勤控除と分離）
  const foreignHeadersOld = ['名前', '現場', '単価種別', '単価', '所定日数', '所定時間(h)',
    '実出勤日数', '補償日', '有給日数', '実労働時間', '残業時間',
    '基本給', '休業補償', '残業手当',
    ...(withBreakShorten ? ['休憩短縮手当'] : []),
    ...(withAllowance ? ['遠方日当', '運転手当'] : []),
    '欠勤日数', '欠勤控除', '補償日控除', '支給額合計']
  // 日本人: 8列
  // 2026-08-27 追加（給与総点検）: 日本人にも法定休日割増を実装済み(202608〜)なのに
  //   この列だけ無く、日曜出勤者のいる月は内訳を足しても支給額合計に一致しなかった
  const withJpLegalHoliday = ym >= '202608'
  // 2026-09-17 追加（キャシュモ両社委託の準備）: 補償日（日給月給は0.6日分を基本給に含む）と
  //   欠勤日数・欠勤控除（完全月給の欠勤控除は 202608〜。列が無く内訳の合計と支給額が合わなかった）。
  //   過去月のExcelの列構成を変えないよう、欠勤控除の適用開始月からだけ列を出す
  const withJpDetail = ym >= JP_MONTHLY_ABSENCE_DEDUCTION_FROM_YM
  // 有給精算（日本人の日給月給・2026-10〜・lib/leave-settle.ts）。使った人がいる月だけ列を出す
  const withLeaveSettle = workers.some(w => (w.leaveSettleAllowance || 0) > 0)
  const japaneseHeaders = ['名前',
    ...(withJpDetail ? ['従業員番号'] : []),
    '現場', '雇用形態', '日額/月給', '出勤日数',
    ...(withJpDetail ? ['補償日'] : []),
    '有給日数', '残業時間(h)', '基本給', '有給手当', '残業手当',
    ...(withJpLegalHoliday ? ['法定休日手当'] : []),
    ...(withLeaveSettle ? ['有給精算日数', '有給精算手当'] : []),
    ...(withAllowance ? ['遠方日当', '運転手当'] : []),
    ...(withJpDetail ? ['欠勤日数', '欠勤控除'] : []),
    '支給額合計']

  // ── 検算結果のシート末尾追加（共通ヘルパー） ──
  function appendValidation(rows: (string | number | null)[][], targets: WorkerMonthly[], colCount: number) {
    // 検算対象は新ルール外国人のみ (validatePayroll の内部で判定)
    const snapshots = targets as unknown as PayrollSnapshot[]
    const result = validatePayrolls(snapshots)
    rows.push([])
    // 2026-10-02: 注意点（warning・支給額は変えない）だけなら「違反」と書かない
    const headerCell: (string | number | null)[] = [
      result.total === 0
        ? '✓ 自動検算: 全項目 OK（法定外残業 0.25倍 / 所定外労働 / 法休 1.35倍 / 深夜 0.25倍 / 休業 60%）'
        : result.critical === 0
          ? `⚠ 注意点: ${result.affectedWorkerIds.length}名で${result.total}件（支給額には入れていません。締める前に確認）`
          : `⚠ 自動検算: ${result.affectedWorkerIds.length}名で${result.total}件の違反検出（critical ${result.critical} / 注意点 ${result.warning}）`
    ]
    for (let i = 1; i < colCount; i++) headerCell.push(null)
    rows.push(headerCell)
    if (result.total > 0) {
      for (const iss of result.issues) {
        const expected = iss.expected !== undefined ? `想定 ¥${iss.expected.toLocaleString()}` : ''
        const actual = iss.actual !== undefined ? `/ 実額 ¥${iss.actual.toLocaleString()}` : ''
        const detail = [`[${iss.severity}]`, iss.workerName, ':', iss.message, expected, actual].filter(Boolean).join(' ')
        const row: (string | number | null)[] = [detail]
        for (let i = 1; i < colCount; i++) row.push(null)
        rows.push(row)
      }
    }
  }

  // ── 外国人シート生成 ──
  function buildForeignSheet(sheetName: string, ws: WorkerMonthly[], forceOldRules: boolean): XLSX.WorkSheet | null {
    if (ws.length === 0) return null
    const useNewRules = !forceOldRules
    const headers = useNewRules ? foreignHeadersNew : foreignHeadersOld
    const rows: (string | number | null)[][] = []
    // タイトル
    const ruleTag = useNewRules ? '新ルール' : '旧ルール'
    rows.push([`${sheetName}（${ruleTag}） ${ymLabel(ym)}`])
    rows.push([])
    rows.push(headers)
    for (const w of ws) {
      const siteList = w.sites.map(sid => siteNames[sid] || sid).join(', ')
      const nameWithDispatch = w.isDispatched
        ? `🔁 ${w.name}（出向: ${w.dispatchTo || ''}）`
        : w.name
      // 2026-06-12 修正 (監査): salary を優先（フン等の固定月給者は salary が計算の正。
      //   旧: hourlyRate 優先のため、計算に使われない旧時給が単価列に出ていた）
      const rateKind = w.salary ? '月給' : (w.hourlyRate ? '時給' : '—')
      const rateValue = w.salary || w.hourlyRate || 0
      // 2026-06-XX 修正B: スタッフ個別の所定日数を使用（旧: 全社の prescribedDays 固定）
      const workerDays = w.workerPrescribedDays ?? prescribedDays
      const limitOrPrescribedH = useNewRules ? (w.legalLimit || 0) : (w.prescribedHours || 0)
      if (useNewRules) {
        // 2026-06-XX 修正A: legalHolidayDays を compute.ts の値から直接取得
        //   旧: const legalHolidayDays = (w.actualWorkDays || 0) - (w.regularWorkDays || 0)
        //       → 補償日(w=0.6)がある場合に不正確
        //   新: w.legalHolidayDays (calculateVietnameseSalary で計算済み)
        const legalHolidayDays = w.legalHolidayDays ?? 0
        const wext = w as WorkerMonthly & { nonStatutoryOTHours?: number; nonStatutoryOTAllowance?: number }
        rows.push([
          nameWithDispatch, siteList, rateKind, rateValue, workerDays, limitOrPrescribedH,
          w.regularWorkDays || 0, legalHolidayDays, w.compDays || 0, w.plDays || 0,
          w.actualWorkHours || 0, wext.nonStatutoryOTHours || 0, w.legalOtHours || 0,
          w.legalHolidayHours || 0, w.nightHours || 0,
          w.fixedBasePay || w.basePay || 0, w.additionalAllowance || 0, w.paidLeaveAllowance || 0,
          wext.nonStatutoryOTAllowance || 0, w.otAllowance || 0,
          w.legalHolidayAllowance || 0, w.nightAllowance || 0, w.compAllowance || 0,
          ...(withAllowance ? [w.siteAllowance || 0, w.driveAllowance || 0] : []),
          w.absence || 0, w.absentDeduction || 0, w.salaryNetPay || 0,
        ])
      } else {
        rows.push([
          nameWithDispatch, siteList, rateKind, rateValue, workerDays, limitOrPrescribedH,
          w.actualWorkDays || 0, w.compDays || 0, w.plDays || 0,
          w.actualWorkHours || 0, w.legalOtHours || 0,
          w.fixedBasePay || w.basePay || 0,
          w.additionalAllowance || 0,  // 旧ルールでは休業補償（会社都合休の60%還元分）
          w.otAllowance || 0,
          ...(withBreakShorten ? [(w as { breakShortenAllowance?: number }).breakShortenAllowance || 0] : []),
          ...(withAllowance ? [w.siteAllowance || 0, w.driveAllowance || 0] : []),
          w.absence || 0, w.absentDeduction || 0,
          w.compBaseDeduction || 0,    // 補償日控除（会社都合休の通常分・固定給は満額前提のため一旦控除）
          w.salaryNetPay || 0,
        ])
      }
    }
    // 小計
    if (useNewRules) {
      const wsExt = ws as (WorkerMonthly & { nonStatutoryOTHours?: number; nonStatutoryOTAllowance?: number })[]
      rows.push([
        '小計', null, null, null, null, null,
        ws.reduce((s, w) => s + (w.regularWorkDays || 0), 0),
        ws.reduce((s, w) => s + (w.legalHolidayDays || 0), 0),
        ws.reduce((s, w) => s + (w.compDays || 0), 0),
        ws.reduce((s, w) => s + w.plDays, 0),
        null,
        wsExt.reduce((s, w) => s + (w.nonStatutoryOTHours || 0), 0),
        ws.reduce((s, w) => s + (w.legalOtHours || 0), 0),
        ws.reduce((s, w) => s + (w.legalHolidayHours || 0), 0),
        ws.reduce((s, w) => s + (w.nightHours || 0), 0),
        ws.reduce((s, w) => s + (w.fixedBasePay || w.basePay || 0), 0),
        ws.reduce((s, w) => s + (w.additionalAllowance || 0), 0),
        ws.reduce((s, w) => s + (w.paidLeaveAllowance || 0), 0),
        wsExt.reduce((s, w) => s + (w.nonStatutoryOTAllowance || 0), 0),
        ws.reduce((s, w) => s + (w.otAllowance || 0), 0),
        ws.reduce((s, w) => s + (w.legalHolidayAllowance || 0), 0),
        ws.reduce((s, w) => s + (w.nightAllowance || 0), 0),
        ws.reduce((s, w) => s + (w.compAllowance || 0), 0),
        ...(withAllowance ? [
          ws.reduce((s, w) => s + (w.siteAllowance || 0), 0),
          ws.reduce((s, w) => s + (w.driveAllowance || 0), 0),
        ] : []),
        ws.reduce((s, w) => s + (w.absence || 0), 0),
        ws.reduce((s, w) => s + (w.absentDeduction || 0), 0),
        ws.reduce((s, w) => s + (w.salaryNetPay || 0), 0),
      ])
    } else {
      rows.push([
        '小計', null, null, null, null, null,
        ws.reduce((s, w) => s + (w.actualWorkDays || 0), 0),
        ws.reduce((s, w) => s + (w.compDays || 0), 0),
        ws.reduce((s, w) => s + w.plDays, 0),
        null,
        ws.reduce((s, w) => s + (w.legalOtHours || 0), 0),
        ws.reduce((s, w) => s + (w.fixedBasePay || w.basePay || 0), 0),
        ws.reduce((s, w) => s + (w.additionalAllowance || 0), 0),
        ws.reduce((s, w) => s + (w.otAllowance || 0), 0),
        ...(withBreakShorten ? [ws.reduce((s, w) => s + ((w as { breakShortenAllowance?: number }).breakShortenAllowance || 0), 0)] : []),
        ...(withAllowance ? [
          ws.reduce((s, w) => s + (w.siteAllowance || 0), 0),
          ws.reduce((s, w) => s + (w.driveAllowance || 0), 0),
        ] : []),
        ws.reduce((s, w) => s + (w.absence || 0), 0),
        ws.reduce((s, w) => s + (w.absentDeduction || 0), 0),
        ws.reduce((s, w) => s + (w.compBaseDeduction || 0), 0),
        ws.reduce((s, w) => s + (w.salaryNetPay || 0), 0),
      ])
    }
    // 2026-06-XX 追加C: 自動検算結果（新ルール対象スタッフのみチェック）
    if (useNewRules) appendValidation(rows, ws, headers.length)
    // ── シート生成 ──
    const sheet = XLSX.utils.aoa_to_sheet(rows)
    sheet['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: headers.length - 1 } }]
    if (useNewRules) {
      // 2026-06-12 修正 (監査): 26列に対し25要素で列幅が1列ずつズレていたのを修正
      setColWidths(sheet, [
        14, 14, 8, 10, 10, 10,
        8, 8, 8, 8,
        9, 10, 9, 9, 9,
        11, 11, 11, 12, 12, 11, 10, 10,
        ...(withAllowance ? [10, 10] : []),
        8, 11, 14,
      ])
    } else {
      setColWidths(sheet, [14, 16, 8, 10, 10, 10, 10, 8, 8, 10, 10, 12, 12, 10, ...(withBreakShorten ? [12] : []), ...(withAllowance ? [10, 10] : []), 8, 12, 12, 14])
    }
    return sheet
  }

  // ── ベトナム人シート（新旧統合・2026-09-17）──
  // キャシュモが MF 取込前の CSV を作る作業を楽にするため、9月分（キャシュモ両社委託の最初の月）から
  // 新ルール・旧ルールを 1 シートにまとめる（代表決定 2026-09-17）。列は両方の和で、
  // 該当しない項目は空欄。残業だけは建て方が違う（新: 所定外1.0倍＋法定外0.25倍／旧: 1.25倍）ので
  // 列を分けたまま隣に置く。行ごとに「内訳合計＝支給額」の検算を付ける。
  // 2026-10-02 総合点検: 枠内補償日・試験日・帰国日数・保証枠・本人の欠勤 を追加（欠勤日数を検算できるように。両社とも同じ列）
  const unifiedHeaders = ['名前', '従業員番号', '契約', '現場', '単価種別', '単価', '所定日数', '法定上限／所定時間(h)',
    '通常出勤', '法休出勤', '補償日', '枠内補償日(100%)', '有給日数', '試験日', '帰国日数', '保証枠', '本人の欠勤(欠)',
    '実労働h', '所定外労働h', '法定残業h(新)／残業h(旧)', '法休労働h', '深夜労働h',
    '基本給', '追加所定手当', '有給日給', '所定外労働手当', '法定外残業手当', '残業手当(旧・1.25倍)',
    '法定休日手当', '深夜手当', '休業手当', '休憩短縮手当',
    ...(withAllowance ? ['遠方日当', '運転手当'] : []),
    '欠勤日数', '欠勤控除', '補償日控除(旧)', '支給額合計']
  function buildUnifiedVnSheet(sheetName: string, ws: WorkerMonthly[]): XLSX.WorkSheet | null {
    if (ws.length === 0) return null
    const rows: (string | number | null)[][] = []
    rows.push([`${sheetName} ${ymLabel(ym)}`])
    rows.push([])
    rows.push(unifiedHeaders)
    const numericRows: (number | null)[][] = []
    const mismatches: string[] = []
    for (const w of ws) {
      const old = isWorkerOldRules(w)
      const wext = w as WorkerMonthly & { nonStatutoryOTHours?: number; nonStatutoryOTAllowance?: number; breakShortenAllowance?: number }
      const siteList = w.sites.map(sid => siteNames[sid] || sid).join(', ')
      const nameWithDispatch = w.isDispatched ? `🔁 ${w.name}（出向: ${w.dispatchTo || ''}）` : w.name
      const rateKind = w.salary ? '月給' : (w.hourlyRate ? '時給' : '—')
      const rateValue = w.salary || w.hourlyRate || 0
      const basePay = w.fixedBasePay || w.basePay || 0
      const otNewStat = old ? null : (w.otAllowance || 0)
      const otOld = old ? (w.otAllowance || 0) : null
      const compAllow = old ? (w.additionalAllowance || 0) : (w.compAllowance || 0)
      const nums: (number | null)[] = [
        w.workerPrescribedDays ?? prescribedDays,
        Math.round((old ? (w.prescribedHours || 0) : (w.legalLimit || 0)) * 10) / 10,
        old ? (w.actualWorkDays || 0) : (w.regularWorkDays || 0),
        old ? null : (w.legalHolidayDays ?? 0),
        w.compDays || 0,
        old ? null : (w.compInGuaranteeDays || 0),
        w.plDays || 0,
        w.examDays || 0,
        w.hkDays || 0,
        old ? null : (w.guaranteeDays ?? null),
        old ? null : (w.personalAbsenceDays ?? 0),
        w.actualWorkHours || 0,
        old ? null : (wext.nonStatutoryOTHours || 0),
        w.legalOtHours || 0,
        old ? null : (w.legalHolidayHours || 0),
        old ? null : (w.nightHours || 0),
        basePay,
        old ? null : (w.additionalAllowance || 0),
        old ? null : (w.paidLeaveAllowance || 0),
        old ? null : (wext.nonStatutoryOTAllowance || 0),
        otNewStat, otOld,
        old ? null : (w.legalHolidayAllowance || 0),
        old ? null : (w.nightAllowance || 0),
        compAllow,
        wext.breakShortenAllowance || 0,
        ...(withAllowance ? [w.siteAllowance || 0, w.driveAllowance || 0] : []),
        w.absence || 0, w.absentDeduction || 0,
        old ? (w.compBaseDeduction || 0) : null,
        w.salaryNetPay || 0,
      ]
      numericRows.push(nums)
      rows.push([nameWithDispatch, w.payrollNo || '', old ? '旧' : '新', siteList, rateKind, rateValue, ...nums])
      // 行ごとの内訳検算
      const parts = basePay + (old ? 0 : (w.additionalAllowance || 0)) + (old ? 0 : (w.paidLeaveAllowance || 0))
        + (old ? 0 : (wext.nonStatutoryOTAllowance || 0)) + (w.otAllowance || 0)
        + (old ? 0 : (w.legalHolidayAllowance || 0)) + (old ? 0 : (w.nightAllowance || 0))
        + compAllow + (wext.breakShortenAllowance || 0) + (w.siteAllowance || 0) + (w.driveAllowance || 0)
        - (w.absentDeduction || 0) - (old ? (w.compBaseDeduction || 0) : 0)
      if (parts !== (w.salaryNetPay || 0)) mismatches.push(w.name)
    }
    // 小計（数値列を縦に合計。所定日数・時間・保証枠の列は合計しない）
    const skip = new Set([0, 1, 9])
    const subtotal: (number | null)[] = numericRows[0].map((_, ci) =>
      skip.has(ci) ? null : Math.round(numericRows.reduce((acc, r) => acc + (r[ci] || 0), 0) * 100) / 100)
    rows.push(['小計', null, null, null, null, null, ...subtotal])
    rows.push([])
    rows.push([mismatches.length === 0
      ? '✓ 自動検算: 全員 内訳合計（基本給＋各手当 − 欠勤控除 − 補償日控除）＝ 支給額合計'
      : `⚠ 自動検算: ${mismatches.join('・')} の内訳合計が支給額合計と一致しません`])
    // 新ルールの割増率チェック（validatePayrolls は内部で新ルールだけを判定する）
    const newOnes = ws.filter(w => !isWorkerOldRules(w))
    if (newOnes.length > 0) appendValidation(rows, newOnes, unifiedHeaders.length)
    rows.push(['※ 契約「新」＝変形労働時間制（時給×20日×7hの固定基本給＋各手当）。「旧」＝固定月給の旧契約（残業1.25倍・現場都合休は補償日控除＋休業手当60%）。空欄はその契約に無い項目。'])
    rows.push(['※ 新契約の欠勤日数 = min(本人の欠勤 ＋ max(0, (保証枠 − 本人の欠勤) − 算入日数), 20 − 算入日数)。算入日数 = 通常出勤 ＋ 有給 ＋ 試験 ＋ 枠内補償日。保証枠 = min(20, カレンダー所定日数)。枠内補償日は100%支給で、休業手当（60%）は 補償日 − 枠内補償日 の分。帰国日数は在籍日数から除外（無給・欠勤に数えない・基本給と所定を日割り）。'])
    const sheet = XLSX.utils.aoa_to_sheet(rows)
    const merges: XLSX.Range[] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: unifiedHeaders.length - 1 } }]
    rows.forEach((r, i) => {
      if (i > 2 && r.length === 1 && typeof r[0] === 'string') merges.push({ s: { r: i, c: 0 }, e: { r: i, c: unifiedHeaders.length - 1 } })
    })
    sheet['!merges'] = merges
    setColWidths(sheet, [14, 9, 5, 14, 8, 10, 8, 12, 8, 8, 8, 9, 8, 7, 8, 7, 9, 9, 10, 12, 9, 9, 11, 11, 11, 12, 12, 12, 11, 10, 10, 11, ...(withAllowance ? [10, 10] : []), 8, 11, 12, 14])
    return sheet
  }

  // ── 日本人シート生成 ──
  function buildJapaneseSheet(sheetName: string, ws: WorkerMonthly[]): XLSX.WorkSheet | null {
    if (ws.length === 0) return null
    const rows: (string | number | null)[][] = []
    rows.push([`${sheetName} ${ymLabel(ym)}`])
    rows.push([])
    rows.push(japaneseHeaders)
    let hasFullMonthly = false
    for (const w of ws) {
      const siteList = w.sites.map(sid => siteNames[sid] || sid).join(', ')
      const nameWithDispatch = w.isDispatched
        ? `🔁 ${w.name}（出向: ${w.dispatchTo || ''}）`
        : w.name
      const isFullMonthly = (w.salary || 0) > 0
      if (isFullMonthly) hasFullMonthly = true
      rows.push([
        nameWithDispatch,
        ...(withJpDetail ? [w.payrollNo || ''] : []),
        siteList,
        isFullMonthly ? '完全月給' : '日給月給',
        isFullMonthly ? (w.salary || 0) : w.rate,
        w.workDays,
        // 日本人の現場都合休（0.6）は compDays でなく出勤日数に 0.6 日として入る → 日数は jpCompDays（2026-10-02）
        ...(withJpDetail ? [w.jpCompDays || w.compDays || 0] : []),
        w.plDays || 0,
        w.dailyOtHours || w.otHours || 0,
        w.basePay || 0, w.paidLeaveAllowance || 0, w.otAllowance || 0,
        ...(withJpLegalHoliday ? [w.legalHolidayAllowance || 0] : []),
        ...(withLeaveSettle ? [w.leaveSettleDays || 0, w.leaveSettleAllowance || 0] : []),
        ...(withAllowance ? [w.siteAllowance || 0, w.driveAllowance || 0] : []),
        ...(withJpDetail ? [w.absence || 0, w.absentDeduction || 0] : []),
        w.salaryNetPay || 0,
      ])
    }
    rows.push([
      '小計', ...(withJpDetail ? [null] : []), null, null, null,
      ws.reduce((s, w) => s + w.workDays, 0),
      ...(withJpDetail ? [ws.reduce((s, w) => s + (w.jpCompDays || w.compDays || 0), 0)] : []),
      ws.reduce((s, w) => s + (w.plDays || 0), 0),
      ws.reduce((s, w) => s + (w.dailyOtHours || w.otHours || 0), 0),
      ws.reduce((s, w) => s + (w.basePay || 0), 0),
      ws.reduce((s, w) => s + (w.paidLeaveAllowance || 0), 0),
      ws.reduce((s, w) => s + (w.otAllowance || 0), 0),
      ...(withJpLegalHoliday ? [ws.reduce((s, w) => s + (w.legalHolidayAllowance || 0), 0)] : []),
      ...(withLeaveSettle ? [
        ws.reduce((s, w) => s + (w.leaveSettleDays || 0), 0),
        ws.reduce((s, w) => s + (w.leaveSettleAllowance || 0), 0),
      ] : []),
      ...(withAllowance ? [
        ws.reduce((s, w) => s + (w.siteAllowance || 0), 0),
        ws.reduce((s, w) => s + (w.driveAllowance || 0), 0),
      ] : []),
      ...(withJpDetail ? [
        ws.reduce((s, w) => s + (w.absence || 0), 0),
        ws.reduce((s, w) => s + (w.absentDeduction || 0), 0),
      ] : []),
      ws.reduce((s, w) => s + (w.salaryNetPay || 0), 0),
    ])
    if (hasFullMonthly) {
      rows.push([])
      rows.push(['※ 完全月給者は出勤日数に関わらず基本給（=月給）を固定支給。「日額/月給」列は月給額。'])
    }
    if (withJpDetail) {
      // 内訳の合計＝支給額合計 の自動検算（外国人シートの validatePayrolls に相当・2026-09-17）。
      //   キャシュモが列を足し上げて確認できるよう、合わない行があれば明示する
      const mismatches = ws.filter(w => {
        const parts = (w.basePay || 0) + (w.paidLeaveAllowance || 0) + (w.otAllowance || 0)
          + (withJpLegalHoliday ? (w.legalHolidayAllowance || 0) : 0)
          + (w.leaveSettleAllowance || 0)
          + (w.siteAllowance || 0) + (w.driveAllowance || 0) - (w.absentDeduction || 0)
        return parts !== (w.salaryNetPay || 0)
      })
      rows.push([])
      rows.push([mismatches.length === 0
        ? '✓ 自動検算: 全員 内訳合計（基本給＋有給手当＋残業手当＋法定休日手当＋手当 − 欠勤控除）＝ 支給額合計'
        : `⚠ 自動検算: ${mismatches.map(w => w.name).join('・')} の内訳合計が支給額合計と一致しません`])
      if (withLeaveSettle) {
        rows.push(['※ 「有給精算手当」は、有給の残りを本人の申請で給料に回した分（日額 × 有給精算日数・日本人の日給月給のみ）。休みの日に有給を取ったものではないため「有給日数」には含めない（年次有給休暇管理簿では買取として記録）。'])
      }
      rows.push(['※ 「補償日」は現場都合休（出面の 0.6）の日数。日給月給は出勤日数に 0.6日 として含め、基本給（日額×人工）に日額の60%で入る。夜勤は 1.5人工（出勤日数には1日）。「欠勤控除」は完全月給者のみ（2026年8月分〜。出面の「欠」＋出勤日の不足分 × 月給÷20.83日）。'])
    }
    const sheet = XLSX.utils.aoa_to_sheet(rows)
    const merges: XLSX.Range[] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: japaneseHeaders.length - 1 } }]
    // 注記・検算の1セル行（3行目以降で要素が1つだけの行）は横に結合して読みやすくする
    rows.forEach((r, i) => {
      if (i > 2 && r.length === 1 && typeof r[0] === 'string') merges.push({ s: { r: i, c: 0 }, e: { r: i, c: japaneseHeaders.length - 1 } })
    })
    sheet['!merges'] = merges
    setColWidths(sheet, [14, ...(withJpDetail ? [9] : []), 16, 10, 12, 8, ...(withJpDetail ? [8] : []), 8, 10, 12, 12, 12, ...(withJpLegalHoliday ? [11] : []), ...(withLeaveSettle ? [10, 12] : []), ...(withAllowance ? [10, 10] : []), ...(withJpDetail ? [8, 12] : []), 14])
    return sheet
  }

  // ── 協力業者シート生成 ──
  function buildSubconSheet(): XLSX.WorkSheet | null {
    if (subcons.length === 0) return null
    const rows: (string | number | null)[][] = []
    const headers = ['外注先', '区分', '現場', '人工', '残業', '単価', '金額']
    rows.push([`協力業者（外注） ${ymLabel(ym)}`])
    rows.push([])
    rows.push(headers)
    for (const sc of subcons) {
      const siteList = sc.sites.map(sid => siteNames[sid] || sid).join(', ')
      rows.push([sc.name, sc.type, siteList, sc.workDays, sc.otCount, sc.rate, sc.cost])
    }
    rows.push([
      '小計', null, null,
      subcons.reduce((s, sc) => s + sc.workDays, 0),
      subcons.reduce((s, sc) => s + sc.otCount, 0),
      null,
      subcons.reduce((s, sc) => s + sc.cost, 0),
    ])
    const sheet = XLSX.utils.aoa_to_sheet(rows)
    sheet['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: headers.length - 1 } }]
    setColWidths(sheet, [18, 8, 18, 8, 8, 10, 14])
    return sheet
  }

  // ── シート登録（順序固定: 日比 → HFU → 外注） ──
  // Excel のシートタブには 31文字制限あり。日本語短めなら問題なし
  // 2026-09-17: 9月分からベトナム人は新旧を 1 シートに統合（キャシュモの要望）。8月分以前は従来の 2 シート
  const unifiedVn = ym >= UNIFIED_VN_SHEET_FROM_YM
  const sheetDefs: { name: string; sheet: XLSX.WorkSheet | null }[] = unifiedVn ? [
    { name: '日比建設・日本人', sheet: buildJapaneseSheet('日比建設・日本人', hibiJapanese) },
    { name: '日比建設・ベトナム人', sheet: buildUnifiedVnSheet('日比建設・ベトナム人', [...hibiForeignNew, ...hibiForeignOld]) },
    { name: 'HFU・日本人', sheet: buildJapaneseSheet('HFU・日本人', hfuJapanese) },
    { name: 'HFU・ベトナム人', sheet: buildUnifiedVnSheet('HFU・ベトナム人', [...hfuForeignNew, ...hfuForeignOld]) },
    { name: '協力業者', sheet: buildSubconSheet() },
  ] : [
    { name: '日比建設・日本人', sheet: buildJapaneseSheet('日比建設・日本人', hibiJapanese) },
    { name: '日比建設・ベトナム人', sheet: buildForeignSheet('日比建設・ベトナム人', hibiForeignNew, false) },
    { name: '日比建設・ベトナム人(旧)', sheet: buildForeignSheet('日比建設・ベトナム人', hibiForeignOld, true) },
    { name: 'HFU・日本人', sheet: buildJapaneseSheet('HFU・日本人', hfuJapanese) },
    { name: 'HFU・ベトナム人', sheet: buildForeignSheet('HFU・ベトナム人', hfuForeignNew, false) },
    { name: 'HFU・ベトナム人(旧)', sheet: buildForeignSheet('HFU・ベトナム人', hfuForeignOld, true) },
    { name: '協力業者', sheet: buildSubconSheet() },
  ]
  for (const d of sheetDefs) {
    if (d.sheet) XLSX.utils.book_append_sheet(wb, d.sheet, d.name)
  }

  // フォールバック: 1シートも作られていない場合は空のサマリーシートを追加
  if (wb.SheetNames.length === 0) {
    const emptySheet = XLSX.utils.aoa_to_sheet([[`月次集計 ${ymLabel(ym)} — 該当データなし`]])
    XLSX.utils.book_append_sheet(wb, emptySheet, '月次集計')
  }
  return wb
}

// ────────────────────────────────────────
//  現場別出面一覧
// ────────────────────────────────────────

export interface PerSiteAttendanceData {
  ym: string
  workers: RawWorker[]
  attD: Record<string, AttendanceEntry>
  sites: { id: string; name: string; archived?: boolean }[]
  assign: Record<string, { workers?: number[]; subcons?: string[] }>
  massign: Record<string, { workers?: number[]; subcons?: string[] }>
}

export function generatePerSiteAttendance(data: PerSiteAttendanceData): XLSX.WorkBook {
  const { ym, workers, attD, sites } = data
  const numDays = daysInMonth(ym)
  const wb = XLSX.utils.book_new()

  // 日付ヘッダー
  const dayHeaders: string[] = []
  for (let d = 1; d <= numDays; d++) {
    dayHeaders.push(dayLabel(ym, d))
  }

  // ワーカーマップ
  const workerMap = new Map(workers.map(w => [w.id, w]))

  // 各現場の出勤データを集計
  const siteWorkerData = new Map<string, Set<number>>()
  for (const key of Object.keys(attD)) {
    const pk = parseDKey(key)
    if (!pk || pk.ym !== ym) continue
    const entry = attD[key]
    if (!entry) continue
    if (!siteWorkerData.has(pk.sid)) siteWorkerData.set(pk.sid, new Set())
    siteWorkerData.get(pk.sid)!.add(Number(pk.wid))
  }

  // アクティブな現場のみ（出勤データがある現場のみシートを生成）
  const activeSites = sites.filter(s => siteWorkerData.has(s.id))

  for (const site of activeSites) {
    const siteWorkerIds = siteWorkerData.get(site.id) || new Set()

    // 日比建設ワーカーとHFUワーカーに分ける（退職月の在籍スタッフは含める）
    const hibiWorkers = Array.from(siteWorkerIds)
      .map(id => workerMap.get(id))
      .filter((w): w is RawWorker => !!w && isStillActiveForMonth(w.retired, ym) && isHiredByMonth(w.hireDate, ym) && (w.org === '日比' || w.org === 'hibi'))
    const hfuWorkers = Array.from(siteWorkerIds)
      .map(id => workerMap.get(id))
      .filter((w): w is RawWorker => !!w && isStillActiveForMonth(w.retired, ym) && isHiredByMonth(w.hireDate, ym) && (orgKeyOf(w.org) === 'hfu' || orgKeyOf(w.org) === 'hfu'))

    if (hibiWorkers.length === 0 && hfuWorkers.length === 0) continue

    const rows: (string | number)[][] = []

    // タイトル行
    rows.push([`${site.name}　出面一覧　${ymLabel(ym)}`])

    // セクション出力関数
    const appendSection = (sectionLabel: string, sectionWorkers: RawWorker[]) => {
      if (sectionWorkers.length === 0) return

      // 空行 + セクション見出し
      rows.push([])
      rows.push([`【${sectionLabel}】${sectionWorkers.length}名`])

      // ヘッダー
      const headerRow = ['名前', '区分', ...dayHeaders, '合計']
      rows.push(headerRow)

      let secWork = 0
      let secOT = 0
      const secDailyWork: number[] = new Array(numDays).fill(0)
      const secDailyOT: number[] = new Array(numDays).fill(0)

      for (const w of sectionWorkers) {
        const workRow: (string | number)[] = [w.name, '出勤']
        const otRow: (string | number)[] = ['', '残業h']

        let wWork = 0
        let wOT = 0

        for (let d = 1; d <= numDays; d++) {
          const dd = String(d)
          const key = `${site.id}_${w.id}_${ym}_${dd}`
          const entry = attD[key]

          let dayWork: string | number = ''
          let dayOT = 0

          if (entry) {
            if (entry.p) {
              dayWork = '有'
              // 有給日は残業を計上しない（旧コードは entry.o があれば加算していたバグ）
            } else if (isWorkingDay(entry) && entry.w && entry.w > 0) {
              // ⚠️ 2026-05-09: 残骸データ対策。isWorkingDay で休み/現場休/帰国中/試験 を除外
              // 2026-08-13: 元請け請求ベース（出面入力ベース）に統一。夜勤日は 1.5人工 が乗る
              const md = calcManDays(entry)
              dayWork = md
              wWork += md
              secDailyWork[d - 1] += md
              if (entry.o && entry.o > 0) {
                dayOT = entry.o
                wOT += dayOT
                secDailyOT[d - 1] += dayOT
              }
            }
          }

          workRow.push(dayWork || '')
          otRow.push(dayOT > 0 ? dayOT : '')
        }

        workRow.push(wWork > 0 ? Math.round(wWork * 10) / 10 : '')
        otRow.push(wOT > 0 ? Math.round(wOT * 10) / 10 : '')

        secWork += wWork
        secOT += wOT

        rows.push(workRow)
        rows.push(otRow)
      }

      // セクション小計
      const footerWork: (string | number)[] = ['小計', '出勤']
      const footerOT: (string | number)[] = ['', '残業h']
      for (let d = 0; d < numDays; d++) {
        footerWork.push(secDailyWork[d] > 0 ? Math.round(secDailyWork[d] * 10) / 10 : '')
        footerOT.push(secDailyOT[d] > 0 ? Math.round(secDailyOT[d] * 10) / 10 : '')
      }
      footerWork.push(Math.round(secWork * 10) / 10)
      footerOT.push(Math.round(secOT * 10) / 10)
      rows.push(footerWork)
      rows.push(footerOT)
    }

    appendSection('日比建設', hibiWorkers)
    appendSection('HFU', hfuWorkers)

    const ws = XLSX.utils.aoa_to_sheet(rows)

    // タイトル行マージ
    ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: numDays + 2 } }]

    // 列幅
    const colWidths = [14, 6]
    for (let d = 0; d < numDays; d++) colWidths.push(7)
    colWidths.push(6)
    setColWidths(ws, colWidths)

    // シート名（31文字制限）
    const sheetName = site.name.slice(0, 31)
    XLSX.utils.book_append_sheet(wb, ws, sheetName)
  }

  return wb
}
