#!/usr/bin/env node
/**
 * 所定外労働手当 (nonStatutoryOTAllowance) の不払い額を集計
 *
 * 2026-06 修正前の旧ルール実装では、月所定 140h 超〜法定上限 177h以内の
 * 労働（所定外労働）に対して通常賃金が支払われていなかった可能性がある。
 *
 * 本スクリプトは、2026/5月以降の各月について、新ルールで再計算した
 * 支給額と既支給額の差を算出し、不払い対象者・金額を一覧化する。
 *
 * 出力:
 *   - 各月・各スタッフの「不払い額（万円単位）」
 *   - 累計不払い額
 *   - 補填対象者リスト（CSV形式で出力）
 *
 * 使い方:
 *   node scripts/audit-unpaid-non-statutory-ot.mjs
 *
 * 前提:
 *   - Firestore の att_YYYYMM ドキュメントが揃っている
 *   - main.workers の hourlyRate / salary が正しく設定済
 *   - 該当月の siteWorkDays が承認済（カレンダー approve 済）
 *
 * 注意:
 *   - 本スクリプトは「現在の compute.ts ロジック」で再計算した値を
 *     基準とする。修正前の旧支給額を再現するためには、別途
 *     旧コミット (a4a038c) でビルドした compute.ts が必要。
 *   - 実際の遡及補填には、社労士確認と本人同意書取得が必須。
 *
 * 実装:
 *   - 各月の att_YYYYMM を取得
 *   - main.workers を取得
 *   - 各ワーカーについて、新ロジックの calculateVietnameseSalary で
 *     再計算し、現状の salaryNetPay と比較
 *   - 差額 > ¥0 なら不払い対象
 */

import { initializeApp, applicationDefault, getApps } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

const FIRESTORE_PROJECT = 'dedura-kanri'

if (!getApps().length) {
  initializeApp({
    credential: applicationDefault(),
    projectId: FIRESTORE_PROJECT,
  })
}
const db = getFirestore()

// 対象月リスト（2026/5 〜 直近月）
const TARGET_MONTHS = ['202605', '202606']

async function main() {
  console.log(`所定外労働手当 不払い監査スクリプト`)
  console.log(`対象月: ${TARGET_MONTHS.join(', ')}`)
  console.log(`================================\n`)

  // main データを取得
  const mainSnap = await db.collection('demmen').doc('main').get()
  if (!mainSnap.exists) {
    console.error('❌ main データが取得できません')
    process.exit(1)
  }
  const main = mainSnap.data()

  // 外国人スタッフ（新ルール対象）
  const targetWorkers = main.workers.filter(w =>
    w.visa && w.visa !== 'none' && !w.useOldRules
  )
  console.log(`対象スタッフ数: ${targetWorkers.length}名（新ルール外国人）\n`)

  const unpaidRecords = []

  for (const ym of TARGET_MONTHS) {
    console.log(`\n──── ${ym} ────`)

    const attSnap = await db.collection('demmen').doc(`att_${ym}`).get()
    if (!attSnap.exists) {
      console.log(`  (出面データなし)`)
      continue
    }
    const att = attSnap.data()

    // 簡易: 各スタッフの月集計から所定外労働時間を推定
    // 注: 正確な計算には compute.ts の calculateVietnameseSalary 相当を再実装する必要あり
    //     ここでは「entry.o の合計」を所定外労働時間の上限として扱う
    for (const w of targetWorkers) {
      let totalOTHours = 0
      let hasData = false
      for (const [key, entry] of Object.entries(att.d || {})) {
        const [siteId, wid, kym, day] = key.split('_')
        if (wid !== String(w.id)) continue
        if (kym !== ym) continue
        if (!entry || typeof entry !== 'object') continue
        if (entry.p || entry.r || entry.h || entry.hk || entry.exam) continue
        if (!entry.w || entry.w === 0.6) continue
        hasData = true
        totalOTHours += (entry.o || 0)
      }

      if (!hasData || totalOTHours === 0) continue

      const hourlyRate = w.hourlyRate || (w.salary ? w.salary / 140 : 0)
      // 簡易見積: statutoryOT を 1.0h と仮定（実際は3層判定が必要）
      // 正確な値が必要なら compute.ts の再実装が必須
      const estimatedNonStatutoryOT = Math.max(0, totalOTHours - 1.0)
      const estimatedUnpaid = Math.round(hourlyRate * estimatedNonStatutoryOT)

      if (estimatedUnpaid > 0) {
        unpaidRecords.push({
          ym, id: w.id, name: w.name, org: w.org,
          totalOTHours, estimatedNonStatutoryOT, estimatedUnpaid,
        })
        console.log(
          `  ${w.id} ${w.name} (${w.org}): 残業${totalOTHours}h → 推定不払い ¥${estimatedUnpaid.toLocaleString()}`
        )
      }
    }
  }

  console.log(`\n================================`)
  console.log(`合計不払い件数: ${unpaidRecords.length}件`)
  const totalUnpaid = unpaidRecords.reduce((s, r) => s + r.estimatedUnpaid, 0)
  console.log(`合計推定不払い額: ¥${totalUnpaid.toLocaleString()}`)
  console.log(`\n⚠️ 本数値は概算です。正確な金額は新ルール (compute.ts) で月次集計を再実行してください。`)
  console.log(`⚠️ 補填には社労士確認 + 本人同意書取得が必須です。`)

  // CSV 出力
  if (unpaidRecords.length > 0) {
    const csv = ['ym,id,name,org,totalOTHours,estimatedNonStatutoryOT,estimatedUnpaid']
    for (const r of unpaidRecords) {
      csv.push(`${r.ym},${r.id},${r.name},${r.org},${r.totalOTHours},${r.estimatedNonStatutoryOT},${r.estimatedUnpaid}`)
    }
    const fs = await import('fs/promises')
    const outFile = `audit-unpaid-${Date.now()}.csv`
    await fs.writeFile(outFile, csv.join('\n'), 'utf-8')
    console.log(`\nCSV 出力: ${outFile}`)
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
