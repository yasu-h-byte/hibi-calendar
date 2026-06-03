/**
 * 給与計算 監査資料 印刷ページ（社労士確認用 PDF 出力）
 *
 * 2026-06-XX 新設:
 *   - 対象: ベトナム人スタッフ全員（会社別: 日比 or HFU）
 *   - 用途: 社労士にチェックしてもらうための PDF
 *   - 出力: ブラウザの「PDFとして保存」(Cmd+P) で PDF 化
 *
 * URL: /monthly/audit-print?ym=YYYYMM&org=hibi|hfu
 *
 * ページ構成:
 *   1. 表紙（会社名/月/対象者数/支給合計/検算サマリ）
 *   2. 各スタッフ 1人ずつ: 計算根拠 + 日別カレンダー
 *
 * 印刷スタイル:
 *   @media print で UI chrome 非表示、1人1ページ改行
 */
'use client'

import { useEffect, useState, useMemo } from 'react'
import { useSearchParams } from 'next/navigation'
import { fmtYen } from '@/lib/format'
import PayrollAuditContent, { type PayrollAuditWorker } from '@/components/monthly/PayrollAuditContent'
import WorkerCalendarView from '@/components/monthly/WorkerCalendarView'
import { validatePayrolls, type PayrollSnapshot } from '@/lib/payroll-validator'

interface MonthlyDataRaw {
  workers: PayrollAuditWorker[]
  workDays: number
  prescribedDays: number
  siteNames: Record<string, string>
  dailyByWorker?: Record<number, Record<number, {
    w?: number; o?: number; p?: number; r?: number; h?: number; hk?: number; exam?: number;
    st?: string; et?: string; _siteId?: string;
  }>>
}

