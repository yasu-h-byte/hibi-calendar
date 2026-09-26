import { NextRequest, NextResponse } from 'next/server'
import { isSiteStartedByMonth } from '@/lib/site-hierarchy'
import { checkApiAuth, getApiAuthUser } from '@/lib/auth'
import { resolveApiRoleFromMain } from '@/lib/attendance-authz'
import { mergeAnnouncements } from '@/lib/release-notes'
import { permRoleOf } from '@/lib/permissions'
import { db } from '@/lib/firebase'
import { collection, query, where, getDocs } from '@/lib/fsdb'
import { getMainData, getAttData, parseDKey, getAssign } from '@/lib/compute'
import { ymKey } from '@/lib/attendance'
import { getUpcomingGrants } from '@/lib/leave-auto'
import { todayJstIso, addMonthsSafe } from '@/lib/date-utils'
import { isAlreadyRetired, isCalendarSignTarget } from '@/lib/workers'
import { calcLegalCarryOver, selectActiveGrantRecord } from '@/lib/leave-compute'
import { getAllActiveHomeLeaves, isFullMonthHomeLeave } from '@/lib/homeLeave'
import { getWorkerLastAccessMap } from '@/lib/accessLog'

interface Notification {
  id: string
  icon: string
  message: string
  type: 'warning' | 'error' | 'info'
  count?: number
  messengerText?: string
  action?: {
    type: string
    workerId: number
    grantDate: string
    grantDays: number
    carryOver: number
    label: string
  }
}

