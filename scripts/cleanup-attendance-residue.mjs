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
 * エントリの「真の残骸」（=ステータス不整合フィールド）のみを検出する。
 *
 * 「真の残骸」の定義:
 *   非作業ステータス flag (p/r/h/hk/exam) があるのに、
 *   作業時の時間ベースフィールド (st/et/b1/b2/b3) や残業 (o>0) が残っている状態。
 *
 *   これがビンさん事案 (5/1 有給日に o:1 が残骸として加算) で問題化した実態。
 *
 *   ※ o:0 や w:0 など 0 値は「正常な明示」なので残骸扱いしない。
 *   ※ 作業日に st/et を持つのは時間ベース入力 (5月以降) では正常。
 */
function detectResidue(entry) {
  if (!entry || typeof entry !== 'object') return { residue: [] }

  const p = (entry.p ?? 0) > 0
  const r = (entry.r ?? 0) > 0
  const h = (entry.h ?? 0) > 0
  const hk = (entry.hk ?? 0) > 0
  const exam = (entry.exam ?? 0) > 0
  const isNonWork = p || r || h || hk || exam

  let canonicalStatus = null
  if (p) canonicalStatus = 'leave'
  else if (exam) canonicalStatus = 'exam'
  else if (r) canonicalStatus = 'rest'
  else if (h) canonicalStatus = 'site_off'
  else if (hk) canonicalStatus = 'home_leave'
  else if ((entry.w ?? 0) > 0) canonicalStatus = 'work'
  else return { residue: [] }

  // 残骸検出: 非作業ステータスのみ、時間ベース/残業フィールドが残っていれば残骸
  const residue = []
  if (isNonWork) {
    // st/et/b*/o は休み・有給・現場休・帰国中・試験 では不要
    const TIME_BASED_FIELDS = ['st', 'et', 'b1', 'b2', 'b3']
    for (const f of TIME_BASED_FIELDS) {
      if (f in entry) residue.push(f)
    }
    // 残業 o は値が > 0 のときだけ残骸（o:0 は単なる明示）
    if ((entry.o ?? 0) > 0) residue.push('o')
    // 残ステータス flag も他のステータスとの混在は残骸（優先順位上、より優先するもの以外）
    // 例: p:1, r:1 が両方ある場合 → p が優先、r は残骸
    if (canonicalStatus === 'leave' && r) residue.push('r')
    if (canonicalStatus === 'leave' && h) residue.push('h')
    if (canonicalStatus === 'leave' && hk) residue.push('hk')
    if (canonicalStatus === 'leave' && exam) residue.push('exam')
    if (canonicalStatus === 'exam' && r) residue.push('r')
    if (canonicalStatus === 'exam' && h) residue.push('h')
    if (canonicalStatus === 'exam' && hk) residue.push('hk')
    if (canonicalStatus === 'rest' && h) residue.push('h')
    if (canonicalStatus === 'rest' && hk) residue.push('hk')
    if (canonicalStatus === 'site_off' && hk) residue.push('hk')
    // また、非作業ステータス + w > 0 は混在残骸（{w:1, p:1}）。w を 0 に補正する。
    if ((entry.w ?? 0) > 0) residue.push('w')  // ※後で 0 として再追加すべきだが deleteField でも問題なし
    // rest 以外の場合 rReason/rNote も残骸
    if (canonicalStatus !== 'rest') {
      if ('rReason' in entry) residue.push('rReason')
      if ('rNote' in entry) residue.push('rNote')
    }
  } else if (canonicalStatus === 'work') {
    // 作業日の場合、ステータス flag (p/r/h/hk/exam) があれば残骸
    // ※ canonical status='work' になっている時点で flags は false なので、ここに該当はしない
    // 念のため確認
  }

  return { canonicalStatus, residue: [...new Set(residue)] }
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
