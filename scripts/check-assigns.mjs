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

const docSnap = await getDoc(doc(db, 'demmen', 'main'));
const assigns = docSnap.data().assigns || {};
for (const [siteId, data] of Object.entries(assigns)) {
  console.log(`${siteId}: workers=${JSON.stringify(data.workers)}`);
}
process.exit(0);
