'use client'

/**
 * 賞与の点数表（docs/wage-system.md 第7節）。
 *
 * 表は `lib/jp-wage.ts` の bonusPoints から生成する。写して持つと配分と表がズレる。
 * 原資を入れると、いまの在籍者でいくらになるかを試算できる。
 */

import { useCallback, useEffect, useState } from 'react'
import {
  bonusPoints, allocateBonus, GRADE_LABELS, GRADES_IN_ORDER,
  childAllowance, attendanceBonusDays, attendanceBonusAmount,
  NON_SMOKER_ALLOWANCE, FIVE_DAY_RESERVE,
  type JpGrade, type Hyogo, type BonusMember,
} from '@/lib/jp-wage'

interface BonusRecord {
  id: string; label: string; paidOn: string; pool: number
  totalPoints: number; unit: number; total: number; grandTotal?: number
  allocations: Array<{
    workerId: number; name: string; grade: string; hyogo: Hyogo; points: number; amount: number
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
  rate: number
  nonSmoker: boolean
  children: string[]
  dispatchTo: string
  leaveRemaining: number
  /** 有効な有給付与レコードの付与日。買取上限（残−5日）の判定に使う */
  leaveGrantDate: string
}

/** 画面上で手修正できる項目（自動計算の結果を上書きする） */
interface Override {
  profit?: number        // 利益分配賞与
  days?: number          // 精勤賞与の買取日数
  payMethod?: 'transfer' | 'cash'
}

const HY: Hyogo[] = ['SS', 'S', 'A', 'B', 'C']
const RATIO = { SS: '5%', S: '15%', A: '60%', B: '15%', C: '5%' }
const yen = (v: number) => '¥' + Math.round(v).toLocaleString()

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
  const [err, setErr] = useState('')

  const load = useCallback(async (password: string) => {
    try {
      const [wr, br] = await Promise.all([
        fetch('/api/workers', { headers: { 'x-admin-password': password } }),
        fetch('/api/jp-wage/bonus', { headers: { 'x-admin-password': password } }),
      ])
      // 評語は年次改定で決めたものを初期値にする（賞与と昇給で別の評価を付けない）
      const bj = br.ok ? await br.json() : { records: [], hyogo: {}, members: [] }
      setRecords(bj.records || [])
      setInfo(Object.fromEntries(((bj.members || []) as MemberInfo[]).map(m => [m.workerId, m])))
      if (wr.ok) {
        const j = await wr.json()
        setMembers((j.workers as Record<string, unknown>[])
          .filter(w => !w.retired && w.jpGrade && Number(w.id) !== 1)
          .filter(w => w.jobType !== 'yakuin' && w.jobType !== 'jimu')
          .map(w => ({
            workerId: Number(w.id), name: String(w.name),
            grade: String(w.jpGrade) as JpGrade,
            hyogo: (bj.hyogo?.[String(w.id)] as Hyogo) || 'A',
          })))
      }
    } catch { /* 試算が出せなくても表は見られる */ }
  }, [])

