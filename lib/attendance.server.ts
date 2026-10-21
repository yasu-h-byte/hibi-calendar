/**
 * 出面・承認・担当現場の Firestore 読み書き（**サーバー専用**・2026-10-21 総点検で lib/attendance.ts から移した）
 *
 * lib/attendance.ts は出面の解釈（isWorkingDay・getEntryStatus・多現場の重複検出・残骸フィールドの算出など）
 * 純粋な関数だけになり、画面（出面グリッド・スマホ出面）から安全に import できる。
 * 以前は同じファイルに setAttendanceEntry 等があったため、/attendance と /attendance/mobile のクライアント JS に
 * Firebase Web SDK（約100KB）が載っていた。
 *
 * 書き込みの安全ルール（CLAUDE.md「Firestore 書き込みの安全ルール」）はそのまま: 子値に {} を渡さない・
 * ensureDocExists → updateDoc(dot-notation) で残骸を消す。
 */
import 'server-only'
import { db } from './firebase'
import { invalidateApprovalCache } from './approval-gap'
import { doc, getDoc, setDoc, updateDoc, deleteField, collection, getDocs, query, where } from '@/lib/fsdb'
import { AttendanceEntry, AttendanceApproval, Site, withDerivedOvertime } from '@/types'
import { ensureDocExists } from './firestore-safe'
import { currentYmJst } from '@/lib/date-utils'
import { attKey, computeAttendanceDeleteFields, paidLeaveChanged } from './attendance'
import { getMainData } from './compute.server'

/**
 * カレンダー上の「出勤予定日」かを判定（2026-06-12 監査 Sprint2-B で共通化）。
 *
 * 有給は稼働日のみ申請可（2026-06 社労士対応）。月給制では20日枠超の有給を
 * 有給日給として別途支給するため、非稼働日への有給は過払いになる。
 * カレンダー未確定の月は dayType 未取得 → 日曜以外は出勤扱い（正当な申請を誤って弾かない）。
 *
 * @param siteId  現場ID
 * @param dateIso 'YYYY-MM-DD'
 */
