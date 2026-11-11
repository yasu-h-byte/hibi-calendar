'use client'

/**
 * 賞与の点数表（docs/wage-system.md 第7節）。
 *
 * 表は `lib/jp-wage.ts` の bonusPoints から生成する。写して持つと配分と表がズレる。
 * 原資を入れると、いまの在籍者でいくらになるかを試算できる。
 * 2026-10-03: ブラウザ標準の confirm を共通部品（confirmDialog）に置き換え
 * 2026-10-03: モーダルの枠と保存ボタンを共通部品（Modal・SaveButton）にそろえた
 * 2026-10-07: 処遇固定の人は点数を1段下で数える・精勤賞与の日額は前の期の最後の日の日額・確定の取り消し
 * 2026-10-23: 特定技能のフウ・トゥアンを「利益分配だけ（2G相当）」で対象に加えた。対象者は API が決める（lib/bonus-members.server.ts）
 * 2026-11-11: 合計を読めるようにした（代表「81万6千円になる理由・合計が分かりづらい」）。原資 → 配分 → 自社／出向先 の道筋、
 *   合計行を 自社・出向先・全員 の3行に、出向の人は表の下へ、箱は「会社が払う合計と内訳」、精勤賞与が全員買取済なら列をたたむ、
 *   履歴に内訳、同じ支給日の確定済みがあれば確定の前に知らせる。数え方は lib/bonus-summary.ts
 */

import { useCallback, useEffect, useState } from 'react'
import { readAuth } from '@/lib/hooks/useAuthPassword'
import { fetchWithAuth } from '@/lib/api-client'
import { fmtYen as yen } from '@/lib/format'
import { confirmDialog, confirmDanger } from '@/lib/confirm-dialog'
import { notify } from '@/lib/notify'
import { SaveButton } from '@/components/ui/SaveButton'
import {
  bonusPoints, allocateBonus, GRADE_LABELS, GRADES_IN_ORDER,
  childAllowance, attendanceBonusDays, attendanceBonusAmount,
  NON_SMOKER_ALLOWANCE, FIXED_BONUS_STEP_DOWN,
  type JpGrade, type Hyogo, type BonusMember,
} from '@/lib/jp-wage'
import { summarizeBonus, sortBonusLines, sameDayBonuses } from '@/lib/bonus-summary'

interface BonusRecord {
  id: string; label: string; paidOn: string; pool: number
  totalPoints: number; unit: number; total: number; grandTotal?: number
  allocations: Array<{
    workerId: number; name: string; grade: string; hyogo: Hyogo; points: number; amount: number
    stepDown?: number; profitShareOnly?: boolean
    attendanceDays?: number; attendanceRate?: number; attendanceAmount?: number
    nonSmokerAmount?: number; childCount?: number; childAmount?: number
    totalAmount?: number; payMethod?: 'transfer' | 'cash'; paidBy?: string
  }>
}

/** 賞与の手当を計算するための各人の情報（API から） */
interface MemberInfo {
  workerId: number
  name: string
  grade: string
  /** 精勤賞与の日額 = 買い取る期の最後の日の日額（9/30 に終わった期なら 10/1 改定前の日額） */
  rate: number
  /** 処遇固定のため賞与の点数を何段下げて数えるか（API が決める） */
  stepDown?: number
  /** 利益分配だけの人（特定技能。②精勤賞与・③禁煙・④子ども手当は付けない。API が決める） */
  profitShareOnly?: boolean
  nonSmoker: boolean
  children: string[]
  dispatchTo: string
  /** 買い取る期（支給日の時点で終わっている直近の期）の残。終わった期が無い／期末買取が記録済みなら 0 */
  leaveRemaining: number
  /** 買い取る期の付与日 */
  leaveGrantDate: string
  /** 年5日に足りない分（買取から除く日数・2026-10-01 付与期から） */
  leaveFiveDayReserve?: number
  /** 買い取る期の最後の日（2026-10-02 総合点検。旧: 9/30 固定だった） */
  leavePeriodEnd?: string
  /** その期の期末買取が記録済み */
  leaveBuyoutRecorded?: boolean
}

/** 画面上で手修正できる項目（自動計算の結果を上書きする） */
interface Override {
  profit?: number        // 利益分配賞与
  days?: number          // 精勤賞与の買取日数
  payMethod?: 'transfer' | 'cash'
}

const HY: Hyogo[] = ['SS', 'S', 'A', 'B', 'C']
const RATIO = { SS: '5%', S: '15%', A: '60%', B: '15%', C: '5%' }

