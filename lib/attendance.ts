import { db } from './firebase'
import { doc, getDoc, setDoc, updateDoc, deleteField } from 'firebase/firestore'
import { AttendanceEntry, AttendanceStatus, AttendanceApproval, Site } from '@/types'
import { ensureDocExists } from './firestore-safe'

// ────────────────────────────────────────
//  日付ヘルパー
// ────────────────────────────────────────

const DOW_HIRAGANA = ['にちようび', 'げつようび', 'かようび', 'すいようび', 'もくようび', 'きんようび', 'どようび']
const DOW_KANJI = ['日曜日', '月曜日', '火曜日', '水曜日', '木曜日', '金曜日', '土曜日']
const DOW_SHORT = ['日', '月', '火', '水', '木', '金', '土']

export function ymKey(y: number, m: number): string {
  return `${y}${String(m).padStart(2, '0')}`
}

// 漢字 + 短い曜日（スタッフ用）
export function formatDateJP(date: Date): string {
  const m = date.getMonth() + 1
  const d = date.getDate()
  const dow = DOW_SHORT[date.getDay()]
  return `${m}月${d}日（${dow}）`
}

// 漢字表記（職長・管理者用）
export function formatDateKanji(date: Date): string {
  const m = date.getMonth() + 1
  const d = date.getDate()
  const dow = DOW_KANJI[date.getDay()]
  return `${m}月${d}日（${dow}）`
}

export function formatDateShort(date: Date): string {
  const m = date.getMonth() + 1
  const d = date.getDate()
  const dow = DOW_SHORT[date.getDay()]
  return `${m}/${d}（${dow}）`
}

export function attKey(siteId: string, workerId: number, ym: string, day: number): string {
  return `${siteId}_${workerId}_${ym}_${String(day)}`
}

// ────────────────────────────────────────
//  ベトナム人スタッフの入力規律ヘルパー
// ────────────────────────────────────────

/**
 * 在留資格コードから「ベトナム人スタッフ（特定技能・技能実習）」かどうか判定。
 *
 * tokutei1 / tokutei2: 特定技能 1号 / 2号
 * jisshu  / jisshu2 / jisshu3: 技能実習 1号 / 2号 / 3号
 * none: 日本人など対象外
 */
export function isVietnameseWorker(visa: string | undefined | null): boolean {
  if (!visa) return false
  return visa.startsWith('tokutei') || visa.startsWith('jisshu')
}

/**
 * admin/foreman が当該日の出面エントリを「新規作成」または「修正」できるかチェック。
 *
 * ルール (2026-05-08 導入):
 *   - 日本人スタッフ等: 常に編集可能（従来通り）
 *   - ベトナム人スタッフ: 既にエントリが存在する場合のみ編集可能。
 *     「最初の入力はスタッフ本人のスマホから」という運用を強制する。
 *     なお、既存エントリのクリア（削除）は可能。
 *
 * @param worker - 対象ワーカー（visa フィールドを参照）
 * @param existingEntry - att_YYYYMM ドキュメントから取得した現在のエントリ
 * @returns editable=true なら編集可、false なら不可（reason に理由）
 */
export function canAdminEditEntry(
  worker: { visa?: string | null },
  existingEntry: AttendanceEntry | null | undefined,
): { editable: boolean; reason?: string } {
  if (!isVietnameseWorker(worker.visa)) {
    return { editable: true }
  }
  if (!existingEntry) {
    return { editable: false, reason: 'スタッフ本人のスマホ入力待ち' }
  }
  // 既存エントリがあれば修正・削除いずれも可能
  return { editable: true }
}

// ────────────────────────────────────────
//  出面ステータス判定
// ────────────────────────────────────────

/**
 * 出面エントリのステータス判定。
 * 優先順位: P(有給) > E(試験) > R(休み) > H(現場休み) > HK(帰国中) > 残業 > 出勤 > 未入力
 *
 * 注意: lib/compute.ts の月次集計では hk が r/h より先に continue するが、
 * UI 表示用のこの関数では「ユーザーが明示的に選んだステータス（r/h）」を優先表示する。
 * 給与・人工計算には影響しない（compute.ts 側のロジックが正）。
 */
export function getEntryStatus(entry: AttendanceEntry | null | undefined): AttendanceStatus {
  if (!entry) return 'none'
  if (entry.p && entry.p === 1) return 'leave'
  if (entry.exam && entry.exam === 1) return 'exam'
  if (entry.r && entry.r === 1) return 'rest'
  if (entry.h && entry.h === 1) return 'site_off'
  if (entry.hk && entry.hk === 1) return 'home_leave'
  if (entry.w === 1 && entry.o && entry.o > 0) return 'overtime'
  if (entry.w === 1) return 'work'
  return 'none'
}

