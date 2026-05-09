#!/usr/bin/env node
/**
 * 出面入力（p フラグ）と有給管理 (plData) の整合性監査スクリプト
 *
 * 検査項目:
 *   1. att_* に書かれた p:1 を全件集計
 *   2. 多現場の同日重複（multi-site dup）を検出
 *   3. 残骸パターン（w>0 + p:1 共存）を検出
 *   4. p:1 だが w:0 でない異常を検出
 *   5. 各ワーカーの「現FYで実際にPLを使った日数」を算出
 *      → plData の grantDays + carryOver - adjustment - 計算used で残日数を再計算
 *   6. designatedLeaves（手動計上）と att 上の p の整合性
 *
 * 使い方:
 *   node scripts/audit-pl-attendance.mjs
 *   node scripts/audit-pl-attendance.mjs --wid=205   # ワーカー指定
 *   node scripts/audit-pl-attendance.mjs --verbose   # 詳細出力
 */
import { initializeApp } from 'firebase/app'
import { getFirestore, doc, getDoc, collection, getDocs } from 'firebase/firestore'

const firebaseConfig = {
  apiKey: 'AIzaSyAcA_kFC8hAqfmS_-_tOxI5oyjH06WNOwM',
  authDomain: 'dedura-kanri.firebaseapp.com',
  projectId: 'dedura-kanri',
  storageBucket: 'dedura-kanri.firebasestorage.app',
  messagingSenderId: '372352470111',
  appId: '1:372352470111:web:136292eb630abddde3dfea',
}

const app = initializeApp(firebaseConfig)
const db = getFirestore(app)

const args = process.argv.slice(2)
const widArg = args.find(a => a.startsWith('--wid='))
const targetWid = widArg ? Number(widArg.slice(6)) : null
const verbose = args.includes('--verbose')

function parseDKey(k) {
  const p = k.split('_')
  if (p.length < 4) return null
  const day = p[p.length - 1]
  const ym = p[p.length - 2]
  const wid = p[p.length - 3]
  const sid = p.slice(0, p.length - 3).join('_')
  return { sid, wid: parseInt(wid), ym, day }
}

