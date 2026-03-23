import { initializeApp } from 'firebase/app';
import { getFirestore, doc, getDoc } from 'firebase/firestore';

const app = initializeApp({
  apiKey: "AIzaSyAcA_kFC8hAqfmS_-_tOxI5oyjH06WNOwM",
  authDomain: "dedura-kanri.firebaseapp.com",
  projectId: "dedura-kanri",
  storageBucket: "dedura-kanri.firebasestorage.app",
  messagingSenderId: "372352470111",
  appId: "1:372352470111:web:136292eb630abddde3dfea"
});
const db = getFirestore(app);

const snap = await getDoc(doc(db, 'demmen', 'main'));
const data = snap.data();
const plData = data.plData || {};
const workers = data.workers || [];

// Count PL usage from att data (FY2025: 202510 - 202609)
const fyMonths = [];
for (let m = 10; m <= 12; m++) fyMonths.push(String(2025 * 100 + m));
for (let m = 1; m <= 9; m++) fyMonths.push(String(2026 * 100 + m));

const plUsage = {};
for (const ym of fyMonths) {
  try {
    const attDoc = await getDoc(doc(db, 'demmen', 'att_' + ym));
    if (!attDoc.exists()) continue;
    const d = attDoc.data().d || {};
    for (const [key, val] of Object.entries(d)) {
      if (val.p && val.p === 1) {
        const parts = key.split('_');
        const wid = parseInt(parts[parts.length - 3]);
        plUsage[wid] = (plUsage[wid] || 0) + 1;
      }
    }
  } catch (e) { /* permission denied for some months */ }
}

// Compare with plData
console.log('=== FY2025 有給データ比較 ===');
console.log('Name               | 付与 | 繰越 | 調整 | 合計 | 消化(att) | 残');
console.log('-------------------|------|------|------|------|-----------|----');

const eligible = workers.filter(w => !w.retired && w.job !== 'yakuin');
for (const w of eligible) {
  const records = plData[String(w.id)] || [];
  // Find FY2025 record (fy could be number 2025 or string "2025")
  const rec = Array.isArray(records) 
    ? records.find(r => String(r.fy) === '2025')
    : (String(records.fy) === '2025' ? records : null);
  
  if (!rec) continue;
  
  const grant = rec.grant ?? rec.grantDays ?? 0;
  const carry = rec.carry ?? rec.carryOver ?? 0;
  const adj = rec.adj ?? rec.adjustment ?? 0;
  const total = grant + carry + adj;
  const used = plUsage[w.id] || 0;
  const rem = total - used;
  
  const name = (w.name + '          ').slice(0, 18);
  console.log(`${name} | ${String(grant).padStart(4)} | ${String(carry).padStart(4)} | ${String(adj).padStart(4)} | ${String(total).padStart(4)} | ${String(used).padStart(9)} | ${String(rem).padStart(3)}`);
}

process.exit(0);
