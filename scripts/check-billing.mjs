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
const billing = data.billing || {};

// Show all billing entries
console.log('=== All billing entries ===');
const keys = Object.keys(billing).sort();
for (const k of keys) {
  const val = billing[k];
  console.log(`${k}: ${JSON.stringify(val)} (type: ${typeof val}, isArray: ${Array.isArray(val)})`);
}

// Calculate total billing for 202603 (March 2026)
console.log('\n=== March 2026 billing ===');
const sites = ['sasazuka', 'ihi', 'yaesu', 'yaesu_night'];
let total = 0;
for (const s of sites) {
  const key = `${s}_202603`;
  const val = billing[key];
  if (val) {
    const sum = Array.isArray(val) ? val.reduce((a, b) => a + b, 0) : (typeof val === 'number' ? val : 0);
    console.log(`${key}: ${JSON.stringify(val)} → sum=${sum}`);
    total += sum;
  }
}
console.log(`Total: ${total}`);

// Check defaultRates
const dr = data.defaultRates || {};
console.log('\n=== defaultRates ===');
console.log(JSON.stringify(dr));
console.log(`tobiBase = ${dr.tobiRate} * 0.85 = ${Math.round(dr.tobiRate * 0.85)}`);

process.exit(0);
