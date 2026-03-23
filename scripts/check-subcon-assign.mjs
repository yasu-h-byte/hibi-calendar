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

// Check what subcons are in assign vs massign for each site
console.log('=== assign.sasazuka.subcons ===');
console.log(main.assign.sasazuka?.subcons);
console.log('\n=== massign sasazuka_202603.subcons ===');
console.log(main.massign['sasazuka_202603']?.subcons);

console.log('\n=== assign.ihi.subcons ===');
console.log(main.assign.ihi?.subcons);
console.log('\n=== massign ihi_202603.subcons ===');
console.log(main.massign['ihi_202603']?.subcons);

// Check what subcon IDs exist in actual sd data
const att = await getDoc(doc(db, 'demmen', 'att_202603'));
const sd = att.data().sd || {};
const sdKeys = Object.keys(sd);

console.log('\n=== Unique subcon IDs in sd data (sasazuka) ===');
const sasaSubs = [...new Set(sdKeys.filter(k => k.startsWith('sasazuka_')).map(k => k.split('_')[1]))];
console.log(sasaSubs);

console.log('\n=== Unique subcon IDs in sd data (ihi) ===');
const ihiSubs = [...new Set(sdKeys.filter(k => k.startsWith('ihi_')).map(k => k.split('_')[1]))];
console.log(ihiSubs);

// Check武優 (buyu) specifically - it's in assign but is it in sd?
console.log('\n=== buyu entries in sd ===');
const buyuKeys = sdKeys.filter(k => k.includes('buyu'));
console.log(buyuKeys.length > 0 ? buyuKeys.slice(0, 5) : 'None');

process.exit(0);
