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
const workers = main.workers;
const sites = main.sites.filter(s => !s.archived);

const todayYM = '202603';
const todayDay = 24;

const attSnap = await getDoc(doc(db, 'demmen', 'att_202603'));
const attData = attSnap.exists() ? attSnap.data() : {};
const D = attData.d || {};
const SD = attData.sd || {};

console.log('=== Today status check (3/24) ===\n');

for (const site of sites) {
  const sid = site.id;
  // Get assign
  const massignKey = `${sid}_${todayYM}`;
  const massign = main.massign[massignKey];
  const assign = main.assign[sid];
  const workerIds = massign?.workers || assign?.workers || [];
  const subconIds = massign?.subcons || assign?.subcons || [];
  
  let tobi = 0, doko = 0, subTobi = 0, subDoko = 0;
  const tobiWorkers = [];
  const dokoWorkers = [];
  
  for (const wid of workerIds) {
    const w = workers.find(x => x.id === wid);
    if (!w || w.retired) continue;
    const key = `${sid}_${wid}_${todayYM}_${todayDay}`;
    const val = D[key];
    if (val && val.w && !val.p && val.w !== 0.6) {
      if (w.job === 'doko') {
        doko += parseFloat(val.w);
        dokoWorkers.push(`${w.name}(${w.job},w=${val.w})`);
      } else {
        tobi += parseFloat(val.w);
        tobiWorkers.push(`${w.name}(${w.job},w=${val.w})`);
      }
    }
  }
  
  for (const scid of subconIds) {
    const key = `${sid}_${scid}_${todayYM}_${todayDay}`;
    const val = SD[key];
    if (val && val.n) {
      const sc = main.subcons.find(x => x.id === scid);
      const n = parseFloat(val.n);
      if (sc && sc.type === '土工業者') {
        subDoko += n;
      } else {
        subTobi += n;
      }
    }
  }
  
  const total = tobi + doko + subTobi + subDoko;
  console.log(`${site.name}:`);
  console.log(`  鳶=${tobi} (${tobiWorkers.join(', ')})`);
  console.log(`  土工=${doko} (${dokoWorkers.join(', ')})`);
  console.log(`  外注鳶=${subTobi}, 外注土工=${subDoko}`);
  console.log(`  合計=${total}`);
  console.log();
}

// Check: is worker 1 (日比政仁) in both sites?
const w1 = workers.find(x => x.id === 1);
console.log(`\n=== Worker 1 (${w1?.name}) ===`);
console.log(`job: ${w1?.job}`);
for (const site of sites) {
  const sid = site.id;
  const massignKey = `${sid}_${todayYM}`;
  const massign = main.massign[massignKey];
  const assign = main.assign[sid];
  const wids = massign?.workers || assign?.workers || [];
  const inSite = wids.includes(1);
  const key = `${sid}_1_${todayYM}_${todayDay}`;
  const val = D[key];
  console.log(`  ${site.name}: assigned=${inSite}, att=${JSON.stringify(val)}`);
}

process.exit(0);
