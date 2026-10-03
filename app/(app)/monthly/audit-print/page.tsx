/**
 * 給与計算 監査資料 印刷ページ（社労士確認用 PDF 出力）
 *
 * 2026-06-XX 新設:
 *   - 対象: その会社の給与計算対象者全員（ベトナム人＋日本人。会社別: 日比 or HFU）
 *     2026-09-17: 日本人も載せる。キャシュモへの毎月の提出を「月次集計Excel＋このPDF」の2点に絞り、
 *     日本人の日別（有給・欠勤の日付）と内訳の根拠もこのPDFで揃える（代表決定）
 *   - 用途: キャシュモ（給与計算委託先）・社労士にチェックしてもらうための PDF
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
  baseDays?: number
  /** 会社別の締め状態（締める前に出したPDFには「未確定（締め前）」の印を付ける・2026-10-02） */
  lockedHibi?: boolean
  lockedHfu?: boolean
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
    if (!password) {
      setError('認証情報がありません。/monthly を一度開いてからこのページに遷移してください')
      setLoading(false)
      return
    }
    fetch(`/api/monthly?ym=${ym}&includeDaily=true`, {
      headers: { 'x-admin-password': password },
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
  const [targetWorkers, dispatchedWorkers] = useMemo(() => {
    if (!data) return [[], []] as [PayrollAuditWorker[], PayrollAuditWorker[]]
    // 該当会社の給与計算対象者: ベトナム人全員 ＋ 日本人は日額か月給がある人（事務の時給者・未設定者は載せない）。
    //   出向中（出向先が支給）は1人ずつのページには載せない。並びはベトナム人 → 日本人、各 id 順
    //   2026-10-02 総合点検: 出向者は月次集計Excelには 🔁 付きで載っているので、表紙に人数と金額を出して
    //   Excel の小計と突き合わせられるようにする（旧: 表紙の支給合計と Excel の小計が黙って食い違っていた）
    const isVn = (w: PayrollAuditWorker) => !!w.visa && w.visa !== 'none'
    const all = data.workers
      .filter(w => (org === 'hibi' ? w.org === 'hibi' : w.org === 'hfu'))
      .filter(w => isVn(w) || w.rate > 0 || (w.salary || 0) > 0)
      .sort((a, b) => (isVn(a) === isVn(b) ? a.id - b.id : isVn(a) ? -1 : 1))
    return [all.filter(w => !w.isDispatched), all.filter(w => !!w.isDispatched)]
  }, [data, org])

  // 締め前か（Excel の markUnconfirmedWorkbook と同じく、その会社の締め状態で判定・2026-10-02）
  const unconfirmed = !!data && !(org === 'hibi' ? data.lockedHibi : data.lockedHfu)

  // 集計値
  const summary = useMemo(() => {
    const total = targetWorkers.reduce((s, w) => s + (w.salaryNetPay || 0), 0)
    const dispatchedTotal = dispatchedWorkers.reduce((s, w) => s + (w.salaryNetPay || 0), 0)
    const vn = targetWorkers.filter(w => !!w.visa && w.visa !== 'none')
    const jpCount = targetWorkers.length - vn.length
    const newRulesCount = vn.filter(w => !w.useOldRules && ym >= '202605').length
    const oldRulesCount = vn.length - newRulesCount
    // 2026-08-27 修正（給与総点検）: 自動検算は新ルール(202605〜)専用。
    //   4月以前に当てると旧ルールの構成（fixedBasePay なし・1.25倍残業）が
    //   全員「違反」と誤検知され、社労士PDFの表紙に赤字で印刷されていた
    const validation = ym >= '202605'
      ? validatePayrolls(targetWorkers as unknown as PayrollSnapshot[])
      : { total: 0, critical: 0, warning: 0, issues: [], affectedWorkerIds: [] }
    const warningOnly = validation.critical === 0 && validation.warning > 0
    return { total, dispatchedTotal, vnCount: vn.length, jpCount, newRulesCount, oldRulesCount, validation, warningOnly }
  }, [targetWorkers, dispatchedWorkers, ym])

  // タイトル（ブラウザの Save as PDF デフォルトファイル名に反映）。締め前は【未確定】を頭に付ける（Excel のファイル名と同じ印）
  useEffect(() => {
    const orgLabel = org === 'hibi' ? '日比建設' : 'HFU'
    document.title = `${unconfirmed ? '【未確定】' : ''}給与計算監査_${orgLabel}_${ym}`
  }, [org, ym, unconfirmed])

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
  // 2026-06-12 修正 (監査): 作成日が文字列「本日」のまま印刷されていた。クライアント側で実日付を整形
  const now = new Date()
  const today = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`

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
          {unconfirmed && (
            <div className="border-2 border-red-500 bg-red-50 text-red-800 rounded-lg p-3 mb-4 text-center">
              <div className="text-xl font-bold">未確定（締め前）</div>
              <div className="text-xs mt-1">{yearMonthLabel}分の{orgLabel.replace('株式会社', '')}はまだ締めていません。数字は変わることがあります。この資料はキャシュモへ送らず、締めたあとに出し直してください</div>
            </div>
          )}
          <div className="text-center mb-8 pt-12">
            <h1 className="text-3xl font-bold text-hibi-navy mb-2">給与計算 監査資料{unconfirmed ? '【未確定】' : ''}</h1>
            <p className="text-sm text-gray-500">キャシュモ提出用（給与計算の根拠）・社労士確認用</p>
          </div>
          <div className="border-2 border-hibi-navy rounded-lg p-6 max-w-md mx-auto bg-blue-50/30">
            <table className="w-full text-sm">
              <tbody className="[&_td]:py-2 [&_td:first-child]:text-gray-600 [&_td:first-child]:w-1/3">
                <tr><td>会社</td><td className="font-bold">{orgLabel}</td></tr>
                <tr><td>対象月</td><td className="font-bold">{yearMonthLabel}分</td></tr>
                <tr><td>対象者</td><td className="font-bold">{targetWorkers.length}名<span className="font-normal text-gray-600 text-xs ml-2">ベトナム人 {summary.vnCount}名{summary.jpCount > 0 ? ` ／ 日本人 ${summary.jpCount}名` : ''}</span></td></tr>
                <tr><td>作成日</td><td className="font-mono">{today}</td></tr>
              </tbody>
            </table>
          </div>

          <div className="mt-6 max-w-md mx-auto">
            <h3 className="font-bold text-hibi-navy mb-2 border-b border-gray-300 pb-1">支給概要</h3>
            <table className="w-full text-sm">
              <tbody className="[&_td]:py-1.5 [&_td:first-child]:text-gray-600 [&_td:first-child]:w-1/2">
                <tr><td>支給合計</td><td className="font-mono font-bold text-base">{fmtYen(summary.total)}</td></tr>
                {dispatchedWorkers.length > 0 && (
                  <tr>
                    <td>出向者（🔁・この資料には載せない）</td>
                    <td>
                      {dispatchedWorkers.length}名 <span className="font-mono">{fmtYen(summary.dispatchedTotal)}</span>
                      <div className="text-3xs text-gray-500">{dispatchedWorkers.map(w => `${w.name}（${w.dispatchTo || '出向'}）`).join('、')}。月次集計Excel の小計には含まれる（出向者込み {fmtYen(summary.total + summary.dispatchedTotal)}）。支給元は代表に確認</div>
                    </td>
                  </tr>
                )}
                {summary.newRulesCount > 0 && <tr><td>ベトナム人・新ルール（変形労働時間制）</td><td>{summary.newRulesCount}名</td></tr>}
                {summary.oldRulesCount > 0 && <tr><td>ベトナム人・旧ルール継続（固定月給）</td><td>{summary.oldRulesCount}名</td></tr>}
                {summary.jpCount > 0 && <tr><td>日本人（日給月給・完全月給・役員）</td><td>{summary.jpCount}名</td></tr>}
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
              // 2026-10-02: 注意点（warning・支給額は変えない）だけなら黄色で「注意点」と書く（旧: 全部「違反」で赤字）
              <div className={`rounded-lg p-3 text-sm border ${summary.warningOnly ? 'bg-amber-50 border-amber-300' : 'bg-red-50 border-red-300'}`}>
                <div className={`font-bold ${summary.warningOnly ? 'text-amber-800' : 'text-red-800'}`}>
                  ⚠ {summary.validation.affectedWorkerIds.length}名で {summary.validation.total}件の{summary.warningOnly ? '注意点（支給額には入れていません。各ページの「注意点」を確認）' : `検出（critical ${summary.validation.critical} / 注意点 ${summary.validation.warning}）`}
                </div>
                <ul className={`text-xs mt-2 space-y-1 ${summary.warningOnly ? 'text-amber-800' : 'text-red-700'}`}>
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
            計算ロジック: lib/compute.ts（ベトナム人: calculateVietnameseSalary／日本人: 日給月給・完全月給ブランチ）<br/>
            検算ロジック: lib/payroll-validator.ts (validatePayrolls)<br/>
            ※ ベトナム人は1ヶ月単位変形労働時間制（労基法32条の2）に基づき計算。日本人は日額×人工（日給月給）または月給固定（完全月給）
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
                    {unconfirmed && <span className="bg-red-600 text-white text-xs px-2 py-0.5 rounded mr-2 align-middle">未確定（締め前）</span>}
                    {worker.name}
                    <span className="ml-2 text-xs opacity-80">
                      ({worker.org === 'hfu' ? 'HFU' : '日比建設'}) — ID:{worker.id}{worker.payrollNo ? ` — 従業員番号:${worker.payrollNo}` : ''}
                    </span>
                  </div>
                </div>

                {/* 給与計算の根拠 */}
                <PayrollAuditContent
                  worker={worker}
                  ym={ym}
                  prescribedDays={data.prescribedDays || data.workDays || 0}
                  baseDays={data.baseDays ?? 20}
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
