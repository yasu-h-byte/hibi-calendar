import { NextRequest, NextResponse } from 'next/server'
import { checkApiAuth, getApiAuthUser } from '@/lib/auth'
import { db } from '@/lib/firebase'
import { doc, getDoc, updateDoc } from 'firebase/firestore'
import { getMainData, getAttData, parseDKey } from '@/lib/compute'
import { ymKey, setAttendanceEntry } from '@/lib/attendance'

/**
 * 前期残日数から新FY付与時の carryOver 値を計算する共通ヘルパー
 * - 日本人（visa='none'）: 常に 0（期末買取制）
 * - 外国人: 前期（new grantDate より前で最新の grantDate を持つレコード）から
 *   grantDays + carryOver - adjustment - periodUsed を計算し、0〜20 で丸める
 */
type PLRecLite = { fy: string | number; grantDate?: string; grantDays?: number; grant?: number; carryOver?: number; carry?: number; adjustment?: number; adj?: number }
function calcCarryOverForWorker(
  workerId: number,
  newGrantDate: string,
  records: PLRecLite[],
  allAtt: Record<string, Record<string, unknown>>,
  isJapanese: boolean,
): number {
  if (isJapanese) return 0
  const newGrantTime = new Date(newGrantDate).getTime()
  if (isNaN(newGrantTime)) return 0

  const prevRecs = records
    .filter(r => r.grantDate && ((r.grantDays ?? 0) > 0 || (r.grant ?? 0) > 0))
    .filter(r => {
      const t = new Date(r.grantDate!).getTime()
      return !isNaN(t) && t < newGrantTime
    })
    .sort((a, b) => new Date(a.grantDate!).getTime() - new Date(b.grantDate!).getTime())
  const prevRec = prevRecs[prevRecs.length - 1]
  if (!prevRec) return 0

  const prevStart = new Date(prevRec.grantDate!)
  const prevEnd = new Date(prevStart)
  prevEnd.setFullYear(prevEnd.getFullYear() + 1)

  let periodUsed = 0
  for (const [key, entry] of Object.entries(allAtt)) {
    if (!entry) continue
    const e = entry as { p?: number | boolean }
    if (!e.p) continue
    const pk = parseDKey(key)
    if (parseInt(pk.wid) !== workerId) continue
    const d = new Date(parseInt(pk.ym.slice(0, 4)), parseInt(pk.ym.slice(4, 6)) - 1, parseInt(pk.day))
    if (d >= prevStart && d < prevEnd) periodUsed++
  }

  const prevGrant = prevRec.grantDays ?? prevRec.grant ?? 0
  const prevCarry = prevRec.carryOver ?? prevRec.carry ?? 0
  const prevAdj = prevRec.adjustment ?? prevRec.adj ?? 0
  const remaining = prevGrant + prevCarry - prevAdj - periodUsed
  return Math.max(0, Math.min(20, remaining))
}

/**
 * 付与期間を内包するのに必要な月群（YYYYMM）を返す
 * 過去2年分の出面データを読めば、任意の前期を完全にカバーできる
 */
