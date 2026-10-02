'use client'

import { Icon } from '@/components/ui/Icon'
import { Chip, AmountChip, type ChipTone } from '@/components/ui/PageParts'
import StaffConfirmBadge, { type StaffConfirmInfo } from './StaffConfirmBadge'

// 月次集計・締めの「見やすい一覧」と「締めの準備カード」（2026-10-01 代表依頼・見本キャンバス5段目）
//
//   旧: 19列の表（ほとんどが「—」）だけで、締めボタン・締め済みの印・本人確認・自動検算がばらばらの場所にあり、
//       「この会社はもう締めていいか」を一か所で判断できなかった。
//   新: ① 会社ごとのカード（人数・支給額の合計・締める前のチェック3つ・締めるボタン）
//       ② 1人1行。出勤・有給・残業／単価／0円でない内訳だけを札で／支給額を大きく／本人確認
//   全項目の表（Excel と突き合わせる用）は「全項目の表」に切り替えて今までどおり見られる。
//   金額はサーバの計算値をそのまま出す（ここで再計算しない＝出力層の原則）。

/** page.tsx の WorkerMonthly のうち、ここで使う項目だけ */
export interface OverviewWorker {
  id: number
  name: string
  org: string
  visa: string
  rate: number
  hourlyRate?: number
  salary?: number
  sites: string[]
  workDays: number
  workAll: number
  plDays: number
  otHours: number
  useOldRules?: boolean
  basePay?: number
  fixedBasePay?: number
  additionalAllowance?: number
  paidLeaveDays?: number
  paidLeaveAllowance?: number
  nonStatutoryOTHours?: number
  nonStatutoryOTAllowance?: number
  legalOtHours?: number
  otAllowance?: number
  legalHolidayAllowance?: number
  nightHours?: number
  nightAllowance?: number
  compAllowance?: number
  breakShortenAllowance?: number
  siteAllowance?: number
  driveAllowance?: number
  driveLegs?: number
  absentDeduction?: number
  compBaseDeduction?: number
  absence?: number
  salaryNetPay?: number
  isDispatched?: boolean
  dispatchTo?: string
  hkDays?: number
  hkEarlyReturnDays?: number
  legalShortfall?: number
  sundayNoRestDays?: number[]
  calendarBlankDays?: number
  suspectCompRestDays?: number[]
  restMismatchDays?: number[]
}

const yen = (n: number) => `¥${Math.round(n).toLocaleString()}`
const num = (n: number) => (Math.round(n * 10) / 10).toLocaleString()

// ─── 締めの準備カード ───────────────────────────────

/** 締め前の会社の出面の承認状況（app/api/monthly の approvalStatus・判定は lib/month-approval-status.ts） */
export interface ApprovalStatus {
  needed: number
  foremanMissing: number
  finalMissing: number
  complete: boolean
  finalRequired: boolean
  /** どの現場の何日が足りないか（例「職長承認がない日: 笹塚 29日」） */
  detail?: string
  /** 月が終わっていない（当月・先の月）ので数えていない */
  notEnded?: boolean
}

export interface CloseCardProps {
  org: 'hibi' | 'hfu'
  label: string
  ymLabel: string
  people: number
  total: number
  locked: boolean
  /** 出面の承認状況（締め済み・取得できなかったときは null） */
  approval: ApprovalStatus | null
  /** 本人確認の対象者の数と状態ごとの人数（状態はサーバが締めと同じ判定で決める） */
  confirm: { target: number; ok: number; none: number; stale: number; issue: number; waiting: number; outside: number; failed?: boolean }
  /** 自動検算の対象人数と、異常のある人数（null＝検算しない月） */
  audit: { target: number; affected: number } | null
  /** 締めたあとに支給額が変わった人数 */
  changedAfterLock: number
  canClose: boolean
  busy: boolean
  onToggleLock: () => void
  onShowConfirm: () => void
  onShowAudit: () => void
}

