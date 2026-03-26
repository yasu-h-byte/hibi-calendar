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

// Check all sites for rates
data.sites.forEach(s => {
  console.log(`\n=== ${s.id}: ${s.name} ===`);
  console.log(`  tobiRate: ${s.tobiRate || 'NOT SET'}`);
  console.log(`  dokoRate: ${s.dokoRate || 'NOT SET'}`);
  console.log(`  rates array: ${s.rates ? JSON.stringify(s.rates) : 'NOT SET'}`);
});

// Check old app's hardcoded rates
console.log('\n=== defaultRates ===');
console.log(JSON.stringify(data.defaultRates));

process.exit(0);
