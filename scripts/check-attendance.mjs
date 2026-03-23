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

// Check attendance data structure
const att = await getDoc(doc(db, 'demmen', 'att_202603'));
if (att.exists()) {
  const data = att.data();
  console.log('att_202603 top keys:', Object.keys(data));
  // Show one site's structure
  const firstKey = Object.keys(data)[0];
  console.log(`\nFirst key: "${firstKey}"`);
  const firstVal = data[firstKey];
  if (typeof firstVal === 'object') {
    console.log('Structure:', JSON.stringify(firstVal, null, 2).substring(0, 1500));
  }
} else {
  console.log('att_202603 not found');
}

// Also check main doc for workDays and other attendance-related fields
const main = await getDoc(doc(db, 'demmen', 'main'));
const mainData = main.data();
console.log('\n--- workDays ---');
console.log(JSON.stringify(mainData.workDays, null, 2)?.substring(0, 500));
console.log('\n--- locks ---');
console.log(JSON.stringify(mainData.locks, null, 2));

process.exit(0);
