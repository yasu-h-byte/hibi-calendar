'use client'

import { useEffect, useState, useCallback } from 'react'
import { useSearchParams } from 'next/navigation'
import { QRCodeSVG } from 'qrcode.react'
import { Worker, AuthUser } from '@/types'
import { fmtYen } from '@/lib/format'
import { JOB_LABELS } from '@/lib/jobs'
import { jobBadge } from '@/lib/labels'
import RaiseHistoryTab from './RaiseHistoryTab'

const ORG_LABELS: Record<string, string> = { hibi: '日比建設', hfu: 'HFU' }
const VISA_LABELS: Record<string, string> = {
  none: '日本人',
  jisshu1: '実習1号', jisshu2: '実習2号', jisshu3: '実習3号',
  tokutei1: '特定1号', tokutei2: '特定2号',
  // 旧データ互換
  jisshu: '技能実習', tokutei: '特定技能',
}
const isGaikoku = (v: string) => v !== 'none' && v !== ''
const isJisshu = (v: string) => v.startsWith('jisshu')
const isTokutei = (v: string) => v.startsWith('tokutei')
// JOB_LABELS は lib/jobs.ts に集約済み（旧定義は重複だったため削除）— import は上部

// 旧 WorkerExt 型は types/index.ts の Worker と完全一致だったため削除して直接 Worker を使用


// jobBadge は lib/labels.ts に集約済み

const DEFAULT_DISPATCH_TO = '山岡建設工業'

const EMPTY_FORM = {
  name: '', org: 'hibi', visa: 'none', job: 'tobi',
  rate: '', hourlyRate: '', otMul: '1.25', hireDate: '', retired: '', salary: '',
  visaExpiry: '', memo: '', dispatchTo: '', dispatchFrom: '',
  useOldRules: false,
}

