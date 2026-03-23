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

// Check att_202603 data structure
const attDoc = await getDoc(doc(db, 'demmen', 'att_202603'));
if (!attDoc.exists()) { console.log('att_202603 not found'); process.exit(0); }

const data = attDoc.data();
const d = data.d || {};

// Show all keys for sasazuka site, worker 3 (大川)
const sasazukaKeys = Object.keys(d).filter(k => k.startsWith('sasazuka_3_'));
console.log('=== sasazuka worker 3 (大川) keys ===');
sasazukaKeys.sort().forEach(k => console.log(`  ${k}: ${JSON.stringify(d[k])}`));

// Show first 30 keys to understand key format
console.log('\n=== First 30 keys (sorted) ===');
const allKeys = Object.keys(d).sort();
allKeys.slice(0, 30).forEach(k => console.log(`  ${k}: ${JSON.stringify(d[k])}`));

// Check key patterns - what format are dates in?
console.log('\n=== Key patterns ===');
const patterns = {};
allKeys.forEach(k => {
  const parts = k.split('_');
  const pattern = parts.length + ' parts: ' + parts.map((p,i) => i === 0 ? 'site' : i === parts.length-1 ? 'day=' + p : (isNaN(p) ? p : 'num')).join('_');
  patterns[pattern] = (patterns[pattern] || 0) + 1;
});
Object.entries(patterns).forEach(([p,c]) => console.log(`  ${p}: ${c} entries`));

// Show keys for days 1-15 vs 10-31 to check the 9-day issue
console.log('\n=== Day distribution (sasazuka) ===');
const sasaKeys = Object.keys(d).filter(k => k.startsWith('sasazuka_'));
const dayNums = sasaKeys.map(k => {
  const parts = k.split('_');
  return parseInt(parts[parts.length - 1]);
}).filter(n => !isNaN(n));
for (let day = 1; day <= 31; day++) {
  const count = dayNums.filter(n => n === day).length;
  if (count > 0) console.log(`  Day ${day}: ${count} entries`);
}

process.exit(0);
