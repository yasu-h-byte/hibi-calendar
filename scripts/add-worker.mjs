import { initializeApp } from 'firebase/app';
import { getFirestore, doc, getDoc, updateDoc, arrayUnion } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: "AIzaSyAcA_kFC8hAqfmS_-_tOxI5oyjH06WNOwM",
  authDomain: "dedura-kanri.firebaseapp.com",
  projectId: "dedura-kanri",
  storageBucket: "dedura-kanri.firebasestorage.app",
  messagingSenderId: "372352470111",
  appId: "1:372352470111:web:136292eb630abddde3dfea"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const docRef = doc(db, 'demmen', 'main');
const docSnap = await getDoc(docRef);
const data = docSnap.data();
const workers = data.workers || [];

const ids = workers.map(w => w.id).sort((a, b) => a - b);
console.log('Existing IDs:', ids);

const token = 'chi-' + Math.random().toString(36).substring(2, 10);

const newWorker = {
  id: 301,
  name: 'レ ファン ティ チー',
  nameVi: 'Lê Phan Thị Chi',
  org: 'mtec',
  visa: 'テスト',
  job: 'テスト',
  token: token
};

console.log('Adding:', JSON.stringify(newWorker));

await updateDoc(docRef, { workers: arrayUnion(newWorker) });

console.log('Done! Token:', token);
process.exit(0);
