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
import { AttendanceEntry } from '@/types'
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
    {
      const { db } = await import('@/lib/firebase')
      const { doc, getDoc } = await import('firebase/firestore')
      const mainSnap = await getDoc(doc(db, 'demmen', 'main'))
      if (mainSnap.exists()) {
        const sites = (mainSnap.data().sites || []) as { id: string; name: string }[]
        for (const s of sites) siteNameMap[s.id] = s.name
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

    if (action === 'edit') {
      const { workerId, year, month, day, choice, overtimeHours } = body
      const ym = ymKey(year, month)

      // ベトナム人スタッフのガード: 「最初の入力はスタッフ本人から」を強制。
      // 既存エントリなしの場合、職長からの新規作成を拒否。
      try {
        const { canAdminEditEntry, detectMultiSiteConflict, getAttendanceDoc } = await import('@/lib/attendance')
        const { db } = await import('@/lib/firebase')
        const { doc, getDoc } = await import('firebase/firestore')
        const mainSnap = await getDoc(doc(db, 'demmen', 'main'))
        if (mainSnap.exists()) {
          const workers = (mainSnap.data().workers || []) as { id: number; visa?: string }[]
          const sitesAll = (mainSnap.data().sites || []) as { id: string; name: string; shiftType?: 'day' | 'night'; workSchedule?: { startTime?: string } }[]
          const targetWorker = workers.find(w => w.id === Number(workerId))
          if (targetWorker) {
            const dData = await getAttendanceDoc(ym)
            const key = `${site.id}_${workerId}_${ym}_${String(day)}`
            const existing = dData[key]
            const check = canAdminEditEntry({ visa: targetWorker.visa }, existing)
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

      // Build entry with s:'foreman' source tracking
      // ⚠️ 2026-05-09 根本原因対処: ステータス変更時に古いフィールドを残さない
      //   computeAttendanceDeleteFields で「新エントリに含まれない既知フィールドを自動算出」
      let entry: AttendanceEntry
      switch (choice) {
        case 'work':
          entry = { w: 1, o: Math.max(0, Math.min(8, overtimeHours || 0)), s: 'foreman' }
          break
        case 'rest':
          entry = { w: 0, r: 1, s: 'foreman' }
          break
        case 'leave':
          entry = { w: 0, p: 1, s: 'foreman' }
          break
        case 'site_off':
          entry = { w: 0, h: 1, s: 'foreman' }
          break
        default:
          return NextResponse.json({ error: 'Invalid choice' }, { status: 400 })
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

      const { db } = await import('@/lib/firebase')
      const { doc, getDoc, updateDoc, deleteField } = await import('firebase/firestore')
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
