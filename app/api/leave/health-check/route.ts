/**
 * 休暇管理の健全性チェック API（2026-06-XX 新設）
 *
 * 目的:
 *   - 保守ツール（繰越再計算・データ正規化・自動修正・時効処理）が
 *     「今、本当に必要なのか」を画面側に伝える
 *   - 不要なら保守ツールボタンをグレーアウトし、誤操作を防ぐ
 *
 * チェック項目:
 *   1. needsNormalization: 正規化が必要なレコード件数
 *      - 旧フィールド(grant/carry/adj)が残っている
 *      - fy が string でない
 *      - grantDate が欠落
 *      - 同一 fy の重複レコード
 *      - 期限切れだがアーカイブ未処理
 *   2. needsFyAutoFix: fy と grantDate の年が不整合な件数
 *   3. needsExpiryProcess: 時効処理が必要なレコード件数
 *      - 付与日+2年 を過ぎているが _archived: false
 *   4. lastExpiryRun: 時効処理 (Cron) の最終実行時刻
 *
 * 出力:
 *   { ok: boolean, counts: {...}, lastExpiryRun: string | null }
 *   ok = true → 保守ツール不要（全件 0）
 *   ok = false → 何らかの保守が必要
 */

import { NextRequest, NextResponse } from 'next/server'
import { checkApiAuth } from '@/lib/auth'
import { db } from '@/lib/firebase'
import { doc, getDoc } from '@/lib/fsdb'
import { todayJstIso, calcExpiryIso } from '@/lib/date-utils'

export const dynamic = 'force-dynamic'

type PLRec = {
  fy: string | number
  grantDate?: string
  grantDays?: number
  grant?: number
  carryOver?: number
  carry?: number
  adjustment?: number
  adj?: number
  _archived?: boolean
}

export async function GET(request: NextRequest) {
  if (!await checkApiAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const mainSnap = await getDoc(doc(db, 'demmen', 'main'))
  if (!mainSnap.exists()) {
    return NextResponse.json({ ok: true, counts: {} })
  }
  const main = mainSnap.data()
  const plData = (main.plData || {}) as Record<string, PLRec[]>
  const today = todayJstIso()

  let needsNormalization = 0
  let needsFyAutoFix = 0
  let needsExpiryProcess = 0
  const samples = {
    normalization: [] as string[],
    fyAutoFix: [] as string[],
    expiry: [] as string[],
  }

  for (const [wid, records] of Object.entries(plData)) {
    if (!Array.isArray(records)) continue
    const workerName = (main.workers || []).find((w: { id: number; name: string }) => String(w.id) === wid)?.name || `ID:${wid}`

    // 同一 fy の重複検出
    const fySeen = new Set<string>()
    for (const r of records) {
      // 1. 旧フィールド
      const hasLegacy = r.grant !== undefined || r.carry !== undefined || r.adj !== undefined
      // 2. fy 型ブレ
      const fyTypeBlur = typeof r.fy === 'number'
      // 3. grantDate 欠落（grantDays > 0 のものに限る）
      const grantDaysVal = r.grantDays ?? r.grant ?? 0
      const grantDateMissing = grantDaysVal > 0 && !r.grantDate
      // 4. 同一 fy 重複
      const fyKey = String(r.fy)
      const fyDup = fySeen.has(fyKey)
      fySeen.add(fyKey)
      // 5. 期限切れアーカイブ漏れ
      let expiryArchiveNeeded = false
      if (r.grantDate && !r._archived) {
        const expiry = calcExpiryIso(r.grantDate)
        if (expiry < today) expiryArchiveNeeded = true
      }

      if (hasLegacy || fyTypeBlur || grantDateMissing || fyDup || expiryArchiveNeeded) {
        needsNormalization++
        if (samples.normalization.length < 5) {
          const reasons: string[] = []
          if (hasLegacy) reasons.push('旧フィールド残存')
          if (fyTypeBlur) reasons.push('fy型ズレ')
          if (grantDateMissing) reasons.push('grantDate欠落')
          if (fyDup) reasons.push('fy重複')
          if (expiryArchiveNeeded) reasons.push('期限切れ未アーカイブ')
          samples.normalization.push(`${workerName} fy=${r.fy}: ${reasons.join(', ')}`)
        }
      }

      // fy/grantDate 年ズレ
      if (r.grantDate) {
        const grantYear = r.grantDate.slice(0, 4)
        if (String(r.fy) !== grantYear) {
          needsFyAutoFix++
          if (samples.fyAutoFix.length < 5) {
            samples.fyAutoFix.push(`${workerName}: fy=${r.fy}, grantDate=${r.grantDate}`)
          }
        }
      }

      // 時効処理が必要（_archived: false かつ expiry < today かつ実際に失効日数が出る）
      if (r.grantDate && !r._archived) {
        const expiry = calcExpiryIso(r.grantDate)
        if (expiry < today) {
          needsExpiryProcess++
          if (samples.expiry.length < 5) {
            samples.expiry.push(`${workerName} fy=${r.fy}: ${r.grantDate} → 期限 ${expiry}`)
          }
        }
      }
    }
  }

  // 時効処理 Cron の最終実行時刻（demmen/system に保存される想定、未実装なら null）
  let lastExpiryRun: string | null = null
  try {
    const sysSnap = await getDoc(doc(db, 'demmen', 'system'))
    if (sysSnap.exists()) {
      const sys = sysSnap.data()
      lastExpiryRun = (sys.lastExpiryRun as string) || null
    }
  } catch { /* ignore */ }

  const ok = needsNormalization === 0 && needsFyAutoFix === 0 && needsExpiryProcess === 0

  return NextResponse.json({
    ok,
    counts: {
      needsNormalization,
      needsFyAutoFix,
      needsExpiryProcess,
    },
    samples,
    lastExpiryRun,
  })
}
