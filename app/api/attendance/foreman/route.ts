import { NextRequest, NextResponse } from 'next/server'
import { getWorkerByToken } from '@/lib/workers'
import {
  getAttendanceDoc,
  setAttendanceEntry,
  getApprovalForDay,
  setApprovalForDay,
  getForemanSite,
  getForeignWorkersForSite,
  getEntryStatus,
  ymKey,
  attKey,
  formatDateKanji,
  formatDateShort,
} from '@/lib/attendance'
import { AttendanceEntry, DEFAULT_WORK_SCHEDULE } from '@/types'
import { recordAccess, getRequestIp } from '@/lib/accessLog'

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get('token')
  const dateParam = request.nextUrl.searchParams.get('date') // YYYY-MM-DD

  if (!token) {
    return NextResponse.json({ error: 'token required' }, { status: 400 })
  }

  try {
    const foreman = await getWorkerByToken(token)
    if (!foreman) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
    }

    const site = await getForemanSite(foreman.id)
    if (!site) {
      return NextResponse.json({ error: 'Not a foreman' }, { status: 403 })
    }

    // アクセスログ記録
    recordAccess({
      workerId: foreman.id,
      workerName: foreman.name,
      role: 'foreman',
      org: foreman.company === 'HFU' ? 'hfu' : 'hibi',
      ip: getRequestIp(request),
    }).catch(() => {})

    // Parse date (default: today)
    let viewDate: Date
    if (dateParam) {
      viewDate = new Date(dateParam + 'T00:00:00')
    } else {
      viewDate = new Date()
    }

    // Don't go past today
    const today = new Date()
    if (viewDate > today) viewDate = today

    const y = viewDate.getFullYear()
    const m = viewDate.getMonth() + 1
    const d = viewDate.getDate()
    const ym = ymKey(y, m)

    // Get foreign workers for this site
    const foreignWorkers = await getForeignWorkersForSite(site.id)

    // Get attendance data
    const attData = await getAttendanceDoc(ym)

    // ── 別現場で入力済みの検出 ──
    // ベトナム人スタッフが現場を間違えて他現場に入力した場合、職長が修正できるよう
    // 当該日の他現場の入力を検出する。
    // attData の key 形式: "{siteId}_{workerId}_{ym}_{day}"
    // 当該 ym と day で他の siteId 配下のエントリを抽出
    const dayStr = String(d)
    const siteNameMap: Record<string, string> = {}
    // 代理入力の初期値用（2026-08-28 追加: 時刻つき代理入力）
    let siteSchedule: import('@/types').SiteWorkSchedule | undefined
    {
      const { db } = await import('@/lib/firebase')
      const { doc, getDoc } = await import('@/lib/fsdb')
      const mainSnap = await getDoc(doc(db, 'demmen', 'main'))
      if (mainSnap.exists()) {
        const sites = (mainSnap.data().sites || []) as { id: string; name: string; workSchedule?: import('@/types').SiteWorkSchedule }[]
        for (const s of sites) siteNameMap[s.id] = s.name
        siteSchedule = sites.find(x => x.id === site.id)?.workSchedule
      }
    }

    // workerId → { siteId, name, entry } のマップを構築
    const crossSiteEntries: Record<number, { siteId: string; siteName: string; entry: AttendanceEntry }[]> = {}
    for (const [key, entry] of Object.entries(attData)) {
      if (!entry || typeof entry !== 'object') continue
      // パース: siteId は最初の "_" 区切り。末尾3要素が wid_ym_day
      const parts = key.split('_')
      if (parts.length < 4) continue
      const keyDay = parts[parts.length - 1]
      const keyYm = parts[parts.length - 2]
      const keyWid = parts[parts.length - 3]
      const keySid = parts.slice(0, parts.length - 3).join('_')
      if (keyYm !== ym) continue
      if (keyDay !== dayStr) continue
      if (keySid === site.id) continue   // 自現場は除外
      const wid = parseInt(keyWid, 10)
      if (!Number.isFinite(wid)) continue
      if (!crossSiteEntries[wid]) crossSiteEntries[wid] = []
      crossSiteEntries[wid].push({
        siteId: keySid,
        siteName: siteNameMap[keySid] || keySid,
        entry: entry as AttendanceEntry,
      })
    }

    // Build worker list with status
    const workers = foreignWorkers.map(w => {
      const key = attKey(site.id, w.id, ym, d)
      const entry = attData[key] || null
      const misplaced = crossSiteEntries[w.id] || []
      return {
        id: w.id,
        name: w.name,
        entry,
        status: getEntryStatus(entry),
        // 別現場で入力済みエントリ（複数現場の場合もある）
        misplacedEntries: misplaced,
      }
    })

    const workCount = workers.filter(w => w.status === 'work' || w.status === 'overtime').length
    const noneCount = workers.filter(w => w.status === 'none').length

    // Check approval
    const approval = await getApprovalForDay(site.id, ym, d)
    const approved = !!(approval?.foreman)

    // ── 月の俯瞰（2026-08-28 追加: 週ビュー・まとめ承認・未入力の見える化）──
    //   その月の稼働日ごとに 承認状態・未入力者 を返す。
    //   旧UIは「今日＋過去2日」しか辿れず、承認をため込むとスマホから消化できなかった。
    const daysInMonth = new Date(y, m, 0).getDate()
    const todayJst = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }))
    const todayDayNum = (todayJst.getFullYear() === y && todayJst.getMonth() + 1 === m)
      ? todayJst.getDate()
      : (new Date(y, m - 1, 1) < todayJst ? daysInMonth : 0)

    // 現場カレンダー（承認済みのみ）。非稼働日は未入力を数えない
    let calDays: Record<string, string> | null = null
    try {
      const { db } = await import('@/lib/firebase')
      const { doc, getDoc } = await import('@/lib/fsdb')
      const calSnap = await getDoc(doc(db, 'siteCalendar', `${site.id}_${y}-${String(m).padStart(2, '0')}`))
      const cal = calSnap.exists() ? calSnap.data() : null
      if (cal?.status === 'approved' && cal?.days) calDays = cal.days as Record<string, string>
    } catch { /* カレンダー未取得でも俯瞰は出す（全日を稼働扱い） */ }

    const dayNums = Array.from({ length: Math.max(0, todayDayNum) }, (_, i) => i + 1)
    const monthApprovals = await Promise.all(dayNums.map(dd => getApprovalForDay(site.id, ym, dd)))
    const monthOverview = dayNums.map((dd, i) => {
      const calDay = calDays?.[String(dd)]
      const isWorkDay = calDays ? calDay === 'work' : new Date(y, m - 1, dd).getDay() !== 0
      const missingNames: string[] = []
      let entered = 0
      if (isWorkDay) {
        for (const w of foreignWorkers) {
          const e = attData[attKey(site.id, w.id, ym, dd)]
          // 判定はリスト表示と同じ getEntryStatus に統一（0.6補償=入力済み、残骸のみ=未入力）
          if (getEntryStatus(e) !== 'none') entered++
          else missingNames.push(w.name)
        }
      }
      return {
        day: dd,
        dateISO: `${y}-${String(m).padStart(2, '0')}-${String(dd).padStart(2, '0')}`,
        isWorkDay,
        approved: !!(monthApprovals[i]?.foreman),
        entered,
        missingNames: isWorkDay ? missingNames : [],
      }
    })

    // Past 2 days
    const pastDays = []
    for (let off = 1; off <= 2; off++) {
      const pd = new Date(y, m - 1, d - off)
      const pym = ymKey(pd.getFullYear(), pd.getMonth() + 1)
      const pDay = pd.getDate()
      const pApproval = await getApprovalForDay(site.id, pym, pDay)
      pastDays.push({
        date: formatDateShort(pd),
        dateISO: `${pd.getFullYear()}-${String(pd.getMonth() + 1).padStart(2, '0')}-${String(pDay).padStart(2, '0')}`,
        approved: !!(pApproval?.foreman),
      })
    }

    return NextResponse.json({
      foreman: { id: foreman.id, name: foreman.name },
      site: { id: site.id, name: site.name },
      date: {
        year: y, month: m, day: d, ym,
        dateLabel: formatDateKanji(viewDate),
        dateISO: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
      },
      workers,
      summary: { workCount, noneCount, totalCount: workers.length },
      approved,
      pastDays,
      monthOverview,
      schedule: {
        startTime: siteSchedule?.startTime || DEFAULT_WORK_SCHEDULE.startTime,
        endTime: siteSchedule?.endTime || DEFAULT_WORK_SCHEDULE.endTime,
        morningBreak: siteSchedule?.morningBreak ?? DEFAULT_WORK_SCHEDULE.morningBreak,
        lunchBreak: siteSchedule?.lunchBreak ?? DEFAULT_WORK_SCHEDULE.lunchBreak,
        afternoonBreak: siteSchedule?.afternoonBreak ?? DEFAULT_WORK_SCHEDULE.afternoonBreak,
      },
    })
  } catch (error) {
    console.error('Foreman GET error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { token, action } = body

    if (!token || !action) {
      return NextResponse.json({ error: 'token and action required' }, { status: 400 })
    }

    const foreman = await getWorkerByToken(token)
    if (!foreman) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
    }

    const site = await getForemanSite(foreman.id)
    if (!site) {
      return NextResponse.json({ error: 'Not a foreman' }, { status: 403 })
    }

    if (action === 'approve') {
      const { year, month, day } = body
      const ym = ymKey(year, month)
      await setApprovalForDay(site.id, ym, day, foreman.id)
      return NextResponse.json({ success: true })
    }

    // ── まとめ承認（2026-08-28 追加）──
    //   「全員入力済みの日」だけをまとめて職長承認する。未入力が残る日は
    //   サーバ側でも弾く（安全弁: 未入力＝欠勤のまま承認して締めに流れるのを防ぐ）。
    if (action === 'approve_bulk') {
      const { year, month, days } = body as { year: number; month: number; days: number[] }
      if (!Array.isArray(days) || days.length === 0 || days.length > 31) {
        return NextResponse.json({ error: 'days (1〜31件) を指定してください' }, { status: 400 })
      }
      const ym = ymKey(year, month)
      const { getAttendanceDoc: getAtt } = await import('@/lib/attendance')
      const attD = await getAtt(ym)
      const workersForBulk = await getForeignWorkersForSite(site.id)
      const approvedDays: number[] = []
      const skipped: { day: number; reason: string }[] = []
      const todayJstB = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }))
      for (const dd of days) {
        const dNum = Number(dd)
        if (!Number.isInteger(dNum) || dNum < 1 || dNum > 31) { skipped.push({ day: dNum, reason: '不正な日付' }); continue }
        if (new Date(year, month - 1, dNum) > todayJstB) { skipped.push({ day: dNum, reason: '未来日' }); continue }
        const missing = workersForBulk.filter(w =>
          getEntryStatus(attD[attKey(site.id, w.id, ym, dNum)]) === 'none')
        if (missing.length > 0) {
          skipped.push({ day: dNum, reason: `未入力: ${missing.map(w => w.name).join('、')}` })
          continue
        }
        await setApprovalForDay(site.id, ym, dNum, foreman.id)
        approvedDays.push(dNum)
      }
      return NextResponse.json({ success: true, approvedDays, skipped })
    }

    if (action === 'edit') {
      const { workerId, year, month, day, choice, overtimeHours } = body
      const ym = ymKey(year, month)

      // 2026-06-12 (監査 Sprint2-B): ロック済み月への職長編集を拒否（給与確定後のデータ変更防止）
      {
        const { checkMonthLocked } = await import('@/lib/locks')
        const lockErr = await checkMonthLocked(ym)
        if (lockErr) return NextResponse.json({ error: lockErr }, { status: 409 })
      }

      // Build entry first（ガードで newEntry を参照するため）
      // Build entry with s:'foreman' source tracking
      // ⚠️ 2026-05-09 根本原因対処: ステータス変更時に古いフィールドを残さない
      //   computeAttendanceDeleteFields で「新エントリに含まれない既知フィールドを自動算出」
      // 2026-08-28 追加: 出勤の代理入力を時刻対応に。
      //   旧: 時刻なしのレガシー形式(w:1+o)のみ → スタッフ入力と形式が揃わず、
      //   実労働の精密計算から外れて管理者がPCで入れ直していた。
      //   startTime/endTime があれば時間ベース（スタッフのスマホ入力と同形式）で保存する。
      const { startTime, endTime, break1, break2, break3 } = body as {
        startTime?: string; endTime?: string; break1?: boolean; break2?: boolean; break3?: boolean
      }
      let entry: AttendanceEntry
      switch (choice) {
        case 'work':
          if (startTime && endTime && /^\d{1,2}:\d{2}$/.test(String(startTime)) && /^\d{1,2}:\d{2}$/.test(String(endTime))) {
            entry = {
              w: 1,
              st: String(startTime), et: String(endTime),
              b1: break1 ? 1 : 0, b2: break2 ? 1 : 0, b3: break3 ? 1 : 0,
              s: 'foreman',
            }
            // ⚠️ o は保存しない（2026-08-31 総ざらいで修正）。
            //   スタッフのスマホ入力も st/et のみで o を持たず、給与計算
            //   (calculateVietnameseSalary) は st/et がある場合 o を無視する。
            //   o を併記すると wm.otHours（表示・現場の残業合計）だけが
            //   二重ソースで膨らみ、スタッフ入力と職長入力で数字が食い違う。
            break
          }
          entry = { w: 1, o: Math.max(0, Math.min(8, overtimeHours || 0)), s: 'foreman' }
          break
        case 'rest': {
          entry = { w: 0, r: 1, s: 'foreman' }
          // 2026-08-27（休暇届総点検）: スタッフが出した欠勤届の理由(rReason/rNote)を
          //   職長の「休み」確認で消さない。旧: 残骸掃除が理由も削除し、
          //   ダッシュボードの欠勤届一覧から届が黙って消えていた
          const { getAttendanceDoc, attKey } = await import('@/lib/attendance')
          const attDocF = await getAttendanceDoc(ym)
          const prevEntry = attDocF[attKey(site.id, workerId, ym, day)] as { rReason?: string; rNote?: string } | undefined
          if (prevEntry?.rReason) (entry as { rReason?: string }).rReason = prevEntry.rReason
          if (prevEntry?.rNote) (entry as { rNote?: string }).rNote = prevEntry.rNote
          break
        }
        case 'leave':
          entry = { w: 0, p: 1, s: 'foreman' }
          break
        case 'site_off':
          entry = { w: 0, h: 1, s: 'foreman' }
          break
        case 'comp':
          // 2026-06-XX 追加: 現場都合休み (補償日 w=0.6, 休業手当60%)
          //   会社/職長判断で代理入力する性質のため、スタッフ未入力でも登録可能
          //   (canAdminEditEntry の例外リストに含まれる)
          entry = { w: 0.6, s: 'foreman' }
          break
        default:
          return NextResponse.json({ error: 'Invalid choice' }, { status: 400 })
      }

      // ベトナム人スタッフのガード: 「最初の入力はスタッフ本人から」を強制。
      // ただし事後申請性ステータス（有給/帰国中）は admin/foreman の後付け入力を許容。
      try {
        const { canAdminEditEntry, detectMultiSiteConflict, getAttendanceDoc } = await import('@/lib/attendance')
        const { db } = await import('@/lib/firebase')
        const { doc, getDoc } = await import('@/lib/fsdb')
        const mainSnap = await getDoc(doc(db, 'demmen', 'main'))
        if (mainSnap.exists()) {
          const workers = (mainSnap.data().workers || []) as { id: number; visa?: string }[]
          const sitesAll = (mainSnap.data().sites || []) as { id: string; name: string; shiftType?: 'day' | 'night'; workSchedule?: { startTime?: string } }[]
          const targetWorker = workers.find(w => w.id === Number(workerId))
          if (targetWorker) {
            const dData = await getAttendanceDoc(ym)
            const key = `${site.id}_${workerId}_${ym}_${String(day)}`
            const existing = dData[key]
            // 事後申請性ステータス例外を許容するため newEntry を渡す
            const check = canAdminEditEntry({ visa: targetWorker.visa }, existing, entry)
            if (!check.editable) {
              return NextResponse.json({ error: check.reason || '編集不可' }, { status: 403 })
            }
            // 同日多現場ガード: 物理的に不可能な「同種シフト併記」を防ぐ
            const conflict = detectMultiSiteConflict(dData, site.id, Number(workerId), ym, day, sitesAll)
            if (conflict) {
              const cName = sitesAll.find(s => s.id === conflict.conflictSiteId)?.name || conflict.conflictSiteId
              const shiftLabel = conflict.shiftType === 'night' ? '夜勤' : '日勤'
              return NextResponse.json({
                error: `既に「${cName}」（${shiftLabel}）で同日の出面が登録されています。先にそちらを取り消すか「現場違い修正」機能で移動してください。`,
                conflictSiteId: conflict.conflictSiteId,
              }, { status: 409 })
            }
          }
        }
      } catch (e) {
        // ⚠️ fail-closed: 判定不能時は拒否（2026-05-08 修正）
        console.error('Multi-site guard error (foreman):', e)
        return NextResponse.json({ error: 'ガード判定に失敗しました（一時的な障害の可能性）' }, { status: 503 })
      }

      // ── 有給の残数チェック（2026-08-04 追加 / 有給システム総点検）──
      //   職長の代理入力（choice='leave'）はこれまで残数を一切見ていなかった。
      //   出面グリッド・スタッフ入力・時季指定と同じ共通ヘルパーで判定する。
      //   職長には超過の上書き権限を与えない（超過が必要な例外は管理者が行う）。
      if (choice === 'leave') {
        try {
          const { getLeaveBalance } = await import('@/lib/leave-balance')
          const targetDate = `${ym.slice(0, 4)}-${ym.slice(4, 6)}-${String(day).padStart(2, '0')}`
          const bal = await getLeaveBalance(Number(workerId), undefined, targetDate)
          if (bal.remaining <= 0) {
            return NextResponse.json({
              error: bal.noGrant
                ? 'このスタッフは有給が付与されていません。管理者に連絡してください。'
                : `有給の残日数が 0 日です（枠 ${bal.total}日 / 消化 ${bal.used}日）。管理者に連絡してください。`,
            }, { status: 409 })
          }
        } catch (chkErr) {
          // 残チェック不能時は従来動作を維持（業務を止めない）。ログのみ残す
          console.warn('[foreman/leave] 残チェック失敗:', chkErr)
        }
      }

      const { computeAttendanceDeleteFields } = await import('@/lib/attendance')
      const deleteFields = computeAttendanceDeleteFields(entry)
      await setAttendanceEntry(site.id, workerId, ym, day, entry, { deleteFields })
      return NextResponse.json({ success: true, entry })
    }

    // ── 別現場で入力されたエントリを自現場へ移動（現場間違い修正） ──
    // ベトナムスタッフが現場を間違えて他現場で入力した場合に、職長が
    // 「ここに移動」できる。ソース現場のエントリは deleteField で消す。
    if (action === 'fix_site') {
      const { workerId, year, month, day, fromSiteId } = body as {
        workerId: number
        year: number
        month: number
        day: number
        fromSiteId: string
      }
      if (!workerId || !year || !month || !day || !fromSiteId) {
        return NextResponse.json({ error: 'workerId, year, month, day, fromSiteId は必須です' }, { status: 400 })
      }
      if (fromSiteId === site.id) {
        return NextResponse.json({ error: '自現場のエントリは移動できません' }, { status: 400 })
      }
      const ym = ymKey(year, month)

      // 2026-06-12 (監査 Sprint2-B): ロック済み月の現場間移動を拒否
      {
        const { checkMonthLocked } = await import('@/lib/locks')
        const lockErr = await checkMonthLocked(ym)
        if (lockErr) return NextResponse.json({ error: lockErr }, { status: 409 })
      }

      const { db } = await import('@/lib/firebase')
      const { doc, getDoc, updateDoc, deleteField } = await import('@/lib/fsdb')
      // ソースエントリを取得
      const attData = await getAttendanceDoc(ym)
      const fromKey = `${fromSiteId}_${workerId}_${ym}_${String(day)}`
      const sourceEntry = attData[fromKey] as AttendanceEntry | undefined
      if (!sourceEntry) {
        return NextResponse.json({ error: '移動元のエントリが見つかりません' }, { status: 404 })
      }
      // ベトナム人スタッフであることを確認（業務ルール）
      const mainSnap = await getDoc(doc(db, 'demmen', 'main'))
      let isVietnamese = false
      let workerName = ''
      if (mainSnap.exists()) {
        const workers = (mainSnap.data().workers || []) as { id: number; visa?: string; name?: string }[]
        const tw = workers.find(w => w.id === Number(workerId))
        if (tw) {
          workerName = tw.name || ''
          const { isVietnameseWorker } = await import('@/lib/attendance')
          isVietnamese = isVietnameseWorker(tw.visa)
        }
      }
      if (!isVietnamese) {
        return NextResponse.json({ error: 'ベトナムスタッフ以外は対象外です' }, { status: 403 })
      }

      // 自現場に既存エントリがあれば移動拒否（上書き事故を防ぐ）
      const toKey = `${site.id}_${workerId}_${ym}_${String(day)}`
      if (attData[toKey]) {
        return NextResponse.json({ error: '移動先の現場に既にエントリがあります。先にそちらを削除してください。' }, { status: 409 })
      }

      // 新エントリ = ソースのコピー + s:'foreman' で出所を記録
      const movedEntry: AttendanceEntry = { ...sourceEntry, s: 'foreman' }

      // 1. 自現場に書き込み
      const { computeAttendanceDeleteFields } = await import('@/lib/attendance')
      const deleteFields = computeAttendanceDeleteFields(movedEntry)
      await setAttendanceEntry(site.id, workerId, ym, day, movedEntry, { deleteFields })

      // 2. 元現場のエントリを削除（dot-notation で安全に削除）
      const docRef = doc(db, 'demmen', `att_${ym}`)
      await updateDoc(docRef, { [`d.${fromKey}`]: deleteField() })

      // 監査ログ
      try {
        const { logActivity } = await import('@/lib/activity')
        await logActivity(
          String(foreman.id),
          'attendance.fixSite',
          `${workerName} (${workerId}) の ${ym}/${day} 入力を ${fromSiteId} → ${site.id} へ移動`,
        )
      } catch { /* ignore */ }

      return NextResponse.json({ success: true, entry: movedEntry })
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  } catch (error) {
    console.error('Foreman POST error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