export async function GET(request: NextRequest) {
  if (!await checkApiAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    // JST基準の現在（2026-08-27: Vercel は UTC のため、JST 0〜9時に「前月扱い/日付が9時間遅れ」で
    //   25日締切系の通知がズレていた）
    const nowJstIso = todayJstIso()
    const now = new Date(nowJstIso + 'T00:00:00')
    const currentYm = nowJstIso.slice(0, 7).replace('-', '')
    const today = Number(nowJstIso.slice(8, 10))
    const notifications: Notification[] = []

    const main = await getMainData()
    // 2026-09-26: 役割と本人はサーバーで決める（旧: 画面が ?role=&workerId= を自己申告しており、
    //   職長が role=admin を送れば管理者向けの通知が見えた）。main はキャッシュ済みのものを使い読み取りを増やさない
    const apiRole = resolveApiRoleFromMain(await getApiAuthUser(request), main, currentYm)
    const role = !apiRole ? 'none' : apiRole.role === 'super-admin' ? 'admin' : apiRole.role
    const requesterWorkerId = apiRole?.workerId ?? null
    const myForemanSites = apiRole?.role === 'foreman' ? apiRole.foremanSites : []
    /** 職長の担当現場（今月の配置）にいる人か。職長ベルの「職長承認待ち」を自分の現場に絞るため */
    const myForemanWorkers = new Set(myForemanSites.flatMap(sid => getAssign(main, sid, currentYm).workers))
    // 2026-08-27 修正（有給総点検・第3回）: 「退職日が入っているだけ」で全通知から
    //   即日消えていた（例: 12/31退職予定を登録した瞬間に有給残・付与予定・未署名等の
    //   通知が全部止まる）。dashboard/ledger と同じく「今日時点で退職済み」のみ除外
    const activeWorkers = main.workers.filter(w => !isAlreadyRetired(w.retired, todayJstIso()))

    // 1. 就業カレンダー未署名（今月＋翌月）。2026-09-26: 就業カレンダー画面と同じ集計に一本化
    //   （lib/calendar-matrix.ts projectSignSites ＋ lib/calendar-sign-status.ts summarizeSignStatus）。
    //   旧: ベルだけ「その現場の配置者」しか数えず、全員×全現場モデルの署名漏れ（新しい現場の分など）が抜けて
    //   画面 8名・ベル 1名 と食い違った。loadCalendarMatrix は20秒キャッシュ（読み取りを増やさない）
    try {
      const { loadCalendarMatrix, projectSignSites } = await import('@/lib/calendar-matrix')
      const { summarizeSignStatus, buildSignRequestMessage } = await import('@/lib/calendar-sign-status')
      let nextY = now.getFullYear()
      let nextM = now.getMonth() + 2
      if (nextM > 12) { nextM = 1; nextY++ }
      const nextYm = ymKey(nextY, nextM)
      const calYmOf = (ym: string) => `${ym.slice(0, 4)}-${ym.slice(4, 6)}`
      const monthLabel = (ym: string) => `${parseInt(ym.slice(4, 6))}月`

      const perMonth: { ym: string; unsigned: { id: number; name: string }[] }[] = []
      for (const ym of [currentYm, nextYm]) {
        const summary = summarizeSignStatus(projectSignSites(await loadCalendarMatrix(calYmOf(ym))))
        perMonth.push({ ym, unsigned: summary.unsigned })
      }
      const withUnsigned = perMonth.filter(p => p.unsigned.length > 0)
      if (withUnsigned.length > 0) {
        // 通知文は月ごとの人数（画面は月を選んで見るので、月ごとに数字が一致する）
        const detail = withUnsigned.map(p => `${monthLabel(p.ym)} ${p.unsigned.length}名`).join('・')
        const count = Math.max(...withUnsigned.map(p => p.unsigned.length))
        // Messenger 用の文面は翌月を優先
        const target = withUnsigned.find(p => p.ym === nextYm) || withUnsigned[0]
        const targetYm = target.ym
        notifications.push({
          id: 'unsigned-calendar',
          icon: '\uD83D\uDCC5',
          message: `就業カレンダー未署名: ${detail}`,
          type: 'warning',
          count,
          messengerText: buildSignRequestMessage(Number(targetYm.slice(0, 4)), Number(targetYm.slice(4, 6)), target.unsigned.map(w => w.name)),
        })
      }
    } catch (e) {
      console.error('Calendar sign check error:', e)
    }

    // 出面データ（有給P消化の集計用）。ブロック2の残数計算とブロック6の繰越計算で共用する。
    // ⚠️ 読み取り回数を増やさないこと（クォータ障害歴あり）。従来ブロック6が読んでいた
    //   範囲をそのまま巻き上げただけで、読む月数は変えていない。
    // 2026-09-02 高速化: 旧は「一昨年1月〜今年12月」の36ヶ月を**逐次**で読んでいた（1件 200〜300KB、
    //   ベルは5分ごとにポーリング）。付与期間は最長でも前々期まで＝24ヶ月前で足り、承認済みの
    //   未来の有給（翌年のテト帰国など）は12ヶ月先まで見れば十分。並列で読み、前月より前の
    //   確定済み月は5分キャッシュ（getAttDataCached）を使う。
    const allAttForPL: Record<string, Record<string, unknown>> = {}
    {
      const { getAttDataCached, isClosedMonthYm } = await import('@/lib/compute')
      const yms: string[] = []
      for (let i = -24; i <= 12; i++) {
        const d = new Date(now.getFullYear(), now.getMonth() + i, 1)
        yms.push(ymKey(d.getFullYear(), d.getMonth() + 1))
      }
      const atts = await Promise.all(yms.map(m =>
        (isClosedMonthYm(m) ? getAttDataCached(m) : getAttData(m)).catch(() => ({ d: {} as Record<string, unknown> }))))
      for (const a of atts) Object.assign(allAttForPL, a.d)
    }

    // 2. PL remaining <= 3 days
    // ⚠️ 2026-08-17 全面修正（有給総点検・第2回）。旧実装は3重に間違っていた:
    //   ① fy を日本人の年度式（10/1起点）で選んでいた → 外国人は自分の付与サイクルなので
    //      期間の切り替わり付近で古い/未来のレコードを掴む
    //   ② total に adjustment を「足して」いた → adjustment は消化側のフィールド。
    //      例: 梶原(付与12・調整11) が「残23日」扱いになり、実残0なのにアラートが出なかった
    //   ③ used をレコードの used フィールドから読んでいた → 消化は出面のPから動的計算する
    //      設計（used はほぼ常に0）なので、残数が常に満額に見えていた
    //   正: selectActiveGrantRecord で今日有効なレコードを選び、
    //       残 = (付与+繰越) − (調整+買取+期間内のP日数)。getLeaveBalance と同じ式。
    try {
      const todayIsoPl = todayJstIso()
      const lowPLWorkers: string[] = []

      for (const w of activeWorkers) {
        const records = (main.plData[String(w.id)] || []) as ({ grantDate?: string; grantDays?: number; grant?: number; carryOver?: number; carry?: number; adjustment?: number; adj?: number; buyoutDays?: number; _archived?: boolean })[]
        if (records.length === 0) continue

        const rec = selectActiveGrantRecord(records, todayIsoPl)
        if (!rec || !rec.grantDate) continue

        const total = (rec.grantDays ?? rec.grant ?? 0) + (rec.carryOver ?? rec.carry ?? 0)
        if (total <= 0) continue

        // 期間 [grantDate, +1年) 内の P 日数（同日複数現場は1日）
        const start = rec.grantDate
        const end = addMonthsSafe(start, 12)  // 2/29 付与にも安全（旧: 文字列+1年）
        const seen = new Set<string>()
        for (const [key, entry] of Object.entries(allAttForPL)) {
          const e = entry as { p?: number }
          if (!e?.p) continue
          const pk = parseDKey(key)
          if (parseInt(pk.wid) !== w.id) continue
          const iso = `${pk.ym.slice(0, 4)}-${pk.ym.slice(4, 6)}-${String(pk.day).padStart(2, '0')}`
          if (iso >= start && iso < end) seen.add(iso)
        }
        // adjustment は「新フィールド優先」（normalizePLRecord と統一。旧 Math.max は
        //   負の調整＝日数を足す調整を 0 に丸め、残3日誤警報の原因だった 2026-08-27）
        const used = (rec.adjustment ?? rec.adj ?? 0) + (rec.buyoutDays ?? 0) + seen.size
        const remaining = total - used

        if (remaining <= 3) {
          lowPLWorkers.push(`${w.name}(残${Math.max(0, remaining)})`)
        }
      }

      if (lowPLWorkers.length > 0) {
        notifications.push({
          id: 'low-pl',
          icon: '\uD83C\uDF34',
          message: `有給残3日以下: ${lowPLWorkers.slice(0, 3).join('、')}${lowPLWorkers.length > 3 ? ` 他${lowPLWorkers.length - 3}名` : ''}`,
          type: 'warning',
          count: lowPLWorkers.length,
        })
      }
    } catch (e) {
      console.error('PL check error:', e)
    }

    // 3. Monthly lock status（前月が未締めの場合のみ警告。組織別にチェック）
    try {
      const prevDate = new Date(now.getFullYear(), now.getMonth() - 1, 1)
      const prevYm = ymKey(prevDate.getFullYear(), prevDate.getMonth() + 1)
      const y = prevDate.getFullYear()
      const m = prevDate.getMonth() + 1

      // 後方互換: 旧形式 locks[prevYm] があれば全組織ロック済み
      const legacyLocked = !!main.locks[prevYm]

      const isHibiLocked = !!(main.locks[`${prevYm}_hibi`]) || legacyLocked
      const isHfuLocked = !!(main.locks[`${prevYm}_hfu`]) || legacyLocked

      if (!isHibiLocked) {
        notifications.push({
          id: 'month-unlocked-hibi',
          icon: '🔓',
          message: `月締め未完了: ${y}年${m}月の日比建設がまだ締められていません`,
          type: 'warning',
        })
      }
      if (!isHfuLocked) {
        notifications.push({
          id: 'month-unlocked-hfu',
          icon: '🔓',
          message: `月締め未完了: ${y}年${m}月のHFUがまだ締められていません`,
          type: 'warning',
        })
      }
    } catch (e) {
      console.error('Lock check error:', e)
    }

// 5. Evaluation due notifications
    // 評価済みの人のみアラート（未評価の人にはアラートを出さない）
    // 前回の評価（承認済み）から1年経過した人のみ対象
    try {
      const foreignWorkers = activeWorkers.filter(w => w.visa && w.visa !== 'none')
      // evaluationsコレクションから承認済み評価を取得
      const evalQuery = query(collection(db, 'evaluations'), where('status', '==', 'approved'))
      const evalSnaps = await getDocs(evalQuery)
      const approvedEvals: Record<number, string> = {} // workerId → 最新の evaluationDate
      evalSnaps.forEach(snap => {
        const data = snap.data()
        const wid = data.workerId as number
        const evalDate = data.evaluationDate as string
        if (!approvedEvals[wid] || evalDate > approvedEvals[wid]) {
          approvedEvals[wid] = evalDate
        }
      })

      for (const w of foreignWorkers) {
        // システムで評価済みの人のみ対象
        const lastEvalDate = approvedEvals[w.id]
        if (!lastEvalDate) continue // 未評価 → アラートなし

        // 最新評価日から1年後が次回評価日
        const lastEval = new Date(lastEvalDate)
        const nextEvalDate = new Date(lastEval)
        nextEvalDate.setFullYear(nextEvalDate.getFullYear() + 1)

        const daysUntilEval = Math.floor((nextEvalDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000))

        if (daysUntilEval <= 30 && daysUntilEval >= -30) {
          const isOverdue = daysUntilEval < 0
          notifications.push({
            id: `evaluation-due-${w.id}`,
            icon: isOverdue ? '🔴' : '📋',
            message: isOverdue
              ? `${w.name}の評価が${Math.abs(daysUntilEval)}日超過しています`
              : `${w.name}の評価時期が${daysUntilEval}日後に到来します`,
            type: isOverdue ? 'error' : 'info',
          })
        }
      }
    } catch (e) {
      console.error('Evaluation notification error:', e)
    }

    // 5b. Evaluation session task notifications
    //   (a) status='collecting' で自分が evaluatorIds に含まれ、まだ submit してないもの
    //       → 「あなたが評価入力する番です」（職長・政仁・靖仁 各自向け）
    //   (b) status='reviewing' のセッション
    //       → 「最終承認待ち」（admin/approver のみ）
    //   (c) status='collecting' で開始から7日以上経過し、未提出者がいる
    //       → admin/approver にエスカレーション通知（停滞リマインダー）
    try {
      const sessQuery = query(
        collection(db, 'evaluations'),
        where('status', 'in', ['collecting', 'reviewing']),
      )
      const sessSnaps = await getDocs(sessQuery)
      // 評価者ID→名前 の参照マップ（停滞リマインダー用）
      const workerNameById = new Map<number, string>()
      for (const w of main.workers) {
        if (w.name) workerNameById.set(w.id, w.name)
      }
      // 靖仁さんは workers にいないので明示
      if (!workerNameById.has(0)) workerNameById.set(0, '日比靖仁')
      sessSnaps.forEach(snap => {
        const data = snap.data()
        const status = data.status as 'collecting' | 'reviewing'
        const workerName = (data.workerName as string) || '対象者不明'
        const evaluatorIds = (data.evaluatorIds || []) as number[]
        const reviews = (data.reviews || []) as { evaluatorId: number }[]
        const createdAt = data.createdAt as string | undefined
        const submittedSet = new Set(reviews.map(r => r.evaluatorId))
        const totalCount = evaluatorIds.length
        const submittedCount = evaluatorIds.filter(id => submittedSet.has(id)).length

        // セッション開始からの経過日数
        const ageDays = createdAt
          ? Math.floor((now.getTime() - new Date(createdAt).getTime()) / (24 * 60 * 60 * 1000))
          : 0

        if (status === 'collecting') {
          // 自分が評価予定者で、まだ提出していない場合
          if (requesterWorkerId !== null && evaluatorIds.includes(requesterWorkerId) && !submittedSet.has(requesterWorkerId)) {
            const stale = ageDays >= 7
            notifications.push({
              id: `evaluation-todo-${snap.id}`,
              icon: stale ? '⚠️' : '📝',
              message: stale
                ? `${workerName} の評価入力が${ageDays}日経過しています（提出 ${submittedCount}/${totalCount}名）`
                : `${workerName} の評価入力をお願いします（提出 ${submittedCount}/${totalCount}名）`,
              type: stale ? 'warning' : 'info',
            })
          }

          // 停滞リマインダー: 開始から7日以上経過 → admin/approver にエスカレーション
          if (ageDays >= 7 && (role === 'admin' || role === 'approver')) {
            const pendingNames = evaluatorIds
              .filter(id => !submittedSet.has(id))
              .map(id => workerNameById.get(id) || `ID:${id}`)
              .slice(0, 3)
              .join('、')
            const remaining = totalCount - submittedCount
            notifications.push({
              id: `evaluation-stale-${snap.id}`,
              icon: '⏰',
              message: `${workerName} の評価が${ageDays}日停滞中（残${remaining}名未提出${pendingNames ? `: ${pendingNames}` : ''}）`,
              type: 'warning',
            })
          }
        } else if (status === 'reviewing') {
          // 全員提出済 → admin/approver に最終承認待ち通知
          notifications.push({
            id: `evaluation-pending-approval-${snap.id}`,
            icon: '⚖️',
            message: `${workerName} の評価が最終承認待ちです（${submittedCount}/${totalCount}名提出済）`,
            type: 'warning',
          })
        }
      })
    } catch (e) {
      console.error('Evaluation session notification error:', e)
    }

    // 6. Upcoming / overdue PL grant dates (30 days ahead, 30 days past)
    try {
      const upcoming = getUpcomingGrants(main, 30)

      for (const u of upcoming) {
        const m = u.grantDate.getMonth() + 1
        const d = u.grantDate.getDate()
        const y = u.grantDate.getFullYear()
        const isPast = u.grantDate <= now
        const dateStr = `${y}/${m}/${d}`

        // 前回レコードから正しい繰越を計算（出面のPを含む）
        const wRecords = (main.plData[String(u.workerId)] || []) as { grantDate?: string; grantDays?: number; grant?: number; carryOver?: number; carry?: number; adjustment?: number; adj?: number; used?: number; fy?: string | number }[]
        const recordsWithGrant = wRecords.filter(r =>
          !(r as { _archived?: boolean })._archived &&  // 時効処理済みは前期候補から除外
          ((r.grantDays && r.grantDays > 0) || (r.grant && r.grant > 0)))
        // 前期レコード = grantDate が最も新しいもの。
        // 2026-08-27 修正（有給総点検・第3回）: 旧実装は Math.max(...fy数値) で選んでおり、
        //   fy 欠損レコードが1件でもあると NaN → 空配列 reduce が throw → catch で
        //   付与予定通知ブロック全体が黙って消えていた。fy比較は selectActiveGrantRecord の
        //   コメントで禁止されたパターンでもある
        let prevRecord = null as typeof recordsWithGrant[0] | null
        for (const r of recordsWithGrant) {
          if (!prevRecord || (r.grantDate || '') > (prevRecord.grantDate || '')) prevRecord = r
        }

        let realCarryOver = u.carryOver // フォールバック
        if (prevRecord && prevRecord.grantDate) {
          const gd = new Date(prevRecord.grantDate)
          const gdEnd = new Date(gd)
          gdEnd.setFullYear(gdEnd.getFullYear() + 1)
          // 出面からP消化を集計（同日複数現場は1日として数える = multi-site dedup）
          const seenDates = new Set<string>()
          for (const [key, entry] of Object.entries(allAttForPL)) {
            const e = entry as { p?: number | boolean }
            if (e.p) {  // truthy 判定（旧データ p:true 互換・他経路と統一 2026-08-27）
              const pk = parseDKey(key)
              if (parseInt(pk.wid) === u.workerId) {
                const entryDate = new Date(parseInt(pk.ym.slice(0, 4)), parseInt(pk.ym.slice(4, 6)) - 1, parseInt(pk.day))
                if (entryDate >= gd && entryDate < gdEnd) seenDates.add(`${pk.ym}_${pk.day}`)
              }
            }
          }
          const periodUsed = seenDates.size
          const prevGrant = prevRecord.grantDays || prevRecord.grant || 0
          const prevCarry = prevRecord.carryOver || prevRecord.carry || 0
          const prevAdj = prevRecord.adjustment ?? prevRecord.adj ?? 0
          const pr = prevRecord as { buyoutDays?: number; buyoutHistory?: Array<{ days?: number }> }
          const prevBuyout = pr.buyoutDays ?? (pr.buyoutHistory || []).reduce((s, h) => s + (h.days || 0), 0)
          // 労基法115条準拠: 前々期付与分(prevCarry)は時効消滅するため繰越上限は prevGrant（leave本体と同一ヘルパー）
          realCarryOver = calcLegalCarryOver({ prevGrant, prevCarry, prevAdj, prevBuyout, periodUsed })
        }

        // 日本人は繰越なし（期末買取制）。2026-09-02 修正: 旧は前期残を繰越として提示し、
        //   validateGrantInput が carryOver>0 を拒否して「付与に失敗しました」になっていた
        {
          const wU = main.workers.find(x => x.id === u.workerId)
          if (!wU?.visa || wU.visa === 'none') realCarryOver = 0
        }
        const realTotal = u.days + realCarryOver
        const grantDateStr = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
        notifications.push({
          id: `pl-grant-${u.workerId}`,
          icon: isPast ? '\u26A0\uFE0F' : '\uD83C\uDF34',
          message: isPast
            ? `${u.name}の有給付与が未処理です（${dateStr}）\n新規付与: ${u.days}日（法定・勤続${u.yearsOfService}）\n繰越: ${realCarryOver}日（前回残）\n→ 合計: ${realTotal}日`
            : `${u.name}の有給付与日が近づいています（${dateStr}）\n新規付与: ${u.days}日（法定・勤続${u.yearsOfService}）\n繰越: ${realCarryOver}日（前回残）\n→ 合計: ${realTotal}日`,
          type: isPast ? 'warning' : 'info',
          action: isPast ? {
            type: 'pl-grant',
            workerId: u.workerId,
            grantDate: grantDateStr,
            grantDays: u.days,
            carryOver: realCarryOver,
            label: `${u.days}日付与する`,
          } : undefined,
        })
      }
    } catch (e) {
      console.error('Upcoming PL grant check error:', e)
    }

    // ── Calendar deadline alert (25日過ぎて翌月カレンダーが未作成・未提出・未承認) ──
    try {
      if (today >= 25) {
        // 翌月のymを計算
        let nextY = now.getFullYear()
        let nextM = now.getMonth() + 2  // 0-indexed + 2 = next month
        if (nextM > 12) { nextM = 1; nextY++ }
        // siteCalendar の ym フィールドは「YYYY-MM」形式で保存されているため、
        // ダッシュあり形式でクエリする必要がある（過去のバグ修正）
        const nextYmDashed = `${nextY}-${String(nextM).padStart(2, '0')}`

        // 工種サイトは親現場のカレンダーを使うので、作成期限の対象から外す（2026-09-15）
        //   まだ始まっていない現場（工期の開始が翌月より後）も対象外（2026-09-21）
        const activeSites = main.sites.filter(s => !s.archived && !(s as { parentId?: string }).parentId && isSiteStartedByMonth(s, nextYmDashed))
        const calQ = query(
          collection(db, 'siteCalendar'),
          where('ym', '==', nextYmDashed)
        )
        const calSnap = await getDocs(calQ)
        const calMap = new Map<string, string>()  // siteId -> status
        calSnap.forEach(d => {
          const data = d.data()
          calMap.set(data.siteId, data.status || 'draft')
        })

        const notCreated: string[] = []
        const notSubmitted: string[] = []
        const notApproved: string[] = []

        for (const site of activeSites) {
          const status = calMap.get(site.id)
          if (!status) {
            notCreated.push(site.name)
          } else if (status === 'draft') {
            notSubmitted.push(site.name)
          } else if (status === 'submitted') {
            notApproved.push(site.name)
          }
          // 'approved' = OK
        }

        const issues: string[] = []
        if (notCreated.length > 0) issues.push(`未作成: ${notCreated.join('、')}`)
        if (notSubmitted.length > 0) issues.push(`未提出: ${notSubmitted.join('、')}`)
        if (notApproved.length > 0) issues.push(`未承認: ${notApproved.join('、')}`)

        if (issues.length > 0) {
          const totalIssues = notCreated.length + notSubmitted.length + notApproved.length
          notifications.push({
            id: 'calendar-deadline',
            icon: '⚠️',
            message: `${nextY}年${nextM}月のカレンダー: ${totalIssues}件の現場が未完了です`,
            type: 'error',
            count: totalIssues,
            messengerText: issues.join('\n'),
          })
        }
      }
    } catch (e) {
      console.error('Calendar deadline check error:', e)
    }

    // 7. 在留期限アラート（90日以内）
    try {
      const foreignWorkers = activeWorkers.filter(w => w.visa && w.visa !== 'none' && w.visa !== '')
      const todayDate = new Date()
      todayDate.setHours(0, 0, 0, 0)
      const visaAlerts: string[] = []
      for (const w of foreignWorkers) {
        const expiry = (w as unknown as { visaExpiry?: string }).visaExpiry
        if (!expiry) continue
        const exp = new Date(expiry + 'T00:00:00')
        const diff = Math.floor((exp.getTime() - todayDate.getTime()) / (1000 * 60 * 60 * 24))
        if (diff <= 90 && diff >= 0) {
          visaAlerts.push(`${w.name}（残${diff}日）`)
        } else if (diff < 0) {
          visaAlerts.push(`${w.name}（期限切れ）`)
        }
      }
      if (visaAlerts.length > 0) {
        notifications.push({
          id: 'visa-expiry',
          icon: '🛂',
          message: `在留期限: ${visaAlerts.join('、')}`,
          type: visaAlerts.some(a => a.includes('期限切れ')) ? 'error' : 'warning',
          count: visaAlerts.length,
        })
      }
    } catch (e) {
      console.error('Visa expiry check error:', e)
    }

    // 8. 承認待ち有給申請（職長承認待ち + 最終承認待ち の両方をカウント）
    try {
      const [lrPendingSnaps, lrForemanSnaps] = await Promise.all([
        getDocs(query(collection(db, 'leaveRequests'), where('status', '==', 'pending'))),
        getDocs(query(collection(db, 'leaveRequests'), where('status', '==', 'foreman_approved'))),
      ])
      const total = lrPendingSnaps.size + lrForemanSnaps.size
      if (total > 0) {
        const detail =
          lrPendingSnaps.size > 0 && lrForemanSnaps.size > 0
            ? `（職長待ち${lrPendingSnaps.size} / 最終承認待ち${lrForemanSnaps.size}）`
            : lrPendingSnaps.size > 0
              ? `（職長承認待ち）`
              : `（最終承認待ち）`
        notifications.push({
          id: 'pending-leave-requests',
          icon: '📝',
          message: `有給申請 ${total}件 ${detail}`,
          type: 'info',
          count: total,
        })
      }
      // 職長: 自分の現場の人の「職長承認待ち」だけ（自分の申請は自分で承認できないので除く）。2026-09-26
      if (role === 'foreman') {
        const mine = lrPendingSnaps.docs.filter(d => {
          const wid = Number(d.data().workerId)
          return myForemanWorkers.has(wid) && wid !== requesterWorkerId
        }).length
        if (mine > 0) {
          notifications.push({
            id: 'foreman-pending-leave',
            icon: '📝',
            message: `有給申請の職長承認待ち ${mine}件（出面入力 → スマホ版「承認」タブ）`,
            type: 'info',
            count: mine,
          })
        }
      }
    } catch (e) {
      console.error('Leave request check error:', e)
    }

    // 8b. 承認待ち帰国申請（職長承認待ち + 最終承認待ち の両方）
    try {
      const [hlPendingSnaps, hlForemanSnaps] = await Promise.all([
        getDocs(query(collection(db, 'homeLongLeave'), where('status', '==', 'pending'))),
        getDocs(query(collection(db, 'homeLongLeave'), where('status', '==', 'foreman_approved'))),
      ])
      const total = hlPendingSnaps.size + hlForemanSnaps.size
      if (total > 0) {
        const detail =
          hlPendingSnaps.size > 0 && hlForemanSnaps.size > 0
            ? `（職長待ち${hlPendingSnaps.size} / 最終承認待ち${hlForemanSnaps.size}）`
            : hlPendingSnaps.size > 0
              ? `（職長承認待ち）`
              : `（最終承認待ち）`
        notifications.push({
          id: 'pending-home-long-leave',
          icon: '✈️',
          message: `帰国申請 ${total}件 ${detail}`,
          type: 'info',
          count: total,
        })
      }
      if (role === 'foreman') {
        const mine = hlPendingSnaps.docs.filter(d => {
          const wid = Number(d.data().workerId)
          return myForemanWorkers.has(wid) && wid !== requesterWorkerId
        }).length
        if (mine > 0) {
          notifications.push({
            id: 'foreman-pending-home-leave',
            icon: '✈️',
            message: `帰国申請の職長承認待ち ${mine}件（出面入力 → スマホ版「承認」タブ）`,
            type: 'info',
            count: mine,
          })
        }
      }
    } catch (e) {
      console.error('Home long leave request check error:', e)
    }

    // 8c. 承認待ちの請求書（事務が発行を申請 → 事業責任者・管理者が承認。2026-09-26）
    if (role === 'admin' || role === 'approver') {
      try {
        const { listPendingPeerInvoices } = await import('@/lib/peer-invoice-store')
        const pendingInv = await listPendingPeerInvoices()
        if (pendingInv.length > 0) {
          notifications.push({
            id: 'pending-invoices',
            icon: '🧾',
            message: `請求書の発行承認待ち ${pendingInv.length}件（${pendingInv.map(i => i.companyName).join('・')}）`,
            type: 'info',
            count: pendingInv.length,
          })
        }
      } catch (e) {
        console.error('Pending invoice check error:', e)
      }
    }

    // 9. お知らせ（最新1件・7日以内）。投稿分＋リリースノートを役割に合わせて（lib/release-notes.ts）。
    //   2026-09-26: 旧は存在しない 'announcements' コレクションを読んでいて、ベルに一度も出ていなかった
    try {
      const recent = mergeAnnouncements(main.announcements || [], permRoleOf(apiRole ? { role: apiRole.role } : null))[0]
      if (recent) {
        const daysSince = Math.floor((now.getTime() - new Date(recent.publishedAt).getTime()) / (1000 * 60 * 60 * 24))
        if (daysSince <= 7) {
          notifications.push({
            id: 'announcement',
            icon: '📢',
            message: `お知らせ: ${recent.title}`,
            type: 'info',
          })
        }
      }
    } catch (e) {
      console.error('Announcement check error:', e)
    }

    // N. 長期未アクセスアラート（admin向け、3日以上アクセスなしのスタッフ/職長）
    try {
      if (role === 'admin') {
        const homeLeaves = await getAllActiveHomeLeaves()
        const accessMap = await getWorkerLastAccessMap(30)
        const today = new Date()
        today.setHours(0, 0, 0, 0)
        const todayJst = new Date(today.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }))
        todayJst.setHours(0, 0, 0, 0)

        const inactiveNames: { name: string; lastAccess: string | null; days: number | null }[] = []
        for (const w of activeWorkers) {
          // スタッフ・職長のみ対象（事務・役員は毎日使うわけではないので除外）
          const isTargetRole = !!w.token && (w.job === 'shokucho' || (w.visa && w.visa !== 'none'))
          if (!isTargetRole) continue

          // 帰国中のスタッフは除外
          const currentYmStr = `${todayJst.getFullYear()}${String(todayJst.getMonth() + 1).padStart(2, '0')}`
          if (isFullMonthHomeLeave(w.id, currentYmStr, homeLeaves)) continue

          const access = accessMap.get(w.id)
          if (!access || !access.lastAccessDate) {
            inactiveNames.push({ name: w.name, lastAccess: null, days: null })
            continue
          }
          const lastDate = new Date(access.lastAccessDate + 'T00:00:00')
          const daysGap = Math.floor((todayJst.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24))
          if (daysGap >= 3) {
            inactiveNames.push({ name: w.name, lastAccess: access.lastAccessDate, days: daysGap })
          }
        }

        if (inactiveNames.length > 0) {
          notifications.push({
            id: 'inactive-access',
            icon: '\uD83D\uDD10',
            message: `3日以上アクセスがないスタッフ: ${inactiveNames.length}名`,
            type: 'info',
            count: inactiveNames.length,
          })
        }
      }
    } catch (e) {
      console.error('Access inactivity check error:', e)
    }

    // ── ロール別フィルタ ──
    // admin: 全通知を表示
    // approver: カレンダー系 + 署名系（PL付与アクションは除く）+ 評価関連
    // foreman: カレンダー期限アラート + 自分宛の評価入力依頼
    const filtered = notifications.filter(n => {
      if (role === 'admin') return true
      if (role === 'approver') {
        // 2026-08-27 追加: 最終承認者に承認待ち（有給・帰国）を配信
        //   （旧: admin 限定で、承認フローの当事者にベルが出なかった）
        return ['unsigned-calendar', 'calendar-deadline', 'month-unlocked-hibi', 'month-unlocked-hfu',
                'pending-leave-requests', 'pending-home-long-leave', 'pending-invoices', 'announcement'].includes(n.id)
            || n.id.startsWith('pl-grant')
            || n.id.startsWith('evaluation-due')
            || n.id.startsWith('evaluation-todo-')
            || n.id.startsWith('evaluation-pending-approval-')
            || n.id.startsWith('evaluation-stale-')
      }
      if (role === 'foreman') {
        // 自分宛の評価入力依頼 + カレンダー期限 + 自分の現場の有給・帰国の職長承認待ち（2026-09-26）
        return n.id === 'calendar-deadline' || n.id.startsWith('evaluation-todo-')
          || n.id === 'foreman-pending-leave' || n.id === 'foreman-pending-home-leave' || n.id === 'announcement'
      }
      if (role !== 'jimu') {
        // 役員（見るだけ）・不明: カレンダー署名系のみ
        return ['unsigned-calendar', 'calendar-deadline', 'announcement'].includes(n.id)
      }
      // jimu: カレンダー署名系 + 有給の付与アラート（2026-09-26: 有給の付与は事務の仕事・lib/permissions.ts leave.manage）
      return ['unsigned-calendar', 'calendar-deadline', 'announcement'].includes(n.id) || n.id.startsWith('pl-grant')
    })

    return NextResponse.json({ notifications: filtered })
  } catch (error) {
    console.error('Notifications API error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