export function CloseCard(p: CloseCardProps) {
  const cf = p.confirm
  const confirmLeft = cf.target - cf.ok
  // 確認がまだの人が全員「承認待ち」（スマホにまだ確認が出ていない）なら、警告にせず待ちとして出す
  const onlyWaiting = confirmLeft > 0 && cf.waiting === confirmLeft
  const confirmNote = [
    `${cf.target}名中 ${cf.ok}名が確認済み`,
    cf.none > 0 ? `まだ ${cf.none}名` : '',
    cf.stale > 0 ? `要再確認 ${cf.stale}名` : '',
    cf.issue > 0 ? `連絡あり ${cf.issue}名` : '',
    cf.waiting > 0 ? `承認待ち ${cf.waiting}名` : '',
    cf.outside > 0 ? `期間外 ${cf.outside}名` : '',
  ].filter(Boolean).join('・')
  return (
    <section className="bg-white dark:bg-gray-800 border border-hibi-line dark:border-gray-700 rounded-xl p-5 flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-gray-900 dark:text-white">{p.label}</h2>
          <div className="text-13 text-hibi-sub dark:text-gray-400">{p.people}名</div>
        </div>
        {p.locked
          ? <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-bold bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300"><Icon name="lock" size={13} strokeWidth={2.2} />締め済み</span>
          : <span className="px-2.5 py-1 rounded-md text-xs font-bold bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300">締め前</span>}
      </div>
      <div className="flex items-baseline gap-2">
        <span className="text-13 text-hibi-sub dark:text-gray-400">支給額の合計</span>
        <span className="text-30 leading-none font-bold tabular-nums text-gray-900 dark:text-white">{yen(p.total)}</span>
      </div>

      <div className="rounded-[10px] border border-hibi-line dark:border-gray-700 divide-y divide-hibi-line dark:divide-gray-700">
        <ApprovalCheck locked={p.locked} approval={p.approval} />
        {cf.failed ? (
          // 取得できなかったときは「対象なし」に見せない（2026-10-02 総合点検）。締める API が再確認するので実害は小さいが、安心させない
          <Check state="warn" label="本人確認" note="本人確認の状態を取得できませんでした。再読み込みしてください" />
        ) : cf.target === 0 ? (
          <Check state="none" label="本人確認" note="対象の人がいません（日本人はスマホ確認の対象外）" />
        ) : confirmLeft === 0 ? (
          <Check state="ok" label="本人確認" note={`${cf.target}名 全員が確認済み`} />
        ) : p.locked ? (
          // 締めたあとはスマホに確認を出さない（締めるときに承知のうえで締めた記録が操作ログに残っている）
          <Check state="none" label="本人確認" note={`${cf.target}名中 ${cf.ok}名が確認済みのまま締めました`} action="一覧で見る" onAction={p.onShowConfirm} />
        ) : onlyWaiting ? (
          // スマホに確認が出るのは、その人の出面の承認（職長・最終）がそろってから（2026-10-02 代表指摘）
          <Check state="none" label="本人確認"
            note={`出面の承認がそろうと、${cf.waiting}名のスマホに確認が出ます${cf.ok > 0 ? `（確認済み ${cf.ok}名）` : ''}`}
            action="一覧で見る" onAction={p.onShowConfirm} />
        ) : (
          <Check state="warn" label="本人確認" note={confirmNote} action="一覧で見る" onAction={p.onShowConfirm} />
        )}
        {p.audit ? (
          <Check
            state={p.audit.affected === 0 ? 'ok' : 'warn'}
            label="自動検算"
            note={p.audit.affected === 0
              ? `対象 ${p.audit.target}名に異常なし（日本人・月給・旧ルールの人は計算根拠で目で確認）`
              : `${p.audit.affected}名に要確認があります`}
            action={p.audit.affected > 0 ? '確認する' : undefined}
            onAction={p.onShowAudit}
          />
        ) : (
          <Check state="none" label="自動検算" note="この月は自動検算の対象外です（2026年5月より前）" />
        )}
        {p.locked && p.changedAfterLock > 0 && (
          <Check state="warn" label="締めたあとに支給額が変わった人" note={`${p.changedAfterLock}名（下のお知らせを確認してください）`} />
        )}
      </div>

      {p.locked ? (
        <div className="flex gap-2">
          <span className="flex-1 h-11 rounded-[10px] bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-300 text-sm font-bold flex items-center justify-center gap-1.5">
            <Icon name="check" size={16} strokeWidth={2.6} />{p.ymLabel}は締め済み
          </span>
          {p.canClose && (
            <button onClick={p.onToggleLock} disabled={p.busy}
              className="h-11 px-4 rounded-[10px] text-sm font-bold border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 hover:bg-hibi-bg dark:hover:bg-gray-700 disabled:opacity-50 inline-flex items-center gap-1.5">
              <Icon name="unlock" size={15} />締めを解除
            </button>
          )}
        </div>
      ) : p.canClose ? (
        <button onClick={p.onToggleLock} disabled={p.busy}
          className="h-11 rounded-[10px] bg-hibi-navy hover:bg-hibi-light text-white text-15 font-bold disabled:opacity-50 inline-flex items-center justify-center gap-2">
          <Icon name="lock" size={16} />{p.label} の{p.ymLabel}を締める
        </button>
      ) : (
        <div className="text-xs text-hibi-sub dark:text-gray-400">締めは代表・事業責任者・事務が行います</div>
      )}
    </section>
  )
}

