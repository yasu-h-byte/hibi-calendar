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

  // 分類
  const byCategory = {
    vietnameseAllWork: [],      // ベトナム人で複数現場とも作業日
    vietnameseOther: [],         // ベトナム人で何らかの組合せ
    japaneseSplit: [],           // 日本人で w<1 ずつの分割（合計≦1 なら正常）
    japaneseAllWork: [],         // 日本人で複数とも w=1 (異常)
    japaneseOther: [],           // それ以外
  }

  for (const dup of duplicates) {
    const [wid] = dup.k.split('_')
    const worker = workerMap.get(parseInt(wid))
    const visa = worker?.visa
    const isVN = isVietnamese(visa)

    const totalW = dup.arr.reduce((s, x) => s + (x.entry.w > 0 ? x.entry.w : 0), 0)
    const allFullWork = dup.arr.every(x => x.entry.w === 1)

    if (isVN) {
      if (allFullWork) byCategory.vietnameseAllWork.push(dup)
      else byCategory.vietnameseOther.push(dup)
    } else {
      if (allFullWork) byCategory.japaneseAllWork.push(dup)
      else if (totalW > 0 && totalW <= 1.01) byCategory.japaneseSplit.push(dup)
      else byCategory.japaneseOther.push(dup)
    }
  }

  console.log('━━━━ 検出結果 ━━━━')
  console.log(`  総 (worker, 日付) ユニーク数: ${dayMap.size}`)
  console.log(`  うち多現場ありの日付      : ${duplicates.length}`)
  console.log()
  console.log('  カテゴリ別:')
  console.log(`  🚨 ベトナム人 全現場とも出勤(w=1)     : ${byCategory.vietnameseAllWork.length} 件`)
  console.log(`  ⚠️  ベトナム人 その他組合せ           : ${byCategory.vietnameseOther.length} 件`)
  console.log(`  🚨 日本人 全現場とも出勤(w=1)        : ${byCategory.japaneseAllWork.length} 件`)
  console.log(`  ℹ️  日本人 分割勤務 (w<1, 合計≦1)    : ${byCategory.japaneseSplit.length} 件 (正常パターン)`)
  console.log(`  ⚠️  日本人 その他組合せ              : ${byCategory.japaneseOther.length} 件`)
  console.log()

  // 詳細出力
  function printDups(label, list, alwaysShow = false) {
    if (list.length === 0) return
    if (!verbose && !alwaysShow) return
    console.log(`━━━━ ${label} 詳細 ━━━━`)
    for (const { k, arr } of list) {
      const [wid, ym, day] = k.split('_')
      const w = workerMap.get(parseInt(wid))
      const wname = w?.name || `?`
      const visaLabel = w?.visa || '(no visa)'
      console.log(`  [${wid}] ${wname} (${visaLabel}) ${ym}/${day}:`)
      for (const x of arr) {
        const siteName = siteMap.get(x.sid)?.name || x.sid
        console.log(`    sid=${x.sid.padEnd(18)} (${siteName.slice(0,12)}) → ${getStatus(x.entry)}  raw=${JSON.stringify(x.entry)}`)
      }
    }
    console.log()
  }

  // 異常系は常に詳細表示、正常系は --verbose のみ
  printDups('🚨 ベトナム人 全現場とも出勤(w=1)', byCategory.vietnameseAllWork, true)
  printDups('⚠️  ベトナム人 その他組合せ', byCategory.vietnameseOther, true)
  printDups('🚨 日本人 全現場とも出勤(w=1)', byCategory.japaneseAllWork, true)
  printDups('⚠️  日本人 その他組合せ', byCategory.japaneseOther, true)
  printDups('ℹ️  日本人 分割勤務 (正常パターン)', byCategory.japaneseSplit, false)

  if (verbose) {
    console.log('💡 上記の正常パターンも含めた全件を表示しています')
  } else {
    if (byCategory.japaneseSplit.length > 0) {
      console.log(`💡 日本人分割勤務 ${byCategory.japaneseSplit.length} 件の詳細は --verbose で確認可能`)
    }
  }

  process.exit(0)
}

main().catch(e => { console.error('エラー:', e); process.exit(1) })
