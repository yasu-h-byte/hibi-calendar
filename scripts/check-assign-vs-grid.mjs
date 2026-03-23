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

const mainDoc = await getDoc(doc(db, 'demmen', 'main'));
const main = mainDoc.data();

// Check assign vs massign
console.log('=== assign (current) ===');
const assign = main.assign || {};
for (const [siteId, data] of Object.entries(assign)) {
  console.log(`  ${siteId}: workers=[${data.workers?.join(',')}], subcons=[${data.subcons?.join(',')}]`);
}

// Check massign (monthly overrides)
console.log('\n=== massign (monthly overrides) ===');
const massign = main.massign || {};
for (const [key, data] of Object.entries(massign)) {
  console.log(`  ${key}: workers=[${data.workers?.join(',')}], subcons=[${data.subcons?.join(',')}]`);
}

// Check att_202603 - which worker IDs have data for each site
const attDoc = await getDoc(doc(db, 'demmen', 'att_202603'));
const att = attDoc.data();
const d = att.d || {};

console.log('\n=== Worker IDs with att data per site (202603) ===');
const siteWorkers = {};
for (const key of Object.keys(d)) {
  const parts = key.split('_');
  const siteId = parts[0];
  const wid = parseInt(parts[1]);
  if (!siteWorkers[siteId]) siteWorkers[siteId] = new Set();
  siteWorkers[siteId].add(wid);
}
for (const [siteId, wids] of Object.entries(siteWorkers)) {
  const assigned = assign[siteId]?.workers || [];
  const unassigned = [...wids].filter(w => !assigned.includes(w));
  console.log(`  ${siteId}: data for [${[...wids].sort((a,b)=>a-b).join(',')}]`);
  console.log(`    assigned: [${assigned.join(',')}]`);
  if (unassigned.length > 0) {
    console.log(`    ⚠ UNASSIGNED workers with data: [${unassigned.join(',')}]`);
    for (const uid of unassigned) {
      const worker = main.workers.find(w => w.id === uid);
      console.log(`      ${uid}: ${worker?.name || '?'} (org=${worker?.org}, retired=${worker?.retired || 'no'})`);
    }
  }
}

process.exit(0);
