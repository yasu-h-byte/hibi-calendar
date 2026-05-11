#!/usr/bin/env node
/**
 * 同一スタッフ・同一日に2現場以上で出面エントリが存在するケースを検出する監査スクリプト
 *
 * これは「ベトナム人スタッフが現場を間違えて入力 → 別現場で再入力」した結果として
 * 両方に残ってしまうデータ重複を見つけるためのもの。
 *
 * 検出内容:
 *   - (workerId, ym, day) の組で複数 siteId のエントリがある場合
 *   - 各エントリの状態を表示（出勤/有給/休み等）
 *   - ベトナム人 vs 日本人で分類（日本人は分割勤務 w<1 なら正常の可能性）
 *
 * 使い方:
 *   node scripts/audit-duplicate-attendance.mjs
 *   node scripts/audit-duplicate-attendance.mjs --apply-cleanup   # 削除実行 (要 --keep-rule)
 *   node scripts/audit-duplicate-attendance.mjs --verbose
 */
import { initializeApp } from 'firebase/app'
import {
  getFirestore, doc, getDoc, collection, getDocs,
} from 'firebase/firestore'

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
const verbose = args.includes('--verbose')

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

function isVietnamese(visa) {
  if (!visa) return false
  return visa.startsWith('tokutei') || visa.startsWith('jisshu')
}

function getStatus(e) {
  if (!e) return '❓'
  if (e.hk) return '✈️ 帰国'
  if (e.p) return '🌴 有給'
  if (e.exam) return '📝 試験'
  if (e.r) return '🏠 休み'
  if (e.h) return '🚧 現場休'
  if (e.w === 0.6) return `🔧 補償 w=0.6`
  if (e.w === 1) return e.o ? `🔨 出勤 +${e.o}h` : '🔨 出勤'
  if (e.w > 0) return `🔨 出勤 w=${e.w}`
  if (e.w === 0) return '⚪ 不在'
  return JSON.stringify(e)
}

/** 現場のシフト種別を判定（lib/attendance.ts の getSiteShiftType と同じロジック） */
function getSiteShiftType(site) {
  if (site.shiftType === 'day' || site.shiftType === 'night') return site.shiftType
  const startTime = site.workSchedule?.startTime
  if (startTime) {
    const [hStr] = startTime.split(':')
    const hour = parseInt(hStr, 10)
    if (Number.isFinite(hour) && hour >= 16) return 'night'
  }
  if (site.name && site.name.includes('夜勤')) return 'night'
  if (site.id && site.id.endsWith('_night')) return 'night'
  return 'day'
}

