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

// Feb billing
const febBilling = {};
let totalFebBill = 0;
for (const site of main.sites) {
  const key = `${site.id}_202602`;
  const val = main.billing[key];
  if (val) {
    const sum = Array.isArray(val) ? val.reduce((a, b) => a + b, 0) : val;
    febBilling[site.id] = sum;
    totalFebBill += sum;
    console.log(`${site.id} billing: ${sum} (${JSON.stringify(val)})`);
  }
}
console.log(`Total Feb billing: ¥${totalFebBill} = ¥${Math.round(totalFebBill/10000)}万`);

// Feb att data
const febAtt = await getDoc(doc(db, 'demmen', 'att_202602'));
const D = febAtt.exists() ? (febAtt.data().d || {}) : {};
const SD = febAtt.exists() ? (febAtt.data().sd || {}) : {};

// Compute tobiEquiv for Feb
const dr = main.defaultRates;
const dokoRatio = dr.dokoRate / dr.tobiRate;
console.log(`\ndefaultRates: tobi=${dr.tobiRate}, doko=${dr.dokoRate}, ratio=${dokoRatio.toFixed(4)}`);
console.log(`tobiBase = ${dr.tobiRate} * 0.85 = ${Math.round(dr.tobiRate * 0.85)}`);

// Count workers per site for Feb
let totalTobi = 0, totalDoko = 0, totalOtEq = 0;
for (const site of main.sites) {
  if (site.id === 'yaesu_night') continue;
  const sid = site.id;
  const massignKey = `${sid}_202602`;
  const massign = main.massign[massignKey];
  const assign = main.assign[sid];
  const wids = massign?.workers || assign?.workers || [];
  
  let siteTobi = 0, siteDoko = 0, siteOtEq = 0;
  for (const wid of wids) {
    const w = main.workers.find(x => x.id === wid);
    if (!w || w.retired) continue;
    for (let d = 1; d <= 28; d++) {
      const key = `${sid}_${wid}_202602_${d}`;
      const val = D[key];
      if (!val) continue;
      const wv = parseFloat(val.w) || 0;
      const isComp = wv === 0.6 && w.visa !== 'none';
      if (isComp) continue; // 0.6 doesn't count as man-day
      if (val.p) continue; // PL doesn't count
      if (wv > 0) {
        if (w.job === 'doko') siteDoko += wv;
        else siteTobi += wv;
      }
      // OT equiv
      const ot = parseFloat(val.o) || 0;
      if (ot > 0) {
        const otBase = w.visa !== 'none' ? 6.667 : 8;
        siteOtEq += ot / otBase;
      }
    }
  }
  console.log(`\n${site.name}: tobi=${siteTobi}, doko=${siteDoko}, otEq=${siteOtEq.toFixed(2)}`);
  totalTobi += siteTobi;
  totalDoko += siteDoko;
  totalOtEq += siteOtEq;
}

const tobiEquiv = totalTobi + totalDoko * dokoRatio + totalOtEq;
console.log(`\n=== TOBI EQUIV ===`);
console.log(`tobi=${totalTobi}, doko=${totalDoko}, dokoRatio=${dokoRatio.toFixed(4)}, otEq=${totalOtEq.toFixed(2)}`);
console.log(`tobiEquiv = ${totalTobi} + ${totalDoko} * ${dokoRatio.toFixed(4)} + ${totalOtEq.toFixed(2)} = ${tobiEquiv.toFixed(2)}`);
console.log(`\n人工あたり売上 = ¥${totalFebBill} / ${tobiEquiv.toFixed(2)} = ¥${Math.round(totalFebBill / tobiEquiv)}`);

process.exit(0);
