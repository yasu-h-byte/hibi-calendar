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
import { getMainData } from './compute'

export async function saveSiteDrivers(args: {
  ym: string; siteId: string; day: unknown; am: unknown; pm: unknown; actorLabel: string
}): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const { ym, siteId, day, am, pm, actorLabel } = args
  if (!ym || !siteId || !day) return { ok: false, status: 400, error: 'ym, siteId, day required' }
  const dayNum = Number(day)
  const dim = /^\d{6}$/.test(ym) ? new Date(Number(ym.slice(0, 4)), Number(ym.slice(4, 6)), 0).getDate() : 0
  if (!Number.isInteger(dayNum) || dayNum < 1 || dayNum > dim) {
    return { ok: false, status: 400, error: '日付が正しくありません' }
  }
  {
    const { checkMonthLocked } = await import('./locks')
    const lockErr = await checkMonthLocked(String(ym))
    if (lockErr) return { ok: false, status: 409, error: `${lockErr}（運転記録は運転手当の元データのため、締め済み月は変更できません）` }
  }
  const clean = (v: unknown) => Array.isArray(v) ? [...new Set(v.map(Number).filter(Number.isFinite))] : []
  const amIds = clean(am); const pmIds = clean(pm)
  if (amIds.length > 0 || pmIds.length > 0) {
    const main = await getMainData()
    const s = main.sites.find(x => x.id === siteId)
    const p = s?.parentId ? main.sites.find(x => x.id === s.parentId) : undefined
    if (s?.noDriveAllowance || p?.noDriveAllowance) {
      return { ok: false, status: 409, error: 'この現場は運転手当なしに指定されています（現場マスタ → その他）' }
    }
  }
  const key = `drv.${siteId}_${ym}_${dayNum}`
  const attRef = doc(db, 'demmen', `att_${ym}`)
  await ensureDocExists(attRef)
  if (amIds.length === 0 && pmIds.length === 0) {
    await updateDoc(attRef, { [key]: deleteField() })
  } else {
    await updateDoc(attRef, { [key]: { am: amIds, pm: pmIds } })
  }
  const { logActivity } = await import('./activity')
  await logActivity('admin', 'attendance.drivers', `${siteId}/${ym}/${dayNum}日 運転者: 行き[${amIds.join(',')}] 帰り[${pmIds.join(',')}]（${actorLabel}）`)
  return { ok: true }
}
