'use client'

import { useEffect, useState, useCallback } from 'react'
import { fmtYen, fmtYenMan, fmtNum, fmtPct } from '@/lib/format'
import { visaLabel } from '@/lib/labels'
import { isTobiGroup, jobLabel as jobLabelLib } from '@/lib/jobs'
import { currentYmJst, todayJstDate } from '@/lib/date-utils'
import { useLatestRequest } from '@/lib/hooks/useLatestRequest'
import { shiftYm } from '@/lib/month-nav'
import { Icon } from '@/components/ui/Icon'
import { PageHeader, TodoCard, Segment, Chip, SidePanel, CloseButton, type ChipTone } from '@/components/ui/PageParts'

// ─── Types ───

interface SiteProfit {
  id: string; name: string
  billing: number; billingRaw?: number; billingByMonth: Record<string, number[]>
  cost: number; costRaw?: number; subCost: number; totalCost: number
  profit: number; profitRate: number; workDays: number; subWorkDays: number
  tobiEquiv: number; tobiRate: number; tobiBase: number
  dispatchDeduction?: number
}

interface SubconSiteBreakdown {
  siteId: string; siteName: string; workDays: number; otCount: number; cost: number
}

interface SubconCostDetail {
  id: string; name: string; type: string; rate: number; otRate: number
  workDays: number; otCount: number; cost: number
  siteBreakdown: SubconSiteBreakdown[]
}

interface MonthlyTrend {
  ym: string
  billing: number
  cost: number
  profit: number
  manDays: number
  equiv: number
  billingPerManDay: number
  costPerManDay: number
  profitPerManDay: number
  inHouseWorkDays: number
  subconWorkDays: number
}

interface CumulativeData {
  ym: string
  billing: number
  cost: number
  profit: number
  cumBilling: number
  cumCost: number
  cumProfit: number
}

interface KPIExtended {
  totalManDays: number
  inHouseManDays: number
  subconManDays: number
  subconRate: number
  billing: number
  billingRaw: number
  cost: number
  profit: number
  profitRate: number
  perW: number
  perWEst: number
  billingPerManDay: number
  billingPerManDayBaseline: number
  laborCostPerPerson: number
  laborCostPerPersonAll: number
  estMonths: number
  pctWork: number
  prevTotalManDays: number
  prevBilling: number
  prevCost: number
  prevProfitRate: number
  prevBillingPerManDay: number
  otHours: number
}

interface SiteOption {
  id: string; name: string
}

interface SiteMember {
  id: number; name: string; org: string; visa: string; job: string
}

interface SiteTrendPoint {
  ym: string; workerCount: number; cost: number; tobi: number; doko: number
}

interface CostData {
  sites: SiteProfit[]
  subconDetails: SubconCostDetail[]
  ymRange: string[]
  totals: {
    billing: number; cost: number; subCost: number; totalCost: number
    profit: number; profitRate: number; workDays: number; subWorkDays: number
    otHours: number; dispatchDeduction?: number; billingRaw?: number; costRaw?: number
  }
  monthlyTrend: MonthlyTrend[]
  cumulativeData: CumulativeData[]
  kpiExtended: KPIExtended
  siteList: SiteOption[]
  siteMembers: SiteMember[] | null
  siteTrend: SiteTrendPoint[] | null
}

type PeriodType = 'monthly' | '3months' | '6months' | 'fiscal' | 'yearly'

// ─── Helpers ───

function ymToShortLabel(ym: string): string {
  const m = parseInt(ym.slice(4, 6))
  return `${m}月`
}

function jobLabel(job: string): string {
  // 2026-06-XX 修正: 単一の真理ソース lib/jobs.ts に委譲
  //   過去の入力で日本語ラベル ('とび' / '鳶' 等) が job フィールドに混入している
  //   ケースに対する後方互換は jobLabelLib で吸収済み
  if (job === 'とび' || job === '鳶') return '鳶'
  if (job === '鳶見習い') return '鳶見習い'
  if (job === '土工') return '土工'
  if (job === '職長') return '職長'
  if (job === '役員') return '役員'
  // それ以外は lib/jobs.ts に集約された JOB_LABELS で解決（コード→日本語）
  // 鳶見習い (tobi_apprentice) も自動対応
  const lib = jobLabelLib(job)
  return lib === '—' ? (job || '他') : lib
}

function jobBadgeColor(job: string): string {
  const label = jobLabel(job)
  if (label === '鳶') return 'bg-amber-100 text-amber-800'
  if (label === '土工') return 'bg-stone-100 text-stone-700'
  if (label === '職長') return 'bg-blue-100 text-blue-800'
  if (label === '役員') return 'bg-purple-100 text-purple-800'
  return 'bg-gray-100 text-gray-600'
}

// visaBadge は lib/labels.ts の visaLabel に集約済み（このページではラベルのみ使用）
const visaBadge = (visa: string): string => visaLabel(visa)

// ─── Main Component ───

