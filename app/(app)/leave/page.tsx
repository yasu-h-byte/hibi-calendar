'use client'

// 休暇管理ページ（司令塔）
// データ取得・共有状態・タブ切替を担当し、各タブ・モーダルの表示は
// components/ 配下の部品に委譲する。純粋な計算は lib/leave-utils.ts を参照。
// 保守操作（繰越再計算・正規化・時効処理・手動付与の入口）は components/leave/MaintenanceButton に集約済み。

import { useEffect, useState, useCallback } from 'react'
import { permRoleOf, roleCan } from '@/lib/permissions'
import MaintenanceButton from '@/components/leave/MaintenanceButton'
import { PLWorker, OrgFilter, LeaveTab, HomeLeave, PendingGrant, PendingGrantForm, LeaveRequest, SiteOption, MforemanMap } from './types'
import { PageHeader, ToolButton, UnderlineTabs, Segment } from '@/components/ui/PageParts'
import ListTab from './components/ListTab'
import GrantDatesTab from './components/GrantDatesTab'
import RequestsTab, { RequestsUiState, initialRequestsUi } from './components/RequestsTab'
import MonthlyTab from './components/MonthlyTab'
import CalendarTab from './components/CalendarTab'
import HomeLeaveTab, { HomeLeaveUiState, initialHomeLeaveUi } from './components/HomeLeaveTab'
import GrantModal from './components/GrantModal'
import EditModal from './components/EditModal'
import BuyoutModal from './components/BuyoutModal'
import DesignateModal from './components/DesignateModal'
import PendingGrantsModal from './components/PendingGrantsModal'
import DetailPanel from './components/DetailPanel'
import { useWorkerPhotos } from '@/lib/hooks/useWorkerPhotos'
import { todayJstIso } from '@/lib/date-utils'

