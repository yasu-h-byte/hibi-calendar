#!/usr/bin/env node
/**
 * 既存出面データの残骸クリーンアップスクリプト
 *
 * 2026-05-09 ビンさん事案後に作成。
 *
 * 残骸とは:
 *   ステータス変更時に古いフィールドが残ったままになるデータ。例：
 *     {w:1, p:1, st:07:30, et:16:30, b1:0, b2:1, b3:0, o:1}
 *     → 出勤入力後に「有給」へ変更したが、時刻・残業データが残っている
 *
 *   このスクリプトは att_YYYYMM ドキュメントを走査し、残骸を検出して
 *   ドライランで報告する。--apply オプション付きで実行すると実際に
 *   不要フィールドを deleteField() でクリーンアップする。
 *
 * 使い方:
 *   node scripts/cleanup-attendance-residue.mjs --ym=202605             # ドライラン (検出のみ)
 *   node scripts/cleanup-attendance-residue.mjs --ym=202605 --apply     # 実行 (Firestore更新)
 *   node scripts/cleanup-attendance-residue.mjs --apply                  # 全 att_* に対して実行
 *
 * 安全策:
 *   - 必ず --apply 前にドライランで内容を確認すること
 *   - 実行前に手動でバックアップを取ることを推奨（/api/backup/snapshot）
 */
import { initializeApp } from 'firebase/app'
import { getFirestore, doc, getDoc, updateDoc, deleteField, collection, getDocs } from 'firebase/firestore'

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
const ymArg = args.find(a => a.startsWith('--ym='))
const apply = args.includes('--apply')
const targetYms = ymArg ? [ymArg.slice(5)] : null  // null = all att_*

const ALL_KNOWN_FIELDS = ['w', 'o', 'p', 'r', 'h', 'hk', 'exam', 'st', 'et', 'b1', 'b2', 'b3', 'rReason', 'rNote']

/**
 * エントリに残るべき正しいステータスを判定し、不要フィールドを返す。
 * ステータス優先順: p > exam > r > h > hk > w
 */
function detectResidue(entry) {
  // ステータスフラグを判定して「正しい状態」を決める
  const isPaidLeave = (entry.p ?? 0) > 0
  const isExam = (entry.exam ?? 0) > 0
  const isRest = (entry.r ?? 0) > 0
  const isSiteOff = (entry.h ?? 0) > 0
  const isHomeLeave = (entry.hk ?? 0) > 0
  const isWork = (entry.w ?? 0) > 0

  // 状態決定 (優先順)
  let canonicalStatus = null
  if (isPaidLeave) canonicalStatus = 'leave'
  else if (isExam) canonicalStatus = 'exam'
  else if (isRest) canonicalStatus = 'rest'
  else if (isSiteOff) canonicalStatus = 'site_off'
  else if (isHomeLeave) canonicalStatus = 'home_leave'
  else if (isWork) canonicalStatus = 'work'
  else return { residue: [] }  // 全 0 ならクリア対象なし

  // ステータスに応じて「あるべきフィールド」セット
  const expected = new Set()
  if (canonicalStatus === 'work') {
    expected.add('w')
    if (entry.o > 0) expected.add('o')
    if (entry.st && entry.et) {
      expected.add('st'); expected.add('et')
      expected.add('b1'); expected.add('b2'); expected.add('b3')
    }
  } else if (canonicalStatus === 'leave') {
    expected.add('p')
    expected.add('w')  // w:0 で残す
  } else if (canonicalStatus === 'exam') {
    expected.add('exam')
    expected.add('w')
  } else if (canonicalStatus === 'rest') {
    expected.add('r')
    expected.add('w')
    if (entry.rReason) expected.add('rReason')
    if (entry.rNote) expected.add('rNote')
  } else if (canonicalStatus === 'site_off') {
    expected.add('h')
    expected.add('w')
  } else if (canonicalStatus === 'home_leave') {
    expected.add('hk')
    expected.add('w')
  }

  // 既存フィールド - あるべきフィールド = 残骸
  const present = Object.keys(entry).filter(k => k !== 's')  // s (source) は対象外
  const residue = present.filter(k => !expected.has(k) && ALL_KNOWN_FIELDS.includes(k))
  return { canonicalStatus, residue }
}

async function getYmList() {
  if (targetYms) return targetYms
  // demmen コレクション全 doc から att_YYYYMM だけ抽出
  const colSnap = await getDocs(collection(db, 'demmen'))
  return colSnap.docs
    .map(d => d.id)
    .filter(id => /^att_\d{6}$/.test(id))
    .map(id => id.slice(4))
    .sort()
}

async function processYm(ym) {
  const docRef = doc(db, 'demmen', `att_${ym}`)
  const snap = await getDoc(docRef)
  if (!snap.exists()) {
    console.log(`  ${ym}: ドキュメントなし`)
    return { totalEntries: 0, residueCount: 0, residueDetails: [] }
  }
  const data = snap.data()
  const d = data.d || {}

  let residueCount = 0
  const residueDetails = []
  const updates = {}

  for (const [key, entry] of Object.entries(d)) {
    const { canonicalStatus, residue } = detectResidue(entry)
    if (residue.length > 0) {
      residueCount++
      residueDetails.push({ key, status: canonicalStatus, residue })
      for (const f of residue) {
        updates[`d.${key}.${f}`] = deleteField()
      }
    }
  }

  if (residueCount > 0 && apply) {
    await updateDoc(docRef, updates)
    console.log(`  ${ym}: ${residueCount}件の残骸を削除しました ✅`)
  } else if (residueCount > 0) {
    console.log(`  ${ym}: ${residueCount}件の残骸あり (--apply で削除実行)`)
    for (const { key, status, residue } of residueDetails.slice(0, 5)) {
      console.log(`    [${status}] ${key} → 削除: ${residue.join(', ')}`)
    }
    if (residueDetails.length > 5) console.log(`    ... 他${residueDetails.length - 5}件`)
  } else {
    console.log(`  ${ym}: 残骸なし ✓`)
  }

  return { totalEntries: Object.keys(d).length, residueCount, residueDetails }
}

async function main() {
  console.log(`=== 出面残骸クリーンアップ ${apply ? '(本番実行)' : '(ドライラン)'} ===`)
  const yms = await getYmList()
  console.log(`対象: ${yms.length} 月分`)

  let totalResidue = 0
  for (const ym of yms) {
    const { residueCount } = await processYm(ym)
    totalResidue += residueCount
  }

  console.log()
  console.log(`合計: ${totalResidue}件の残骸`)
  if (totalResidue > 0 && !apply) {
    console.log('--apply オプションを付けて再実行すると Firestore を更新します')
  }
  process.exit(0)
}

main().catch(e => {
  console.error('エラー:', e)
  process.exit(1)
})
