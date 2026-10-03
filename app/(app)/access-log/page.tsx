'use client'
// 2026-10-03: 画面の型（PageHeader・カード・下線タブ）にそろえた

import { useEffect, useState, useCallback } from 'react'
import { isTobiGroup } from '@/lib/jobs'
import { PageHeader, TodoCard, Segment, Chip, type ChipTone } from '@/components/ui/PageParts'

interface AccessRow {
  workerId: number
  workerName: string
  role: 'admin' | 'approver' | 'foreman' | 'jimu' | 'staff'
  currentRole: 'admin' | 'approver' | 'foreman' | 'jimu' | 'staff'
  jobType: string
  visa: string
  org: string
  lastAccessDate: string | null
  lastAccessAt: string | null
  accessCountLast7Days: number
}

/**
 * 人員マスタの jobType をそのまま表示するためのラベル・色定義
 * （人員マスタのバッジ表示と一致。色は共通の Chip の色から選ぶ）
 */
function jobTypeBadge(row: AccessRow): { label: string; tone: ChipTone } {
  // workerId=0 の社長は「管理者」（人員マスタに無いケース）
  if (row.workerId === 0) return { label: '管理者', tone: 'red' }
  switch (row.jobType) {
    case 'yakuin':         return { label: '役員', tone: 'red' }
    case 'shokucho':       return { label: '職長', tone: 'blue' }
    case 'tobi':           return { label: 'とび', tone: 'green' }
    // 2026-06-XX 追加: 鳶見習い (tobi_apprentice) の表示対応
    case 'tobi_apprentice':return { label: '鳶見習い', tone: 'green' }
    case 'doko':           return { label: '土工', tone: 'gray' }
    case 'jimu':           return { label: '事務', tone: 'cyan' }
    default:
      // 在留資格ありなら外国人スタッフ
      if (row.visa && row.visa !== 'none') return { label: 'スタッフ', tone: 'amber' }
      return { label: '—', tone: 'gray' }
  }
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '—'
  const m = d.getMonth() + 1
  const day = d.getDate()
  const h = d.getHours()
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${m}/${day} ${h}:${mi}`
}

function daysAgo(dateStr: string | null): number | null {
  if (!dateStr) return null
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const target = new Date(dateStr + 'T00:00:00')
  const diff = Math.floor((today.getTime() - target.getTime()) / (1000 * 60 * 60 * 24))
  return diff
}

/** 状態の札。赤＝未アクセス・8日以上、琥珀＝4〜7日、灰＝2〜3日、青＝昨日、緑＝今日 */
function statusBadge(dateStr: string | null): { label: string; tone: ChipTone } {
  const days = daysAgo(dateStr)
  if (days === null) return { label: '未アクセス', tone: 'red' }
  if (days === 0) return { label: '今日', tone: 'green' }
  if (days === 1) return { label: '昨日', tone: 'blue' }
  if (days <= 3) return { label: `${days}日前`, tone: 'gray' }
  if (days <= 7) return { label: `${days}日前`, tone: 'amber' }
  return { label: `${days}日前`, tone: 'red' }
}

type JobFilter = 'all' | 'yakuin' | 'shokucho' | 'tobi' | 'tobi_apprentice' | 'doko' | 'jimu' | 'staff' | 'admin'
type StatusFilter = 'all' | 'never' | 'stale'
const STATUS_FILTER_LABEL: Record<Exclude<StatusFilter, 'all'>, string> = { never: '未アクセス', stale: '3日以上開いていない' }

export default function AccessLogPage() {
  const [password, setPassword] = useState('')
  const [rows, setRows] = useState<AccessRow[]>([])
  const [loading, setLoading] = useState(false)
  const [days, setDays] = useState<'7' | '30' | '90'>('30')
  // 2026-06-XX: 鳶見習い (tobi_apprentice) フィルタ追加
  const [jobFilter, setJobFilter] = useState<JobFilter>('all')
  // 「今やること」カードを押したときの絞り込み（表示だけ）
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')

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
      const res = await fetch(`/api/access-log?days=${Number(days)}`, {
        headers: { 'x-admin-password': password },
      })
      if (res.ok) {
        const data = await res.json()
        setRows(data.rows || [])
      }
    } catch { /* ignore */ }
    setLoading(false)
  }, [password, days])

  useEffect(() => { fetchData() }, [fetchData])

  const filtered = rows.filter(r => {
    if (jobFilter === 'all') return true
    if (jobFilter === 'admin') return r.workerId === 0
    // 2026-06-XX 修正: 鳶グループ判定は isTobiGroup に統一（鳶見習い・職長・役員を含む）
    if (jobFilter === 'staff') return !isTobiGroup(r.jobType) && r.jobType !== 'doko' && r.jobType !== 'jimu' && r.workerId !== 0 && r.visa && r.visa !== 'none'
    return r.jobType === jobFilter
  })

  // ソート: アクセスが新しい順（時刻まで含む）、未アクセスは最後
  filtered.sort((a, b) => {
    if (!a.lastAccessAt && !b.lastAccessAt) return a.workerName.localeCompare(b.workerName)
    if (!a.lastAccessAt) return 1
    if (!b.lastAccessAt) return -1
    return b.lastAccessAt.localeCompare(a.lastAccessAt)
  })

  // 統計
  const todayCount = filtered.filter(r => daysAgo(r.lastAccessDate) === 0).length
  const never = filtered.filter(r => r.lastAccessDate === null)
  const stale = filtered.filter(r => {
    const d = daysAgo(r.lastAccessDate)
    return d !== null && d >= 3
  })
  const names = (list: AccessRow[]) => list.slice(0, 4).map(r => r.workerName).join('・') + (list.length > 4 ? ` ほか${list.length - 4}名` : '')
  const toggleStatus = (f: Exclude<StatusFilter, 'all'>) => setStatusFilter(prev => prev === f ? 'all' : f)
  const shown = statusFilter === 'never' ? never : statusFilter === 'stale' ? stale : filtered

  return (
    <div className="max-w-7xl mx-auto space-y-5">
      <PageHeader
        group="マスタ・管理"
        title="スタッフのアクセス履歴"
        sub="スタッフが最後にアプリを開いた日時。過去90日分を保存し、IPはハッシュ化して保存します（個人は特定できません）"
      />

      {/* ① 今やること */}
      {!loading && (
        <section className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <TodoCard icon="alert" tone={never.length > 0 ? 'urgent' : 'ok'} title="一度も開いていない"
            big={never.length > 0 ? `${never.length}名` : 'ありません'}
            sub={never.length > 0 ? `${names(never)}。専用URLが届いているか、ログインできているかを確かめてください` : '対象の全員がアプリを開いたことがあります'}
            action={never.length > 0 ? '見る' : undefined} active={statusFilter === 'never'}
            onClick={never.length > 0 ? () => toggleStatus('never') : undefined} />
          <TodoCard icon="clock" tone={stale.length > 0 ? 'warn' : 'ok'} title="3日以上開いていない"
            big={stale.length > 0 ? `${stale.length}名` : 'ありません'}
            sub={stale.length > 0 ? `${names(stale)}。出面の入力が止まっていないか確かめてください` : '全員が3日以内に開いています'}
            action={stale.length > 0 ? '見る' : undefined} active={statusFilter === 'stale'}
            onClick={stale.length > 0 ? () => toggleStatus('stale') : undefined} />
          <TodoCard icon="check" tone="info" title="今日開いた人"
            big={`${todayCount}名`}
            sub={`対象 ${filtered.length}名のうち、今日アプリを開いた人数`} />
        </section>
      )}

      <section className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 overflow-hidden">
        <div className="px-5 py-3.5 border-b border-hibi-line dark:border-gray-700 flex flex-wrap items-center gap-3">
          <h2 className="text-[1.0625rem] font-bold text-gray-900 dark:text-white">スタッフ（{shown.length}名）</h2>
          <Segment value={days} onChange={setDays} items={[['7', '直近7日'], ['30', '直近30日'], ['90', '直近90日']]} />
          <Segment value={jobFilter} onChange={v => { setJobFilter(v); setStatusFilter('all') }} items={[
            ['all', '全職種'], ['admin', '管理者'], ['yakuin', '役員'], ['shokucho', '職長'], ['tobi', 'とび'],
            ['tobi_apprentice', '鳶見習い'], ['doko', '土工'], ['jimu', '事務'], ['staff', 'スタッフ（外国人）'],
          ]} />
          {statusFilter !== 'all' && (
            <button onClick={() => setStatusFilter('all')} className="h-8 px-3 rounded-lg bg-hibi-active text-hibi-navy dark:bg-blue-900/30 dark:text-blue-300 text-[0.8125rem] font-bold">
              {STATUS_FILTER_LABEL[statusFilter]}だけ表示中 ×
            </button>
          )}
        </div>

        {loading ? (
          <div className="px-5 py-8 text-center text-sm text-gray-400">読み込み中...</div>
        ) : shown.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-hibi-sub">当てはまる人はいません</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-hibi-thead dark:bg-gray-700 text-xs font-bold text-hibi-sub dark:text-gray-300">
                  <th className="text-left px-5 py-2.5">スタッフ</th>
                  <th className="text-left px-3 py-2.5 w-24">職種</th>
                  <th className="text-left px-3 py-2.5 w-20">会社</th>
                  <th className="text-left px-3 py-2.5 w-32">最終アクセス</th>
                  <th className="text-left px-3 py-2.5 w-28">状態</th>
                  <th className="text-right px-5 py-2.5 w-28">7日間の回数</th>
                </tr>
              </thead>
              <tbody>
                {shown.map(r => {
                  const badge = statusBadge(r.lastAccessDate)
                  const job = jobTypeBadge(r)
                  return (
                    <tr key={r.workerId} className="border-t border-hibi-line dark:border-gray-700 hover:bg-hibi-bg dark:hover:bg-gray-700/40">
                      <td className="px-5 py-3 font-bold text-gray-900 dark:text-white">{r.workerName}</td>
                      <td className="px-3 py-3"><Chip tone={job.tone}>{job.label}</Chip></td>
                      <td className="px-3 py-3 text-xs text-hibi-sub dark:text-gray-400">{r.org === 'hfu' ? 'HFU' : '日比'}</td>
                      <td className="px-3 py-3 tabular-nums text-xs text-gray-700 dark:text-gray-300">{formatDateTime(r.lastAccessAt)}</td>
                      <td className="px-3 py-3"><Chip tone={badge.tone}>{badge.label}</Chip></td>
                      <td className="px-5 py-3 text-right tabular-nums text-gray-700 dark:text-gray-300">{r.accessCountLast7Days}回</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
