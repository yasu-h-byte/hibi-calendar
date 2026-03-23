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
const massign = snap.data().massign || {};

// Show worker counts per month for sasazuka
const keys = Object.keys(massign).filter(k => k.startsWith('sasazuka_')).sort();
for (const k of keys) {
  const wc = massign[k].workers?.length || 0;
  console.log(`${k}: ${wc} workers`);
}

console.log('\n--- IHI ---');
const ihiKeys = Object.keys(massign).filter(k => k.startsWith('ihi_')).sort();
for (const k of ihiKeys) {
  const wc = massign[k].workers?.length || 0;
  console.log(`${k}: ${wc} workers`);
}

// Show current assign for comparison
const assign = snap.data().assign;
console.log(`\nCurrent assign sasazuka: ${assign.sasazuka?.workers?.length} workers`);
console.log(`Current assign ihi: ${assign.ihi?.workers?.length} workers`);

process.exit(0);
