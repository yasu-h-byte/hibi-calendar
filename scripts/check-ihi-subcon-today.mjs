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

const attSnap = await getDoc(doc(db, 'demmen', 'att_202603'));
const SD = attSnap.exists() ? (attSnap.data().sd || {}) : {};

const todayDay = new Date().getDate();
console.log(`Today: 3/${todayDay}\n`);

// IHI subcon assignment
const ihiAssign = main.assign['ihi'];
const ihiMassign = main.massign['ihi_202603'];
const subconIds = ihiMassign?.subcons || ihiAssign?.subcons || [];

console.log('=== IHI subcon assignment ===');
console.log('subconIds:', subconIds);

console.log('\n=== IHI subcon att data for today ===');
let totalN = 0, tobiN = 0, dokoN = 0;
for (const scid of subconIds) {
  const sc = main.subcons.find(x => x.id === scid);
  const key = `ihi_${scid}_202603_${todayDay}`;
  const val = SD[key];
  const n = val?.n || 0;
  const on = val?.on || 0;
  totalN += n;
  if (sc?.type === '土工業者') {
    dokoN += n;
  } else {
    tobiN += n;
  }
  console.log(`  ${scid} (${sc?.name}, type=${sc?.type}): n=${n}, on=${on}`);
}
console.log(`\nTotal: ${totalN} (鳶業者=${tobiN}, 土工業者=${dokoN})`);

// Also check ALL subcon entries for IHI today (in case there are entries not in subconIds)
console.log('\n=== ALL IHI subcon entries for today in att data ===');
const allIhiSubKeys = Object.keys(SD).filter(k => k.startsWith('ihi_') && k.endsWith(`_202603_${todayDay}`));
for (const k of allIhiSubKeys) {
  const parts = k.split('_');
  const scid = parts[1];
  const val = SD[k];
  const inAssign = subconIds.includes(scid);
  console.log(`  ${k}: ${JSON.stringify(val)} (in assign: ${inAssign})`);
}

process.exit(0);
