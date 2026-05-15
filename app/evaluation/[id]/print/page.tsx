'use client'

/**
 * 個人評価表 A4印刷ページ（2026-05-15 追加）
 *
 * ブラウザの「印刷」機能でA4縦1枚に出力する。PDFとして保存も可能。
 * - URL: /evaluation/{evaluationId}/print
 * - `(app)` グループ外に配置してサイドバーを表示しない
 * - 評価詳細モーダルや承認画面から「🖨 A4印刷」ボタンで開く
 *
 * 印刷最適化:
 *   - @page A4 portrait
 *   - 余白 12mm
 *   - 文字サイズ調整・カラーインク量抑制
 *   - 印刷時は header/footer も適切に表示
 */

import { useEffect, useState, useRef } from 'react'
import { useParams, useRouter } from 'next/navigation'
import type { Evaluation, EvaluationScores, EvaluationReview, ABCGrade } from '@/types'
import { EVALUATION_CATEGORIES } from '@/lib/evaluation-criteria'

interface WorkerInfo {
  id: number
  name: string
  org: string
  visa: string
  job: string
  hireDate: string
}

interface EvaluatorInfo {
  id: number
  name: string
  job: string
}

const VISA_LABELS: Record<string, string> = {
  none: '日本人',
  jisshu1: '実習1号', jisshu2: '実習2号', jisshu3: '実習3号',
  tokutei1: '特定1号', tokutei2: '特定2号',
  jisshu: '技能実習', tokutei: '特定技能',
}

function getScoreValue(scores: EvaluationScores | undefined, category: string, key: string): ABCGrade | '-' {
  if (!scores) return '-'
  const cat = (scores as unknown as Record<string, Record<string, ABCGrade>>)[category]
  if (!cat) return '-'
  return cat[key] || '-'
}

function yearsFromHire(hireDate: string): number {
  if (!hireDate) return 0
  const hire = new Date(hireDate)
  const now = new Date()
  let y = now.getFullYear() - hire.getFullYear()
  const m = now.getMonth() - hire.getMonth()
  if (m < 0 || (m === 0 && now.getDate() < hire.getDate())) y--
  return Math.max(0, y)
}

function fmtDate(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
}

// 各評価者がそのカテゴリを評価する範囲か判定（スコープ分担）
function isCategoryInScope(evaluatorId: number, categoryKey: string): boolean {
  const isAdmin = evaluatorId === 0
  const isLiving = categoryKey === 'living'
  if (isLiving && !isAdmin) return false
  if (!isLiving && isAdmin) return false
  return true
}

