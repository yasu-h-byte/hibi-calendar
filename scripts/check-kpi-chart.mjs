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

const mainSnap = await getDoc(doc(db, 'demmen', 'main'));
const main = mainSnap.data();

// Check billing for FY months with all sites including archived
const fyMonths = ['202510','202511','202512','202601','202602','202603'];
const allSiteIds = main.sites.map(s => s.id);

console.log('=== Per-month billing (ALL sites including archived) ===\n');
for (const ym of fyMonths) {
  let total = 0;
  const breakdown = [];
  for (const sid of allSiteIds) {
    const key = `${sid}_${ym}`;
    const val = main.billing[key];
    if (val) {
      const sum = Array.isArray(val) ? val.reduce((a, b) => a + b, 0) : (typeof val === 'number' ? val : 0);
      total += sum;
      breakdown.push(`${sid}=${Math.round(sum/10000)}万`);
    }
  }
  console.log(`${ym}: total=¥${Math.round(total/10000)}万 (${breakdown.join(', ')})`);
}

// Check if yaesu is archived
const yaesu = main.sites.find(s => s.id === 'yaesu');
console.log(`\nyaesu archived: ${yaesu?.archived}`);
console.log(`yaesu end: ${yaesu?.end}`);

// Check att data for yaesu in Dec
const attDec = await getDoc(doc(db, 'demmen', 'att_202512'));
if (attDec.exists()) {
  const d = attDec.data().d || {};
  const yaesuKeys = Object.keys(d).filter(k => k.startsWith('yaesu_'));
  console.log(`\nyaesu att_202512 entries: ${yaesuKeys.length}`);
}

process.exit(0);
