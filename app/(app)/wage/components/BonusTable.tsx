'use client'

/**
 * 賞与の点数表（docs/wage-system.md 第7節）。
 *
 * 表は `lib/jp-wage.ts` の bonusPoints から生成する。写して持つと配分と表がズレる。
 * 原資を入れると、いまの在籍者でいくらになるかを試算できる。
 */

import { useEffect, useState } from 'react'
import {
  bonusPoints, allocateBonus, GRADE_LABELS, GRADES_IN_ORDER,
  type JpGrade, type Hyogo, type BonusMember,
} from '@/lib/jp-wage'

const HY: Hyogo[] = ['SS', 'S', 'A', 'B', 'C']
const RATIO = { SS: '5%', S: '15%', A: '60%', B: '15%', C: '5%' }
const yen = (v: number) => '¥' + Math.round(v).toLocaleString()

export default function BonusTable() {
  const [pool, setPool] = useState('1200000')
  const [members, setMembers] = useState<Array<BonusMember & { name: string }>>([])

  useEffect(() => {
    try {
      const raw = localStorage.getItem('hibi_auth')
      const pw = raw ? JSON.parse(raw)?.password : ''
      if (!pw) return
      fetch('/api/workers', { headers: { 'x-admin-password': pw } })
        .then(r => r.ok ? r.json() : null)
        .then(j => {
          if (!j?.workers) return
          setMembers((j.workers as Record<string, unknown>[])
            .filter(w => !w.retired && w.jpGrade && Number(w.id) !== 1)
            .map(w => ({ workerId: Number(w.id), name: String(w.name), grade: String(w.jpGrade) as JpGrade, hyogo: 'A' as Hyogo })))
        })
        .catch(() => {})
    } catch { /* 試算が出せなくても表は見られる */ }
  }, [])

  const poolNum = Number(pool) || 0
  const result = members.length ? allocateBonus(poolNum, members) : null

  const th = 'px-2.5 py-2 text-xs font-bold text-gray-500 dark:text-gray-400 whitespace-nowrap'
  const td = 'px-2.5 py-1.5 text-right tabular-nums whitespace-nowrap'

  return (
    <div className="space-y-5">
      <div className="bg-hibi-navy/5 dark:bg-blue-900/20 rounded-xl border border-hibi-navy/20 dark:border-blue-800 p-4">
        <div className="text-sm font-bold mb-1">賞与の決め方</div>
        <p className="text-xs text-gray-600 dark:text-gray-300 leading-relaxed">
          ① 代表が業績を見て<b>原資（総額）</b>を決める　→　② 各人に<b>等級 × 評語</b>で点数をつける　→　
          ③ <b>単価 = 原資 ÷ 合計点</b>　→　④ 点数 × 単価（千円切り上げ）<br />
          <b>業績連動はこの原資の決定に集約しています。</b>配分側にも昇給側にも係数は掛けません（掛けると二重連動になるため）。
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

      <div>
        <h3 className="text-sm font-bold mb-2">試算</h3>
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <label className="text-xs text-gray-500">原資</label>
          <input
            type="number" step="100000" value={pool} onChange={e => setPool(e.target.value)}
            className="w-36 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 rounded-lg px-3 py-2 text-sm tabular-nums"
          />
          <span className="text-xs text-gray-500">円</span>
          {result && (
            <span className="text-xs text-gray-500 ml-2">
              合計 {result.totalPoints}点 ／ 1点あたり <b>{result.unit.toFixed(2)}円</b>
            </span>
          )}
        </div>

        {!result ? (
          <p className="text-xs text-gray-400">在籍者の等級が読み込めませんでした。</p>
        ) : (
          <>
            <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-x-auto">
              <table className="w-full text-sm min-w-[460px]">
                <thead className="bg-gray-50 dark:bg-gray-700/50 border-b border-gray-200 dark:border-gray-700">
                  <tr>
                    <th className={`${th} text-left`}>氏名</th><th className={`${th} text-left`}>等級</th>
                    <th className={`${th} text-right`}>点数</th><th className={`${th} text-right`}>支給額</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                  {result.allocations
                    .map((a, i) => ({ ...a, name: members[i].name }))
                    .sort((x, y) => y.points - x.points)
                    .map(a => (
                      <tr key={a.workerId}>
                        <td className="px-2.5 py-2">{a.name}</td>
                        <td className="px-2.5 py-2 text-gray-500">{a.grade === 'doko' ? '土工' : a.grade}</td>
                        <td className={td}>{a.points}</td>
                        <td className={`${td} font-bold`}>{yen(a.amount)}</td>
                      </tr>
                    ))}
                  <tr className="bg-gray-50 dark:bg-gray-700/30 font-bold">
                    <td className="px-2.5 py-2" colSpan={2}>合計 {result.allocations.length}名</td>
                    <td className={td}>{result.totalPoints}</td>
                    <td className={td}>{yen(result.allocations.reduce((s, a) => s + a.amount, 0))}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="text-[11px] text-gray-400 mt-2">
              全員A評価とした場合の試算です。千円切り上げのぶん、合計は原資をわずかに超えます。
              役員は配分の対象外。実際の評語は年次改定で決めたものを使ってください。
            </p>
          </>
        )}
      </div>
    </div>
  )
}
