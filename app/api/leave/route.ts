import { NextRequest, NextResponse } from 'next/server'
import { checkApiAuth } from '@/lib/auth'
import { db } from '@/lib/firebase'
import { doc, getDoc, updateDoc } from 'firebase/firestore'
import { getMainData, getAttData, parseDKey } from '@/lib/compute'
import { ymKey } from '@/lib/attendance'

/** 法定有給付与日数を計算 */
function calcLegalPL(hireDate: string, grantDate: string): number {
  if (!hireDate || !grantDate) return 0
  const hire = new Date(hireDate)
  const grant = new Date(grantDate)
  if (isNaN(hire.getTime()) || isNaN(grant.getTime())) return 0

  // 月数ベースで計算（浮動小数点誤差を回避）
  const diffMonths = (grant.getFullYear() - hire.getFullYear()) * 12
    + (grant.getMonth() - hire.getMonth())
    + (grant.getDate() >= hire.getDate() ? 0 : -1)

  if (diffMonths < 6) return 0
  if (diffMonths < 18) return 10
  if (diffMonths < 30) return 11
  if (diffMonths < 42) return 12
  if (diffMonths < 54) return 14
  if (diffMonths < 66) return 16
  if (diffMonths < 78) return 18
  return 20
}

export async function POST(request: NextRequest) {
  if (!await checkApiAuth(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const body = await request.json()
    const { action } = body

    const docRef = doc(db, 'demmen', 'main')
    const snap = await getDoc(docRef)
    if (!snap.exists()) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    // 本日のJST日付を YYYY-MM-DD で返す（Vercelサーバーは UTC のため補正）
    const todayJST = () => {
      const now = new Date()
      const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000)
      return jst.toISOString().slice(0, 10)
    }

    if (action === 'getPendingGrants') {
      // 付与時期を迎えているが未付与のワーカー一覧を返す（半自動付与用）
      const data = snap.data()
      type Worker = { id: number; name: string; retired?: boolean; job?: string; visa?: string; hireDate?: string }
      type PLRecord = { fy: string | number; grantDate?: string; grantDays?: number; grant?: number; carryOver?: number; carry?: number; adjustment?: number; adj?: number }
      const workers = (data.workers || []) as Worker[]
      const plData = (data.plData || {}) as Record<string, PLRecord[]>

      const today = todayJST()
      const todayDate = new Date(today)

      type PendingGrant = {
        workerId: number
        name: string
        visa: string
        hireDate: string
        tenureText: string
        nextGrantDate: string
        fy: string
        legalDays: number
        reason: string
      }
      const pending: PendingGrant[] = []

      // 在籍月数テキスト
      const tenureTextOf = (hireDate: string, at: string): string => {
        if (!hireDate) return '入社日未登録'
        const h = new Date(hireDate)
        const a = new Date(at)
        if (isNaN(h.getTime()) || isNaN(a.getTime())) return '入社日未登録'
        let months = (a.getFullYear() - h.getFullYear()) * 12 + (a.getMonth() - h.getMonth())
        if (a.getDate() < h.getDate()) months -= 1
        if (months < 0) return '入社前'
        const y = Math.floor(months / 12)
        const m = months % 12
        if (y === 0) return `在籍 ${m}ヶ月`
        if (m === 0) return `在籍 ${y}年`
        return `在籍 ${y}年${m}ヶ月`
      }

      // レコードが「付与済み」とみなせるか
      const hasGrantForFy = (records: PLRecord[], fy: string): boolean =>
        records.some(r => String(r.fy) === fy && ((r.grantDays ?? 0) > 0 || (r.grant ?? 0) > 0))

      for (const w of workers) {
        if (w.retired) continue
        if (w.job === 'yakuin' || w.job === 'jimu') continue

        const records = plData[String(w.id)] || []
        const isJp = !w.visa || w.visa === 'none'

        if (isJp) {
          // 日本人: 10/1起点
          const y = todayDate.getFullYear()
          const m = todayDate.getMonth() + 1
          const currentFyStart = m >= 10 ? y : y - 1
          const expectedFy = String(currentFyStart)
          const expectedGrantDate = `${currentFyStart}-10-01`

          // その付与日が今日以前（= 既に過ぎている付与タイミング）で、対応FYレコードが未作成
          if (expectedGrantDate <= today && !hasGrantForFy(records, expectedFy)) {
            const legalDays = w.hireDate ? calcLegalPL(w.hireDate, expectedGrantDate) : 10
            pending.push({
              workerId: w.id,
              name: w.name,
              visa: w.visa || 'none',
              hireDate: w.hireDate || '',
              tenureText: tenureTextOf(w.hireDate || '', expectedGrantDate),
              nextGrantDate: expectedGrantDate,
              fy: expectedFy,
              legalDays,
              reason: `FY ${expectedFy} (${expectedGrantDate}~)の付与が未実施`,
            })
          }
        } else {
          // 外国人: 最新 grantDate + 1年
          const withGrant = records
            .filter(r => r.grantDate && ((r.grantDays ?? 0) > 0 || (r.grant ?? 0) > 0))
            .slice()
            .sort((a, b) => new Date(a.grantDate!).getTime() - new Date(b.grantDate!).getTime())
          const lastRec = withGrant[withGrant.length - 1]

          if (!lastRec) {
            // 初回付与候補: hireDate + 6ヶ月
            if (w.hireDate) {
              const hire = new Date(w.hireDate)
              if (!isNaN(hire.getTime())) {
                const firstGrant = new Date(hire)
                firstGrant.setMonth(firstGrant.getMonth() + 6)
                const firstGrantStr = firstGrant.toISOString().slice(0, 10)
                if (firstGrantStr <= today) {
                  const legalDays = calcLegalPL(w.hireDate, firstGrantStr)
                  pending.push({
                    workerId: w.id,
                    name: w.name,
                    visa: w.visa || '',
                    hireDate: w.hireDate,
                    tenureText: tenureTextOf(w.hireDate, firstGrantStr),
                    nextGrantDate: firstGrantStr,
                    fy: String(firstGrant.getFullYear()),
                    legalDays,
                    reason: '初回付与（入社6ヶ月経過）',
                  })
                }
              }
            }
            continue
          }

          const lastGrant = new Date(lastRec.grantDate!)
          if (isNaN(lastGrant.getTime())) continue
          const nextGrant = new Date(lastGrant)
          nextGrant.setFullYear(nextGrant.getFullYear() + 1)
          const nextGrantStr = nextGrant.toISOString().slice(0, 10)

          if (nextGrantStr <= today) {
            const nextFy = String(nextGrant.getFullYear())
            if (!hasGrantForFy(records, nextFy)) {
              const legalDays = w.hireDate ? calcLegalPL(w.hireDate, nextGrantStr) : 10
              pending.push({
                workerId: w.id,
                name: w.name,
                visa: w.visa || '',
                hireDate: w.hireDate || '',
                tenureText: tenureTextOf(w.hireDate || '', nextGrantStr),
                nextGrantDate: nextGrantStr,
                fy: nextFy,
                legalDays,
                reason: `前回付与(${lastRec.grantDate})から1年経過`,
              })
            }
          }
        }
      }

      return NextResponse.json({ pending })
    }

    if (action === 'executePendingGrants') {
      // 一括付与実行
      const { grants } = body as {
        grants: { workerId: number; fy: string; grantDate: string; grantDays: number }[]
      }
      if (!Array.isArray(grants) || grants.length === 0) {
        return NextResponse.json({ error: 'No grants to execute' }, { status: 400 })
      }

      const plData = (snap.data().plData || {}) as Record<string, { fy: string | number; grantDate?: string; grantDays?: number; carryOver?: number; adjustment?: number; grant?: number; carry?: number; adj?: number }[]>

      let granted = 0
      for (const g of grants) {
        const key = String(g.workerId)
        let records = plData[key] || []

        // 旧互換フィールドのクリーンアップ & fy正規化
        records = records.map(r => {
          const clean = { ...r } as Record<string, unknown>
          if (clean.grant !== undefined && (clean.grantDays === undefined || clean.grantDays === null)) clean.grantDays = clean.grant
          if (clean.carry !== undefined && (clean.carryOver === undefined || clean.carryOver === null)) clean.carryOver = clean.carry
          if (clean.adj !== undefined && (clean.adjustment === undefined || clean.adjustment === null)) clean.adjustment = clean.adj
          delete clean.grant
          delete clean.carry
          delete clean.adj
          if (clean.fy !== undefined) clean.fy = String(clean.fy)
          return clean as { fy: string; grantDate?: string; grantDays: number; carryOver: number; adjustment: number }
        })

        // 既にその fy のレコードがあればスキップ（安全策）
        const existsIdx = records.findIndex(r => String(r.fy) === String(g.fy))
        const newRec = {
          fy: String(g.fy),
          grantDate: g.grantDate,
          grantDays: Number(g.grantDays) || 0,
          carryOver: 0,
          adjustment: 0,
          used: 0,
        }
        if (existsIdx >= 0) {
          const existing = records[existsIdx] as { grantDays?: number; grant?: number }
          if (((existing.grantDays ?? 0) > 0) || ((existing.grant ?? 0) > 0)) {
            // 既に付与済み → スキップ
            continue
          }
          records[existsIdx] = { ...records[existsIdx], ...newRec }
        } else {
          records.push(newRec)
        }
        plData[key] = records
        granted++
      }

      await updateDoc(docRef, { plData })
      return NextResponse.json({ success: true, granted })
    }

    if (action === 'updateGrantMonth') {
      const { workerId, grantMonth } = body
      const workers = (snap.data().workers || []) as { id: number; grantMonth?: number }[]
      const wIdx = workers.findIndex(w => w.id === Number(workerId))
      if (wIdx < 0) return NextResponse.json({ error: 'Worker not found' }, { status: 404 })
      if (grantMonth === null || grantMonth === '' || grantMonth === undefined) {
        delete workers[wIdx].grantMonth
      } else {
        workers[wIdx].grantMonth = Number(grantMonth)
      }
      await updateDoc(docRef, { workers })
      return NextResponse.json({ success: true })
    }

    if (action === 'grant') {
      const { workerId, fy, grantDays, grantMonth, grantDate, carryOver: bodyCarryOver } = body
      const plData = (snap.data().plData || {}) as Record<string, { fy: string | number; grantDate?: string; grantDays: number; carryOver: number; adjustment: number; grant?: number; carry?: number; adj?: number }[]>
      const key = String(workerId)
      let records = plData[key] || []

      // === 旧アプリ互換フィールドの一括クリーンアップ & 重複FY集約 ===
      records = records.map(r => {
        const clean = { ...r } as Record<string, unknown>
        if (clean.grant !== undefined && (clean.grantDays === undefined || clean.grantDays === null)) {
          clean.grantDays = clean.grant
        }
        if (clean.carry !== undefined && (clean.carryOver === undefined || clean.carryOver === null)) {
          clean.carryOver = clean.carry
        }
        if (clean.adj !== undefined && (clean.adjustment === undefined || clean.adjustment === null)) {
          clean.adjustment = clean.adj
        }
        delete clean.grant
        delete clean.carry
        delete clean.adj
        if (clean.fy !== undefined) clean.fy = String(clean.fy)
        return clean as { fy: string; grantDate?: string; grantDays: number; carryOver: number; adjustment: number }
      })
      // 同じfyで重複があれば集約
      type PLRec = { fy: string; grantDate?: string; grantDays: number; carryOver: number; adjustment: number }
      const fyMap = new Map<string, PLRec>()
      for (const rRaw of records) {
        const r = rRaw as PLRec
        const k = String(r.fy)
        const existing = fyMap.get(k)
        if (!existing) {
          fyMap.set(k, r)
        } else {
          const winner = r.grantDays >= existing.grantDays ? r : existing
          const loser = r.grantDays >= existing.grantDays ? existing : r
          fyMap.set(k, { ...loser, ...winner, grantDate: winner.grantDate || loser.grantDate || '' })
        }
      }
      records = Array.from(fyMap.values())

      const idx = records.findIndex(r => String(r.fy) === String(fy))

      const record = {
        fy: String(fy),
        grantDate: grantDate || '',
        grantDays: Number(grantDays) || 0,
        carryOver: bodyCarryOver != null ? Number(bodyCarryOver) : 0,
        adjustment: 0,
        used: 0,
      }
      if (idx >= 0) {
        records[idx] = { ...records[idx], ...record } as { fy: string; grantDate?: string; grantDays: number; carryOver: number; adjustment: number }
      } else {
        records.push(record)
      }

      // Also store grantMonth on the worker if provided
      if (grantMonth) {
        const workers = (snap.data().workers || []) as { id: number; grantMonth?: number }[]
        const wIdx = workers.findIndex(w => w.id === Number(workerId))
        if (wIdx >= 0) {
          workers[wIdx].grantMonth = Number(grantMonth)
          plData[key] = records
          await updateDoc(docRef, { plData, workers })
        } else {
          plData[key] = records
          await updateDoc(docRef, { plData })
        }
      } else {
        plData[key] = records
        await updateDoc(docRef, { plData })
      }

      return NextResponse.json({ success: true })
    }

    if (action === 'carryOver') {
      const { fy } = body
      const prevFy = String(Number(fy) - 1)
      const plData = (snap.data().plData || {}) as Record<string, { fy: string; grantDays: number; carryOver: number; adjustment: number; grant?: number; carry?: number; adj?: number }[]>

      // Calculate previous FY PL usage
      const prevFyStart = parseInt(prevFy)
      const prevFyMonths: string[] = []
      for (let m = 10; m <= 12; m++) prevFyMonths.push(ymKey(prevFyStart, m))
      for (let m = 1; m <= 9; m++) prevFyMonths.push(ymKey(prevFyStart + 1, m))

      const allAtt: Record<string, Record<string, unknown>> = {}
      for (const ym of prevFyMonths) {
        const att = await getAttData(ym)
        Object.assign(allAtt, att.d)
      }

      const plUsage: Record<number, number> = {}
      for (const [key, entry] of Object.entries(allAtt)) {
        if (!entry) continue
        const e = entry as { p?: number | boolean }
        if (e.p) {  // 旧データ互換: truthy判定
          const pk = parseDKey(key)
          const wid = parseInt(pk.wid)
          plUsage[wid] = (plUsage[wid] || 0) + 1
        }
      }

      // workersデータを取得（日本人判定用）
      const mainData = snap.data()
      const workersList = (mainData.workers || []) as { id: number; visa?: string }[]
      const isJapanese = (wid: number) => {
        const w = workersList.find(x => x.id === wid)
        return !w?.visa || w.visa === 'none'
      }

      for (const [wid, records] of Object.entries(plData)) {
        // 日本人社員は期末買取制のため繰越なし → スキップ
        if (isJapanese(Number(wid))) continue

        const prevRec = records.find(r => r.fy === prevFy)
        if (!prevRec) continue
        // 旧フィールド(grant/carry/adj)のいずれかが存在すれば旧レコードと判定
        const isPrevOld = prevRec.grant != null || prevRec.adj != null || prevRec.carry != null
        const prevGrant = isPrevOld ? (prevRec.grant ?? prevRec.grantDays ?? 0) : (prevRec.grantDays || 0)
        const prevCarry = isPrevOld ? (prevRec.carry ?? 0) : (prevRec.carryOver || 0)
        const prevAdj = Math.max(prevRec.adjustment || 0, prevRec.adj || 0)
        const prevTotal = prevGrant + prevCarry
        const prevPeriodUsed = plUsage[Number(wid)] || 0
        const prevUsed = prevAdj + prevPeriodUsed
        const prevRemaining = Math.min(20, Math.max(0, prevTotal - prevUsed))  // 繰越上限20日

        const curIdx = records.findIndex(r => r.fy === fy)
        if (curIdx >= 0) {
          records[curIdx].carryOver = prevRemaining
        } else {
          records.push({ fy, grantDays: 0, carryOver: prevRemaining, adjustment: 0 })
        }
      }

      await updateDoc(docRef, { plData })
      return NextResponse.json({ success: true })
    }

    // Default: edit PL record
    const { workerId, fy, grantDays, carryOver, adjustment, grantDate } = body
    const plData = (snap.data().plData || {}) as Record<string, { fy: string | number; grantDate?: string; grantDays: number; carryOver: number; adjustment: number; grant?: number; carry?: number; adj?: number }[]>
    const key = String(workerId)
    let records = plData[key] || []

    // === 旧アプリ互換フィールドの一括クリーンアップ & 重複FYの集約 ===
    // すべてのレコードで grant→grantDays / carry→carryOver / adj→adjustment に昇格し、
    // 旧フィールドを削除する。また fy も String に正規化する。
    records = records.map(r => {
      const clean = { ...r } as Record<string, unknown>
      if (clean.grant !== undefined && (clean.grantDays === undefined || clean.grantDays === null)) {
        clean.grantDays = clean.grant
      }
      if (clean.carry !== undefined && (clean.carryOver === undefined || clean.carryOver === null)) {
        clean.carryOver = clean.carry
      }
      if (clean.adj !== undefined && (clean.adjustment === undefined || clean.adjustment === null)) {
        clean.adjustment = clean.adj
      }
      delete clean.grant
      delete clean.carry
      delete clean.adj
      if (clean.fy !== undefined) clean.fy = String(clean.fy)
      return clean as { fy: string; grantDate?: string; grantDays: number; carryOver: number; adjustment: number }
    })

    // 同じfyで重複レコードがあれば集約（過去のfy型ブレバグで発生した重複の修復）
    type PLRec2 = { fy: string; grantDate?: string; grantDays: number; carryOver: number; adjustment: number }
    const fyMap2 = new Map<string, PLRec2>()
    for (const rRaw of records) {
      const r = rRaw as PLRec2
      const k = String(r.fy)
      const existing = fyMap2.get(k)
      if (!existing) {
        fyMap2.set(k, r)
      } else {
        const winner = r.grantDays >= existing.grantDays ? r : existing
        const loser = r.grantDays >= existing.grantDays ? existing : r
        fyMap2.set(k, {
          ...loser,
          ...winner,
          grantDate: winner.grantDate || loser.grantDate || '',
        })
      }
    }
    records = Array.from(fyMap2.values())

    const idx = records.findIndex(r => String(r.fy) === String(fy))

    const record: Record<string, unknown> = {
      fy: String(fy),
      grantDays: Number(grantDays) || 0,
      carryOver: Number(carryOver) || 0,
      adjustment: Number(adjustment) || 0,
      used: 0,
    }
    // grantDate が指定されたら更新（空文字の場合はクリア）
    if (grantDate !== undefined) {
      record.grantDate = grantDate || ''
    }
    if (idx >= 0) {
      records[idx] = { ...records[idx], ...record } as { fy: string; grantDate?: string; grantDays: number; carryOver: number; adjustment: number }
    } else {
      records.push(record as { fy: string; grantDate?: string; grantDays: number; carryOver: number; adjustment: number })
    }

    plData[key] = records
    await updateDoc(docRef, { plData })
    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Leave POST error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

export async function GET(request: NextRequest) {
  if (!await checkApiAuth(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const calendarMode = request.nextUrl.searchParams.get('calendar') === 'true'
  const debugMode = request.nextUrl.searchParams.get('debug') === 'true'

  try {
    const main = await getMainData()

    // デバッグモード: 生のplDataを返す
    if (debugMode) {
      return NextResponse.json({ plData: main.plData })
    }

    // 全期間の出面データからPL消化を集計（付与日から1年間はスタッフごとに異なるため、広めに取得）
    const now = new Date()
    const currentYear = now.getFullYear()
    const allMonths: string[] = []
    // 過去2年 + 今年分をカバー
    for (let y = currentYear - 2; y <= currentYear; y++) {
      for (let m = 1; m <= 12; m++) allMonths.push(ymKey(y, m))
    }

    const allAtt: Record<string, Record<string, unknown>> = {}
    for (const ym of allMonths) {
      const att = await getAttData(ym)
      Object.assign(allAtt, att.d)
    }

    // Worker name map for calendar tooltips
    const workerNames: Record<number, string> = {}
    main.workers.forEach(w => { workerNames[w.id] = w.name })

    // Build worker PL data — 現在FYに該当するレコードを優先して使用
    const workers = main.workers
      .filter(w => !w.retired && w.job !== 'yakuin' && w.job !== 'jimu')
      .map(w => {
        const plRecords = (main.plData[String(w.id)] || []) as { fy: number | string; grantDate?: string; grant?: number; grantDays?: number; carry?: number; carryOver?: number; adj?: number; adjustment?: number }[]

        // 現在FYを判定
        // - 日本人社員（職長・とび等）: 全員「10/1起点」（決算期サイクル統一）
        // - 外国人（実習生・特定技能）: 個別の grantDate..+1年 に今日が含まれるレコードのfy
        const isJp = !w.visa || w.visa === 'none'
        const nowY = now.getFullYear()
        const nowM = now.getMonth() + 1

        let targetFy: string | null = null
        if (isJp) {
          // 日本人は全員 10/1 起点で統一
          targetFy = String(nowM >= 10 ? nowY : nowY - 1)
        } else {
          // 外国人: grantDate..+1y に今日を含むレコードのfyを使用
          const activeRec = plRecords.find(r => {
            if (!r.grantDate) return false
            const gd = new Date(r.grantDate)
            if (isNaN(gd.getTime())) return false
            const end = new Date(gd); end.setFullYear(end.getFullYear() + 1)
            return now >= gd && now < end
          })
          if (activeRec) targetFy = String(activeRec.fy)
        }

        // targetFy に一致するレコードのうち「最後のもの」を採用（push順で最新）
        let fyRecord: typeof plRecords[number] | undefined
        if (targetFy !== null) {
          const matching = plRecords.filter(r => String(r.fy) === targetFy)
          if (matching.length > 0) fyRecord = matching[matching.length - 1]
        }

        // フォールバック: 付与日数があるレコードの最後、なければplRecordsの最後
        if (!fyRecord) {
          const recordsWithGrant = plRecords.filter(r =>
            (r.grantDays && r.grantDays > 0) || (r.grant && r.grant > 0)
          )
          fyRecord = recordsWithGrant.length > 0
            ? recordsWithGrant[recordsWithGrant.length - 1]
            : (plRecords.length > 0 ? plRecords[plRecords.length - 1] : undefined)
        }

        // 旧アプリ(grant/carry/adj)と新アプリ(grantDays/carryOver/adjustment)の両方に対応
        // 旧フィールドが存在する場合はそちらが元データなので優先する
        // ただし旧アプリは値が0のときフィールド自体を省略する場合があるため、
        // adjが存在する＝旧アプリのレコードと判定し、carry未定義でも0とみなす
        const isOldRecord = fyRecord?.grant != null || fyRecord?.adj != null || fyRecord?.carry != null
        const grantDays = isOldRecord ? (fyRecord?.grant ?? fyRecord?.grantDays ?? 0) : (fyRecord?.grantDays ?? 0)
        const rawCarryOver = isOldRecord ? (fyRecord?.carry ?? 0) : (fyRecord?.carryOver ?? 0)
        // 日本人社員は期末買取制のため繰越なし（強制0）
        const isJapanese = !w.visa || w.visa === 'none'
        const carryOver = isJapanese ? 0 : rawCarryOver
        // adj（旧）とadjustment（新）が両方存在する場合、大きい方を使う（旧データの方が正確な場合がある）
        const adjustment = Math.max(fyRecord?.adjustment ?? 0, fyRecord?.adj ?? 0)
        let grantDate = fyRecord?.grantDate || ''
        let inferredFromDefault = false

        // 日本人社員（visa='none'）でgrantDate未設定の場合、決算期サイクル(10/1起点)をデフォルト適用
        // ただし「Pエントリがある期」を優先して選ぶ（過去のデータを失わないため）
        if (!grantDate && (!w.visa || w.visa === 'none')) {
          const m = now.getMonth() + 1
          const currentFyStartYear = m >= 10 ? now.getFullYear() : now.getFullYear() - 1

          // 10/1起点でPエントリのFYを判定
          const fyCandidates = new Set<number>()
          for (const [key, entry] of Object.entries(allAtt)) {
            if (!entry) continue
            const e = entry as { p?: number | boolean }
            if (!e.p) continue
            const pk = parseDKey(key)
            if (parseInt(pk.wid) !== w.id) continue
            const ey = parseInt(pk.ym.slice(0, 4))
            const em = parseInt(pk.ym.slice(4, 6))
            const fyStart = em >= 10 ? ey : ey - 1
            fyCandidates.add(fyStart)
          }

          // 直近のFYを選ぶ（Pエントリがあれば最新FY、なければ当期）
          let selectedFyStart = currentFyStartYear
          if (fyCandidates.size > 0) {
            if (fyCandidates.has(currentFyStartYear)) {
              selectedFyStart = currentFyStartYear
            } else {
              selectedFyStart = Math.max(...Array.from(fyCandidates))
            }
          }
          grantDate = `${selectedFyStart}-10-01`
          inferredFromDefault = true
        }

        const total = grantDays + carryOver

        // 付与日から1年間のPL消化日数を集計（月別内訳付き）
        // grantDateが空の場合: 全期間のPエントリを集計（移行データ整備中の対策）
        let periodUsed = 0
        const plCalendarLocal: string[] = []
        const monthlyUsage: Record<string, number> = {} // YYYYMM -> count

        const hasPeriod = !!grantDate
        const gd = hasPeriod ? new Date(grantDate) : null
        const gdEnd = hasPeriod ? new Date(gd!) : null
        if (gdEnd) gdEnd.setFullYear(gdEnd.getFullYear() + 1)

        for (const [key, entry] of Object.entries(allAtt)) {
          if (!entry) continue
          const e = entry as { p?: number | boolean }
          // 旧データ互換: e.p === 1 だけでなく truthy な値をすべて有給として扱う
          if (!e.p) continue
          const pk = parseDKey(key)
          const wid = parseInt(pk.wid)
          if (wid !== w.id) continue
          const entryDate = new Date(parseInt(pk.ym.slice(0, 4)), parseInt(pk.ym.slice(4, 6)) - 1, parseInt(pk.day))
          // grantDateがある場合のみ期間で絞り込み、ない場合は全期間集計
          if (hasPeriod && (entryDate < gd! || entryDate >= gdEnd!)) continue
          periodUsed++
          plCalendarLocal.push(`${pk.ym}${pk.day}`)
          monthlyUsage[pk.ym] = (monthlyUsage[pk.ym] || 0) + 1
        }
        const used = adjustment + periodUsed
        const remaining = Math.max(0, total - used)

        // Expiry calculation: grantDate + 2 years - 1 day
        let expiryDate = ''
        let expiryStatus: 'ok' | 'warning' | 'expired' = 'ok'
        if (grantDate) {
          const gd = new Date(grantDate)
          if (!isNaN(gd.getTime())) {
            const exp = new Date(gd)
            exp.setFullYear(exp.getFullYear() + 2)
            exp.setDate(exp.getDate() - 1)
            expiryDate = `${exp.getFullYear()}/${String(exp.getMonth() + 1).padStart(2, '0')}/${String(exp.getDate()).padStart(2, '0')}`

            const now = new Date()
            const diffDays = Math.floor((exp.getTime() - now.getTime()) / (24 * 60 * 60 * 1000))
            if (diffDays < 0) expiryStatus = 'expired'
            else if (diffDays <= 60) expiryStatus = 'warning'
          }
        }

        // Legal PL calculation info
        const legalPL = w.hireDate ? calcLegalPL(w.hireDate, grantDate || new Date().toISOString().split('T')[0]) : 0

        // 年5日取得義務チェック
        // 条件: 外国人 + 年10日以上付与 + 有効期限まで残り3ヶ月以内 + 5日未満消化
        let fiveDayShortfall = 0
        const isGaikoku = w.visa && w.visa !== 'none'
        if (isGaikoku && grantDays >= 10 && periodUsed < 5) {
          if (expiryDate) {
            const exp = new Date(expiryDate)
            const now = new Date()
            const diffDays = Math.floor((exp.getTime() - now.getTime()) / (24 * 60 * 60 * 1000))
            if (diffDays <= 90) {  // 残り3ヶ月（90日）以内
              fiveDayShortfall = 5 - periodUsed
            }
          }
        }

        return {
          id: w.id,
          name: w.name,
          org: w.org,
          visa: w.visa,
          hireDate: w.hireDate || '',
          grantDays,
          carryOver,
          adjustment,
          periodUsed,
          used,
          total,
          remaining: expiryStatus === 'expired' ? 0 : remaining,
          rate: total > 0 ? (used / total) * 100 : 0,
          grantMonth: (w as unknown as { grantMonth?: number }).grantMonth,
          grantDate,
          inferredFromDefault,
          expiryDate,
          expiryStatus,
          legalPL,
          fiveDayShortfall,
          monthlyUsage,
        }
      })
      // Show all eligible workers (including those with no PL data yet)

    // PLカレンダーデータを出面から構築（旧データ互換: truthy判定）
    // dateKeyを YYYYMMDD 形式で統一（日が1桁の場合の重複問題を回避）
    const plCalendar: Record<string, number[]> = {}
    for (const [key, entry] of Object.entries(allAtt)) {
      if (!entry) continue
      const e = entry as { p?: number | boolean }
      if (e.p) {
        const pk = parseDKey(key)
        const wid = parseInt(pk.wid)
        const dateKey = `${pk.ym}${String(pk.day).padStart(2, '0')}`
        if (!plCalendar[dateKey]) plCalendar[dateKey] = []
        if (!plCalendar[dateKey].includes(wid)) plCalendar[dateKey].push(wid)
      }
    }

    const response: Record<string, unknown> = { workers }

    if (calendarMode) {
      response.plCalendar = plCalendar
      response.workerNames = workerNames
    }

    return NextResponse.json(response)
  } catch (error) {
    console.error('Leave API error:', error)
    const errMsg = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ error: 'Server error', detail: errMsg }, { status: 500 })
  }
}
