/**
 * 診断スクリプト: 週40h固定判定による「変形労働で本来不要な残業」の影響を定量化
 *
 * 背景 (2026-06 社労士監査):
 *   給与計算 (calculateVietnameseSalary) の週次残業判定が「週40h固定」のため、
 *   週6日勤務 (週42h所定) の現場で、変形労働時間制なら本来0のはずの残業が
 *   計上されている可能性がある (compute.ts:1895 'weekRegular - 40')。
 *
 *   1ヶ月単位変形労働時間制では、週の所定が40hを超える週は「所定超」が残業。
 *   週所定42hなら42h超のみが残業 → 42hちょうどなら残業0が法令上の正。
 *
 * このスクリプトは READ-ONLY。給与額は一切変更しない。
 *   各ベトナム人スタッフについて、当月の週ごとに
 *     - 実労働時間 (calcActualHours と同じ休憩フラグ控除)
 *     - flat-40h 判定による週残業 (現状コード)
 *     - 週所定ベース判定による週残業 (法令準拠案)
 *   を比較し、差分 (= 過大計上の疑い) を一覧する。
 *
 * 使い方:
 *   node scripts/diagnose-working-hours.mjs 202605
 *   node scripts/diagnose-working-hours.mjs 202606
 */
import { initializeApp } from 'firebase/app'
import { getFirestore, doc, getDoc, collection, query, where, getDocs } from 'firebase/firestore'

const firebaseConfig = {
  apiKey: 'AIzaSyAcA_kFC8hAqfmS_-_tOxI5oyjH06WNOwM',
  authDomain: 'dedura-kanri.firebaseapp.com',
  projectId: 'dedura-kanri',
  storageBucket: 'dedura-kanri.firebasestorage.app',
  messagingSenderId: '372352470111',
  appId: '1:372352470111:web:136292eb630abddde3dfea',
}

const ym = process.argv[2] || '202605'
if (!/^\d{6}$/.test(ym)) {
  console.error('使い方: node scripts/diagnose-working-hours.mjs YYYYMM')
  process.exit(1)
}

const app = initializeApp(firebaseConfig)
const db = getFirestore(app)

const ymY = parseInt(ym.slice(0, 4))
const ymM = parseInt(ym.slice(4, 6))
const numDays = new Date(ymY, ymM, 0).getDate()
const legalLimit = Math.round((numDays * 40 / 7) * 10) / 10

// calcActualHours 相当 (休憩フラグが立っている分のみ控除)
function calcActualHours(e, ws) {
  if (!e.st || !e.et) return e.w === 0.6 ? 4.2 : (e.w || 0) * 7
  const [sh, sm] = e.st.split(':').map(Number)
  const [eh, em] = e.et.split(':').map(Number)
  let min = (eh * 60 + (em || 0)) - (sh * 60 + (sm || 0))
  const mMin = ws?.morningBreak?.enabled === false ? 0 : (ws?.morningBreak?.minutes ?? 30)
  const lMin = ws?.lunchBreak?.enabled === false ? 0 : (ws?.lunchBreak?.minutes ?? 60)
  const aMin = ws?.afternoonBreak?.enabled === false ? 0 : (ws?.afternoonBreak?.minutes ?? 30)
  if (e.b1) min -= mMin
  if (e.b2) min -= lMin
  if (e.b3) min -= aMin
  return Math.max(0, Math.round(min / 60 * 10) / 10)
}

