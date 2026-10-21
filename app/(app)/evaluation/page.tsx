'use client'

// 2026-10-03: ブラウザ標準の confirm/alert を共通部品（confirmDialog・notify・FieldError）に置き換え
// 2026-10-03: モーダルの枠と保存ボタンを共通部品（Modal・SaveButton）にそろえた
// 2026-10-03: 飾りの絵文字を外した（線のアイコンか文字に）
import { useEffect, useState, useCallback } from 'react'
import { readAuth } from '@/lib/hooks/useAuthPassword'
import { fetchWithAuth } from '@/lib/api-client'
import { useSearchParams } from 'next/navigation'
import {
  Worker,
  ABCGrade,
  EvaluationSessionStatus,
  EvaluationRank,
  EvaluationScores,
  EvaluationMetrics,
  EvaluationReview,
  Evaluation,
  AuthUser,
} from '@/types'
import { fmtYen } from '@/lib/format'
import WorkerAvatar from '@/components/WorkerAvatar'
import { PageHeader, ToolButton, UnderlineTabs, TodoCard, Segment, SearchBox, Chip, SidePanel, CloseButton, FieldError, type ChipTone } from '@/components/ui/PageParts'
import { Modal, CancelButton } from '@/components/ui/Modal'
import { SaveButton } from '@/components/ui/SaveButton'
import { confirmDialog } from '@/lib/confirm-dialog'
import { notify } from '@/lib/notify'
import { useWorkerPhotos } from '@/lib/hooks/useWorkerPhotos'
import { todayJstIso, addMonthsSafe } from '@/lib/date-utils'
import { isAlreadyRetired } from '@/lib/workers'
import { can } from '@/lib/permissions'
import { notifyBulkResult, rankColor, VISA_LABELS, nextEvalDate, hasBeenEvaluated, sessionStatusLabel, EVAL_ITEMS, CATEGORY_INFO, getScoreValue, setScoreValue, EVALUATOR_COLORS, isCategoryInScope, computePrefillScores, evaluatorNameLookup, fmtDateShort, daysSince, EV_COLS, EMPTY_SCORES, type TabId, type EvState, type EvFilter } from '@/lib/evaluation-view'
import { ABCRadio } from '@/components/evaluation/ABCRadio'
import { GradeBadge } from '@/components/evaluation/GradeBadge'
import { EVALUATION_CATEGORIES } from '@/lib/evaluation-criteria'
import { Icon } from '@/components/ui/Icon'
// 注意: 評価ロジック（重み・テーブル・計算関数）は lib/evaluation-config.ts に集約。
//   フロント・バックエンドで重複して定義すると過去のような不整合が再発する。
//   修正時は必ず lib/evaluation-config.ts だけを編集すること。
import {
  calculateManualScore,
  calculateRank,
  getRaiseAmount,
  applyLegalWageFloor,
  yearsFromHire as yearsFromDate,
} from '@/lib/evaluation-config'
import { minWageAt } from '@/lib/wage-analysis'

/** 一括再計算の結果の帯（更新・対象外・できなかった件数） */
import { useEvaluationPage } from './useEvaluationPage'
import { EvaluatorBadgeList } from './components/EvaluatorBadgeList'
import { SessionDetailView } from './components/SessionDetailView'
import { ListTab } from './components/ListTab'
import { ReviewTab } from './components/ReviewTab'
import { ApproveTab } from './components/ApproveTab'
import { MonitorTab } from './components/MonitorTab'
import { HistoryTab } from './components/HistoryTab'

/**
 * 評価管理の画面（2026-10-21 総点検 §7-2 で分割）。
 * 状態・読み込み・処理は useEvaluationPage.tsx、タブごとの見た目は components/*Tab.tsx、純粋な関数は lib/evaluation-view.ts。
 */
