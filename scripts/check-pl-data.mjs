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

// Check plData
const plData = data.plData || {};
console.log('=== plData keys ===');
console.log(Object.keys(plData));
console.log('\n=== plData contents ===');
for (const [wid, records] of Object.entries(plData)) {
  const w = data.workers.find(x => x.id === parseInt(wid));
  console.log(`\n${wid} (${w?.name || 'unknown'}):`);
  if (Array.isArray(records)) {
    records.forEach(r => console.log(`  ${JSON.stringify(r)}`));
  } else {
    console.log(`  ${JSON.stringify(records)}`);
  }
}

process.exit(0);
