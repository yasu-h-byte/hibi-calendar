#!/usr/bin/env node
/**
 * 評価者ウェイトの計算検証スクリプト
 *
 * 指定ワーカーの過去12ヶ月の出勤データを月別・現場別に集計し、
 * 各評価者にどのくらい日数が credit されているかを表示。
 *
 * 使い方:
 *   node scripts/audit-evaluator-weights.mjs --wid=204 --date=2026-05-07
 *   node scripts/audit-evaluator-weights.mjs --wid=205 --date=2026-05-07 --verbose
 */
import { initializeApp } from 'firebase/app'
import { getFirestore, doc, getDoc } from 'firebase/firestore'

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
const dateArg = args.find(a => a.startsWith('--date='))
const verbose = args.includes('--verbose')

if (!widArg || !dateArg) {
  console.error('Usage: node scripts/audit-evaluator-weights.mjs --wid=N --date=YYYY-MM-DD')
  process.exit(1)
}

const workerId = parseInt(widArg.slice(6))
const evalDate = new Date(dateArg.slice(7))

function parseDKey(k) {
  const p = k.split('_')
  if (p.length < 4) return null
  return {
    sid: p.slice(0, p.length - 3).join('_'),
    wid: parseInt(p[p.length - 3], 10),
    ym: p[p.length - 2],
    day: p[p.length - 1],
  }
}

function isWorkingDay(e) {
  if (!e) return false
  if (e.p || e.r || e.h || e.hk || e.exam) return false
  return (e.w ?? 0) > 0
}

async function main() {
  console.log(`=== 評価者ウェイト計算検証 ===`)
  console.log(`対象スタッフ: workerId=${workerId}`)
  console.log(`評価日: ${dateArg.slice(7)}`)
  console.log()

  const mainSnap = await getDoc(doc(db, 'demmen', 'main'))
  if (!mainSnap.exists()) throw new Error('main doc not found')
  const main = mainSnap.data()
  const sites = main.sites || []
  const mforeman = main.mforeman || {}
  const workers = main.workers || []
  const worker = workers.find(w => w.id === workerId)
  console.log(`ワーカー名: ${worker?.name} / visa: ${worker?.visa} / hireDate: ${worker?.hireDate}`)
  console.log()

  // 過去13ヶ月の att を取得
  const ymList = []
  for (let i = 0; i < 13; i++) {
    const d = new Date(evalDate)
    d.setMonth(d.getMonth() - i)
    ymList.push(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`)
  }
  ymList.sort()

  const yearCut = new Date(evalDate)
  yearCut.setDate(yearCut.getDate() - 365)

  function resolveForeman(siteId, ym) {
    const mfk = `${siteId}_${ym}`
    const monthlyForeman = mforeman[mfk]?.foreman
    if (typeof monthlyForeman === 'number') return monthlyForeman
    const site = sites.find(s => s.id === siteId)
    return typeof site?.foreman === 'number' ? site.foreman : null
  }
  function getSiteName(siteId) {
    const s = sites.find(s => s.id === siteId)
    return s ? `${s.name}${s.archived ? '[終了]' : ''}` : `(unknown:${siteId})`
  }

  let totalWorkingDays = 0
  const byForeman = new Map()  // foremanId -> count
  const byOutOfRange = []      // 期間外
  const noForeman = []         // 現場 not found
  const detailsByMonth = {}

  for (const ym of ymList) {
    const attSnap = await getDoc(doc(db, 'demmen', `att_${ym}`))
    if (!attSnap.exists()) continue
    const d = attSnap.data().d || {}

    for (const [key, entry] of Object.entries(d)) {
      if (!entry) continue
      const pk = parseDKey(key)
      if (!pk) continue
      if (pk.wid !== workerId) continue
      if (pk.ym !== ym) continue
      if (!isWorkingDay(entry)) continue

      const dayN = parseInt(pk.day)
      const date = new Date(parseInt(ym.slice(0, 4)), parseInt(ym.slice(4, 6)) - 1, dayN)
      const inRange = date >= yearCut && date <= evalDate

      const foremanId = resolveForeman(pk.sid, ym)
      const detail = {
        date: `${ym}/${String(dayN).padStart(2, '0')}`,
        sid: pk.sid,
        siteName: getSiteName(pk.sid),
        foremanId,
        foremanName: workers.find(w => w.id === foremanId)?.name || `?`,
        inRange,
        w: entry.w,
      }

      if (!inRange) {
        byOutOfRange.push(detail)
        continue
      }
      totalWorkingDays++

      if (!detailsByMonth[ym]) detailsByMonth[ym] = []
      detailsByMonth[ym].push(detail)

      if (foremanId === null) {
        noForeman.push(detail)
        continue
      }

      byForeman.set(foremanId, (byForeman.get(foremanId) || 0) + 1)
    }
  }

  console.log(`━━━━ 過去365日 (${yearCut.toISOString().slice(0, 10)} 〜 ${dateArg.slice(7)}) ━━━━`)
  console.log(`  期間内 実出勤総数: ${totalWorkingDays}日`)
  console.log(`  期間外（過去13ヶ月内・但し365日範囲外）: ${byOutOfRange.length}日`)
  console.log(`  現場 not found / 職長 null: ${noForeman.length}日`)
  console.log()

  console.log(`━━━━ 職長別 内訳 ━━━━`)
  const sortedForemen = [...byForeman.entries()].sort((a, b) => b[1] - a[1])
  for (const [fid, count] of sortedForemen) {
    const fname = workers.find(w => w.id === fid)?.name || `?`
    console.log(`  [${fid}] ${fname}: ${count}日`)
  }
  console.log()
  console.log(`合計（評価者になっているか問わず）: ${[...byForeman.values()].reduce((a, b) => a + b, 0)}日`)
  console.log()

  if (verbose) {
    console.log(`━━━━ 月別 詳細 ━━━━`)
    for (const ym of ymList) {
      const arr = detailsByMonth[ym] || []
      if (arr.length === 0) continue
      console.log(`  ${ym}: ${arr.length}日`)
      // 月内サイト別
      const bySid = {}
      for (const d of arr) {
        if (!bySid[d.sid]) bySid[d.sid] = []
        bySid[d.sid].push(d)
      }
      for (const [sid, days] of Object.entries(bySid)) {
        const sample = days[0]
        console.log(`    ${sid} (${sample.siteName}) → 職長:${sample.foremanName}(${sample.foremanId}) → ${days.length}日`)
      }
    }
  }

  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
