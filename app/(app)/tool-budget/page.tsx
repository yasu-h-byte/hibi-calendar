'use client'
// 2026-10-03: ブラウザ標準の confirm/alert を共通部品（confirmDialog・notify・FieldError）に置き換え
// 2026-10-03: モーダルの枠と保存ボタンを共通部品（Modal・SaveButton）にそろえた
// 2026-10-03: 行ごとの小さいボタンを RowButton にそろえた

import { useEffect, useState, useCallback } from 'react'
import { visaLabel } from '@/lib/labels'
import { jobLabel } from '@/lib/jobs'
import { confirmDialog, confirmDanger } from '@/lib/confirm-dialog'
import { notify } from '@/lib/notify'
import { PageHeader, ToolButton, TodoCard, Segment, SearchBox, Chip, SidePanel, CloseButton, RowButton } from '@/components/ui/PageParts'
import { SaveButton } from '@/components/ui/SaveButton'
import WorkerAvatar from '@/components/WorkerAvatar'
import { useWorkerPhotos } from '@/lib/hooks/useWorkerPhotos'
import { earliestReceiptDate } from '@/lib/tool-budget-period'
import { todayJstIso } from '@/lib/date-utils'
import { isToolSubsidyEligible, toolSubsidyCompanyAmount, TOOL_SUBSIDY_FROM, TOOL_SUBSIDY_ITEMS, type ToolSubsidyKind } from '@/lib/tool-subsidy'

interface Purchase {
  id: string
  date: string
  amount: number
  item: string
  registeredAt: string
  /** 残高を超えて登録した */
  over?: boolean
  /** 会社半額負担（2026-10-08）。company = 会社が負担した額 */
  subsidy?: { kind: ToolSubsidyKind; company: number }
}

interface Period {
  start: string
  end: string
  index: number
}

interface WorkerBudget {
  workerId: number
  workerName: string
  visa: string
  org: string
  hireDate?: string
  periodAnchor?: string | null
  period: Period | null
  notStarted?: boolean
  budget: number
  /** 前の期間からの繰越（2026-09-30）。マイナスは使いすぎの持ち越し */
  carry?: number
  /** この人の区分の既定額（API が区分別設定から算出） */
  defaultBudget?: number
  /** 枠から引いた額（会社半額負担の分は除く） */
  used: number
  /** この期間に会社が半額負担した額 */
  companyPaid?: number
  remaining: number
  purchases: Purchase[]
}

// visaLabel は lib/labels.ts に集約済み — import は上部

function formatPeriod(p: Period | null): string {
  if (!p) return '期間未設定'
  // 例: '2025-10-06' → '2025/10/6'（年付き・ゼロパディングなし）
  const fmt = (d: string) => {
    const [y, m, day] = d.split('-')
    return `${y}/${parseInt(m, 10)}/${parseInt(day, 10)}`
  }
  return `${fmt(p.start)} 〜 ${fmt(p.end)}`
}

function formatPeriodFull(p: Period | null): string {
  if (!p) return ''
  // 例: '2025-10-06' → '2025年10月6日'
  const fmt = (d: string) => {
    const [y, m, day] = d.split('-')
    return `${y}年${parseInt(m, 10)}月${parseInt(day, 10)}日`
  }
  return `${fmt(p.start)} 〜 ${fmt(p.end)}`
}

type TbFilter = 'all' | 'over' | 'low' | 'noperiod'
const TB_FILTER_LABEL: Record<Exclude<TbFilter, 'all'>, string> = { over: '使いすぎの人', low: '残りが少ない人', noperiod: '期間が決まっていない人' }
const TB_COLS = 'lg:grid-cols-[minmax(0,1fr)_100px_190px_minmax(0,1.2fr)_110px]'

