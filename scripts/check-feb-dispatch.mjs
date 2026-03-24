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

const dr = main.defaultRates;
const dokoRatio = Math.round(dr.dokoRate * 0.85) / Math.round(dr.tobiRate * 0.85);

function parseDKey(k) {
  const p = k.split('_');
  return { sid: p.slice(0, p.length - 3).join('_'), wid: p[p.length - 3], ym: p[p.length - 2], day: p[p.length - 1] };
}

// Get dispatch list for sasazuka
const dispatch = main.assign?.sasazuka?.dispatch || [];
console.log('dispatch list:', dispatch);

let tobiWork = 0, dokoWork = 0, tobiOtEq = 0, dokoOtEq = 0;
let dispatchedWork = 0, dispatchedOtEq = 0;

for (const [k, v] of Object.entries(D)) {
  const pk = parseDKey(k);
  if (pk.ym !== '202602') continue;
  if (v.p || !v.w) continue;
  const w = main.workers.find(x => x.id === parseInt(pk.wid));
  if (!w) continue;
  const isComp = (v.w === 0.6 && w.visa !== 'none');
  if (isComp) continue;
  
  // Check dispatch
  if (dispatch.includes(w.id) && pk.sid === 'sasazuka') {
    dispatchedWork += v.w;
    const stdH = w.visa === 'none' ? 8 : (20/3);
    dispatchedOtEq += (v.o || 0) / stdH;
    continue; // Skip dispatched
  }
  
  const stdH = w.visa === 'none' ? 8 : (20/3);
  const oe = (v.o || 0) / stdH;
  if (w.job === 'doko') { dokoWork += v.w; dokoOtEq += oe; }
  else { tobiWork += v.w; tobiOtEq += oe; }
}

for (const [k, v] of Object.entries(SD)) {
  const pk = parseDKey(k);
  if (pk.ym !== '202602') continue;
  const sc = main.subcons.find(x => x.id === pk.wid);
  if (!sc) continue;
  const soe = v.on / 8;
  if (sc.type === '土工業者') { dokoWork += v.n; dokoOtEq += soe; }
  else { tobiWork += v.n; tobiOtEq += soe; }
}

const equiv = (tobiWork + tobiOtEq) + (dokoWork + dokoOtEq) * dokoRatio;

console.log(`\nWith dispatch exclusion:`);
console.log(`tobiWork=${tobiWork}, tobiOtEq=${tobiOtEq.toFixed(4)}`);
console.log(`dokoWork=${dokoWork}, dokoOtEq=${dokoOtEq.toFixed(4)}`);
console.log(`dispatched: work=${dispatchedWork}, otEq=${dispatchedOtEq.toFixed(4)}`);
console.log(`equiv = ${equiv.toFixed(4)}`);

const billing = 37418693;
console.log(`\n人工あたり売上 = ${billing} / ${equiv.toFixed(4)} = ¥${Math.round(billing / equiv)}`);
console.log(`旧アプリ表示: ¥31,346`);

process.exit(0);
