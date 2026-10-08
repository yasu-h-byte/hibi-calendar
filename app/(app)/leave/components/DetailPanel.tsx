'use client'

import { PLWorker } from '../types'
import WorkerAvatar from '@/components/WorkerAvatar'
import { Icon } from '@/components/ui/Icon'
import { SidePanel, CloseButton } from '@/components/ui/PageParts'
import { addMonthsSafe, addDaysIso } from '@/lib/date-utils'

// 一人の有給の詳細（2026-10-01 休暇管理の改善・代表依頼）。一覧の行を押すと右から開く。
//   見るだけの画面。直す・時季指定・買取はここから既存のモーダルを開く（操作の中身は変えない）。
//   旧: 行を押すといきなり編集モーダルで、「今どうなっているか」を読む場所が無かった。

const slash = (iso?: string) => iso ? `${Number(iso.slice(0, 4))}/${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}` : ''
const VISA_LABEL: Record<string, string> = {
  jisshu1: '実習1号', jisshu2: '実習2号', jisshu3: '実習3号',
  tokutei1: '特定1号', tokutei2: '特定2号', tokutei3: '特定3号',
}

interface Props {
  worker: PLWorker
  photo?: string
  onClose: () => void
  onEdit: (w: PLWorker) => void
  onDesignate: (w: PLWorker) => void
  onBuyout: (w: PLWorker) => void
}

