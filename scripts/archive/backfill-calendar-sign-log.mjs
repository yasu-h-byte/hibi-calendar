/**
 * 既存の calendarSign（live署名）を永続アーカイブ calendarSignLog へ取り込む（一度だけ実行）。
 *
 * - 冪等: 既に同一IDのログがあればスキップ（再実行しても重複しない）
 * - signedDays は導入前の正確な値が無いため、現在の siteCalendar の休日設定を best-effort で
 *   スナップショット（backfilled:true で区別）。導入後の署名は署名時点の内容を正確に保存する。
 *
 * 実行: node scripts/backfill-calendar-sign-log.mjs
 */
import { initializeApp, getApps } from 'firebase/app'
import { getFirestore, collection, getDocs, doc, getDoc, setDoc } from 'firebase/firestore'

const app = getApps().length ? getApps()[0] : initializeApp({
  apiKey: 'AIzaSyAcA_kFC8hAqfmS_-_tOxI5oyjH06WNOwM',
  authDomain: 'dedura-kanri.firebaseapp.com',
  projectId: 'dedura-kanri',
  storageBucket: 'dedura-kanri.firebasestorage.app',
  messagingSenderId: '372352470111',
  appId: '1:372352470111:web:136292eb630abddde3dfea',
})
const db = getFirestore(app)

const signSnap = await getDocs(collection(db, 'calendarSign'))
console.log(`calendarSign: ${signSnap.size} 件を走査`)

// siteCalendar を全件読み、docId(`${siteId}_${ym}`) → {days, approvedAt} のマップに
const calSnap = await getDocs(collection(db, 'siteCalendar'))
const calMap = {}
calSnap.forEach(d => { const x = d.data(); calMap[`${x.siteId}_${x.ym}`] = { days: x.days || null, approvedAt: x.approvedAt || null } })

let created = 0, skipped = 0, errors = 0
for (const d of signSnap.docs) {
  const x = d.data()
  if (!x.signedAt || !x.workerId || !x.ym || !x.siteId) { skipped++; continue }
  const safeStamp = String(x.signedAt).replace(/[/:.]/g, '-')
  const id = `${x.workerId}_${x.ym}_${x.siteId}_${safeStamp}`
  try {
    const existing = await getDoc(doc(db, 'calendarSignLog', id))
    if (existing.exists()) { skipped++; continue }
    const cal = calMap[`${x.siteId}_${x.ym}`] || {}
    const resignCount = typeof x.resignCount === 'number' ? x.resignCount : 0
    await setDoc(doc(db, 'calendarSignLog', id), {
      workerId: x.workerId,
      ym: x.ym,
      siteId: x.siteId,
      signedAt: x.signedAt,
      method: x.method || 'tap',
      ipHash: x.ipHash || '',
      resignCount,
      event: resignCount > 0 ? 'resign' : 'sign',
      signedDays: cal.days || null,
      calendarApprovedAt: cal.approvedAt || null,
      loggedAt: new Date().toISOString(),
      backfilled: true,
    })
    created++
  } catch (e) {
    console.error(`  ERROR ${id}:`, e.message)
    errors++
  }
}
console.log(`\n完了: 作成 ${created} / スキップ(既存) ${skipped} / エラー ${errors}`)
process.exit(errors > 0 ? 1 : 0)
