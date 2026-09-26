'use client'

import { Fragment, useEffect, useState, useCallback } from 'react'
import { CAPABILITIES, PERM_ROLES, PERM_ROLE_LABEL, type Capability, type PermRole } from '@/lib/permissions'

interface DefaultRates {
  tobiRate: number
  dokoRate: number
  baseDays: number
}

/** 応援の請求書（/peer-invoice）に印字する自社情報。docs/peer-invoice.md 参照 */
interface CompanyProfile {
  name: string
  nameEn: string
  representative?: string
  postal: string
  address: string
  tel: string
  fax: string
  email: string
  invoiceRegNo: string
  bank: { bankName: string; branch: string; accountType: '普通' | '当座'; accountNo: string; holder: string }
  invoicePrefix: string
}

const EMPTY_COMPANY_PROFILE: CompanyProfile = {
  name: '株式会社日比建設', nameEn: 'HIBI CONSTRUCTION', postal: '', address: '', tel: '', fax: '', email: '',
  invoiceRegNo: '', bank: { bankName: '', branch: '', accountType: '普通', accountNo: '', holder: '' },
  invoicePrefix: 'HC',
}

/** HFU → 日比建設 の請求書の設定（lib/hfu-invoice.ts）。docs/peer-invoice.md 参照 */
interface HfuInvoiceForm {
  profile: CompanyProfile
  tobiRate: number
  dokoRate: number
  payMonthOffset: 1 | 2
  payDay: 'end' | number
}

/**
 * 未保存時の初期値は、HFU がこれまで手作りしていた請求書（2025-12 分・代表提供 2026-09-26）の記載どおり。
 * 保存ボタンを押すまで Firestore には入らない。土工の単価はその請求書に無いので空欄
 */
const EMPTY_HFU_INVOICE: HfuInvoiceForm = {
  profile: {
    ...EMPTY_COMPANY_PROFILE,
    name: 'エイチエフユナイテッド株式会社', nameEn: '', representative: '代表取締役 日比 靖仁',
    postal: '204-0003', address: '東京都清瀬市中里2-1620-1', tel: '042-493-9978', fax: '',
    invoiceRegNo: 'T5012701011352',
    bank: { bankName: '青梅信用金庫', branch: '秋津', accountType: '普通', accountNo: '0086328', holder: 'エイチエフユナイテッド株式会社 代表取締役 日比 靖仁' },
    invoicePrefix: 'HFU',
  },
  tobiRate: 30000, dokoRate: 0, payMonthOffset: 1, payDay: 'end',
}

/** 請求書の発行者情報の入力欄（日比建設の自社情報・HFU の情報で共通） */
function CompanyProfileFields({ value, onChange }: {
  value: CompanyProfile
  onChange: (update: (p: CompanyProfile) => CompanyProfile) => void
}) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">会社名</label>
          <input value={value.name} onChange={e => onChange(p => ({ ...p, name: e.target.value }))}
            className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm" />
        </div>
        <div>
          <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">会社名（英字・帳票用）</label>
          <input value={value.nameEn} onChange={e => onChange(p => ({ ...p, nameEn: e.target.value }))}
            className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm" />
        </div>
      </div>
      <div>
        <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">代表者（任意・例: 代表取締役 日比 靖仁）</label>
        <input value={value.representative || ''} onChange={e => onChange(p => ({ ...p, representative: e.target.value }))}
          className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm" />
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">郵便番号</label>
          <input value={value.postal} onChange={e => onChange(p => ({ ...p, postal: e.target.value }))}
            placeholder="例: 123-4567"
            className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm" />
        </div>
        <div className="col-span-2">
          <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">住所</label>
          <input value={value.address} onChange={e => onChange(p => ({ ...p, address: e.target.value }))}
            className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm" />
        </div>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">電話番号</label>
          <input value={value.tel} onChange={e => onChange(p => ({ ...p, tel: e.target.value }))}
            className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm" />
        </div>
        <div>
          <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">FAX（任意）</label>
          <input value={value.fax} onChange={e => onChange(p => ({ ...p, fax: e.target.value }))}
            className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm" />
        </div>
        <div>
          <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">メール（任意）</label>
          <input value={value.email} onChange={e => onChange(p => ({ ...p, email: e.target.value }))}
            className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">適格請求書発行事業者の登録番号</label>
          <input value={value.invoiceRegNo} onChange={e => onChange(p => ({ ...p, invoiceRegNo: e.target.value }))}
            placeholder="例: T1234567890123"
            className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm font-mono" />
        </div>
        <div>
          <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">請求書番号の接頭辞</label>
          <input value={value.invoicePrefix} onChange={e => onChange(p => ({ ...p, invoicePrefix: e.target.value.toUpperCase() }))}
            className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm" />
        </div>
      </div>

      <div className="pt-3 border-t border-gray-200 dark:border-gray-700">
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">振込先</label>
        <div className="grid grid-cols-2 gap-3 mb-3">
          <div>
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">銀行名</label>
            <input value={value.bank.bankName} onChange={e => onChange(p => ({ ...p, bank: { ...p.bank, bankName: e.target.value } }))}
              className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">支店名</label>
            <input value={value.bank.branch} onChange={e => onChange(p => ({ ...p, bank: { ...p.bank, branch: e.target.value } }))}
              className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm" />
          </div>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">種別</label>
            <select value={value.bank.accountType} onChange={e => onChange(p => ({ ...p, bank: { ...p.bank, accountType: e.target.value as '普通' | '当座' } }))}
              className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm">
              <option value="普通">普通</option>
              <option value="当座">当座</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">口座番号</label>
            <input value={value.bank.accountNo} onChange={e => onChange(p => ({ ...p, bank: { ...p.bank, accountNo: e.target.value } }))}
              className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">口座名義</label>
            <input value={value.bank.holder} onChange={e => onChange(p => ({ ...p, bank: { ...p.bank, holder: e.target.value } }))}
              className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm" />
          </div>
        </div>
      </div>
    </div>
  )
}

interface BackupPreview {
  workerCount: number
  siteCount: number
  subconCount: number
  hasAttendance: boolean
  attendanceMonths: number
  hasCalendars: boolean
  raw: Record<string, unknown>
}

interface ActivityEntry {
  id: string
  userId: string
  action: string
  details: string
  timestamp: string
}

interface UserWorker {
  id: number
  name: string
  company: string
  jobType: string
  token: string
  hireDate: string
  retired: string
}

