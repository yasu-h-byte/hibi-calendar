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
const sites = data.sites || [];
const workers = data.workers || [];

sites.filter(s => !s.archived).forEach(s => {
  const foreman = workers.find(w => w.id === s.foreman);
  console.log(`${s.name}: 職長=${foreman?.name || '?'} (id:${s.foreman}) token=${foreman?.token || 'なし'}`);
});
process.exit(0);