export default function DetailPanel({ worker: w, photo, onClose, onEdit, onDesignate, onBuyout }: Props) {
  const jp = !w.visa || w.visa === 'none'
  const end = w.grantDate ? addDaysIso(addMonthsSafe(w.grantDate, 12), -1) : ''
  const taken = w.periodUsed ?? 0

  // 今の期間（付与日〜1年）の月を順に並べる。monthlyUsage は YYYYMM → 日数
  const months: { ym: string; label: string; days: number; future: boolean }[] = []
  if (w.grantDate) {
    const today = new Date()
    const nowYm = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}`
    for (let i = 0; i < 12; i++) {
      const d = addMonthsSafe(w.grantDate.slice(0, 8) + '01', i)
      const ym = d.slice(0, 4) + d.slice(5, 7)
      months.push({ ym, label: `${Number(d.slice(5, 7))}月`, days: w.monthlyUsage?.[ym] ?? 0, future: ym > nowYm })
    }
  }

  const records: { at: string; text: string }[] = []
  if (w.grantDate) records.push({ at: w.grantDate, text: `今期の付与 ${w.grantDays}日${w.method === 'manual' ? '（手作業）' : ''}` })
  if ((w.carryOver ?? 0) > 0 && w.grantDate) records.push({ at: w.grantDate, text: `前の期から繰越 ${w.carryOver}日${w.carryOverExpiryDate ? `（${slash(w.carryOverExpiryDate)} まで）` : ''}` })
  for (const d of w.designatedLeaves ?? []) records.push({ at: d.designatedAt?.slice(0, 10) || d.date, text: `${slash(d.date)} を${d.kind === 'manual-entry' ? '有給として直接入力' : '時季指定'}${d.note ? `（${d.note}）` : ''}` })
  for (const b of w.buyoutHistory ?? []) records.push({ at: b.at?.slice(0, 10) || '', text: b.reason === 'monthly-settle'
    ? `${b.days}日を有給精算（${String((b as { ym?: string }).ym || '').replace(/^(\d{4})(\d{2})$/, '$1年$2月')}分の給与に回した）`
    : `${b.days}日を買取${b.amount ? `（${b.amount.toLocaleString()}円）` : ''}${b.reason ? `・${b.reason}` : ''}` })
  for (const h of w.adjustmentHistory ?? []) records.push({ at: h.at?.slice(0, 10) || '', text: `${h.field === 'grantDays' ? '付与日数' : h.field === 'adjustment' ? '調整' : h.field === 'carryOver' ? '繰越' : h.field} を ${h.before || '—'} → ${h.after} に変更` })
  records.sort((a, b) => b.at.localeCompare(a.at))

  return (
    <SidePanel label={`${w.name} の有給`} onClose={onClose}>
        <div className="p-6 space-y-6">
          {/* 見出し */}
          <div className="flex items-start gap-3">
            <WorkerAvatar name={w.name} src={photo} size={48} />
            <div className="flex-1 min-w-0">
              <h2 className="text-[1.375rem] font-bold text-gray-900 dark:text-white truncate">{w.name}</h2>
              <div className="text-[0.8125rem] text-hibi-sub dark:text-gray-400">
                {w.org === 'hfu' ? 'HFU' : '日比建設'}　{jp ? '日本人' : (VISA_LABEL[w.visa] || w.visa)}
                {w.hireDate && <>　入社 {slash(w.hireDate)}</>}
              </div>
              <div className="text-[0.8125rem] text-hibi-sub dark:text-gray-400 tabular-nums">
                今の期間 {w.grantDate ? `${slash(w.grantDate)}〜${slash(end)}` : '付与日が未設定'}
              </div>
            </div>
            <CloseButton onClick={onClose} />
          </div>

          <div className="flex flex-wrap gap-2">
            <ActionBtn onClick={() => onEdit(w)} icon="pen">付与・調整を直す</ActionBtn>
            <ActionBtn onClick={() => onDesignate(w)} icon="calendar">時季指定</ActionBtn>
            <ActionBtn onClick={() => onBuyout(w)} icon="yen">買取を記録</ActionBtn>
          </div>

          {/* 数字3つ */}
          <div className="grid grid-cols-3 gap-3">
            <Stat label="使える日" value={w.remaining} />
            <Stat label="この期間に取った" value={taken} />
            {w.grantDays >= 10 ? (
              taken >= 5
                ? <div className="rounded-xl bg-green-50 dark:bg-green-900/30 p-4"><div className="text-[0.8125rem] font-bold text-green-700 dark:text-green-300">年5日の取得義務</div><div className="mt-1 text-lg font-bold text-green-700 dark:text-green-300 flex items-center gap-1"><Icon name="check" size={18} strokeWidth={2.6} />達成</div></div>
                : <div className={`rounded-xl p-4 ${(w.fiveDayShortfall ?? 0) > 0 ? 'bg-amber-50 dark:bg-amber-900/30' : 'bg-hibi-bg dark:bg-gray-700/50'}`}><div className={`text-[0.8125rem] font-bold ${(w.fiveDayShortfall ?? 0) > 0 ? 'text-amber-800 dark:text-amber-300' : 'text-hibi-sub dark:text-gray-400'}`}>年5日の取得義務</div><div className="mt-1 text-lg font-bold text-gray-900 dark:text-white">{taken} / 5日</div><div className="text-xs text-hibi-sub dark:text-gray-400">期限 {slash(end)}</div></div>
            ) : <Stat label="年5日の取得義務" value={null} note="付与10日未満は対象外" />}
          </div>

          {/* 内訳 */}
          <section className="space-y-2">
            <h3 className="text-base font-bold text-gray-900 dark:text-white">使える日の内訳（上から先に使われます）</h3>
            <div className="rounded-xl border border-hibi-line dark:border-gray-700 overflow-hidden divide-y divide-hibi-line dark:divide-gray-700 text-sm">
              {(w.carryOver ?? 0) > 0 && (
                <BucketRow
                  label="前の期からの繰越" got={w.carryOver} rem={w.carryOverRemaining ?? 0}
                  note={w.carryOverExpiryDate ? `${slash(w.carryOverExpiryDate)} に消える` : ''}
                  warn={w.carryOverExpiryStatus !== 'ok' && (w.carryOverRemaining ?? 0) > 0}
                />
              )}
              <BucketRow
                label="今期の付与" got={w.grantDays} rem={w.grantRemaining ?? w.remaining}
                note={jp ? `${slash(end)} まで（残りは賞与で買取）` : (w.expiryDate ? `${slash(w.expiryDate)} まで使える` : '')}
                warn={w.expiryStatus !== 'ok'}
              />
              {w.adjustment > 0 && <div className="px-4 py-2.5 text-xs text-hibi-sub dark:text-gray-400">調整 {w.adjustment}日（移行・手作業で引いた分）</div>}
            </div>
            {jp && w.prevPeriod && (w.prevPeriod.remaining > 0 || w.prevPeriod.buyoutDays > 0) && (
              <div className={`rounded-xl border border-dashed px-4 py-3 text-sm ${w.prevPeriod.remaining > 0 ? 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-200' : 'border-gray-300 bg-gray-50 text-gray-600 dark:border-gray-600 dark:bg-gray-700/40 dark:text-gray-300'}`}>
                <div className="font-bold">前の期（{slash(w.prevPeriod.grantDate)}〜{slash(w.prevPeriod.endDate)}）の残り {w.prevPeriod.remaining > 0 ? `${w.prevPeriod.remaining}日 → 賞与で買取予定` : `→ ${w.prevPeriod.buyoutDays}日を賞与で買取済み`}</div>
                <div className="text-xs mt-0.5 opacity-80">もらった {w.prevPeriod.grantDays}日・取った {w.prevPeriod.taken}日{w.prevPeriod.buyoutDays > 0 ? `・買取 ${w.prevPeriod.buyoutDays}日` : ''}。休みには使えません</div>
              </div>
            )}
          </section>

          {/* 月ごと */}
          {months.length > 0 && (
            <section className="space-y-2">
              <h3 className="text-base font-bold text-gray-900 dark:text-white">取った日（月ごと）</h3>
              <div className="grid grid-cols-6 sm:grid-cols-12 gap-1.5">
                {months.map(m => (
                  <div key={m.ym} className={`rounded-lg border border-hibi-line dark:border-gray-700 py-1.5 flex flex-col items-center ${m.future ? 'bg-hibi-bg dark:bg-gray-700/40' : 'bg-white dark:bg-gray-800'}`}>
                    <span className="text-2xs text-hibi-sub dark:text-gray-400">{m.label}</span>
                    <span className={`text-base font-bold tabular-nums ${m.days > 0 ? 'text-hibi-navy dark:text-blue-300' : 'text-gray-300 dark:text-gray-600'}`}>{m.days > 0 ? m.days : '—'}</span>
                  </div>
                ))}
              </div>
              <div className="text-xs text-hibi-sub dark:text-gray-400">先の月の数字は、承認済みの予定です</div>
            </section>
          )}

          {/* 記録 */}
          {records.length > 0 && (
            <section className="space-y-2">
              <h3 className="text-base font-bold text-gray-900 dark:text-white">記録</h3>
              <ul className="text-[0.8125rem] text-gray-700 dark:text-gray-300 space-y-1">
                {records.slice(0, 12).map((r, i) => (
                  <li key={i} className="flex gap-3"><span className="text-hibi-sub dark:text-gray-400 tabular-nums w-[84px] shrink-0">{slash(r.at)}</span><span>{r.text}</span></li>
                ))}
              </ul>
            </section>
          )}
        </div>
    </SidePanel>
  )
}

