/**
 * 診断スクリプト: setDoc(ref, { d: {} }, { merge: true }) が
 * 既存の d フィールドを空にしてしまうかを実機で検証する
 *
 * 使い方:
 *   node scripts/diagnose-merge-empty-map.mjs
 *
 * 影響範囲:
 *   demmen/att_TEST00 という TEST 用ドキュメントのみ操作。
 *   本番データ (att_YYYYMM) には一切触れない。最後に削除する。
 */
import { initializeApp } from 'firebase/app'
import { getFirestore, doc, setDoc, getDoc, deleteDoc } from 'firebase/firestore'

const firebaseConfig = {
  apiKey: "AIzaSyAcA_kFC8hAqfmS_-_tOxI5oyjH06WNOwM",
  authDomain: "dedura-kanri.firebaseapp.com",
  projectId: "dedura-kanri",
  storageBucket: "dedura-kanri.firebasestorage.app",
  messagingSenderId: "372352470111",
  appId: "1:372352470111:web:136292eb630abddde3dfea"
}

const app = initializeApp(firebaseConfig)
const db = getFirestore(app)

// Firestoreルールで att_[0-9]{6} のみ書き込み可能なため、
// 確実に実データと衝突しない年月にする (西暦9000年1月)
const TEST_DOC = 'att_900001'
const ref = doc(db, 'demmen', TEST_DOC)

const log = (...args) => console.log(...args)
const dump = (label, data) => log(`\n[${label}]`, JSON.stringify(data, null, 2))