export default function CostPage() {
  const [password, setPassword] = useState('')
  const [data, setData] = useState<CostData | null>(null)
  const [loading, setLoading] = useState(true)
  const [period, setPeriod] = useState<PeriodType>('monthly')
  const [siteFilter, setSiteFilter] = useState('all')
  // 最初に開く月: 毎月10日までは前の月（月初は今月の数字がほとんどなく、大きな赤字に見えるため・2026-10-01 代表）
  const [ym, setYm] = useState(() => {
    const today = todayJstDate()
    if (today.getDate() > 10) return currentYmJst()
    const d = new Date(today.getFullYear(), today.getMonth() - 1, 1)
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`
  })
  const [listFilter, setListFilter] = useState<'all' | 'nobill' | 'low'>('all')
  const [openSiteId, setOpenSiteId] = useState<string | null>(null)
  const [showIdleSubcons, setShowIdleSubcons] = useState(false)
  // Local billing edits: siteId_ym -> number[]
  const [billingEdits, setBillingEdits] = useState<Record<string, number[]>>({})
  // 行を削除したときに入力群を作り直すための世代番号。
  // 入力欄は defaultValue（非制御）＋ index キーなので、行を消すと下の行の DOM 値が
  // 上の行に残ってしまう。削除時だけ世代を上げて丸ごと再マウントする
  // （追加は末尾に足すだけで既存 index が動かないため、上げない＝フォーカスを守る）。
  const [billingRowsVersion, setBillingRowsVersion] = useState<Record<string, number>>({})

  useEffect(() => {
    const stored = localStorage.getItem('hibi_auth')
    if (stored) setPassword(JSON.parse(stored).password)
  }, [])

  // 月・期間・現場を素早く切り替えたとき、前の条件の応答をあとから画面に出さない（lib/hooks/useLatestRequest・2026-10-02）
  const latest = useLatestRequest()
  const fetchData = useCallback(async (opts?: { silent?: boolean }) => {
    if (!password) return
    // silent=true（保存後のバックグラウンド更新）は「読み込み中」に差し替えない。
    //   差し替えると表が一瞬1行に縮んで画面がガクッとスクロールするため。
    if (!opts?.silent) setLoading(true)
    const req = latest.begin()
    try {
      const params = new URLSearchParams({ ym, period, site: siteFilter })
      const res = await fetch(`/api/cost?${params}`, { headers: { 'x-admin-password': password }, signal: req.signal })
      if (!req.isCurrent()) return
      if (res.ok) {
        const d = await res.json()
        if (!req.isCurrent()) return
        setData(d)
        // 入力欄の状態をサーバー値から組み立てる。
        //
        // ⚠️ ただし丸ごと上書きしない。保存APIは0円の行を捨てるため、
        //    「+ 行追加」直後の空行が再取得のたびに消え、そこへフォーカスを移した
        //    瞬間に入力欄ごとアンマウントされていた（連続入力できない不具合の原因）。
        //    非ゼロの値がサーバーと一致している間は、ローカルの配列（空行含む）を保持する。
        setBillingEdits(prev => {
          const edits: Record<string, number[]> = {}
          for (const site of d.sites) {
            for (const [m, arr] of Object.entries(site.billingByMonth as Record<string, number[]>)) {
              const key = `${site.id}_${m}`
              const server = (arr as number[]).filter(v => v !== 0)
              const local = prev[key]
              const localNonZero = local ? local.filter(v => v !== 0) : null
              const same = localNonZero !== null
                && localNonZero.length === server.length
                && localNonZero.every((v, i) => v === server[i])
              edits[key] = same ? local! : (server.length > 0 ? [...server] : [0])
            }
          }
          return edits
        })
      }
    } catch (e) {
      if (!latest.isAbort(e)) throw e
    } finally {
      if (!opts?.silent && req.isCurrent()) setLoading(false)
    }
  }, [password, ym, period, siteFilter, latest])

  useEffect(() => { fetchData() }, [fetchData])

  const ymLabel = (m: string) => `${parseInt(m.slice(4))}月`

  // Period navigation (prev/next month)
  const navigateMonth = (direction: -1 | 1) => setYm(shiftYm(ym, direction))

  const ymDisplayLabel = `${parseInt(ym.slice(0, 4))}年${parseInt(ym.slice(4))}月`

  const isMultiMonth = period !== 'monthly'
  const ymRange = data?.ymRange || [ym]

  // Save billing for a site+month
  const saveBilling = async (siteId: string, month: string, amounts: number[]) => {
    // 2026-10-02 総合点検: 旧は res.ok を見ておらず、締め済み・権限なし・通信失敗でも「保存できた」ように見えていた
    let res: Response
    try {
      res = await fetch('/api/cost', {
        method: 'POST',
        headers: { 'x-admin-password': password, 'Content-Type': 'application/json' },
        body: JSON.stringify({ siteId, ym: month, amounts }),
      })
    } catch {
      alert('請求額を保存できませんでした（通信に失敗しました）'); return
    }
    if (!res.ok) {
      const j = await res.json().catch(() => null)
      alert(j?.error || '請求額を保存できませんでした')
    }
    fetchData({ silent: true })  // 静かに更新（表を縮めない＝スクロールが飛ばない）
  }

  // Update a billing row value locally
  const updateBillingRow = (siteId: string, month: string, rowIndex: number, value: number) => {
    const key = `${siteId}_${month}`
    setBillingEdits(prev => {
      const arr = [...(prev[key] || [0])]
      arr[rowIndex] = value
      return { ...prev, [key]: arr }
    })
  }

  // Add billing row
  const addBillingRow = (siteId: string, month: string) => {
    const key = `${siteId}_${month}`
    setBillingEdits(prev => {
      const arr = [...(prev[key] || [0]), 0]
      return { ...prev, [key]: arr }
    })
  }

  // Remove billing row
  const removeBillingRow = (siteId: string, month: string, rowIndex: number) => {
    setBillingRowsVersion(prev => ({ ...prev, [`${siteId}_${month}`]: (prev[`${siteId}_${month}`] || 0) + 1 }))
    const key = `${siteId}_${month}`
    setBillingEdits(prev => {
      const arr = [...(prev[key] || [0])]
      arr.splice(rowIndex, 1)
      if (arr.length === 0) arr.push(0)
      return { ...prev, [key]: arr }
    })
  }

  const t = data?.totals
  const kpi = data?.kpiExtended

  // 現場ごとの状態（2026-10-01 改修）: 請求額まだ（原価だけある）／粗利が薄い（15%未満）
  const LOW_RATE = 15
  //   請求額が入っていない現場の売上は、API が「人工 × 過去の平均単価」の見込み額で埋めている。
  //   billing だけ見ると入力済みに見えるので、入力した額（billingRaw）で判定する
  const noBilling = (s: SiteProfit) => (s.billingRaw ?? 0) === 0 && (s.totalCost > 0 || s.billing > 0)
  const isEstimate = (s: SiteProfit) => noBilling(s) && s.billing > 0
  //   複数月の期間で「入れた月」と「まだの月」が混ざる現場は、billing = 入力額 ＋ まだの月の見込み額。
  //   入力済みの確定額に見えないよう「見込み込み」と表示する（判定・計算は変えない）
  const estPart = (s: SiteProfit) => noBilling(s) ? 0 : Math.max(0, s.billing - (s.billingRaw ?? 0))
  const hasEstPart = (s: SiteProfit) => estPart(s) >= 1
  const lowProfit = (s: SiteProfit) => !noBilling(s) && s.billing > 0 && s.profitRate < LOW_RATE
  const sites = data?.sites || []
  const noBillingSites = sites.filter(noBilling)
  const lowSites = sites.filter(lowProfit)
  const shownSites = sites.filter(s => listFilter === 'all' || (listFilter === 'nobill' ? noBilling(s) : lowProfit(s)))
  const openSite = sites.find(s => s.id === openSiteId) || null
  const siteNames = (arr: SiteProfit[]) => arr.slice(0, 3).map(s => s.name.length > 12 ? s.name.slice(0, 12) + '…' : s.name).join('・') + (arr.length > 3 ? ` ほか${arr.length - 3}` : '')
  const rateTone = (s: SiteProfit): ChipTone => s.profitRate >= LOW_RATE ? 'green' : s.profitRate >= 0 ? 'amber' : 'red'
  const perManDay = (s: SiteProfit) => s.tobiEquiv > 0 && s.billing > 0 ? Math.round(s.billing / s.tobiEquiv) : 0
  const activeSubcons = (data?.subconDetails || []).filter(sc => sc.workDays > 0 || sc.cost > 0)
  const idleSubcons = (data?.subconDetails || []).length - activeSubcons.length
  const periodLabel = isMultiMonth ? `${ymRange.length}か月` : ymLabel(ym)
  const SITE_COLS = 'lg:grid-cols-[minmax(0,1fr)_130px_130px_130px_84px_70px_130px_130px]'

  const monthStepper = (
    <div className="flex items-center h-[42px] rounded-[10px] border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800">
      <button type="button" aria-label="前の月" onClick={() => navigateMonth(-1)}
        className="w-10 h-full flex items-center justify-center text-hibi-navy dark:text-gray-200 hover:bg-hibi-bg dark:hover:bg-gray-700 rounded-l-[10px]">
        <Icon name="chevronLeft" size={18} strokeWidth={2.2} />
      </button>
      <span className="px-1.5 text-[0.9375rem] font-bold tabular-nums whitespace-nowrap">{ymDisplayLabel}</span>
      <button type="button" aria-label="次の月" onClick={() => navigateMonth(1)}
        className="w-10 h-full flex items-center justify-center text-hibi-navy dark:text-gray-200 hover:bg-hibi-bg dark:hover:bg-gray-700 rounded-r-[10px]">
        <Icon name="chevronRight" size={18} strokeWidth={2.2} />
      </button>
    </div>
  )

  // 請求額の入力欄（1か月のとき。右のパネルの中で使う）
  const billingInputs = (s: SiteProfit) => {
    const key = `${s.id}_${ym}`
    const rows = billingEdits[key] || [0]
    const ver = billingRowsVersion[key] || 0
    return (
      <div className="space-y-2">
        {rows.map((val, ri) => (
          <div key={`${ver}:${ri}`} className="flex items-center gap-2">
            <input
              type="text"
              inputMode="numeric"
              aria-label={`請求額 ${ri + 1}行目`}
              defaultValue={val ? val.toLocaleString() : ''}
              placeholder="金額を入れる"
              onFocus={(e) => { e.target.value = String(Number(e.target.value.replace(/,/g, '')) || '') }}
              onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
              onBlur={(e) => {
                const v = Number(e.target.value.replace(/,/g, '')) || 0
                e.target.value = v ? v.toLocaleString() : ''
                updateBillingRow(s.id, ym, ri, v)
                const updated = [...rows]
                updated[ri] = v
                saveBilling(s.id, ym, updated)
              }}
              className="flex-1 h-11 text-right border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-[10px] px-3 text-base font-bold tabular-nums focus:ring-2 focus:ring-hibi-navy focus:outline-none"
            />
            {rows.length > 1 && (
              <button onClick={() => { removeBillingRow(s.id, ym, ri); const updated = [...rows]; updated.splice(ri, 1); saveBilling(s.id, ym, updated.length > 0 ? updated : [0]) }}
                aria-label="この行を消す"
                className="w-9 h-9 rounded-lg border border-hibi-line dark:border-gray-600 text-gray-400 hover:text-red-600 hover:border-red-300">×</button>
            )}
          </div>
        ))}
        <div className="flex items-center justify-between">
          <button onClick={() => addBillingRow(s.id, ym)} className="text-[0.8125rem] font-bold text-hibi-navy dark:text-blue-300 hover:underline">＋ 請求書が複数あるときは行を足す</button>
          {rows.length > 1 && <span className="text-sm font-bold tabular-nums">計 {fmtYen(rows.reduce((a, b) => a + b, 0))}</span>}
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-7xl mx-auto space-y-5">
      <PageHeader
        group="請求・原価"
        title="原価・収益"
        sub="現場ごとの売上（請求額）と原価（人件費・外注費）から、儲けを見ます。金額は税抜"
        actions={<>
          <Segment value={period} onChange={setPeriod} items={[
            ['monthly', '1か月'], ['3months', '3か月'], ['6months', '6か月'], ['fiscal', '決算期'], ['yearly', '1年'],
          ]} />
          {monthStepper}
        </>}
      />

      {/* 現場の絞り込み（全現場／1現場。1現場のときはメンバー・職種・推移のグラフが出る） */}
      {data && data.siteList && data.siteList.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          <select value={siteFilter} onChange={e => { setSiteFilter(e.target.value); setListFilter('all') }} aria-label="現場"
            className="h-[42px] border border-gray-300 dark:border-gray-600 rounded-[10px] px-3 text-[0.9375rem] font-bold bg-white dark:bg-gray-800 dark:text-white focus:ring-2 focus:ring-hibi-navy focus:outline-none min-w-[260px]">
            <option value="all">全現場</option>
            {data.siteList.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          {siteFilter !== 'all' && (
            <button onClick={() => setSiteFilter('all')} className="text-[0.8125rem] font-bold text-hibi-navy dark:text-blue-300 hover:underline">全現場にもどす</button>
          )}
          {!isMultiMonth && ym === currentYmJst() && (
            <Chip tone="amber">今月は途中までの数字です</Chip>
          )}
        </div>
      )}

      {loading && !data && <div className="text-center py-12 text-gray-400">集計中...</div>}

      {data && t && kpi && (
        <>
          {/* ① 今やること */}
          <section className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <TodoCard icon="pen" tone={noBillingSites.length > 0 ? 'urgent' : 'ok'} title="請求額が入っていない"
              big={noBillingSites.length > 0 ? `${noBillingSites.length}現場` : 'ありません'}
              sub={noBillingSites.length > 0 ? `${siteNames(noBillingSites)}。入れるまでは、人工 × 過去の平均単価の見込みで計算しています` : 'すべての現場に請求額が入っています'}
              action={noBillingSites.length > 0 ? '入れる' : undefined}
              active={listFilter === 'nobill'}
              onClick={noBillingSites.length > 0 ? () => setListFilter(listFilter === 'nobill' ? 'all' : 'nobill') : undefined} />
            <TodoCard icon="alert" tone={lowSites.length > 0 ? 'warn' : 'ok'} title="赤字・粗利が薄い"
              big={lowSites.length > 0 ? `${lowSites.length}現場` : 'ありません'}
              sub={lowSites.length > 0 ? `${siteNames(lowSites)}。粗利率の目安は${LOW_RATE}%以上` : `請求額が入った現場は、どこも粗利率${LOW_RATE}%以上です`}
              action={lowSites.length > 0 ? '見る' : undefined}
              active={listFilter === 'low'}
              onClick={lowSites.length > 0 ? () => setListFilter(listFilter === 'low' ? 'all' : 'low') : undefined} />
            {/* ⚠️ `t.dispatchDeduction &&` の形は値が 0 のとき「0」が描画される。必ず比較式にする */}
            <TodoCard icon="user" tone={(t.dispatchDeduction ?? 0) > 0 ? 'info' : 'ok'} title="出向の差し引き"
              big={(t.dispatchDeduction ?? 0) > 0 ? fmtYen(t.dispatchDeduction ?? 0) : 'ありません'}
              sub={(t.dispatchDeduction ?? 0) > 0
                ? `出向中スタッフの人件費を原価から差し引いています（差し引く前の人件費 ${fmtYen(t.costRaw || 0)}）。売上は差し引き済みの額を入れます`
                : 'この期間に出向中のスタッフはいません'} />
          </section>

          {/* ② 合計 */}
          <section className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
            <Stat label={kpi.estMonths > 0 ? `売上（請求額・見込み${kpi.estMonths}か月を含む）` : '売上（請求額）'} value={fmtYen(kpi.billing)}
              sub={kpi.prevBilling > 0
                // 2026-10-02 総合点検: サーバの prevBilling は前月の1か月分の請求額（日割りではない）。旧の「前月の同じ日まで」は実態と違った
                ? `前月の請求額（1か月分） ${fmtYenMan(kpi.prevBilling)}（${kpi.billing >= kpi.prevBilling ? '+' : ''}${(((kpi.billing - kpi.prevBilling) / kpi.prevBilling) * 100).toFixed(1)}%）`
                : '請求額の合計'} />
            <Stat label="原価" value={fmtYen(kpi.cost)}
              sub={`社員 ${fmtYenMan(t.cost)} ／ 外注 ${fmtYenMan(t.subCost)}（外注率 ${fmtPct(kpi.subconRate)}）`} />
            <Stat label="粗利" value={fmtYen(kpi.profit)} tone={kpi.profit >= 0 ? 'green' : 'red'}
              sub={`粗利率 ${fmtPct(kpi.profitRate)}${noBillingSites.length > 0 ? '（請求額まだの現場は見込みで計算）' : ''}`} />
            <Stat label="人工あたり売上" value={(() => { const v = kpi.estMonths > 0 ? kpi.perWEst : kpi.perW; return v > 0 ? fmtYen(v) : '—' })()}
              sub={`基準 ${fmtYen(kpi.billingPerManDayBaseline)} ／ 1人あたり労務費 ${fmtYen(kpi.laborCostPerPersonAll)}`} />
          </section>

          {/* ③ 現場ごと */}
          <section className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 overflow-hidden">
            <div className="px-5 py-3.5 border-b border-hibi-line dark:border-gray-700 flex flex-wrap items-center gap-3">
              <h2 className="text-[1.0625rem] font-bold text-gray-900 dark:text-white">現場ごと（{periodLabel}）</h2>
              <Segment value={listFilter} onChange={setListFilter} items={[
                ['all', `すべて ${sites.length}`], ['nobill', `請求額まだ ${noBillingSites.length}`], ['low', `粗利が薄い ${lowSites.length}`],
              ]} />
              <span className="ml-auto text-xs text-hibi-sub dark:text-gray-400">
                {isMultiMonth ? '行を押すと、月ごとの請求額と原価の内訳が右に開きます' : '行を押すと、請求額の入力と原価の内訳が右に開きます'}
              </span>
            </div>
            <div className={`hidden lg:grid ${SITE_COLS} gap-3 px-5 py-2.5 bg-hibi-thead dark:bg-gray-700 text-xs font-bold text-hibi-sub dark:text-gray-300`}>
              <span>現場</span><span className="text-right">売上</span><span className="text-right">原価</span><span className="text-right">粗利</span>
              <span className="text-right">粗利率</span><span className="text-right">人工</span><span className="text-right">人工あたり売上</span><span />
            </div>
            {sites.length === 0 ? (
              <div className="px-5 py-8 text-center text-sm text-hibi-sub dark:text-gray-400">この期間のデータはありません</div>
            ) : shownSites.length === 0 ? (
              <div className="px-5 py-8 text-center text-sm text-hibi-sub dark:text-gray-400">この絞り込みに当てはまる現場はありません</div>
            ) : shownSites.map(s => {
              const nb = noBilling(s)
              const pm = perManDay(s)
              return (
                <div key={s.id} role="button" tabIndex={0}
                  onClick={() => setOpenSiteId(s.id)}
                  onKeyDown={e => { if (e.key === 'Enter') setOpenSiteId(s.id) }}
                  className={`border-t border-hibi-line dark:border-gray-700 px-5 py-3 grid grid-cols-2 ${SITE_COLS} gap-x-3 gap-y-1 items-center cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/40 transition tabular-nums`}>
                  <span className="col-span-2 lg:col-span-1 text-[0.9375rem] font-bold text-gray-900 dark:text-gray-100">{s.name}</span>
                  <span className="lg:text-right text-base font-bold">{isEstimate(s)
                    ? <span className="text-gray-400 dark:text-gray-500" title="請求額が入るまでは、人工 × 過去の平均単価の見込み額です"><span className="text-2xs font-normal mr-1">見込み</span>{fmtYen(s.billing)}</span>
                    : s.billing > 0
                      ? (hasEstPart(s)
                        ? <span title={`入力した請求額 ${fmtYen(s.billingRaw ?? 0)} ＋ 請求額まだの月の見込み ${fmtYen(estPart(s))}`}><span className="text-2xs font-normal text-gray-400 dark:text-gray-500 mr-1">見込み込み</span>{fmtYen(s.billing)}</span>
                        : fmtYen(s.billing))
                      : <span className="text-gray-300 dark:text-gray-600">—</span>}</span>
                  <span className="lg:text-right text-[0.9375rem]">{fmtYen(s.totalCost)}</span>
                  <span className="lg:text-right text-base font-bold">{nb
                    ? (isEstimate(s) ? <span className="text-gray-400 dark:text-gray-500">{fmtYen(s.profit)}</span> : <span className="text-gray-300 dark:text-gray-600">—</span>)
                    : <span className={s.profit < 0 ? 'text-red-700 dark:text-red-400' : ''}>{fmtYen(s.profit)}</span>}</span>
                  <span className="lg:text-right">{nb
                    ? (isEstimate(s) ? <span className="text-sm text-gray-400 dark:text-gray-500">{fmtPct(s.profitRate)}</span> : <span className="text-gray-300 dark:text-gray-600">—</span>)
                    : <Chip tone={rateTone(s)}>{fmtPct(s.profitRate)}</Chip>}</span>
                  <span className="lg:text-right text-sm">{s.tobiEquiv > 0 ? fmtNum(s.tobiEquiv) : '—'}</span>
                  <span className="lg:text-right text-sm">
                    {pm > 0 ? <>{fmtYen(pm)}{s.tobiBase > 0 && <span className={`ml-1 text-xs font-bold ${pm >= s.tobiBase ? 'text-blue-700 dark:text-blue-300' : 'text-red-700 dark:text-red-400'}`}>{Math.round(pm / s.tobiBase * 100)}%</span>}</> : '—'}
                  </span>
                  <span className="lg:text-right flex lg:justify-end gap-1 flex-wrap">
                    {nb && <Chip tone="red">請求額まだ</Chip>}
                    {lowProfit(s) && <Chip tone={s.profitRate < 0 ? 'red' : 'amber'}>{s.profitRate < 0 ? '赤字' : '粗利が薄い'}</Chip>}
                    {(s.dispatchDeduction ?? 0) > 0 && <Chip tone="gray" title="出向中スタッフの人件費を差し引いています">出向 −{fmtYen(s.dispatchDeduction ?? 0)}</Chip>}
                  </span>
                </div>
              )
            })}
            {sites.length > 0 && (
              <div className={`border-t-2 border-gray-300 dark:border-gray-600 px-5 py-3 grid grid-cols-2 ${SITE_COLS} gap-x-3 gap-y-1 font-bold tabular-nums text-[0.9375rem]`}>
                <span className="col-span-2 lg:col-span-1">合計</span>
                <span className="lg:text-right">{fmtYen(t.billing)}</span>
                <span className="lg:text-right">{fmtYen(t.totalCost)}</span>
                <span className={`lg:text-right ${t.profit < 0 ? 'text-red-700 dark:text-red-400' : ''}`}>{fmtYen(t.profit)}</span>
                <span className="lg:text-right">{fmtPct(t.profitRate)}</span>
                <span className="lg:text-right">—</span>
                <span className="lg:text-right">{(t.workDays + t.subWorkDays) > 0 ? fmtYen(Math.round(t.billing / (t.workDays + t.subWorkDays))) : '—'}</span>
                <span />
              </div>
            )}
          </section>

          {/* 1現場のとき: メンバー・職種構成・推移 */}
          {siteFilter !== 'all' && data.siteMembers && data.siteMembers.length > 0 && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <Section title="メンバー一覧">
                <SiteMemberList members={data.siteMembers} />
              </Section>
              <Section title="職種構成">
                <DonutChart members={data.siteMembers} />
              </Section>
            </div>
          )}
          {siteFilter !== 'all' && data.siteTrend && data.siteTrend.length > 1 && (
            <Section title="月ごとの推移（人数・原価）">
              <SiteTrendChart data={data.siteTrend} />
            </Section>
          )}

          {/* ④ 月ごとの推移 */}
          {data.monthlyTrend && data.monthlyTrend.length > 1 && (
            <MonthlyTrendSection trend={data.monthlyTrend} title={`月ごとの推移（売上・原価・粗利）${siteFilter === 'all' ? '（全現場）' : ''}`} />
          )}

          {/* 人工あたりの推移 */}
          {data.monthlyTrend && data.monthlyTrend.length > 0 && (
            <Section title={`人工あたりの推移${siteFilter === 'all' ? '（全現場）' : ''}（${(() => {
              const firstYm = data.monthlyTrend[0].ym
              const m = parseInt(firstYm.slice(4, 6))
              const y = parseInt(firstYm.slice(0, 4))
              return `${m >= 10 ? y : y - 1}年度`
            })()}）`}>
              <KPILineChart data={data.monthlyTrend} baseline={kpi.billingPerManDayBaseline} />
            </Section>
          )}

          {/* 累積（決算期） */}
          {data.cumulativeData && data.cumulativeData.length > 0 && (
            <CumulativeSection data={data.cumulativeData} />
          )}

          {/* ⑤ 外注先（来てもらった会社だけ。来ていない会社は隠す） */}
          {data.subconDetails && data.subconDetails.length > 0 && (
            <section className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 overflow-hidden">
              <div className="px-5 py-3.5 border-b border-hibi-line dark:border-gray-700">
                <h2 className="text-[1.0625rem] font-bold text-gray-900 dark:text-white">外注先（{periodLabel}に来てもらった会社）</h2>
              </div>
              <div className="hidden md:grid grid-cols-[minmax(0,1fr)_80px_100px_100px_70px_70px_120px] gap-3 px-5 py-2.5 bg-hibi-thead dark:bg-gray-700 text-xs font-bold text-hibi-sub dark:text-gray-300">
                <span>会社</span><span>職種</span><span className="text-right">人工単価</span><span className="text-right">残業単価</span><span className="text-right">人工</span><span className="text-right">残業</span><span className="text-right">金額</span>
              </div>
              {(showIdleSubcons ? data.subconDetails : activeSubcons).map(sc => {
                const idle = !(sc.workDays > 0 || sc.cost > 0)
                return (
                  <div key={sc.id} className={`border-t border-hibi-line dark:border-gray-700 px-5 py-2.5 grid grid-cols-2 md:grid-cols-[minmax(0,1fr)_80px_100px_100px_70px_70px_120px] gap-x-3 gap-y-1 items-center text-sm tabular-nums ${idle ? 'text-gray-400' : ''}`}>
                    <span className="col-span-2 md:col-span-1 font-bold">{sc.name}</span>
                    <span><Chip tone="gray">{sc.type.replace('業者', '')}</Chip></span>
                    <span className="md:text-right text-hibi-sub dark:text-gray-400">{fmtYen(sc.rate)}</span>
                    <span className="md:text-right text-hibi-sub dark:text-gray-400">{sc.otRate ? fmtYen(sc.otRate) : '—'}</span>
                    <span className="md:text-right">{fmtNum(sc.workDays)}</span>
                    <span className="md:text-right">{fmtNum(sc.otCount)}</span>
                    <span className="md:text-right font-bold">{fmtYen(sc.cost)}</span>
                  </div>
                )
              })}
              <div className="border-t-2 border-gray-300 dark:border-gray-600 px-5 py-2.5 flex items-center gap-3 text-sm">
                <span className="font-bold">合計 {fmtNum(activeSubcons.reduce((a, sc) => a + sc.workDays, 0))}人工</span>
                <span className="ml-auto text-base font-bold tabular-nums">{fmtYen(activeSubcons.reduce((a, sc) => a + sc.cost, 0))}</span>
              </div>
              {idleSubcons > 0 && (
                <div className="border-t border-hibi-line dark:border-gray-700 px-5 py-2.5 text-xs text-hibi-sub dark:text-gray-400">
                  {showIdleSubcons ? '来ていない会社も出しています' : `来ていない${idleSubcons}社は隠しています`}
                  <button onClick={() => setShowIdleSubcons(v => !v)} className="ml-2 font-bold text-hibi-navy dark:text-blue-300 hover:underline">
                    {showIdleSubcons ? '隠す' : 'すべて出す'}
                  </button>
                </div>
              )}
            </section>
          )}
        </>
      )}

      {/* 現場の内訳（右から開く） */}
      {openSite && (
        <SidePanel label={`${openSite.name} の原価・収益`} onClose={() => setOpenSiteId(null)}>
          <div className="p-6 space-y-6">
            <div className="flex items-start gap-3">
              <div className="flex-1 min-w-0">
                <h2 className="text-[1.375rem] font-bold text-gray-900 dark:text-white">{openSite.name}</h2>
                <div className="text-[0.8125rem] text-hibi-sub dark:text-gray-400 tabular-nums">
                  {isMultiMonth ? `${ymLabel(ymRange[0])}〜${ymLabel(ymRange[ymRange.length - 1])}` : ymDisplayLabel} ／ 人工 {fmtNum(openSite.tobiEquiv)} ／ 原価 {fmtYen(openSite.totalCost)}
                </div>
              </div>
              <CloseButton onClick={() => setOpenSiteId(null)} />
            </div>

            <section className="space-y-2">
              <div className="flex items-center gap-2">
                <h3 className="text-base font-bold text-gray-900 dark:text-white">{isMultiMonth ? '請求額（月ごと）' : `請求額（${ymLabel(ym)}分）`}</h3>
                {noBilling(openSite) && <Chip tone="red">まだ入っていない</Chip>}
              </div>
              {isMultiMonth ? (
                <div className="rounded-xl border border-hibi-line dark:border-gray-700 overflow-hidden text-sm">
                  {ymRange.map(m => {
                    const rows = billingEdits[`${openSite.id}_${m}`] || [0]
                    const sum = rows.reduce((a: number, b: number) => a + b, 0)
                    return (
                      <div key={m} className="flex justify-between px-3 py-2 border-t first:border-t-0 border-hibi-line dark:border-gray-700 tabular-nums">
                        <span>{ymLabel(m)}</span><span className={sum > 0 ? 'font-bold' : 'text-gray-400'}>{sum > 0 ? fmtYen(sum) : 'まだ'}</span>
                      </div>
                    )
                  })}
                  <div className="flex justify-between px-3 py-2.5 border-t-2 border-gray-300 dark:border-gray-600">
                    <span className="font-bold">合計{(isEstimate(openSite) || hasEstPart(openSite)) ? '（見込み込み）' : ''}</span><span className="text-lg font-bold tabular-nums">{fmtYen(openSite.billing)}</span>
                  </div>
                  {(isEstimate(openSite) || hasEstPart(openSite)) && (
                    <div className="px-3 py-2 text-xs text-hibi-sub dark:text-gray-400 border-t border-hibi-line dark:border-gray-700 tabular-nums">
                      入れた請求額 {fmtYen(openSite.billingRaw ?? 0)} ＋ 「まだ」の月の見込み {fmtYen(isEstimate(openSite) ? openSite.billing : estPart(openSite))}（人工 × 過去の平均単価）
                    </div>
                  )}
                  <div className="px-3 py-2 text-xs text-hibi-sub dark:text-gray-400 border-t border-hibi-line dark:border-gray-700">請求額を入れるときは、上の期間を「1か月」にして、その月を開いてください</div>
                </div>
              ) : (
                <>
                  {isEstimate(openSite) && (
                    <p className="text-[0.8125rem] text-hibi-sub dark:text-gray-400">いまは見込み <b className="tabular-nums text-gray-700 dark:text-gray-200">{fmtYen(openSite.billing)}</b>（人工 × 過去の平均単価）で計算しています。請求額を入れると置き換わります</p>
                  )}
                  {billingInputs(openSite)}
                  <p className="text-xs text-hibi-sub dark:text-gray-400">入れると自動で保存し、粗利を計算し直します。出向中スタッフの分は差し引いた額を入れてください</p>
                </>
              )}
            </section>

            <section className="space-y-1">
              <h3 className="text-base font-bold text-gray-900 dark:text-white mb-1">原価の内訳</h3>
              <div className="flex justify-between py-2 border-t border-hibi-line dark:border-gray-700 text-sm tabular-nums"><span>社員の人件費（{fmtNum(openSite.workDays)}人工）</span><span>{fmtYen(openSite.cost)}</span></div>
              {(openSite.dispatchDeduction ?? 0) > 0 && (
                <div className="flex justify-between py-2 border-t border-hibi-line dark:border-gray-700 text-sm tabular-nums text-hibi-sub dark:text-gray-400"><span>（出向の差し引き済み・差し引いた額）</span><span>−{fmtYen(openSite.dispatchDeduction ?? 0)}</span></div>
              )}
              {(data?.subconDetails || []).flatMap(sc => sc.siteBreakdown.filter(b => b.siteId === openSite.id && b.cost > 0).map(b => (
                <div key={sc.id} className="flex justify-between py-2 border-t border-hibi-line dark:border-gray-700 text-sm tabular-nums"><span>外注 {sc.name}（{fmtNum(b.workDays)}人工）</span><span>{fmtYen(b.cost)}</span></div>
              )))}
              {openSite.subCost > 0 && !(data?.subconDetails || []).some(sc => sc.siteBreakdown.some(b => b.siteId === openSite.id && b.cost > 0)) && (
                <div className="flex justify-between py-2 border-t border-hibi-line dark:border-gray-700 text-sm tabular-nums"><span>外注費（{fmtNum(openSite.subWorkDays)}人工）</span><span>{fmtYen(openSite.subCost)}</span></div>
              )}
              <div className="flex justify-between py-2.5 border-t-2 border-gray-300 dark:border-gray-600"><span className="font-bold">原価 合計</span><span className="text-lg font-bold tabular-nums">{fmtYen(openSite.totalCost)}</span></div>
            </section>

            {openSite.billing > 0 && (
              <section className="grid grid-cols-2 gap-3">
                <div className="rounded-xl border border-hibi-line dark:border-gray-700 px-4 py-3">
                  <div className="text-xs text-hibi-sub dark:text-gray-400">粗利{isEstimate(openSite) ? '（見込み）' : hasEstPart(openSite) ? '（見込み込み）' : ''}</div>
                  <div className={`text-xl font-bold tabular-nums ${openSite.profit < 0 ? 'text-red-700 dark:text-red-400' : ''}`}>{fmtYen(openSite.profit)}</div>
                  <div className="mt-1"><Chip tone={rateTone(openSite)}>粗利率 {fmtPct(openSite.profitRate)}</Chip></div>
                </div>
                <div className="rounded-xl border border-hibi-line dark:border-gray-700 px-4 py-3">
                  <div className="text-xs text-hibi-sub dark:text-gray-400">人工あたり売上</div>
                  <div className="text-xl font-bold tabular-nums">{perManDay(openSite) > 0 ? fmtYen(perManDay(openSite)) : '—'}</div>
                  {openSite.tobiBase > 0 && <div className="text-xs text-hibi-sub dark:text-gray-400 mt-1">基準 {fmtYen(openSite.tobiBase)}</div>}
                </div>
              </section>
            )}

            {siteFilter !== openSite.id && (
              <button onClick={() => { setSiteFilter(openSite.id); setListFilter('all'); setOpenSiteId(null) }}
                className="w-full h-11 rounded-[10px] border border-gray-300 dark:border-gray-600 text-sm font-bold text-hibi-navy dark:text-gray-200 hover:bg-hibi-bg dark:hover:bg-gray-700">
                この現場だけの画面で詳しく見る（メンバー・グラフ）
              </button>
            )}
          </div>
        </SidePanel>
      )}
    </div>
  )
}

// ─── Sub-components ───

function Stat({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: 'green' | 'red' }) {
  const c = tone === 'green' ? 'text-green-700 dark:text-green-400' : tone === 'red' ? 'text-red-700 dark:text-red-400' : 'text-gray-900 dark:text-white'
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 px-5 py-4 flex flex-col gap-1">
      <span className="text-[0.8125rem] text-hibi-sub dark:text-gray-400">{label}</span>
      <span className={`text-[1.625rem] font-bold tabular-nums ${c}`}>{value}</span>
      <span className="text-xs text-hibi-sub dark:text-gray-400">{sub}</span>
    </div>
  )
}

function MonthlyTrendSection({ trend, title }: { trend: MonthlyTrend[]; title: string }) {
  return (
        <Section title={title}>
          <div className="overflow-x-auto">
            {/* Bar chart */}
            <div className="flex items-end gap-2" style={{ minWidth: `${trend.length * 70}px`, height: '260px' }}>
              {trend.map((m) => {
                const maxVal = Math.max(
                  ...trend.map(t => Math.max(t.billing, t.cost, Math.abs(t.profit))),
                  1
                )
                const billingH = (m.billing / maxVal) * 180
                const costH = (m.cost / maxVal) * 180
                const profitH = (Math.abs(m.profit) / maxVal) * 180
                const profitRate = m.billing > 0 ? (m.profit / m.billing) * 100 : 0

                return (
                  <div key={m.ym} className="flex flex-col items-center flex-1" style={{ minWidth: '64px' }}>
                    {/* 数値ラベル */}
                    <div className="text-3xs text-gray-400 text-center whitespace-nowrap">
                      売{fmtYenMan(m.billing)}
                    </div>
                    {/* 3本バー */}
                    <div className="flex items-end gap-0.5" style={{ height: '180px' }}>
                      <div
                        className="w-4 bg-blue-500 rounded-t"
                        style={{ height: `${billingH}px` }}
                        title={`売上 ${fmtYen(m.billing)}`}
                      />
                      <div
                        className="w-4 bg-orange-400 rounded-t"
                        style={{ height: `${costH}px` }}
                        title={`原価 ${fmtYen(m.cost)}`}
                      />
                      <div
                        className={`w-4 ${m.profit >= 0 ? 'bg-green-500' : 'bg-red-500'} rounded-t`}
                        style={{ height: `${profitH}px` }}
                        title={`粗利 ${fmtYen(m.profit)}`}
                      />
                    </div>
                    {/* 粗利 + 粗利率 */}
                    <div className={`text-3xs font-bold text-center mt-1 whitespace-nowrap ${m.profit >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                      {m.profit >= 0 ? '+' : ''}{fmtYenMan(m.profit)}
                    </div>
                    <div className="text-3xs text-gray-400 text-center whitespace-nowrap">
                      {profitRate.toFixed(1)}%
                    </div>
                    <div className="text-2xs text-gray-600 font-medium mt-1">{ymToShortLabel(m.ym)}</div>
                  </div>
                )
              })}
            </div>
            {/* 凡例 */}
            <div className="flex items-center gap-4 pt-2 mt-2 text-xs text-gray-500 dark:text-gray-400 border-t flex-wrap">
              <span className="flex items-center gap-1">
                <span className="inline-block w-3 h-3 bg-blue-500 rounded" /> 売上
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block w-3 h-3 bg-orange-400 rounded" /> 原価
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block w-3 h-3 bg-green-500 rounded" /> 粗利（黒字）
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block w-3 h-3 bg-red-500 rounded" /> 粗利（赤字）
              </span>
            </div>
          </div>

          {/* 月別数値テーブル */}
          <div className="overflow-x-auto mt-4">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-gray-50 dark:bg-gray-700 text-gray-600 dark:text-gray-300">
                  <th className="px-2 py-1.5 text-left">月</th>
                  <th className="px-2 py-1.5 text-right">売上</th>
                  <th className="px-2 py-1.5 text-right">原価</th>
                  <th className="px-2 py-1.5 text-right">粗利</th>
                  <th className="px-2 py-1.5 text-right">粗利率</th>
                  <th className="px-2 py-1.5 text-right">鳶換算人工</th>
                </tr>
              </thead>
              <tbody>
                {trend.map(m => {
                  const profitRate = m.billing > 0 ? (m.profit / m.billing) * 100 : 0
                  return (
                    <tr key={m.ym} className="border-t dark:border-gray-700">
                      <td className="px-2 py-1.5 font-medium">{ymToShortLabel(m.ym)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{fmtYen(m.billing)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-orange-600">{fmtYen(m.cost)}</td>
                      <td className={`px-2 py-1.5 text-right tabular-nums font-bold ${m.profit >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                        {m.profit >= 0 ? '+' : ''}{fmtYen(m.profit)}
                      </td>
                      <td className={`px-2 py-1.5 text-right tabular-nums ${m.profit >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                        {profitRate.toFixed(1)}%
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-gray-600">{m.equiv.toFixed(1)}</td>
                    </tr>
                  )
                })}
                {/* 合計行 */}
                {(() => {
                  const tot = trend.reduce((acc, m) => ({
                    billing: acc.billing + m.billing,
                    cost: acc.cost + m.cost,
                    profit: acc.profit + m.profit,
                    equiv: acc.equiv + m.equiv,
                  }), { billing: 0, cost: 0, profit: 0, equiv: 0 })
                  const totRate = tot.billing > 0 ? (tot.profit / tot.billing) * 100 : 0
                  return (
                    <tr className="border-t-2 border-hibi-navy bg-gray-50 dark:bg-gray-700 font-bold">
                      <td className="px-2 py-2">合計</td>
                      <td className="px-2 py-2 text-right tabular-nums">{fmtYen(tot.billing)}</td>
                      <td className="px-2 py-2 text-right tabular-nums text-orange-600">{fmtYen(tot.cost)}</td>
                      <td className={`px-2 py-2 text-right tabular-nums ${tot.profit >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                        {tot.profit >= 0 ? '+' : ''}{fmtYen(tot.profit)}
                      </td>
                      <td className={`px-2 py-2 text-right tabular-nums ${tot.profit >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                        {totRate.toFixed(1)}%
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums text-gray-700">{tot.equiv.toFixed(1)}</td>
                    </tr>
                  )
                })()}
              </tbody>
            </table>
          </div>
        </Section>
  )
}

function CumulativeSection({ data }: { data: CumulativeData[] }) {
  return (
        <Section title="累積推移（決算期）">
          <div className="overflow-x-auto">
            <div className="flex items-end gap-1" style={{ minWidth: `${data.length * 60}px`, height: '220px' }}>
              {data.map((cd) => {
                const maxCum = Math.max(
                  ...data.map(c => Math.max(c.cumBilling, c.cumCost)),
                  1
                )
                const billingH = (cd.cumBilling / maxCum) * 180
                const costH = (cd.cumCost / maxCum) * 180

                return (
                  <div key={cd.ym} className="flex flex-col items-center" style={{ width: '56px' }}>
                    <div className="flex items-end gap-0.5" style={{ height: '180px' }}>
                      <div
                        className="w-5 bg-blue-500 rounded-t"
                        style={{ height: `${billingH}px` }}
                        title={`売上 ${fmtYenMan(cd.cumBilling)}`}
                      />
                      <div
                        className="w-5 bg-orange-400 rounded-t"
                        style={{ height: `${costH}px` }}
                        title={`原価 ${fmtYenMan(cd.cumCost)}`}
                      />
                    </div>
                    {cd.cumProfit !== 0 && (
                      <div className={`text-3xs font-bold ${cd.cumProfit >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                        {fmtYenMan(cd.cumProfit)}
                      </div>
                    )}
                    <div className="text-3xs text-gray-500 mt-0.5">{ymToShortLabel(cd.ym)}</div>
                  </div>
                )
              })}
            </div>
            <div className="flex items-center gap-4 pt-2 mt-2 text-xs text-gray-500 dark:text-gray-400 border-t">
              <span className="flex items-center gap-1">
                <span className="inline-block w-3 h-3 bg-blue-500 rounded" /> 累積売上
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block w-3 h-3 bg-orange-400 rounded" /> 累積原価
              </span>
              <span className="text-green-600 font-bold">数値=累積粗利</span>
            </div>
          </div>
        </Section>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100 bg-white dark:bg-gray-800">
        <h2 className="font-bold text-hibi-navy dark:text-blue-300 text-sm">{title}</h2>
      </div>
      <div className="p-4">
        {children}
      </div>
    </div>
  )
}

/** SVG line chart for per-worker KPIs */
function KPILineChart({
  data,
  baseline,
}: {
  data: MonthlyTrend[]
  baseline: number
}) {
  if (data.length === 0) return null

  const COLORS = {
    billing: '#2563EB',
    cost: '#EA580C',
    profit: '#16A34A',
    baseline: '#DC2626',
    grid: '#E5E7EB',
  }

  const activeData = data.filter(d => d.billingPerManDay > 0 || d.costPerManDay > 0 || d.profitPerManDay > 0)
  const avgBilling = activeData.length > 0
    ? Math.round(activeData.reduce((s, d) => s + d.billingPerManDay, 0) / activeData.length)
    : 0
  const avgCost = activeData.length > 0
    ? Math.round(activeData.reduce((s, d) => s + d.costPerManDay, 0) / activeData.length)
    : 0
  const avgProfit = avgBilling - avgCost

  const svgW = 800
  const svgH = 400
  const padL = 70
  const padR = 20
  const padT = 50
  const padB = 58   // 月ラベル + 差益の2段ぶん
  const chartW = svgW - padL - padR
  const chartH = svgH - padT - padB

  const allValues = [
    ...data.map(d => d.billingPerManDay),
    ...data.map(d => d.costPerManDay),
    ...data.map(d => d.profitPerManDay),
    baseline,
  ]
  const rawMax = Math.max(...allValues, 1)
  const rawMin = Math.min(...allValues.filter(v => v > 0), 0)
  const range = rawMax - rawMin || 1
  const maxVal = rawMax + range * 0.15
  const minVal = Math.max(rawMin - range * 0.1, 0)
  const yRange = maxVal - minVal || 1

  const getX = (i: number) => padL + (data.length > 1 ? (i / (data.length - 1)) * chartW : chartW / 2)
  const getY = (val: number) => padT + chartH - ((val - minVal) / yRange) * chartH

  const makePath = (values: number[]) =>
    values.map((v, i) => `${i === 0 ? 'M' : 'L'}${getX(i).toFixed(1)},${getY(v).toFixed(1)}`).join(' ')

  const billingPath = makePath(data.map(d => d.billingPerManDay))
  const costPath = makePath(data.map(d => d.costPerManDay))

  const barW = 30
  const zeroY = Math.min(getY(0), padT + chartH)

  const yTickCount = 5
  const yTicks = Array.from({ length: yTickCount + 1 }, (_, i) => {
    const val = minVal + (yRange * i) / yTickCount
    return { val, y: getY(val) }
  })

  const baselineY = getY(baseline)

  return (
    <div>
      <div className="flex items-center justify-end gap-4 text-xs mb-2 flex-wrap">
        <span className="flex items-center gap-1">
          <span className="inline-block w-5 h-0.5" style={{ backgroundColor: COLORS.billing }} />
          <span className="text-gray-600 dark:text-gray-400">売上 {fmtYen(avgBilling)}</span>
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-5 h-0.5" style={{ backgroundColor: COLORS.cost }} />
          <span className="text-gray-600 dark:text-gray-400">原価 {fmtYen(avgCost)}</span>
        </span>
        <span className={`font-bold ${avgProfit >= 0 ? 'text-green-600' : 'text-red-600'}`}>
          差益 {avgProfit >= 0 ? '+' : ''}{fmtYen(avgProfit)}
        </span>
      </div>

      <svg viewBox={`0 0 ${svgW} ${svgH}`} className="w-full" style={{ maxHeight: '400px' }} preserveAspectRatio="xMidYMid meet">
        {yTicks.map((t, i) => (
          <g key={i}>
            <line x1={padL} y1={t.y} x2={svgW - padR} y2={t.y} stroke={COLORS.grid} strokeWidth="1" />
            <text x={padL - 8} y={t.y + 4} textAnchor="end" fill="#9ca3af" fontSize="11">
              {fmtYen(t.val)}
            </text>
          </g>
        ))}

        {/* 基準線 */}
        <line
          x1={padL} y1={baselineY} x2={svgW - padR} y2={baselineY}
          stroke={COLORS.baseline} strokeWidth="1.5" strokeDasharray="8 4"
        />

        {/* 差益バー */}
        {data.map((d, i) => {
          const x = getX(i)
          const val = d.profitPerManDay
          const barTop = val >= 0 ? getY(val) : zeroY
          const barBottom = val >= 0 ? zeroY : getY(val)
          const h = barBottom - barTop
          return (
            <rect
              key={`bar-${i}`}
              x={x - barW / 2}
              y={barTop}
              width={barW}
              height={Math.max(h, 1)}
              fill={val >= 0 ? COLORS.profit : '#DC2626'}
              opacity={0.7}
              rx={2}
            />
          )
        })}

        {/* 折れ線 */}
        <path d={billingPath} fill="none" stroke={COLORS.billing} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
        <path d={costPath} fill="none" stroke={COLORS.cost} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />

        {/* ラベルの置き方の原則:
            ・売上 = 青ドットの上（上空側。上には基準線しかない）
            ・原価 = 橙ドットの上（売上線との間の回廊。バーは原価線の下から迫るので、
              下に置くとバーに刺さる。以前の「ドットの下」が崩れていた原因）
            ・差益 = プロットの外（軸の下の2段目）。バーや線と場所を取り合わない
            線が接近したときだけ、2つのラベルの間隔14pxを機械的に確保する */}
        {data.map((d, i) => {
          const x = getX(i)
          // 端の列は y軸目盛りや枠と重なるため、ラベルだけ内側へ寄せる
          const labelX = Math.min(Math.max(x, padL + 26), svgW - padR - 26)
          const bY = getY(d.billingPerManDay)
          const cY = getY(d.costPerManDay)

          let bLabelY = bY - 10
          let cLabelY = cY - 10
          // 基準線（破線）に乗るときは上へ逃がす
          if (Math.abs(bLabelY - baselineY) < 12) bLabelY = Math.min(bLabelY, baselineY - 14)
          // 売上と原価のラベル間隔を確保（上側にある売上をさらに上へ）
          if (cLabelY - bLabelY < 14) bLabelY = cLabelY - 14
          bLabelY = Math.max(bLabelY, padT - 36)
          cLabelY = Math.max(cLabelY, bLabelY + 14)

          return (
            <g key={`labels-${i}`}>
              <circle cx={x} cy={bY} r={4} fill={COLORS.billing} stroke="white" strokeWidth="2" />
              <text x={labelX} y={bLabelY} textAnchor="middle" fill={COLORS.billing} fontSize="9" fontWeight="600">
                {fmtYen(d.billingPerManDay)}
              </text>

              <circle cx={x} cy={cY} r={4} fill={COLORS.cost} stroke="white" strokeWidth="2" />
              <text x={labelX} y={cLabelY} textAnchor="middle" fill={COLORS.cost} fontSize="9" fontWeight="600">
                {fmtYen(d.costPerManDay)}
              </text>
            </g>
          )
        })}

        {data.map((d, i) => {
          const x = getX(i)
          const labelX = Math.min(Math.max(x, padL + 26), svgW - padR - 26)
          const p = d.profitPerManDay
          return (
            <g key={`x-${i}`}>
              <text x={x} y={svgH - 24} textAnchor="middle" fill="#6b7280" fontSize="11">
                {ymToShortLabel(d.ym)}
              </text>
              <text x={labelX} y={svgH - 8} textAnchor="middle"
                fill={p >= 0 ? COLORS.profit : '#DC2626'} fontSize="9" fontWeight="600">
                {p >= 0 ? '+' : ''}{fmtYen(p)}
              </text>
            </g>
          )
        })}
      </svg>

      <div className="flex items-center gap-5 text-xs text-gray-500 dark:text-gray-400 mt-1 flex-wrap">
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-4 h-0.5 rounded" style={{ backgroundColor: COLORS.billing }} /> 売上/人工
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-4 h-0.5 rounded" style={{ backgroundColor: COLORS.cost }} /> 原価/人工
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-3 h-3 rounded-sm" style={{ backgroundColor: COLORS.profit, opacity: 0.7 }} /> 差益/人工（数値は月の下）
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-4 border-t-2 border-dashed" style={{ borderColor: COLORS.baseline }} /> 基準
        </span>
      </div>
    </div>
  )
}

/** Site member list grouped by org */
function SiteMemberList({ members }: { members: SiteMember[] }) {
  const hibi = members.filter(m => m.org !== 'hfu')
  const hfu = members.filter(m => m.org === 'hfu')

  const renderGroup = (label: string, workers: SiteMember[], badgeClass: string) => {
    if (workers.length === 0) return null
    return (
      <div>
        <div className="flex items-center gap-2 mb-2">
          <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${badgeClass}`}>{label}</span>
          <span className="text-xs text-gray-400">{workers.length}名</span>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {workers.map(w => (
            <div
              key={w.id}
              className="flex flex-col gap-1 p-2 bg-gray-50 rounded-lg border border-gray-100 hover:border-gray-200 transition-colors"
            >
              <span className="font-medium text-sm text-hibi-navy truncate">{w.name}</span>
              <div className="flex flex-wrap gap-1">
                <span className={`text-3xs px-1.5 py-0.5 rounded-full font-medium ${jobBadgeColor(w.job)}`}>
                  {jobLabel(w.job)}
                </span>
                {visaBadge(w.visa) && (
                  <span className="text-3xs px-1.5 py-0.5 rounded-full font-medium bg-teal-100 text-teal-700">
                    {visaBadge(w.visa)}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {renderGroup('日比建設', hibi, 'bg-sky-100 text-sky-700')}
      {renderGroup('HFU', hfu, 'bg-purple-100 text-purple-700')}
      {members.length === 0 && (
        <p className="text-gray-400 text-sm text-center py-4">配置メンバーなし</p>
      )}
    </div>
  )
}

/** SVG donut chart showing tobi vs doko breakdown */
function DonutChart({ members }: { members: SiteMember[] }) {
  // 2026-06-XX 修正: 集計ルール（鳶合計＝とび+鳶見習い+職長+役員+外注鳶）に合わせ
  //                 単一の真理ソース isTobiGroup を使用。
  //                 旧コードはハードコードで 'とび' / 'tobi' / '鳶' のみ判定しており
  //                 鳶見習い・職長・役員が誤って土工に分類されていた。
  const tobi = members.filter(m => isTobiGroup(m.job)).length
  const doko = members.length - tobi
  const total = members.length

  if (total === 0) return <p className="text-gray-400 text-sm text-center py-4">データなし</p>

  const tobiPct = total > 0 ? tobi / total : 0
  const circumference = 2 * Math.PI * 60

  return (
    <div className="flex flex-col items-center">
      <svg width="180" height="180" viewBox="0 0 180 180">
        <circle cx="90" cy="90" r="60" fill="none" stroke="#e5e7eb" strokeWidth="24" />
        <circle
          cx="90" cy="90" r="60" fill="none"
          stroke="#78716c" strokeWidth="24"
          strokeDasharray={`${circumference} ${circumference}`}
          strokeDashoffset="0"
          transform="rotate(-90 90 90)"
          className="transition-all duration-500"
        />
        <circle
          cx="90" cy="90" r="60" fill="none"
          stroke="#f59e0b" strokeWidth="24"
          strokeDasharray={`${tobiPct * circumference} ${circumference}`}
          strokeDashoffset="0"
          transform="rotate(-90 90 90)"
          className="transition-all duration-500"
        />
        <text x="90" y="84" textAnchor="middle" fontSize="28" fontWeight="bold" fill="#1e3a5f">
          {total}
        </text>
        <text x="90" y="104" textAnchor="middle" fontSize="12" fill="#9ca3af">
          名
        </text>
      </svg>
      <div className="flex items-center gap-6 mt-2">
        <div className="flex items-center gap-2">
          <span className="w-3 h-3 rounded-full bg-amber-500" />
          <span className="text-sm text-gray-700">鳶 <span className="font-bold">{tobi}</span>名</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-3 h-3 rounded-full bg-stone-500" />
          <span className="text-sm text-gray-700">土工 <span className="font-bold">{doko}</span>名</span>
        </div>
      </div>
    </div>
  )
}

/** SVG trend chart: worker count and cost per month */
function SiteTrendChart({ data }: { data: SiteTrendPoint[] }) {
  const [hoveredI, setHoveredI] = useState<number | null>(null)

  if (data.length === 0) return null

  const maxWorkers = Math.max(...data.map(d => d.workerCount), 1)
  const maxCostVal = Math.max(...data.map(d => d.cost), 1)

  const svgW = 600
  const svgH = 200
  const padL = 48
  const padR = 48
  const padT = 16
  const padB = 32
  const chartW = svgW - padL - padR
  const chartH = svgH - padT - padB

  const getX = (i: number) => padL + (data.length > 1 ? (i / (data.length - 1)) * chartW : chartW / 2)
  const getWorkerY = (v: number) => padT + chartH - (v / maxWorkers) * chartH
  const getCostY = (v: number) => padT + chartH - (v / maxCostVal) * chartH

  const workerPath = data.map((d, i) =>
    `${i === 0 ? 'M' : 'L'}${getX(i).toFixed(1)},${getWorkerY(d.workerCount).toFixed(1)}`
  ).join(' ')

  const costPath = data.map((d, i) =>
    `${i === 0 ? 'M' : 'L'}${getX(i).toFixed(1)},${getCostY(d.cost).toFixed(1)}`
  ).join(' ')

  const workerTicks = Array.from({ length: 5 }, (_, i) => {
    const val = (maxWorkers * i) / 4
    return { val: Math.round(val), y: getWorkerY(val) }
  })

  const costTicks = Array.from({ length: 5 }, (_, i) => {
    const val = (maxCostVal * i) / 4
    return { val, y: getCostY(val) }
  })

  return (
    <div className="space-y-2">
      <svg viewBox={`0 0 ${svgW} ${svgH}`} className="w-full" style={{ maxHeight: '240px' }}>
        {workerTicks.map((t, i) => (
          <line key={i} x1={padL} y1={t.y} x2={svgW - padR} y2={t.y} stroke="#f0f0f0" strokeWidth="1" />
        ))}

        {workerTicks.map((t, i) => (
          <text key={`wl-${i}`} x={padL - 6} y={t.y + 4} textAnchor="end" fill="#3b82f6" fontSize="10">
            {t.val}
          </text>
        ))}
        <text x={6} y={padT + chartH / 2} textAnchor="middle" fill="#3b82f6" fontSize="9" transform={`rotate(-90, 6, ${padT + chartH / 2})`}>
          人数
        </text>

        {costTicks.map((t, i) => (
          <text key={`cl-${i}`} x={svgW - padR + 6} y={t.y + 4} textAnchor="start" fill="#f59e0b" fontSize="10">
            {Math.round(t.val / 10000)}万
          </text>
        ))}
        <text x={svgW - 6} y={padT + chartH / 2} textAnchor="middle" fill="#f59e0b" fontSize="9" transform={`rotate(90, ${svgW - 6}, ${padT + chartH / 2})`}>
          原価
        </text>

        <path d={costPath} fill="none" stroke="#f59e0b" strokeWidth="2" opacity="0.7" />
        <path d={workerPath} fill="none" stroke="#3b82f6" strokeWidth="2.5" />

        {data.map((d, i) => (
          <circle
            key={`wd-${i}`}
            cx={getX(i)} cy={getWorkerY(d.workerCount)} r={hoveredI === i ? 6 : 4}
            fill="#3b82f6" stroke="white" strokeWidth="2"
            className="transition-all duration-150 cursor-pointer"
            onMouseEnter={() => setHoveredI(i)}
            onMouseLeave={() => setHoveredI(null)}
          />
        ))}

        {data.map((d, i) => (
          <circle
            key={`cd-${i}`}
            cx={getX(i)} cy={getCostY(d.cost)} r={3}
            fill="#f59e0b" stroke="white" strokeWidth="1.5"
          />
        ))}

        {data.map((d, i) => (
          <text key={`xl-${i}`} x={getX(i)} y={svgH - 4} textAnchor="middle" fill="#9ca3af" fontSize="10">
            {ymToShortLabel(d.ym)}
          </text>
        ))}

        {hoveredI !== null && (() => {
          const d = data[hoveredI]
          const tx = getX(hoveredI)
          const ty = getWorkerY(d.workerCount)
          const tooltipX = tx > svgW / 2 ? tx - 115 : tx + 10
          return (
            <g>
              <rect x={tooltipX} y={Math.max(ty - 60, 4)} width="110" height="55" rx="4" fill="white" stroke="#e5e7eb" strokeWidth="1" />
              <text x={tooltipX + 6} y={Math.max(ty - 60, 4) + 14} fill="#3b82f6" fontSize="10" fontWeight="600">
                {`人数: ${d.workerCount}名`}
              </text>
              <text x={tooltipX + 6} y={Math.max(ty - 60, 4) + 28} fill="#f59e0b" fontSize="10">
                {`原価: ${fmtYenMan(d.cost)}`}
              </text>
              <text x={tooltipX + 6} y={Math.max(ty - 60, 4) + 42} fill="#f59e0b" fontSize="10">
                {`鳶 ${d.tobi} / 土工 ${d.doko}`}
              </text>
            </g>
          )
        })()}
      </svg>

      <div className="flex items-center gap-4 text-xs text-gray-500 dark:text-gray-400">
        <span className="flex items-center gap-1">
          <span className="inline-block w-2.5 h-2.5 rounded-full bg-blue-500" /> 人数
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-2.5 h-2.5 rounded-full bg-amber-500" /> 原価
        </span>
      </div>
    </div>
  )
}