export default function PrintEvaluationPage() {
  const params = useParams()
  const router = useRouter()
  const evaluationId = params.id as string
  const [evaluation, setEvaluation] = useState<Evaluation | null>(null)
  const [worker, setWorker] = useState<WorkerInfo | null>(null)
  const [evaluators, setEvaluators] = useState<EvaluatorInfo[]>([])
  const [error, setError] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const printed = useRef(false)

  useEffect(() => {
    const stored = typeof window !== 'undefined' ? localStorage.getItem('hibi_auth') : null
    if (!stored) {
      router.replace('/')
      return
    }
    const { password } = JSON.parse(stored)
    ;(async () => {
      try {
        const res = await fetch('/api/evaluation', { headers: { 'x-admin-password': password } })
        if (!res.ok) {
          setError('評価データの取得に失敗しました')
          setLoading(false)
          return
        }
        const data = await res.json()
        const ev = (data.evaluations as Evaluation[]).find(e => e.id === evaluationId)
        if (!ev) {
          setError('該当の評価が見つかりません')
          setLoading(false)
          return
        }
        const w = (data.workers as WorkerInfo[]).find(x => x.id === ev.workerId) || null
        setEvaluation(ev)
        setWorker(w)
        setEvaluators(data.evaluators || [])
        setLoading(false)
      } catch (e) {
        setError(`エラー: ${e instanceof Error ? e.message : String(e)}`)
        setLoading(false)
      }
    })()
  }, [evaluationId, router])

  // データ取得完了後、自動で印刷ダイアログを開く（1回のみ）
  useEffect(() => {
    if (!loading && evaluation && !printed.current) {
      printed.current = true
      // 少し待ってからブラウザ印刷を起動（CSSとフォントの読み込み待ち）
      const timer = setTimeout(() => window.print(), 400)
      return () => clearTimeout(timer)
    }
  }, [loading, evaluation])

  if (loading) {
    return <div className="p-8 text-center text-gray-500">読み込み中...</div>
  }
  if (error) {
    return <div className="p-8 text-center text-red-600">{error}</div>
  }
  if (!evaluation || !worker) return null

  const years = yearsFromHire(worker.hireDate)
  const tenureLabel = years > 0 ? `${years}年` : '1年未満'
  const orgLabel = worker.org === 'hfu' ? 'HFU' : '日比建設'
  const visaLabel = VISA_LABELS[worker.visa] || worker.visa
  const reviews: EvaluationReview[] = evaluation.reviews || []
  const weights = evaluation.evaluatorWeights || {}

  // 評価者並び順: 評価セッションに登録されている順
  const orderedEvaluatorIds = evaluation.evaluatorIds || []
  const evaluatorRows = orderedEvaluatorIds.map(id => ({
    id,
    name: evaluators.find(e => e.id === id)?.name || reviews.find(r => r.evaluatorId === id)?.evaluatorName || `ID:${id}`,
    weight: (weights as Record<number, { weight: number }>)[id]?.weight,
    review: reviews.find(r => r.evaluatorId === id),
  }))

  const metrics = evaluation.metrics
  const rank = evaluation.rank || '—'
  const raiseAmount = evaluation.raiseAmount ?? 0
  const totalScore = evaluation.totalScore ?? 0
  const manualScore = evaluation.manualScore ?? 0
  const bonus = metrics?.attendanceBonus ?? 0

  return (
    <>
      <style jsx global>{`
        @page {
          size: A4 portrait;
          margin: 12mm 10mm 10mm 10mm;
        }
        @media print {
          html, body { background: white !important; }
          .no-print { display: none !important; }
          .print-page {
            box-shadow: none !important;
            margin: 0 !important;
            padding: 0 !important;
            width: 100% !important;
            min-height: auto !important;
          }
        }
        body { background: #f5f5f5; }
        .print-page {
          width: 190mm;
          min-height: 275mm;
          margin: 12mm auto;
          padding: 6mm 8mm;
          background: white;
          box-shadow: 0 2px 8px rgba(0,0,0,0.1);
          font-family: -apple-system, "Hiragino Sans", "Noto Sans CJK JP", sans-serif;
          font-size: 9px;
          color: #1a1a1a;
          line-height: 1.35;
        }
        .print-page h1, .print-page h2 { margin: 0; }
        .print-page table { border-collapse: collapse; width: 100%; }
        .print-page th, .print-page td {
          border: 0.5px solid #555;
          padding: 1.5px 3px;
          text-align: center;
          vertical-align: middle;
        }
        .print-page th { background: #f0f0f0; font-weight: 600; }
        .grade-A { color: #1d4ed8; font-weight: 700; }
        .grade-B { color: #4b5563; }
        .grade-C { color: #b45309; font-weight: 700; }
        .grade-na { color: #ccc; }
        .rank-A { color: #1d4ed8; }
        .rank-B { color: #059669; }
        .rank-C { color: #d97706; }
        .rank-S { color: #7c3aed; }
        .rank-D { color: #dc2626; }
      `}</style>

      {/* 画面表示時のみ「印刷」ボタン */}
      <div className="no-print" style={{ position: 'fixed', top: 8, right: 8, display: 'flex', gap: 8, zIndex: 1000 }}>
        <button onClick={() => window.print()} style={{ padding: '6px 12px', background: '#1B2A4A', color: 'white', borderRadius: 4, fontSize: 13, border: 'none', cursor: 'pointer' }}>🖨 印刷</button>
        <button onClick={() => window.close()} style={{ padding: '6px 12px', background: '#aaa', color: 'white', borderRadius: 4, fontSize: 13, border: 'none', cursor: 'pointer' }}>閉じる</button>
      </div>

      <div className="print-page">
        {/* ── ヘッダ ── */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1.5px solid #1B2A4A', paddingBottom: 4, marginBottom: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo.png" alt="HIBI" style={{ height: 24 }} />
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1 }}>HIBI CONSTRUCTION</div>
              <div style={{ fontSize: 8, color: '#666' }}>鳶事業部</div>
            </div>
          </div>
          <h1 style={{ fontSize: 16, fontWeight: 700, color: '#1B2A4A' }}>個人評価表</h1>
          <div style={{ fontSize: 9, textAlign: 'right' }}>
            <div>評価日: {fmtDate(evaluation.evaluationDate)}</div>
            <div>承認日: {evaluation.approvedAt ? fmtDate(evaluation.approvedAt) : '—'}</div>
          </div>
        </div>

        {/* ── スタッフ情報 ── */}
        <table style={{ marginBottom: 6 }}>
          <tbody>
            <tr>
              <th style={{ width: '12%' }}>氏名</th>
              <td style={{ width: '22%', fontWeight: 700, fontSize: 11 }}>{evaluation.workerName}</td>
              <th style={{ width: '10%' }}>所属</th>
              <td style={{ width: '12%' }}>{orgLabel}</td>
              <th style={{ width: '12%' }}>在留資格</th>
              <td style={{ width: '12%' }}>{visaLabel}</td>
              <th style={{ width: '10%' }}>勤続年数</th>
              <td style={{ width: '10%' }}>{tenureLabel}</td>
            </tr>
            <tr>
              <th>入社日</th>
              <td colSpan={3}>{worker.hireDate || '—'}</td>
              <th>評価期間</th>
              <td colSpan={3}>過去12ヶ月（{evaluation.evaluationDate} 基準）</td>
            </tr>
          </tbody>
        </table>

        {/* ── 出勤指標 ── */}
        <table style={{ marginBottom: 6 }}>
          <tbody>
            <tr>
              <th style={{ width: '18%', background: '#dbeafe' }}>出勤率</th>
              <td>{metrics?.attendanceRate?.toFixed(1) ?? '—'}%</td>
              <th style={{ background: '#dbeafe' }}>残業平均/月</th>
              <td>{metrics?.overtimeAvg?.toFixed(1) ?? '—'}h</td>
              <th style={{ background: '#dbeafe' }}>有給取得</th>
              <td>{metrics?.plUsage ?? 0}日</td>
              <th style={{ background: '#dbeafe' }}>皆勤ボーナス</th>
              <td>{bonus > 0 ? `+${bonus}` : '0'}</td>
            </tr>
          </tbody>
        </table>

        {/* ── 評価表 ── */}
        <table style={{ marginBottom: 6 }}>
          <thead>
            <tr>
              <th style={{ width: '15%', background: '#e5e7eb' }}>カテゴリ</th>
              <th style={{ width: '20%', background: '#e5e7eb' }}>評価項目</th>
              {evaluatorRows.map(er => (
                <th key={er.id} style={{ background: '#fef9c3' }}>
                  <div style={{ fontSize: 9 }}>{er.name}</div>
                  {er.weight !== undefined && (
                    <div style={{ fontSize: 7, color: '#666', fontWeight: 400 }}>w={er.weight.toFixed(2)}</div>
                  )}
                </th>
              ))}
              <th style={{ background: '#dbeafe' }}>最終評価</th>
            </tr>
          </thead>
          <tbody>
            {EVALUATION_CATEGORIES.flatMap(cat =>
              cat.criteria.map((cri, idx) => (
                <tr key={`${cat.key}_${cri.key}`}>
                  {idx === 0 && (
                    <td rowSpan={cat.criteria.length} style={{ background: '#f3f4f6', fontWeight: 700 }}>
                      <div>{cat.icon} {cat.label}</div>
                      <div style={{ fontSize: 7, color: '#666', fontWeight: 400 }}>{cat.weightLabel}</div>
                    </td>
                  )}
                  <td style={{ textAlign: 'left', paddingLeft: 4 }}>{cri.label}</td>
                  {evaluatorRows.map(er => {
                    const inScope = isCategoryInScope(er.id, cat.key)
                    if (!inScope) {
                      return <td key={er.id} className="grade-na">—</td>
                    }
                    const g = getScoreValue(er.review?.scores, cat.key, cri.key)
                    return (
                      <td key={er.id} className={`grade-${g}`}>{g}</td>
                    )
                  })}
                  <td style={{ background: '#eff6ff' }}>
                    <span className={`grade-${getScoreValue(evaluation.finalScores, cat.key, cri.key)}`}>
                      {getScoreValue(evaluation.finalScores, cat.key, cri.key)}
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>

        {/* ── 最終結果 ── */}
        <table style={{ marginBottom: 6 }}>
          <tbody>
            <tr>
              <th style={{ width: '15%', background: '#dbeafe' }}>手動スコア</th>
              <td style={{ width: '12%' }}>{manualScore.toFixed(1)}</td>
              <th style={{ width: '13%', background: '#dbeafe' }}>＋ 皆勤ボーナス</th>
              <td style={{ width: '10%' }}>+{bonus}</td>
              <th style={{ width: '12%', background: '#dbeafe' }}>合計スコア</th>
              <td style={{ width: '10%', fontWeight: 700 }}>{totalScore.toFixed(1)}</td>
              <th style={{ width: '12%', background: '#fef3c7' }}>ランク</th>
              <td style={{ width: '8%' }}>
                <span className={`rank-${rank}`} style={{ fontSize: 18, fontWeight: 800 }}>{rank}</span>
              </td>
              <th style={{ width: '8%', background: '#fef3c7' }}>推奨昇給</th>
              <td style={{ fontWeight: 700 }}>+¥{raiseAmount}/h</td>
            </tr>
          </tbody>
        </table>

        {/* ── コメント ── */}
        <div style={{ marginTop: 6 }}>
          <div style={{ fontWeight: 700, marginBottom: 2, fontSize: 10, color: '#1B2A4A' }}>📝 評価者コメント</div>
          {evaluatorRows.filter(er => er.review?.comment).map(er => (
            <div key={er.id} style={{ marginBottom: 3, padding: 3, border: '0.5px solid #ddd', borderRadius: 2, background: '#fafafa' }}>
              <div style={{ fontSize: 8, fontWeight: 700, color: '#1B2A4A' }}>{er.name}</div>
              <div style={{ fontSize: 8, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: '#333' }}>
                {er.review!.comment}
              </div>
            </div>
          ))}
          {evaluation.finalComment && (
            <div style={{ marginTop: 4, padding: 4, border: '1px solid #1B2A4A', borderRadius: 2, background: '#eff6ff' }}>
              <div style={{ fontSize: 8, fontWeight: 700, color: '#1B2A4A' }}>★ 最終コメント（事業責任者）</div>
              <div style={{ fontSize: 8, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: '#1B2A4A' }}>
                {evaluation.finalComment}
              </div>
            </div>
          )}
        </div>

        {/* ── フッター ── */}
        <div style={{ marginTop: 'auto', paddingTop: 4, borderTop: '0.5px solid #ccc', fontSize: 7, color: '#888', textAlign: 'center', display: 'flex', justifyContent: 'space-between' }}>
          <span>HIBI CONSTRUCTION 鳶事業部</span>
          <span>評価ID: {evaluation.id}</span>
          <span>出力日時: {fmtDate(new Date().toISOString())}</span>
        </div>
      </div>
    </>
  )
}