export async function isScheduledWorkDay(siteId: string, dateIso: string): Promise<boolean> {
  const [y, m, d] = dateIso.split('-').map(Number)
  if (!y || !m || !d) return false
  // 2026-09-15: 工種サイトは親現場のカレンダーで判定する
  {
    const { getMainData } = await import('./compute.server')
    const { calendarSiteIdOf } = await import('./site-hierarchy')
    siteId = calendarSiteIdOf((await getMainData()).sites, siteId)
  }
  const ymDash = dateIso.slice(0, 7)
  const calSnap = await getDocs(query(
    collection(db, 'siteCalendar'),
    where('ym', '==', ymDash),
    where('siteId', '==', siteId),
  ))
  let days: Record<string, string> | undefined
  calSnap.forEach(s => { days = (s.data().days as Record<string, string> | undefined) ?? days })
  // 欠けた日の扱いは法令チェック・画面・所定日数と同じ resolveDayType（日曜は休み・ほかは出勤。2026-10-02 総合点検で一本化）
  const { resolveDayType } = await import('./calendar')
  return resolveDayType(days, y, m, d) === 'work'
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

/**
 * その日の**全現場キー**から有給(p)を外す（2026-09-02 共通化・有給総点検 第4回）。
 *
 * 承認後に職長が「現場違い修正」で別現場へ移していると、「申請時の siteId」だけを
 * 狙った削除は空振りして p が残る（残数が戻らず、給与では有給2日扱い）。
 * revoke は 2026-08-27 に全現場走査へ直したが modify_date が取り残されていたため、
 * 両者からこのヘルパーを呼ぶ形に統一した。
 *
 * @returns p を外したキー（0件なら対象日に p が無かった）
 */
export async function removePaidLeaveForDay(workerId: number, dateIso: string): Promise<string[]> {
  const ym = dateIso.slice(0, 4) + dateIso.slice(5, 7)
  const day = String(parseInt(dateIso.slice(8, 10), 10))
  const ref = doc(db, 'demmen', `att_${ym}`)
  const snap = await getDoc(ref)
  if (!snap.exists()) return []
  const d = (snap.data().d || {}) as Record<string, AttendanceEntry>
  const suffix = `_${workerId}_${ym}_${day}`
  const updates: Record<string, unknown> = {}
  const removed: string[] = []
  for (const [k, e] of Object.entries(d)) {
    if (k.endsWith(suffix) && e?.p) {
      updates[`d.${k}.p`] = deleteField()
      removed.push(k)
    }
  }
  if (removed.length > 0) {
    await updateDoc(ref, updates)
    try {
      const { recomputeNextCarryOver } = await import('./leave-carry')
      await recomputeNextCarryOver(workerId, dateIso)
    } catch (e) {
      console.warn('[removePaidLeaveForDay] 繰越再計算に失敗（p の削除は完了）:', e)
    }
  }
  return removed
}

export async function setAttendanceEntry(
  siteId: string,
  workerId: number,
  ym: string,
  day: number,
  entry: AttendanceEntry,
  options: {
    deleteFields?: string[]
    /**
     * 保存前のエントリ（呼び出し元が既に持っているときだけ渡す）。
     * 渡すと、有給の有無が変わったときだけ次期繰越を再計算する（paidLeaveChanged）。
     * 渡さない（undefined）ときは従来どおり「p を書いた／消すかもしれない」なら再計算する。
     * null は「保存前にエントリが無かった」の意味。
     */
    prevEntry?: AttendanceEntry | null
  } = {}
): Promise<void> {
  // 確定済み月の短期キャッシュ（ダッシュボード用）を同一インスタンス内で無効化
  try { (await import('./compute.server')).invalidateAttDataCache(ym) } catch { /* ignore */ }
  // 時刻のある日は o（残業h）を現場の休憩設定で付け直す（2026-10-02・calcOvertimeHours が唯一の決まり）。
  //   旧: 職長画面は o を保存せず、PC・職長スマホは標準の休憩で数えていたため、入れた画面で残業が変わり、
  //   o を読む請求書（HFU → 日比建設・応援）や月次集計に職長が入れた日の残業が乗らなかった。
  if (entry.st && entry.et) {
    let ws: Site['workSchedule']
    try {
      const { getMainData } = await import('./compute.server')
      ws = (await getMainData()).sites.find(s => s.id === siteId)?.workSchedule as Site['workSchedule']
    } catch { /* 読めなければ標準の休憩で数える */ }
    entry = withDerivedOvertime(entry, ws)
    if (entry.o === undefined) {
      // 残業が無くなった日は、前の o を消す（merge 書き込みだと残骸が残る）
      options = { ...options, deleteFields: [...new Set([...(options.deleteFields || []), 'o'])] }
    } else if (options.deleteFields?.includes('o')) {
      options = { ...options, deleteFields: options.deleteFields.filter(f => f !== 'o') }
    }
  }
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

  // ── 次期レコードの繰越を追随再計算（2026-09-02・lib/leave-carry.ts）──
  //   有給(p)を書いた／消した日が属する付与期の「次の付与レコード」の繰越を計算し直す。
  //   半自動付与が付与日の30日前に作った繰越や、承認済み未来有給の変更に追随させる。
  //   ⚠️ 2026-10-02 まで閉じ括弧のずれでこの処理が else（deleteFields なし）の中にあり、
  //   deleteFields を渡す呼び出し元（grid/staff/foreman/leave-request/leave）では走っていなかった。
  //   deleteFields には有給以外の保存でも 'p' が入るため、重い読み取り（最大13か月分の出面）は
  //   recomputeNextCarryOver 側の事前チェック（キャッシュ済み main で「書き換える次期が無い」を判定）で省く。
  //   2026-10-02: 通常の保存は computeAttendanceDeleteFields が無い項目をすべて deleteFields に
  //   並べるため、ほぼ毎回 'p' が入り、次期レコードがある人は打刻のたびに重い再計算が走っていた。
  //   呼び出し元が保存前のエントリ（prevEntry）を渡したときは、有給の有無が変わったときだけ走らせる。
  const mayTouchPaidLeave = options.prevEntry !== undefined
    ? paidLeaveChanged(options.prevEntry, entry)
    : ((entry.p ?? 0) > 0 || !!options.deleteFields?.includes('p'))
  if (mayTouchPaidLeave) {
    try {
      const { recomputeNextCarryOver } = await import('./leave-carry')
      await recomputeNextCarryOver(workerId, `${ym.slice(0, 4)}-${ym.slice(4, 6)}-${String(day).padStart(2, '0')}`)
    } catch (e) {
      console.warn('[setAttendanceEntry] 繰越再計算に失敗（出面の保存は完了）:', e)
    }
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
  invalidateApprovalCache(docId)   // 承認の判定キャッシュ（lib/approval-gap.ts）を消す・2026-10-02
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
  invalidateApprovalCache(docId)   // 承認の判定キャッシュ（lib/approval-gap.ts）を消す・2026-10-02
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
  invalidateApprovalCache(docId)   // 承認の判定キャッシュ（lib/approval-gap.ts）を消す・2026-10-02
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
  invalidateApprovalCache(docId)   // 承認の判定キャッシュ（lib/approval-gap.ts）を消す・2026-10-02
  await ensureDocExists(docRef)
  await updateDoc(docRef, {
    final: deleteField(),
  })
}

// ────────────────────────────────────────
//  スタッフの現場一覧取得（assign + massign対応）
// ────────────────────────────────────────

export async function getStaffSites(workerId: number, ymOverride?: string): Promise<{ id: string; name: string }[]> {
  // 人員マスタは getMainData（30 秒キャッシュ・2026-10-21 総点検。旧: 毎回 demmen/main を読み直し）
  const main = await getMainData()

  // 2026-09-02: 対象月（申請日の月）を渡せるようにした。旧は常に「今月」の配置で
  //   現場を決めていたため、来月から別現場へ移る人の来月分の有給が旧現場に書かれ、
  //   新現場の出面グリッド・職長画面に出ない（残数・給与には効く）状態になっていた
  // 2026-10-02 総合点検: 配置の決まりを getAssign（過去12か月の月別配置をさかのぼる）に寄せる（lib/roster.ts）。
  //   旧は `massign[その月] ?? assign` で、PC の出面画面・給与計算・職長の名簿と食い違っていた
  const ym = ymOverride ? ymOverride.replace('-', '') : currentYmJst()
  const { sitesOfWorkerForMonth } = await import('./roster')
  return sitesOfWorkerForMonth(main, workerId, ym)
}

// ────────────────────────────────────────
//  職長の担当現場取得
// ────────────────────────────────────────

/**
 * 職長のトークン画面が扱う現場。**見ている月**の職長で決める（2026-10-02 総合点検）。
 *
 * 旧: 常に今月の月別職長（mforeman）で判定し、最初に一致した1現場を返していた。
 *   10/1 に IHI の職長が交代すると、新職長はトークン画面で9月分を承認・修正でき、旧職長はできなかった。
 *   マイページ（lib/foreman-todo.ts foremanParentSites・月ごと）と結果が食い違い、2現場を持つ職長は1現場しか扱えなかった。
 * 新: 判定は lib/auth.ts foremenOfSiteForMonth（月別職長 → 現場の職長。承認の権限判定と同じ1か所）。
 *   `preferSiteId` を渡すとその現場（担当なら）を返す。返すのは main.sites の現場そのもの（noDriveAllowance・siteType などを含む）。
 *
 * @param ym 見ている月 'YYYYMM'（省略＝今月）
 * @returns 担当の親現場（工種サイトは親にまとめる）と、その月に担当する親現場の一覧
 */
export async function getForemanSite(
  foremanId: number, ym?: string, preferSiteId?: string | null,
): Promise<(Site & { foremanSites: { id: string; name: string }[] }) | null> {
  const data = await getMainData()
  const sites = data.sites as unknown as (Site & { parentId?: string })[]
  const mforeman = data.mforeman as Record<string, { foreman?: number; wid?: number }>
  const ymKey6 = (ym || currentYmJst()).replace('-', '')
  const { foremenOfSiteForMonth } = await import('./foremen')
  const mine = sites.filter(s => !s.archived && !s.parentId && foremenOfSiteForMonth(s, mforeman, ymKey6).includes(foremanId))
  if (mine.length === 0) return null
  const chosen = (preferSiteId && mine.find(s => s.id === preferSiteId)) || mine[0]
  return { ...chosen, foremanSites: mine.map(s => ({ id: s.id, name: s.name })) }
}

// ────────────────────────────────────────
//  現場のスタッフ一覧（外国人のみ）
// ────────────────────────────────────────

export async function getForeignWorkersForSite(
  siteId: string,
  /** 対象月 'YYYYMM'（省略=今月）。前月の承認では前月の配置で数える（2026-10-01） */
  ymOverride?: string,
): Promise<{ id: number; name: string; nameVi?: string; visa: string }[]> {
  const data = await getMainData()
  const workers = data.workers as unknown as Record<string, unknown>[]
  const ym = ymOverride ? ymOverride.replace('-', '') : currentYmJst()
  // 2026-10-02 総合点検: 配置は getAssign（過去12か月の月別配置をさかのぼる）に寄せる（lib/roster.ts）。
  //   旧は `massign[その月] ?? assign` で、職長の名簿（lib/foreman-todo.ts）と食い違っていた
  const { workerIdsOfSiteForMonth } = await import('./roster')
  const workerIds = new Set(workerIdsOfSiteForMonth(data, siteId, ym))

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
