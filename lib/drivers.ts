/**
 * 便ごとの運転者（運転手当の元データ）の保存。PC・スマホの出面画面（app/api/attendance/grid）と
 * 職長のスマホ画面（app/api/attendance/foreman）で同じ決まりを使う（2026-10-02 点検で共通化）。
 *
 * `drv.<siteId>_<ym>_<day>` へのドット記法更新なので、他の日・他の現場のキーには触れない（Firestore 安全ルール準拠）。
 * - 締め済み月は拒否（運転手当は給与の元データ・2026-08-27）
 * - 「運転手当なし」の現場には記録させない（消す操作は通す・2026-09-30）
 */
import { db } from './firebase'
import { doc, updateDoc, deleteField } from '@/lib/fsdb'
import { ensureDocExists } from './firestore-safe'
import { getMainData, getAttData } from './compute'
import { todayJstIso } from './date-utils'
import { driveFamilyIds, drvKeyOf, nonWorkingDriverIds, validateDriverDate } from './allowance'

/**
 * 2026-10-02 点検で追加:
 * - 月は 01〜12・日はその月の範囲（'202613' のような月で att_202613 のごみドキュメントを作らない）
 * - 誰かを記録するときは今日（日本時間）まで。未来の日は不可（消す操作は通す）
 * - 記録する人は、その日この現場（親＋工種）で働いた人だけ（出勤 w>0・0.6補償を除く、または夜勤。休み・有給などは不可）。
 *   職長のスマホ画面から自分や出ていない人を記録して運転手当が出てしまうのを防ぐ（計算側でも無視する＝下流の防御）
 * - キーは親（カレンダーの現場）の id にそろえる。工種サイトの id で残っていたその日のキーは同時に消す
 *   （PC で工種、職長スマホで親に保存され、同じ便が二重に払われる・職長に見えない問題の根治）
 */
export async function saveSiteDrivers(args: {
  ym: string; siteId: string; day: unknown; am: unknown; pm: unknown; actorLabel: string
}): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const { ym, siteId, day, am, pm, actorLabel } = args
  if (!ym || !siteId || !day) return { ok: false, status: 400, error: 'ym, siteId, day required' }
  const clean = (v: unknown) => Array.isArray(v) ? [...new Set(v.map(Number).filter(Number.isFinite))] : []
  const amIds = clean(am); const pmIds = clean(pm)
  const hasDrivers = amIds.length > 0 || pmIds.length > 0
  const dateErr = validateDriverDate(String(ym), day, todayJstIso(), hasDrivers)
  if (dateErr) return { ok: false, status: 400, error: dateErr }
  const dayNum = Number(day)
  {
    const { checkMonthLocked } = await import('./locks')
    const lockErr = await checkMonthLocked(String(ym))
    if (lockErr) return { ok: false, status: 409, error: `${lockErr}（運転記録は運転手当の元データのため、締め済み月は変更できません）` }
  }
  const main = await getMainData()
  const s = main.sites.find(x => x.id === siteId)
  if (!s) return { ok: false, status: 404, error: '現場が見つかりません' }
  const family = driveFamilyIds(main.sites, siteId)
  if (hasDrivers) {
    const p = s.parentId ? main.sites.find(x => x.id === s.parentId) : undefined
    if (s.noDriveAllowance || p?.noDriveAllowance) {
      return { ok: false, status: 409, error: 'この現場は運転手当なしに指定されています（現場マスタ → その他）' }
    }
    // その日の出面で、働いた人か確かめる（この保存では att を他に読まないので1回だけ）
    const att = await getAttData(String(ym))
    const bad = nonWorkingDriverIds(att.d, family, String(ym), dayNum, [...new Set([...amIds, ...pmIds])])
    if (bad.length > 0) {
      const names = bad.map(id => main.workers.find(w => w.id === id)?.name || `ID${id}`).join('、')
      return { ok: false, status: 400, error: `${dayNum}日にこの現場で出勤（または夜勤）していない人は運転者にできません: ${names}` }
    }
  }
  const key = `drv.${drvKeyOf(main.sites, siteId, String(ym), dayNum)}`
  // 工種サイトの id で残っている同じ日のキー（旧データ）は消す。画面は親＋工種をまとめて表示しているので、
  // 送られてきた am/pm がまとめた後の全体になっている
  const stale: Record<string, unknown> = {}
  for (const f of family.slice(1)) stale[`drv.${f}_${ym}_${dayNum}`] = deleteField()
  const attRef = doc(db, 'demmen', `att_${ym}`)
  await ensureDocExists(attRef)
  if (!hasDrivers) {
    await updateDoc(attRef, { [key]: deleteField(), ...stale })
  } else {
    await updateDoc(attRef, { [key]: { am: amIds, pm: pmIds }, ...stale })
  }
  const { logActivity } = await import('./activity')
  await logActivity('admin', 'attendance.drivers', `${siteId}/${ym}/${dayNum}日 運転者: 行き[${amIds.join(',')}] 帰り[${pmIds.join(',')}]（${actorLabel}）`)
  return { ok: true }
}
