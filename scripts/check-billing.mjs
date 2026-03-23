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
const billing = snap.data().billing || {};

console.log('=== Billing data ===');
const keys = Object.keys(billing).sort();
keys.forEach(k => console.log(`  ${k}: ${JSON.stringify(billing[k])}`));
console.log(`\nTotal entries: ${keys.length}`);

// Also check what the old app might use differently
const data = snap.data();
// Check if there's a different billing field
const topKeys = Object.keys(data);
const billingRelated = topKeys.filter(k => k.toLowerCase().includes('bill') || k.toLowerCase().includes('uriage') || k.toLowerCase().includes('seikyu'));
console.log('\nBilling-related top keys:', billingRelated);

process.exit(0);
