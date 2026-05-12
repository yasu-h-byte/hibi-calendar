/**
 * 評価者ウェイト算出ユーティリティ
 *
 * 「直近1年で実際に対象スタッフと一緒に現場にいた職長」の意見を
 * 多数決プリフィルで重く反映するためのウェイト計算ロジック。
 *
 * 数式（2026-05-12 改訂）:
 *   admin/approver（固定ウェイト）:
 *     APPROVER_WEIGHTS マップで個別指定
 *       0: 靖仁さん = 0.5（事業責任者だが現場接点が少ないため抑制）
 *       1: 政仁さん = 1.0（事業責任者）
 *
 *   その他（職長）— 直近1年フラット方式:
 *     yearDays = 評価日から過去365日の共働日数
 *     weight = 0.3 + 0.7 * (min(yearDays, 200) / 200)
 *     範囲: 0.3 〜 1.0
 *       - 0日   → 0.30（最低）
 *       - 100日 → 0.65
 *       - 200日+→ 1.00（上限）
 *
 * 共働日数の定義:
 *   対象スタッフが「その評価者が月の職長として責任を持っていた現場」で
 *   実出勤した日数。月の職長は mforeman[siteId_ym] → site.foreman の順で解決。
 *   出勤判定は isWorkingDay() を使用（残骸データの混入を防ぐ）。
 *
 * 旧仕様（2026-05-09 〜 2026-05-12）:
 *   weight = 0.3 + 0.4 * (recentCap / 60) + 0.3 * (yearCap / 200)
 *   直近90日にボーナス重み付けしていたが、ロジックが直感的でないとの指摘で簡素化。
 *   recentDays/recentPct は参考表示用に残している。
 */

import { isWorkingDay } from './attendance'
import { getAttData, getMainData, parseDKey, type MainData } from './compute'
import type { AttendanceEntry } from '@/types'

/**
 * 事業責任者として固定ウェイトを持つ workerId のマップ
 * 共働実績によらず指定値を使用。
 */
export const APPROVER_WEIGHTS: Record<number, number> = {
  0: 0.5,  // 靖仁さん（super admin）
  1: 0.7,  // 政仁さん（事業責任者）
}

/** 後方互換: 旧 APPROVER_WORKER_IDS の代替（呼び出し側で in 演算子を使う） */
export const APPROVER_WORKER_IDS = new Set<number>(
  Object.keys(APPROVER_WEIGHTS).map(k => Number(k)),
)

export interface EvaluatorWeight {
  evaluatorId: number
  recentDays: number    // 直近90日の共働日数（参考表示用、ウェイトには影響しない）
  yearDays: number      // 過去365日の共働日数（ウェイト計算の主たる入力）
  recentPct: number     // recentDays / 60 * 100 をcap (0〜100, 参考)
  yearPct: number       // yearDays / 200 * 100 をcap (0〜100)
  weight: number        // 0.3 〜 1.0 の範囲（小数2桁丸め）
  isApprover: boolean   // approver/admin として 固定ウェイトを受けたか
}

export type EvaluatorWeightMap = Record<number, EvaluatorWeight>

/**
 * 評価対象スタッフ × 評価者 の共働日数を集計し、ウェイトを計算する。
 *
 * @param workerId       評価対象スタッフのID
 * @param evaluatorIds   ウェイトを算出する評価者IDのリスト
 * @param evaluationDate 評価日 (YYYY-MM-DD) — この日付を基準に過去365日/90日を遡る
 * @param main           main データ（省略時は内部で取得）
 * @returns 評価者IDをキーとしたウェイトマップ
 */
export async function calcEvaluatorWeights(
  workerId: number,
  evaluatorIds: number[],
  evaluationDate: string,
  main?: MainData,
): Promise<EvaluatorWeightMap> {
  const evalDate = new Date(evaluationDate)
  const recent90Cut = new Date(evalDate)
  recent90Cut.setDate(recent90Cut.getDate() - 90)
  const yearCut = new Date(evalDate)
  yearCut.setDate(yearCut.getDate() - 365)

  // 過去13ヶ月分の att を網羅（評価日が月初の場合に365日前は前年の同月をまたぐ可能性があるため）
  const ymList: string[] = []
  for (let i = 0; i < 13; i++) {
    const d = new Date(evalDate)
    d.setMonth(d.getMonth() - i)
    ymList.push(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`)
  }

  const mainData = main ?? (await getMainData())
  const attResults = await Promise.all(ymList.map(ym => getAttData(ym)))

  // 各評価者ID -> 共働日数集計
  const tally: Record<number, { recentDays: number; yearDays: number }> = {}
  for (const id of evaluatorIds) tally[id] = { recentDays: 0, yearDays: 0 }

  // 月別 site → foreman 解決のヘルパー
  // 月単位の mforeman > 全体 site.foreman の順で解決
  function resolveForeman(siteId: string, ym: string): number | null {
    const mfk = `${siteId}_${ym}`
    const monthlyForeman = mainData.mforeman[mfk]?.foreman
    if (typeof monthlyForeman === 'number') return monthlyForeman
    const site = mainData.sites.find(s => s.id === siteId)
    return typeof site?.foreman === 'number' ? site.foreman : null
  }

  // 全 att エントリを走査
  for (let i = 0; i < ymList.length; i++) {
    const ym = ymList[i]
    const att = attResults[i]
    for (const [key, entry] of Object.entries(att.d)) {
      if (!entry) continue
      const pk = parseDKey(key)
      if (pk.wid !== String(workerId)) continue
      if (pk.ym !== ym) continue
      // 出勤日のみ対象（残骸データ・有給・休み等は除外）
      if (!isWorkingDay(entry as AttendanceEntry)) continue

      const dayN = parseInt(pk.day, 10)
      if (!Number.isFinite(dayN) || dayN <= 0) continue
      const date = new Date(parseInt(ym.slice(0, 4)), parseInt(ym.slice(4, 6)) - 1, dayN)
      if (date < yearCut || date > evalDate) continue

      const foremanId = resolveForeman(pk.sid, ym)
      if (foremanId === null) continue
      if (!evaluatorIds.includes(foremanId)) continue

      tally[foremanId].yearDays += 1
      if (date >= recent90Cut) tally[foremanId].recentDays += 1
    }
  }

  // ウェイト算出
  const result: EvaluatorWeightMap = {}
  for (const id of evaluatorIds) {
    const isApprover = id in APPROVER_WEIGHTS
    const t = tally[id]
    const recentDays = t.recentDays
    const yearDays = t.yearDays
    const recentCap = Math.min(recentDays, 60)
    const yearCap = Math.min(yearDays, 200)
    const recentPct = Math.round((recentCap / 60) * 100)
    const yearPct = Math.round((yearCap / 200) * 100)

    let weight: number
    if (isApprover) {
      weight = APPROVER_WEIGHTS[id]
    } else {
      // 直近1年フラット方式: 過去365日の共働日数のみで決定
      const raw = 0.3 + 0.7 * (yearCap / 200)
      weight = Math.round(raw * 100) / 100
    }

    result[id] = {
      evaluatorId: id,
      recentDays,
      yearDays,
      recentPct,
      yearPct,
      weight,
      isApprover,
    }
  }

  return result
}
