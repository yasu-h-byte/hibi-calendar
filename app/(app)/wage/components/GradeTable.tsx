'use client'

/**
 * 号俸表（docs/wage-system.md 第3節）。
 *
 * 表は `lib/jp-wage.ts` から都度生成する。ドキュメントの表を写して持つと、
 * ピッチを変えたときに画面と計算がズレる。**表示と計算を同じ関数から出す**のが要点。
 */

import { useState } from 'react'
import {
  dailyForStep, capDaily, pitchOf, baseAnnual, MAX_STEP, ANNUAL_DAYS,
  GRADE_LABELS, GRADES_IN_ORDER, type JpGrade,
} from '@/lib/jp-wage'

const yen = (v: number) => '¥' + v.toLocaleString()

interface Placed { name: string; grade: string; step: number }

export default function GradeTable({ placed }: { placed: Placed[] }) {
  const [dense, setDense] = useState(true)
  // 既定は5号刻み。全60号は必要なときだけ開く（縦に長くなりすぎるため）
  const steps = dense
    ? Array.from({ length: MAX_STEP }, (_, i) => i + 1).filter(n => n === 1 || n % 5 === 0 || placed.some(p => p.step === n))
    : Array.from({ length: MAX_STEP }, (_, i) => i + 1)

  const byCell = new Map<string, Placed[]>()
  for (const p of placed) {
    const k = `${p.grade}:${p.step}`
    byCell.set(k, [...(byCell.get(k) || []), p])
  }

  const th = 'px-2.5 py-2 text-xs font-bold text-gray-500 dark:text-gray-400 whitespace-nowrap'
  const td = 'px-2.5 py-1.5 text-right tabular-nums whitespace-nowrap'

  return (
    <div className="space-y-5">
      {/* 等級の一覧 */}
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-x-auto">
        <table className="w-full text-sm min-w-[720px]">
          <thead className="bg-gray-50 dark:bg-gray-700/50 border-b border-gray-200 dark:border-gray-700">
            <tr>
              <th className={`${th} text-left`}>等級</th>
              <th className={`${th} text-left`}>役割</th>
              <th className={`${th} text-right`}>初号（1号）</th>
              <th className={`${th} text-right`}>上限（60号）</th>
              <th className={`${th} text-right`}>上限の年収</th>
              <th className={`${th} text-right`}>ピッチ 1〜25 / 26〜45 / 46〜60</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
            {GRADES_IN_ORDER.map(g => {
              const p = pitchOf(g)
              return (
                <tr key={g}>
                  <td className="px-2.5 py-2 font-bold">{g === 'doko' ? '土工' : g}</td>
                  <td className="px-2.5 py-2 text-gray-600 dark:text-gray-300">{GRADE_LABELS[g]}</td>
                  <td className={td}>{yen(dailyForStep(g, 1))}</td>
                  <td className={`${td} font-bold`}>{yen(capDaily(g))}</td>
                  <td className={`${td} text-gray-500`}>{yen(baseAnnual(capDaily(g)))}</td>
                  <td className={`${td} text-gray-500`}>{p[0]} / {p[1]} / {p[2]}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-gray-400 -mt-3">
        年収は年間所定 {ANNUAL_DAYS} 日換算。ピッチは上位の号ほど小さくなり、上位等級ほど大きい（同じ評価なら上位等級の方が速く上がる）。
        土工は3Gの90%。
      </p>

      {/* 号俸表 */}
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-bold">号俸表（全{MAX_STEP}号・日額）</h3>
        <button onClick={() => setDense(!dense)}
          className="text-xs px-3 py-1.5 rounded-lg border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700">
          {dense ? '全60号を表示' : '5号刻みに戻す'}
        </button>
      </div>

      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-x-auto">
        <table className="w-full text-sm min-w-[760px]">
          <thead className="bg-gray-50 dark:bg-gray-700/50 border-b border-gray-200 dark:border-gray-700 sticky top-0">
            <tr>
              <th className={`${th} text-left`}>号</th>
              {GRADES_IN_ORDER.map(g => (
                <th key={g} className={`${th} text-right`}>{g === 'doko' ? '土工' : g}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
            {steps.map(n => (
              <tr key={n} className={n === MAX_STEP ? 'bg-gray-50 dark:bg-gray-700/30' : ''}>
                <td className="px-2.5 py-1.5 font-medium tabular-nums">{n}</td>
                {GRADES_IN_ORDER.map(g => {
                  const here = byCell.get(`${g}:${n}`) || []
                  return (
                    <td key={g} className={`${td} ${here.length ? 'bg-hibi-navy/10 dark:bg-blue-900/30' : ''}`}>
                      {yen(dailyForStep(g, n))}
                      {here.length > 0 && (
                        <div className="text-[10px] font-bold text-hibi-navy dark:text-blue-300">
                          {here.map(p => p.name).join('・')}
                        </div>
                      )}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-gray-400">
        色のついたセルが現在の在籍者の位置です。
        {dense && '既定は5号刻みですが、在籍者のいる号は必ず表示しています。'}
      </p>
    </div>
  )
}