export default function EvaluationPage() {
  const ctx = useEvaluationPage()
  const { loading, setActiveTab, evaluations, detailSessionId, setDetailSessionId, recalculatingWeights, submitSuccess, setSubmitSuccess, handleRecalculateAllWeights, handleRecalculateAllMetrics, isAdmin, tabs, visibleTabs, effectiveTab, openCreate } = ctx

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500" />
      </div>
    )
  }

  return (
    <div className="max-w-7xl mx-auto space-y-5">
      <PageHeader
        group="賃金・評価"
        title="評価管理"
        sub="ベトナム人スタッフの年次評価。入社記念日ごとに評価して、時給を改定します"
        actions={isAdmin && effectiveTab === 'list' ? <>
          <ToolButton icon="chart" onClick={handleRecalculateAllMetrics} disabled={recalculatingWeights} title="進行中の評価の出勤率・残業平均・ボーナスを計算し直します">
            {recalculatingWeights ? '計算中...' : '出勤の指標を計算し直す'}
          </ToolButton>
          <ToolButton icon="users" onClick={handleRecalculateAllWeights} disabled={recalculatingWeights} title="進行中の評価の、評価者ごとの重みを出面から計算し直します">
            {recalculatingWeights ? '計算中...' : '評価者の重みを計算し直す'}
          </ToolButton>
          <button onClick={() => openCreate(null)}
            className="h-[42px] px-4 rounded-[10px] bg-hibi-navy text-white text-[0.9375rem] font-bold hover:bg-hibi-light inline-flex items-center gap-1.5">
            <span className="text-lg leading-none">＋</span>評価を始める
          </button>
        </> : undefined}
      />

      {/* 提出成功トースト — 8秒で自動フェード */}
      {submitSuccess && (
        <div className="sticky top-2 z-40 mb-4 animate-fadeIn">
          <div className="bg-green-500 dark:bg-green-600 text-white rounded-xl shadow-lg p-4 flex items-center gap-3">
            <div className="flex-shrink-0 w-10 h-10 rounded-full bg-white/20 flex items-center justify-center text-2xl font-bold">
              ✓
            </div>
            <div className="flex-1">
              <p className="font-bold text-base">
                {submitSuccess.workerName} さんの評価を{submitSuccess.isEdit ? '修正' : '提出'}しました
              </p>
              <p className="text-xs text-green-50 mt-0.5 opacity-90">
                {new Date(submitSuccess.at).toLocaleString('ja-JP')} に保存完了
              </p>
            </div>
            <button
              onClick={() => setSubmitSuccess(null)}
              className="flex-shrink-0 text-white/80 hover:text-white text-sm px-2 py-1 rounded hover:bg-white/10"
              aria-label="閉じる"
            >
              ×
            </button>
          </div>
        </div>
      )}

      <UnderlineTabs label="評価管理のタブ" active={effectiveTab} onChange={setActiveTab}
        tabs={visibleTabs.map(t => ({ key: t.id, label: t.label }))} />

      {/* ═══════════════════════════════════════ */}
      {/* Tab 1: 一覧 (List)                      */}
      {/* ═══════════════════════════════════════ */}
      {effectiveTab === 'list' &&  <ListTab ctx={ctx} />}

      {/* ═══════════════════════════════════════ */}
      {/* Tab 2: 評価入力 (My Review)              */}
      {/* ═══════════════════════════════════════ */}
      {effectiveTab === 'review' &&  <ReviewTab ctx={ctx} />}

      {/* ═══════════════════════════════════════ */}
      {/* Tab 3: 承認 (Approval) - admin only      */}
      {/* ═══════════════════════════════════════ */}
      {effectiveTab === 'approve' && isAdmin &&  <ApproveTab ctx={ctx} />}

      {/* ═══════════════════════════════════════ */}
      {/* Tab 4: 進捗監視 (Monitor) — admin only   */}
      {/* ═══════════════════════════════════════ */}
      {effectiveTab === 'monitor' && isAdmin &&  <MonitorTab ctx={ctx} />}

      {/* ═══════════════════════════════════════ */}
      {/* Tab 5: 履歴 (History) — admin only       */}
      {/* ═══════════════════════════════════════ */}
      {effectiveTab === 'history' && isAdmin &&  <HistoryTab ctx={ctx} />}

      {/* ═══════════════════════════════════════ */}
      {/* Detail Modal — どのタブからも開ける         */}
      {/* ═══════════════════════════════════════ */}
      {detailSessionId && (() => {
        const session = evaluations.find(e => e.id === detailSessionId)
        if (!session) return null
        return (
          <Modal
            open
            onClose={() => setDetailSessionId(null)}
            title="評価セッション詳細"
            size="xl"
            footer={<CancelButton onClick={() => setDetailSessionId(null)}>閉じる</CancelButton>}
          >
            <SessionDetailView ctx={ctx} session={session} />
          </Modal>
        )
      })()}
    </div>
  )
}