export default function ToolBudgetPage() {
  const [password, setPassword] = useState('')
  const [workers, setWorkers] = useState<WorkerBudget[]>([])
  const [loading, setLoading] = useState(false)
  const [modalWorkerId, setModalWorkerId] = useState<number | null>(null)
  const [query, setQuery] = useState('')
  const [listFilter, setListFilter] = useState<TbFilter>('all')
  const [org, setOrg] = useState<'all' | 'hibi' | 'hfu'>('all')
  const { photos } = useWorkerPhotos()
  // 区分別の既定予算（2026-08-28 追加）。空欄 = 既定額を使う
  const [showBudgetSettings, setShowBudgetSettings] = useState(false)
  const [defaultBudget, setDefaultBudget] = useState('30000')
  const [budgetByVisa, setBudgetByVisa] = useState<Record<string, string>>({})
  const [budgetByJob, setBudgetByJob] = useState<Record<string, string>>({})

  useEffect(() => {
    try {
      const auth = localStorage.getItem('hibi_auth')
      if (auth) {
        const { password: pw } = JSON.parse(auth)
        setPassword(pw || '')
      }
    } catch { /* ignore */ }
  }, [])

  const fetchData = useCallback(async () => {
    if (!password) return
    setLoading(true)
    try {
      const res = await fetch('/api/tool-budget', {
        headers: { 'x-admin-password': password },
      })
      if (res.ok) {
        const data = await res.json()
        setWorkers(data.workers || [])
        setDefaultBudget(String(data.defaultBudget ?? 30000))
        setBudgetByVisa(Object.fromEntries(Object.entries(data.budgetByVisa || {}).map(([k, v]) => [k, String(v)])))
        setBudgetByJob(Object.fromEntries(Object.entries(data.budgetByJob || {}).map(([k, v]) => [k, String(v)])))
      }
    } catch { /* ignore */ }
    setLoading(false)
  }, [password])

  useEffect(() => { fetchData() }, [fetchData])

  const totalBudget = workers.reduce((s, w) => s + w.budget + (w.carry ?? 0), 0)
  const totalUsed = workers.reduce((s, w) => s + w.used, 0)
  const totalCompanyPaid = workers.reduce((s, w) => s + (w.companyPaid ?? 0), 0)
  const setupCount = workers.filter(w => w.period).length

  const companyGroups = [
    { key: 'hibi', label: '日比建設', bg: 'bg-blue-50', text: 'text-blue-800' },
    { key: 'hfu', label: 'HFU', bg: 'bg-purple-50', text: 'text-purple-800' },
  ]

  const currentWorker = modalWorkerId ? workers.find(w => w.workerId === modalWorkerId) || null : null

  // 今やること・絞り込み（2026-10-01 改修）
  const isLow = (w: WorkerBudget) => {
    const cap = w.budget + (w.carry ?? 0)
    return !!w.period && w.remaining >= 0 && cap > 0 && w.remaining < cap * 0.2
  }
  const overList = workers.filter(w => w.remaining < 0)
  const lowList = workers.filter(isLow).sort((a, b) => a.remaining - b.remaining)
  const noPeriod = workers.filter(w => !w.period)
  const totalRemaining = workers.reduce((s, w) => s + w.remaining, 0)
  const toggleFilter = (f: Exclude<TbFilter, 'all'>) => { setOrg('all'); setListFilter(listFilter === f ? 'all' : f) }
  const q = query.trim().replace(/[\s　]/g, '').toLowerCase()
  const shown = workers
    .filter(w => org === 'all' || w.org === org)
    .filter(w => listFilter === 'all' || (listFilter === 'over' ? w.remaining < 0 : listFilter === 'low' ? isLow(w) : !w.period))
    .filter(w => !q || w.workerName.replace(/[\s　]/g, '').toLowerCase().includes(q))

  // 数字だけ残して number 化。空欄はその区分の設定なし
  const toNumMap = (m: Record<string, string>) =>
    Object.fromEntries(Object.entries(m).filter(([, v]) => v.trim() !== '').map(([k, v]) => [k, Number(v)]))

  // 保存ボタン（SaveButton）の約束: うまくいったら何も返さない・サーバの断りは { ok: false, error }（ボタンが赤の帯を出す）
  const saveBudgetSettings = async () => {
    const res = await fetch('/api/tool-budget', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
      body: JSON.stringify({
        action: 'setDefaultBudget',
        defaultBudget: Number(defaultBudget) || 30000,
        budgetByVisa: toNumMap(budgetByVisa),
        budgetByJob: toNumMap(budgetByJob),
      }),
    })
    if (!res.ok) { const j = await res.json().catch(() => null); return { ok: false, error: j?.error || 'サーバが受け付けませんでした' } }
    await fetchData()
  }

  // 設定欄に出す区分。外国人はまとめキー（jisshu/tokutei）、日本人は現場職種
  const VISA_GROUPS = [
    { key: 'jisshu', label: '技能実習' },
    { key: 'tokutei', label: '特定技能' },
  ]
  const JOB_GROUPS = ['tobi', 'tobi_apprentice', 'shokucho', 'doko']

  return (
    <div className="max-w-7xl mx-auto space-y-5">
      <PageHeader
        group="人・書類"
        title="道具代管理"
        sub="外国人スタッフ（技能実習・特定技能）と日本人の現場スタッフが対象。入社日から1年ごとの期間で管理します"
        actions={<ToolButton icon="gear" onClick={() => setShowBudgetSettings(v => !v)}>{showBudgetSettings ? '区分ごとの予算を閉じる' : '区分ごとの予算'}</ToolButton>}
      />

      {/* ── 区分別の既定予算（2026-08-28 追加）──
          在留資格・職種ごとに年間予算の既定額を変えられる。空欄の区分は既定額を使う。
          個別に予算を変更した期間はそちらが優先（従来どおり） */}
      {showBudgetSettings && (
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 p-5 space-y-3">
          <div className="text-[1.0625rem] font-bold text-gray-900 dark:text-white">区分ごとの予算（年間の既定額）</div>
          <p className="text-xs text-gray-500">
            空欄の区分は「既定額」を使います。個別に予算を変更したスタッフはそちらが優先されます。
            変更は<b>次に開く期間や未設定の期間</b>から効きます（設定済みの期間の予算は変わりません）。
          </p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="block">
              <span className="text-xs text-gray-500">既定額（どの区分にも当てはまらない場合）</span>
              <input type="text" inputMode="numeric" value={defaultBudget}
                onChange={e => setDefaultBudget(e.target.value.replace(/[^0-9]/g, ''))}
                className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm tabular-nums" />
            </label>
            {VISA_GROUPS.map(g => (
              <label key={g.key} className="block">
                <span className="text-xs text-orange-700">{g.label}（ベトナム人）</span>
                <input type="text" inputMode="numeric" value={budgetByVisa[g.key] ?? ''}
                  placeholder={`既定額 ¥${Number(defaultBudget || 0).toLocaleString()}`}
                  onChange={e => setBudgetByVisa(m => ({ ...m, [g.key]: e.target.value.replace(/[^0-9]/g, '') }))}
                  className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm tabular-nums" />
              </label>
            ))}
            {JOB_GROUPS.map(j => (
              <label key={j} className="block">
                <span className="text-xs text-blue-700">{jobLabel(j)}（日本人）</span>
                <input type="text" inputMode="numeric" value={budgetByJob[j] ?? ''}
                  placeholder={`既定額 ¥${Number(defaultBudget || 0).toLocaleString()}`}
                  onChange={e => setBudgetByJob(m => ({ ...m, [j]: e.target.value.replace(/[^0-9]/g, '') }))}
                  className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm tabular-nums" />
              </label>
            ))}
          </div>
          <div className="flex items-center gap-3">
            <SaveButton action="保存" onSave={saveBudgetSettings} />
          </div>
        </div>
      )}

      {/* ① 今やること（2026-10-01 改修） */}
      {!loading && workers.length > 0 && (
        <section className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <TodoCard icon="alert" tone={overList.length > 0 ? 'urgent' : 'ok'} title="使いすぎ（残りがマイナス）"
            big={overList.length > 0 ? `${overList.length}名` : 'ありません'}
            sub={overList.length > 0 ? overList.slice(0, 3).map(w => `${w.workerName} −¥${Math.abs(w.remaining).toLocaleString()}`).join('・') + '。次の期間の予算から差し引かれます' : '予算をこえている人はいません'}
            action={overList.length > 0 ? '見る' : undefined} active={listFilter === 'over'}
            onClick={overList.length > 0 ? () => toggleFilter('over') : undefined} />
          <TodoCard icon="alert" tone={lowList.length > 0 ? 'warn' : 'ok'} title="残りが少ない（2割未満）"
            big={lowList.length > 0 ? `${lowList.length}名` : 'ありません'}
            sub={lowList.length > 0 ? lowList.slice(0, 3).map(w => `${w.workerName} 残り¥${w.remaining.toLocaleString()}`).join('・') + (lowList.length > 3 ? ` ほか${lowList.length - 3}名` : '') : '残りが2割を切った人はいません'}
            action={lowList.length > 0 ? '見る' : undefined} active={listFilter === 'low'}
            onClick={lowList.length > 0 ? () => toggleFilter('low') : undefined} />
          <TodoCard icon="clock" tone={noPeriod.length > 0 ? 'warn' : 'ok'} title="期間が決まっていない"
            big={noPeriod.length > 0 ? `${noPeriod.length}名` : 'ありません'}
            sub={noPeriod.length > 0 ? `${noPeriod.slice(0, 3).map(w => w.workerName).join('・')}。行を押して期間の起算日を決めてください` : '全員、入社日などから期間が決まっています'}
            action={noPeriod.length > 0 ? '見る' : undefined} active={listFilter === 'noperiod'}
            onClick={noPeriod.length > 0 ? () => toggleFilter('noperiod') : undefined} />
        </section>
      )}

      {/* ② 合計 */}
      {!loading && workers.length > 0 && (
        <section className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <TbStat label={`予算（${workers.length}名）`} value={`¥${totalBudget.toLocaleString()}`} sub={`今の期間の予算の合計（繰り越し込み）${setupCount < workers.length ? `／期間が決まっている ${setupCount}名` : ''}`} />
          <TbStat label="使った" value={`¥${totalUsed.toLocaleString()}`} sub={totalCompanyPaid > 0 ? `本人の枠から使った分の合計（ほかに会社の半額負担 ¥${totalCompanyPaid.toLocaleString()}）` : '今の期間に買ったものの合計'} />
          <TbStat label="残り" value={`¥${totalRemaining.toLocaleString()}`} sub={overList.length > 0 ? `使いすぎ ${overList.length}名を含む` : '予算 − 使った'} />
        </section>
      )}

      {loading ? (
        <div className="text-center py-8 text-gray-400">読み込み中...</div>
      ) : workers.length === 0 ? (
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 p-8 text-center text-gray-400">
          <p>対象スタッフがいません。</p>
          <p className="text-sm mt-2">技能実習生・特定技能のスタッフが登録されているか、人員マスタをご確認ください。</p>
        </div>
      ) : (
        <section className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 overflow-hidden">
          <div className="px-5 py-3.5 border-b border-hibi-line dark:border-gray-700 flex flex-wrap items-center gap-3">
            <h2 className="text-[1.0625rem] font-bold text-gray-900 dark:text-white">一人ずつ</h2>
            <Segment value={org} onChange={v => { setOrg(v); setListFilter('all') }} items={[
              ['all', `全員 ${workers.length}`], ['hibi', `日比建設 ${workers.filter(w => w.org === 'hibi').length}`], ['hfu', `HFU ${workers.filter(w => w.org === 'hfu').length}`],
            ]} />
            {listFilter !== 'all' && (
              <button onClick={() => setListFilter('all')} className="h-8 px-3 rounded-lg bg-hibi-active text-hibi-navy dark:bg-blue-900/30 dark:text-blue-300 text-[0.8125rem] font-bold">
                {TB_FILTER_LABEL[listFilter]}だけ表示中 ×
              </button>
            )}
            <SearchBox value={query} onChange={setQuery} placeholder="名前で探す" />
          </div>
          <div className={`hidden lg:grid ${TB_COLS} gap-3 px-5 py-2.5 bg-hibi-thead dark:bg-gray-700 text-xs font-bold text-hibi-sub dark:text-gray-300`}>
            <span>名前</span><span>区分</span><span>今の期間</span><span>使った ／ 予算</span><span className="text-right">残り</span>
          </div>
          {companyGroups.map(company => {
            const rows = shown.filter(w => w.org === company.key)
            if (rows.length === 0) return null
            return (
              <div key={company.key}>
                <div className="px-5 py-2 text-xs font-bold text-hibi-sub dark:text-gray-400 bg-gray-50 dark:bg-gray-700/40 border-t border-hibi-line dark:border-gray-700">{company.label}（{rows.length}名）</div>
                {rows.map(w => {
                  const cap = w.budget + (w.carry ?? 0)
                  const pct = cap > 0 ? Math.min(100, (w.used / cap) * 100) : (w.used > 0 ? 100 : 0)
                  const over = w.remaining < 0
                  const low = isLow(w)
                  return (
                    <div key={w.workerId} role="button" tabIndex={0}
                      onClick={() => setModalWorkerId(w.workerId)}
                      onKeyDown={e => { if (e.key === 'Enter') setModalWorkerId(w.workerId) }}
                      className={`border-t border-hibi-line dark:border-gray-700 px-5 py-2.5 grid grid-cols-2 ${TB_COLS} gap-x-3 gap-y-1.5 items-center cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/40 transition tabular-nums`}>
                      <span className="col-span-2 lg:col-span-1 flex items-center gap-2.5 min-w-0">
                        <WorkerAvatar name={w.workerName} src={photos[String(w.workerId)]} size={36} />
                        <span className="text-[0.9375rem] font-bold text-gray-900 dark:text-gray-100 truncate">{w.workerName}</span>
                      </span>
                      <span><Chip tone={visaLabel(w.visa) ? 'gray' : 'blue'}>{visaLabel(w.visa) || '日本人'}</Chip></span>
                      <span className="text-[0.8125rem] text-hibi-sub dark:text-gray-400">
                        {w.period ? formatPeriod(w.period) : <Chip tone="amber">期間が決まっていない</Chip>}
                        {w.notStarted && <span className="ml-1"><Chip tone="amber">開始前</Chip></span>}
                      </span>
                      <span className="col-span-2 lg:col-span-1 flex flex-col gap-1">
                        <span className="h-2 rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden">
                          <span className={`block h-full ${over ? 'bg-red-600' : low ? 'bg-amber-500' : 'bg-hibi-navy dark:bg-blue-400'}`} style={{ width: `${pct}%` }} />
                        </span>
                        <span className="text-xs text-hibi-sub dark:text-gray-400">
                          ¥{w.used.toLocaleString()} ／ ¥{w.budget.toLocaleString()}
                          {(w.carry ?? 0) !== 0 && <span className={(w.carry ?? 0) > 0 ? 'text-blue-700 dark:text-blue-300' : 'text-red-700 dark:text-red-400'}>（繰越 {(w.carry ?? 0) > 0 ? '+' : '−'}¥{Math.abs(w.carry ?? 0).toLocaleString()}）</span>}
                        </span>
                      </span>
                      <span className={`lg:text-right text-base font-bold ${over ? 'text-red-700 dark:text-red-400' : low ? 'text-amber-700 dark:text-amber-400' : 'text-gray-900 dark:text-white'}`}>
                        {over ? `−¥${Math.abs(w.remaining).toLocaleString()}` : `¥${w.remaining.toLocaleString()}`}
                      </span>
                    </div>
                  )
                })}
              </div>
            )
          })}
          {shown.length === 0 && <div className="px-5 py-8 text-center text-sm text-hibi-sub dark:text-gray-400">当てはまる人はいません</div>}
        </section>
      )}

      {/* 一人の道具代（右から開く） */}
      {currentWorker && (
        <WorkerModal
          worker={currentWorker}
          password={password}
          onClose={() => setModalWorkerId(null)}
          onRefresh={fetchData}
        />
      )}
    </div>
  )
}