async function main() {
  // 1. main データ取得
  const mainSnap = await getDoc(doc(db, 'demmen', 'main'))
  if (!mainSnap.exists()) throw new Error('main doc not found')
  const main = mainSnap.data()
  const workers = main.workers || []
  const plData = main.plData || {}

  // 2. 全 att_* doc を取得（過去2年程度）
  const colSnap = await getDocs(collection(db, 'demmen'))
  const attDocs = {}
  for (const d of colSnap.docs) {
    if (!/^att_\d{6}$/.test(d.id)) continue
    attDocs[d.id.slice(4)] = d.data().d || {}
  }
  const ymList = Object.keys(attDocs).sort()
  console.log(`📅 検査対象期間: ${ymList[0]} 〜 ${ymList[ymList.length - 1]} (${ymList.length}ヶ月)`)
  console.log()

  // 3. 全エントリから p:1 を抽出して (workerId, ym, day, sid) でインデックス化
  const plEntries = []  // {wid, ym, day, sid, w, hasPLBoolean, hasOtherFlag}
  for (const [ym, d] of Object.entries(attDocs)) {
    for (const [key, entry] of Object.entries(d)) {
      if (!entry || typeof entry !== 'object') continue
      if (!entry.p) continue
      const pk = parseDKey(key)
      if (!pk) continue
      if (pk.ym !== ym) continue   // 整合性チェック
      plEntries.push({
        wid: pk.wid,
        ym: pk.ym,
        day: parseInt(pk.day),
        sid: pk.sid,
        w: entry.w ?? 0,
        o: entry.o ?? 0,
        r: entry.r ?? 0,
        h: entry.h ?? 0,
        hk: entry.hk ?? 0,
        exam: entry.exam ?? 0,
        pType: typeof entry.p,
        pVal: entry.p,
      })
    }
  }
  console.log(`🔎 p フラグありエントリ: ${plEntries.length}件`)
  console.log()

  // 4. 異常検出
  const issues = {
    multiSiteDup: [],      // 同日に2現場以上
    coexistWork: [],       // p:1 + w>0 (残骸)
    coexistOtherFlag: [],  // p:1 + r/h/hk/exam
    nonNumericP: [],       // p が 1 / true 以外
  }

  // (wid, ym, day) でグループ化
  const byDate = {}
  for (const e of plEntries) {
    const k = `${e.wid}_${e.ym}_${e.day}`
    if (!byDate[k]) byDate[k] = []
    byDate[k].push(e)
  }
  for (const [k, group] of Object.entries(byDate)) {
    if (group.length > 1) issues.multiSiteDup.push({ k, group })
  }
  for (const e of plEntries) {
    if (e.w > 0) issues.coexistWork.push(e)
    if (e.r > 0 || e.h > 0 || e.hk > 0 || e.exam > 0) issues.coexistOtherFlag.push(e)
    if (e.pVal !== 1 && e.pVal !== true) issues.nonNumericP.push(e)
  }

  console.log('━━━━ 異常検出結果 ━━━━')
  console.log(`  多現場の同日重複   : ${issues.multiSiteDup.length}件`)
  console.log(`  p:1 + w>0 残骸     : ${issues.coexistWork.length}件`)
  console.log(`  p:1 + 他フラグ共存 : ${issues.coexistOtherFlag.length}件`)
  console.log(`  非標準のp値         : ${issues.nonNumericP.length}件`)
  console.log()

  if (verbose) {
    if (issues.multiSiteDup.length > 0) {
      console.log('--- 多現場の同日重複 詳細 ---')
      for (const { k, group } of issues.multiSiteDup) {
        const wname = workers.find(w => w.id === group[0].wid)?.name || `?`
        console.log(`  ${k} ${wname} (${group.length}件):`)
        for (const e of group) {
          console.log(`    sid=${e.sid} w=${e.w} pVal=${e.pVal}`)
        }
      }
      console.log()
    }
    if (issues.coexistWork.length > 0) {
      console.log('--- p:1 + w>0 残骸 詳細 ---')
      for (const e of issues.coexistWork) {
        const wname = workers.find(w => w.id === e.wid)?.name || `?`
        console.log(`  ${wname} ${e.ym}/${e.day} sid=${e.sid} w=${e.w} p=${e.pVal} o=${e.o}`)
      }
      console.log()
    }
    if (issues.coexistOtherFlag.length > 0) {
      console.log('--- p:1 + 他フラグ共存 詳細 ---')
      for (const e of issues.coexistOtherFlag) {
        const wname = workers.find(w => w.id === e.wid)?.name || `?`
        console.log(`  ${wname} ${e.ym}/${e.day} sid=${e.sid} r=${e.r} h=${e.h} hk=${e.hk} exam=${e.exam}`)
      }
      console.log()
    }
  }

  // 5. ワーカーごとの集計と plData 残日数の整合性チェック
  console.log('━━━━ ワーカー別 PL消化集計と plData 整合性 ━━━━')
  const eligibleWorkers = workers.filter(w => !w.retired && w.job !== 'yakuin' && w.hireDate !== undefined)
  for (const w of eligibleWorkers) {
    if (targetWid !== null && w.id !== targetWid) continue
    const records = plData[String(w.id)] || []
    const isJp = !w.visa || w.visa === 'none'

    // 該当ワーカーの p エントリ（重複は1日1カウントに正規化）
    const myEntries = plEntries.filter(e => e.wid === w.id)
    const dedupedDates = new Set()
    for (const e of myEntries) {
      const dk = `${e.ym}_${String(e.day).padStart(2, '0')}`
      dedupedDates.add(dk)
    }
    const totalPLDays = dedupedDates.size
    const totalRawCount = myEntries.length  // 重複含む生カウント

    // 月別内訳
    const byMonth = {}
    for (const dk of dedupedDates) {
      const ym = dk.split('_')[0]
      byMonth[ym] = (byMonth[ym] || 0) + 1
    }

    // 現FY（最新の grantDate を持つ非archived レコード）の grantDate 〜 +1年で集計
    const activeRecords = records.filter(r => !r._archived)
    const withGrant = activeRecords.filter(r => r.grantDate)
    let currentFy = null
    if (withGrant.length > 0) {
      currentFy = withGrant.reduce((best, r) => (r.grantDate > (best?.grantDate || '') ? r : best))
    }

    // 現FYの実消化日数（重複排除済み）
    let currentFyUsed = 0
    if (currentFy?.grantDate) {
      const gd = new Date(currentFy.grantDate)
      const gdEnd = new Date(gd)
      gdEnd.setFullYear(gdEnd.getFullYear() + 1)
      for (const dk of dedupedDates) {
        const [ym, day] = dk.split('_')
        const date = new Date(parseInt(ym.slice(0, 4)), parseInt(ym.slice(4, 6)) - 1, parseInt(day))
        if (date >= gd && date < gdEnd) currentFyUsed++
      }
    }

    // システム計算（leave/route.ts と同じロジック - 重複あり）
    let sysUsed = 0
    if (currentFy?.grantDate) {
      const gd = new Date(currentFy.grantDate)
      const gdEnd = new Date(gd)
      gdEnd.setFullYear(gdEnd.getFullYear() + 1)
      for (const e of myEntries) {
        const date = new Date(parseInt(e.ym.slice(0, 4)), parseInt(e.ym.slice(4, 6)) - 1, e.day)
        if (date >= gd && date < gdEnd) sysUsed++
      }
    }

    const grantDays = currentFy?.grantDays || currentFy?.grant || 0
    const carry = currentFy?.carryOver || currentFy?.carry || 0
    const adj = currentFy?.adjustment || currentFy?.adj || 0
    const total = grantDays + carry
    const sysRemaining = Math.max(0, total - adj - sysUsed)
    const correctRemaining = Math.max(0, total - adj - currentFyUsed)

    const dupDelta = sysUsed - currentFyUsed
    const flag = dupDelta !== 0 ? '⚠️ 重複あり' : '✓'

    if (targetWid !== null || dupDelta !== 0 || verbose) {
      console.log(
        `  ${flag} [${w.id}] ${w.name} (${isJp ? '日本' : 'Vietnamese'}) ` +
        `現FY: ${currentFy?.grantDate || '未設定'}`,
      )
      console.log(
        `      付与:${grantDays} 繰越:${carry} 調整:${adj} → 合計:${total}`,
      )
      console.log(
        `      実消化(重複排除): ${currentFyUsed}日 / システム計算(重複あり): ${sysUsed}日 / 差分: ${dupDelta}`,
      )
      console.log(
        `      残日数 → 正解: ${correctRemaining}日 / システム表示: ${sysRemaining}日`,
      )
      if (verbose) {
        console.log(`      全期間PLエントリ: 重複排除 ${totalPLDays}日 / 生${totalRawCount}件`)
        if (Object.keys(byMonth).length > 0) {
          const monthly = Object.entries(byMonth).sort().map(([ym, n]) => `${ym}:${n}`).join(' ')
          console.log(`      月別: ${monthly}`)
        }
      }
    }
  }

  // 6. 全体サマリ
  console.log()
  console.log('━━━━ サマリ ━━━━')
  console.log(`  総 p エントリ: ${plEntries.length} 件（重複含む）`)
  const uniqueDates = new Set(plEntries.map(e => `${e.wid}_${e.ym}_${e.day}`))
  console.log(`  重複排除後   : ${uniqueDates.size} 件`)
  console.log(`  重複差分     : ${plEntries.length - uniqueDates.size} 件`)
  console.log()
  if (issues.multiSiteDup.length > 0 || issues.coexistWork.length > 0) {
    console.log('💡 詳細を見るには --verbose を付けてください')
  }
  process.exit(0)
}

main().catch(e => { console.error('エラー:', e); process.exit(1) })
