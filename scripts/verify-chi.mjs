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
const assign = docSnap.data().assign;

console.log('笹塚 workers:', assign.sasazuka.workers);
console.log('IHI workers:', assign.ihi.workers);
console.log('笹塚に301:', assign.sasazuka.workers.includes(301));
console.log('IHIに301:', assign.ihi.workers.includes(301));
process.exit(0);
