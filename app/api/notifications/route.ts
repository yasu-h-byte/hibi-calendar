import { NextRequest, NextResponse } from 'next/server'
import { checkApiAuth } from '@/lib/auth'
import { db } from '@/lib/firebase'
import { collection, query, where, getDocs } from 'firebase/firestore'
import { getMainData, getAttData, parseDKey } from '@/lib/compute'
import { ymKey } from '@/lib/attendance'
import { getUpcomingGrants } from '@/lib/leave-auto'

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
    const now = new Date()
    const currentYm = ymKey(now.getFullYear(), now.getMonth() + 1)
    const today = now.getDate()
    const role = request.nextUrl.searchParams.get('role') || 'admin'
    const notifications: Notification[] = []

    const main = await getMainData()
    const activeWorkers = main.workers.filter(w => !w.retired)

    // 1. Calendar unsigned workers (batch query instead of N+1 reads)
    try {
      const activeSites = main.sites.filter(s => !s.archived)

      // Collect all expected worker×site combinations
      const expectedSignIds = new Set<string>()
      for (const site of activeSites) {
        const monthKey = `${site.id}_${currentYm}`
        const mAssign = main.massign[monthKey]
        const dAssign = main.assign[site.id]
        const workerIds = mAssign?.workers || dAssign?.workers || []

        for (const wid of workerIds) {
          expectedSignIds.add(`${wid}_${currentYm}_${site.id}`)
        }
      }

      // Single Firestore query to get ALL signatures for this month
      const signQuery = query(collection(db, 'calendarSign'), where('ym', '==', currentYm))
      const signSnaps = await getDocs(signQuery)
      const existingSignIds = new Set<string>()
      signSnaps.forEach(snap => existingSignIds.add(snap.id))

      // Count unsigned by checking in memory
      let unsignedCount = 0
      for (const id of expectedSignIds) {
        if (!existingSignIds.has(id)) {
          unsignedCount++
        }
      }

      if (unsignedCount > 0) {
        // 未署名のスタッフ名を取得
        const unsignedNames: string[] = []
        for (const id of expectedSignIds) {
          if (!existingSignIds.has(id)) {
            const wid = parseInt(id.split('_')[0])
            const w = activeWorkers.find(x => x.id === wid)
            if (w && !unsignedNames.includes(w.name)) unsignedNames.push(w.name)
          }
        }
        const ymLabel = `${currentYm.slice(0, 4)}年${parseInt(currentYm.slice(4, 6))}月`
        const calYm = `${currentYm.slice(0, 4)}-${currentYm.slice(4, 6)}`
        const calUrl = `https://hibi-calendar.vercel.app/calendar/public?ym=${calYm}`
        notifications.push({
          id: 'unsigned-calendar',
          icon: '\uD83D\uDCC5',
          message: `就業カレンダー未署名: ${unsignedCount}件の署名が未完了です`,
          type: 'warning',
          count: unsignedCount,
          messengerText: `HIBI CONSTRUCTION\n就業カレンダー ${ymLabel}\nLịch làm việc tháng ${parseInt(currentYm.slice(4, 6))}\n\n${calUrl}\n\n名前を選んで → カレンダー確認 → 署名\nChọn tên → Xem lịch → Ký\n\n未署名 / Chưa ký:\n${unsignedNames.join(', ')}`,
        })
      }
    } catch (e) {
      console.error('Calendar sign check error:', e)
    }

    // 2. PL remaining <= 3 days
    try {
      const currentFy = now.getMonth() + 1 >= 10
        ? String(now.getFullYear())
        : String(now.getFullYear() - 1)

      const lowPLWorkers: string[] = []

      for (const w of activeWorkers) {
        const records = main.plData[String(w.id)] || []
        if (records.length === 0) continue

        const fyRecord = records.find(r => r.fy === currentFy)
        if (!fyRecord) continue

        const total = fyRecord.grantDays + fyRecord.carryOver + fyRecord.adjustment
        const used = fyRecord.used || 0
        const remaining = total - used

        if (remaining <= 3 && total > 0) {
          lowPLWorkers.push(w.name)
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

    // 4. Today's attendance not entered
    try {
      const att = await getAttData(currentYm)
      const activeSites = main.sites.filter(s => !s.archived)

      const assignedWorkerIds = new Set<number>()
      for (const site of activeSites) {
        const monthKey = `${site.id}_${currentYm}`
        const mAssign = main.massign[monthKey]
        const dAssign = main.assign[site.id]
        const workerIds = mAssign?.workers || dAssign?.workers || []
        for (const wid of workerIds) assignedWorkerIds.add(wid)
      }

      const workersWithEntry = new Set<number>()
      for (const [key, entry] of Object.entries(att.d)) {
        if (!entry) continue
        const pk = parseDKey(key)
        const day = parseInt(pk.day)
        const wid = parseInt(pk.wid)
        if (day === today && (entry as unknown as Record<string, unknown>).w !== undefined) {
          workersWithEntry.add(wid)
        }
      }

      const noEntryWorkers = activeWorkers.filter(
        w => assignedWorkerIds.has(w.id) && !workersWithEntry.has(w.id)
      )

      if (noEntryWorkers.length > 0) {
        const noEntryNames = noEntryWorkers.map(w => w.name)
        notifications.push({
          id: 'no-attendance',
          icon: '\u274C',
          message: `出面未入力: 本日${noEntryWorkers.length}名の出面が未入力です`,
          type: 'error',
          count: noEntryWorkers.length,
          messengerText: `⚠️ 本日の出面がまだ入力されていません。\nスマホから入力をお願いします。\n\nHôm nay chưa nhập chấm công. Vui lòng nhập trên điện thoại.\n\n未入力 / Chưa nhập: ${noEntryNames.join(', ')}`,
        })
      }
    } catch (e) {
      console.error('Attendance check error:', e)
    }

    // 5. Evaluation due notifications (入社日基準の評価時期アラート)
    try {
      const foreignWorkers = activeWorkers.filter(w => w.visa && w.visa !== 'none')
      for (const w of foreignWorkers) {
        if (!w.hireDate) continue
        const hire = new Date(w.hireDate)
        if (isNaN(hire.getTime())) continue

        // 次の評価日を計算（入社日から1年ごと）
        const yearsSinceHire = Math.floor((now.getTime() - hire.getTime()) / (365.25 * 24 * 60 * 60 * 1000))
        const nextEvalDate = new Date(hire)
        nextEvalDate.setFullYear(hire.getFullYear() + yearsSinceHire + 1)

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

    // 6. Upcoming / overdue PL grant dates (30 days ahead, 30 days past)
    try {
      const upcoming = getUpcomingGrants(main, 30)

      // 出面データから正しい繰越を計算するため、全期間のattデータを取得
      const currentYear = now.getFullYear()
      const allAttForPL: Record<string, Record<string, unknown>> = {}
      for (let y = currentYear - 2; y <= currentYear; y++) {
        for (let m = 1; m <= 12; m++) {
          const att = await getAttData(ymKey(y, m))
          Object.assign(allAttForPL, att.d)
        }
      }

      for (const u of upcoming) {
        const m = u.grantDate.getMonth() + 1
        const d = u.grantDate.getDate()
        const y = u.grantDate.getFullYear()
        const isPast = u.grantDate <= now
        const dateStr = `${y}/${m}/${d}`

        // 前回レコードから正しい繰越を計算（出面のPを含む）
        const wRecords = (main.plData[String(u.workerId)] || []) as { grantDate?: string; grantDays?: number; grant?: number; carryOver?: number; carry?: number; adjustment?: number; adj?: number; used?: number; fy?: string | number }[]
        const recordsWithGrant = wRecords.filter(r => (r.grantDays && r.grantDays > 0) || (r.grant && r.grant > 0))
        // 同じFYに複数ある場合はgrantDateが最も新しいものを採用（正しいレコード）
        let prevRecord = null as typeof recordsWithGrant[0] | null
        if (recordsWithGrant.length > 0) {
          const maxFy = Math.max(...recordsWithGrant.map(r => Number(r.fy)))
          const sameFy = recordsWithGrant.filter(r => Number(r.fy) === maxFy)
          prevRecord = sameFy.reduce((best, r) => {
            const bestDate = best.grantDate || ''
            const rDate = r.grantDate || ''
            return rDate > bestDate ? r : best
          })
        }

        let realCarryOver = u.carryOver // フォールバック
        if (prevRecord && prevRecord.grantDate) {
          const gd = new Date(prevRecord.grantDate)
          const gdEnd = new Date(gd)
          gdEnd.setFullYear(gdEnd.getFullYear() + 1)
          // 出面からP消化を集計
          let periodUsed = 0
          for (const [key, entry] of Object.entries(allAttForPL)) {
            const e = entry as { p?: number }
            if (e.p === 1) {
              const pk = parseDKey(key)
              if (parseInt(pk.wid) === u.workerId) {
                const entryDate = new Date(parseInt(pk.ym.slice(0, 4)), parseInt(pk.ym.slice(4, 6)) - 1, parseInt(pk.day))
                if (entryDate >= gd && entryDate < gdEnd) periodUsed++
              }
            }
          }
          const prevGrant = prevRecord.grantDays || prevRecord.grant || 0
          const prevCarry = prevRecord.carryOver || prevRecord.carry || 0
          const prevAdj = Math.max(prevRecord.adjustment || 0, prevRecord.adj || 0)
          const prevTotal = prevGrant + prevCarry
          const prevUsed = prevAdj + periodUsed
          realCarryOver = Math.min(20, Math.max(0, prevTotal - prevUsed))
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
        const nextYm = `${nextY}${String(nextM).padStart(2, '0')}`

        const activeSites = main.sites.filter(s => !s.archived)
        const calQ = query(
          collection(db, 'siteCalendar'),
          where('ym', '==', nextYm)
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

    // ── ロール別フィルタ ──
    // admin: 全通知を表示
    // approver: カレンダー系 + 署名系（PL付与アクションは除く）
    // foreman: カレンダー期限アラートのみ
    const filtered = notifications.filter(n => {
      if (role === 'admin') return true
      if (role === 'approver') {
        return ['unsigned-calendar', 'calendar-deadline', 'no-attendance', 'month-unlocked-hibi', 'month-unlocked-hfu'].includes(n.id) || n.id.startsWith('pl-grant') || n.id.startsWith('evaluation-due')
      }
      if (role === 'foreman') {
        return n.id === 'calendar-deadline'
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