/** 出面の承認（職長・最終）。締めと同じ判定の結果を出す（旧: 締めるまで常に緑だった） */
function ApprovalCheck({ locked, approval }: { locked: boolean; approval: ApprovalStatus | null }) {
  const label = '出面の承認（職長・最終）'
  if (locked) return <Check state="ok" label={label} note="締めたときにそろっていることを確認済み" />
  if (!approval) return <Check state="none" label={label} note="承認の状況を読み込めませんでした（締めるときにもう一度確認します）" />
  if (approval.notEnded) return <Check state="none" label={label} note="月が終わってから数えます（月の途中は締められません）" />
  if (approval.needed === 0) return <Check state="none" label={label} note="この月は出勤の記録がありません" />
  if (approval.complete) {
    return <Check state="ok" label={label} note={approval.finalRequired
      ? `全現場・全日（${approval.needed}件・外国人スタッフは休み・有給の日も）の承認がそろっています`
      : `出勤・残業のある全現場・全日（${approval.needed}件）の職長承認がそろっています`} />
  }
  const parts: string[] = []
  if (approval.foremanMissing > 0) parts.push(`職長承認がまだ ${approval.foremanMissing}件`)
  if (approval.finalMissing > 0) parts.push(`最終承認がまだ ${approval.finalMissing}件`)
  return (
    <Check state="warn" label={label} note={`${parts.join('・')}（現場×日。そろうまで締められません）`}
      detail={approval.detail} />
  )
}

