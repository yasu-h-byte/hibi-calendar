#!/usr/bin/env node
/**
 * 濱上祥太郎の社員ID 304 → 12 への移行スクリプト
 *
 * 背景:
 *   日本人職人の社員IDは 1〜99 の連番が方針。
 *   濱上さん（2026-06-01 入社予定の鳶見習い）は既存のインクリメント採番で
 *   304 として登録されてしまっているため、空き番号 12 に修正する。
 *
 * 処理内容:
 *   1. workers 配列: 濱上の id を 304 → 12
 *   2. assign[sasazuka].workers: 304 → 12
 *   3. massign[sasazuka_202606].workers: 304 → 12
 *   4. 残骸の ID 12 を massign 過去月から除去（削除された旧スタッフの参照、
 *      濱上が 12 を継承すると過去月に存在することになってしまうため）
 *      対象: ihi_202510, ihi_202511, sasazuka_202510, sasazuka_202511,
 *           yaesu_202510〜202512, yaesu_night_202510〜202512
 *
 * 安全性検証 (事前):
 *   - att_202510 に worker ID 12 の出面エントリは存在しない（残骸は massign のみ）
 *   - evaluation, homeLeave, leaveRequest に ID 12 / 304 の参照なし
 *
 * 使い方:
 *   node scripts/migrate-hamagami-id.mjs           # ドライラン
 *   node scripts/migrate-hamagami-id.mjs --apply   # 実行
 */
import { initializeApp } from 'firebase/app'
import { getFirestore, doc, getDoc, updateDoc } from 'firebase/firestore'

const firebaseConfig = {
  apiKey: "AIzaSyAcA_kFC8hAqfmS_-_tOxI5oyjH06WNOwM",
  authDomain: "dedura-kanri.firebaseapp.com",
  projectId: "dedura-kanri",
  storageBucket: "dedura-kanri.firebasestorage.app",
  messagingSenderId: "372352470111",
  appId: "1:372352470111:web:136292eb630abddde3dfea"
}

const app = initializeApp(firebaseConfig)
const db = getFirestore(app)

const args = process.argv.slice(2)
const APPLY = args.includes('--apply')

const OLD_ID = 304
const NEW_ID = 12

// 過去月の massign で ID 12 の残骸を除去する対象（濱上 2026-06 入社前の月）
const STALE_12_MASSIGN_KEYS = [
  'ihi_202510', 'ihi_202511',
  'sasazuka_202510', 'sasazuka_202511',
  'yaesu_202510', 'yaesu_202511', 'yaesu_202512',
  'yaesu_night_202510', 'yaesu_night_202511', 'yaesu_night_202512',
]

async function main() {
  console.log(`\n${APPLY ? '🔧 APPLY MODE' : '🔍 DRY RUN'} - Hamagami ID ${OLD_ID} → ${NEW_ID}\n`)

  const ref = doc(db, 'demmen', 'main')
  const snap = await getDoc(ref)
  if (!snap.exists()) {
    console.error('demmen/main not found')
    process.exit(1)
  }

  const data = snap.data()
  const workers = data.workers || []
  const assign = data.assign || {}
  const massign = data.massign || {}

  // ── 1. workers 配列 ──
  const hamagamiIdx = workers.findIndex(w => w.id === OLD_ID)
  if (hamagamiIdx === -1) {
    console.error(`Worker with id=${OLD_ID} not found`)
    process.exit(1)
  }
  const hamagami = workers[hamagamiIdx]
  console.log(`✓ Found: ID ${OLD_ID} = ${hamagami.name} (${hamagami.job})`)

  const conflictIdx = workers.findIndex(w => w.id === NEW_ID)
  if (conflictIdx !== -1) {
    console.error(`❌ Worker with id=${NEW_ID} already exists: ${workers[conflictIdx].name}`)
    process.exit(1)
  }
  console.log(`✓ ID ${NEW_ID} is unused in workers array`)

  const newWorkers = workers.map((w, i) =>
    i === hamagamiIdx ? { ...w, id: NEW_ID } : w
  )

  // ── 2. assign の更新 ──
  const newAssign = {}
  let assignChanges = 0
  for (const [siteId, val] of Object.entries(assign)) {
    const ws = val.workers || []
    if (ws.includes(OLD_ID)) {
      const replaced = ws.map(id => id === OLD_ID ? NEW_ID : id)
      newAssign[siteId] = { ...val, workers: replaced }
      assignChanges++
      console.log(`  assign[${siteId}]: 304 → 12 (workers: [${ws.join(',')}] → [${replaced.join(',')}])`)
    } else {
      newAssign[siteId] = val
    }
  }
  console.log(`✓ assign: ${assignChanges} site(s) updated`)

  // ── 3. massign の更新（濱上の 304 を 12 へ、かつ過去月の残骸 12 を削除） ──
  const newMassign = {}
  let massignReplaced = 0
  let massignCleaned = 0
  for (const [key, val] of Object.entries(massign)) {
    const ws = val.workers || []
    let newWs = ws
    // 304 → 12 へ
    if (ws.includes(OLD_ID)) {
      newWs = newWs.map(id => id === OLD_ID ? NEW_ID : id)
      massignReplaced++
      console.log(`  massign[${key}]: 304 → 12`)
    }
    // 過去月の残骸 12 を除去（濱上 2026-06 入社前の対象キー）
    if (STALE_12_MASSIGN_KEYS.includes(key) && newWs.includes(NEW_ID)) {
      newWs = newWs.filter(id => id !== NEW_ID)
      massignCleaned++
      console.log(`  massign[${key}]: removed stale ID 12 (no actual attendance data)`)
    }
    newMassign[key] = { ...val, workers: newWs }
  }
  console.log(`✓ massign: ${massignReplaced} key(s) updated for 304→12, ${massignCleaned} key(s) cleaned of stale 12`)

  // ── 書き込み ──
  if (!APPLY) {
    console.log(`\nℹ️  Dry run complete. Re-run with --apply to write to Firestore.\n`)
    return
  }

  console.log(`\n📝 Writing to Firestore...`)
  await updateDoc(ref, {
    workers: newWorkers,
    assign: newAssign,
    massign: newMassign,
  })
  console.log(`✅ Done.\n`)
}

main().catch(e => { console.error(e); process.exit(1) })
