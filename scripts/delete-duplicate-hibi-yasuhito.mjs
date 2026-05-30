#!/usr/bin/env node
/**
 * 重複した「日比 靖仁」(ID 13, 14) を削除するスクリプト
 *
 * 背景:
 *   2026-05-30 時点で /workers から「日比 靖仁」が誤って 2 回追加されており、
 *   ID 13 と ID 14 として登録されていた（名前にスペース有り、ID 0 のオリジナルとは別人扱い）。
 *
 * 確認済:
 *   - assign / massign / leaveRequest / homeLongLeave に ID 13/14 の参照なし
 *   - 出面 (att_*) にもエントリなし（追加直後で稼働実績なし）
 *
 * 削除内容:
 *   - workers[] から id===13 および id===14 のエントリを除去
 *   - nextWorkerId は 307 のまま据え置き（巻き戻すと別の混乱を招く）
 *
 * 使い方:
 *   node scripts/delete-duplicate-hibi-yasuhito.mjs           # ドライラン
 *   node scripts/delete-duplicate-hibi-yasuhito.mjs --apply   # 実行
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
const APPLY = process.argv.slice(2).includes('--apply')

const DELETE_IDS = [13, 14]

async function main() {
  console.log(`\n${APPLY ? '🔧 APPLY MODE' : '🔍 DRY RUN'} - Delete duplicate Hibi Yasuhito\n`)

  const ref = doc(db, 'demmen', 'main')
  const snap = await getDoc(ref)
  if (!snap.exists()) {
    console.error('demmen/main not found')
    process.exit(1)
  }
  const data = snap.data()
  const workers = data.workers || []

  // 削除対象を確認
  const toDelete = workers.filter(w => DELETE_IDS.includes(w.id))
  if (toDelete.length === 0) {
    console.log('対象なし — 既に削除済み？')
    return
  }
  console.log(`削除対象: ${toDelete.length}件`)
  for (const w of toDelete) {
    console.log(`  - ID ${w.id}: ${w.name} (${w.job})`)
  }

  // 念のため assign / massign を再確認
  const assignRefs = []
  for (const [siteId, val] of Object.entries(data.assign || {})) {
    for (const id of (val.workers || [])) {
      if (DELETE_IDS.includes(id)) assignRefs.push(`assign[${siteId}]: ${id}`)
    }
  }
  for (const [key, val] of Object.entries(data.massign || {})) {
    for (const id of (val.workers || [])) {
      if (DELETE_IDS.includes(id)) assignRefs.push(`massign[${key}]: ${id}`)
    }
  }
  if (assignRefs.length > 0) {
    console.log(`\n⚠️  assign/massign に参照あり:`)
    for (const r of assignRefs) console.log(`  - ${r}`)
    console.log(`  → これらも削除します`)
  } else {
    console.log(`\n✓ assign / massign に参照なし`)
  }

  const newWorkers = workers.filter(w => !DELETE_IDS.includes(w.id))

  // assign / massign からも除去
  const newAssign = {}
  for (const [siteId, val] of Object.entries(data.assign || {})) {
    newAssign[siteId] = {
      ...val,
      workers: (val.workers || []).filter(id => !DELETE_IDS.includes(id)),
    }
  }
  const newMassign = {}
  for (const [key, val] of Object.entries(data.massign || {})) {
    newMassign[key] = {
      ...val,
      workers: (val.workers || []).filter(id => !DELETE_IDS.includes(id)),
    }
  }

  console.log(`\nworkers: ${workers.length} → ${newWorkers.length}`)

  if (!APPLY) {
    console.log(`\nℹ️  Dry run. Re-run with --apply to write.\n`)
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