async function run() {
  const mainSnap = await getDoc(doc(db, 'demmen', 'main'))
  const main = mainSnap.data()
  const workers = (main.workers || []).filter(w => w.visa && w.visa !== 'none' && w.visa !== '')
  const sites = main.sites || []
  const siteWs = {}
  for (const s of sites) siteWs[s.id] = s.workSchedule

  const attSnap = await getDoc(doc(db, 'demmen', `att_${ym}`))
  const attD = attSnap.exists() ? (attSnap.data().d || {}) : {}

  // 月曜起算の週番号
  const firstDow = new Date(ymY, ymM - 1, 1).getDay()
  const firstMondayOffset = (firstDow + 6) % 7
  const weekOf = (d) => Math.floor((d - 1 + firstMondayOffset) / 7) + 1

  console.log(`\n=== 労働時間診断 ${ym} (法定上限 ${legalLimit}h) ===\n`)

  const flagged = []
  const dualInput = []

  for (const w of workers) {
    // この worker のその月の全エントリ (現場別)
    const dayEntries = {} // day -> { siteId, e }
    for (const [key, e] of Object.entries(attD)) {
      if (!e || typeof e !== 'object') continue
      const parts = key.split('_')
      if (parts.length < 4) continue
      const day = parseInt(parts[parts.length - 1])
      const kym = parts[parts.length - 2]
      const wid = parseInt(parts[parts.length - 3])
      const sid = parts.slice(0, parts.length - 3).join('_')
      if (kym !== ym || wid !== w.id) continue
      const dow = new Date(ymY, ymM - 1, day).getDay()
      if (dow === 0) continue // 法定休日(日曜)は別枠
      if (!e.w || e.w <= 0 || e.w === 0.6) continue
      if (!dayEntries[day]) dayEntries[day] = { sid, e }
      // st/et と o の二重入力検出
      if (e.st && e.et && e.o) dualInput.push(`${w.name}(${w.id}) ${day}日: st/et + o=${e.o} 併存`)
    }
    if (Object.keys(dayEntries).length === 0) continue

    // 週ごとに集計
    const weeks = {}
    for (const [dayStr, { sid, e }] of Object.entries(dayEntries)) {
      const day = parseInt(dayStr)
      const wn = weekOf(day)
      const h = calcActualHours(e, siteWs[sid])
      if (!weeks[wn]) weeks[wn] = { actual: 0, prescribed: 0 }
      weeks[wn].actual += h
      weeks[wn].prescribed += 7 // 所定7h/日
    }

    // flat-40h vs 週所定 の週残業を比較
    let flatOT = 0, schedOT = 0
    for (const wk of Object.values(weeks)) {
      // 日次8h超 (簡易: 各日のexcessは省略。週次のみ比較)
      flatOT += Math.max(0, wk.actual - 40)
      const thr = Math.max(40, wk.prescribed)
      schedOT += Math.max(0, wk.actual - thr)
    }
    flatOT = Math.round(flatOT * 10) / 10
    schedOT = Math.round(schedOT * 10) / 10
    const diff = Math.round((flatOT - schedOT) * 10) / 10

    if (diff > 0) {
      const rate = w.hourlyRate || (w.salary ? Math.round(w.salary / 140) : 0)
      const overpay = Math.round(diff * 0.25 * rate)
      flagged.push({ name: w.name, id: w.id, org: w.org, flatOT, schedOT, diff, rate, overpay })
    }
  }

  console.log('■ 週40h固定 vs 週所定 で残業時間に差が出るスタッフ')
  console.log('  (変形労働の週所定で判定すれば diff 時間分の法定外残業が消える=過払いの疑い)\n')
  if (flagged.length === 0) {
    console.log('  該当なし')
  } else {
    let totalOverpay = 0
    for (const f of flagged) {
      console.log(`  ${f.org} ${f.name}(${f.id}): flat-40h=${f.flatOT}h / 週所定=${f.schedOT}h / 差=${f.diff}h → 割増過払い約¥${f.overpay.toLocaleString()} (時給${f.rate})`)
      totalOverpay += f.overpay
    }
    console.log(`\n  合計 ${flagged.length}名 / 過払い割増 約¥${totalOverpay.toLocaleString()}`)
  }

  console.log('\n■ st/et と o(残業欄) が二重入力されているエントリ')
  if (dualInput.length === 0) {
    console.log('  該当なし')
  } else {
    dualInput.slice(0, 30).forEach(s => console.log(`  ${s}`))
    if (dualInput.length > 30) console.log(`  ...他 ${dualInput.length - 30}件`)
  }

  console.log('\n※ このスクリプトは read-only。給与額は変更していません。')
  console.log('※ 週所定ベースでの判定が法的に正しいかは、変形労働時間制の協定整備状況を社労士に確認のこと。\n')
  process.exit(0)
}

run().catch(e => { console.error(e); process.exit(1) })