export default function AuditPrintPage() {
  const searchParams = useSearchParams()
  const ym = searchParams.get('ym') || ''
  const org = (searchParams.get('org') || 'hibi') as 'hibi' | 'hfu'

  const [data, setData] = useState<MonthlyDataRaw | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!ym) {
      setError('ym パラメータが指定されていません')
      setLoading(false)
      return
    }
    const stored = localStorage.getItem('hibi_auth')
    const password = stored ? JSON.parse(stored).password : ''
    fetch(`/api/monthly?ym=${ym}&includeDaily=true`, {
      headers: { 'X-Auth': password },
    })
      .then(async r => {
        if (!r.ok) throw new Error(`API ${r.status}`)
        return r.json()
      })
      .then(json => {
        setData(json as MonthlyDataRaw)
        setLoading(false)
      })
      .catch(err => {
        setError(String(err))
        setLoading(false)
      })
  }, [ym])

  // 対象スタッフのフィルタリング
  const targetWorkers = useMemo(() => {
    if (!data) return []
    // ベトナム人のみ (visa !== 'none') + 該当会社
    return data.workers
      .filter(w => w.visa && w.visa !== 'none')
      .filter(w => (org === 'hibi' ? w.org === 'hibi' : w.org === 'hfu'))
      .sort((a, b) => a.id - b.id)
  }, [data, org])

  // 集計値
  const summary = useMemo(() => {
    const total = targetWorkers.reduce((s, w) => s + (w.salaryNetPay || 0), 0)
    const newRulesCount = targetWorkers.filter(w => !w.useOldRules && ym >= '202605').length
    const oldRulesCount = targetWorkers.length - newRulesCount
    const validation = validatePayrolls(targetWorkers as unknown as PayrollSnapshot[])
    return { total, newRulesCount, oldRulesCount, validation }
  }, [targetWorkers, ym])

  // タイトル（ブラウザの Save as PDF デフォルトファイル名に反映）
  useEffect(() => {
    const orgLabel = org === 'hibi' ? '日比建設' : 'HFU'
    document.title = `給与計算監査_${orgLabel}_${ym}`
  }, [org, ym])

  if (loading) return (
    <div className="p-8 text-center text-gray-500">読み込み中...</div>
  )
  if (error) return (
    <div className="p-8 text-center text-red-600">エラー: {error}</div>
  )
  if (!data) return null

  const orgLabel = org === 'hibi' ? '日比建設株式会社' : '株式会社HFU'
  const ymY = parseInt(ym.slice(0, 4))
  const ymM = parseInt(ym.slice(4, 6))
  const yearMonthLabel = `${ymY}年${ymM}月`
  const today = '本日'  // Date.now() がランタイム制限の場合があるためフォールバック

  return (
    <>
      {/* 印刷用スタイル: ブラウザ chrome や sidebar を完全に隠す */}
      <style jsx global>{`
        @media print {
          /* (app) layout のサイドバー・ヘッダーを非表示 */
          aside, header, nav, button.print-hide { display: none !important; }
          /* 印刷専用余白 */
          @page { size: A4 portrait; margin: 12mm; }
          /* 改ページ */
          .page-break { page-break-after: always; }
          /* セクション内の改ページ抑制 */
          section, table { page-break-inside: avoid; }
          /* 印刷時は背景色を維持 */
          * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
          /* main の余白を最小化 */
          main, .audit-print-root { padding: 0 !important; margin: 0 !important; max-width: 100% !important; }
        }
        .audit-print-root {
          background: white;
          color: #1f2937;
          font-family: system-ui, -apple-system, "Hiragino Kaku Gothic ProN", "Yu Gothic", sans-serif;
        }
      `}</style>

      <div className="audit-print-root max-w-4xl mx-auto px-6 py-6">

        {/* 印刷ボタン（画面のみ表示） */}
        <div className="print-hide mb-4 flex items-center justify-between gap-3 bg-yellow-50 border border-yellow-300 rounded-lg p-3">
          <div className="text-sm text-yellow-800">
            💡 <strong>PDF として保存するには:</strong> Cmd+P (Mac) / Ctrl+P (Windows) を押して「送信先: PDF として保存」を選択してください
          </div>
          <button
            onClick={() => window.print()}
            className="print-hide px-4 py-2 bg-hibi-navy text-white rounded-lg text-sm font-bold hover:bg-[#243656] whitespace-nowrap"
          >
            🖨️ 印刷 / PDF 保存
          </button>
        </div>

        {/* ── 表紙ページ ── */}
        <section className="page-break">
          <div className="text-center mb-8 pt-12">
            <h1 className="text-3xl font-bold text-hibi-navy mb-2">給与計算 監査資料</h1>
            <p className="text-sm text-gray-500">社労士確認用</p>
          </div>
          <div className="border-2 border-hibi-navy rounded-lg p-6 max-w-md mx-auto bg-blue-50/30">
            <table className="w-full text-sm">
              <tbody className="[&_td]:py-2 [&_td:first-child]:text-gray-600 [&_td:first-child]:w-1/3">
                <tr><td>会社</td><td className="font-bold">{orgLabel}</td></tr>
                <tr><td>対象月</td><td className="font-bold">{yearMonthLabel}分</td></tr>
                <tr><td>対象者</td><td className="font-bold">ベトナム人スタッフ {targetWorkers.length}名</td></tr>
                <tr><td>作成日</td><td className="font-mono">{today}</td></tr>
              </tbody>
            </table>
          </div>

          <div className="mt-6 max-w-md mx-auto">
            <h3 className="font-bold text-hibi-navy mb-2 border-b border-gray-300 pb-1">支給概要</h3>
            <table className="w-full text-sm">
              <tbody className="[&_td]:py-1.5 [&_td:first-child]:text-gray-600 [&_td:first-child]:w-1/2">
                <tr><td>支給合計</td><td className="font-mono font-bold text-base">{fmtYen(summary.total)}</td></tr>
                {summary.newRulesCount > 0 && <tr><td>新ルール対象</td><td>{summary.newRulesCount}名</td></tr>}
                {summary.oldRulesCount > 0 && <tr><td>旧ルール継続</td><td>{summary.oldRulesCount}名（個別フラグ設定）</td></tr>}
              </tbody>
            </table>
          </div>

          <div className="mt-6 max-w-md mx-auto">
            <h3 className="font-bold text-hibi-navy mb-2 border-b border-gray-300 pb-1">自動検算結果</h3>
            {summary.validation.total === 0 ? (
              <div className="bg-green-50 border border-green-300 rounded-lg p-3 text-sm">
                <div className="font-bold text-green-800">✓ 全 {targetWorkers.length}名 OK</div>
                <div className="text-xs text-green-700 mt-1">
                  法定外残業 0.25倍 / 所定外労働 / 法定休日 1.35倍 / 深夜 0.25倍 / 休業 60% — 全項目で労基法準拠を確認
                </div>
              </div>
            ) : (
              <div className="bg-red-50 border border-red-300 rounded-lg p-3 text-sm">
                <div className="font-bold text-red-800">
                  ⚠ {summary.validation.affectedWorkerIds.length}名で {summary.validation.total}件の違反検出
                </div>
                <ul className="text-xs text-red-700 mt-2 space-y-1">
                  {summary.validation.issues.map((iss, i) => (
                    <li key={i}>
                      [{iss.severity}] <strong>{iss.workerName}</strong>: {iss.message}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <div className="mt-12 text-xs text-gray-500 text-center">
            計算ロジック: lib/compute.ts (calculateVietnameseSalary)<br/>
            検算ロジック: lib/payroll-validator.ts (validatePayrolls)<br/>
            ※ 1ヶ月単位変形労働時間制（労基法32条の2）に基づき計算
          </div>
        </section>

        {/* ── 各スタッフ詳細ページ ── */}
        {targetWorkers.length === 0 ? (
          <div className="p-8 text-center text-gray-500">対象スタッフがいません</div>
        ) : (
          targetWorkers.map((worker, idx) => {
            const dailyEntries = data.dailyByWorker?.[worker.id] || {}
            return (
              <section key={worker.id} className={idx < targetWorkers.length - 1 ? 'page-break' : ''}>
                {/* ヘッダー */}
                <div className="bg-hibi-navy text-white px-4 py-2 rounded-t-md mb-3 mt-6">
                  <div className="font-bold text-base">
                    {worker.name}
                    <span className="ml-2 text-xs opacity-80">
                      ({worker.org === 'hfu' ? 'HFU' : '日比建設'}) — ID:{worker.id}
                    </span>
                  </div>
                </div>

                {/* 給与計算の根拠 */}
                <PayrollAuditContent
                  worker={worker}
                  ym={ym}
                  prescribedDays={data.prescribedDays || data.workDays || 0}
                  baseDays={20}
                />

                {/* 日別カレンダー */}
                <div className="mt-6">
                  <WorkerCalendarView
                    ym={ym}
                    entries={dailyEntries}
                    siteNames={data.siteNames}
                  />
                </div>
              </section>
            )
          })
        )}
      </div>
    </>
  )
}