function currentYmDash(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function visaExpiryStatus(expiry: string): { label: string; cls: string; priority: number } | null {
  if (!expiry) return null
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const exp = new Date(expiry + 'T00:00:00')
  const diff = Math.floor((exp.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
  if (diff < 0) return { label: '期限切れ', cls: 'bg-red-600 text-white', priority: 0 }
  if (diff <= 30) return { label: `残${diff}日`, cls: 'bg-red-100 text-red-700 animate-pulse', priority: 1 }
  if (diff <= 90) return { label: `残${diff}日`, cls: 'bg-orange-100 text-orange-700', priority: 2 }
  if (diff <= 180) return { label: `残${Math.floor(diff / 30)}ヶ月`, cls: 'bg-yellow-100 text-yellow-700', priority: 3 }
  return null
}

export default function WorkersPage() {
  const searchParams = useSearchParams()
  const [workers, setWorkers] = useState<Worker[]>([])
  const [password, setPassword] = useState('')
  const [authUser, setAuthUser] = useState<AuthUser | null>(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState('all')
  // メインタブ: 'list' (人員一覧) / 'raise-history' (昇給履歴)
  const [mainTab, setMainTab] = useState<'list' | 'raise-history'>('list')
  const [showModal, setShowModal] = useState(false)
  const [editId, setEditId] = useState<number | null>(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [qrWorker, setQrWorker] = useState<Worker | null>(null)
  const [sortKey, setSortKey] = useState<string>('id')
  const [sortAsc, setSortAsc] = useState(true)
  const [transferring, setTransferring] = useState<number | null>(null)

  useEffect(() => {
    const stored = localStorage.getItem('hibi_auth')
    if (stored) {
      const { password: pw, user } = JSON.parse(stored)
      setPassword(pw)
      if (user) setAuthUser(user as AuthUser)
    }
  }, [])

  // URL ?tab=raise-history で昇給履歴タブを初期表示（人員マスタの履歴ボタン経由）
  useEffect(() => {
    const tabParam = searchParams.get('tab')
    if (tabParam === 'raise-history') setMainTab('raise-history')
    else if (tabParam === 'list') setMainTab('list')
  }, [searchParams])

  const isAdminOrApprover = authUser?.role === 'admin' || authUser?.role === 'approver'

  const headers = useCallback(() => ({
    'x-admin-password': password,
    'Content-Type': 'application/json',
  }), [password])

  const fetchWorkers = useCallback(async () => {
    if (!password) return
    setLoading(true)
    try {
      const res = await fetch('/api/workers', { headers: { 'x-admin-password': password } })
      if (res.ok) {
        const data = await res.json()
        setWorkers(data.workers || [])
      }
    } finally {
      setLoading(false)
    }
  }, [password])

  useEffect(() => { fetchWorkers() }, [fetchWorkers])

  // Transfer handler (toggle org between hibi/hfu)
  const handleTransfer = async (w: Worker) => {
    const newOrg = w.company === 'HFU' ? 'hibi' : 'hfu'
    const newLabel = newOrg === 'hfu' ? 'HFU' : '日比建設'
    if (!confirm(`${w.name} を ${newLabel} に転籍しますか？`)) return
    setTransferring(w.id)
    try {
      await fetch('/api/workers', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ action: 'update', id: w.id, org: newOrg }),
      })
      fetchWorkers()
    } finally {
      setTransferring(null)
    }
  }

  const openAdd = () => {
    setEditId(null)
    setForm(EMPTY_FORM)
    setShowModal(true)
  }

  const openEdit = (w: Worker) => {
    setEditId(w.id)
    setForm({
      name: w.name,
      org: w.company === 'HFU' ? 'hfu' : 'hibi',
      visa: w.visaType || 'none',
      job: w.jobType || 'tobi',
      rate: String(w.rate || ''),
      hourlyRate: String(w.hourlyRate || ''),
      otMul: String(w.otMul || 1.25),
      hireDate: w.hireDate || '',
      retired: w.retired || '',
      salary: String(w.salary || ''),
      visaExpiry: w.visaExpiry || '',
      memo: (w as unknown as { memo?: string }).memo || '',
      dispatchTo: w.dispatchTo || '',
      dispatchFrom: w.dispatchFrom || '',
      useOldRules: !!w.useOldRules,
    })
    setShowModal(true)
  }

  const handleSave = async () => {
    if (!form.name.trim()) { alert('名前を入力してください'); return }

    // 新規追加時のみ: 同名スタッフチェック（スペース・全角半角を無視）
    //   2026-05-30 「日比靖仁」が誤って 2 回追加された事案を受けて追加。
    //   全角/半角スペースを除去して比較し、誤ったコピー入力を防ぐ。
    if (!editId) {
      const normalize = (s: string) => s.replace(/[\s　]/g, '').toLowerCase()
      const inputName = normalize(form.name)
      const duplicates = workers.filter(w => normalize(w.name) === inputName)
      if (duplicates.length > 0) {
        const list = duplicates.map(w => `  - ID ${w.id}: ${w.name}${w.retired ? '（退職済）' : ''}`).join('\n')
        const ok = confirm(
          `⚠️ 同じ名前のスタッフが既に登録されています:\n\n${list}\n\n` +
          `別人として新規追加しますか？\n（同じ人を誤って二重登録しようとしている場合は「キャンセル」してください）`
        )
        if (!ok) return
      }
    }

    // 2026-06-12 (監査 Sprint2-C): 給与に直結するフィールドの変更は確認を挟む。
    //   特に外国人への固定月給の誤入力は計算方式自体が月給制に切り替わるため危険。
    if (editId) {
      const orig = workers.find(w => w.id === editId)
      if (orig) {
        const diffs: string[] = []
        const numOrEmpty = (v: string | number | undefined | null) => Number(v) || 0
        if (numOrEmpty(form.rate) !== numOrEmpty(orig.rate)) diffs.push(`日額: ¥${numOrEmpty(orig.rate).toLocaleString()} → ¥${numOrEmpty(form.rate).toLocaleString()}`)
        if (numOrEmpty(form.hourlyRate) !== numOrEmpty(orig.hourlyRate)) diffs.push(`時給: ¥${numOrEmpty(orig.hourlyRate).toLocaleString()} → ¥${numOrEmpty(form.hourlyRate).toLocaleString()}`)
        if (numOrEmpty(form.salary) !== numOrEmpty(orig.salary)) {
          const ns = numOrEmpty(form.salary)
          diffs.push(ns > 0
            ? `固定月給: ¥${numOrEmpty(orig.salary).toLocaleString()} → ¥${ns.toLocaleString()}（月給制${numOrEmpty(orig.salary) > 0 ? '' : 'に切替'}）`
            : `固定月給: ¥${numOrEmpty(orig.salary).toLocaleString()} → 解除（時給/日給制に戻る）`)
        }
        if (Number(form.otMul) !== (orig.otMul || 1.25)) diffs.push(`残業倍率: ${orig.otMul || 1.25} → ${form.otMul}`)
        if (!!form.useOldRules !== !!orig.useOldRules) diffs.push(`旧ルール継続: ${orig.useOldRules ? 'ON' : 'OFF'} → ${form.useOldRules ? 'ON' : 'OFF'}`)
        if (diffs.length > 0) {
          const ok = confirm(
            `⚠️ ${form.name} さんの給与計算に直結する設定を変更します:\n\n${diffs.map(d => `  - ${d}`).join('\n')}\n\n` +
            `保存すると月次集計の金額に即反映されます（変更は監査ログに記録されます）。よろしいですか？`
          )
          if (!ok) return
        }
      }
    }

    setSaving(true)
    try {
      const body = editId
        ? { action: 'update', id: editId, name: form.name, org: form.org, visa: form.visa, job: form.job, rate: form.rate, hourlyRate: form.hourlyRate || undefined, otMul: form.otMul, hireDate: form.hireDate, retired: form.retired || undefined, salary: form.salary || undefined, visaExpiry: form.visaExpiry || undefined, memo: form.memo || undefined, dispatchTo: form.dispatchTo || '', dispatchFrom: form.dispatchTo ? (form.dispatchFrom || '') : '', useOldRules: form.useOldRules || undefined }
        : { action: 'add', name: form.name, org: form.org, visa: form.visa, job: form.job, rate: form.rate, hourlyRate: form.hourlyRate || undefined, otMul: form.otMul, hireDate: form.hireDate, salary: form.salary || undefined, visaExpiry: form.visaExpiry || undefined, memo: form.memo || undefined, dispatchTo: form.dispatchTo || undefined, dispatchFrom: (form.dispatchTo && form.dispatchFrom) ? form.dispatchFrom : undefined, useOldRules: form.useOldRules || undefined }
      const res = await fetch('/api/workers', { method: 'POST', headers: headers(), body: JSON.stringify(body) })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: '保存に失敗しました' }))
        alert(`保存エラー: ${err.error || res.statusText}`)
        return
      }
      setShowModal(false)
      fetchWorkers()
    } catch (e) {
      alert(`通信エラー: ${e instanceof Error ? e.message : '不明なエラー'}`)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id: number, name: string) => {
    // 2026-06-13 (監査 Sprint3): 「完全削除」と「退職」を取り違えないよう導線を明示。
    //   退職は編集画面の退職日設定で（過去の給与記録は保持・翌月から自動で集計対象外）。
    //   完全削除は出面実績のないスタッフのみ可能（サーバが実績ありをブロック）。
    if (!confirm(
      `${name} を完全に削除しますか？\n\n` +
      `⚠ 退職させたいだけなら「キャンセル」して、編集画面で「退職日」を設定してください。\n` +
      `　退職日設定なら過去の給与記録は残り、翌月から自動で集計対象外になります。\n\n` +
      `完全削除は出面実績のないスタッフのみ可能で、取り消せません。`,
    )) return
    const res = await fetch('/api/workers', {
      method: 'POST', headers: headers(),
      body: JSON.stringify({ action: 'delete', id }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: '削除に失敗しました' }))
      alert(err.error || '削除に失敗しました')
      return
    }
    fetchWorkers()
  }

  const handleGenToken = async (id: number) => {
    const res = await fetch('/api/workers', {
      method: 'POST', headers: headers(),
      body: JSON.stringify({ action: 'generateToken', id }),
    })
    if (res.ok) fetchWorkers()
  }

  const handleRevokeToken = async (id: number, name: string) => {
    if (!confirm(`${name} のトークンを無効化しますか？`)) return
    await fetch('/api/workers', {
      method: 'POST', headers: headers(),
      body: JSON.stringify({ action: 'revokeToken', id }),
    })
    fetchWorkers()
  }

  // Filter & sort
  const activeWorkers = workers.filter(w => !w.retired)
  const retiredWorkers = workers.filter(w => !!w.retired)
  const filtered = workers.filter(w => {
    if (tab === 'retired') return !!w.retired
    if (tab === 'hibi') return w.company !== 'HFU' && !w.retired
    if (tab === 'hfu') return w.company === 'HFU' && !w.retired
    return !w.retired // 「全員」タブでも退職者は非表示
  })

  const sorted = [...filtered].sort((a, b) => {
    // 退職者は常に末尾（「退職者」タブ以外）
    if (tab !== 'retired') {
      const aR = a.retired ? 1 : 0
      const bR = b.retired ? 1 : 0
      if (aR !== bR) return aR - bR
    }
    let cmp = 0
    if (sortKey === 'id') cmp = a.id - b.id
    else if (sortKey === 'name') cmp = a.name.localeCompare(b.name)
    else if (sortKey === 'rate') cmp = (a.rate || 0) - (b.rate || 0)
    else if (sortKey === 'jobType') cmp = (a.jobType || '').localeCompare(b.jobType || '')
    return sortAsc ? cmp : -cmp
  })

  const toggleSort = (key: string) => {
    if (sortKey === key) setSortAsc(!sortAsc)
    else { setSortKey(key); setSortAsc(true) }
  }

  const hibiCount = activeWorkers.filter(w => w.company !== 'HFU').length
  const hfuCount = activeWorkers.filter(w => w.company === 'HFU').length
  const baseUrl = typeof window !== 'undefined' ? window.location.origin : ''

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-hibi-navy dark:text-white">人員マスタ</h1>
          {mainTab === 'list' && (
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
              在籍: {activeWorkers.length}名（日比 {hibiCount} / HFU {hfuCount}）{retiredWorkers.length > 0 && ` / 退職: ${retiredWorkers.length}名`}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <a href="/leave" className="text-hibi-navy dark:text-blue-400 text-sm underline hover:text-hibi-light transition">
            休暇管理
          </a>
          {mainTab === 'list' && (
            <button onClick={openAdd} className="bg-hibi-navy text-white px-4 py-2 rounded-lg text-sm hover:bg-hibi-light transition">
              + 新規追加
            </button>
          )}
        </div>
      </div>

      {/* Main Tabs: 一覧 / 昇給履歴 */}
      <div className="flex border-b border-gray-200 dark:border-gray-700">
        <button
          onClick={() => setMainTab('list')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            mainTab === 'list'
              ? 'border-hibi-navy text-hibi-navy dark:border-blue-400 dark:text-blue-400'
              : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
          }`}
        >
          人員一覧
        </button>
        {isAdminOrApprover && (
          <button
            onClick={() => setMainTab('raise-history')}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              mainTab === 'raise-history'
                ? 'border-hibi-navy text-hibi-navy dark:border-blue-400 dark:text-blue-400'
                : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
            }`}
          >
            💰 昇給履歴
          </button>
        )}
      </div>

      {mainTab === 'raise-history' && (
        <RaiseHistoryTab authUser={authUser} />
      )}

      {mainTab === 'list' && (
        <>
      {/* Tabs */}
      <div className="flex gap-2">
        {[
          { key: 'all', label: '全員' },
          { key: 'hibi', label: '日比建設' },
          { key: 'hfu', label: 'HFU' },
          ...(retiredWorkers.length > 0 ? [{ key: 'retired', label: `退職者 (${retiredWorkers.length})` }] : []),
        ].map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition ${
              tab === t.key ? 'bg-hibi-navy text-white' : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Visa expiry alerts */}
      {(() => {
        const alerts = activeWorkers
          .filter(w => w.visaExpiry && isGaikoku(w.visaType || ''))
          .map(w => ({ ...w, status: visaExpiryStatus(w.visaExpiry!) }))
          .filter(w => w.status)
          .sort((a, b) => a.status!.priority - b.status!.priority)
        if (alerts.length === 0) return null
        return (
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow p-4 border-l-4 border-red-500">
            <h3 className="text-sm font-bold text-red-700 dark:text-red-400 mb-2">在留期限アラート</h3>
            <div className="flex flex-wrap gap-2">
              {alerts.map(w => (
                <button key={w.id} onClick={() => openEdit(w)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gray-50 dark:bg-gray-700 hover:bg-gray-100 dark:hover:bg-gray-600 transition text-sm">
                  <span className="font-medium">{w.name}</span>
                  <span className={`text-[11px] px-1.5 py-0.5 rounded-full font-bold ${w.status!.cls}`}>
                    {w.status!.label}
                  </span>
                  <span className="text-xs text-gray-400">{w.visaExpiry}</span>
                </button>
              ))}
            </div>
          </div>
        )
      })()}

      {/* Table */}
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 dark:bg-gray-700 text-left text-gray-600 dark:text-gray-300">
              <th className="px-3 py-3 cursor-pointer hover:text-hibi-navy" onClick={() => toggleSort('id')}>
                ID {sortKey === 'id' && (sortAsc ? '↑' : '↓')}
              </th>
              <th className="px-3 py-3 cursor-pointer hover:text-hibi-navy" onClick={() => toggleSort('name')}>
                名前 {sortKey === 'name' && (sortAsc ? '↑' : '↓')}
              </th>
              <th className="px-3 py-3">所属</th>
              <th className="px-3 py-3 cursor-pointer hover:text-hibi-navy" onClick={() => toggleSort('jobType')}>
                職種 {sortKey === 'jobType' && (sortAsc ? '↑' : '↓')}
              </th>
              <th className="px-3 py-3">在留資格</th>
              <th className="px-3 py-3">在留期限</th>
              <th className="px-3 py-3 cursor-pointer hover:text-hibi-navy" onClick={() => toggleSort('rate')}>
                単価 {sortKey === 'rate' && (sortAsc ? '↑' : '↓')}
              </th>
              <th className="px-3 py-3">月給目安</th>
              <th className="px-3 py-3">📱</th>
              <th className="px-3 py-3">操作</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={10} className="px-3 py-8 text-center text-gray-400">読み込み中...</td></tr>
            ) : sorted.length === 0 ? (
              <tr><td colSpan={10} className="px-3 py-8 text-center text-gray-400">データがありません</td></tr>
            ) : sorted.map(w => {
              const jb = jobBadge(w.jobType)
              return (
                <tr key={w.id} className={`border-t dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50 even:bg-gray-50/50 dark:even:bg-gray-700/30 ${w.retired ? 'opacity-45' : ''}`}>
                  <td className="px-3 py-2.5 text-gray-400">{w.id}</td>
                  <td className="px-3 py-2.5 font-medium">
                    {w.name}
                    {w.dispatchTo && (
                      <span
                        className="ml-2 text-[10px] bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded-full font-bold"
                        title={`出向先: ${w.dispatchTo}${w.dispatchFrom ? ` / 開始: ${w.dispatchFrom}` : ''}`}
                      >
                        🔁 出向中{w.dispatchFrom && ` (${w.dispatchFrom}〜)`}
                      </span>
                    )}
                    {w.retired && <span className="ml-2 text-xs bg-gray-200 text-gray-500 px-1.5 py-0.5 rounded">{w.retired && w.retired !== 'true' && w.retired.length >= 7 ? `退職 ${w.retired.slice(0, 7)}` : '退職'}</span>}
                    {(w as unknown as { memo?: string }).memo && (
                      <span className="ml-1.5 relative group cursor-default" title={(w as unknown as { memo?: string }).memo}>
                        <span className="text-xs text-orange-400">&#128221;</span>
                        <span className="absolute left-0 top-full mt-1 z-50 hidden group-hover:block bg-gray-800 text-white text-xs rounded-lg px-3 py-2 shadow-lg whitespace-pre-wrap max-w-xs">
                          {(w as unknown as { memo?: string }).memo}
                        </span>
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${
                      w.company === 'HFU' ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'
                    }`}>
                      {w.company === 'HFU' ? 'HFU' : '日比'}
                    </span>
                  </td>
                  <td className="px-3 py-2.5">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${jb.cls}`}>
                      {jb.label}
                    </span>
                  </td>
                  <td className="px-3 py-2.5">
                    {w.visaType && isGaikoku(w.visaType) && (
                      <span className={`text-xs px-2 py-0.5 rounded-full ${
                        isJisshu(w.visaType) ? 'bg-orange-100 text-orange-700' : 'bg-teal-100 text-teal-700'
                      }`}>
                        {VISA_LABELS[w.visaType] || w.visaType}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    {w.visaExpiry && isGaikoku(w.visaType || '') ? (() => {
                      const s = visaExpiryStatus(w.visaExpiry!)
                      return s ? (
                        <span className={`text-[11px] px-1.5 py-0.5 rounded-full font-bold ${s.cls}`}>{s.label}</span>
                      ) : (
                        <span className="text-xs text-gray-400">{w.visaExpiry}</span>
                      )
                    })() : '—'}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-gray-600">
                    {w.visaType && isGaikoku(w.visaType) ? (
                      w.hourlyRate ? (
                        <div>
                          <div className="font-medium">{fmtYen(w.hourlyRate)}<span className="text-[10px] text-gray-400 font-normal">/h</span></div>
                          <div className="text-[10px] text-gray-400">日額 {fmtYen(w.hourlyRate * 7)}</div>
                        </div>
                      ) : '—'
                    ) : (
                      w.rate ? (
                        <div>
                          <div className="font-medium">{fmtYen(w.rate)}<span className="text-[10px] text-gray-400 font-normal">/日</span></div>
                          <div className="text-[10px] text-gray-400">OT ×{w.otMul || 1.25}</div>
                        </div>
                      ) : '—'
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-gray-600">
                    {w.visaType && isGaikoku(w.visaType) && w.hourlyRate ? (
                      fmtYen(w.hourlyRate * 168)
                    ) : w.visaType && isGaikoku(w.visaType) && w.salary ? fmtYen(w.salary) : '—'}
                  </td>
                  <td className="px-3 py-2.5">
                    {w.token ? (
                      <div className="flex items-center gap-1">
                        <span className="text-green-500 text-xs">✓</span>
                        <button onClick={() => setQrWorker(w)} className="text-hibi-navy text-xs underline">QR</button>
                      </div>
                    ) : (
                      <button onClick={() => handleGenToken(w.id)} className="text-gray-400 text-xs hover:text-hibi-navy">
                        発行
                      </button>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex gap-1 items-center">
                      <button onClick={() => openEdit(w)} className="text-hibi-navy text-xs underline hover:text-hibi-light">
                        編集
                      </button>
                      {isGaikoku(w.visaType) && (
                        <a
                          href={`/workers?tab=raise-history&worker=${w.id}`}
                          className="text-emerald-600 text-xs hover:text-emerald-800 ml-1"
                          title="昇給履歴を表示"
                        >
                          💰 履歴
                        </a>
                      )}
                      {!w.retired && (
                        <button
                          onClick={() => handleTransfer(w)}
                          disabled={transferring === w.id}
                          className="text-amber-600 text-xs hover:text-amber-800 ml-1 disabled:opacity-50"
                          title={`${w.company === 'HFU' ? '日比建設' : 'HFU'} に転籍`}
                        >
                          ⇄ 転籍
                        </button>
                      )}
                      {!w.retired && (
                        <button onClick={() => handleDelete(w.id, w.name)} className="text-red-400 text-xs hover:text-red-600 ml-2">
                          削除
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
        </>
      )}

      {/* Add/Edit Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowModal(false)}>
          <div className="bg-white dark:bg-gray-800 rounded-xl p-6 max-w-md w-full mx-4 max-h-[90vh] overflow-y-auto animate-modalIn" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-hibi-navy dark:text-white mb-4">
              {editId ? '社員編集' : '社員追加'}
            </h3>

            <div className="space-y-4">
              {/* ── 基本情報 ── */}
              <div className="border border-gray-200 dark:border-gray-600 rounded-lg p-3 space-y-3">
                <h4 className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wide">基本情報</h4>
                <div>
                  <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">名前 *</label>
                  <input
                    value={form.name}
                    onChange={e => setForm({ ...form, name: e.target.value })}
                    placeholder="例：山田太郎"
                    className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-hibi-navy focus:outline-none"
                  />
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">所属</label>
                    <select value={form.org} onChange={e => setForm({ ...form, org: e.target.value })}
                      className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm">
                      <option value="hibi">日比建設</option>
                      <option value="hfu">HFU</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">職種</label>
                    <select value={form.job} onChange={e => setForm({ ...form, job: e.target.value })}
                      className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm">
                      <option value="tobi">とび</option>
                      <option value="tobi_apprentice">鳶見習い</option>
                      <option value="doko">土工</option>
                      <option value="shokucho">職長</option>
                      <option value="yakuin">役員</option>
                      <option value="jimu">事務</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">在留資格</label>
                    <select value={form.visa} onChange={e => setForm({ ...form, visa: e.target.value })}
                      className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm">
                      <option value="none">なし（日本人）</option>
                      <optgroup label="技能実習">
                        <option value="jisshu1">実習1号</option>
                        <option value="jisshu2">実習2号</option>
                        <option value="jisshu3">実習3号</option>
                      </optgroup>
                      <optgroup label="特定技能">
                        <option value="tokutei1">特定1号</option>
                        <option value="tokutei2">特定2号</option>
                      </optgroup>
                    </select>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">入社日</label>
                    <input type="date" value={form.hireDate} onChange={e => setForm({ ...form, hireDate: e.target.value })}
                      className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-hibi-navy focus:outline-none" />
                  </div>
                  {editId && (
                    <div>
                      <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">退職日</label>
                      <div className="flex gap-2">
                        <input type="date" value={form.retired} onChange={e => setForm({ ...form, retired: e.target.value })}
                          className="flex-1 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-hibi-navy focus:outline-none" />
                        {form.retired && (
                          <button type="button" onClick={() => setForm({ ...form, retired: '' })}
                            className="px-2 py-2 text-xs text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-gray-600 rounded-lg hover:bg-gray-200 transition">
                            ✕
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* ── 在留期限（外国人のみ） ── */}
              {isGaikoku(form.visa) && (
                <div className="border border-orange-200 dark:border-orange-800 rounded-lg p-3 space-y-2 bg-orange-50/30 dark:bg-orange-900/10">
                  <h4 className="text-xs font-bold text-orange-600 dark:text-orange-400 uppercase tracking-wide">在留情報</h4>
                  <div>
                    <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">在留期限</label>
                    <input type="date" value={form.visaExpiry} onChange={e => setForm({ ...form, visaExpiry: e.target.value })}
                      className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-orange-500 focus:outline-none" />
                    {form.visaExpiry && (() => {
                      const s = visaExpiryStatus(form.visaExpiry)
                      return s ? (
                        <div className={`mt-1.5 text-xs font-bold px-2 py-1 rounded ${s.cls}`}>
                          {s.priority === 0 ? '在留期限が切れています' :
                           s.priority === 1 ? `在留期限まで${s.label} — 更新手続きが必要です` :
                           s.priority === 2 ? `在留期限まで${s.label}` :
                           `在留期限まで${s.label}`}
                        </div>
                      ) : (
                        <div className="mt-1 text-xs text-green-600">在留期限まで余裕があります</div>
                      )
                    })()}
                  </div>
                  <div>
                    <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">メモ</label>
                    <textarea value={form.memo} onChange={e => setForm({ ...form, memo: e.target.value })}
                      placeholder="一時帰国予定、退職予定、更新方針など"
                      rows={3}
                      className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-orange-500 focus:outline-none resize-none" />
                  </div>
                </div>
              )}

              {/* ── 単価・給与 ── */}
              <div className="border border-blue-200 dark:border-blue-800 rounded-lg p-3 space-y-3 bg-blue-50/30 dark:bg-blue-900/10">
                <h4 className="text-xs font-bold text-blue-600 dark:text-blue-400 uppercase tracking-wide">単価・給与</h4>

                {isGaikoku(form.visa) ? (
                  <>
                    {/* 外国人: 時給ベース */}
                    <div>
                      <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">時給（円）</label>
                      <input type="text" inputMode="numeric"
                        value={form.hourlyRate ? Number(form.hourlyRate).toLocaleString() : ''}
                        onChange={e => {
                          const hr = e.target.value.replace(/[^0-9]/g, '')
                          const autoRate = hr ? String(Math.round(Number(hr) * 7)) : ''
                          setForm({ ...form, hourlyRate: hr, rate: autoRate })
                        }}
                        placeholder="1,538"
                        className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm text-right font-bold focus:ring-2 focus:ring-blue-500 focus:outline-none" />
                    </div>
                    <div className="grid grid-cols-3 gap-3">
                      <div>
                        <label className="text-xs text-gray-400 block mb-1">日額（自動）</label>
                        <div className="border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-800 rounded-lg px-3 py-2 text-sm text-right text-gray-500 tabular-nums">
                          {form.hourlyRate && Number(form.hourlyRate) > 0
                            ? `¥${(Number(form.hourlyRate) * 7).toLocaleString()}`
                            : '—'}
                        </div>
                      </div>
                      <div>
                        <label className="text-xs text-gray-400 block mb-1">月給目安（自動）</label>
                        <div className="border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-800 rounded-lg px-3 py-2 text-sm text-right text-gray-500 tabular-nums">
                          {form.hourlyRate && Number(form.hourlyRate) > 0
                            ? `¥${Math.round(Number(form.hourlyRate) * 168).toLocaleString()}`
                            : '—'}
                        </div>
                      </div>
                      <div>
                        <label className="text-xs text-gray-400 block mb-1">残業単価（自動）</label>
                        <div className="border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-800 rounded-lg px-3 py-2 text-sm text-right text-gray-500 tabular-nums">
                          {form.hourlyRate && Number(form.hourlyRate) > 0
                            ? `¥${Math.round(Number(form.hourlyRate) * 1.25).toLocaleString()}`
                            : '—'}
                        </div>
                      </div>
                    </div>
                    <p className="text-[10px] text-gray-400">※ 時給を入力すると日額・月給・残業単価が自動計算されます</p>

    {/* 固定月給 — 旧ルール継続者（フン等）専用。誤入力で計算方式が月給制に切り替わるため、
                        useOldRules ON か既に設定済みの場合のみ表示（2026-06-12 監査 Sprint2-C） */}
                    {(form.useOldRules || (form.salary && Number(form.salary) > 0)) ? (
                    <div className="pt-2 border-t border-gray-100 dark:border-gray-700">
                      <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">
                        固定月給（任意・円）
                      </label>
                      <input type="text" inputMode="numeric"
                        value={form.salary ? Number(form.salary).toLocaleString() : ''}
                        onChange={e => setForm({ ...form, salary: e.target.value.replace(/[^0-9]/g, '') })}
                        placeholder="未設定（時給制）"
                        className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm text-right font-bold focus:ring-2 focus:ring-blue-500 focus:outline-none" />
                      {form.salary && Number(form.salary) > 0 ? (
                        <p className="text-[10px] text-amber-600 dark:text-amber-400 mt-1">
                          ⚠ 月給制: 基本給は毎月この固定額（所定日数で変動しない）。残業・欠勤は日給ベースで固定単価。月途中入退社は日割り。
                        </p>
                      ) : (
                        <p className="text-[10px] text-gray-400 mt-1">
                          ※ 通常は空欄（時給制）。フンさん等、毎月固定月給で支払う旧ルール継続者のみ設定。
                        </p>
                      )}
                    </div>
                    ) : null}
                  </>
                ) : (
                  <>
                    {/* 日本人: 日給制 or 月給制を選択 */}
                    {/* salary > 0 を「月給制」、それ以外を「日給制」と判定。
                        モード切替時に対側のフィールドはクリアして両立を防ぐ。 */}
                    {(() => {
                      const isMonthly = !!(form.salary && Number(form.salary) > 0)
                      const prescribedDays = 20  // 月所定日数の標準値（時給換算用）
                      const prescribedH = prescribedDays * 8
                      return (
                        <>
                          {/* モード切替 */}
                          <div className="flex gap-2">
                            <button type="button"
                              onClick={() => setForm({ ...form, salary: '' })}
                              className={`flex-1 px-3 py-2 rounded-lg text-sm font-bold transition ${
                                !isMonthly
                                  ? 'bg-blue-600 text-white shadow'
                                  : 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-300 hover:bg-gray-200'
                              }`}
                            >
                              日給制
                            </button>
                            <button type="button"
                              onClick={() => setForm({ ...form, rate: '', salary: form.salary || '300000' })}
                              className={`flex-1 px-3 py-2 rounded-lg text-sm font-bold transition ${
                                isMonthly
                                  ? 'bg-blue-600 text-white shadow'
                                  : 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-300 hover:bg-gray-200'
                              }`}
                            >
                              月給制
                            </button>
                          </div>

                          {!isMonthly ? (
                            <>
                              {/* 日給制 */}
                              <div className="grid grid-cols-2 gap-3">
                                <div>
                                  <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">日額単価（円）</label>
                                  <input type="text" inputMode="numeric"
                                    value={form.rate ? Number(form.rate).toLocaleString() : ''}
                                    onChange={e => setForm({ ...form, rate: e.target.value.replace(/[^0-9]/g, '') })}
                                    placeholder="25,000"
                                    className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm text-right font-bold focus:ring-2 focus:ring-blue-500 focus:outline-none" />
                                </div>
                                <div>
                                  <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">残業倍率</label>
                                  <input type="number" step="0.05" value={form.otMul} onChange={e => setForm({ ...form, otMul: e.target.value })}
                                    className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm text-right focus:ring-2 focus:ring-blue-500 focus:outline-none" />
                                </div>
                              </div>
                              {form.rate && Number(form.rate) > 0 && (
                                <div className="grid grid-cols-2 gap-3">
                                  <div>
                                    <label className="text-xs text-gray-400 block mb-1">時給換算（参考）</label>
                                    <div className="border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-800 rounded-lg px-3 py-2 text-sm text-right text-gray-500 tabular-nums">
                                      ¥{Math.round(Number(form.rate) / 8).toLocaleString()}
                                    </div>
                                  </div>
                                  <div>
                                    <label className="text-xs text-gray-400 block mb-1">残業単価（参考）</label>
                                    <div className="border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-800 rounded-lg px-3 py-2 text-sm text-right text-gray-500 tabular-nums">
                                      ¥{Math.round(Number(form.rate) / 8 * Number(form.otMul || 1.25)).toLocaleString()}
                                    </div>
                                  </div>
                                </div>
                              )}
                            </>
                          ) : (
                            <>
                              {/* 月給制 */}
                              <div className="grid grid-cols-2 gap-3">
                                <div>
                                  <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">月給（円）</label>
                                  <input type="text" inputMode="numeric"
                                    value={form.salary ? Number(form.salary).toLocaleString() : ''}
                                    onChange={e => setForm({ ...form, salary: e.target.value.replace(/[^0-9]/g, '') })}
                                    placeholder="300,000"
                                    className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm text-right font-bold focus:ring-2 focus:ring-blue-500 focus:outline-none" />
                                </div>
                                <div>
                                  <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">残業倍率</label>
                                  <input type="number" step="0.05" value={form.otMul} onChange={e => setForm({ ...form, otMul: e.target.value })}
                                    className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm text-right focus:ring-2 focus:ring-blue-500 focus:outline-none" />
                                </div>
                              </div>
                              {form.salary && Number(form.salary) > 0 && (
                                <div className="grid grid-cols-3 gap-3">
                                  <div>
                                    <label className="text-xs text-gray-400 block mb-1">日額換算（参考）</label>
                                    <div className="border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-800 rounded-lg px-3 py-2 text-sm text-right text-gray-500 tabular-nums">
                                      ¥{Math.round(Number(form.salary) / prescribedDays).toLocaleString()}
                                    </div>
                                  </div>
                                  <div>
                                    <label className="text-xs text-gray-400 block mb-1">時給換算（参考）</label>
                                    <div className="border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-800 rounded-lg px-3 py-2 text-sm text-right text-gray-500 tabular-nums">
                                      ¥{Math.round(Number(form.salary) / prescribedH).toLocaleString()}
                                    </div>
                                  </div>
                                  <div>
                                    <label className="text-xs text-gray-400 block mb-1">残業単価（参考）</label>
                                    <div className="border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-800 rounded-lg px-3 py-2 text-sm text-right text-gray-500 tabular-nums">
                                      ¥{Math.round(Number(form.salary) / prescribedH * Number(form.otMul || 1.25)).toLocaleString()}
                                    </div>
                                  </div>
                                </div>
                              )}
                              <p className="text-[10px] text-gray-400">
                                ※ 月給制: 出勤日数に関わらず月給固定。残業は時給換算 × 倍率で加算。
                                <br/>※ 換算は月所定 {prescribedDays}日 × 8h = {prescribedH}h で計算。
                              </p>
                            </>
                          )}
                        </>
                      )
                    })()}
                  </>
                )}
              </div>

              {/* ── 出向情報 ── */}
              <div className="border border-purple-200 dark:border-purple-800 rounded-lg p-3 space-y-2 bg-purple-50/30 dark:bg-purple-900/10">
                <h4 className="text-xs font-bold text-purple-600 dark:text-purple-400 uppercase tracking-wide">🔁 出向情報</h4>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      if (form.dispatchTo) {
                        // 解除
                        setForm({ ...form, dispatchTo: '', dispatchFrom: '' })
                      } else {
                        // 出向開始: 開始月は当月をデフォルト
                        setForm({ ...form, dispatchTo: DEFAULT_DISPATCH_TO, dispatchFrom: form.dispatchFrom || currentYmDash() })
                      }
                    }}
                    className={`flex-1 px-3 py-2 rounded-lg text-sm font-bold transition ${
                      form.dispatchTo
                        ? 'bg-purple-600 text-white hover:bg-purple-700'
                        : 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600'
                    }`}
                  >
                    {form.dispatchTo ? `🔁 ${form.dispatchTo} へ出向中` : '通常勤務（出向なし）'}
                  </button>
                </div>
                {form.dispatchTo && (
                  <div className="pt-1">
                    <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">出向開始月</label>
                    <input
                      type="month"
                      value={form.dispatchFrom}
                      onChange={e => setForm({ ...form, dispatchFrom: e.target.value })}
                      className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-purple-500 focus:outline-none"
                    />
                    <p className="mt-1 text-[10px] text-gray-500 dark:text-gray-400">
                      ※ この月以降の月次集計・原価で出向控除が適用されます。空欄の場合は全期間が対象になります。
                    </p>
                  </div>
                )}
                <p className="text-[10px] text-gray-500 dark:text-gray-400">
                  ※ 出向中にすると、開始月以降の人件費から実給与額（実出勤×日額＋残業）が自動で差し引かれます。
                </p>
              </div>
            </div>

            {/* 旧ルール継続フラグ（個別対応用） */}
            {isGaikoku(form.visa) && (
              <div className="mt-4 p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 rounded-lg">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.useOldRules || false}
                    onChange={e => setForm({ ...form, useOldRules: e.target.checked })}
                    className="w-4 h-4 text-amber-600 focus:ring-amber-500"
                  />
                  <span className="text-sm font-medium text-amber-900 dark:text-amber-200">
                    旧ルール（変形労働制以前）で給与計算する
                  </span>
                </label>
                <p className="mt-1 text-[10px] text-amber-700 dark:text-amber-300 leading-relaxed">
                  ※ 通常、ベトナム人スタッフは 2026年5月から新ルール（変形労働時間制・3層構造給与）が
                  自動適用されます。本人が新ルール移行を拒否した等の個別事情がある場合のみチェック。<br />
                  チェックすると、5月以降も旧ルール（1日6h40min所定、月集計合計×1.25残業）で計算されます。
                  退職時に退職日を設定すれば自動的に対象外になります。
                </p>
              </div>
            )}

            {/* Token management (edit only) */}
            {editId && (() => {
              const w = workers.find(x => x.id === editId)
              if (!w) return null
              return w.token ? (
                <div className="mt-4 p-3 bg-gray-50 rounded-lg">
                  <div className="text-xs text-gray-500 mb-2">モバイルトークン</div>
                  <div className="flex items-center gap-2">
                    <code className="text-xs bg-white px-2 py-1 rounded border flex-1 truncate">{w.token}</code>
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(`${baseUrl}/attendance/${w.token}`)
                        alert('URLをコピーしました')
                      }}
                      className="text-xs bg-hibi-navy text-white px-3 py-1 rounded"
                    >
                      URL
                    </button>
                    <button onClick={() => handleRevokeToken(w.id, w.name)} className="text-xs text-red-500 hover:text-red-700">
                      無効化
                    </button>
                  </div>
                </div>
              ) : null
            })()}

            <div className="flex gap-2 mt-6">
              <button onClick={handleSave} disabled={saving}
                className="flex-1 bg-hibi-navy text-white rounded-lg py-2.5 font-bold text-sm hover:bg-hibi-light transition disabled:opacity-50">
                {saving ? '保存中...' : '保存'}
              </button>
              <button onClick={() => setShowModal(false)}
                className="flex-1 bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-200 rounded-lg py-2.5 text-sm hover:bg-gray-300 dark:hover:bg-gray-500 transition">
                キャンセル
              </button>
            </div>
          </div>
        </div>
      )}

      {/* QR Modal */}
      {qrWorker && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setQrWorker(null)}>
          <div className="bg-white dark:bg-gray-800 rounded-xl p-6 max-w-sm w-full mx-4 animate-modalIn" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-hibi-navy dark:text-white mb-2">{qrWorker.name}</h3>
            <p className="text-xs text-gray-500 mb-4 break-all">{baseUrl}/attendance/{qrWorker.token}</p>
            <div className="flex justify-center mb-4">
              <QRCodeSVG value={`${baseUrl}/attendance/${qrWorker.token}`} size={200} level="M" />
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => {
                  navigator.clipboard.writeText(`${baseUrl}/attendance/${qrWorker.token}`)
                  alert('URLをコピーしました')
                }}
                className="flex-1 bg-hibi-navy text-white rounded-lg py-2 text-sm"
              >
                URLコピー
              </button>
              <button onClick={() => setQrWorker(null)} className="flex-1 bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-200 rounded-lg py-2 text-sm">
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
