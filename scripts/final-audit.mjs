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
const d = snap.data();

console.log('=== TOP-LEVEL KEYS ===');
console.log(Object.keys(d).sort().join(', '));

console.log('\n=== WORKERS ===');
console.log(`Count: ${d.workers?.length}, Fields: ${Object.keys(d.workers?.[0] || {}).join(', ')}`);
const retired = d.workers?.filter(w => w.retired);
console.log(`Retired: ${retired?.length} (${retired?.map(w => w.name).join(', ')})`);
const withToken = d.workers?.filter(w => w.token);
console.log(`With token: ${withToken?.length}`);

console.log('\n=== SITES ===');
d.sites?.forEach(s => console.log(`  ${s.id}: ${s.name} foreman=${s.foreman} archived=${!!s.archived} rates=${s.rates?.length || 0} periods`));

console.log('\n=== SUBCONS ===');
d.subcons?.forEach(s => console.log(`  ${s.id}: ${s.name} type=${s.type} rate=${s.rate} otRate=${s.otRate}`));

console.log('\n=== ASSIGN ===');
for (const [k, v] of Object.entries(d.assign || {})) {
  console.log(`  ${k}: workers=${v.workers?.length || 0} subcons=${v.subcons?.length || 0} dispatch=${JSON.stringify(v.dispatch || [])} subconRates=${Object.keys(v.subconRates || {}).length} entries`);
}

console.log('\n=== MASSIGN MONTHS ===');
const mkeys = Object.keys(d.massign || {}).sort();
console.log(mkeys.join(', '));

console.log('\n=== BILLING ===');
for (const [k, v] of Object.entries(d.billing || {})) {
  console.log(`  ${k}: ${JSON.stringify(v)}`);
}

console.log('\n=== LOCKS ===');
console.log(JSON.stringify(d.locks || {}));

console.log('\n=== WORKDAYS ===');
console.log(JSON.stringify(d.workDays || {}));

console.log('\n=== DEFAULT RATES ===');
console.log(JSON.stringify(d.defaultRates || {}));

console.log('\n=== MFOREMAN ===');
console.log(JSON.stringify(d.mforeman || {}));

console.log('\n=== PLDATA WORKERS ===');
console.log(Object.keys(d.plData || {}).join(', '));

console.log('\n=== APPROVALS ===');
console.log(JSON.stringify(d.approvals || {}));

console.log('\n=== SAVED AT ===');
console.log(d.savedAt);

// Check att_ docs existence
const months = ['202510','202511','202512','202601','202602','202603'];
console.log('\n=== ATT DOCS ===');
for (const ym of months) {
  try {
    const att = await getDoc(doc(db, 'demmen', 'att_' + ym));
    if (att.exists()) {
      const data = att.data();
      const dCount = Object.keys(data.d || {}).length;
      const sdCount = Object.keys(data.sd || {}).length;
      const appCount = Object.keys(data.approvals || {}).length;
      console.log(`  att_${ym}: d=${dCount} entries, sd=${sdCount} entries, approvals=${appCount}`);
    }
  } catch(e) { console.log(`  att_${ym}: ${e.code}`); }
}

// Check nextWorkerId
console.log('\n=== NEXT WORKER ID ===');
console.log(d.nextWorkerId);

process.exit(0);
