import { initializeApp } from 'firebase/app';
import { getFirestore, doc, getDoc, updateDoc } from 'firebase/firestore';

const app = initializeApp({
  apiKey: "AIzaSyAcA_kFC8hAqfmS_-_tOxI5oyjH06WNOwM",
  authDomain: "dedura-kanri.firebaseapp.com",
  projectId: "dedura-kanri",
  storageBucket: "dedura-kanri.firebasestorage.app",
  messagingSenderId: "372352470111",
  appId: "1:372352470111:web:136292eb630abddde3dfea"
});
const db = getFirestore(app);

const ref = doc(db, 'demmen', 'main');
const snap = await getDoc(ref);
const workers = snap.data().workers;

// Update 奥寺 (id:13) job from keiri to jimu
const idx = workers.findIndex(w => w.id === 13);
if (idx >= 0) {
  workers[idx].job = 'jimu';
  await updateDoc(ref, { workers });
  console.log('Updated 奥寺 job to jimu');
} else {
  console.log('奥寺 not found');
}

process.exit(0);
