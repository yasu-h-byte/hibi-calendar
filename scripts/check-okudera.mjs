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
const workers = snap.data().workers || [];

// Find okudera
const okudera = workers.find(w => w.name?.includes('奥寺'));
console.log('奥寺:', JSON.stringify(okudera, null, 2));

// Show all workers who can log in (yakuin/shokucho/keiri)
console.log('\n=== Login-capable workers ===');
workers.filter(w => !w.retired && (w.job === 'yakuin' || w.job === 'shokucho' || w.job === 'keiri'))
  .forEach(w => console.log(`  ${w.id}: ${w.name} job=${w.job} org=${w.org}`));

// Show all unique job types
console.log('\n=== All job types ===');
const jobs = [...new Set(workers.map(w => w.job))];
console.log(jobs);

process.exit(0);
