import { initializeApp } from 'firebase/app'
import { getFirestore, doc, getDoc } from 'firebase/firestore'
const cfg = { apiKey:'AIzaSyAcA_kFC8hAqfmS_-_tOxI5oyjH06WNOwM', authDomain:'dedura-kanri.firebaseapp.com', projectId:'dedura-kanri', storageBucket:'dedura-kanri.firebasestorage.app', messagingSenderId:'372352470111', appId:'1:372352470111:web:136292eb630abddde3dfea' }
const app = initializeApp(cfg); const db = getFirestore(app)

function parseDKey(k) {
  const p = k.split('_')
  if (p.length < 4) return null
  return { sid: p.slice(0, p.length - 3).join('_'), wid: p[p.length - 3], ym: p[p.length - 2], day: p[p.length - 1] }
}

// Replicate generatePLLedger logic
async function main() {
  const mainSnap = await getDoc(doc(db, 'demmen', 'main'))
  const main = mainSnap.data()
  const workers = main.workers
  const plData = main.plData

  // Collect all P entries from all att docs (extended to 2027 for future entries)
  const plDates = {}
  const ymList = []
  for (let y = 2024; y <= 2027; y++) {
    for (let m = 1; m <= 12; m++) ymList.push(`${y}${String(m).padStart(2,'0')}`)
  }
  for (const ym of ymList) {
    const snap = await getDoc(doc(db, 'demmen', `att_${ym}`))
    if (!snap.exists()) continue
    const attD = snap.data().d || {}
    for (const [key, entry] of Object.entries(attD)) {
      if (!entry || entry.p !== 1) continue
      const pk = parseDKey(key)
      const wid = parseInt(pk.wid)
      const dateStr = `${pk.ym.slice(0,4)}/${pk.ym.slice(4,6)}/${pk.day.padStart(2,'0')}`
      if (!plDates[wid]) plDates[wid] = []
      plDates[wid].push(dateStr)
    }
  }

  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const targets = [107, 106, 102, 104]
  for (const wid of targets) {
    const w = workers.find(x => x.id === wid)
    const records = (plData[String(wid)] || []).filter(r => !r._archived)
    if (records.length === 0) {
      console.log(`${w.name}: no records`)
      continue
    }
    const recordsWithGrant = records.filter(r => (r.grantDays && r.grantDays > 0) || (r.grant && r.grant > 0))
    // 修正後: activeRec を優先選択
    const activeRec = recordsWithGrant.find(rec => {
      if (!rec.grantDate) return false
      const gd = new Date(rec.grantDate)
      if (isNaN(gd.getTime())) return false
      const end = new Date(gd); end.setFullYear(end.getFullYear() + 1)
      return today >= gd && today < end
    })
    const r = activeRec ?? (recordsWithGrant.length > 0 ? recordsWithGrant[recordsWithGrant.length - 1] : records[records.length - 1])

    const grantDays = r.grantDays ?? r.grant ?? 0
    const carryOver = r.carryOver ?? r.carry ?? 0
    const adjustment = Math.max(r.adjustment ?? 0, r.adj ?? 0)
    const total = grantDays + carryOver

    // 修正後: 未来日付除外
    let periodUsed = 0
    if (r.grantDate) {
      const gd = new Date(r.grantDate)
      const gdEnd = new Date(gd)
      gdEnd.setFullYear(gdEnd.getFullYear() + 1)
      const wDates = plDates[wid] || []
      periodUsed = wDates.filter(d => {
        const pd = new Date(d.replace(/\//g, '-'))
        return pd >= gd && pd < gdEnd && pd <= today
      }).length
    }

    const used = adjustment + periodUsed
    const remaining = Math.max(0, total - used)

    console.log(`\n=== ${w.name} (id=${wid}) ===`)
    console.log(`  選ばれたrecord (activeRec優先): grantDate=${r.grantDate}, grantDays=${grantDays}, carryOver=${carryOver}, adjustment=${adjustment}, fy=${r.fy}`)
    console.log(`  total = ${total}`)
    console.log(`  periodUsed (該当grantDate期間, 未来除外) = ${periodUsed}`)
    console.log(`  used (adjustment + periodUsed) = ${used}`)
    console.log(`  remaining (修正後) = max(0, ${total} - ${used}) = ${remaining}`)
  }
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