export function getStatusLabel(status: AttendanceStatus): string {
  switch (status) {
    case 'work': return 'しゅっきん'
    case 'overtime': return 'しゅっきん'
    case 'rest': return 'やすみ'
    case 'leave': return 'ゆうきゅう'
    case 'site_off': return 'げんばやすみ'
    case 'home_leave': return 'きこくちゅう'
    case 'exam': return 'しけん'
    case 'none': return 'みにゅうりょく'
  }
}

export function getStatusEmoji(status: AttendanceStatus): string {
  switch (status) {
    case 'work': return '🔨'
    case 'overtime': return '🔨'
    case 'rest': return '🏠'
    case 'leave': return '🌴'
    case 'site_off': return '🚧'
    case 'home_leave': return '✈️'
    case 'exam': return '📝'
    case 'none': return '—'
  }
}

export function getStatusColor(status: AttendanceStatus): string {
  switch (status) {
    case 'work': return 'bg-blue-100 text-blue-700'
    case 'overtime': return 'bg-orange-100 text-orange-700'
    case 'rest': return 'bg-gray-100 text-gray-500'
    case 'leave': return 'bg-green-100 text-green-700'
    case 'site_off': return 'bg-yellow-100 text-yellow-700'
    case 'home_leave': return 'bg-cyan-100 text-cyan-700'
    case 'exam': return 'bg-purple-100 text-purple-700'
    case 'none': return 'bg-red-50 text-red-400'
  }
}

// ────────────────────────────────────────
//  Firestore読み書き: att_YYYYMM
// ────────────────────────────────────────

export async function getAttendanceDoc(ym: string): Promise<Record<string, AttendanceEntry>> {
  const docRef = doc(db, 'demmen', `att_${ym}`)
  const docSnap = await getDoc(docRef)
  if (!docSnap.exists()) return {}
  return (docSnap.data().d as Record<string, AttendanceEntry>) || {}
}

export async function setAttendanceEntry(
  siteId: string,
  workerId: number,
  ym: string,
  day: number,
  entry: AttendanceEntry,
  options: { deleteFields?: string[] } = {}
): Promise<void> {
  const key = attKey(siteId, workerId, ym, day)
  const docRef = doc(db, 'demmen', `att_${ym}`)
  if (options.deleteFields && options.deleteFields.length > 0) {
    // deleteField() は updateDoc + dot-notation でないと入れ子内のフィールドを確実に
    // 削除できない。updateDoc はドキュメント未存在だと失敗するため、先に空マージで
    // ドキュメント存在を保証する。
    //
    // ⚠️ ensureDocExists を使うこと（直接 setDoc で `{ d: {} }` を渡すと既存データを
    //   全消失させる罠がある — 詳細は lib/firestore-safe.ts のコメント参照）。
    await ensureDocExists(docRef)
    const updates: Record<string, unknown> = {}
    // 削除対象フィールドを deleteField で消す
    for (const f of options.deleteFields) {
      updates[`d.${key}.${f}`] = deleteField()
    }
    // 新しい値を書き込み（dot-notation で各フィールドごとに上書き）
    for (const [k, v] of Object.entries(entry)) {
      if (v !== undefined) {
        updates[`d.${key}.${k}`] = v
      }
    }
    await updateDoc(docRef, updates)
  } else {
    await setDoc(docRef, { d: { [key]: entry } }, { merge: true })
  }
}

// ────────────────────────────────────────
//  Firestore読み書き: attendanceApprovals
// ────────────────────────────────────────

export async function getApprovalForDay(
  siteId: string,
  ym: string,
  day: number
): Promise<AttendanceApproval | null> {
  const docId = `${siteId}_${ym}_${String(day)}`
  const docRef = doc(db, 'attendanceApprovals', docId)
  const docSnap = await getDoc(docRef)
  if (!docSnap.exists()) return null
  return docSnap.data() as AttendanceApproval
}

/**
 * 後方互換: 旧 setApprovalForDay = 職長承認を書き込む
 * 新コードは setForemanApprovalForDay を直接使うこと
 */
export async function setApprovalForDay(
  siteId: string,
  ym: string,
  day: number,
  foremanId: number
): Promise<void> {
  return setForemanApprovalForDay(siteId, ym, day, foremanId)
}

/**
 * 職長による1次承認を書き込む
 * - 子値 { by, at } は非空マップなので Firestore の罠は踏まない
 * - 既存の final フィールドは保持される（merge:true）
 */
export async function setForemanApprovalForDay(
  siteId: string,
  ym: string,
  day: number,
  foremanId: number
): Promise<void> {
  const docId = `${siteId}_${ym}_${String(day)}`
  const docRef = doc(db, 'attendanceApprovals', docId)
  await setDoc(docRef, {
    foreman: { by: foremanId, at: new Date().toISOString() }
  }, { merge: true })
}

/**
 * 職長承認を解除する
 * - foreman フィールドを deleteField で削除
 * - 同時に final フィールドも削除（職長承認なし→最終承認は意味を失うため）
 * - ドキュメント自体は他のフィールド保護のため残す（updateDoc）
 */
