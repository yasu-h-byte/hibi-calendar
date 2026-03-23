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

const main = (await getDoc(doc(db, 'demmen', 'main'))).data();

// Check 202603 data
const att = await getDoc(doc(db, 'demmen', 'att_202603'));
const attData = att.exists() ? att.data() : {};
const d = attData.d || {};
const sd = attData.sd || {};

// Count worker entries per site
const sites = ['sasazuka', 'ihi', 'yaesu'];
for (const site of sites) {
  const workerKeys = Object.keys(d).filter(k => k.startsWith(site + '_'));
  const subconKeys = Object.keys(sd).filter(k => k.startsWith(site + '_'));
  
  // Count unique workers
  const workerIds = new Set(workerKeys.map(k => k.split('_')[1]));
  const subconIds = new Set(subconKeys.map(k => k.split('_')[1]));
  
  // Sum work days
  let totalWork = 0;
  let totalOT = 0;
  workerKeys.forEach(k => {
    const e = d[k];
    if (e.w) totalWork += e.w;
    if (e.o) totalOT += e.o;
  });
  
  // Sum subcon work
  let totalSubconN = 0;
  let totalSubconON = 0;
  subconKeys.forEach(k => {
    const e = sd[k];
    if (e.n) totalSubconN += e.n;
    if (e.on) totalSubconON += e.on;
  });
  
  console.log(`=== ${site} (202603) ===`);
  console.log(`  Worker entries: ${workerKeys.length}, unique workers: ${workerIds.size}`);
  console.log(`  Total work days: ${totalWork}, OT hours: ${totalOT}`);
  console.log(`  Subcon entries: ${subconKeys.length}, unique subcons: ${subconIds.size}`);
  console.log(`  Total subcon N: ${totalSubconN}, subcon ON: ${totalSubconON}`);
  console.log(`  Grand total man-days: ${totalWork + totalSubconN}`);
}

// Check assign vs massign for 202603
console.log('\n=== Current assign ===');
for (const site of sites) {
  const a = main.assign[site];
  if (a) {
    console.log(`  ${site}: ${a.workers?.length || 0} workers, ${a.subcons?.length || 0} subcons`);
  }
}

console.log('\n=== massign 202603 ===');
for (const site of sites) {
  const key = `${site}_202603`;
  const m = main.massign[key];
  if (m) {
    console.log(`  ${site}: ${m.workers?.length || 0} workers, ${m.subcons?.length || 0} subcons`);
  }
}

// Check subcon data structure
console.log('\n=== Subcon detail (sasazuka 202603) ===');
const sasaSubKeys = Object.keys(sd).filter(k => k.startsWith('sasazuka_'));
const subconBySc = {};
sasaSubKeys.forEach(k => {
  const parts = k.split('_');
  const scId = parts[1];
  if (!subconBySc[scId]) subconBySc[scId] = { total_n: 0, total_on: 0, days: 0 };
  subconBySc[scId].total_n += sd[k].n || 0;
  subconBySc[scId].total_on += sd[k].on || 0;
  subconBySc[scId].days++;
});
for (const [scId, data] of Object.entries(subconBySc)) {
  const sc = main.subcons.find(s => s.id === scId);
  console.log(`  ${scId} (${sc?.name || '?'}): N=${data.total_n}, ON=${data.total_on}, ${data.days} day-entries`);
}

process.exit(0);
