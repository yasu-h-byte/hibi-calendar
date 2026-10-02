import { NextRequest, NextResponse } from 'next/server'
import { getWorkerByToken, isEmployedOn } from '@/lib/workers'
import {
  getAttendanceDoc,
  getApprovalForDay,
  setApprovalForDay,
  getForemanSite,
  getEntryStatus,
  ymKey,
  formatDateKanji,
  formatDateShort,
} from '@/lib/attendance'
import { AttendanceEntry, DEFAULT_WORK_SCHEDULE } from '@/types'
import { recordAccess, getRequestIp } from '@/lib/accessLog'
import { staffEntryTarget, familyEntrySiteId, type HierarchySite, type WorkTypeAssignMap } from '@/lib/site-hierarchy'
import { loadSiteFamily, familyEntry, approveDaysForSite, siteMonthDays, siteRosterFromMain, loadSiteRoster } from '@/lib/foreman-todo'
import { getMainData, getAttData, parseDKey } from '@/lib/compute'
import { canDriveDefault, driversByDayForSite } from '@/lib/allowance'
import { todayJstDate } from '@/lib/date-utils'
import {
  attendanceDateError, isoOfYmDay, dayApprovalOf, finalApprovedEditError, writeAttendanceEntry, moveAttendanceEntry,
  COMP_NON_WORKING_DAY_MESSAGE,
} from '@/lib/attendance-save'

