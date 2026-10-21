#!/usr/bin/env node
/**
 * 笹塚現場の配置データを復旧するスクリプト
 *
 * 背景:
 *   2026-05-27 時点で assign.sasazuka と massign.sasazuka_202606 の
 *   workers/subcons が IHI のメンバーリストで上書きされていることが判明。
 *   原因は配置編集モーダルの状態管理不備（サイト切替時に古い状態のまま
 *   保存される）と推定。
 *
 *   ユーザー指示:
 *     - 6月: 5月メンバー + 濱上(12) を追加
 *     - デフォルト: 5月のメンバーに復旧
 *     - 5月: そのまま正しい（ただし subcons から `________99u1` を除去）
 *
 * 復旧内容:
 *   - assign.sasazuka.workers   = [3, 4, 7, 203, 204, 205, 206]
 *   - assign.sasazuka.subcons   = ['yoshimoto', 'iwaida', 'buyu', 'sato', 'suzutaka']
 *   - assign.sasazuka.dispatch  = [3] (出向情報は保持)
 *   - assign.sasazuka.subconRates = {} (保持)
 *   - massign.sasazuka_202606.workers = [3, 4, 7, 12, 203, 204, 205, 206]
 *   - massign.sasazuka_202606.subcons = ['yoshimoto', 'iwaida', 'buyu', 'sato', 'suzutaka']
 *   - massign.sasazuka_202605.subcons から `________99u1` を除去（workers は変更なし）
 *
 * 使い方:
 *   node scripts/restore-sasazuka-assign.mjs           # ドライラン
 *   node scripts/restore-sasazuka-assign.mjs --apply   # 実行
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

const TARGET_WORKERS_MAY = [3, 4, 7, 203, 204, 205, 206]
const TARGET_WORKERS_JUN = [3, 4, 7, 12, 203, 204, 205, 206]
const TARGET_SUBCONS = ['yoshimoto', 'iwaida', 'buyu', 'sato', 'suzutaka']

async function main() {
  console.log(`\n${APPLY ? '🔧 APPLY MODE' : '🔍 DRY RUN'} - Restore sasazuka assignments\n`)

  const ref = doc(db, 'demmen', 'main')
  const snap = await getDoc(ref)
  if (!snap.exists()) {
    console.error('demmen/main not found')
    process.exit(1)
  }
  const data = snap.data()

  // ── 1. assign.sasazuka 復旧 ──
  const assign = data.assign || {}
  const currentSasazuka = assign.sasazuka || {}
  const newSasazuka = {
    ...currentSasazuka,
    workers: TARGET_WORKERS_MAY,
    subcons: TARGET_SUBCONS,
    // dispatch[3] と subconRates は保持
  }
  console.log(`assign.sasazuka:`)
  console.log(`  workers: [${(currentSasazuka.workers || []).join(',')}]`)
  console.log(`       → [${TARGET_WORKERS_MAY.join(',')}]`)
  console.log(`  subcons: [${(currentSasazuka.subcons || []).join(',')}]`)
  console.log(`       → [${TARGET_SUBCONS.join(',')}]`)
  console.log(`  dispatch (保持): [${(currentSasazuka.dispatch || []).join(',')}]`)

  // ── 2. massign.sasazuka_202606 復旧 ──
  const massign = data.massign || {}
  const currentJun = massign.sasazuka_202606 || {}
  const newJun = {
    ...currentJun,
    workers: TARGET_WORKERS_JUN,
    subcons: TARGET_SUBCONS,
  }
  console.log(`\nmassign.sasazuka_202606:`)
  console.log(`  workers: [${(currentJun.workers || []).join(',')}]`)
  console.log(`       → [${TARGET_WORKERS_JUN.join(',')}]`)
  console.log(`  subcons: [${(currentJun.subcons || []).join(',')}]`)
  console.log(`       → [${TARGET_SUBCONS.join(',')}]`)

  // ── 3. massign.sasazuka_202605 の subcons から ________99u1 を除去 ──
  const currentMay = massign.sasazuka_202605 || {}
  const newMaySubcons = (currentMay.subcons || []).filter(s => s !== '________99u1')
  const newMay = {
    ...currentMay,
    subcons: newMaySubcons,
  }
  console.log(`\nmassign.sasazuka_202605 (subcons cleanup):`)
  console.log(`  subcons: [${(currentMay.subcons || []).join(',')}]`)
  console.log(`       → [${newMaySubcons.join(',')}]`)

  if (!APPLY) {
    console.log(`\nℹ️  Dry run. Re-run with --apply to write.\n`)
    return
  }

  // ── 書き込み（既存の他キーを保持するため、対象キーだけ差し替え） ──
  console.log(`\n📝 Writing to Firestore...`)
  await updateDoc(ref, {
    'assign.sasazuka': newSasazuka,
    'massign.sasazuka_202606': newJun,
    'massign.sasazuka_202605': newMay,
  })
  console.log(`✅ Done.\n`)
}

main().catch(e => { console.error(e); process.exit(1) })