// 役割ごとの権限は lib/permissions.ts に一本化（2026-09-26）。ここは表示するだけ
function PermissionMatrix() {
  const caps = Object.entries(CAPABILITIES) as [Capability, (typeof CAPABILITIES)[Capability]][]
  const groups = Array.from(new Set(caps.map(([, c]) => c.group)))
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 shadow-sm p-6">
      <h2 className="text-lg font-bold text-hibi-navy dark:text-white">役割ごとの権限</h2>
      <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 mb-4">
        メニューの表示・画面のボタン・サーバーのチェックはすべてこの表で決まります（2026-09-26 代表決定）。
        原則: 現場の作業は職長、事務処理は事務、最終承認は事業責任者、システムは代表。役員（政仁さん以外）は見るだけ。
        担当現場の制限（職長は自分の現場だけ）は別にかかります。変更はシステム管理者（コード）で行います。
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b-2 dark:border-gray-600">
              <th className="text-left px-2 py-2 text-gray-600 dark:text-gray-400">できること</th>
              {PERM_ROLES.map(r => <th key={r} className="text-center px-2 py-2 text-xs whitespace-nowrap">{PERM_ROLE_LABEL[r]}</th>)}
            </tr>
          </thead>
          <tbody>
            {groups.map(g => (
              <Fragment key={g}>
                <tr><td colSpan={1 + PERM_ROLES.length} className="px-2 pt-4 pb-1 text-xs font-bold text-gray-400">{g}</td></tr>
                {caps.filter(([, c]) => c.group === g).map(([key, c]) => (
                  <tr key={key} className="border-t dark:border-gray-700/50">
                    <td className="px-2 py-1.5 text-gray-700 dark:text-gray-300">{c.label}</td>
                    {PERM_ROLES.map(r => (
                      <td key={r} className="text-center px-2 py-1.5">
                        {(c.roles as readonly PermRole[]).includes(r) ? <span className="text-emerald-600 font-bold">○</span> : <span className="text-gray-300">—</span>}
                      </td>
                    ))}
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}


const ROLE_BADGES: Record<string, { label: string; cls: string }> = {
  yakuin: { label: '役員（見るだけ）', cls: 'bg-red-100 text-red-700' },
  shokucho: { label: '職長（foreman）', cls: 'bg-blue-100 text-blue-700' },
  jimu: { label: '事務', cls: 'bg-purple-100 text-purple-700' },
}

function roleBadge(jobType: string) {
  return ROLE_BADGES[jobType] || { label: jobType || '—', cls: 'bg-gray-100 text-gray-500' }
}

const ACTION_LABELS: Record<string, string> = {
  'worker.add': '人員追加',
  'worker.update': '人員更新',
  'worker.delete': '人員削除',
  'site.add': '現場追加',
  'site.update': '現場更新',
  'site.delete': '現場削除',
  'calendar.submit': 'カレンダー提出',
  'calendar.approve': 'カレンダー承認',
  'calendar.reject': 'カレンダー差戻',
  'calendar.sign': 'カレンダー署名',
  'attendance.save': '出面保存',
  'monthly.lock': '月次締め',
  'monthly.unlock': '月次締め解除',
  'leave.grant': '有給付与',
  'leave.update': '有給更新',
  'subcon.add': '外注先追加',
  'subcon.update': '外注先更新',
  'subcon.delete': '外注先削除',
  'settings.update': '設定変更',
  'rates.default': 'デフォルト単価変更',
  'rates.site': '現場単価変更',
}

const ACTION_ICONS: Record<string, string> = {
  'worker': '👷',
  'site': '🏗',
  'calendar': '📅',
  'attendance': '📋',
  'monthly': '📊',
  'leave': '🌴',
  'subcon': '🔧',
  'settings': '⚙️',
  'rates': '💰',
}

function getActionIcon(action: string): string {
  const prefix = action.split('.')[0]
  return ACTION_ICONS[prefix] || '📝'
}

function getActionLabel(action: string): string {
  return ACTION_LABELS[action] || action
}

function formatTimestamp(ts: string): string {
  const d = new Date(ts)
  const m = d.getMonth() + 1
  const day = d.getDate()
  const h = String(d.getHours()).padStart(2, '0')
  const min = String(d.getMinutes()).padStart(2, '0')
  return `${m}/${day} ${h}:${min}`
}

/**
 * 設定画面のタブ（2026-09-26 整理）。旧は「設定」タブに単価・請求書・HFU・パスワード・バックアップが混在していた
 * company=会社・請求書 / settings=単価の既定値 / users=ログイン・権限 / announcements=お知らせ / activity=バックアップ・履歴
 */
type Tab = 'company' | 'settings' | 'users' | 'announcements' | 'activity'
const SETTINGS_TABS: { key: Tab; label: string }[] = [
  { key: 'company', label: '🏢 会社・請求書' },
  { key: 'settings', label: '💴 単価の既定値' },
  { key: 'users', label: '🔑 ログイン・権限' },
  { key: 'announcements', label: '📢 お知らせ' },
  { key: 'activity', label: '🗄 バックアップ・履歴' },
]

interface Announcement {
  id: string
  title: string
  content: string
  category: 'new' | 'fix' | 'info'
  publishedAt: string
  publishedBy: string
}

const ANN_CATEGORIES = [
  { value: 'new', label: '🆕 新機能', cls: 'bg-blue-100 text-blue-700' },
  { value: 'fix', label: '🔧 不具合修正', cls: 'bg-green-100 text-green-700' },
  { value: 'info', label: '📢 お知らせ', cls: 'bg-gray-100 text-gray-700' },
] as const

export default function SettingsPage() {
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [activeTab, setActiveTab] = useState<Tab>('company')
  // メニュー検索などから ?tab=users / activity / announcements で直接開けるように（2026-09-26）
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('tab')
    if (SETTINGS_TABS.some(x => x.key === t)) setActiveTab(t as Tab)
  }, [])

  // Default rates
  const [rates, setRates] = useState<DefaultRates>({ tobiRate: 0, dokoRate: 0, baseDays: 20 })

  // 請求書の自社情報（応援の請求書用）
  const [companyProfile, setCompanyProfile] = useState<CompanyProfile>(EMPTY_COMPANY_PROFILE)
  const [savingProfile, setSavingProfile] = useState(false)

  // HFU → 日比建設 の請求書
  const [hfuInvoice, setHfuInvoice] = useState<HfuInvoiceForm>(EMPTY_HFU_INVOICE)
  const [savingHfu, setSavingHfu] = useState(false)

  // User passwords
  // 2026-09-26: パスワードそのものは画面に出さない（保存はハッシュ）。設定済みかどうかと、今回の変更だけを持つ
  const [passwordSet, setPasswordSet] = useState<Record<string, boolean>>({})
  const [pwChanges, setPwChanges] = useState<Record<string, string | null>>({})
  const [pwWorkers, setPwWorkers] = useState<{ id: number; name: string; jobType: string; retired?: string }[]>([])
  const [savingPw, setSavingPw] = useState(false)

  // Backup/Restore
  const [exporting, setExporting] = useState(false)
  const [importPreview, setImportPreview] = useState<BackupPreview | null>(null)
  const [restoring, setRestoring] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)

  // Activity
  const [activityEntries, setActivityEntries] = useState<ActivityEntry[]>([])
  const [activityLoading, setActivityLoading] = useState(false)
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [filterUser, setFilterUser] = useState('')
  const [filterAction, setFilterAction] = useState('')

  // Announcements
  const [announcements, setAnnouncements] = useState<Announcement[]>([])
  const [annLoading, setAnnLoading] = useState(false)
  const [annEditId, setAnnEditId] = useState<string | null>(null)
  const [annForm, setAnnForm] = useState<{ title: string; content: string; category: 'new' | 'fix' | 'info' }>({
    title: '', content: '', category: 'new',
  })
  const [annSaving, setAnnSaving] = useState(false)

  // Users
  const [userWorkers, setUserWorkers] = useState<UserWorker[]>([])
  const [usersLoading, setUsersLoading] = useState(true)

  useEffect(() => {
    const stored = localStorage.getItem('hibi_auth')
    if (stored) {
      try {
        const { password: pw } = JSON.parse(stored)
        if (pw) setPassword(pw)
      } catch { /* ignore */ }
    }
  }, [])

  const showMessage = (type: 'success' | 'error', text: string) => {
    setMessage({ type, text })
    setTimeout(() => setMessage(null), 3000)
  }

  const fetchRates = useCallback(async () => {
    if (!password) return
    setLoading(true)
    try {
      const res = await fetch('/api/settings', {
        headers: { 'x-admin-password': password },
      })
      if (!res.ok) throw new Error('Unauthorized')
      const data = await res.json()
      setRates({ tobiRate: 0, dokoRate: 0, baseDays: 20, ...data.defaultRates })
    } catch {
      showMessage('error', '設定の読み込みに失敗しました')
    } finally {
      setLoading(false)
    }
  }, [password])

  const fetchHfuInvoice = useCallback(async () => {
    if (!password) return
    try {
      const res = await fetch('/api/settings?action=getHfuInvoice', { headers: { 'x-admin-password': password } })
      if (!res.ok) return
      const h = (await res.json()).hfuInvoice
      if (!h) return
      setHfuInvoice({
        profile: { ...EMPTY_HFU_INVOICE.profile, ...(h.profile || {}), bank: { ...EMPTY_HFU_INVOICE.profile.bank, ...(h.profile?.bank || {}) } },
        tobiRate: h.tobiRate || 0,
        dokoRate: h.dokoRate || 0,
        payMonthOffset: h.paymentTerms?.payMonthOffset === 2 ? 2 : 1,
        payDay: h.paymentTerms?.payDay ?? 'end',
      })
    } catch { /* ignore */ }
  }, [password])

  const fetchCompanyProfile = useCallback(async () => {
    if (!password) return
    try {
      const res = await fetch('/api/settings?action=getCompanyProfile', { headers: { 'x-admin-password': password } })
      if (!res.ok) return
      const data = await res.json()
      if (data.companyProfile) setCompanyProfile({ ...EMPTY_COMPANY_PROFILE, ...data.companyProfile, bank: { ...EMPTY_COMPANY_PROFILE.bank, ...(data.companyProfile.bank || {}) } })
    } catch { /* ignore */ }
  }, [password])

  const fetchUserPasswords = useCallback(async () => {
    if (!password) return
    try {
      const [pwRes, wRes] = await Promise.all([
        fetch('/api/settings?action=getUserPasswords', { headers: { 'x-admin-password': password } }),
        fetch('/api/workers', { headers: { 'x-admin-password': password } }),
      ])
      if (pwRes.ok) {
        const data = await pwRes.json()
        setPasswordSet(data.passwordSet || {})
      }
      if (wRes.ok) {
        const data = await wRes.json()
        setPwWorkers(
          (data.workers || [])
            // 個人パスワードでログインする対象: 役員(yakuin) / 事務(jimu) / 事業責任者=approver(workerId=1, 政仁さん)
            // 退職済みでもパスワードが残っている人は出す（消せるように）
            .filter((w: { id?: number; retired?: string; jobType?: string }) =>
              w.jobType === 'yakuin' || w.jobType === 'jimu' || w.id === 1
            )
            .map((w: { id: number; name: string; jobType: string; retired?: string }) => ({ id: w.id, name: w.name, jobType: w.jobType, retired: w.retired }))
        )
      }
    } catch { /* ignore */ }
  }, [password])

  const fetchActivity = useCallback(async () => {
    if (!password) return
    setActivityLoading(true)
    try {
      const params = new URLSearchParams()
      if (startDate) params.set('startDate', startDate)
      if (endDate) params.set('endDate', endDate)
      if (filterUser) params.set('userId', filterUser)
      if (filterAction) params.set('action', filterAction)

      const res = await fetch(`/api/activity?${params.toString()}`, {
        headers: { 'x-admin-password': password },
      })
      if (res.ok) {
        const data = await res.json()
        setActivityEntries(data.entries || [])
      }
    } catch {
      // silent
    } finally {
      setActivityLoading(false)
    }
  }, [password, startDate, endDate, filterUser, filterAction])

  const fetchUsers = useCallback(async () => {
    if (!password) return
    setUsersLoading(true)
    try {
      const workersRes = await fetch('/api/workers', { headers: { 'x-admin-password': password } })
      if (workersRes.ok) {
        const data = await workersRes.json()
        const all: UserWorker[] = data.workers || []
        setUserWorkers(all.filter(w => ['yakuin', 'shokucho', 'jimu'].includes(w.jobType) && !w.retired))
      }
    } finally {
      setUsersLoading(false)
    }
  }, [password])

  useEffect(() => {
    if (password) { fetchRates(); fetchUserPasswords(); fetchCompanyProfile(); fetchHfuInvoice() }
  }, [password, fetchRates, fetchUserPasswords, fetchCompanyProfile, fetchHfuInvoice])

  // Fetch activity when tab is switched or filters change
  useEffect(() => {
    if (activeTab === 'activity' && password) fetchActivity()
  }, [activeTab, fetchActivity, password])

  // Fetch users when tab is switched
  useEffect(() => {
    if (activeTab === 'users' && password) fetchUsers()
  }, [activeTab, fetchUsers, password])

  // ── Announcements ──
  const fetchAnnouncements = useCallback(async () => {
    if (!password) return
    setAnnLoading(true)
    try {
      // 投稿の編集・削除用なので、投稿したものだけ（リリースノートはコード側・lib/release-notes.ts）
      const res = await fetch('/api/announcements?scope=posted', {
        headers: { 'x-admin-password': password },
      })
      if (res.ok) {
        const data = await res.json()
        setAnnouncements(data.announcements || [])
      }
    } finally {
      setAnnLoading(false)
    }
  }, [password])

  useEffect(() => {
    if (activeTab === 'announcements' && password) fetchAnnouncements()
  }, [activeTab, fetchAnnouncements, password])

  const handleSaveAnnouncement = async () => {
    if (!annForm.title.trim() || !annForm.content.trim()) {
      showMessage('error', 'タイトルと本文を入力してください')
      return
    }
    setAnnSaving(true)
    try {
      const userStored = localStorage.getItem('hibi_auth')
      const publishedBy = userStored ? (JSON.parse(userStored).user?.name || '管理者') : '管理者'
      const body = annEditId
        ? { action: 'update', id: annEditId, ...annForm }
        : { action: 'add', ...annForm, publishedBy }
      const res = await fetch('/api/announcements', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
        body: JSON.stringify(body),
      })
      if (res.ok) {
        showMessage('success', annEditId ? 'お知らせを更新しました' : 'お知らせを投稿しました')
        setAnnEditId(null)
        setAnnForm({ title: '', content: '', category: 'new' })
        await fetchAnnouncements()
      } else {
        showMessage('error', '保存に失敗しました')
      }
    } catch {
      showMessage('error', 'エラーが発生しました')
    }
    setAnnSaving(false)
  }

  const handleDeleteAnnouncement = async (id: string, title: string) => {
    if (!confirm(`「${title}」を削除しますか？`)) return
    const res = await fetch('/api/announcements', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
      body: JSON.stringify({ action: 'delete', id }),
    })
    if (res.ok) {
      showMessage('success', '削除しました')
      await fetchAnnouncements()
    } else {
      showMessage('error', '削除に失敗しました')
    }
  }

  const handleEditAnnouncement = (a: Announcement) => {
    setAnnEditId(a.id)
    setAnnForm({ title: a.title, content: a.content, category: a.category })
  }

  const handleCancelAnnouncementEdit = () => {
    setAnnEditId(null)
    setAnnForm({ title: '', content: '', category: 'new' })
  }

  const handleSaveRates = async () => {
    setSaving(true)
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-password': password,
        },
        body: JSON.stringify({
          action: 'saveDefaultRates',
          tobiRate: rates.tobiRate,
          dokoRate: rates.dokoRate,
          baseDays: rates.baseDays,
        }),
      })
      if (!res.ok) throw new Error('Save failed')
      showMessage('success', 'デフォルト単価を保存しました')
    } catch {
      showMessage('error', '保存に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  const handleSaveCompanyProfile = async () => {
    setSavingProfile(true)
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
        body: JSON.stringify({ action: 'saveCompanyProfile', companyProfile }),
      })
      if (!res.ok) throw new Error('Save failed')
      showMessage('success', '請求書の自社情報を保存しました')
    } catch {
      showMessage('error', '保存に失敗しました（管理者パスワードでログインしているか確認してください）')
    } finally {
      setSavingProfile(false)
    }
  }

  const handleSaveHfuInvoice = async () => {
    setSavingHfu(true)
    try {
      const { profile, tobiRate, dokoRate, payMonthOffset, payDay } = hfuInvoice
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
        body: JSON.stringify({ action: 'saveHfuInvoice', hfuInvoice: { profile, tobiRate, dokoRate, paymentTerms: { closing: 'end', payMonthOffset, payDay } } }),
      })
      if (!res.ok) throw new Error('Save failed')
      showMessage('success', 'HFU → 日比建設 の請求書の設定を保存しました')
    } catch {
      showMessage('error', '保存に失敗しました（管理者パスワードでログインしているか確認してください）')
    } finally {
      setSavingHfu(false)
    }
  }

  const handleExport = async () => {
    setExporting(true)
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-password': password,
        },
        body: JSON.stringify({ action: 'backup' }),
      })
      if (!res.ok) throw new Error('Export failed')
      const data = await res.json()

      const now = new Date()
      const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
      const filename = `hibi-backup-${dateStr}.json`
      const blob = new Blob([JSON.stringify(data.backup, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)

      showMessage('success', `${filename} をダウンロードしました`)
    } catch {
      showMessage('error', 'エクスポートに失敗しました')
    } finally {
      setExporting(false)
    }
  }

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    const reader = new FileReader()
    reader.onload = (evt) => {
      try {
        const raw = JSON.parse(evt.target?.result as string) as Record<string, unknown>
        const workers = Array.isArray(raw.workers) ? raw.workers : []
        const sites = Array.isArray(raw.sites) ? raw.sites : []
        const subcons = Array.isArray(raw.subcons) ? raw.subcons : []
        const attDocs = (raw._attDocs || {}) as Record<string, unknown>
        const attMonthCount = Object.keys(attDocs).filter(k => k.startsWith('att_')).length
        setImportPreview({
          workerCount: workers.length,
          siteCount: sites.length,
          subconCount: subcons.length,
          hasAttendance: attMonthCount > 0 || !!raw.attend,
          attendanceMonths: attMonthCount,
          hasCalendars: !!raw.calendars,
          raw,
        })
      } catch {
        showMessage('error', 'JSONファイルの読み込みに失敗しました')
        setImportPreview(null)
      }
    }
    reader.readAsText(file)
  }

  const handleRestore = async () => {
    if (!importPreview) return
    setRestoring(true)
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-password': password,
        },
        body: JSON.stringify({ action: 'restore', data: importPreview.raw }),
      })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || 'Restore failed')
      }
      showMessage('success', 'データをリストアしました')
      setImportPreview(null)
      setShowConfirm(false)
      fetchRates()
    } catch (err) {
      showMessage('error', `リストアに失敗しました: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setRestoring(false)
    }
  }

  const adjustRate = (field: 'tobiRate' | 'dokoRate' | 'baseDays', delta: number) => {
    setRates(prev => {
      let val = prev[field] + delta
      if (field === 'baseDays') val = Math.min(31, Math.max(1, val))
      else val = Math.max(0, val)
      return { ...prev, [field]: val }
    })
  }

  /** 数値をカンマ区切り文字列に変換 */
  const fmt = (n: number) => n.toLocaleString('ja-JP')
  /** カンマ区切り文字列を数値に変換 */
  const parseRate = (s: string) => Number(s.replace(/,/g, '')) || 0

  if (loading && password) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-gray-400">読み込み中...</div>
      </div>
    )
  }

  // Activity tab unique values for filters
  const uniqueUsers = Array.from(new Set(activityEntries.map(e => e.userId)))
  const uniqueActions = Array.from(new Set(activityEntries.map(e => e.action)))

  return (
    <div className="max-w-5xl mx-auto">
      <h1 className="text-2xl font-bold text-hibi-navy dark:text-white mb-4">管理者設定</h1>

      {/* Tabs */}
      <div className="flex gap-1 mb-4 bg-gray-100 dark:bg-gray-800 rounded-lg p-1 overflow-x-auto">
        {SETTINGS_TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setActiveTab(t.key)}
            className={`flex-1 whitespace-nowrap py-2 px-3 rounded-md text-sm font-medium transition ${
              activeTab === t.key
                ? 'bg-white dark:bg-gray-700 text-hibi-navy dark:text-white shadow-sm'
                : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Message toast */}
      {message && (
        <div className={`p-3 rounded-lg text-sm font-medium mb-4 ${
          message.type === 'success' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
        }`}>
          {message.text}
        </div>
      )}

      {/* ===== 設定系のカード（タブごとに出し分け・2026-09-26） ===== */}
      {(activeTab === 'settings' || activeTab === 'company' || activeTab === 'users' || activeTab === 'activity') && (
        <div className="max-w-2xl space-y-6 mb-6">
          {activeTab === 'settings' && (<>
          {/* Default Rates Card */}
          <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 shadow-sm p-6">
            <h2 className="text-lg font-bold text-hibi-navy dark:text-white mb-4">デフォルト単価エディタ</h2>

            <div className="space-y-4">
              {/* Tobi Rate */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">鳶基本単価</label>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => adjustRate('tobiRate', -1000)}
                    className="px-3 py-2 bg-gray-200 dark:bg-gray-600 hover:bg-gray-300 dark:hover:bg-gray-500 rounded-lg font-bold text-lg transition dark:text-white"
                  >
                    −1000
                  </button>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={fmt(rates.tobiRate)}
                    onChange={e => setRates(prev => ({ ...prev, tobiRate: parseRate(e.target.value) }))}
                    className="flex-1 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-center text-lg font-bold"
                  />
                  <button
                    onClick={() => adjustRate('tobiRate', 1000)}
                    className="px-3 py-2 bg-gray-200 dark:bg-gray-600 hover:bg-gray-300 dark:hover:bg-gray-500 rounded-lg font-bold text-lg transition dark:text-white"
                  >
                    +1000
                  </button>
                  <span className="text-gray-500 dark:text-gray-400 text-sm">円</span>
                </div>
              </div>

              {/* Doko Rate */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">土工基本単価</label>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => adjustRate('dokoRate', -1000)}
                    className="px-3 py-2 bg-gray-200 dark:bg-gray-600 hover:bg-gray-300 dark:hover:bg-gray-500 rounded-lg font-bold text-lg transition dark:text-white"
                  >
                    −1000
                  </button>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={fmt(rates.dokoRate)}
                    onChange={e => setRates(prev => ({ ...prev, dokoRate: parseRate(e.target.value) }))}
                    className="flex-1 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-center text-lg font-bold"
                  />
                  <button
                    onClick={() => adjustRate('dokoRate', 1000)}
                    className="px-3 py-2 bg-gray-200 dark:bg-gray-600 hover:bg-gray-300 dark:hover:bg-gray-500 rounded-lg font-bold text-lg transition dark:text-white"
                  >
                    +1000
                  </button>
                  <span className="text-gray-500 dark:text-gray-400 text-sm">円</span>
                </div>
              </div>

              {/* Base Days */}
              <div className="pt-4 border-t border-gray-200 dark:border-gray-700">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">基本給ベース日数（外国人・3層構造）</label>
                <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
                  基本給（固定）= 時給 × ベース日数 × 7h。この日数を超えた出勤分は追加所定手当として支給。
                </p>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => adjustRate('baseDays', -1)}
                    className="px-3 py-2 bg-gray-200 dark:bg-gray-600 hover:bg-gray-300 dark:hover:bg-gray-500 rounded-lg font-bold text-lg transition dark:text-white"
                  >
                    −1
                  </button>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={rates.baseDays}
                    onChange={e => setRates(prev => ({ ...prev, baseDays: Math.min(31, Math.max(1, Number(e.target.value.replace(/\D/g, '')) || 1)) }))}
                    className="w-20 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-center text-lg font-bold"
                  />
                  <button
                    onClick={() => adjustRate('baseDays', 1)}
                    className="px-3 py-2 bg-gray-200 dark:bg-gray-600 hover:bg-gray-300 dark:hover:bg-gray-500 rounded-lg font-bold text-lg transition dark:text-white"
                  >
                    +1
                  </button>
                  <span className="text-gray-500 dark:text-gray-400 text-sm">日</span>
                </div>
              </div>
            </div>

            <button
              onClick={handleSaveRates}
              disabled={saving}
              className="mt-4 w-full bg-hibi-navy text-white py-2.5 rounded-lg font-medium hover:bg-hibi-navy/90 disabled:opacity-50 transition"
            >
              {saving ? '保存中...' : '保存'}
            </button>
          </div>
          </>)}

          {activeTab === 'company' && (<>
          {/* 請求書の自社情報（応援の請求書 /peer-invoice 用） */}
          <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 shadow-sm p-6">
            <h2 className="text-lg font-bold text-hibi-navy dark:text-white mb-2">請求書の自社情報</h2>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
              「応援の請求書」（同業者へ送る請求書。/peer-statement から作成）に印字する発行者情報です。
              住所・登録番号・振込先は未入力のままにしています。届いた請求書を見ながらご自身で入力してください。
            </p>
            <CompanyProfileFields value={companyProfile} onChange={setCompanyProfile} />

            <button
              onClick={handleSaveCompanyProfile}
              disabled={savingProfile}
              className="mt-4 w-full bg-hibi-navy text-white py-2.5 rounded-lg font-medium hover:bg-hibi-navy/90 disabled:opacity-50 transition"
            >
              {savingProfile ? '保存中...' : '保存'}
            </button>
          </div>
          </>)}

          {activeTab === 'company' && (<>
          {/* HFU → 日比建設 の請求書（/peer-invoice?company=__hfu_to_hibi__） */}
          <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 shadow-sm p-6">
            <h2 className="text-lg font-bold text-hibi-navy dark:text-white mb-2">HFU → 日比建設 の請求書</h2>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
              HFU 所属の作業員が働いた人工（全現場）を、HFU から日比建設へ請求する請求書の設定です。
              金額は 人工 × 下の単価（税抜）。残業は「時間 × 残業単価（単価÷8×1.25）」の別の行になります（従来の請求書と同じ）。
              土工のいない月は土工の単価が空欄でも発行できます。宛先には上の「請求書の自社情報」（日比建設）の住所を印字します。
            </p>
            <div className="grid grid-cols-2 gap-3 mb-4">
              <div>
                <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">鳶 1人工の単価（税抜・円）</label>
                <input type="number" min={0} value={hfuInvoice.tobiRate || ''} onChange={e => setHfuInvoice(h => ({ ...h, tobiRate: Number(e.target.value) || 0 }))}
                  className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm tabular-nums" />
              </div>
              <div>
                <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">土工 1人工の単価（税抜・円）</label>
                <input type="number" min={0} value={hfuInvoice.dokoRate || ''} onChange={e => setHfuInvoice(h => ({ ...h, dokoRate: Number(e.target.value) || 0 }))}
                  className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm tabular-nums" />
              </div>
              <div>
                <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">支払月（月末締め）</label>
                <select value={hfuInvoice.payMonthOffset} onChange={e => setHfuInvoice(h => ({ ...h, payMonthOffset: Number(e.target.value) === 2 ? 2 : 1 }))}
                  className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm">
                  <option value={1}>翌月払い</option>
                  <option value={2}>翌々月払い</option>
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">支払日</label>
                <select value={String(hfuInvoice.payDay)} onChange={e => setHfuInvoice(h => ({ ...h, payDay: e.target.value === 'end' ? 'end' : Number(e.target.value) }))}
                  className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm">
                  <option value="end">月末</option>
                  {[5, 10, 15, 20, 25].map(d => <option key={d} value={d}>{d}日</option>)}
                </select>
              </div>
            </div>
            <div className="pt-3 border-t border-gray-200 dark:border-gray-700">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">HFU の会社情報（発行者として印字）</label>
              <CompanyProfileFields value={hfuInvoice.profile} onChange={update => setHfuInvoice(h => ({ ...h, profile: update(h.profile) }))} />
              <p className="text-[11px] text-gray-400 mt-2">請求書番号の接頭辞は日比建設（{companyProfile.invoicePrefix || 'HC'}）と別にしてください。番号は会社ごとに別々に数えます。</p>
            </div>
            <button
              onClick={handleSaveHfuInvoice}
              disabled={savingHfu}
              className="mt-4 w-full bg-hibi-navy text-white py-2.5 rounded-lg font-medium hover:bg-hibi-navy/90 disabled:opacity-50 transition"
            >
              {savingHfu ? '保存中...' : '保存'}
            </button>
          </div>
          </>)}

          {activeTab === 'users' && (<>
          {/* User Passwords Card */}
          <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 shadow-sm p-6">
            <h2 className="text-lg font-bold text-hibi-navy dark:text-white mb-2">個人パスワード設定</h2>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
              役員・事務スタッフの個人ログインパスワード（名前選択なしで直接ログイン）。
              パスワードは暗号化して保存し、画面には表示しません。変えるときは新しいパスワードを入れて「保存」（8文字以上・名前や誕生日など推測されやすいものは避ける）。
              変えた人・消した人は、使っている端末でログインし直しになります。
            </p>
            <div className="space-y-3">
              {pwWorkers
                .filter(w => !w.retired || passwordSet[String(w.id)])
                .map(w => {
                const key = String(w.id)
                // 政仁さん（workerId=1）は事業責任者ロール
                const isApprover = w.id === 1
                const badgeClass = isApprover
                  ? 'bg-orange-100 text-orange-700'
                  : w.jobType === 'yakuin'
                    ? 'bg-red-100 text-red-700'
                    : 'bg-purple-100 text-purple-700'
                const badgeLabel = isApprover ? '事業責任者' : w.jobType === 'yakuin' ? '役員' : '事務'
                const change = pwChanges[key]
                const isSet = !!passwordSet[key]
                return (
                <div key={w.id} className="flex items-center gap-3 flex-wrap">
                  <span className="text-sm font-medium w-28">{w.name}{w.retired && <span className="text-[10px] text-gray-400">（退職）</span>}</span>
                  <span className={`text-[10px] px-2 py-0.5 rounded-full ${badgeClass}`}>{badgeLabel}</span>
                  <span className={`text-[11px] w-16 ${change === null ? 'text-red-600' : isSet ? 'text-emerald-600' : 'text-gray-400'}`}>
                    {change === null ? '削除する' : isSet ? '✓ 設定済み' : '未設定'}
                  </span>
                  <input
                    type="text"
                    autoComplete="off"
                    value={typeof change === 'string' ? change : ''}
                    onChange={e => setPwChanges(prev => ({ ...prev, [key]: e.target.value }))}
                    placeholder={isSet ? '変えるときだけ新しいパスワードを入力' : '新しいパスワード（8文字以上）'}
                    className="flex-1 min-w-[12rem] border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-hibi-navy focus:outline-none"
                  />
                  {isSet && (
                    <button type="button"
                      onClick={() => setPwChanges(prev => { const n = { ...prev }; if (n[key] === null) delete n[key]; else n[key] = null; return n })}
                      className="text-xs text-red-600 border border-red-200 rounded px-2 py-1 hover:bg-red-50">
                      {change === null ? '取り消し' : 'ログインできなくする'}
                    </button>
                  )}
                </div>
                )
              })}
            </div>
            {pwWorkers.length > 0 && (
              <button
                onClick={async () => {
                  // 空欄は「変更なし」。null は削除
                  const changes = Object.fromEntries(Object.entries(pwChanges).filter(([, v]) => v === null || (typeof v === 'string' && v !== '')))
                  if (Object.keys(changes).length === 0) { showMessage('error', '変更がありません'); return }
                  setSavingPw(true)
                  try {
                    const res = await fetch('/api/settings', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
                      body: JSON.stringify({ action: 'saveUserPasswords', changes }),
                    })
                    const data = await res.json().catch(() => ({}))
                    if (res.ok) {
                      showMessage('success', '個人パスワードを保存しました（本人に口頭で伝えてください）')
                      setPwChanges({})
                      fetchUserPasswords()
                    } else showMessage('error', data.error || '保存に失敗しました')
                  } catch { showMessage('error', 'エラーが発生しました') }
                  finally { setSavingPw(false) }
                }}
                disabled={savingPw}
                className="mt-4 bg-hibi-navy text-white rounded-lg px-4 py-2 text-sm font-bold hover:bg-hibi-light transition disabled:opacity-50"
              >
                {savingPw ? '保存中...' : '保存'}
              </button>
            )}
          </div>
          </>)}

          {activeTab === 'activity' && (<>
          {/* Backup Card */}
          <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 shadow-sm p-6">
            <h2 className="text-lg font-bold text-hibi-navy dark:text-white mb-4">バックアップ</h2>

            <p className="text-sm text-gray-600 dark:text-gray-400 mb-3">
              現在のデータベース全体をJSONファイルとしてダウンロードします。
            </p>

            <button
              onClick={handleExport}
              disabled={exporting}
              className="w-full bg-blue-600 text-white py-2.5 rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50 transition"
            >
              {exporting ? 'エクスポート中...' : 'JSONエクスポート'}
            </button>
          </div>
          </>)}

          {activeTab === 'activity' && (<>
          {/* Restore Card */}
          <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 shadow-sm p-6">
            <h2 className="text-lg font-bold text-hibi-navy dark:text-white mb-4">リストア</h2>

            <p className="text-sm text-gray-600 dark:text-gray-400 mb-3">
              バックアップJSONファイルからデータを復元します。現在のデータは上書きされます。
            </p>

            <input
              type="file"
              accept=".json"
              onChange={handleFileSelect}
              className="w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-gray-200 file:text-gray-700 hover:file:bg-gray-300"
            />

            {/* Preview */}
            {importPreview && (
              <div className="mt-4 border border-gray-200 dark:border-gray-700 rounded-lg p-4 bg-gray-50 dark:bg-gray-700">
                <h3 className="font-medium text-gray-800 dark:text-gray-200 mb-2">インポートデータのプレビュー</h3>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div className="text-gray-600 dark:text-gray-400">作業員数:</div>
                  <div className="font-medium">{importPreview.workerCount}名</div>
                  <div className="text-gray-600 dark:text-gray-400">現場数:</div>
                  <div className="font-medium">{importPreview.siteCount}件</div>
                  <div className="text-gray-600 dark:text-gray-400">外注先数:</div>
                  <div className="font-medium">{importPreview.subconCount}件</div>
                  <div className="text-gray-600 dark:text-gray-400">出面データ:</div>
                  <div className="font-medium">
                    {importPreview.hasAttendance ? `あり${importPreview.attendanceMonths > 0 ? `（${importPreview.attendanceMonths}ヶ月分）` : ''}` : 'なし'}
                  </div>
                  <div className="text-gray-600 dark:text-gray-400">カレンダーデータ:</div>
                  <div className="font-medium">{importPreview.hasCalendars ? 'あり' : 'なし'}</div>
                </div>

                {!showConfirm ? (
                  <button
                    onClick={() => setShowConfirm(true)}
                    className="mt-4 w-full bg-orange-500 text-white py-2.5 rounded-lg font-medium hover:bg-orange-600 transition"
                  >
                    リストア実行
                  </button>
                ) : (
                  <div className="mt-4 space-y-2">
                    <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                      本当にリストアしますか？現在のデータは全て上書きされます。この操作は取り消せません。
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={() => setShowConfirm(false)}
                        className="flex-1 bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-200 py-2.5 rounded-lg font-medium hover:bg-gray-300 dark:hover:bg-gray-500 transition"
                      >
                        キャンセル
                      </button>
                      <button
                        onClick={handleRestore}
                        disabled={restoring}
                        className="flex-1 bg-red-600 text-white py-2.5 rounded-lg font-medium hover:bg-red-700 disabled:opacity-50 transition"
                      >
                        {restoring ? 'リストア中...' : '確定する'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
          </>)}
        </div>
      )}

      {/* ===== Activity Tab ===== */}
      {activeTab === 'activity' && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-lg font-bold text-hibi-navy dark:text-white">操作の記録</h2>
            <a href="/access-log" className="text-sm text-hibi-navy dark:text-blue-300 underline">スタッフのアクセス履歴を見る →</a>
          </div>
          {/* Filters */}
          <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4 mb-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div>
                <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">開始日</label>
                <input
                  type="date"
                  value={startDate}
                  onChange={e => setStartDate(e.target.value)}
                  className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">終了日</label>
                <input
                  type="date"
                  value={endDate}
                  onChange={e => setEndDate(e.target.value)}
                  className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">ユーザー</label>
                <select
                  value={filterUser}
                  onChange={e => setFilterUser(e.target.value)}
                  className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none bg-white dark:bg-gray-700"
                >
                  <option value="">すべて</option>
                  {uniqueUsers.map(u => (
                    <option key={u} value={u}>{u}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">操作</label>
                <select
                  value={filterAction}
                  onChange={e => setFilterAction(e.target.value)}
                  className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none bg-white dark:bg-gray-700"
                >
                  <option value="">すべて</option>
                  {uniqueActions.map(a => (
                    <option key={a} value={a}>{getActionLabel(a)}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {/* Table */}
          <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
            {activityLoading ? (
              <div className="p-8 text-center text-gray-400">読み込み中...</div>
            ) : activityEntries.length === 0 ? (
              <div className="p-8 text-center text-gray-400">アクティビティログはありません</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 dark:bg-gray-700 border-b border-gray-200 dark:border-gray-700">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider w-28">日時</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider w-24">ユーザー</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider w-36">操作</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">詳細</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                    {activityEntries.map((entry) => (
                      <tr key={entry.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors">
                        <td className="px-4 py-3 text-gray-500 whitespace-nowrap font-mono text-xs">
                          {formatTimestamp(entry.timestamp)}
                        </td>
                        <td className="px-4 py-3 text-gray-700 dark:text-gray-300 whitespace-nowrap">
                          {entry.userId}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          <span className="inline-flex items-center gap-1.5 text-gray-700 dark:text-gray-300">
                            <span>{getActionIcon(entry.action)}</span>
                            <span>{getActionLabel(entry.action)}</span>
                          </span>
                        </td>
                        <td className="px-4 py-3 text-gray-600 dark:text-gray-400 max-w-xs truncate">
                          {entry.details}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Footer */}
            {activityEntries.length > 0 && (
              <div className="px-4 py-2 border-t border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-700 text-xs text-gray-400 dark:text-gray-500">
                {activityEntries.length}件のログ（最大500件保持）
              </div>
            )}
          </div>
        </div>
      )}

      {/* ===== Users Tab ===== */}
      {activeTab === 'users' && (
        <div className="space-y-6">
          <div>
            <p className="text-sm text-gray-500 dark:text-gray-400">ログインユーザー・ロール別権限の管理</p>
            <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">※ 役割は人員マスタの職種で決まります（役員→役員（見るだけ）、職長→職長、事務→事務。政仁さんは事業責任者）。変えるときは人員マスタで職種を変更してください。</p>
          </div>

          {/* Summary */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 shadow-sm hover:shadow-md transition-shadow p-4 text-center">
              <div className="text-2xl font-bold text-hibi-navy dark:text-white">{userWorkers.length}</div>
              <div className="text-xs text-gray-500 dark:text-gray-400">ユーザー数</div>
            </div>
            <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 shadow-sm hover:shadow-md transition-shadow p-4 text-center">
              <div className="text-2xl font-bold text-red-600">{userWorkers.filter(w => w.jobType === 'yakuin').length}</div>
              <div className="text-xs text-gray-500 dark:text-gray-400">役員</div>
            </div>
            <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 shadow-sm hover:shadow-md transition-shadow p-4 text-center">
              <div className="text-2xl font-bold text-blue-600">{userWorkers.filter(w => w.jobType === 'shokucho').length}</div>
              <div className="text-xs text-gray-500 dark:text-gray-400">職長</div>
            </div>
            <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 shadow-sm hover:shadow-md transition-shadow p-4 text-center">
              <div className="text-2xl font-bold text-purple-600">{userWorkers.filter(w => w.jobType === 'jimu').length}</div>
              <div className="text-xs text-gray-500 dark:text-gray-400">事務</div>
            </div>
          </div>

          {/* User Table */}
          <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 shadow-sm overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 dark:bg-gray-700 text-left text-gray-600 dark:text-gray-300">
                  <th className="px-4 py-3">名前</th>
                  <th className="px-4 py-3">所属</th>
                  <th className="px-4 py-3">ロール</th>
                  <th className="px-4 py-3">トークン</th>
                  <th className="px-4 py-3">ステータス</th>
                </tr>
              </thead>
              <tbody>
                {usersLoading ? (
                  <tr><td colSpan={5} className="px-4 py-8 text-center text-gray-400">読み込み中...</td></tr>
                ) : userWorkers.length === 0 ? (
                  <tr><td colSpan={5} className="px-4 py-8 text-center text-gray-400">対象ユーザーがいません</td></tr>
                ) : userWorkers.map(w => {
                  // 政仁さん（workerId 1）は職種が役員でも事業責任者（lib/auth.ts buildAuthUser と同じ判定）
                  const badge = w.id === 1 ? { label: '事業責任者', cls: 'bg-orange-100 text-orange-700' } : roleBadge(w.jobType)
                  const hasToken = !!w.token
                  return (
                    <tr key={w.id} className="border-t dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50 even:bg-gray-50/50 dark:even:bg-gray-700/30">
                      <td className="px-4 py-3 font-medium">{w.name}</td>
                      <td className="px-4 py-3">
                        <span className={`text-xs px-2 py-0.5 rounded-full ${w.company === 'HFU' ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'}`}>
                          {w.company}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${badge.cls}`}>
                          {badge.label}
                        </span>
                        <a href="/workers" className="ml-2 text-[10px] text-blue-500 hover:underline">変更</a>
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-500 font-mono">
                        {hasToken ? `${w.token.substring(0, 8)}...` : '—'}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${hasToken ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                          {hasToken ? '有効' : 'トークン未発行'}
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* 役割ごとの権限（lib/permissions.ts を表示するだけ。変えるときはコードを直す） */}
          <PermissionMatrix />
        </div>
      )}

      {/* ===== Announcements Tab ===== */}
      {activeTab === 'announcements' && (
        <div className="max-w-3xl space-y-4">
          {/* 投稿フォーム */}
          <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 shadow-sm p-5">
            <h2 className="text-base font-bold text-hibi-navy dark:text-white mb-3">
              {annEditId ? '✏️ お知らせを編集' : '📝 新しいお知らせを投稿'}
            </h2>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">カテゴリ</label>
                <div className="flex gap-2">
                  {ANN_CATEGORIES.map(c => (
                    <button
                      key={c.value}
                      onClick={() => setAnnForm(f => ({ ...f, category: c.value }))}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                        annForm.category === c.value
                          ? c.cls + ' ring-2 ring-offset-1 ring-hibi-navy'
                          : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                      }`}
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">タイトル</label>
                <input
                  type="text"
                  value={annForm.title}
                  onChange={e => setAnnForm(f => ({ ...f, title: e.target.value }))}
                  placeholder="例: 外注先の現場別単価設定が可能になりました"
                  className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-hibi-navy focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">本文</label>
                <textarea
                  value={annForm.content}
                  onChange={e => setAnnForm(f => ({ ...f, content: e.target.value }))}
                  placeholder="本文を入力（改行対応）"
                  rows={4}
                  className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-hibi-navy focus:outline-none"
                />
              </div>
              <div className="flex gap-2">
                <button
                  onClick={handleSaveAnnouncement}
                  disabled={annSaving || !annForm.title.trim() || !annForm.content.trim()}
                  className="bg-hibi-navy text-white rounded-lg px-4 py-2 text-sm font-bold hover:bg-hibi-light transition disabled:opacity-50"
                >
                  {annSaving ? '保存中...' : annEditId ? '更新する' : '投稿する'}
                </button>
                {annEditId && (
                  <button
                    onClick={handleCancelAnnouncementEdit}
                    className="bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-200 rounded-lg px-4 py-2 text-sm hover:bg-gray-300 dark:hover:bg-gray-500 transition"
                  >
                    キャンセル
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* お知らせ一覧 */}
          <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 shadow-sm p-5">
            <h2 className="text-base font-bold text-hibi-navy dark:text-white mb-3">投稿済み一覧</h2>
            {annLoading ? (
              <div className="text-center py-6 text-gray-400 text-sm">読み込み中...</div>
            ) : announcements.length === 0 ? (
              <div className="text-center py-6 text-gray-400 text-sm">お知らせはありません</div>
            ) : (
              <div className="space-y-3">
                {announcements.map(a => {
                  const cat = ANN_CATEGORIES.find(c => c.value === a.category)
                  const date = new Date(a.publishedAt)
                  const dateStr = `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
                  return (
                    <div key={a.id} className="border border-gray-200 dark:border-gray-700 rounded-lg p-3">
                      <div className="flex items-center gap-2 mb-2">
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${cat?.cls || 'bg-gray-100 text-gray-700'}`}>
                          {cat?.label || a.category}
                        </span>
                        <span className="text-xs text-gray-400">{dateStr} / {a.publishedBy}</span>
                      </div>
                      <h3 className="text-sm font-bold text-gray-800 dark:text-gray-200 mb-1">{a.title}</h3>
                      <p className="text-xs text-gray-600 dark:text-gray-400 whitespace-pre-wrap">{a.content}</p>
                      <div className="flex gap-2 mt-2">
                        <button
                          onClick={() => handleEditAnnouncement(a)}
                          className="text-xs text-hibi-navy dark:text-blue-400 hover:underline"
                        >
                          編集
                        </button>
                        <button
                          onClick={() => handleDeleteAnnouncement(a.id, a.title)}
                          className="text-xs text-red-500 hover:underline"
                        >
                          削除
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
