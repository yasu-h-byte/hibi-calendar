import { initializeApp } from 'firebase/app'
import { getFirestore, doc, getDoc } from 'firebase/firestore'
const cfg = { apiKey:'AIzaSyAcA_kFC8hAqfmS_-_tOxI5oyjH06WNOwM', authDomain:'dedura-kanri.firebaseapp.com', projectId:'dedura-kanri', storageBucket:'dedura-kanri.firebasestorage.app', messagingSenderId:'372352470111', appId:'1:372352470111:web:136292eb630abddde3dfea' }
const app = initializeApp(cfg); const db = getFirestore(app)

const TARGETS = [
  { id: 107, name: 'ケン', grantDate: '2025-11-14' },
  { id: 106, name: 'タン', grantDate: '2025-11-14' },
  { id: 102, name: 'トゥアン', grantDate: '2025-11-01' },
  { id: 104, name: 'フン', grantDate: '2025-09-16' },
]

function parseDKey(k) {
  const p = k.split('_')
  if (p.length < 4) return null
  return { sid: p.slice(0, p.length - 3).join('_'), wid: p[p.length - 3], ym: p[p.length - 2], day: p[p.length - 1] }
}

const ymList = []
// scan from 2025-09 to 2026-05
for (let y = 2025; y <= 2026; y++) {
  for (let m = 1; m <= 12; m++) {
    if (y === 2025 && m < 9) continue
    if (y === 2026 && m > 5) continue
    ymList.push(`${y}${String(m).padStart(2,'0')}`)
  }
}

for (const t of TARGETS) {
  console.log(`\n=== ${t.name} (id=${t.id}) — 直近付与: ${t.grantDate} ===`)
  const dates = []
  for (const ym of ymList) {
    const snap = await getDoc(doc(db, 'demmen', `att_${ym}`))
    if (!snap.exists()) continue
    const d = snap.data().d || {}
    for (const [key, entry] of Object.entries(d)) {
      if (!entry || !entry.p) continue
      const pk = parseDKey(key)
      if (pk.wid !== String(t.id)) continue
      const date = `${pk.ym.slice(0,4)}-${pk.ym.slice(4,6)}-${pk.day.padStart(2,'0')}`
      dates.push({ date, siteId: pk.sid })
    }
  }
  dates.sort((a,b) => a.date.localeCompare(b.date))
  // dedupe same date (same worker different site)
  const dedupedByDate = {}
  for (const d of dates) {
    if (!dedupedByDate[d.date]) dedupedByDate[d.date] = []
    dedupedByDate[d.date].push(d.siteId)
  }
  const grantStart = t.grantDate
  let usedInPeriod = 0
  for (const date of Object.keys(dedupedByDate)) {
    if (date >= grantStart) usedInPeriod++
  }
  console.log(`Total P entries (全期間): ${dates.length} (重複なし日数: ${Object.keys(dedupedByDate).length})`)
  console.log(`付与日(${grantStart})以降の使用日数: ${usedInPeriod}日`)
  console.log(`日付一覧:`)
  for (const [date, sites] of Object.entries(dedupedByDate).sort()) {
    const inPeriod = date >= grantStart ? '★' : '  '
    console.log(`  ${inPeriod} ${date}  sites: ${sites.join(', ')}`)
  }
}
process.exit(0)
