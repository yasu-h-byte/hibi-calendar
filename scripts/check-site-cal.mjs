import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs } from 'firebase/firestore';

const app = initializeApp({
  apiKey: "AIzaSyAcA_kFC8hAqfmS_-_tOxI5oyjH06WNOwM",
  authDomain: "dedura-kanri.firebaseapp.com",
  projectId: "dedura-kanri",
  storageBucket: "dedura-kanri.firebasestorage.app",
  messagingSenderId: "372352470111",
  appId: "1:372352470111:web:136292eb630abddde3dfea"
});
const db = getFirestore(app);

const snap = await getDocs(collection(db, 'siteCalendar'));
console.log(`siteCalendar docs: ${snap.size}`);
snap.forEach(d => {
  const data = d.data();
  console.log(`  ${d.id}: ym=${data.ym} siteId=${data.siteId} status=${data.status} days=${Object.keys(data.days || {}).length}`);
});
process.exit(0);
