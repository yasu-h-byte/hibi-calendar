import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs, doc, getDoc } from 'firebase/firestore';

const app = initializeApp({
  apiKey: "AIzaSyAcA_kFC8hAqfmS_-_tOxI5oyjH06WNOwM",
  authDomain: "dedura-kanri.firebaseapp.com",
  projectId: "dedura-kanri",
  storageBucket: "dedura-kanri.firebasestorage.app",
  messagingSenderId: "372352470111",
  appId: "1:372352470111:web:136292eb630abddde3dfea"
});
const db = getFirestore(app);

// 1. siteCalendar docs
console.log('=== siteCalendar ===');
const scSnap = await getDocs(collection(db, 'siteCalendar'));
scSnap.forEach(d => {
  const data = d.data();
  console.log(`  ${d.id}: status=${data.status}, days=${data.days ? Object.keys(data.days).length + ' days' : 'null'}`);
});

// 2. calendarSign docs
console.log('\n=== calendarSign ===');
const csSnap = await getDocs(collection(db, 'calendarSign'));
csSnap.forEach(d => {
  const data = d.data();
  console.log(`  ${d.id}: signedAt=${data.signedAt}`);
});

// 3. attendanceApprovals
console.log('\n=== attendanceApprovals ===');
const aaSnap = await getDocs(collection(db, 'attendanceApprovals'));
aaSnap.forEach(d => {
  const data = d.data();
  console.log(`  ${d.id}: foreman=${JSON.stringify(data.foreman)}`);
});

// 4. att_202603 (current month test entries)
console.log('\n=== att_202603 (test entries) ===');
const attDoc = await getDoc(doc(db, 'demmen', 'att_202603'));
if (attDoc.exists()) {
  const d = attDoc.data().d || {};
  // Only show entries with s:'staff' that might be test data from today
  const testEntries = Object.entries(d).filter(([k, v]) => {
    return k.includes('_301_') || k.includes('_23'); // Chi's entries or today's entries
  });
  testEntries.forEach(([k, v]) => {
    console.log(`  ${k}: ${JSON.stringify(v)}`);
  });
  if (testEntries.length === 0) console.log('  (no test entries found)');
}

process.exit(0);