function Check({ state, label, note, detail, action, onAction }: {
  state: 'ok' | 'warn' | 'none'
  label: string
  note: string
  /** note の下に小さく出す補足（改行ごとに1行） */
  detail?: string
  action?: string
  onAction?: () => void
}) {
  return (
    <div className="px-3.5 py-2.5 flex items-center gap-2.5">
      {state === 'ok'
        ? <span className="w-6 h-6 rounded-full bg-green-600 text-white flex items-center justify-center shrink-0"><Icon name="check" size={14} strokeWidth={3} /></span>
        : state === 'warn'
          ? <span className="w-6 h-6 rounded-full bg-amber-50 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300 flex items-center justify-center shrink-0"><Icon name="alert" size={14} strokeWidth={2.4} /></span>
          : <span className="w-6 h-6 rounded-full border-2 border-gray-300 dark:border-gray-600 shrink-0" />}
      <div className="min-w-0">
        <div className="text-sm font-bold text-gray-900 dark:text-gray-100">{label}</div>
        <div className={`text-xs ${state === 'warn' ? 'text-amber-800 dark:text-amber-300' : 'text-hibi-sub dark:text-gray-400'}`}>{note}</div>
        {detail && <div className="mt-0.5 text-xxs text-hibi-sub dark:text-gray-400 whitespace-pre-line">{detail}</div>}
      </div>
      {action && onAction && (
        <button onClick={onAction} className="ml-auto shrink-0 text-13 font-bold text-hibi-navy dark:text-blue-300 inline-flex items-center gap-0.5 hover:underline">
          {action}<Icon name="chevronRight" size={13} />
        </button>
      )}
    </div>
  )
}

// ─── 見やすい一覧 ──────────────────────────────────

/** 0円でない支給・控除の項目だけを札にする（並びは給与明細の順） */
function payChips(w: OverviewWorker, ym: string): { label: string; amount: number; neg?: boolean; note?: string }[] {
  const out: { label: string; amount: number; neg?: boolean; note?: string }[] = []
  const foreign = w.visa !== 'none'
  const base = (w.fixedBasePay || 0) > 0 ? w.fixedBasePay! : (w.basePay || 0)
  if (base > 0) {
    out.push({
      label: (w.salary || 0) > 0 ? '月給' : foreign ? '基本給' : `日給 ${num(w.workAll || w.workDays)}日`,
      amount: base,
    })
  }
  if (foreign && (w.additionalAllowance || 0) > 0) out.push({ label: w.useOldRules ? '休業補償' : '追加所定', amount: w.additionalAllowance! })
  if ((w.paidLeaveAllowance || 0) > 0) out.push({ label: `有給手当${(w.paidLeaveDays || 0) > 0 ? ` ${num(w.paidLeaveDays!)}日` : ''}`, amount: w.paidLeaveAllowance! })
  if (foreign && (w.nonStatutoryOTAllowance || 0) > 0) out.push({ label: `所定外 ${num(w.nonStatutoryOTHours || 0)}h`, amount: w.nonStatutoryOTAllowance! })
  if ((w.otAllowance || 0) > 0) out.push({ label: ym >= '202605' ? `法定外残業${foreign && (w.legalOtHours || 0) > 0 ? ` ${num(w.legalOtHours!)}h` : ''}` : '残業手当', amount: w.otAllowance! })
  if ((w.legalHolidayAllowance || 0) > 0) out.push({ label: '法休手当', amount: w.legalHolidayAllowance! })
  if (foreign && (w.nightAllowance || 0) > 0) out.push({ label: `深夜${(w.nightHours || 0) > 0 ? ` ${num(w.nightHours!)}h` : ''}`, amount: w.nightAllowance! })
  if (foreign && (w.compAllowance || 0) > 0) out.push({ label: '休業手当', amount: w.compAllowance! })
  if ((w.breakShortenAllowance || 0) > 0) out.push({ label: '休憩短縮', amount: w.breakShortenAllowance! })
  if ((w.siteAllowance || 0) > 0) out.push({ label: '日当', amount: w.siteAllowance! })
  if ((w.driveAllowance || 0) > 0) out.push({ label: `運転手当${(w.driveLegs || 0) > 0 ? ` ${w.driveLegs}便` : ''}`, amount: w.driveAllowance! })
  if (foreign && (w.absentDeduction || 0) > 0) out.push({ label: `欠勤控除${w.useOldRules && (w.absence || 0) > 0 ? ` ${num(w.absence!)}日` : ''}`, amount: w.absentDeduction!, neg: true })
  if ((w.compBaseDeduction || 0) > 0) out.push({ label: '補償日控除', amount: w.compBaseDeduction!, neg: true })
  return out
}

