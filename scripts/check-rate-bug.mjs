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

const mainSnap = await getDoc(doc(db, 'demmen', 'main'));
const main = mainSnap.data();

// Check トゥアン (ID 102) who shows 101%
const wid = 102;
const months = ['202510','202511','202512','202601','202602','202603'];

for (const ym of months) {
  const attSnap = await getDoc(doc(db, 'demmen', 'att_' + ym));
  if (!attSnap.exists()) continue;
  const d = attSnap.data().d || {};
  
  let worked = 0;
  let entries = [];
  for (const [k, v] of Object.entries(d)) {
    const parts = k.split('_');
    const entryWid = parseInt(parts[parts.length - 3]);
    const entryYm = parts[parts.length - 2];
    if (entryWid !== wid || entryYm !== ym) continue;
    if (v.p) { entries.push({ day: parts[parts.length-1], type: 'PL' }); continue; }
    if (v.w && v.w > 0) {
      const isComp = (v.w === 0.6);
      if (!isComp) {
        worked += v.w;
        entries.push({ day: parts[parts.length-1], w: v.w, o: v.o || 0 });
      } else {
        entries.push({ day: parts[parts.length-1], type: 'comp', w: v.w });
      }
    }
  }
  
  const prescribed = main.workDays[ym] || 22;
  const rate = prescribed > 0 ? (worked / prescribed * 100).toFixed(1) : 0;
  console.log(`${ym}: worked=${worked} prescribed=${prescribed} rate=${rate}% entries=${entries.length}`);
  if (worked > prescribed) {
    entries.sort((a,b) => parseInt(a.day) - parseInt(b.day));
    entries.forEach(e => console.log(`  day ${e.day}: ${e.type || `w=${e.w} o=${e.o}`}`));
  }
}

process.exit(0);
