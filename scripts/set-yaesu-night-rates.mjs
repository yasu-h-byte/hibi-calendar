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
const sites = snap.data().sites;

const idx = sites.findIndex(s => s.id === 'yaesu_night');
if (idx === -1) { console.log('yaesu_night not found'); process.exit(1); }

// 八重洲の1.5倍: 鳶33000*1.5=49500, 土工26000*1.5=39000
sites[idx].rates = [{ from: '202510', tobiRate: 49500, dokoRate: 39000 }];
sites[idx].tobiRate = 49500;
sites[idx].dokoRate = 39000;

await updateDoc(ref, { sites });
console.log('Done: yaesu_night rates set to tobi=49500 (33000x1.5), doko=39000 (26000x1.5)');
process.exit(0);
