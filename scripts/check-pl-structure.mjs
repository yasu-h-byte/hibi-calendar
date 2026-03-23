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
const plData = snap.data().plData || {};

// Check which are arrays vs objects
for (const [wid, val] of Object.entries(plData)) {
  const isArray = Array.isArray(val);
  console.log(`${wid}: isArray=${isArray}, type=${typeof val}, ${isArray ? val.length + ' records' : 'single object'}`);
}
process.exit(0);
