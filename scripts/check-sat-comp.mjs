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

const att = await getDoc(doc(db, 'demmen', 'att_202603'));
const d = att.data().d || {};

// March 2026 Saturdays: 7, 14, 21, 28
const saturdays = [7, 14, 21, 28];

for (const sat of saturdays) {
  const entries = Object.entries(d).filter(([k]) => {
    const parts = k.split('_');
    return parts[parts.length - 1] === String(sat) && parts[parts.length - 2] === '202603';
  });
  
  const compEntries = entries.filter(([, v]) => v.w === 0.6);
  console.log(`Day ${sat} (Sat): ${entries.length} total entries, ${compEntries.length} comp (0.6)`);
  compEntries.forEach(([k, v]) => console.log(`  ${k}: ${JSON.stringify(v)}`));
}

process.exit(0);