/** 名前の横に出す印（旧表の警告と同じ条件。詳しい説明は押して開く計算根拠と全項目の表で） */
function badgesOf(w: OverviewWorker, auditIds: Set<number>): { text: string; tone: ChipTone; title?: string }[] {
  const b: { text: string; tone: ChipTone; title?: string }[] = []
  if (auditIds.has(w.id)) b.push({ text: '検算 要確認', tone: 'red', title: '自動検算で要確認。押して計算根拠を確認してください' })
  if ((w.calendarBlankDays || 0) > 0) b.push({ text: `稼働日未入力 ${w.calendarBlankDays}日`, tone: 'red', title: '空欄のままだと欠勤（100%控除）として計算されます' })
  if ((w.legalShortfall || 0) > 0) b.push({ text: `法定不足 ${yen(w.legalShortfall!)}`, tone: 'red' })
  if ((w.suspectCompRestDays?.length || 0) > 0) b.push({ text: `会社都合の休み？ ${w.suspectCompRestDays!.join('・')}日`, tone: 'amber' })
  if ((w.restMismatchDays?.length || 0) > 0) b.push({ text: `休みの区別？ ${w.restMismatchDays!.join('・')}日`, tone: 'amber' })
  if ((w.sundayNoRestDays?.length || 0) > 0) b.push({ text: `休みなし週の日曜 ${w.sundayNoRestDays!.join('・')}日`, tone: 'amber' })
  if ((w.hkEarlyReturnDays || 0) > 0) b.push({ text: `早期復帰 ${w.hkEarlyReturnDays}日`, tone: 'amber' })
  if ((w.hkDays || 0) > 0) b.push({ text: `帰国中 ${w.hkDays}日`, tone: 'cyan' })
  if (w.isDispatched) b.push({ text: '出向中', tone: 'blue', title: w.dispatchTo ? `出向先: ${w.dispatchTo}` : undefined })
  if (w.useOldRules && w.visa !== 'none') b.push({ text: '旧ルール', tone: 'gray' })
  return b
}

/** 要確認（並べ替え・「要確認だけ」に使う） */
export function needsAttention(w: OverviewWorker, auditIds: Set<number>): boolean {
  return badgesOf(w, auditIds).some(b => b.tone === 'red' || b.tone === 'amber')
}