function TbStat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 px-5 py-4 flex flex-col gap-1">
      <span className="text-[0.8125rem] text-hibi-sub dark:text-gray-400">{label}</span>
      <span className="text-[1.625rem] font-bold tabular-nums text-gray-900 dark:text-white">{value}</span>
      <span className="text-xs text-hibi-sub dark:text-gray-400">{sub}</span>
    </div>
  )
}

// ────────────────────────────────────────
//  Worker Detail Modal
// ────────────────────────────────────────

function WorkerModal({
  worker,
  password,
  onClose,
  onRefresh,
}: {
  worker: WorkerBudget
  password: string
  onClose: () => void
  onRefresh: () => void
}) {
  const [anchor, setAnchor] = useState(worker.periodAnchor || '')

  const [budget, setBudget] = useState(String(worker.budget))

  const [bulkAmount, setBulkAmount] = useState('')
  const [bulkDate, setBulkDate] = useState(worker.period?.start || '')
  const [bulkMemo, setBulkMemo] = useState('既存使用分')

  const [newDate, setNewDate] = useState('')
  // 購入日（領収書の日付）の範囲（2026-10-09）: 枠が始まる前月の1日〜今日。どの期間に入るかはサーバが日付で決める
  const receiptMin = worker.periodAnchor ? earliestReceiptDate(worker.periodAnchor) : (worker.period?.start || '')
  const receiptMax = todayJstIso()
  const [newAmount, setNewAmount] = useState('')
  const [newItem, setNewItem] = useState('')
  // 会社半額負担（2026-10-08・外国人の電動インパクトだけ）
  const [newSubsidy, setNewSubsidy] = useState<ToolSubsidyKind | ''>('')
  const subsidyEligible = isToolSubsidyEligible(worker.visa)
  const newCompany = newSubsidy && Number(newAmount) > 0 ? toolSubsidyCompanyAmount(newSubsidy, Number(newAmount)) : 0

  // worker props が更新されたら state を同期
  useEffect(() => {
    setAnchor(worker.periodAnchor || '')
    setBudget(String(worker.budget))
    if (worker.period) setBulkDate(worker.period.start)
  }, [worker])

  // 保存ボタン（SaveButton）の約束: うまくいったら何も返さない・サーバの断りは { ok: false, error }（ボタンが赤の帯を出す）
  const saveAnchor = async () => {
    const r = await fetch('/api/tool-budget', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
      body: JSON.stringify({ action: 'setPeriodAnchor', workerId: worker.workerId, anchor: anchor || null }),
    })
    // 2026-10-02 総合点検: 旧は応答を見ておらず、権限なし・形式不正でも「保存しました」と出た
    if (!r.ok) { const j = await r.json().catch(() => null); return { ok: false, error: j?.error || 'サーバが受け付けませんでした' } }
    onRefresh()
  }

  const saveBudget = async () => {
    if (!worker.period) return null
    const r = await fetch('/api/tool-budget', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
      body: JSON.stringify({
        action: 'setBudget',
        workerId: worker.workerId,
        periodStart: worker.period.start,
        budget: Number(budget),
      }),
    })
    if (!r.ok) { const j = await r.json().catch(() => null); return { ok: false, error: j?.error || 'サーバが受け付けませんでした' } }
    onRefresh()
  }

  // 2026-09-30: 登録時に残高・期間をサーバで確認する。残高を超えるときは確認してから通す
  //   戻り値: true=登録した / null=「やめる」が押された（失敗ではない） / false=だめだった（帯はここで出す）
  const addPurchase = async (date: string, amount: number, item: string, subsidyKind?: ToolSubsidyKind): Promise<boolean | null> => {
    if (!worker.period) return null
    const post = (allowOver: boolean, allowDuplicate: boolean) => fetch('/api/tool-budget', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
      body: JSON.stringify({
        action: 'addPurchase',
        workerId: worker.workerId,
        periodStart: worker.period!.start,
        date,
        amount,
        item,
        allowOver,
        allowDuplicate,
        ...(subsidyKind ? { subsidyKind } : {}),
      }),
    })
    try {
      // 2026-10-09: 同じ購入の二度登録（duplicate）と残高超え（over_budget）は、確認してから通す。両方当たることもあるので順に聞く
      let allowOver = false
      let allowDuplicate = false
      let res = await post(allowOver, allowDuplicate)
      while (res.status === 409) {
        const j = await res.json().catch(() => ({}))
        if (j.code === 'duplicate' && !allowDuplicate) {
          const okDup = await confirmDialog({
            title: '同じ購入がもう登録されています。それでも登録しますか？',
            description: `${j.error || ''}\n二度押しでなければ（同じ日に同じ金額の別の買い物なら）登録してください。`.trim(),
            confirmLabel: '別の購入として登録する',
          })
          if (!okDup) return null
          allowDuplicate = true
        } else if (j.code === 'over_budget' && !allowOver) {
          const okOver = await confirmDialog({
            title: `${worker.workerName} さんの道具代の残高を超えます。それでも登録しますか？`,
            description: `${j.error || ''}\n超過分は、次の期間の枠から差し引かれます。`.trim(),
            confirmLabel: '超えて登録する',
          })
          if (!okOver) return null
          allowOver = true
        } else {
          notify.failed('登録', j.error || 'サーバが受け付けませんでした')
          return false
        }
        res = await post(allowOver, allowDuplicate)
      }
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        notify.failed('登録', j.error || 'サーバが受け付けませんでした')
        return false
      }
      // 領収書の日付で期間が決まる（2026-10-09）。開いている期間と違う期間に入ったら伝える
      const j = await res.json().catch(() => ({}))
      // 2026-10-09: 登録できたことを緑の帯で必ず伝える（旧: ボタンの文字が2秒変わるだけで、気づかず二度登録した例があった）
      const what = `${worker.workerName} さんに ${date.replace(/-/g, '/')} の ¥${amount.toLocaleString()} を登録しました`
      if (j.otherPeriod && j.periodStart) {
        notify.success(what, `領収書の日付で ${String(j.periodStart).replace(/-/g, '/')}〜${String(j.periodEnd || '').replace(/-/g, '/')} の期間に入れました`)
      } else {
        notify.success(what)
      }
      return true
    } catch (e) {
      notify.failed('登録', e)
      return false
    }
  }

  // addPurchase は失敗の帯を自分で出す（残高超えの確認もその中）ので、だめなら false を返すだけ
  const handleBulkRegister = async () => {
    if (!bulkAmount || !bulkDate) return null
    const ok = await addPurchase(bulkDate, Number(bulkAmount), bulkMemo || '既存使用分')
    if (!ok) return ok
    setBulkAmount('')
    onRefresh()
  }

  const handleAddNew = async () => {
    if (!newDate || !newAmount) return null
    const ok = await addPurchase(newDate, Number(newAmount), newItem || (newSubsidy ? TOOL_SUBSIDY_ITEMS[newSubsidy].label : ''), newSubsidy || undefined)
    if (!ok) return ok
    setNewDate('')
    setNewAmount('')
    setNewItem('')
    setNewSubsidy('')
    onRefresh()
  }

  // 登録済みの購入に半額負担を付ける／外す（10月に普通の購入として入れた分を直す用）
  const handleSetSubsidy = async (p: Purchase, kind: ToolSubsidyKind | null) => {
    if (!worker.period) return
    const label = TOOL_SUBSIDY_ITEMS.impact.label
    const ok = kind
      ? await confirmDialog({
        title: `この購入を「${label}の会社半額負担」にしますか？`,
        description: `会社負担 ¥${toolSubsidyCompanyAmount(kind, p.amount).toLocaleString()}（上限 ¥${TOOL_SUBSIDY_ITEMS[kind].cap.toLocaleString()}）。本人の枠からは残りの ¥${(p.amount - toolSubsidyCompanyAmount(kind, p.amount)).toLocaleString()} だけ引きます。`,
        confirmLabel: '半額負担にする',
      })
      : await confirmDialog({
        title: 'この購入の会社半額負担を外しますか？',
        description: `購入額 ¥${p.amount.toLocaleString()} をすべて本人の枠から引きます。`,
        confirmLabel: '外す',
      })
    if (!ok) return
    try {
      const r = await fetch('/api/tool-budget', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
        body: JSON.stringify({ action: 'setPurchaseSubsidy', workerId: worker.workerId, periodStart: worker.period.start, purchaseId: p.id, subsidyKind: kind }),
      })
      if (!r.ok) { const j = await r.json().catch(() => null); notify.failed('半額負担の変更', j?.error || 'サーバが受け付けませんでした'); return }
      onRefresh()
    } catch (e) { notify.failed('半額負担の変更', e) }
  }

  const handleDelete = async (purchaseId: string) => {
    if (!worker.period) return
    if (!(await confirmDanger({
      title: 'この購入記録を削除しますか？',
      description: '使った額から差し引かれ、残高が戻ります。',
      confirmLabel: '削除する',
    }))) return
    try {
      const r = await fetch('/api/tool-budget', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
        body: JSON.stringify({
          action: 'deletePurchase',
          workerId: worker.workerId,
          periodStart: worker.period.start,
          purchaseId,
        }),
      })
      if (!r.ok) { const j = await r.json().catch(() => null); notify.failed('購入記録を削除', j?.error || 'サーバが受け付けませんでした'); return }
      onRefresh()
    } catch { /* ignore */ }
  }

  const sortedPurchases = [...worker.purchases].sort((a, b) => b.date.localeCompare(a.date))
  const pct = worker.budget + (worker.carry ?? 0) > 0 ? Math.min(100, (worker.used / (worker.budget + (worker.carry ?? 0))) * 100) : 100

  return (
    <SidePanel label={`${worker.workerName} の道具代`} onClose={onClose}>
      <div className="flex flex-col min-h-full bg-white dark:bg-gray-800">
        {/* Header */}
        <div className="sticky top-0 bg-white dark:bg-gray-800 border-b border-hibi-line dark:border-gray-700 px-6 py-5 flex items-start gap-3 z-10">
          <div className="flex-1 min-w-0">
            <h2 className="text-[1.375rem] font-bold text-gray-900 dark:text-white truncate">{worker.workerName}</h2>
            <div className="flex flex-wrap items-center gap-1.5 mt-1 text-[0.8125rem] text-hibi-sub dark:text-gray-400">
              <Chip tone={visaLabel(worker.visa) ? 'gray' : 'blue'}>{visaLabel(worker.visa) || '日本人'}</Chip>
              {worker.period && <span>期間 {formatPeriodFull(worker.period)}</span>}
              {worker.remaining < 0 && <Chip tone="red">予算を ¥{Math.abs(worker.remaining).toLocaleString()} こえています</Chip>}
            </div>
          </div>
          <CloseButton onClick={onClose} />
        </div>

        <div className="p-6 space-y-5">
          {/* ══ Section 1: 期間設定 ══ */}
          <section>
            <h3 className="text-sm font-bold text-hibi-navy dark:text-blue-300 mb-2 flex items-center gap-2">
              <span className="bg-hibi-navy dark:bg-blue-700 text-white rounded-full w-5 h-5 text-xs flex items-center justify-center">1</span>
              期間の起点日
            </h3>
            <div className="bg-gray-50 dark:bg-gray-700/40 rounded-lg p-3 border border-gray-200 dark:border-gray-600 dark:text-gray-200">
              <div className="flex items-end gap-2 flex-wrap">
                <div>
                  <label className="text-3xs text-gray-500 dark:text-gray-400 block mb-0.5">起点日（1年サイクルの始まり）</label>
                  <input
                    type="date"
                    value={anchor}
                    onChange={e => setAnchor(e.target.value)}
                    className="border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded px-2 py-1.5 text-sm w-40" />
                </div>
                <SaveButton action="保存" onSave={saveAnchor} disabled={anchor === (worker.periodAnchor || '')} />
              </div>
              <p className="text-2xs text-gray-500 dark:text-gray-400 mt-2">
                起点日を設定すると、その日から1年ごとに自動でサイクルが切り替わります（例: 5/14 → 翌5/13まで）。<br />
                {worker.period && <span>現在の期間: <strong>{formatPeriodFull(worker.period)}</strong></span>}
              </p>
            </div>
          </section>

          {/* ══ 期間未設定の場合はここまで ══ */}
          {!worker.period ? (
            <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-300 dark:border-yellow-800 rounded-lg p-4 text-center text-yellow-800 dark:text-yellow-300 text-sm">
              まず期間の起点日を設定してください。<br />
              設定後、購入の登録ができるようになります。
            </div>
          ) : (
            <>
              {/* ══ Section 2: 予算と使用状況 ══ */}
              <section>
                <h3 className="text-sm font-bold text-hibi-navy dark:text-blue-300 mb-2 flex items-center gap-2">
                  <span className="bg-hibi-navy dark:bg-blue-700 text-white rounded-full w-5 h-5 text-xs flex items-center justify-center">2</span>
                  予算と使用状況
                </h3>
                <div className="bg-gray-50 dark:bg-gray-700/40 rounded-lg p-3 border border-gray-200 dark:border-gray-600 dark:text-gray-200 space-y-3">
                  {/* 進捗バー */}
                  <div>
                    <div className="flex justify-between text-xs mb-1">
                      <span className="text-gray-600 dark:text-gray-300">
                        使用済 ¥{worker.used.toLocaleString()}
                        {(worker.companyPaid ?? 0) > 0 && <span className="text-green-700 dark:text-green-400">（ほかに会社負担 ¥{(worker.companyPaid ?? 0).toLocaleString()}）</span>}
                      </span>
                      <span className="text-gray-600 dark:text-gray-300">残額 <strong className="text-green-600 dark:text-green-400">¥{worker.remaining.toLocaleString()}</strong></span>
                    </div>
                    <div className="w-full h-3 bg-gray-200 dark:bg-gray-600 rounded-full overflow-hidden">
                      <div
                        className={`h-full transition-all ${pct >= 100 ? 'bg-red-500' : pct >= 80 ? 'bg-orange-400' : 'bg-blue-400'}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <div className="text-2xs text-gray-500 dark:text-gray-400 mt-1 text-right">
                      {pct.toFixed(0)}% 使用中 / 予算 ¥{worker.budget.toLocaleString()}
                      {(worker.carry ?? 0) !== 0 && <>（前期からの繰越 {(worker.carry ?? 0) > 0 ? '+' : '−'}¥{Math.abs(worker.carry ?? 0).toLocaleString()}）</>}
                    </div>
                  </div>

                  {/* 予算変更 */}
                  <div className="flex items-end gap-2 pt-2 border-t border-gray-200 dark:border-gray-600">
                    <div>
                      <label className="text-3xs text-gray-500 dark:text-gray-400 block mb-0.5">予算額（個別変更）</label>
                      <input
                        type="number"
                        value={budget}
                        onChange={e => setBudget(e.target.value)}
                        className="border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded px-2 py-1.5 text-sm w-32 tabular-nums" />
                    </div>
                    <SaveButton action="予算を変更" onSave={saveBudget} disabled={Number(budget) === worker.budget} />
                    <span className="text-2xs text-gray-400 ml-auto">デフォルト: ¥{(worker.defaultBudget ?? worker.budget).toLocaleString()}</span>
                  </div>
                </div>
              </section>

              {/* ══ Section 3: 既存使用分のまとめ登録（既存0件の時のみ強調） ══ */}
              {worker.purchases.length === 0 && (
                <section>
                  <h3 className="text-sm font-bold text-hibi-navy dark:text-blue-300 mb-2 flex items-center gap-2">
                    <span className="bg-hibi-navy dark:bg-blue-700 text-white rounded-full w-5 h-5 text-xs flex items-center justify-center">3</span>
                    既存使用分のまとめ登録（初回のみ）
                  </h3>
                  <div className="bg-amber-50 dark:bg-amber-900/20 rounded-lg p-3 border border-amber-300 dark:border-amber-800">
                    <p className="text-xs text-amber-800 dark:text-amber-300 mb-2">
                      この期間ですでに使った道具代がある場合は、合計金額をまとめて登録できます。
                    </p>
                    <div className="flex items-end gap-2 flex-wrap">
                      <div>
                        <label className="text-3xs text-gray-500 dark:text-gray-400 block mb-0.5">日付（通常は期間起点）</label>
                        <input
                          type="date"
                          value={bulkDate}
                          onChange={e => setBulkDate(e.target.value)}
                          min={receiptMin} max={receiptMax}
                          className="border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded px-2 py-1.5 text-sm w-36" />
                      </div>
                      <div>
                        <label className="text-3xs text-gray-500 dark:text-gray-400 block mb-0.5">摘要</label>
                        <input
                          type="text"
                          value={bulkMemo}
                          onChange={e => setBulkMemo(e.target.value)}
                          className="border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded px-2 py-1.5 text-sm w-36" />
                      </div>
                      <div>
                        <label className="text-3xs text-gray-500 dark:text-gray-400 block mb-0.5">合計金額</label>
                        <input
                          type="number"
                          value={bulkAmount}
                          onChange={e => setBulkAmount(e.target.value)}
                          placeholder="8500"
                          className="border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded px-2 py-1.5 text-sm w-28 tabular-nums" />
                      </div>
                      <SaveButton action="まとめて計上" onSave={handleBulkRegister} disabled={!bulkAmount || !bulkDate} />
                    </div>
                  </div>
                </section>
              )}

              {/* ══ Section 4: 購入履歴 ══ */}
              <section>
                <h3 className="text-sm font-bold text-hibi-navy dark:text-blue-300 mb-2 flex items-center gap-2">
                  <span className="bg-hibi-navy dark:bg-blue-700 text-white rounded-full w-5 h-5 text-xs flex items-center justify-center">
                    {worker.purchases.length === 0 ? '4' : '3'}
                  </span>
                  購入履歴（{worker.purchases.length}件）
                </h3>
                <div className="bg-gray-50 dark:bg-gray-700/40 rounded-lg border border-gray-200 dark:border-gray-600 dark:text-gray-200 overflow-hidden">
                  {sortedPurchases.length === 0 ? (
                    <p className="text-sm text-gray-400 text-center py-4">購入記録なし</p>
                  ) : (
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-xs text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-600">
                          <th className="text-left py-2 px-3">日付</th>
                          <th className="text-left py-2 px-3">品名</th>
                          <th className="text-right py-2 px-3">金額</th>
                          <th className="text-center py-2 px-3 w-12"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {sortedPurchases.map(p => (
                          <tr key={p.id} className="border-b border-gray-100 dark:border-gray-700 last:border-b-0">
                            <td className="py-1.5 px-3 tabular-nums text-xs">{p.date}</td>
                            <td className="py-1.5 px-3">
                              {p.item || '—'}
                              {p.over && <span className="ml-1.5 text-3xs bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300 px-1.5 py-0.5 rounded-full font-bold">超過（翌期から差し引き）</span>}
                              {p.subsidy && <span className="ml-1.5 text-3xs bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300 px-1.5 py-0.5 rounded-full font-bold">会社半額負担</span>}
                            </td>
                            <td className="py-1.5 px-3 text-right tabular-nums">
                              ¥{p.amount.toLocaleString()}
                              {p.subsidy && (
                                <div className="text-3xs text-hibi-sub dark:text-gray-400">
                                  会社 ¥{p.subsidy.company.toLocaleString()} ／ 本人 ¥{(p.amount - p.subsidy.company).toLocaleString()}
                                </div>
                              )}
                            </td>
                            <td className="py-1.5 px-3 text-center">
                              <div className="flex flex-col items-center gap-1">
                                {subsidyEligible && (p.subsidy
                                  ? <RowButton onClick={() => handleSetSubsidy(p, null)}>半額負担を外す</RowButton>
                                  : p.date >= TOOL_SUBSIDY_FROM && <RowButton onClick={() => handleSetSubsidy(p, 'impact')}>半額負担にする</RowButton>)}
                                <RowButton tone="danger" onClick={() => handleDelete(p.id)}>削除する</RowButton>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </section>

              {/* ══ Section 5: 新規登録 ══ */}
              <section>
                <h3 className="text-sm font-bold text-hibi-navy dark:text-blue-300 mb-2 flex items-center gap-2">
                  <span className="bg-hibi-navy dark:bg-blue-700 text-white rounded-full w-5 h-5 text-xs flex items-center justify-center">
                    {worker.purchases.length === 0 ? '5' : '4'}
                  </span>
                  新しい購入を登録
                </h3>
                <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-3 border border-blue-200 dark:border-blue-800">
                  <div className="flex items-end gap-2 flex-wrap">
                    <div>
                      <label className="text-3xs text-gray-500 dark:text-gray-400 block mb-0.5" title="領収書の日付をそのまま入れます。どの期間の枠から引くかも、この日付で決まります">購入日（領収書の日付）</label>
                      <input
                        type="date"
                        value={newDate}
                        onChange={e => setNewDate(e.target.value)}
                        min={receiptMin} max={receiptMax}
                        className="border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded px-2 py-1.5 text-sm w-36" />
                    </div>
                    <div>
                      <label className="text-3xs text-gray-500 dark:text-gray-400 block mb-0.5">品名</label>
                      <input
                        type="text"
                        value={newItem}
                        onChange={e => setNewItem(e.target.value)}
                        placeholder="安全帯など"
                        className="border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded px-2 py-1.5 text-sm w-40" />
                    </div>
                    <div>
                      <label className="text-3xs text-gray-500 dark:text-gray-400 block mb-0.5">金額（円）</label>
                      <input
                        type="number"
                        value={newAmount}
                        onChange={e => setNewAmount(e.target.value)}
                        placeholder="3500"
                        className="border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded px-2 py-1.5 text-sm w-28 tabular-nums" />
                    </div>
                    <SaveButton action="追加" onSave={handleAddNew} disabled={!newDate || !newAmount} />
                  </div>
                  {subsidyEligible && (
                    <div className="mt-2.5 pt-2.5 border-t border-blue-200 dark:border-blue-800">
                      <label className="inline-flex items-center gap-2 text-sm font-bold text-gray-800 dark:text-gray-100 cursor-pointer">
                        <input type="checkbox" checked={newSubsidy === 'impact'}
                          onChange={e => setNewSubsidy(e.target.checked ? 'impact' : '')} className="w-4 h-4" />
                        {TOOL_SUBSIDY_ITEMS.impact.label}（会社が半額負担）
                      </label>
                      <p className="text-2xs text-gray-500 dark:text-gray-400 mt-1">
                        会社負担は半額で上限 ¥{TOOL_SUBSIDY_ITEMS.impact.cap.toLocaleString()}、{TOOL_SUBSIDY_ITEMS.impact.intervalYears}年に1回まで（{TOOL_SUBSIDY_FROM.replace(/-0?/g, '/')} 以降の購入）。本人の枠からは残りだけ引きます。
                      </p>
                      {newSubsidy && Number(newAmount) > 0 && (
                        <p className="text-xs font-bold text-green-800 dark:text-green-300 mt-1 tabular-nums">
                          会社 ¥{newCompany.toLocaleString()} ／ 本人の枠から ¥{(Number(newAmount) - newCompany).toLocaleString()}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              </section>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="sticky bottom-0 mt-auto bg-white dark:bg-gray-800 border-t border-hibi-line dark:border-gray-700 px-6 py-3.5 flex justify-end">
          <button
            onClick={onClose}
            className="h-11 px-5 rounded-[10px] border border-gray-300 dark:border-gray-600 text-sm font-bold text-gray-700 dark:text-gray-200 hover:bg-hibi-bg dark:hover:bg-gray-700"
          >
            閉じる
          </button>
        </div>
      </div>
    </SidePanel>
  )
}
