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
const workers = docSnap.data().workers || [];
const chi = workers.find(w => w.id === 301);
console.log('Worker 301:', JSON.stringify(chi, null, 2));

// Also check sites to see which ones exist
const sites = docSnap.data().sites || [];
console.log('\nSites:', sites.map(s => `${s.id}: ${s.name}`));

process.exit(0);
