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

// Check which att docs exist and have p=1 entries
const months = ['202510','202511','202512','202601','202602','202603'];
for (const ym of months) {
  try {
    const attDoc = await getDoc(doc(db, 'demmen', 'att_' + ym));
    if (!attDoc.exists()) { console.log(`att_${ym}: NOT FOUND`); continue; }
    const d = attDoc.data().d || {};
    const plEntries = Object.entries(d).filter(([k, v]) => v.p === 1);
    console.log(`att_${ym}: ${Object.keys(d).length} entries total, ${plEntries.length} PL entries`);
    if (plEntries.length > 0) {
      plEntries.forEach(([k, v]) => console.log(`  ${k}: ${JSON.stringify(v)}`));
    }
  } catch (e) {
    console.log(`att_${ym}: ERROR - ${e.code || e.message}`);
  }
}

process.exit(0);