  useEffect(() => {
    try {
      const raw = localStorage.getItem('hibi_auth')
      const p = raw ? JSON.parse(raw)?.password : ''
      if (!p) return
      setPw(p); load(p)
    } catch { /* noop */ }
  }, [load])

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
    // 2026-10-01 付与期からは年5日を確保するため「残日数 − 5日」が買取の上限
    // （代表決定 2026-08-31・docs/paid-leave.md）。それ以前の期は全額買取できる。
    const capped = !!inf?.leaveGrantDate && inf.leaveGrantDate >= '2026-10-01'
    const days = o.days !== undefined
      ? o.days
      : attendanceBonusDays(inf?.leaveRemaining || 0, { capForFiveDayObligation: capped })
    const attendanceAmount = attendanceBonusAmount(days, rate)
    const nonSmokerAmount = inf?.nonSmoker ? NON_SMOKER_ALLOWANCE : 0
    const child = childAllowance(inf?.children || [], paidOn)
    const profit = o.profit !== undefined ? o.profit : a.amount
    return {
      workerId: a.workerId, name: m.name, grade: a.grade, hyogo: a.hyogo, points: a.points,
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
  const setOverride = (id: number, patch: Override) =>
    setOv(prev => ({ ...prev, [id]: { ...prev[id], ...patch } }))

  const save = async () => {
    if (!result) return
    if (!confirm(
      `「${label}」として支給を確定します。\n\n`
      + `対象 ${lines.length}名（うち出向先支給 ${lines.length - own.length}名）\n`
      + `利益分配 ${yen(sum(l => l.amount))}\n`
      + `精勤賞与 ${yen(sum(l => l.attendanceAmount))}\n`
      + `禁煙手当 ${yen(sum(l => l.nonSmokerAmount))}\n`
      + `子ども手当 ${yen(sum(l => l.childAmount))}\n`
      + `─────────────\n`
      + `支給総額 ${yen(sum(l => l.totalAmount))}\n\n`
      + `確定すると、精勤賞与の分は有給の買取としても自動記録されます\n`
      + `（休暇管理での手動記録は不要です）。よろしいですか？`
    )) return
    setBusy(true); setErr(''); setMsg('')
    try {
      const res = await fetch('/api/jp-wage/bonus', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-password': pw },
        body: JSON.stringify({
          label, paidOn, pool: poolNum,
          hyogo: Object.fromEntries(members.map(m => [String(m.workerId), m.hyogo])),
          lines: lines.map(({ idx: _idx, ...l }) => l),
        }),
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
      await load(pw)
    } catch (e) {
      setErr(e instanceof Error ? e.message : '保存に失敗しました')
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
        <p className="text-[11px] text-gray-400 mt-2 leading-relaxed">
          評語は「等級を上下にずらす」のと同じ（SS＝2段上 / S＝1段上 / B＝1段下 / C＝2段下）。
          分布の目安は左右対称で、第5節のペアのルール（S を1人なら B を1人、SS を1人なら C を1人）と同じ思想。
          土工は3G相当（旧配分表で班長と同額だった扱いを踏襲）。
        </p>
      </div>

      {err && <div className="rounded-lg border border-red-300 bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-700 dark:text-red-300">{err}</div>}
      {msg && <div className="rounded-lg border border-green-300 bg-green-50 dark:bg-green-900/20 p-3 text-sm text-green-800 dark:text-green-300">{msg}</div>}

      <div>
        <h3 className="text-sm font-bold mb-2">配分</h3>
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
          <p className="text-xs text-gray-500 mb-3">
            合計 {result.totalPoints}点 ／ 1点あたり <b>{result.unit.toFixed(2)}円</b>
          </p>
        )}

        {!result ? (
          <p className="text-xs text-gray-400">在籍者の等級が読み込めませんでした。</p>
        ) : (
          <>
            <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-x-auto">
              <table className="w-full text-sm min-w-[1040px]">
                <thead className="bg-gray-50 dark:bg-gray-700/50 border-b border-gray-200 dark:border-gray-700">
                  <tr>
                    {/* 12列あり横スクロールするため、氏名列は左に固定する（2026-08-31） */}
                    <th className={`${th} text-left sticky left-0 z-20 bg-gray-50 dark:bg-gray-700`}>氏名</th>
                    <th className={`${th} text-left`}>等級</th>
                    <th className={`${th} text-left`}>評語</th>
                    <th className={`${th} text-right`}>点</th>
                    <th className={`${th} text-right`}>① 利益分配</th>
                    <th className={`${th} text-right`}>残日数</th>
                    <th className={`${th} text-right`}>単価</th>
                    <th className={`${th} text-right`}>② 精勤賞与</th>
                    <th className={`${th} text-right`}>③ 禁煙</th>
                    <th className={`${th} text-right`}>④ 子ども</th>
                    <th className={`${th} text-right`}>合計</th>
                    <th className={`${th} text-center`}>支給</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                  {[...lines].sort((x, y) => y.totalAmount - x.totalAmount).map(l => (
                    <tr key={l.workerId} className={l.paidBy ? 'bg-gray-50 dark:bg-gray-700/30 text-gray-400' : ''}>
                      <td className={`px-2.5 py-2 whitespace-nowrap sticky left-0 z-10 ${
                        l.paidBy ? 'bg-gray-50 dark:bg-gray-700' : 'bg-white dark:bg-gray-800'}`}>
                        {l.name}
                        {l.paidBy && <span className="block text-[10px] text-gray-400">{l.paidBy} から支給</span>}
                      </td>
                      <td className="px-2.5 py-2 text-gray-500">{l.grade === 'doko' ? '土工' : l.grade}</td>
                      <td className="px-2.5 py-1.5">
                        <select
                          value={l.hyogo} disabled={busy}
                          onChange={ev => setMembers(ms => ms.map((m, i) => i === l.idx ? { ...m, hyogo: ev.target.value as Hyogo } : m))}
                          className="border border-gray-300 dark:border-gray-600 dark:bg-gray-700 rounded-lg px-1.5 py-1 text-xs"
                        >
                          {HY.map(h => <option key={h} value={h}>{h}</option>)}
                        </select>
                      </td>
                      <td className={`${td} text-gray-500`}>{l.points}</td>
                      <td className={td}>
                        <input
                          type="text" inputMode="numeric" disabled={busy}
                          value={String(l.amount)}
                          onChange={e => setOverride(l.workerId, { profit: Number(e.target.value.replace(/[^0-9]/g, '')) || 0 })}
                          className="w-24 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 rounded px-1.5 py-1 text-right text-sm tabular-nums"
                        />
                      </td>
                      <td className={td}>
                        <input
                          type="text" inputMode="numeric" disabled={busy}
                          value={String(l.attendanceDays)}
                          onChange={e => setOverride(l.workerId, { days: Number(e.target.value.replace(/[^0-9]/g, '')) || 0 })}
                          className="w-14 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 rounded px-1.5 py-1 text-right text-sm tabular-nums"
                        />
                        {l.capped && (
                          <span className="block text-[9px] text-gray-400">上限（残−{FIVE_DAY_RESERVE}日）</span>
                        )}
                      </td>
                      <td className={`${td} text-gray-500`}>{l.attendanceRate ? yen(l.attendanceRate) : '—'}</td>
                      <td className={td}>{yen(l.attendanceAmount)}</td>
                      <td className={td}>{l.nonSmokerAmount ? yen(l.nonSmokerAmount) : '—'}</td>
                      <td className={td}>
                        {l.childAmount ? (
                          <span title={`対象の子 ${l.childCount}人`}>{yen(l.childAmount)}
                            <span className="text-[10px] text-gray-400 ml-1">{l.childCount}人</span>
                          </span>
                        ) : '—'}
                      </td>
                      <td className={`${td} font-bold`}>{yen(l.totalAmount)}</td>
                      <td className="px-2.5 py-1.5 text-center">
                        {l.paidBy ? <span className="text-[10px] text-gray-400">—</span> : (
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
                  <tr className="bg-gray-50 dark:bg-gray-700/30 font-bold border-t-2 border-gray-200 dark:border-gray-600">
                    <td className="px-2.5 py-2 sticky left-0 z-10 bg-gray-50 dark:bg-gray-700" colSpan={4}>合計（自社支給 {own.length}名）</td>
                    <td className={td}>{yen(sum(l => l.amount))}</td>
                    <td className={td}>{sum(l => l.attendanceDays)}日</td>
                    <td className={td}>—</td>
                    <td className={td}>{yen(sum(l => l.attendanceAmount))}</td>
                    <td className={td}>{yen(sum(l => l.nonSmokerAmount))}</td>
                    <td className={td}>{yen(sum(l => l.childAmount))}</td>
                    <td className={td}>{yen(sum(l => l.totalAmount))}</td>
                    <td />
                  </tr>
                </tbody>
              </table>
            </div>

            <div className="grid gap-3 sm:grid-cols-3 mt-3">
              <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-3">
                <div className="text-xs text-gray-500">振込 計</div>
                <div className="text-lg font-bold tabular-nums">{yen(sum(l => l.totalAmount, own.filter(l => l.payMethod === 'transfer')))}</div>
              </div>
              <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-3">
                <div className="text-xs text-gray-500">現金 計</div>
                <div className="text-lg font-bold tabular-nums">{yen(sum(l => l.totalAmount, own.filter(l => l.payMethod === 'cash')))}</div>
              </div>
              <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-3">
                <div className="text-xs text-gray-500">出向先が支給</div>
                <div className="text-lg font-bold tabular-nums text-gray-400">
                  {yen(lines.filter(l => l.paidBy).reduce((s2, l) => s2 + l.totalAmount, 0))}
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3 mt-3">
              <button
                onClick={save} disabled={busy || !label.trim() || poolNum <= 0}
                className="px-5 py-2.5 rounded-lg bg-hibi-navy text-white font-bold text-sm hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {busy ? '保存中…' : 'この配分を確定して保存'}
              </button>
              <span className="text-[11px] text-gray-500">
                評語の初期値は年次改定で決めたもの。千円切り上げのぶん、利益分配の合計は原資をわずかに超えます。
                役員・事務は対象外。精勤賞与の残日数は今日時点の有給残です。
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
            {records.map(r => (
              <details key={r.id} className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700">
                <summary className="cursor-pointer px-4 py-3 text-sm flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <b>{r.label}</b>
                  <span className="text-xs text-gray-500 tabular-nums">{r.paidOn}</span>
                  <span className="text-xs text-gray-500 tabular-nums">
                    原資 {yen(r.pool)} ／ {r.allocations.length}名 ／ 支給計 {yen(r.grandTotal ?? r.total)}
                  </span>
                </summary>
                <div className="px-4 pb-3 overflow-x-auto">
                  <table className="w-full text-xs min-w-[420px]">
                    <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                      {r.allocations.slice().sort((a, b) => (b.totalAmount ?? b.amount) - (a.totalAmount ?? a.amount)).map(a => (
                        <tr key={a.workerId}>
                          <td className="py-1.5">{a.name}{a.paidBy && <span className="text-[10px] text-gray-400 ml-1">({a.paidBy})</span>}</td>
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
                          <td className="py-1.5 text-right text-[10px] text-gray-400">{a.payMethod === 'cash' ? '現金' : ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="text-[10px] text-gray-400 mt-2">
                    1点あたり {r.unit.toFixed(2)}円（合計 {r.totalPoints}点）
                    {r.grandTotal !== undefined && <> ／ 手当込みの支給総額 <b>{yen(r.grandTotal)}</b>（出向先支給を除く）</>}
                  </p>
                </div>
              </details>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
