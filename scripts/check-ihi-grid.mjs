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

// IHI current assign
const assign = data.assign?.ihi;
console.log('=== IHI assign ===');
console.log('workers:', assign?.workers?.length, assign?.workers);

// IHI massign for 202603
const massign = data.massign?.['ihi_202603'];
console.log('\n=== IHI massign 202603 ===');
console.log('workers:', massign?.workers?.length, massign?.workers);

// Show worker names for the assigned list
const workerIds = massign?.workers || assign?.workers || [];
const workers = data.workers.filter(w => workerIds.includes(w.id));
console.log('\n=== Workers in IHI ===');
workers.forEach(w => console.log(`  ${w.id}: ${w.name} org=${w.org} job=${w.job} retired=${w.retired || ''}`));

// Count by org
const hibi = workers.filter(w => w.org === 'hibi');
const hfu = workers.filter(w => w.org === 'hfu');
console.log(`\nhibi: ${hibi.length}, hfu: ${hfu.length}`);

process.exit(0);
