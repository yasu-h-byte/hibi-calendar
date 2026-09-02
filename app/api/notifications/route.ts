import { NextRequest, NextResponse } from 'next/server'
import { checkApiAuth } from '@/lib/auth'
import { db } from '@/lib/firebase'
import { collection, query, where, getDocs } from '@/lib/fsdb'
import { getMainData, getAttData, parseDKey } from '@/lib/compute'
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
    const role = request.nextUrl.searchParams.get('role') || 'admin'
    const workerIdParam = request.nextUrl.searchParams.get('workerId')
    const requesterWorkerId = workerIdParam ? Number(workerIdParam) : null
    const notifications: Notification[] = []

    const main = await getMainData()
    // 2026-08-27 修正（有給総点検・第3回）: 「退職日が入っているだけ」で全通知から
    //   即日消えていた（例: 12/31退職予定を登録した瞬間に有給残・付与予定・未署名等の
    //   通知が全部止まる）。dashboard/ledger と同じく「今日時点で退職済み」のみ除外
    const activeWorkers = main.workers.filter(w => !isAlreadyRetired(w.retired, todayJstIso()))

    // 1. Calendar unsigned workers (承認済みカレンダーのみ、現月＋翌月をチェック)
    try {
      const activeSites = main.sites.filter(s => !s.archived)

      // 帰国情報
      const homeLeaves = await getAllActiveHomeLeaves()

      // チェック対象: 現月 + 翌月（翌月カレンダーを月末に署名するため）
      // 注意: siteCalendar と calendarSign の ym はダッシュあり形式 "YYYY-MM"
      //       massign のキーはダッシュなし形式 "YYYYMM"
      let nextY = now.getFullYear()
      let nextM = now.getMonth() + 2
      if (nextM > 12) { nextM = 1; nextY++ }
      const nextYm = ymKey(nextY, nextM)
      const ymsToCheck = [currentYm, nextYm]
      const calYmOf = (ym: string) => `${ym.slice(0, 4)}-${ym.slice(4, 6)}`

      // 署名対象の判定は共通ヘルパー isCalendarSignTarget に一元化する（2026-09-02 修正）。
      //   旧: activeWorkers.filter(w => !!w.token) — 「トークン所持＝ベトナム人」という
      //   前提で書かれていたが、日本人スタッフにマイページ用トークンを発行した時点で崩れ、
      //   署名対象外の日本人9名が「未署名」として通知に出ていた。
      //   ヘルパーは visa（日本人除外）・当該月の在籍・全期間帰国もまとめて判定する。
      const eligibleIdsByYm: Record<string, Set<number>> = {}
      for (const ym of ymsToCheck) {
        const fullMonthHlIds = new Set(
          main.workers.map(w => w.id).filter(id => isFullMonthHomeLeave(id, ym, homeLeaves)),
        )
        eligibleIdsByYm[ym] = new Set(
          main.workers.filter(w => isCalendarSignTarget(w, ym, fullMonthHlIds)).map(w => w.id),
        )
      }

      // 各月の承認済みカレンダーを一括取得
      const approvedCalendarsByYm: Record<string, Set<string>> = {}
      for (const ym of ymsToCheck) {
        const calQuery = query(
          collection(db, 'siteCalendar'),
          where('ym', '==', calYmOf(ym)),
          where('status', '==', 'approved'),
        )
        const calSnaps = await getDocs(calQuery)
        const approvedSet = new Set<string>()
        calSnaps.forEach(snap => {
          const data = snap.data()
          if (data.siteId) approvedSet.add(data.siteId as string)
        })
        approvedCalendarsByYm[ym] = approvedSet
      }

      // 各月の署名状況を一括取得（calendarSignのymはダッシュあり形式）
      const signaturesByYm: Record<string, Set<string>> = {}
      for (const ym of ymsToCheck) {
        const signQuery = query(collection(db, 'calendarSign'), where('ym', '==', calYmOf(ym)))
        const signSnaps = await getDocs(signQuery)
        const existing = new Set<string>()
        // ドキュメントIDは ${workerId}_${ym-with-dash}_${siteId} 形式
        signSnaps.forEach(snap => existing.add(snap.id))
        signaturesByYm[ym] = existing
      }

      // 未署名集計
      const expectedUnsignedWorkerIds = new Set<number>()
      const unsignedByYm: Record<string, Set<number>> = {}

      for (const ym of ymsToCheck) {
        const approvedSites = approvedCalendarsByYm[ym]
        const existingSignIds = signaturesByYm[ym]
        unsignedByYm[ym] = new Set<number>()

        if (approvedSites.size === 0) continue

        for (const site of activeSites) {
          if (!approvedSites.has(site.id)) continue

          const monthKey = `${site.id}_${ym}`
          const mAssign = main.massign[monthKey]
          const dAssign = main.assign[site.id]
          const workerIds = mAssign?.workers || dAssign?.workers || []

          for (const wid of workerIds) {
            if (!eligibleIdsByYm[ym].has(wid)) continue
            // calendarSignのドキュメントIDはダッシュあり形式
            const signId = `${wid}_${calYmOf(ym)}_${site.id}`
            if (!existingSignIds.has(signId)) {
              expectedUnsignedWorkerIds.add(wid)
              unsignedByYm[ym].add(wid)
            }
          }
        }
      }

      if (expectedUnsignedWorkerIds.size > 0) {
        const unsignedNames: string[] = []
        for (const wid of expectedUnsignedWorkerIds) {
          const w = activeWorkers.find(x => x.id === wid)
          if (w) unsignedNames.push(w.name)
        }
        // Messengerテキストは未署名が多い方の月を対象にする（翌月優先）
        const targetYm = unsignedByYm[nextYm].size > 0 ? nextYm : currentYm
        const ymLabel = `${targetYm.slice(0, 4)}年${parseInt(targetYm.slice(4, 6))}月`
        const calYm = `${targetYm.slice(0, 4)}-${targetYm.slice(4, 6)}`
        const calUrl = `https://hibi-calendar.vercel.app/calendar/public?ym=${calYm}`
        const unsignedCount = expectedUnsignedWorkerIds.size
        notifications.push({
          id: 'unsigned-calendar',
          icon: '\uD83D\uDCC5',
          message: `就業カレンダー未署名: ${unsignedCount}名が未完了です`,
          type: 'warning',
          count: unsignedCount,
          messengerText: `HIBI CONSTRUCTION\n就業カレンダー ${ymLabel}\nLịch làm việc tháng ${parseInt(targetYm.slice(4, 6))}\n\n${calUrl}\n\n名前を選んで → カレンダー確認 → 署名\nChọn tên → Xem lịch → Ký\n\n未署名 / Chưa ký:\n${unsignedNames.join(', ')}`,
        })
      }
    } catch (e) {
      console.error('Calendar sign check error:', e)
    }

    // 出面データ（有給P消化の集計用）。ブロック2の残数計算とブロック6の繰越計算で共用する。
    // ⚠️ 読み取り回数を増やさないこと（クォータ障害歴あり）。従来ブロック6が読んでいた
    //   範囲をそのまま巻き上げただけで、読む月数は変えていない。
    const allAttForPL: Record<string, Record<string, unknown>> = {}
    {
      const currentYear = now.getFullYear()
      for (let y = currentYear - 2; y <= currentYear; y++) {
        for (let m = 1; m <= 12; m++) {
          const att = await getAttData(ymKey(y, m))
          Object.assign(allAttForPL, att.d)
        }
      }
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

        const activeSites = main.sites.filter(s => !s.archived)
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
    } catch (e) {
      console.error('Home long leave request check error:', e)
    }

    // 9. お知らせ（最新1件のみ）
    try {
      const annSnap = await getDocs(collection(db, 'announcements'))
      const anns: { title: string; publishedAt: string }[] = []
      annSnap.forEach(d => {
        const data = d.data()
        if (data.publishedAt) anns.push({ title: data.title, publishedAt: data.publishedAt })
      })
      anns.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
      const recent = anns[0]
      if (recent) {
        const pubDate = new Date(recent.publishedAt)
        const daysSince = Math.floor((now.getTime() - pubDate.getTime()) / (1000 * 60 * 60 * 24))
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
                'pending-leave-requests', 'pending-home-long-leave'].includes(n.id)
            || n.id.startsWith('pl-grant')
            || n.id.startsWith('evaluation-due')
            || n.id.startsWith('evaluation-todo-')
            || n.id.startsWith('evaluation-pending-approval-')
            || n.id.startsWith('evaluation-stale-')
      }
      if (role === 'foreman') {
        // 自分宛の評価入力依頼 + カレンダー期限のみ
        return n.id === 'calendar-deadline' || n.id.startsWith('evaluation-todo-')
      }
      // jimu: カレンダー署名系のみ
      return ['unsigned-calendar', 'calendar-deadline'].includes(n.id)
    })

    return NextResponse.json({ notifications: filtered })
  } catch (error) {
    console.error('Notifications API error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