function relevantAttMonths(): string[] {
  const now = new Date()
  const y = now.getFullYear()
  const out: string[] = []
  for (let yy = y - 2; yy <= y; yy++) {
    for (let mm = 1; mm <= 12; mm++) out.push(ymKey(yy, mm))
  }
  return out
}

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
  const authResult = await getApiAuthUser(request)
  if (!authResult.authorized) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const actor = authResult.actor  // number | 'admin' | 'super-admin'
  try {
    const body = await request.json()
    const { action } = body

    const docRef = doc(db, 'demmen', 'main')
    const snap = await getDoc(docRef)
    if (!snap.exists()) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    // 現在時刻 (ISO) と 操作者識別子
    const nowIso = new Date().toISOString()

    // 本日のJST日付を YYYY-MM-DD で返す（Vercelサーバーは UTC のため補正）
    const todayJST = () => {
      const now = new Date()
      const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000)
      return jst.toISOString().slice(0, 10)
    }

    if (action === 'designateLeaves') {
      // Phase 5: 時季指定（年5日取得義務への対応）
      // 管理者が指定日に P を自動入力し、PLRecord の designatedLeaves に履歴記録
      const { workerId, dates, siteId, note } = body as {
        workerId: number
        dates: string[]          // ["2026-05-01", "2026-05-02", ...]
        siteId: string           // 出面書き込み先の現場ID
        note?: string
      }
      if (!workerId || !Array.isArray(dates) || dates.length === 0 || !siteId) {
        return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
      }

      const data = snap.data()
      const plData = (data.plData || {}) as Record<string, Record<string, unknown>[]>
      const wRecords = plData[String(workerId)] || []

      // 対象FYレコード: 最新の付与レコード
      const granted = wRecords
        .filter(r => r.grantDate && ((r.grantDays as number | undefined) ?? 0) > 0)
        .slice()
        .sort((a, b) => new Date(a.grantDate as string).getTime() - new Date(b.grantDate as string).getTime())
      const targetRec = granted[granted.length - 1]
      if (!targetRec) {
        return NextResponse.json({ error: 'No granted record found for worker' }, { status: 404 })
      }

      // 出面に P を書き込み
      type DesignatedEntry = { date: string; designatedAt: string; designatedBy: number | string; note?: string; siteId: string }
      const history = (targetRec.designatedLeaves as DesignatedEntry[] | undefined) ?? []
      const written: string[] = []

      for (const dateStr of dates) {
        const d = new Date(dateStr)
        if (isNaN(d.getTime())) continue
        const ym = ymKey(d.getFullYear(), d.getMonth() + 1)
        const day = d.getDate()
        // 出面書き込み: { w: 0, p: 1 }
        await setAttendanceEntry(siteId, workerId, ym, day, { w: 0, p: 1 })
        history.push({
          date: dateStr,
          designatedAt: nowIso,
          designatedBy: actor,
          note,
          siteId,
        })
        written.push(dateStr)
      }

      targetRec.designatedLeaves = history
      targetRec.lastEditedAt = nowIso
      targetRec.lastEditedBy = actor

      plData[String(workerId)] = wRecords
      await updateDoc(docRef, { plData })
      return NextResponse.json({ success: true, written })
    }

    if (action === 'processExpiry') {
      // Phase 3: 時効（2年）処理を実行
      // grantDate + 2年 - 1日 < today のレコードで、まだ失効処理されていないものに
      // expiredDays / expiredAt / expiredBy / _archived を記録する
      const data = snap.data()
      const plData = (data.plData || {}) as Record<string, Record<string, unknown>[]>
      const today = todayJST()
      const todayDate = new Date(today)

      // 出面データをロード（残日数計算用）
      const allAtt: Record<string, Record<string, unknown>> = {}
      for (const ym of relevantAttMonths()) {
        const att = await getAttData(ym)
        Object.assign(allAtt, att.d)
      }

      const expiredList: { workerId: number; workerName: string; fy: string; grantDate: string; expiredDays: number }[] = []
      const workersArr = (data.workers || []) as { id: number; name: string }[]
      const nameOf = (wid: number) => workersArr.find(w => w.id === wid)?.name || `id=${wid}`

      for (const [wid, records] of Object.entries(plData)) {
        const workerId = Number(wid)
        for (const r of records) {
          // 既に処理済みはスキップ
          if (r._archived || r.expiredAt) continue
          if (!r.grantDate) continue
          const gd = new Date(r.grantDate as string)
          if (isNaN(gd.getTime())) continue
          // 有効期限 = grantDate + 2年 - 1日
          const exp = new Date(gd)
          exp.setFullYear(exp.getFullYear() + 2)
          exp.setDate(exp.getDate() - 1)
          if (exp >= todayDate) continue  // まだ期限内

          // 期限切れ → 残日数計算
          // 残 = grantDays + carryOver - adjustment - (付与期間内のP消化)
          const grantDays = (r.grantDays as number | undefined) ?? 0
          const carryOver = (r.carryOver as number | undefined) ?? 0
          const adjustment = (r.adjustment as number | undefined) ?? 0
          const periodStart = gd
          const periodEnd = new Date(gd)
          periodEnd.setFullYear(periodEnd.getFullYear() + 1)
          let periodUsed = 0
          for (const [key, entry] of Object.entries(allAtt)) {
            if (!entry) continue
            const e = entry as { p?: number | boolean }
            if (!e.p) continue
            const pk = parseDKey(key)
            if (parseInt(pk.wid) !== workerId) continue
            const d = new Date(parseInt(pk.ym.slice(0, 4)), parseInt(pk.ym.slice(4, 6)) - 1, parseInt(pk.day))
            if (d >= periodStart && d < periodEnd) periodUsed++
          }
          const expiredDays = Math.max(0, grantDays + carryOver - adjustment - periodUsed)

          r.expiredDays = expiredDays
          r.expiredAt = nowIso
          r.expiredBy = actor
          r._archived = true

          expiredList.push({
            workerId,
            workerName: nameOf(workerId),
            fy: String(r.fy ?? ''),
            grantDate: r.grantDate as string,
            expiredDays,
          })
        }
      }

      await updateDoc(docRef, { plData })
      return NextResponse.json({
        success: true,
        processed: expiredList.length,
        expired: expiredList,
      })
    }

    if (action === 'migrate') {
      // Phase 1 データ正規化マイグレーション
      // 冪等な処理 — 何度実行しても結果は同じ
      // body.autoFixMismatches: true で、fy と grantDate の年ズレを自動修正
      //   (fy を grantDate の年に合わせる。grantDate を認定データとして扱う)
      const autoFixMismatches = body.autoFixMismatches === true
      const data = snap.data()
      type Worker = { id: number; name: string; retired?: boolean; job?: string; visa?: string; hireDate?: string }
      type PLRecFull = {
        fy: string | number
        grantDate?: string
        grantDays?: number
        carryOver?: number
        adjustment?: number
        used?: number
        expiry?: string
        _archived?: boolean
        grant?: number
        carry?: number
        adj?: number
      }
      const workers = (data.workers || []) as Worker[]
      const plData = (data.plData || {}) as Record<string, PLRecFull[]>
      const today = todayJST()

      const stats = {
        workersProcessed: 0,
        recordsProcessed: 0,
        legacyFieldsUpgraded: 0,
        fyNormalized: 0,
        grantDatesInferred: 0,
        duplicatesMerged: 0,
        recordsArchived: 0,
        mismatches: [] as { workerId: number; name: string; fy: string; grantDate: string; note: string }[],
        warnings: [] as { workerId: number; name: string; note: string }[],
      }

      for (const [wid, origRecords] of Object.entries(plData)) {
        const workerId = Number(wid)
        const worker = workers.find(w => w.id === workerId)
        const workerName = worker?.name || `id=${wid}`
        const isJp = !worker?.visa || worker.visa === 'none'
        let records = [...origRecords] as PLRecFull[]
        stats.workersProcessed++
        stats.recordsProcessed += records.length

        // STEP 1: 旧フィールド昇格 & fy正規化
        records = records.map(r => {
          const clean = { ...r } as Record<string, unknown>
          let upgraded = false
          if (clean.grant !== undefined && (clean.grantDays === undefined || clean.grantDays === null)) {
            clean.grantDays = clean.grant
            upgraded = true
          }
          if (clean.carry !== undefined && (clean.carryOver === undefined || clean.carryOver === null)) {
            clean.carryOver = clean.carry
            upgraded = true
          }
          if (clean.adj !== undefined && (clean.adjustment === undefined || clean.adjustment === null)) {
            clean.adjustment = clean.adj
            upgraded = true
          }
          if (clean.grant !== undefined || clean.carry !== undefined || clean.adj !== undefined) {
            delete clean.grant
            delete clean.carry
            delete clean.adj
          }
          if (upgraded) stats.legacyFieldsUpgraded++
          // fy正規化
          if (clean.fy !== undefined && typeof clean.fy !== 'string') {
            clean.fy = String(clean.fy)
            stats.fyNormalized++
          }
          return clean as PLRecFull
        })

        // STEP 2: grantDate欠落の補完
        //   日本人: fy があれば ${fy}-10-01 を補完
        //   外国人: 同一fyの他レコードにgrantDateがあれば採用、なければwarning
        for (let i = 0; i < records.length; i++) {
          const r = records[i]
          if (r.grantDate) continue
          if (!(r.grantDays && r.grantDays > 0)) continue  // 空データは補完せずスキップ
          const fyStr = String(r.fy || '')
          if (!fyStr) {
            stats.warnings.push({ workerId, name: workerName, note: 'grantDate/fyともに欠落したレコードあり (補完不可)' })
            continue
          }
          if (isJp) {
            r.grantDate = `${fyStr}-10-01`
            stats.grantDatesInferred++
          } else {
            // 外国人: 他の同一fyレコードから補完可能か
            const sibling = records.find(x => String(x.fy) === fyStr && x.grantDate)
            if (sibling && sibling.grantDate) {
              r.grantDate = sibling.grantDate
              stats.grantDatesInferred++
            } else {
              stats.warnings.push({ workerId, name: workerName, note: `外国人 fy=${fyStr} のgrantDate欠落 (推定不可、管理画面で設定が必要)` })
            }
          }
        }

        // STEP 3: 同一fyの重複集約
        //   戦略: 最新の grantDate を持つレコードを「真」とし、古い重複は捨てる
        //   (古いレコードから max値をマージすると、legacy値の混入で二重計上が発生する)
        const fyGroups = new Map<string, PLRecFull[]>()
        for (const r of records) {
          const k = String(r.fy ?? '')
          if (!fyGroups.has(k)) fyGroups.set(k, [])
          fyGroups.get(k)!.push(r)
        }
        const merged: PLRecFull[] = []
        for (const [, group] of fyGroups) {
          if (group.length === 1) {
            merged.push(group[0])
            continue
          }
          stats.duplicatesMerged += group.length - 1
          // 並び順の優先度:
          //  1. grantDays > 0 を優先（空データより本物のレコードを選ぶ）
          //  2. grantDate が新しい方を優先（最新の編集を「真」とする）
          //  3. grantDays が大きい方を優先（タイブレイク）
          const sorted = group.slice().sort((a, b) => {
            const gdA = a.grantDays ?? 0
            const gdB = b.grantDays ?? 0
            if ((gdA > 0) !== (gdB > 0)) return gdB - gdA
            const dateA = a.grantDate ? new Date(a.grantDate).getTime() : 0
            const dateB = b.grantDate ? new Date(b.grantDate).getTime() : 0
            if (dateB !== dateA) return dateB - dateA
            return gdB - gdA
          })
          merged.push(sorted[0])  // 他のレコードは捨てる (最新のものが真)
        }
        records = merged

        // STEP 4: fy と grantDate の年ズレ検出・修正
        for (const r of records) {
          if (!r.grantDate) continue
          const gdYear = r.grantDate.slice(0, 4)
          const fyStr = String(r.fy ?? '')
          if (!fyStr) continue
          if (gdYear !== fyStr) {
            stats.mismatches.push({ workerId, name: workerName, fy: fyStr, grantDate: r.grantDate, note: `fy=${fyStr} だがgrantDate=${r.grantDate}${autoFixMismatches ? ' → fy=' + gdYear + 'に自動修正' : ''}` })
            if (autoFixMismatches) {
              r.fy = gdYear
            }
          }
        }

        // STEP 4.5: fy修正後に再度重複が発生していないかチェック・集約
        if (autoFixMismatches) {
          const fyGroups2 = new Map<string, PLRecFull[]>()
          for (const r of records) {
            const k = String(r.fy ?? '')
            if (!fyGroups2.has(k)) fyGroups2.set(k, [])
            fyGroups2.get(k)!.push(r)
          }
          const merged2: PLRecFull[] = []
          for (const [, group] of fyGroups2) {
            if (group.length === 1) {
              merged2.push(group[0])
              continue
            }
            stats.duplicatesMerged += group.length - 1
            const sorted = group.slice().sort((a, b) => {
              const gdA = a.grantDays ?? 0
              const gdB = b.grantDays ?? 0
              if ((gdA > 0) !== (gdB > 0)) return gdB - gdA
              const dateA = a.grantDate ? new Date(a.grantDate).getTime() : 0
              const dateB = b.grantDate ? new Date(b.grantDate).getTime() : 0
              if (dateB !== dateA) return dateB - dateA
              return gdB - gdA
            })
            merged2.push(sorted[0])
          }
          records = merged2
        }

        // STEP 5: 期限切れレコードのアーカイブ
        //   grantDate+2年 < today なら _archived: true
        //   表示ロジックは _archived を除外
        for (const r of records) {
          if (r._archived) continue
          if (!r.grantDate) continue
          const gd = new Date(r.grantDate)
          if (isNaN(gd.getTime())) continue
          const exp = new Date(gd)
          exp.setFullYear(exp.getFullYear() + 2)
          exp.setDate(exp.getDate() - 1)
          const expStr = exp.toISOString().slice(0, 10)
          if (expStr < today) {
            r._archived = true
            stats.recordsArchived++
          }
        }

        // STEP 6: method が未設定なレコードに 'legacy' を付与（監査用）
        for (const r of records) {
          const rr = r as Record<string, unknown>
          if (rr.method === undefined) {
            rr.method = 'legacy'
          }
        }

        plData[wid] = records
      }

      await updateDoc(docRef, { plData })
      return NextResponse.json({ success: true, stats })
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
        needsAttention: boolean  // hireDate未登録など、手動確認が必要なフラグ
        attentionNote?: string
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

      // 「付与判定」: 以下のいずれかで「付与済み」とみなす
      //   (a) 付与日近傍（±7日）に既存レコードあり → 通常パターン
      //   (b) grantDateが欠落していても fy が一致する → 「本田文人」のような移行期データに対応
      // (a)単独だと grantDate 欠落レコードを見逃し、(b)単独だと fy 不整合データで誤スキップ。
      // 両条件のOR合成が最適解。
      const hasGrantForExpected = (records: PLRecord[], expectedFy: string, expectedGrantDate: string): boolean => {
        const target = new Date(expectedGrantDate).getTime()
        return records.some(r => {
          if (!((r.grantDays ?? 0) > 0 || (r.grant ?? 0) > 0)) return false
          if (r.grantDate) {
            const d = new Date(r.grantDate).getTime()
            if (isNaN(d) || isNaN(target)) return false
            return Math.abs(d - target) <= 7 * 86400000
          }
          // grantDate 欠落 → fy一致で判定
          return String(r.fy) === expectedFy
        })
      }

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

          // 付与判定に引っかからなければ対象
          if (expectedGrantDate <= today && !hasGrantForExpected(records, expectedFy, expectedGrantDate)) {
            const hasHire = !!w.hireDate
            const legalDays = hasHire ? calcLegalPL(w.hireDate!, expectedGrantDate) : 10
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
              needsAttention: !hasHire,
              attentionNote: !hasHire ? '入社日未登録のため法定日数(10日)はデフォルト値です' : undefined,
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
                    needsAttention: false,
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

          const nextFyForCheck = String(nextGrant.getFullYear())
          if (nextGrantStr <= today && !hasGrantForExpected(records, nextFyForCheck, nextGrantStr)) {
            const nextFy = nextFyForCheck
            const hasHire = !!w.hireDate
            const legalDays = hasHire ? calcLegalPL(w.hireDate!, nextGrantStr) : 10
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
              needsAttention: !hasHire,
              attentionNote: !hasHire ? '入社日未登録のため法定日数(10日)はデフォルト値です' : undefined,
            })
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
      const workersArr = ((snap.data().workers || []) as { id: number; visa?: string }[])
      const isJpOf = (id: number) => {
        const w = workersArr.find(x => x.id === id)
        return !w?.visa || w.visa === 'none'
      }

      // 付与日近傍(±7日)に既存付与があるかチェック（二重付与防止用）
      type PLRec = { fy: string | number; grantDate?: string; grantDays?: number; grant?: number; carryOver?: number; carry?: number; adjustment?: number; adj?: number }
      const hasGrantNear = (records: PLRec[], targetDate: string): boolean => {
        const target = new Date(targetDate).getTime()
        if (isNaN(target)) return false
        return records.some(r => {
          if (!((r.grantDays ?? 0) > 0 || (r.grant ?? 0) > 0)) return false
          if (!r.grantDate) return false
          const d = new Date(r.grantDate).getTime()
          if (isNaN(d)) return false
          return Math.abs(d - target) <= 7 * 86400000
        })
      }

      // 外国人の繰越計算用: 出面データを事前に一括ロード
      const needsAttLoad = grants.some(g => !isJpOf(g.workerId))
      const allAtt: Record<string, Record<string, unknown>> = {}
      if (needsAttLoad) {
        const months = relevantAttMonths()
        for (const ym of months) {
          const att = await getAttData(ym)
          Object.assign(allAtt, att.d)
        }
      }

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

        // 「付与日近傍」に既存レコードがあればスキップ（真の二重付与防止）
        if (hasGrantNear(records, g.grantDate)) {
          plData[key] = records
          continue
        }

        // 繰越を前期残日数から自動計算（外国人のみ）
        const carryOverVal = calcCarryOverForWorker(
          g.workerId,
          g.grantDate,
          records,
          allAtt,
          isJpOf(g.workerId),
        )

        const newRec = {
          fy: String(g.fy),
          grantDate: g.grantDate,
          grantDays: Number(g.grantDays) || 0,
          carryOver: carryOverVal,
          adjustment: 0,
          used: 0,
          // 監査情報
          grantedAt: nowIso,
          grantedBy: actor,
          method: 'auto-pending' as const,
        }
        records.push(newRec)
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

      // 繰越: ユーザーが明示的に指定している場合はそれを優先。
      // 未指定の場合は前期残日数から自動計算（日本人は強制0）
      const workersArrG = ((snap.data().workers || []) as { id: number; visa?: string }[])
      const workerG = workersArrG.find(x => x.id === Number(workerId))
      const isJpG = !workerG?.visa || workerG.visa === 'none'
      let carryOverVal: number
      if (bodyCarryOver != null) {
        carryOverVal = Number(bodyCarryOver) || 0
      } else if (grantDate) {
        // 自動計算には出面データが必要
        const allAttG: Record<string, Record<string, unknown>> = {}
        for (const ym of relevantAttMonths()) {
          const att = await getAttData(ym)
          Object.assign(allAttG, att.d)
        }
        carryOverVal = calcCarryOverForWorker(Number(workerId), grantDate, records, allAttG, isJpG)
      } else {
        carryOverVal = 0
      }

      const record = {
        fy: String(fy),
        grantDate: grantDate || '',
        grantDays: Number(grantDays) || 0,
        carryOver: carryOverVal,
        adjustment: 0,
        used: 0,
        // 監査情報
        grantedAt: nowIso,
        grantedBy: actor,
        method: 'manual' as const,
      }
      if (idx >= 0) {
        // 既存レコードの更新: 初回grantedAtは残す、method='manual-edit'に
        const existing = records[idx] as { grantedAt?: string; grantedBy?: number | string; method?: string }
        const merged = {
          ...records[idx],
          ...record,
          grantedAt: existing.grantedAt || nowIso,  // 初回付与時刻を保持
          grantedBy: existing.grantedBy || actor,
          method: existing.method || 'manual',
          lastEditedAt: nowIso,
          lastEditedBy: actor,
        }
        records[idx] = merged as { fy: string; grantDate?: string; grantDays: number; carryOver: number; adjustment: number }
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
      // 「繰越自動計算」ボタン — 全ワーカーの「最新付与レコード」の繰越値を再計算する。
      // ワーカーごとに異なるサイクル（日本人=10/1、外国人=各grantDate）に対応。
      // 以前は10/1アンカー固定で計算していたため、4/23や7/1サイクルの外国人で
      // 前期期間が誤計算される問題があった。
      const plData = (snap.data().plData || {}) as Record<string, PLRecLite[]>
      const workersList = ((snap.data().workers || []) as { id: number; visa?: string }[])
      const isJapaneseOf = (wid: number) => {
        const w = workersList.find(x => x.id === wid)
        return !w?.visa || w.visa === 'none'
      }

      // 出面データを一括ロード
      const allAtt: Record<string, Record<string, unknown>> = {}
      for (const ym of relevantAttMonths()) {
        const att = await getAttData(ym)
        Object.assign(allAtt, att.d)
      }

      let updated = 0
      for (const [wid, records] of Object.entries(plData)) {
        const workerId = Number(wid)
        // 日本人社員は期末買取制のため繰越なし → 強制0
        const isJp = isJapaneseOf(workerId)

        // 最新付与レコード（grantDate最大 かつ grantDays>0）を特定
        const granted = records
          .filter(r => r.grantDate && ((r.grantDays ?? 0) > 0 || (r.grant ?? 0) > 0))
          .slice()
          .sort((a, b) => new Date(a.grantDate!).getTime() - new Date(b.grantDate!).getTime())
        const latest = granted[granted.length - 1]
        if (!latest) continue

        const newCarry = calcCarryOverForWorker(workerId, latest.grantDate!, records, allAtt, isJp)

        // 最新レコードの carryOver を更新
        const idx = records.findIndex(r => r === latest)
        if (idx >= 0) {
          const before = (records[idx].carryOver ?? records[idx].carry ?? 0)
          if (before !== newCarry) {
            (records[idx] as { carryOver: number }).carryOver = newCarry
            // 旧フィールドも掃除しておく
            delete (records[idx] as Record<string, unknown>).carry
            updated++
          }
        }
      }

      await updateDoc(docRef, { plData })
      return NextResponse.json({ success: true, updated })
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
      // 既存レコードの編集: 値変更を adjustmentHistory に記録
      const existing = records[idx] as Record<string, unknown>
      type HistoryEntry = { at: string; by: number | string; field: string; before: string | number; after: string | number }
      const history = (existing.adjustmentHistory as HistoryEntry[] | undefined) ?? []
      const trackFields: Array<{ key: 'grantDays' | 'carryOver' | 'adjustment' | 'grantDate'; before: unknown; after: unknown }> = [
        { key: 'grantDays', before: existing.grantDays ?? 0, after: record.grantDays },
        { key: 'carryOver', before: existing.carryOver ?? 0, after: record.carryOver },
        { key: 'adjustment', before: existing.adjustment ?? 0, after: record.adjustment },
      ]
      if (grantDate !== undefined) {
        trackFields.push({ key: 'grantDate', before: (existing.grantDate as string) ?? '', after: record.grantDate })
      }
      for (const t of trackFields) {
        if (t.before !== t.after) {
          history.push({
            at: nowIso,
            by: actor,
            field: t.key,
            before: String(t.before ?? ''),
            after: String(t.after ?? ''),
          })
        }
      }
      const merged: Record<string, unknown> = {
        ...existing,
        ...record,
        lastEditedAt: nowIso,
        lastEditedBy: actor,
      }
      if (history.length > 0) merged.adjustmentHistory = history
      records[idx] = merged as { fy: string; grantDate?: string; grantDays: number; carryOver: number; adjustment: number }
    } else {
      // 新規レコード: 監査情報も付与
      records.push({
        ...(record as { fy: string; grantDate?: string; grantDays: number; carryOver: number; adjustment: number }),
        grantedAt: nowIso,
        grantedBy: actor,
        method: 'manual',
      } as { fy: string; grantDate?: string; grantDays: number; carryOver: number; adjustment: number })
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
        const plRecordsRaw = (main.plData[String(w.id)] || []) as { fy: number | string; grantDate?: string; grant?: number; grantDays?: number; carry?: number; carryOver?: number; adj?: number; adjustment?: number; _archived?: boolean }[]
        // アーカイブ済みレコードは表示対象から除外（期限切れで2年以上経過）
        const plRecords = plRecordsRaw.filter(r => !r._archived)

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
          // 監査情報: 現在表示中レコードのみ
          grantedAt: (fyRecord as { grantedAt?: string } | undefined)?.grantedAt,
          grantedBy: (fyRecord as { grantedBy?: number | string } | undefined)?.grantedBy,
          method: (fyRecord as { method?: string } | undefined)?.method,
          lastEditedAt: (fyRecord as { lastEditedAt?: string } | undefined)?.lastEditedAt,
          lastEditedBy: (fyRecord as { lastEditedBy?: number | string } | undefined)?.lastEditedBy,
          adjustmentHistory: (fyRecord as { adjustmentHistory?: Array<{ at: string; by: number | string; field: string; before: string; after: string }> } | undefined)?.adjustmentHistory,
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