export default function BonusTable() {
  const [pw, setPw] = useState('')
  const [pool, setPool] = useState('1200000')
  const [label, setLabel] = useState('')
  const [paidOn, setPaidOn] = useState(() => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' }))
  const [members, setMembers] = useState<Array<BonusMember & { name: string }>>([])
  const [info, setInfo] = useState<Record<number, MemberInfo>>({})
  const [ov, setOv] = useState<Record<number, Override>>({})
  const [records, setRecords] = useState<BonusRecord[]>([])
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  /** ② 精勤賞与の列（全員が買取済のときはたたむ。出したいときに開く） */
  const [showAttendance, setShowAttendance] = useState(false)

  const load = useCallback(async (password: string, paidOnIso?: string) => {
    try {
      // 買い取る有給の期は支給日で決まる（支給日の時点で終わっている直近の期）ので支給日を渡す（2026-10-02 総合点検）
      const q = paidOnIso && /^\d{4}-\d{2}-\d{2}$/.test(paidOnIso) ? `?paidOn=${paidOnIso}` : ''
      const br = await fetchWithAuth(`/api/jp-wage/bonus${q}`, { password })
      // 評語は年次改定で決めたものを初期値にする（賞与と昇給で別の評価を付けない）
      const bj = br.ok ? await br.json() : { records: [], hyogo: {}, members: [] }
      setRecords(bj.records || [])
      const infoById: Record<number, MemberInfo> = Object.fromEntries(((bj.members || []) as MemberInfo[]).map(m => [m.workerId, m]))
      setInfo(infoById)
      // 対象者と等級は確定する API と同じ関数で決めたものを使う（2026-10-23。旧: 画面が人員マスタを自分で絞っていた）
      if (br.ok) {
        setMembers(((bj.members || []) as MemberInfo[])
          .filter(m => m.grade)
          .map(m => ({
            workerId: m.workerId, name: m.name,
            grade: m.grade as JpGrade,
            hyogo: (bj.hyogo?.[String(m.workerId)] as Hyogo) || 'A',
            // 処遇固定の人は点数を下げて数える（確定する API と同じ値を API から受け取る）
            stepDown: m.stepDown || 0,
          })))
      }
    } catch { /* 試算が出せなくても表は見られる */ }
  }, [])

  useEffect(() => {
    try {
      const raw = readAuth()
      const p = raw ? raw?.password : ''
      if (!p) return
      setPw(p); load(p, paidOn)
    } catch { /* noop */ }
  }, [load, paidOn])

  const poolNum = Number(pool) || 0
  const result = members.length ? allocateBonus(poolNum, members) : null

  /**
   * 支給明細（1人1行）。
   *   ① 利益分配 = 点数配分（代表が個別に上書き可）
   *   ② 精勤賞与 = 有給残 × 日額（日数は上書き可）
   *   ③ 禁煙手当 = 人員マスタのチェック
   *   ④ 子ども手当 = 子の誕生年月から自動
   * 出向者（dispatchTo あり）は出向先から支給されるため、自社の合計から分ける。
   */
  const lines = (result?.allocations || []).map((a, i) => {
    const m = members[i]
    const inf = info[a.workerId]
    const o = ov[a.workerId] || {}
    const rate = inf?.rate || 0
    // 2026-10-01 付与期からは「残日数 −（5 − 稼働日に取った有給）」が買取の上限（2026-10-08 有給精算とそろえた。
    //   旧: いつも残−5日）。5日取った人は全部買い取れる。それ以前の期は全額買取できる。
    const reserve = inf?.leaveFiveDayReserve || 0
    const capped = reserve > 0
    // 買い取る期は「支給日の時点で終わっている直近の期」（API が支給日で出す・2026-10-02 総合点検）。
    //   終わった期が無い（期の途中）・期末買取が記録済みなら leaveRemaining=0 で、自動では買い取らない。
    //   旧: 支給日が 10/1 以降かどうか（9/30 期末の固定）で決めていた
    const only = inf?.profitShareOnly === true
    const days = only ? 0 : o.days !== undefined
      ? o.days
      : attendanceBonusDays(inf?.leaveRemaining || 0, { reserveDays: reserve })
    const attendanceAmount = attendanceBonusAmount(days, rate)
    const nonSmokerAmount = inf?.nonSmoker ? NON_SMOKER_ALLOWANCE : 0
    const child = childAllowance(only ? [] : (inf?.children || []), paidOn)
    const profit = o.profit !== undefined ? o.profit : a.amount
    return {
      workerId: a.workerId, name: m.name, grade: a.grade, hyogo: a.hyogo, points: a.points,
      stepDown: a.stepDown || 0,
      profitShareOnly: only,
      amount: profit,
      attendanceDays: days, attendanceRate: rate, attendanceAmount,
      nonSmokerAmount,
      childCount: child.eligibleCount, childAmount: child.amount,
      totalAmount: profit + attendanceAmount + nonSmokerAmount + child.amount,
      payMethod: o.payMethod || 'transfer' as const,
      paidBy: inf?.dispatchTo || '',
      capped,
      idx: i,
    }
  })
  const own = lines.filter(l => !l.paidBy)   // 自社が支給する人
  const sum = (f: (l: typeof lines[number]) => number, list = own) => list.reduce((s, l) => s + f(l), 0)
  // 合計（自社・出向先・全員）。合計行・箱・原資とのつながりの表示が同じ数え方を使う（lib/bonus-summary.ts）
  const S = summarizeBonus(poolNum, lines)
  const profitEdited = lines.some(l => ov[l.workerId]?.profit !== undefined)
  // ② 精勤賞与: 買い取る残りがある人が1人もいなければ（記録済みか、残りが0日）、3列（残日数・日額・精勤賞与）をたたむ。
  //   日数を手で入れた人がいるときはたたまない（入れた数字を隠さない）
  const attendanceTargets = lines.filter(l => !l.profitShareOnly)
  const attendanceAllDone = attendanceTargets.length > 0
    && attendanceTargets.every(l => l.attendanceDays === 0 && ov[l.workerId]?.days === undefined
      && (info[l.workerId]?.leaveBuyoutRecorded === true || (info[l.workerId]?.leaveRemaining || 0) === 0))
  const hideAttendance = attendanceAllDone && !showAttendance
  const buyoutRecord = records.find(r => r.allocations.some(a => (a.attendanceAmount || 0) > 0))
  const buyoutSum = buyoutRecord ? summarizeBonus(buyoutRecord.pool, buyoutRecord.allocations) : null
  // 同じ支給日ですでに確定している賞与（二重に確定する前に知らせる）
  const sameDay = sameDayBonuses(records, paidOn)
  const setOverride = (id: number, patch: Override) =>
    setOv(prev => ({ ...prev, [id]: { ...prev[id], ...patch } }))

  /**
   * 確定して保存（SaveButton の約束: だめなら { ok: false, error } を返して赤の帯に出す）。
   * 確認の窓で「やめる」を選んだときは null（取りやめ。帯は出さず、ボタンはふだんの顔に戻る）。
   */
  const save = async () => {
    if (!result) return null
    if (sameDay.length > 0 && !(await confirmDanger({
      title: `支給日 ${paidOn} の賞与は、すでに確定されています`,
      description: `確定済み: ${sameDay.map(r => `「${r.label}」`).join('・')}\n`
        + `このまま進むと、もう1件として記録されます（利益分配・禁煙・子ども手当が二重に残ります）。\n`
        + `直したいだけなら「やめる」を押し、下の履歴でその確定を取り消してから確定してください。`,
      confirmLabel: 'もう1件として確定する',
    }))) return null
    if (!(await confirmDialog({
      title: `「${label}」として賞与の支給を確定しますか？`,
      description: `対象 ${lines.length}名（うち出向先支給 ${lines.length - own.length}名）\n`
        + `利益分配 ${yen(sum(l => l.amount))}\n`
        + `精勤賞与 ${yen(sum(l => l.attendanceAmount))}\n`
        + `禁煙手当 ${yen(sum(l => l.nonSmokerAmount))}\n`
        + `子ども手当 ${yen(sum(l => l.childAmount))}\n`
        + `支給総額 ${yen(sum(l => l.totalAmount))}\n`
        + `確定すると、精勤賞与の分は有給の買取としても自動で記録されます（休暇管理での手動記録は不要です）。`,
      confirmLabel: '確定する',
    }))) return null
    setBusy(true); setMsg('')
    try {
      const res = await fetchWithAuth('/api/jp-wage/bonus', { password: pw,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label, paidOn, pool: poolNum,
          // 同じ支給日の確定済みがあるのを分かったうえで確定する（サーバーも同じ判定で止める）
          allowSamePaidOn: sameDay.length > 0,
          hyogo: Object.fromEntries(members.map(m => [String(m.workerId), m.hyogo])),
          lines: lines.map(({ idx: _idx, ...l }) => l)
        })
      })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error || `失敗しました（${res.status}）`)
      // 有給買取の自動記録の結果（2026-08-31 追加）
      const br = (j.buyoutResults || []) as Array<{ name: string; days: number; status: string; note?: string }>
      const recorded = br.filter(b => b.status === 'recorded')
      const issues = br.filter(b => b.status !== 'recorded')
      let m = `「${label}」を保存しました`
      if (recorded.length > 0) m += `／有給の買取を${recorded.length}名分 自動記録しました`
      if (issues.length > 0) {
        m += `\n⚠️ 買取を記録できなかった人: ` + issues.map(b => `${b.name}（${b.note || b.status}）`).join('・')
      }
      setMsg(m)
      setLabel('')
      await load(pw, paidOn)
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : '保存に失敗しました' }
    } finally { setBusy(false) }
  }

  /** 確定の取り消し（押し間違えたとき）。賞与の記録と、この賞与が付けた有給の買取記録をまとめて外す */
  const cancelRecord = async (r: BonusRecord) => {
    if (!(await confirmDanger({
      title: `「${r.label}」の確定を取り消しますか？`,
      description: `支給日 ${r.paidOn}・${r.allocations.length}名分の記録を消します。\n`
        + `この賞与の精勤賞与で付けた有給の買取記録も外れ、休暇管理の「前の期の残り」に日数が戻ります。\n`
        + `手で記録した買取には触れません。消した内容は監査の記録に残ります。`,
      confirmLabel: '取り消す',
    }))) return
    setBusy(true)
    try {
      const res = await fetchWithAuth(`/api/jp-wage/bonus?id=${encodeURIComponent(r.id)}`, { password: pw,
        method: 'DELETE'})
      const j = await res.json().catch(() => ({}))
      if (!res.ok) { notify.failed('取り消し', j.error); return }
      const removed = (j.removedBuyouts || []) as Array<{ name: string; days: number }>
      notify.success(`「${r.label}」の確定を取り消しました`,
        removed.length > 0 ? `有給の買取記録を外した人: ${removed.map(b => `${b.name}（${b.days}日）`).join('・')}` : undefined,
        { sticky: removed.length > 0 })
      await load(pw, paidOn)
    } catch (e) {
      notify.failed('取り消し', e)
    } finally { setBusy(false) }
  }

  const th = 'px-2.5 py-2 text-xs font-bold text-gray-500 dark:text-gray-400 whitespace-nowrap'
  const td = 'px-2.5 py-1.5 text-right tabular-nums whitespace-nowrap'

  return (
    <div className="space-y-5">
      <div className="bg-hibi-navy/5 dark:bg-blue-900/20 rounded-xl border border-hibi-navy/20 dark:border-blue-800 p-4">
        <div className="text-sm font-bold mb-1">賞与の決め方</div>
        <p className="text-xs text-gray-600 dark:text-gray-300 leading-relaxed mb-2">
          支給額は次の4つの合計です。<br />
          <b>① 利益分配賞与</b> … 代表が業績を見て決めた<b>原資</b>を、<b>等級 × 評語</b>の点数で配分（単価 = 原資 ÷ 合計点）。
          個別に増減させたい場合は表の中で直接直せます<br />
          <b>② 精勤賞与</b> … 有給の買取。<b>残日数 × 日額</b>（日数は表の中で直せます）<br />
          <b>③ 禁煙手当</b> … 煙草を吸わない社員に年 {yen(NON_SMOKER_ALLOWANCE)}（人員マスタのチェック）<br />
          <b>④ 子ども手当</b> … 第1子 ¥30,000／第2子 ¥50,000／第3子以降 ¥70,000（18歳の誕生日を迎える年まで・人員マスタの誕生年月から自動）
        </p>
        <p className="text-xs text-gray-600 dark:text-gray-300 leading-relaxed">
          <b>業績連動は原資の決定に集約しています。</b>配分側にも昇給側にも係数は掛けません（掛けると二重連動になるため）。
        </p>
      </div>

      <div>
        <h3 className="text-sm font-bold mb-2">点数表</h3>
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-x-auto">
          <table className="w-full text-sm min-w-[560px]">
            <thead className="bg-gray-50 dark:bg-gray-700/50 border-b border-gray-200 dark:border-gray-700">
              <tr>
                <th className={`${th} text-left`}>等級</th>
                <th className={`${th} text-left`}>役割</th>
                {HY.map(h => <th key={h} className={`${th} text-right`}>{h}</th>)}
              </tr>
              <tr className="border-b border-gray-200 dark:border-gray-700">
                <th className={`${th} text-left`} colSpan={2}>分布の目安</th>
                {HY.map(h => <th key={h} className={`${th} text-right font-normal`}>{RATIO[h]}</th>)}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {GRADES_IN_ORDER.map(g => (
                <tr key={g}>
                  <td className="px-2.5 py-2 font-bold">{g === 'doko' ? '土工' : g}</td>
                  <td className="px-2.5 py-2 text-gray-600 dark:text-gray-300">{GRADE_LABELS[g]}</td>
                  {HY.map(h => (
                    <td key={h} className={`${td} ${h === 'A' ? 'font-bold' : ''}`}>{bonusPoints(g, h)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-2xs text-gray-400 mt-2 leading-relaxed">
          評語は「等級を上下にずらす」のと同じ（SS＝2段上 / S＝1段上 / B＝1段下 / C＝2段下）。
          分布の目安は左右対称で、第5節のペアのルール（S を1人なら B を1人、SS を1人なら C を1人）と同じ思想。
          土工は3G相当（旧配分表で班長と同額だった扱いを踏襲）。
          処遇固定の人は等級の{FIXED_BONUS_STEP_DOWN}段下で数える（4G・A なら {bonusPoints('4G', 'A')}点 → {bonusPoints('4G', 'A', FIXED_BONUS_STEP_DOWN)}点。2026-10 代表決定）。
          出向中の人も原資の配分に入れ、支払いは出向先を通す。
        </p>
      </div>

      {msg && <div className="rounded-lg border border-green-300 bg-green-50 dark:bg-green-900/20 p-3 text-sm text-green-800 dark:text-green-300">{msg}</div>}

      <div>
        <h3 className="text-sm font-bold mb-2">配分</h3>
        {/* 同じ支給日の賞与が確定済みのとき（2026-11-11）。確定すると精勤賞与は「買取済」になり、下の表では 0 に見える。
            「精勤賞与が消えた」と読めてしまうので、確定した中身（精勤賞与の日数と金額）をここに出し、下の表は「もう1件の試算」だと先に伝える */}
        {sameDay.map(r => {
          const h = summarizeBonus(r.pool, r.allocations)
          return (
            <div key={r.id} role="status" className="mb-3 rounded-xl border border-amber-300 bg-amber-50 dark:bg-amber-900/20 p-3 text-sm text-amber-900 dark:text-amber-200">
              <div className="font-bold">支給日 {paidOn} の賞与「{r.label}」は、確定済みです</div>
              <div className="mt-1 tabular-nums flex flex-wrap gap-x-3 gap-y-0.5">
                <span>会社が払う合計 <b>{yen(h.own.total)}</b></span>
                <span>① 利益分配 {yen(h.own.profit)}</span>
                <span>② 精勤賞与 <b>{yen(h.own.attendance)}</b>（{h.own.attendanceDays}日ぶんの有給の買取）</span>
                <span>③ 禁煙 {yen(h.own.nonSmoker)}</span>
                <span>④ 子ども {yen(h.own.child)}</span>
                {h.dispatched.count > 0 && <span>出向先が支給 {yen(h.dispatched.total)}（うち精勤賞与 {yen(h.dispatched.attendance)}）</span>}
              </div>
              <p className="text-xs mt-1.5">
                下の表は、この日に<b>もう1件</b>作るときの試算です。精勤賞与は確定した賞与で買い取ったので、下の表では 0 になります。
                直したいときは、履歴でこの確定を取り消してから確定し直してください（取り消すと有給の残りも戻ります）。
                <button
                  type="button"
                  onClick={() => {
                    const el = document.getElementById(`bonus-record-${r.id}`) as HTMLDetailsElement | null
                    if (el) { el.open = true; el.scrollIntoView({ behavior: 'smooth', block: 'start' }) }
                  }}
                  className="ml-2 underline font-bold"
                >
                  確定した内容を1人ずつ見る
                </button>
              </p>
            </div>
          )
        })}
        <div className="grid gap-3 sm:grid-cols-3 mb-3">
          <div>
            <label className="text-xs text-gray-500 block mb-1">支給名</label>
            <input
              type="text" value={label} onChange={e => setLabel(e.target.value)}
              placeholder="例：2026年 冬季賞与"
              className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 rounded-lg px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="text-xs text-gray-500 block mb-1">原資（円）</label>
            <input
              type="number" step="100000" value={pool} onChange={e => setPool(e.target.value)}
              className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 rounded-lg px-3 py-2 text-sm tabular-nums"
            />
          </div>
          <div>
            <label className="text-xs text-gray-500 block mb-1">支給日</label>
            <input
              type="date" value={paidOn} onChange={e => setPaidOn(e.target.value)}
              className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 rounded-lg px-3 py-2 text-sm"
            />
          </div>
        </div>
        {result && (
          <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2.5 mb-3">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm tabular-nums">
              <span>原資 <b>{yen(poolNum)}</b></span>
              <span className="text-gray-400">→</span>
              <span>① 利益分配の合計 <b>{yen(S.all.profit)}</b></span>
              {S.overPool !== 0 && (
                <span className="text-xs text-gray-500">
                  （{profitEdited ? '切り上げと手直しで' : '1人ずつ千円単位に切り上げるので'} 原資より {S.overPool > 0 ? '+' : '−'}{yen(Math.abs(S.overPool))}）
                </span>
              )}
              {S.dispatched.count > 0 && (
                <>
                  <span className="text-gray-400">＝</span>
                  <span>自社が払う <b>{yen(S.own.profit)}</b><span className="text-xs text-gray-500">（{S.own.count}名）</span></span>
                  <span className="text-gray-400">＋</span>
                  <span>出向先が払う {yen(S.dispatched.profit)}<span className="text-xs text-gray-500">（{S.dispatched.count}名）</span></span>
                </>
              )}
            </div>
            <p className="text-xs text-gray-500 mt-1">
              合計 {result.totalPoints}点 ／ 1点あたり <b>{result.unit.toFixed(2)}円</b>（1人ぶん = 点 × 1点あたり を千円単位に切り上げ）
            </p>
          </div>
        )}

        {!result ? (
          <p className="text-xs text-gray-400">在籍者の等級が読み込めませんでした。</p>
        ) : (
          <>
            {attendanceAllDone && (
              <p className="text-xs text-gray-500 mb-2">
                ② 精勤賞与（有給の買取）は、買い取る残りがある人がいません{buyoutRecord && buyoutSum ? `（「${buyoutRecord.label}」で ${buyoutSum.all.attendanceDays}日ぶん・${yen(buyoutSum.all.attendance)} を買取済み）` : ''}。この表では 0 になります。
                <button
                  type="button" onClick={() => setShowAttendance(v => !v)}
                  className="ml-2 underline text-hibi-navy dark:text-blue-300"
                >
                  {showAttendance ? '列をたたむ' : '列を出す'}
                </button>
              </p>
            )}
            <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-x-auto">
              <table className={`w-full text-sm ${hideAttendance ? 'min-w-[760px]' : 'min-w-[1040px]'}`}>
                <thead className="bg-gray-50 dark:bg-gray-700/50 border-b border-gray-200 dark:border-gray-700">
                  <tr>
                    {/* 12列あり横スクロールするため、氏名列は左に固定する（2026-08-31） */}
                    <th className={`${th} text-left sticky left-0 z-20 bg-gray-50 dark:bg-gray-700`}>氏名</th>
                    <th className={`${th} text-left`}>等級</th>
                    <th className={`${th} text-left`}>評語</th>
                    <th className={`${th} text-right`}>点</th>
                    <th className={`${th} text-right`}>① 利益分配</th>
                    {!hideAttendance && (
                      <>
                        <th className={`${th} text-right`}>残日数</th>
                        <th className={`${th} text-right`} title="買い取る期の最後の日に払っていた日額（10/1改定前）">日額（期末）</th>
                        <th className={`${th} text-right`}>② 精勤賞与</th>
                      </>
                    )}
                    <th className={`${th} text-right`}>③ 禁煙</th>
                    <th className={`${th} text-right`}>④ 子ども</th>
                    <th className={`${th} text-right`}>合計</th>
                    <th className={`${th} text-center`}>支給</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                  {/* 自社が払う人を合計の大きい順 → 出向先が払う人は下にまとめる（合計行に入らない人を途中に混ぜない） */}
                  {sortBonusLines(lines).map(l => (
                    <tr key={l.workerId} className={l.paidBy ? 'bg-gray-50 dark:bg-gray-700/30 text-gray-400' : ''}>
                      <td className={`px-2.5 py-2 whitespace-nowrap sticky left-0 z-10 ${
                        l.paidBy ? 'bg-gray-50 dark:bg-gray-700' : 'bg-white dark:bg-gray-800'}`}>
                        {l.name}
                        {l.paidBy && <span className="block text-3xs text-gray-400">{l.paidBy} から支給</span>}
                      </td>
                      <td className="px-2.5 py-2 text-gray-500 whitespace-nowrap">
                        {l.grade === 'doko' ? '土工' : l.grade}{l.profitShareOnly ? '相当' : ''}
                        {l.profitShareOnly && <span className="block text-3xs text-gray-400">利益分配のみ</span>}
                      </td>
                      <td className="px-2.5 py-1.5">
                        <select
                          value={l.hyogo} disabled={busy}
                          onChange={ev => setMembers(ms => ms.map((m, i) => i === l.idx ? { ...m, hyogo: ev.target.value as Hyogo } : m))}
                          className="border border-gray-300 dark:border-gray-600 dark:bg-gray-700 rounded-lg px-1.5 py-1 text-xs"
                        >
                          {HY.map(h => <option key={h} value={h}>{h}</option>)}
                        </select>
                      </td>
                      <td className={`${td} text-gray-500`}>
                        {l.points}
                        {l.stepDown > 0 && <span className="block text-3xs text-gray-400">処遇固定・{l.stepDown}段下</span>}
                      </td>
                      <td className={td}>
                        <input
                          type="text" inputMode="numeric" disabled={busy}
                          value={String(l.amount)}
                          onChange={e => setOverride(l.workerId, { profit: Number(e.target.value.replace(/[^0-9]/g, '')) || 0 })}
                          className="w-24 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 rounded px-1.5 py-1 text-right text-sm tabular-nums"
                        />
                      </td>
                      {!hideAttendance && (<>
                      <td className={td}>
                        {l.profitShareOnly ? <span className="text-gray-400">—</span> : <>
                        <input
                          type="text" inputMode="numeric" disabled={busy}
                          value={String(l.attendanceDays)}
                          onChange={e => setOverride(l.workerId, { days: Number(e.target.value.replace(/[^0-9]/g, '')) || 0 })}
                          className="w-14 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 rounded px-1.5 py-1 text-right text-sm tabular-nums"
                        />
                        {l.capped && (
                          <span className="block text-3xs text-gray-400">上限（残−{info[l.workerId]?.leaveFiveDayReserve || 0}日・年5日に足りない分）</span>
                        )}
                        {info[l.workerId]?.leavePeriodEnd ? (
                          <span className="block text-3xs text-gray-400">
                            期末 {info[l.workerId].leavePeriodEnd!.replace(/-/g, '/')}{info[l.workerId].leaveBuyoutRecorded ? '・買取済' : ''}
                          </span>
                        ) : (
                          <span className="block text-3xs text-gray-400">終わった期なし</span>
                        )}
                        </>}
                      </td>
                      <td className={`${td} text-gray-500`}>{l.attendanceRate ? yen(l.attendanceRate) : '—'}</td>
                      <td className={td}>{yen(l.attendanceAmount)}</td>
                      </>)}
                      <td className={td}>{l.nonSmokerAmount ? yen(l.nonSmokerAmount) : '—'}</td>
                      <td className={td}>
                        {l.childAmount ? (
                          <span title={`対象の子 ${l.childCount}人`}>{yen(l.childAmount)}
                            <span className="text-3xs text-gray-400 ml-1">{l.childCount}人</span>
                          </span>
                        ) : '—'}
                      </td>
                      <td className={`${td} font-bold`}>{yen(l.totalAmount)}</td>
                      <td className="px-2.5 py-1.5 text-center">
                        {l.paidBy ? <span className="text-3xs text-gray-400">—</span> : (
                          <select
                            value={l.payMethod} disabled={busy}
                            onChange={e => setOverride(l.workerId, { payMethod: e.target.value as 'transfer' | 'cash' })}
                            className="border border-gray-300 dark:border-gray-600 dark:bg-gray-700 rounded px-1 py-1 text-xs"
                          >
                            <option value="transfer">振込</option>
                            <option value="cash">現金</option>
                          </select>
                        )}
                      </td>
                    </tr>
                  ))}
                  {([
                    { key: 'own', label: `自社が払う合計（${S.own.count}名）`, p: S.own, strong: true },
                    ...(S.dispatched.count > 0 ? [
                      { key: 'dispatched', label: `出向先が払う（${S.dispatched.count}名）`, p: S.dispatched, strong: false },
                      { key: 'all', label: `全員（${S.all.count}名）`, p: S.all, strong: false },
                    ] : []),
                  ]).map((r, i) => (
                    <tr key={r.key} className={`bg-gray-50 dark:bg-gray-700/30 ${r.strong ? 'font-bold' : 'text-gray-500 dark:text-gray-400'} ${i === 0 ? 'border-t-2 border-gray-200 dark:border-gray-600' : ''}`}>
                      <td className="px-2.5 py-2 sticky left-0 z-10 bg-gray-50 dark:bg-gray-700 whitespace-nowrap" colSpan={4}>{r.label}</td>
                      <td className={td}>{yen(r.p.profit)}</td>
                      {!hideAttendance && (
                        <>
                          <td className={td}>{r.p.attendanceDays}日</td>
                          <td className={td}>—</td>
                          <td className={td}>{yen(r.p.attendance)}</td>
                        </>
                      )}
                      <td className={td}>{yen(r.p.nonSmoker)}</td>
                      <td className={td}>{yen(r.p.child)}</td>
                      <td className={td}>{yen(r.p.total)}</td>
                      <td />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="grid gap-3 sm:grid-cols-3 mt-3">
              <div className="sm:col-span-2 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-3">
                <div className="text-xs text-gray-500">会社が払う合計（{S.own.count}名）</div>
                <div className="text-2xl font-bold tabular-nums">{yen(S.own.total)}</div>
                <div className="text-xs text-gray-600 dark:text-gray-300 mt-1 flex flex-wrap gap-x-3 gap-y-0.5 tabular-nums">
                  <span>① 利益分配 {yen(S.own.profit)}</span>
                  <span>② 精勤賞与 {yen(S.own.attendance)}</span>
                  <span>③ 禁煙 {yen(S.own.nonSmoker)}</span>
                  <span>④ 子ども {yen(S.own.child)}</span>
                </div>
              </div>
              <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-3">
                <div className="text-xs text-gray-500">支払い方</div>
                <div className="text-sm tabular-nums mt-1 space-y-0.5">
                  <div className="flex justify-between gap-3"><span>振込</span><b>{yen(S.transfer)}</b></div>
                  <div className="flex justify-between gap-3"><span>現金</span><b>{yen(S.cash)}</b></div>
                  {S.dispatched.count > 0 && (
                    <div className="flex justify-between gap-3 text-gray-400">
                      <span>出向先が支給（会社は払わない）</span><span>{yen(S.dispatched.total)}</span>
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3 mt-3">
              <SaveButton
                action="確定"
                label="この配分を確定して保存する"
                onSave={save}
                disabled={!label.trim() || poolNum <= 0}
              />
              <span className="text-2xs text-gray-500">
                評語の初期値は年次改定で決めたもの。
                役員・事務は対象外。精勤賞与は、支給日の時点で終わっている有給の期の残りを、その期の最後の日の日額で買い取ります。
              </span>
            </div>
          </>
        )}
      </div>
      <section>
        <h3 className="text-sm font-bold mb-2">支給の履歴</h3>
        {records.length === 0 ? (
          <p className="text-xs text-gray-400">まだ記録がありません。</p>
        ) : (
          <div className="space-y-2">
            {records.map(r => {
              const h = summarizeBonus(r.pool, r.allocations)
              return (
              <details key={r.id} id={`bonus-record-${r.id}`} className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700">
                <summary className="cursor-pointer px-4 py-3 text-sm flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <b>{r.label}</b>
                  <span className="text-xs text-gray-500 tabular-nums">{r.paidOn}</span>
                  <span className="text-xs text-gray-500 tabular-nums">
                    原資 {yen(r.pool)} ／ {r.allocations.length}名 ／ 会社が払った合計 <b>{yen(h.own.total)}</b>
                    （利益分配 {yen(h.own.profit)}・精勤賞与 {yen(h.own.attendance)}・禁煙と子ども {yen(h.own.nonSmoker + h.own.child)}）
                    {h.dispatched.count > 0 && <> ／ 出向先が支給 {yen(h.dispatched.total)}</>}
                  </span>
                </summary>
                <div className="px-4 pb-3 overflow-x-auto">
                  <table className="w-full text-xs min-w-[420px]">
                    <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                      {r.allocations.slice().sort((a, b) => (b.totalAmount ?? b.amount) - (a.totalAmount ?? a.amount)).map(a => (
                        <tr key={a.workerId}>
                          <td className="py-1.5">{a.name}{a.paidBy && <span className="text-3xs text-gray-400 ml-1">({a.paidBy})</span>}</td>
                          <td className="py-1.5 text-gray-500">{a.grade === 'doko' ? '土工' : a.grade} / {a.hyogo}</td>
                          <td className="py-1.5 text-right tabular-nums text-gray-500">利益 {yen(a.amount)}</td>
                          <td className="py-1.5 text-right tabular-nums text-gray-500">
                            {a.attendanceAmount ? `精勤 ${yen(a.attendanceAmount)}(${a.attendanceDays}日)` : ''}
                          </td>
                          <td className="py-1.5 text-right tabular-nums text-gray-500">
                            {a.nonSmokerAmount ? `禁煙 ${yen(a.nonSmokerAmount)}` : ''}
                            {a.childAmount ? ` 子 ${yen(a.childAmount)}` : ''}
                          </td>
                          <td className="py-1.5 text-right tabular-nums font-bold">{yen(a.totalAmount ?? a.amount)}</td>
                          <td className="py-1.5 text-right text-3xs text-gray-400">{a.payMethod === 'cash' ? '現金' : ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="text-3xs text-gray-400 mt-2">
                    1点あたり {r.unit.toFixed(2)}円（合計 {r.totalPoints}点）
                    {r.grandTotal !== undefined && <> ／ 手当込みの支給総額 <b>{yen(r.grandTotal)}</b>（出向先支給を除く）</>}
                  </p>
                  <button
                    type="button" disabled={busy} onClick={() => cancelRecord(r)}
                    className="mt-2 text-xs text-red-600 dark:text-red-400 hover:underline disabled:opacity-50"
                  >
                    この確定を取り消す（押し間違えたとき）
                  </button>
                </div>
              </details>
              )
            })}
          </div>
        )}
      </section>
    </div>
  )
}
