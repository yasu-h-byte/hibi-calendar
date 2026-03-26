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
const data = snap.data();

// Find yaesu site and add rates
const sites = data.sites;
const idx = sites.findIndex(s => s.id === 'yaesu');
if (idx === -1) { console.log('yaesu not found'); process.exit(1); }

sites[idx].rates = [{ from: '202510', tobiRate: 33000, dokoRate: 26000 }];
sites[idx].tobiRate = 33000;
sites[idx].dokoRate = 26000;

await updateDoc(ref, { sites });
console.log('Done: yaesu rates set to tobi=33000, doko=26000');
process.exit(0);
