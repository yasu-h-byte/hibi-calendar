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
const attSnap = await getDoc(doc(db, 'demmen', 'att_202602'));
const D = attSnap.data().d || {};
const SD = attSnap.data().sd || {};

function parseDKey(k) {
  const p = k.split('_');
  return { sid: p.slice(0, p.length - 3).join('_'), wid: p[p.length - 3], ym: p[p.length - 2], day: p[p.length - 1] };
}

// Get site rates
function getSiteRates(siteId) {
  const s = main.sites.find(x => x.id === siteId);
  const defTobi = main.defaultRates.tobiRate || 38000;
  const defDoko = main.defaultRates.dokoRate || 30000;
  if (!s || !s.rates || s.rates.length === 0) {
    const tb = Math.round(defTobi * 0.85);
    return { tobiBase: tb, dokoRatio: Math.round(defDoko * 0.85) / tb };
  }
  const r = s.rates[s.rates.length - 1];
  const tb = Math.round(r.tobiRate * 0.85);
  return { tobiBase: tb, dokoRatio: Math.round(r.dokoRate * 0.85) / tb };
}

// dispatch
const dispatch = main.assign?.sasazuka?.dispatch || [];

// Per-site tobiEquiv for February
for (const siteId of ['sasazuka', 'ihi']) {
  const rates = getSiteRates(siteId);
  let tobiWork = 0, dokoWork = 0, tobiOtEq = 0, dokoOtEq = 0;
  
  // Workers
  for (const [k, v] of Object.entries(D)) {
    const pk = parseDKey(k);
    if (pk.ym !== '202602' || pk.sid !== siteId) continue;
    if (v.p || !v.w) continue;
    const w = main.workers.find(x => x.id === parseInt(pk.wid));
    if (!w) continue;
    if (dispatch.includes(w.id) && siteId === 'sasazuka') continue;
    const isComp = (v.w === 0.6 && w.visa !== 'none');
    if (isComp) continue;
    const stdH = w.visa === 'none' ? 8 : (20/3);
    const oe = (v.o || 0) / stdH;
    if (w.job === 'doko') { dokoWork += v.w; dokoOtEq += oe; }
    else { tobiWork += v.w; tobiOtEq += oe; }
  }
  
  // Subcons
  for (const [k, v] of Object.entries(SD)) {
    const pk = parseDKey(k);
    if (pk.ym !== '202602' || pk.sid !== siteId) continue;
    const sc = main.subcons.find(x => x.id === pk.wid);
    if (!sc) continue;
    const soe = v.on / 8;
    if (sc.type === '土工業者') { dokoWork += v.n; dokoOtEq += soe; }
    else { tobiWork += v.n; tobiOtEq += soe; }
  }
  
  const equiv = (tobiWork + tobiOtEq) + (dokoWork + dokoOtEq) * rates.dokoRatio;
  
  // Get billing
  const billingKey = `${siteId}_202602`;
  const billingArr = main.billing[billingKey] || [];
  const billing = billingArr.reduce((s, v) => s + v, 0);
  const perW = equiv > 0 ? Math.round(billing / equiv) : 0;
  
  console.log(`\n=== ${siteId} (Feb 2026) ===`);
  console.log(`tobiWork=${tobiWork}, dokoWork=${dokoWork}`);
  console.log(`tobiOtEq=${tobiOtEq.toFixed(4)}, dokoOtEq=${dokoOtEq.toFixed(4)}`);
  console.log(`dokoRatio=${rates.dokoRatio.toFixed(6)}, tobiBase=${rates.tobiBase}`);
  console.log(`equiv = (${tobiWork}+${tobiOtEq.toFixed(2)}) + (${dokoWork}+${dokoOtEq.toFixed(2)})*${rates.dokoRatio.toFixed(4)} = ${equiv.toFixed(4)}`);
  console.log(`billing = ${billing}`);
  console.log(`perW = ${billing} / ${equiv.toFixed(4)} = ¥${perW}`);
  console.log(`旧アプリ: 笹塚=¥29,315 IHI=¥32,724`);
}

// Now check: what does old app use for tobiBase?
// Old app: TOBI_BASE = Math.round(DEF_TOBI_RATE * 0.85)
// New app: same but per-site
console.log('\n=== Rate comparison ===');
console.log(`defaultRates: tobi=${main.defaultRates.tobiRate}, doko=${main.defaultRates.dokoRate}`);
console.log(`sasazuka rates:`, main.sites.find(s => s.id === 'sasazuka')?.rates);
console.log(`ihi rates:`, main.sites.find(s => s.id === 'ihi')?.rates);

process.exit(0);
