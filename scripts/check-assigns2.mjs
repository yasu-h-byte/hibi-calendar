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
const data = docSnap.data();
// Check all top-level keys
console.log('Top-level keys:', Object.keys(data));
// Check assigns structure
const assigns = data.assigns;
if (assigns) {
  console.log('assigns type:', typeof assigns);
  console.log('assigns:', JSON.stringify(assigns, null, 2));
} else {
  console.log('No assigns field');
}
process.exit(0);