// 工種（親＋工種サイト）の範囲・まとめ承認の判定はマイページと共通（lib/foreman-todo.ts・2026-10-01）

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get('token')
  const dateParam = request.nextUrl.searchParams.get('date') // YYYY-MM-DD
  const siteIdParam = request.nextUrl.searchParams.get('siteId') // 2現場以上を持つ職長が現場を選ぶとき（2026-10-02）

  if (!token) {
    return NextResponse.json({ error: 'token required' }, { status: 400 })
  }

  try {
    const foreman = await getWorkerByToken(token)
    if (!foreman) {
      return NextResponse.json({ error: 'この URL は無効です。会社に連絡してください / URL không hợp lệ' }, { status: 401 })
    }

    // 見ている日の月（担当現場はその月の職長で決める・2026-10-02 総合点検。旧: 常に今月の職長で、交代の前後で食い違った）
    const viewYmForSite = /^\d{4}-\d{2}-\d{2}$/.test(dateParam || '') ? (dateParam as string).slice(0, 7).replace('-', '') : undefined
    // 職種が職長の人だけ（職長でない人が現場の職長に登録されている現場は政仁さんが代行・2026-10-01 代表）
    const site = foreman.jobType === 'shokucho' ? await getForemanSite(foreman.id, viewYmForSite, siteIdParam) : null
    if (!site) {
      return NextResponse.json({ error: 'この月はあなたが職長の現場がありません（職長の交代の前後は月ごとに決まります）' }, { status: 403 })
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
    // 「今日」は日本時間（サーバは UTC。旧: 0〜9時に今日を開くと前日へ戻されていた・2026-10-01）
    const today = todayJstDate()
    let viewDate: Date = dateParam ? new Date(dateParam + 'T00:00:00') : today

    // Don't go past today
    if (viewDate > today) viewDate = today

    const y = viewDate.getFullYear()
    const m = viewDate.getMonth() + 1
    const d = viewDate.getDate()
    const ym = ymKey(y, m)

    // Get attendance data（運転者の記録 drv も同じ1回の読みで取る・2026-10-02）
    const attRaw = await getAttData(ym)
    const attData = attRaw.d as Record<string, AttendanceEntry>

    // ── 別現場で入力済みの検出 ──
    // ベトナム人スタッフが現場を間違えて他現場に入力した場合、職長が修正できるよう
    // 当該日の他現場の入力を検出する。
    // attData の key 形式: "{siteId}_{workerId}_{ym}_{day}"
    // 当該 ym と day で他の siteId 配下のエントリを抽出
    const dayStr = String(d)
    // main は最新を1回だけ読む（名簿・工種の範囲・現場名・勤務時間をここから作る）
    const main = await getMainData({ fresh: true })
    const siteNameMap: Record<string, string> = {}
    for (const s of main.sites) siteNameMap[s.id] = s.name
    // 代理入力の初期値用（2026-08-28 追加: 時刻つき代理入力）
    const siteSchedule = main.sites.find(x => x.id === site.id)?.workSchedule as import('@/types').SiteWorkSchedule | undefined
    // 表示している日の月の名簿（2026-10-01: 旧は常に今月の配置で、前月を開くと俯瞰とまとめ承認で名簿が食い違った）。
    //   名簿の決まりはマイページ・まとめ承認と共通（lib/foreman-todo.ts siteRosterFromMain）。
    //   同じ現場（親＋工種サイト）。工種の無い現場は [site.id] だけ
    const roster = siteRosterFromMain(main, site.id, ym)
    const { workers: foreignWorkers, family } = roster
    // 配置外の入力（この現場に入力があるのに配置に入っていない人・2026-10-02 点検）。PC の出面画面の「配置外」と同じ考え方
    const offByDay = roster.offRosterOf(attData)

    // workerId → { siteId, name, entry } のマップを構築
    const crossSiteEntries: Record<number, { siteId: string; siteName: string; entry: AttendanceEntry }[]> = {}
    for (const [key, entry] of Object.entries(attData)) {
      if (!entry || typeof entry !== 'object') continue
      // キーの分解は共通（lib/compute.ts parseDKey・2026-10-02 総合点検。旧: split で自前に分けていた）
      const { sid: keySid, wid: keyWid, ym: keyYm, day: keyDay } = parseDKey(key)
      if (keyYm !== ym) continue
      if (keyDay !== dayStr) continue
      if (family.includes(keySid)) continue   // 自現場（工種サイトを含む）は除外
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
    //   その日に在籍していない人（入社前・退職後）は出さない（2026-10-02・未入力に数えていた）
    const viewIso = `${ym.slice(0, 4)}-${ym.slice(4, 6)}-${String(d).padStart(2, '0')}`
    const workers = [
      ...foreignWorkers.filter(w => isEmployedOn(w, viewIso)),
      ...(offByDay.get(d) || []).map(x => ({ ...x, offRoster: true as const })),
    ].map(w => {
      const entry = familyEntry(attData, family, w.id, ym, d) || null
      const misplaced = crossSiteEntries[w.id] || []
      return {
        id: w.id,
        name: w.name,
        entry,
        status: getEntryStatus(entry),
        offRoster: 'offRoster' in w ? true : undefined,
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
    // 日ごとの状態はマイページの「承認すること」と共通（lib/foreman-todo.ts）。
    //   別の現場で入力している人（移動・掛け持ち）は未入力に数えない（2026-10-01 代表決定）
    const monthOverview = (await siteMonthDays(site.id, ym, { att: attData, family, workers: foreignWorkers, offRosterOf: roster.offRosterOf })).map(dd => ({
      day: dd.day,
      dateISO: dd.dateISO,
      isWorkDay: dd.isWorkDay,
      approved: dd.approved,
      entered: dd.entered,
      missingNames: dd.isWorkDay ? dd.missingNames : [],
      offRosterNames: dd.offRoster,
    }))

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
      // 応援現場か（取りまとめ役を「責任者」と呼ぶ・2026-09-30）
      site: { id: site.id, name: site.name, isSupport: (await import('@/lib/companies')).isSupportSite(site as never, main.sites as never) },
      // この月に担当する親現場（2現場以上なら画面で選べるように返す・?siteId= で切り替え・2026-10-02）
      foremanSites: site.foremanSites,
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
      // 運転者（運転手当）: その日の記録と、運転手当を出さない現場か（2026-10-02）
      // 親＋工種のキーをまとめて見せる（PC の工種画面で記録した分も見える・2026-10-02）
      drivers: driversByDayForSite((attRaw as { drv?: Record<string, { am?: number[]; pm?: number[] }> }).drv, main.sites, site.id, ym)[d] || null,
      // 運転者の候補: その日この現場（親＋工種）で出勤（0.6補・休みを除く）した、運転しうる人（日本人を含む・PC と同じ）
      driverCandidates: (() => {
        const out: { id: number; name: string }[] = []
        for (const w of main.workers) {
          const e = familyEntry(attData, family, w.id, ym, d) as (AttendanceEntry & { ns?: unknown }) | undefined
          if (!e) continue
          const wv = e.w || 0
          if (!((wv > 0 && wv !== 0.6) || !!e.ns)) continue
          if (!canDriveDefault(w as never)) continue
          out.push({ id: w.id, name: w.name })
        }
        return out
      })(),
      noDriveAllowance: !!(site as { noDriveAllowance?: boolean }).noDriveAllowance,
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
      return NextResponse.json({ error: 'この URL は無効です。会社に連絡してください / URL không hợp lệ' }, { status: 401 })
    }

    // 対象の月の職長か（2026-10-02 総合点検: 旧は今月の職長で判定し、交代の前後で前月を承認できる人が食い違った）
    const ymBody = Number.isInteger(Number(body.year)) && Number.isInteger(Number(body.month))
      ? ymKey(Number(body.year), Number(body.month)) : undefined
    // 職種が職長の人だけ（職長でない人が現場の職長に登録されている現場は政仁さんが代行・2026-10-01 代表）
    const site = foreman.jobType === 'shokucho' ? await getForemanSite(foreman.id, ymBody, body.siteId) : null
    if (!site) {
      return NextResponse.json({ error: 'この月はあなたが職長の現場がありません（職長の交代の前後は月ごとに決まります）' }, { status: 403 })
    }

    // 便ごとの運転者（運転手当）を保存（2026-10-02 点検: 職長のスマホ画面から記録できなかった）。決まりは PC と共通（lib/drivers.ts）
    if (action === 'saveDrivers') {
      const { year, month, day, am, pm } = body
      const { saveSiteDrivers } = await import('@/lib/drivers')
      const r = await saveSiteDrivers({ ym: ymKey(year, month), siteId: site.id, day, am, pm, actorLabel: `職長スマホ ${foreman.name}` })
      if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status })
      return NextResponse.json({ success: true })
    }

    if (action === 'approve') {
      const { year, month, day } = body
      const ym = ymKey(year, month)
      // 2026-09-02 追加（大川さんの 9/1 誤承認事故の再発防止）:
      //   誰も入力していない日を承認するとスタッフ入力がロックされ、
      //   「9月から入力できない」状態を作ってしまう。全員未入力の日は拒否する。
      {
        const attD = await getAttendanceDoc(ym)
        // 名簿はその日の月の配置（一覧・まとめ承認と同じ決まり・2026-10-01）
        const { workers: roster, family } = await loadSiteRoster(site.id, ym)
        const dayIso = `${ym.slice(0, 4)}-${ym.slice(4, 6)}-${String(day).padStart(2, '0')}`
        const ws = roster.filter(w => isEmployedOn(w, dayIso))   // その日に在籍している人だけ（入社前・退職後を除く）
        const enteredCount = ws.filter(w =>
          getEntryStatus(familyEntry(attD, family, w.id, ym, day)) !== 'none').length
        if (ws.length > 0 && enteredCount === 0) {
          return NextResponse.json({
            error: 'この日はまだ誰も入力していません。承認するとスタッフが入力できなくなるため、承認できません。',
          }, { status: 409 })
        }
      }
      await setApprovalForDay(site.id, ym, day, foreman.id)
      return NextResponse.json({ success: true })
    }

    // 2026-09-02 追加: 職長が自分で承認を取り消せるようにする。
    //   従来は解除手段がPC画面にしかなく、誤承認するとスマホから復旧できなかった。
    //   最終承認（政仁さん）が入った日は職長からは取り消せない。
    if (action === 'unapprove') {
      const { year, month, day } = body
      const ym = ymKey(year, month)
      const cur = await getApprovalForDay(site.id, ym, day)
      if (cur?.final) {
        return NextResponse.json({
          error: 'この日は最終承認済みのため取り消せません。管理者に連絡してください。',
        }, { status: 409 })
      }
      const { removeForemanApprovalForDay } = await import('@/lib/attendance')
      await removeForemanApprovalForDay(site.id, ym, day)
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
      const { approvedDays, skipped } = await approveDaysForSite(site.id, ym, days, foreman.id)
      return NextResponse.json({ success: true, approvedDays, skipped })
    }

    if (action === 'edit') {
      const { workerId: workerIdRaw, year, month, day, choice, overtimeHours } = body
      const ym = ymKey(year, month)
      const workerId = Number(workerIdRaw)
      const dayNum = Number(day)
      // 2026-10-02 総合点検: 実在しない日（9月31日）・" 5" のような日を断る（PC の出面入力と同じ共通の決まり）
      {
        const dateErr = attendanceDateError(ym, day)
        if (dateErr) return NextResponse.json({ error: dateErr }, { status: 400 })
      }
      if (!Number.isInteger(workerId)) return NextResponse.json({ error: 'workerId が正しくありません' }, { status: 400 })
      const dayIso = isoOfYmDay(ym, dayNum)

      // 2026-06-12 (監査 Sprint2-B): ロック済み月への職長編集を拒否（給与確定後のデータ変更防止）
      {
        // その人の会社が締め済みなら拒否（会社なしで呼ぶと「両社とも締めたときだけ」になる・2026-10-02 総合点検）
        const { checkMonthLockedForWorkers } = await import('@/lib/locks')
        const lockErr = await checkMonthLockedForWorkers(ym, [workerId])
        if (lockErr) return NextResponse.json({ error: lockErr }, { status: 409 })
      }

      // 対象者・名簿（2026-10-02 総合点検）: 旧は workerId を確かめず、人員マスタに居ない人は確かめを全部飛ばして書き、
      //   名簿に無い人（日本人・他現場の人）も API を直接呼べば自現場に出勤を作れた。
      //   名簿＝この現場×月の配置（外国人・lib/foreman-todo.ts siteRosterFromMain）＋その日この現場に入力がある配置外の人（画面に出ている人と同じ）
      const mainE = await getMainData({ fresh: true })
      const targetWorker = mainE.workers.find(w => w.id === workerId)
      if (!targetWorker) return NextResponse.json({ error: '対象の人が人員マスタに見つかりません' }, { status: 400 })
      const rosterE = siteRosterFromMain(mainE, site.id, ym)
      const dData = await getAttendanceDoc(ym)
      const onRosterE = rosterE.workers.some(w => w.id === workerId)
        || (rosterE.offRosterOf(dData).get(dayNum) || []).some(x => x.id === workerId)
      if (!onRosterE) {
        return NextResponse.json({ error: `${targetWorker.name} さんはこの現場のこの月の名簿にいません（配置は PC の出面画面で直してください）` }, { status: 403 })
      }
      // 入社前・退職後の日には入れない（PC・スタッフのスマホと同じ・2026-10-02 点検）
      if (!isEmployedOn(targetWorker, dayIso)) {
        return NextResponse.json({ error: 'この人はこの日に在籍していません（入社前・退職後）' }, { status: 400 })
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
      // 書き込み先の工種（鉄骨・仮設など）。スタッフのスマホと同じ決め方（lib/site-hierarchy.ts staffEntryTarget）
      const editTarget = staffEntryTarget(
        mainE.sites as unknown as HierarchySite[], mainE.assign as unknown as WorkTypeAssignMap | undefined,
        dData, site.id, workerId, ym, dayNum,
      ).targetSiteId
      // 保存前のこの日のエントリ（下のガードと履歴で使い回す。null = 無かった）
      const foremanPrevEntry: AttendanceEntry | null = (dData[`${editTarget}_${workerId}_${ym}_${dayNum}`] as AttendanceEntry | undefined) ?? null
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
            // o（残業h）は保存の共通入口 setAttendanceEntry が現場の休憩設定で付け直す（2026-10-02）。
            //   旧: ここでは o を保存しなかったため、o を読む請求書（HFU → 日比建設・応援）や
            //   月次の残業合計に、職長が入れた日の残業だけ乗らなかった（スタッフ本人の入力は o を持つ）。
            break
          }
          entry = { w: 1, o: Math.max(0, Math.min(8, overtimeHours || 0)), s: 'foreman' }
          break
        case 'rest': {
          entry = { w: 0, r: 1, s: 'foreman' }
          // 2026-08-27（休暇届総点検）: スタッフが出した欠勤届の理由(rReason/rNote)を
          //   職長の「休み」確認で消さない。旧: 残骸掃除が理由も削除し、
          //   ダッシュボードの欠勤届一覧から届が黙って消えていた
          const prevR = familyEntry(dData, rosterE.family, workerId, ym, dayNum) as { rReason?: string; rNote?: string } | undefined
          if (prevR?.rReason) (entry as { rReason?: string }).rReason = prevR.rReason
          if (prevR?.rNote) (entry as { rNote?: string }).rNote = prevR.rNote
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

      // 最終承認済みの日は職長からは変えられない（事業責任者・代表だけ・2026-10-02 総合点検。lib/attendance-save.ts）
      {
        const ap = await dayApprovalOf(mainE.sites as unknown as HierarchySite[], site.id, ym, dayNum)
        const finalErr = finalApprovedEditError(ap, false)
        if (finalErr) return NextResponse.json({ error: finalErr }, { status: 409 })
      }

      // ベトナム人スタッフのガード: 「最初の入力はスタッフ本人から」を強制。
      // ただし事後申請性ステータス（有給/帰国中）は admin/foreman の後付け入力を許容。
      try {
        const { canAdminEditEntry, detectMultiSiteConflict } = await import('@/lib/attendance')
        // 事後申請性ステータス例外を許容するため newEntry を渡す
        const check = canAdminEditEntry({ visa: targetWorker.visa }, foremanPrevEntry, entry)
        if (!check.editable) {
          return NextResponse.json({ error: check.reason || '編集不可' }, { status: 403 })
        }
        // 同日多現場ガード: 物理的に不可能な「同種シフト併記」を防ぐ
        const conflict = detectMultiSiteConflict(dData, editTarget, workerId, ym, dayNum, mainE.sites as never)
        if (conflict) {
          const cName = mainE.sites.find(s => s.id === conflict.conflictSiteId)?.name || conflict.conflictSiteId
          const shiftLabel = conflict.shiftType === 'night' ? '夜勤' : '日勤'
          return NextResponse.json({
            error: `既に「${cName}」（${shiftLabel}）で同日の出面が登録されています。先にそちらを取り消すか「現場違い修正」機能で移動してください。`,
            conflictSiteId: conflict.conflictSiteId,
          }, { status: 409 })
        }
      } catch (e) {
        // ⚠️ fail-closed: 判定不能時は拒否（2026-05-08 修正）
        console.error('Multi-site guard error (foreman):', e)
        return NextResponse.json({ error: 'ガード判定に失敗しました（一時的な障害の可能性）' }, { status: 503 })
      }

      // ── 承認済み有給(p)の保護（2026-09-02 追加・有給総点検 第4回）──
      //   承認済みの有給の日を職長が別ステータスで上書きすると p だけ消え、申請は approved の
      //   まま残数が黙って戻る（staff 経路には 2026-08-27 から同じ保護がある）。
      if (choice !== 'leave' && foremanPrevEntry?.p) {
        return NextResponse.json({
          error: 'この日は有給として登録済みです。変更が必要な場合は管理者に連絡してください',
        }, { status: 409 })
      }
      // ── 稼働日ガード（2026-09-02 追加）: 申請・スタッフ経路と同じ基準。
      //   所定休への有給は「20日枠超の有給日給」の過払いになる（2026-06 社労士対応）。
      // 2026-09-30（代表決定）: 有給は前日まで。職長の代理入力でも当日・過ぎた日は入れられない
      if (choice === 'leave') {
        const { leaveRequestDateError } = await import('@/lib/leave-rules')
        const { todayJstIso: tj } = await import('@/lib/date-utils')
        const dErr = leaveRequestDateError(dayIso, tj())
        if (dErr) return NextResponse.json({ error: dErr }, { status: 400 })
      }
      // 有給・0.6補（会社都合の休み）は、カレンダーの仕事の日だけ（スタッフのスマホと同じ決まり・2026-10-02 総合点検）
      //   旧: 0.6補は職長・PC・一括入力から休みの日にも入れられ、休業手当（60%）の過払いになりえた
      if (choice === 'leave' || (choice === 'comp' && foremanPrevEntry?.w !== 0.6)) {
        const { isScheduledWorkDay: iswd } = await import('@/lib/attendance')
        if (!await iswd(site.id, dayIso)) {
          return NextResponse.json({
            error: choice === 'leave'
              ? 'この日は現場の非稼働日のため有給にできません（休日・所定休は対象外）'
              : COMP_NON_WORKING_DAY_MESSAGE,
          }, { status: 400 })
        }
      }

      // ── 有給の残数チェック（2026-08-04 追加 / 有給システム総点検）──
      //   職長の代理入力（choice='leave'）はこれまで残数を一切見ていなかった。
      //   出面グリッド・スタッフ入力・時季指定と同じ共通ヘルパーで判定する。
      //   職長には超過の上書き権限を与えない（超過が必要な例外は管理者が行う）。
      if (choice === 'leave') {
        try {
          const { getLeaveBalance } = await import('@/lib/leave-balance')
          // 2026-09-02 修正: 基準日を対象日に（今日の付与期で判定していた）
          const bal = await getLeaveBalance(workerId, dayIso, dayIso)
          if (bal.remaining <= 0) {
            return NextResponse.json({
              error: bal.noGrant
                ? 'このスタッフは有給が付与されていません。管理者に連絡してください。'
                : bal.periodOver
                  ? '有給の期が終わり、次の付与の手続きがまだです。事務所に連絡してください。'
                  : `有給の残日数が 0 日です（枠 ${bal.total}日 / 消化 ${bal.used}日）。管理者に連絡してください。`,
            }, { status: 409 })
          }
        } catch (chkErr) {
          // 残チェック不能時は従来動作を維持（業務を止めない）。ログのみ残す
          console.warn('[foreman/leave] 残チェック失敗:', chkErr)
        }
      }

      // 保存は共通の入口（変更履歴 → 残骸の掃除つき保存・2026-10-02 総合点検。旧: 履歴も操作ログも残らなかった）
      await writeAttendanceEntry({
        siteId: editTarget, workerId, ym, day: dayNum, entry, prevEntry: foremanPrevEntry, actor: `foreman:${foreman.id}`,
      })
      try {
        const { logActivity } = await import('@/lib/activity')
        const label = choice === 'work' ? (entry.st ? `出勤 ${entry.st}-${entry.et}` : `出勤${entry.o ? `+${entry.o}h` : ''}`)
          : choice === 'rest' ? '欠勤' : choice === 'leave' ? '有給' : choice === 'site_off' ? '現場休' : '0.6補'
        await logActivity(String(foreman.id), 'attendance.foremanEdit',
          `${targetWorker.name} (${workerId}) ${ym}/${dayNum} → ${label}（職長トークン ${foreman.name}・${editTarget}）`)
      } catch { /* ログ失敗は本体処理に影響させない */ }
      return NextResponse.json({ success: true, entry })
    }

    // ── 別現場で入力されたエントリを自現場へ移動（現場間違い修正） ──
    // ベトナムスタッフが現場を間違えて他現場で入力した場合に、職長が
    // 「ここに移動」できる。ソース現場のエントリは deleteField で消す。
    if (action === 'fix_site') {
      const { workerId: widRaw, year, month, day, fromSiteId } = body as {
        workerId: number
        year: number
        month: number
        day: number
        fromSiteId: string
      }
      if (!widRaw || !year || !month || !day || !fromSiteId) {
        return NextResponse.json({ error: 'workerId, year, month, day, fromSiteId は必須です' }, { status: 400 })
      }
      const workerId = Number(widRaw)
      const ym = ymKey(year, month)
      // 2026-10-02 総合点検: 実在しない日を断る（共通の決まり）
      {
        const dateErr = attendanceDateError(ym, day)
        if (dateErr) return NextResponse.json({ error: dateErr }, { status: 400 })
      }
      const dayNum = Number(day)
      const famFix = await loadSiteFamily(site.id)
      if (famFix.family.includes(fromSiteId)) {
        // 工種（鉄骨・仮設）の切り替えは現場違いではない。PC・職長スマホの出面画面の工種タグで行う
        return NextResponse.json({ error: '自現場（工種を含む）のエントリは移動できません。工種の切り替えは出面画面の工種タグから行ってください' }, { status: 400 })
      }

      // 2026-06-12 (監査 Sprint2-B): ロック済み月の現場間移動を拒否
      {
        const { checkMonthLockedForWorkers } = await import('@/lib/locks')
        const lockErr = await checkMonthLockedForWorkers(ym, [workerId])
        if (lockErr) return NextResponse.json({ error: lockErr }, { status: 409 })
      }

      // ソースエントリを取得
      const attData = await getAttendanceDoc(ym)
      const fromKey = `${fromSiteId}_${workerId}_${ym}_${dayNum}`
      const sourceEntry = attData[fromKey] as AttendanceEntry | undefined
      if (!sourceEntry) {
        return NextResponse.json({ error: '移動元のエントリが見つかりません' }, { status: 404 })
      }
      // ベトナム人スタッフであることを確認（業務ルール）。対象者が人員マスタに居なければ断る（2026-10-02 総合点検）
      const mainF = await getMainData({ fresh: true })
      const tw = mainF.workers.find(w => w.id === workerId)
      if (!tw) return NextResponse.json({ error: '対象の人が人員マスタに見つかりません' }, { status: 400 })
      {
        const { isVietnameseWorker } = await import('@/lib/attendance')
        if (!isVietnameseWorker(tw.visa)) {
          return NextResponse.json({ error: 'ベトナムスタッフ以外は対象外です' }, { status: 403 })
        }
      }
      const workerName = tw.name || ''

      // 自現場（工種を含む）に既存エントリがあれば移動拒否（上書き事故を防ぐ）
      if (familyEntrySiteId(attData, famFix.family, workerId, ym, dayNum)) {
        return NextResponse.json({ error: '移動先の現場に既にエントリがあります。先にそちらを削除してください。' }, { status: 409 })
      }
      // 移動元の日が承認済み（職長承認・最終承認）なら動かさない（2026-10-02 総合点検）。
      //   承認した職長・事業責任者の見た内容が黙って消える。先に移動元の現場で承認を外してもらう
      {
        const apFrom = await dayApprovalOf(mainF.sites as unknown as HierarchySite[], fromSiteId, ym, dayNum)
        if (apFrom.foreman || apFrom.final) {
          const fromName = mainF.sites.find(s => s.id === fromSiteId)?.name || fromSiteId
          return NextResponse.json({ error: `移動元の「${fromName}」のこの日は承認済みのため移動できません。先にそちらの承認を外してもらってください` }, { status: 409 })
        }
        // 自現場の日が最終承認済みなら、職長からは変えられない（edit と同じ）
        const apTo = await dayApprovalOf(mainF.sites as unknown as HierarchySite[], site.id, ym, dayNum)
        const finalErr = finalApprovedEditError(apTo, false)
        if (finalErr) return NextResponse.json({ error: finalErr }, { status: 409 })
      }

      // 移動先の工種は、その日の工種指定・本人の既定に従う（無ければ親現場）
      const fixTarget = staffEntryTarget(famFix.sites, famFix.assign, attData, site.id, workerId, ym, dayNum).targetSiteId
      // 書きと消しを1回の updateDoc で（2026-10-02 総合点検・lib/attendance-save.ts。旧: 2回に分け、2回目の失敗で二重に残った）。
      //   同じ日の中で現場を移すだけなので、その日の有給の有無は変わらない（繰越の再計算は不要）
      const movedEntry = await moveAttendanceEntry({
        fromSiteId, toSiteId: fixTarget, workerId, ym, day: dayNum, entry: sourceEntry, source: 'foreman', actor: `foreman:${foreman.id}`,
      })

      // 監査ログ
      try {
        const { logActivity } = await import('@/lib/activity')
        await logActivity(
          String(foreman.id),
          'attendance.fixSite',
          `${workerName} (${workerId}) の ${ym}/${dayNum} 入力を ${fromSiteId} → ${fixTarget} へ移動`,
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