async function main() {
  console.log('=== 同一スタッフ・同日 多現場エントリ監査 ===\n')

  // main データ
  const mainSnap = await getDoc(doc(db, 'demmen', 'main'))
  if (!mainSnap.exists()) throw new Error('main doc not found')
  const main = mainSnap.data()
  const workers = main.workers || []
  const workerMap = new Map(workers.map(w => [w.id, w]))
  const sites = main.sites || []
  const siteMap = new Map(sites.map(s => [s.id, s]))

  // 全 att_* を取得
  const colSnap = await getDocs(collection(db, 'demmen'))
  const attDocs = {}
  for (const d of colSnap.docs) {
    if (!/^att_\d{6}$/.test(d.id)) continue
    attDocs[d.id.slice(4)] = d.data().d || {}
  }
  const ymList = Object.keys(attDocs).sort()
  console.log(`📅 対象期間: ${ymList[0]} 〜 ${ymList[ymList.length - 1]} (${ymList.length}ヶ月)`)
  console.log()

  // (workerId, ym, day) → [{sid, entry}, ...]
  const dayMap = new Map()
  for (const [ym, d] of Object.entries(attDocs)) {
    for (const [key, entry] of Object.entries(d)) {
      if (!entry) continue
      const pk = parseDKey(key)
      if (!pk) continue
      if (pk.ym !== ym) continue
      const k = `${pk.wid}_${pk.ym}_${pk.day}`
      if (!dayMap.has(k)) dayMap.set(k, [])
      dayMap.get(k).push({ sid: pk.sid, entry })
    }
  }

  // 多現場ケース抽出
  const duplicates = []
  for (const [k, arr] of dayMap.entries()) {
    if (arr.length <= 1) continue
    duplicates.push({ k, arr })
  }

  // 分類（シフト種別で判定: 同種シフト併記=異常 / 日勤+夜勤=正常）
  const byCategory = {
    sameShiftDup: [],       // 同種シフト併記（物理的に不可能 = 異常）
    crossShiftValid: [],    // 日勤+夜勤などのクロスシフト（正常）
  }

  for (const dup of duplicates) {
    // 全現場のシフト種別を取得
    const shifts = dup.arr.map(x => {
      const site = siteMap.get(x.sid) || { id: x.sid }
      return getSiteShiftType(site)
    })
    // 同じシフト種別が2つ以上あれば同種シフト併記
    const dayCount = shifts.filter(s => s === 'day').length
    const nightCount = shifts.filter(s => s === 'night').length
    if (dayCount >= 2 || nightCount >= 2) {
      byCategory.sameShiftDup.push({ ...dup, shifts })
    } else {
      // 日勤+夜勤のみ（または日勤1のみ・夜勤1のみ=多現場じゃない、ここではあり得ない）
      byCategory.crossShiftValid.push({ ...dup, shifts })
    }
  }

  console.log('━━━━ 検出結果 ━━━━')
  console.log(`  総 (worker, 日付) ユニーク数: ${dayMap.size}`)
  console.log(`  うち多現場ありの日付      : ${duplicates.length}`)
  console.log()
  console.log('  カテゴリ別:')
  console.log(`  🚨 同種シフト併記（物理的に不可能 = 異常）   : ${byCategory.sameShiftDup.length} 件`)
  console.log(`  ℹ️  日勤+夜勤など（正常）                    : ${byCategory.crossShiftValid.length} 件`)
  console.log()

  // 詳細出力
  function printDups(label, list, alwaysShow = false) {
    if (list.length === 0) return
    if (!verbose && !alwaysShow) return
    console.log(`━━━━ ${label} 詳細 ━━━━`)
    for (const { k, arr, shifts } of list) {
      const [wid, ym, day] = k.split('_')
      const w = workerMap.get(parseInt(wid))
      const wname = w?.name || `?`
      const visaLabel = w?.visa || '(no visa)'
      const shiftSummary = shifts ? `[${shifts.join('+')}]` : ''
      console.log(`  [${wid}] ${wname} (${visaLabel}) ${ym}/${day} ${shiftSummary}:`)
      for (let i = 0; i < arr.length; i++) {
        const x = arr[i]
        const siteName = siteMap.get(x.sid)?.name || x.sid
        const shiftLabel = shifts ? `(${shifts[i]})` : ''
        console.log(`    sid=${x.sid.padEnd(18)} ${shiftLabel} (${siteName.slice(0,12)}) → ${getStatus(x.entry)}  raw=${JSON.stringify(x.entry)}`)
      }
    }
    console.log()
  }

  // 異常系は常に詳細表示、正常系は --verbose のみ
  printDups('🚨 同種シフト併記（物理的に不可能 = 異常）', byCategory.sameShiftDup, true)
  printDups('ℹ️  日勤+夜勤など（正常パターン）', byCategory.crossShiftValid, false)

  if (verbose) {
    console.log('💡 上記の正常パターンも含めた全件を表示しています')
  } else if (byCategory.crossShiftValid.length > 0) {
    console.log(`💡 日勤+夜勤併記 ${byCategory.crossShiftValid.length} 件の詳細は --verbose で確認可能`)
  }

  process.exit(0)
}

main().catch(e => { console.error('エラー:', e); process.exit(1) })
