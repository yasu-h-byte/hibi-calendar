import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs, doc, deleteDoc } from 'firebase/firestore';

const app = initializeApp({
  apiKey: "AIzaSyAcA_kFC8hAqfmS_-_tOxI5oyjH06WNOwM",
  authDomain: "dedura-kanri.firebaseapp.com",
  projectId: "dedura-kanri",
  storageBucket: "dedura-kanri.firebasestorage.app",
  messagingSenderId: "372352470111",
  appId: "1:372352470111:web:136292eb630abddde3dfea"
});
const db = getFirestore(app);

// 1. siteCalendar（カレンダー休日設定のテスト）を削除
console.log('Deleting siteCalendar docs...');
const scSnap = await getDocs(collection(db, 'siteCalendar'));
for (const d of scSnap.docs) {
  await deleteDoc(d.ref);
  console.log('  Deleted:', d.id);
}

// 2. calendarSign（カレンダー署名のテスト）を削除
console.log('Deleting calendarSign docs...');
const csSnap = await getDocs(collection(db, 'calendarSign'));
for (const d of csSnap.docs) {
  await deleteDoc(d.ref);
  console.log('  Deleted:', d.id);
}

// 3. attendanceApprovals（職長承認のテスト）を削除
console.log('Deleting attendanceApprovals docs...');
const aaSnap = await getDocs(collection(db, 'attendanceApprovals'));
for (const d of aaSnap.docs) {
  await deleteDoc(d.ref);
  console.log('  Deleted:', d.id);
}

// att_202603 の出勤データには触らない
console.log('\n※ att_202603 の出勤データはそのまま残しています');
console.log('Done!');
process.exit(0);