export async function removeForemanApprovalForDay(
  siteId: string,
  ym: string,
  day: number,
): Promise<void> {
  const docId = `${siteId}_${ym}_${String(day)}`
  const docRef = doc(db, 'attendanceApprovals', docId)
  // ドキュメント未存在時に updateDoc が失敗するのを防ぐため、まず存在保証
  await ensureDocExists(docRef)
  await updateDoc(docRef, {
    foreman: deleteField(),
    final: deleteField(),
  })
}

/**
 * 最終承認を書き込む（admin/approver 用）
 * - 呼び出し側で「職長承認済みかどうか」を必ずチェックすること
 *   （API の grid/route.ts で実装）
 */
export async function setFinalApprovalForDay(
  siteId: string,
  ym: string,
  day: number,
  approverId: number,
): Promise<void> {
  const docId = `${siteId}_${ym}_${String(day)}`
  const docRef = doc(db, 'attendanceApprovals', docId)
  await setDoc(docRef, {
    final: { by: approverId, at: new Date().toISOString() }
  }, { merge: true })
}

/**
 * 最終承認のみを解除する（職長承認は維持）
 */
export async function removeFinalApprovalForDay(
  siteId: string,
  ym: string,
  day: number,
): Promise<void> {
  const docId = `${siteId}_${ym}_${String(day)}`
  const docRef = doc(db, 'attendanceApprovals', docId)
  await ensureDocExists(docRef)
  await updateDoc(docRef, {
    final: deleteField(),
  })
}

// ────────────────────────────────────────
//  スタッフの現場一覧取得（assign + massign対応）
// ────────────────────────────────────────

export async function getStaffSites(workerId: number): Promise<{ id: string; name: string }[]> {
  const mainDoc = await getDoc(doc(db, 'demmen', 'main'))
  if (!mainDoc.exists()) return []

  const data = mainDoc.data()
  const sites = (data.sites || []) as { id: string; name: string; archived?: boolean }[]
  const assign = (data.assign || {}) as Record<string, { workers?: number[] }>
  const massign = (data.massign || {}) as Record<string, { workers?: number[] }>

  const now = new Date()
  const ym = ymKey(now.getFullYear(), now.getMonth() + 1)

  const result: { id: string; name: string }[] = []

  for (const site of sites) {
    if (site.archived) continue

    // Check monthly override first, then default assignment
    const monthKey = `${site.id}_${ym}`
    const monthAssign = massign[monthKey]
    const defaultAssign = assign[site.id]

    const workers = monthAssign?.workers || defaultAssign?.workers || []
    if (workers.includes(workerId)) {
      result.push({ id: site.id, name: site.name })
    }
  }

  return result
}

// ────────────────────────────────────────
//  職長の担当現場取得
// ────────────────────────────────────────

export async function getForemanSite(foremanId: number): Promise<Site | null> {
  const mainDoc = await getDoc(doc(db, 'demmen', 'main'))
  if (!mainDoc.exists()) return null

  const data = mainDoc.data()
  const sites = (data.sites || []) as Record<string, unknown>[]
  const mforeman = (data.mforeman || {}) as Record<string, { foreman?: number }>

  const now = new Date()
  const ym = ymKey(now.getFullYear(), now.getMonth() + 1)

  for (const s of sites) {
    if (s.archived) continue
    const siteId = s.id as string

    // Check monthly foreman override
    const monthKey = `${siteId}_${ym}`
    const monthForeman = mforeman[monthKey]?.foreman
    const defaultForeman = s.foreman as number

    if ((monthForeman || defaultForeman) === foremanId) {
      return {
        id: siteId,
        name: s.name as string,
        start: (s.start as string) || '',
        end: (s.end as string) || '',
        foreman: foremanId,
        archived: false,
      }
    }
  }
  return null
}

// ────────────────────────────────────────
//  現場のスタッフ一覧（外国人のみ）
// ────────────────────────────────────────

export async function getForeignWorkersForSite(
  siteId: string
): Promise<{ id: number; name: string; nameVi?: string; visa: string }[]> {
  const mainDoc = await getDoc(doc(db, 'demmen', 'main'))
  if (!mainDoc.exists()) return []

  const data = mainDoc.data()
  const workers = (data.workers || []) as Record<string, unknown>[]
  const assign = (data.assign || {}) as Record<string, { workers?: number[] }>
  const massign = (data.massign || {}) as Record<string, { workers?: number[] }>

  const now = new Date()
  const ym = ymKey(now.getFullYear(), now.getMonth() + 1)

  const monthKey = `${siteId}_${ym}`
  const monthAssign = massign[monthKey]
  const defaultAssign = assign[siteId]
  const workerIds = new Set(monthAssign?.workers || defaultAssign?.workers || [])

  return workers
    .filter(w => {
      const id = w.id as number
      const visa = w.visa as string
      return workerIds.has(id) && visa && visa !== 'none'
    })
    .map(w => ({
      id: w.id as number,
      name: w.name as string,
      nameVi: (w.nameVi as string) || undefined,
      visa: w.visa as string,
    }))
}