async function run() {
  log('=== Firestore merge挙動 診断 ===')
  log('テストドキュメント: demmen/' + TEST_DOC)

  // クリーンスタート
  await deleteDoc(ref).catch(() => {})

  // ── ケース1: setDoc({d: {}}, {merge:true}) は既存の d を消すか？ ──
  log('\n--- ケース1: { d: {} } を merge:true で書き込み ---')

  // 初期状態を作る
  await setDoc(ref, {
    d: { 'site_5_202605_1': { w: 1, st: '08:00', et: '17:00' } },
    sd: { 'sub_a_202605_1': { n: 3, on: 0 } }
  })
  let snap = await getDoc(ref)
  dump('初期状態', snap.data())

  // 疑惑のパターンを実行
  await setDoc(ref, { d: {} }, { merge: true })
  snap = await getDoc(ref)
  dump('setDoc({d:{}}, {merge:true}) 実行後', snap.data())

  const dAfter = snap.data().d || {}
  const dKeysAfter = Object.keys(dAfter)
  if (dKeysAfter.length === 0) {
    log('🚨 結果: d が空に！ → 仮説確定: このパターンは d を消す')
  } else {
    log('✅ 結果: d は保持された (' + dKeysAfter.length + ' keys) → 仮説誤り')
  }

  // ── ケース2: setDoc({}, {merge:true}) は安全か？ ──
  log('\n--- ケース2: 空オブジェクト {} を merge:true で書き込み ---')

  await setDoc(ref, {
    d: { 'site_5_202605_1': { w: 1, st: '08:00', et: '17:00' } },
    sd: { 'sub_a_202605_1': { n: 3, on: 0 } }
  })
  snap = await getDoc(ref)
  dump('初期状態', snap.data())

  await setDoc(ref, {}, { merge: true })
  snap = await getDoc(ref)
  dump('setDoc({}, {merge:true}) 実行後', snap.data())

  const dAfter2 = snap.data().d || {}
  if (Object.keys(dAfter2).length === 0) {
    log('🚨 setDoc({}, {merge:true}) も d を消した')
  } else {
    log('✅ setDoc({}, {merge:true}) は安全（d 保持）')
  }

  // ── ケース3: 修正後パターンの実証 — setAttendanceEntry 相当の流れ ──
  log('\n--- ケース3: 修正後の setAttendanceEntry 相当の挙動 ---')

  await setDoc(ref, {
    d: {
      'ihi_5_202605_1': { w: 1, st: '08:00', et: '17:00' },
      'ihi_6_202605_1': { w: 1, st: '08:00', et: '17:00' },
      'ihi_7_202605_1': { w: 0, r: 1 },
    },
    sd: { 'sub_a_202605_1': { n: 3, on: 0 } }
  })
  snap = await getDoc(ref)
  dump('初期状態（3スタッフ分）', snap.data())

  // 修正後パターン: setDoc({}, {merge:true}) → updateDoc with dot-notation
  const { updateDoc, deleteField } = await import('firebase/firestore')
  await setDoc(ref, {}, { merge: true })  // ドキュメント存在保証
  await updateDoc(ref, {
    'd.ihi_5_202605_1.w': 0,
    'd.ihi_5_202605_1.r': 1,
    'd.ihi_5_202605_1.st': deleteField(),
    'd.ihi_5_202605_1.et': deleteField(),
  })
  snap = await getDoc(ref)
  dump('修正後パターン適用後', snap.data())

  const dCase3 = snap.data().d || {}
  const expectedKeys = ['ihi_5_202605_1', 'ihi_6_202605_1', 'ihi_7_202605_1']
  const allPresent = expectedKeys.every(k => dCase3[k])
  const targetUpdated = dCase3['ihi_5_202605_1']?.r === 1 && dCase3['ihi_5_202605_1']?.w === 0
  const targetTimeRemoved = !dCase3['ihi_5_202605_1']?.st && !dCase3['ihi_5_202605_1']?.et
  if (allPresent && targetUpdated && targetTimeRemoved) {
    log('✅ 修正後パターン: 他の2スタッフのデータ保持 + 対象スタッフのフィールド更新+削除 が正常')
  } else {
    log('🚨 修正後パターン: 期待通り動作していない')
    log('  allPresent:', allPresent, 'targetUpdated:', targetUpdated, 'targetTimeRemoved:', targetTimeRemoved)
  }

  // ── ケース4 (rules): デプロイ後、setDoc({d:{}},{merge:true}) が拒否されることを確認するテスト ──
  // ※ これは Firestore Rules を本番デプロイした後でないと確認できない。
  //    rules デプロイ前にこのスクリプトを実行すると、まだ通ってしまう（修正前の挙動）。
  log('\n--- ケース4: rules によるサーバーサイド拒否テスト（デプロイ後のみ意味がある） ---')

  await setDoc(ref, {
    d: { 'site_5_202605_1': { w: 1 } },
    sd: { 'sub_a_202605_1': { n: 3 } }
  })
  try {
    await setDoc(ref, { d: {} }, { merge: true })
    snap = await getDoc(ref)
    const dKeys = Object.keys(snap.data().d || {})
    if (dKeys.length === 0) {
      log('🚨 rules がまだ反映されていません（または無効）— d が空に消えました')
    } else {
      log('✅ rules が効いて d が保持されました (' + dKeys.length + ' keys)')
    }
  } catch (e) {
    if (e.code === 'permission-denied') {
      log('✅ rules がサーバーサイドで書き込みを拒否しました（期待通り）')
    } else {
      log('❓ 予期しないエラー:', e.message)
    }
  }

  // ── ケース5: 「正規の」書き込みパターンが他のキーを保持するか ──
  // setAttendanceEntry の else分岐 (line 148): setDoc({d:{[key]:entry}}, {merge:true})
  log('\n--- ケース4: setDoc({ d: { [key]: entry } }, { merge:true }) — 単一エントリ書き込み ---')

  await setDoc(ref, {
    d: {
      'ihi_5_202605_1': { w: 1, st: '08:00', et: '17:00' },
      'ihi_6_202605_1': { w: 1, st: '08:00', et: '17:00' },
    },
    sd: { 'sub_a_202605_1': { n: 3, on: 0 } }
  })
  snap = await getDoc(ref)
  dump('初期状態（2スタッフ）', snap.data())

  // ihi_7 の新規エントリを追加
  await setDoc(ref, { d: { 'ihi_7_202605_1': { w: 0, r: 1 } } }, { merge: true })
  snap = await getDoc(ref)
  dump('setDoc({d:{[新規key]:entry}}, {merge:true}) 実行後', snap.data())

  const dCase4 = snap.data().d || {}
  const keysCase4 = Object.keys(dCase4)
  if (keysCase4.length === 3 && dCase4['ihi_5_202605_1'] && dCase4['ihi_6_202605_1'] && dCase4['ihi_7_202605_1']) {
    log('✅ 単一エントリ書き込みは安全（既存2件 + 新規1件 = 3件保持）')
  } else {
    log('🚨 単一エントリ書き込みも他のキーを消している！')
    log('  保持されたキー:', keysCase4)
  }

  // 後片付け
  log('\n--- 後片付け ---')
  await deleteDoc(ref)
  log('demmen/' + TEST_DOC + ' を削除しました')

  process.exit(0)
}

run().catch(e => {
  console.error('エラー:', e)
  process.exit(1)
})