function ActionBtn({ onClick, icon, children }: { onClick: () => void; icon: 'pen' | 'calendar' | 'yen'; children: React.ReactNode }) {
  return (
    <button onClick={onClick}
      className="inline-flex items-center gap-1.5 h-9 px-3 rounded-[10px] text-[0.8125rem] font-bold border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-hibi-navy dark:text-gray-200 hover:bg-hibi-bg dark:hover:bg-gray-700 transition">
      <Icon name={icon} size={15} />{children}
    </button>
  )
}

function Stat({ label, value, note }: { label: string; value: number | null; note?: string }) {
  return (
    <div className="rounded-xl bg-hibi-bg dark:bg-gray-700/50 p-4">
      <div className="text-[0.8125rem] text-hibi-sub dark:text-gray-400">{label}</div>
      {value !== null
        ? <div className="mt-1 text-[2rem] leading-none font-bold text-gray-900 dark:text-white tabular-nums">{value}<span className="text-sm font-normal text-hibi-sub dark:text-gray-400"> 日</span></div>
        : <div className="mt-1 text-xs text-hibi-sub dark:text-gray-400">{note}</div>}
    </div>
  )
}

function BucketRow({ label, got, rem, note, warn }: { label: string; got: number; rem: number; note: string; warn?: boolean }) {
  return (
    <div className={`grid grid-cols-[1fr_88px_88px_minmax(0,1.3fr)] items-center gap-2 px-4 py-2.5 ${warn ? 'bg-amber-50 dark:bg-amber-900/20' : ''}`}>
      <span className="font-bold text-gray-900 dark:text-gray-100">{label}</span>
      <span className="text-xs text-hibi-sub dark:text-gray-400">もらった {got}日</span>
      <span className="font-bold text-gray-900 dark:text-white">残り {rem}日</span>
      <span className={`text-xs ${warn ? 'font-bold text-amber-800 dark:text-amber-300' : 'text-hibi-sub dark:text-gray-400'}`}>{note}</span>
    </div>
  )
}
