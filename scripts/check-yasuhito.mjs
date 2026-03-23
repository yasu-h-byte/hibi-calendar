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

// Find 日比靖仁
const yasu = workers.find(w => w.name === '日比靖仁');
console.log('日比靖仁:', JSON.stringify(yasu, null, 2));

// Also check ID 12 (the user mentioned they were added)
const id12 = workers.find(w => w.id === 12);
console.log('\nID 12:', JSON.stringify(id12, null, 2));

// Show all workers with their key fields
console.log('\n--- Login filter check ---');
workers.forEach(w => {
  const hasToken = !!w.token;
  const isAdmin = ['yakuin', 'shokucho'].includes(w.job);
  const shows = !hasToken || isAdmin;
  if (w.name.includes('日比')) {
    console.log(`${w.id} ${w.name}: token=${hasToken}, job=${w.job}, shows=${shows}`);
  }
});

process.exit(0);