export function OverviewList({
  workers, ym, auditIds, staffConfirms, password, canResolveConfirm, onConfirmChanged, onOpen, siteNameOf,
}: {
  workers: OverviewWorker[]
  ym: string
  auditIds: Set<number>
  staffConfirms: Record<number, StaffConfirmInfo>
  password: string
  canResolveConfirm: boolean
  onConfirmChanged: () => void
  onOpen: (id: number) => void
  siteNameOf: (siteId: string) => string
}) {
  const cols = 'lg:grid-cols-[230px_200px_120px_minmax(0,1fr)_130px_96px]'
  const total = workers.reduce((s, w) => s + (w.salaryNetPay || 0), 0)
  const workAll = workers.reduce((s, w) => s + (w.workAll || w.workDays), 0)
  const ot = workers.reduce((s, w) => s + (w.otHours || 0), 0)
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-hibi-line dark:border-gray-700 overflow-hidden">
      <div className={`hidden lg:grid ${cols} gap-3.5 px-5 py-2.5 bg-hibi-thead dark:bg-gray-700 text-xs font-bold text-hibi-sub dark:text-gray-300`}>
        <span>名前</span><span>出勤・有給・残業</span><span>単価</span><span>内訳（0円の項目は出さない）</span><span className="text-right">支給額</span><span>本人確認</span>
      </div>
      {workers.length === 0 ? (
        <div className="px-5 py-10 text-center text-gray-400">該当する人がいません</div>
      ) : workers.map(w => {
        const badges = badgesOf(w, auditIds)
        const chips = payChips(w, ym)
        const attention = badges.some(b => b.tone === 'red')
        const rateText = (w.salary || 0) > 0 ? `月給 ${yen(w.salary!)}` : (w.hourlyRate || 0) > 0 ? `時給 ${yen(w.hourlyRate!)}` : (w.rate || 0) > 0 ? `日給 ${yen(w.rate)}` : '—'
        const conf = staffConfirms[w.id]
        return (
          <div key={w.id} role="button" tabIndex={0}
            onClick={() => onOpen(w.id)}
            onKeyDown={e => { if (e.key === 'Enter') onOpen(w.id) }}
            className={`grid grid-cols-1 ${cols} gap-2 lg:gap-3.5 items-center px-5 py-3 border-t border-hibi-line dark:border-gray-700 first-of-type:border-t-0 cursor-pointer transition ${
              attention ? 'bg-amber-50/40 dark:bg-amber-900/10 hover:bg-amber-50 dark:hover:bg-amber-900/20' : 'hover:bg-gray-50 dark:hover:bg-gray-700/40'
            }`}>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-15 font-bold text-gray-900 dark:text-gray-100">{w.name}</span>
                {badges.map((b, i) => (
                  <Chip key={i} tone={b.tone} title={b.title}>{b.text}</Chip>
                ))}
              </div>
              <div className="text-xs text-hibi-sub dark:text-gray-400 truncate">
                {w.org === 'hfu' ? 'HFU' : '日比'}{w.sites.length > 0 && `・${w.sites.map(siteNameOf).join('・')}`}
              </div>
            </div>
            <div className="flex gap-3 tabular-nums text-xs text-hibi-sub dark:text-gray-400 whitespace-nowrap">
              <span>出勤 <b className="text-base text-gray-900 dark:text-white">{num(w.workAll || w.workDays)}</b></span>
              <span>有給 <b className="text-base text-gray-900 dark:text-white">{num(w.plDays)}</b></span>
              <span>残業 <b className="text-base text-gray-900 dark:text-white">{num(w.otHours)}</b></span>
            </div>
            <div className="text-13 text-gray-700 dark:text-gray-300 tabular-nums">{rateText}</div>
            <div className="flex flex-wrap gap-1.5 min-w-0">
              {chips.length === 0
                ? <span className="text-xs text-gray-400">支給なし</span>
                : chips.map((c, i) => (
                  <AmountChip key={i} label={c.label} amount={Math.round(c.amount).toLocaleString()} neg={c.neg} />
                ))}
              {w.isDispatched && <span className="text-xs text-hibi-navy dark:text-blue-300 whitespace-nowrap">出向先が支給（原価から控除）</span>}
            </div>
            <div className="lg:text-right text-lg font-bold tabular-nums text-gray-900 dark:text-white">{(w.salaryNetPay || 0) > 0 ? yen(w.salaryNetPay!) : '—'}</div>
            <div onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
              {/* 対象者と状態はサーバが決める（締めと同じ）。対象外＝日本人・その月に記録が無い人など */}
              {conf
                ? <StaffConfirmBadge info={conf} workerId={w.id} workerName={w.name} ym={ym} password={password} canResolve={canResolveConfirm} onChanged={onConfirmChanged} />
                : <span className="text-xs text-gray-400">対象外</span>}
            </div>
          </div>
        )
      })}
      {workers.length > 0 && (
        <div className="px-5 py-3 border-t border-hibi-line dark:border-gray-700 flex flex-wrap gap-x-5 gap-y-1 items-baseline text-13 text-hibi-sub dark:text-gray-400">
          <span>{workers.length}名</span>
          <span>出勤延べ {num(workAll)}人日</span>
          <span>残業 {num(ot)}h</span>
          <span className="ml-auto">支給額の合計 <b className="text-lg text-gray-900 dark:text-white tabular-nums">{yen(total)}</b></span>
        </div>
      )}
    </div>
  )
}
