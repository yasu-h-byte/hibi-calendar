/**
 * 現場の請求額（demmen/main.billing[`${siteId}_${ym}`]）を請求書から書く共通の口（2026-10-20）。
 * - 山岡への請求書の発行（lib/prime-invoice-store.ts）と、応援の紙の控えの登録（app/api/paper-invoice）が使う
 * - app/api/cost の手入力と同じ形（ドット記法でそのキーだけ・配列・操作ログ billing.update）
 * 原価・収益と経営コックピット（sites[].billing × 1.1 を入金予定に使う）が、請求書と同じ額になる。
 */
import { db } from './firebase'
import { doc, getDoc, updateDoc } from '@/lib/fsdb'
import { logActivity } from './activity'

const jpYmOf = (ym: string) => `${ym.slice(0, 4)}年${parseInt(ym.slice(4, 6), 10)}月分`

export async function writeSiteBilling(args: { siteId: string; siteName: string; ym: string; amounts: number[]; actor: string; why: string }): Promise<void> {
  const { siteId, siteName, ym, actor, why } = args
  if (!/^[A-Za-z0-9_-]+$/.test(siteId) || !/^\d{6}$/.test(ym)) return
  const key = `${siteId}_${ym}`
  const docRef = doc(db, 'demmen', 'main')
  const snap = await getDoc(docRef)
  if (!snap.exists()) return
  const data = snap.data() as { billing?: Record<string, number[] | number> }
  const prevRaw = data.billing?.[key]
  const prev = (Array.isArray(prevRaw) ? prevRaw : typeof prevRaw === 'number' ? [prevRaw] : []).filter(v => v !== 0)
  const arr = args.amounts.map(v => Math.round(v)).filter(v => v !== 0)
  const sum = (xs: number[]) => xs.reduce((s, v) => s + v, 0)
  if (sum(prev) === sum(arr) && prev.length === arr.length && prev.every((v, i) => v === arr[i])) return
  await updateDoc(docRef, { [`billing.${key}`]: arr.length > 0 ? arr : [0] })
  await logActivity(actor, 'billing.update',
    `${siteName} ${jpYmOf(ym)}の請求額: ${prev.length ? prev.map(v => v.toLocaleString()).join('+') : '未入力'} → ${arr.length ? arr.map(v => v.toLocaleString()).join('+') : '未入力'}（税抜 ${sum(arr).toLocaleString()}円・${why}）`)
}