export default function LeavePage() {
  const [password, setPassword] = useState('')
  const [userRole, setUserRole] = useState<string>('')
  const [userForemanSites, setUserForemanSites] = useState<string[]>([])
  const [workers, setWorkers] = useState<PLWorker[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [orgFilter, setOrgFilter] = useState<OrgFilter>('all')
  const [activeTab, setActiveTab] = useState<LeaveTab>('list')
  // 残数の基準日（空=今日）。月末残高の突合用（例: 6月末を指定して「6月末時点の残数」を見る）
  const [asOfDate, setAsOfDate] = useState<string>('')

  // データ
  const [plCalendar, setPlCalendar] = useState<Record<string, number[]>>({})
  const [workerNames, setWorkerNames] = useState<Record<number, string>>({})
  const [homeLeaves, setHomeLeaves] = useState<HomeLeave[]>([])
  const [leaveRequests, setLeaveRequests] = useState<LeaveRequest[]>([])
  const [sites, setSites] = useState<SiteOption[]>([])
  // mforeman: 月別職長オーバーライド ("siteId_ym" -> { wid: workerId })
  const [mforeman, setMforeman] = useState<MforemanMap>({})
  const [pendingGrants, setPendingGrants] = useState<PendingGrant[]>([])
  const [pendingForm, setPendingForm] = useState<PendingGrantForm>({})

  // モーダル開閉
  const [showGrantModal, setShowGrantModal] = useState(false)
  const [editWorker, setEditWorker] = useState<PLWorker | null>(null)
  const [buyoutWorker, setBuyoutWorker] = useState<PLWorker | null>(null)
  const [designate, setDesignate] = useState<{ worker: PLWorker; kind: 'designation' | 'manual-entry' } | null>(null)
  const [pendingModal, setPendingModal] = useState(false)
  // 一人の詳細（一覧の行を押すと右から開く・2026-10-01）。再取得後も最新の値を出すため id で持つ
  const [detailId, setDetailId] = useState<number | null>(null)
  const { photos } = useWorkerPhotos()

  // タブ内UI状態（データ再取得で消えないよう親で保持）
  const [requestsUi, setRequestsUi] = useState<RequestsUiState>(initialRequestsUi)
  const patchRequestsUi = useCallback((patch: Partial<RequestsUiState>) => setRequestsUi(prev => ({ ...prev, ...patch })), [])
  const [homeLeaveUi, setHomeLeaveUi] = useState<HomeLeaveUiState>(initialHomeLeaveUi)
  const patchHomeLeaveUi = useCallback((patch: Partial<HomeLeaveUiState>) => setHomeLeaveUi(prev => ({ ...prev, ...patch })), [])

  useEffect(() => {
    const stored = localStorage.getItem('hibi_auth')
    if (stored) {
      const parsed = JSON.parse(stored)
      setPassword(parsed.password)
      setUserRole(parsed.user?.role || '')
      setUserForemanSites(parsed.user?.foremanSites || [])
    }
  }, [])

  // ?tab=homeleave などURLパラメータでタブ初期表示を制御
  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    const tab = params.get('tab')
    if (tab === 'list' || tab === 'grantdates' || tab === 'requests' || tab === 'monthly' || tab === 'calendar' || tab === 'homeleave') {
      setActiveTab(tab)
    }
  }, [])

  const fetchData = useCallback(async () => {
    if (!password) return
    setLoading(true)
    setError('')
    try {
      const [res, reqRes, siteRes, pendRes, hlRes] = await Promise.all([
        fetch(`/api/leave?calendar=true${asOfDate ? `&asOf=${asOfDate}` : ''}`, { headers: { 'x-admin-password': password } }),
        fetch('/api/leave-request', { headers: { 'x-admin-password': password } }),
        fetch('/api/sites', { headers: { 'x-admin-password': password } }),
        fetch('/api/leave', {
          method: 'POST',
          headers: { 'x-admin-password': password, 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'getPendingGrants' }),
        }),
        fetch('/api/home-leave', { headers: { 'x-admin-password': password } }),
      ])
      if (hlRes.ok) {
        const d = await hlRes.json()
        setHomeLeaves(d.homeLeaves || [])
      }
      if (res.ok) {
        const data = await res.json()
        setWorkers(data.workers || [])
        setPlCalendar(data.plCalendar || {})
        setWorkerNames(data.workerNames || {})
      } else {
        setError('データの取得に失敗しました')
      }
      if (reqRes.ok) {
        const d = await reqRes.json()
        setLeaveRequests(d.requests || [])
      }
      if (siteRes.ok) {
        const d = await siteRes.json()
        setSites(d.sites || [])
        setMforeman(d.mforeman || {})
      }
      if (pendRes.ok) {
        const d = await pendRes.json()
        const list = (d.pending || []) as PendingGrant[]
        setPendingGrants(list)
        // フォーム初期値: 注意フラグが立っているワーカーは「デフォルト外す」（管理者に確認を促す）
        const form: PendingGrantForm = {}
        list.forEach(p => {
          form[p.workerId] = {
            grantDate: p.nextGrantDate,
            grantDays: String(p.legalDays || 10),
            include: !p.needsAttention,
          }
        })
        setPendingForm(form)
      }
    } catch {
      setError('通信エラーが発生しました')
    } finally {
      setLoading(false)
    }
  }, [password, asOfDate])

  useEffect(() => { fetchData() }, [fetchData])

  const filteredWorkers = orgFilter === 'all'
    ? workers
    : workers.filter(w => orgFilter === 'hfu' ? w.org === 'hfu' : w.org !== 'hfu')

  if (loading) return <div className="flex items-center justify-center py-20"><div className="text-gray-400">読み込み中...</div></div>
  if (error) return <div className="max-w-5xl mx-auto py-10"><div className="bg-red-50 border border-red-200 rounded-xl p-4 text-center text-red-700">{error}</div></div>

  const pendingCount = leaveRequests.filter(r => r.status === 'pending').length
  // 承認待ち＝職長承認待ち＋最終承認待ち（「今やること」のカード用）
  const awaitingCount = leaveRequests.filter(r => r.status === 'pending' || r.status === 'foreman_approved').length

  return (
    <div className="max-w-7xl mx-auto space-y-5">
      <PageHeader
        group="出面・勤怠"
        title="休暇管理"
        actions={<>
          {/* 2026-06-XX 改善: 「+ 有給付与」緑ボタンを🔧メニュー内へ移動
              - 通常運用は「🌴 半自動付与バナー」が main flow
              - 手動付与は例外オペレーションなので 🔧メニュー > 例外オペレーション に隠す
              - これにより主動線（半自動）を明確化し、誤操作リスクを削減 */}
          <MaintenanceButton
            password={password}
            onChanged={fetchData}
            onOpenGrantModal={() => setShowGrantModal(true)}
          />
          <ToolButton icon="download" title="労基法施行規則24条の7準拠の有給管理簿をExcelで出力" onClick={async () => {
            const res = await fetch('/api/leave/export-ledger', {
              headers: { 'x-admin-password': password },
            })
            if (!res.ok) { alert('管理簿の出力に失敗しました'); return }
            const blob = await res.blob()
            const url = URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = url
            a.download = `有給管理簿_${todayJstIso().replace(/-/g, '')}.xlsx`
            a.click()
            URL.revokeObjectURL(url)
          }}>管理簿（Excel）</ToolButton>
        </>}
      />

      {/* タブ（2026-10-01: 下線タブに。絵文字はやめる） */}
      <UnderlineTabs
        label="休暇管理のタブ"
        active={activeTab}
        onChange={setActiveTab}
        tabs={[
          { key: 'list', label: '有給' },
          { key: 'requests', label: '申請', badge: pendingCount },
          { key: 'calendar', label: 'カレンダー' },
          { key: 'monthly', label: '月別' },
          { key: 'grantdates', label: '付与日' },
          { key: 'homeleave', label: '帰国' },
        ]}
      />

      {/* Org filter (一覧・基準日タブ) + 残数の基準日（一覧タブのみ） */}
      {(activeTab === 'list' || activeTab === 'grantdates') && (
        <div className="flex flex-wrap items-center gap-3">
          {/* 有給タブは中で「日本人／外国人・日比／HFU」に分けるので、所属の切り替えは付与日タブだけ */}
          {activeTab === 'grantdates' && (
            <Segment value={orgFilter} onChange={setOrgFilter} items={[['all', '全員'], ['hibi', '日比建設'], ['hfu', 'HFU']]} />
          )}
          {activeTab === 'list' && (
            <div className="flex items-center gap-2 bg-white dark:bg-gray-800 border border-hibi-line dark:border-gray-700 rounded-lg px-3 py-1.5">
              <span className="text-xs font-bold text-gray-500 dark:text-gray-400 whitespace-nowrap">残数の基準日</span>
              <input
                type="date"
                value={asOfDate}
                onChange={e => setAsOfDate(e.target.value)}
                className="text-sm bg-transparent text-hibi-navy dark:text-white outline-none"
                title="この日「時点」の残数を表示します（月末残高の突合用）。空欄=今日時点。"
              />
              {asOfDate ? (
                <button onClick={() => setAsOfDate('')}
                  className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 whitespace-nowrap">
                  今日に戻す
                </button>
              ) : (
                <span className="text-[10px] text-gray-400 whitespace-nowrap">今日時点</span>
              )}
            </div>
          )}
        </div>
      )}

      {/* タブ本体（常時マウント・visibleで表示切替） */}
      <RequestsTab
        visible={activeTab === 'requests'}
        leaveRequests={leaveRequests}
        sites={sites}
        mforeman={mforeman}
        workerNames={workerNames}
        password={password}
        userRole={userRole}
        userForemanSites={userForemanSites}
        ui={requestsUi}
        patchUi={patchRequestsUi}
        onRefresh={fetchData}
      />
      <ListTab
        visible={activeTab === 'list'}
        workers={workers}
        loading={loading}
        onEdit={w => setDetailId(w.id)}
        asOfDate={asOfDate}
        pendingGrants={pendingGrants}
        pendingRequestCount={awaitingCount}
        onOpenPendingGrants={() => setPendingModal(true)}
        onOpenRequests={() => setActiveTab('requests')}
      />
      <GrantDatesTab
        visible={activeTab === 'grantdates'}
        filteredWorkers={filteredWorkers}
      />
      <MonthlyTab
        visible={activeTab === 'monthly'}
        filteredWorkers={filteredWorkers}
        orgFilter={orgFilter}
      />
      <CalendarTab
        visible={activeTab === 'calendar'}
        plCalendar={plCalendar}
        workerNames={workerNames}
      />
      <HomeLeaveTab
        visible={activeTab === 'homeleave'}
        homeLeaves={homeLeaves}
        workers={workers}
        password={password}
        ui={homeLeaveUi}
        patchUi={patchHomeLeaveUi}
        onRefresh={fetchData}
        canDelete={roleCan(permRoleOf({ role: userRole }), 'homeLeave.delete')}
      />

      {/* 一人の詳細（見るだけ。直す・時季指定・買取は既存のモーダルを開く） */}
      {(() => {
        // 直す・時季指定・買取のモーダルを開いている間は隠す（閉じると最新の値で戻ってくる）
        const modalOpen = !!editWorker || !!buyoutWorker || !!designate
        const dw = detailId !== null && !modalOpen ? workers.find(w => w.id === detailId) : undefined
        return dw ? (
          <DetailPanel
            worker={dw}
            photo={photos[String(dw.id)]}
            onClose={() => setDetailId(null)}
            onEdit={w => setEditWorker(w)}
            onDesignate={w => setDesignate({ worker: w, kind: 'designation' })}
            onBuyout={w => setBuyoutWorker(w)}
          />
        ) : null
      })()}

      {/* モーダル */}
      <GrantModal
        open={showGrantModal}
        workers={workers}
        password={password}
        onClose={() => setShowGrantModal(false)}
        onSaved={() => { setShowGrantModal(false); fetchData() }}
      />
      {editWorker && (
        <EditModal
          worker={editWorker}
          password={password}
          onClose={() => setEditWorker(null)}
          onSaved={() => { setEditWorker(null); fetchData() }}
          onOpenDesignate={w => setDesignate({ worker: w, kind: 'manual-entry' })}
          onOpenBuyout={w => setBuyoutWorker(w)}
        />
      )}
      {buyoutWorker && (
        <BuyoutModal
          worker={buyoutWorker}
          password={password}
          onClose={() => setBuyoutWorker(null)}
          onSuccess={() => { setBuyoutWorker(null); setEditWorker(null); fetchData() }}
        />
      )}
      {designate && (
        <DesignateModal
          worker={designate.worker}
          kind={designate.kind}
          sites={sites}
          password={password}
          onClose={() => setDesignate(null)}
          onSuccess={() => { setDesignate(null); setEditWorker(null); fetchData() }}
        />
      )}
      <PendingGrantsModal
        open={pendingModal}
        pendingGrants={pendingGrants}
        pendingForm={pendingForm}
        setPendingForm={setPendingForm}
        password={password}
        onClose={() => setPendingModal(false)}
        onSaved={() => { setPendingModal(false); fetchData() }}
      />
    </div>
  )
}
