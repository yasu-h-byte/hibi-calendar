import { NextRequest, NextResponse } from 'next/server'
import { checkApiAuth } from '@/lib/auth'
import { db } from '@/lib/firebase'
import { doc, getDoc, updateDoc } from '@/lib/fsdb'
import { logActivity } from '@/lib/activity'
import { resolveSiteParties } from '@/lib/companies'
import { orderSitesWithWorkTypes } from '@/lib/site-hierarchy'

interface RatePeriod {
  from: string
  tobiRate: number
  dokoRate: number
}

interface SiteBreakRaw {
  enabled?: boolean
  minutes?: number
  mandatory?: boolean
}

interface SiteWorkScheduleRaw {
  startTime?: string
  endTime?: string
  morningBreak?: SiteBreakRaw
  lunchBreak?: SiteBreakRaw
  afternoonBreak?: SiteBreakRaw
}

interface RawSite {
  id: string
  name: string
  start?: string
  end?: string
  foreman?: number
  archived?: boolean
  tobiRate?: number
  dokoRate?: number
  rates?: RatePeriod[]
  workSchedule?: SiteWorkScheduleRaw | null
  commute?: import('@/types').SiteCommuteData
  siteType?: 'direct' | 'support'
  client?: string
  gcId?: string
  primeId?: string
  ownerId?: string
  /** 工種サイトの親現場 id（2026-09-15）。lib/site-hierarchy.ts 参照 */
  parentId?: string
  /** 工種名（鉄骨・仮設など） */
  workType?: string
}

/**
 * 工種サイトが親現場から引き継ぐ項目（2026-09-15 代表決定: カレンダー・署名・職長・勤務時間・請負体制は共通）。
 * 親を保存するたびに子へ書き写す（読み取り側の改修を最小にするため、直接 site.foreman 等を読む箇所もそのまま正しくなる）。
 */
const INHERITED_FIELDS = ['start', 'end', 'foreman', 'workSchedule', 'siteType', 'client', 'gcId', 'primeId', 'ownerId'] as const

function inheritFromParent(child: RawSite, parent: RawSite): RawSite {
  const next: RawSite = { ...child }
  for (const k of INHERITED_FIELDS) {
    const v = (parent as unknown as Record<string, unknown>)[k]
    if (v === undefined) delete (next as unknown as Record<string, unknown>)[k]
    else (next as unknown as Record<string, unknown>)[k] = v
  }
  next.name = `${parent.name}（${child.workType || child.name}）`
  return next
}

async function getMainDoc() {
  const docRef = doc(db, 'demmen', 'main')
  const docSnap = await getDoc(docRef)
  if (!docSnap.exists()) return null
  return { ref: docRef, data: docSnap.data() }
}

export async function GET(request: NextRequest) {
  if (!await checkApiAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const result = await getMainDoc()
    if (!result) {
      return NextResponse.json({ sites: [], assign: {}, workers: [], subcons: [], mforeman: {} })
    }

    const { data } = result
    // 工種サイトは親現場の直後に並べる（出面の現場選択でも親の下に出る・2026-09-15）
    const rawSites = orderSitesWithWorkTypes((data.sites || []) as RawSite[])
    const sites = rawSites.map(s => ({
      id: s.id,
      name: s.name,
      start: s.start || '',
      end: s.end || '',
      foreman: s.foreman || 0,
      archived: s.archived || false,
      tobiRate: s.tobiRate || 0,
      dokoRate: s.dokoRate || 0,
      rates: s.rates || [],
      workSchedule: s.workSchedule || null,  // 未設定はnull (クライアント側でDEFAULTを補完)
      // ⚠️ 保存されるフィールドは必ずここにも足すこと（許可リスト）。
      //   commute/siteType/client が漏れていて「保存したのに開き直すと消えて見える →
      //   その状態で再保存すると空値で上書き消去」が起きた（2026-08-26 修正）
      commute: s.commute || undefined,
      siteType: s.siteType || undefined,
      client: s.client ?? undefined,
      gcId: s.gcId || undefined,
      primeId: s.primeId || undefined,
      ownerId: s.ownerId || undefined,
      parentId: s.parentId || undefined,
      workType: s.workType || undefined,
    }))

    const assign: Record<string, { workers: number[]; subcons: string[]; subconRates?: Record<string, { rate: number; otRate: number }> }> = {}
    if (data.assign) {
      for (const [siteId, val] of Object.entries(data.assign as Record<string, Record<string, unknown>>)) {
        assign[siteId] = {
          workers: (val.workers as number[]) || [],
          subcons: (val.subcons as string[]) || [],
          subconRates: (val.subconRates as Record<string, { rate: number; otRate: number }>) || undefined,
        }
      }
    }

    const workers = ((data.workers || []) as Record<string, unknown>[]).map(w => ({
      id: w.id as number,
      name: w.name as string,
      jobType: (w.job as string) || '',
      retired: (w.retired as string) || '',
    }))

    const subcons = ((data.subcons || []) as Record<string, unknown>[]).map(sc => ({
      id: sc.id as string,
      name: sc.name as string,
      type: (sc.type as string) || '',
      rate: (sc.rate as number) || 0,
      otRate: (sc.otRate as number) || 0,
      roles: Array.isArray(sc.roles) ? (sc.roles as string[]) : undefined,
    }))

    // mforeman: entries like { siteId_ym: { wid: workerId } }
    const mforeman = (data.mforeman || {}) as Record<string, { wid: number }>

    const defaultRates = (data.defaultRates || { tobiRate: 38000, dokoRate: 30000 }) as { tobiRate: number; dokoRate: number }

    return NextResponse.json({ sites, assign, workers, subcons, mforeman, defaultRates })
  } catch (error) {
    console.error('Failed to fetch sites:', error)
    return NextResponse.json({ error: 'Failed to fetch sites' }, { status: 500 })
  }
}

/**
 * 通勤時間（commute）の更新を安全に取り込む。
 * - 凍結済み（judgedMin あり）は変更不可: 非課税の根拠となる客観基準のため、
 *   既存値をそのまま維持する（UI も編集不可にしているが、サーバでも保証する）
 * - 空の commute（住所なし・サンプルなし）で既存の実データを上書きしない:
 *   読み出し漏れ等でフォームが空のまま保存されても消えないようにする多層防御
 * - サンプルは空配列で既存分を消さない（自動測定の蓄積を守る）
 */
function mergeCommute(
  existing: import('@/types').SiteCommuteData | undefined,
  incoming: import('@/types').SiteCommuteData | null | undefined,
): import('@/types').SiteCommuteData | undefined {
  if (existing?.judgedMin !== undefined) return existing
  if (!incoming) return existing
  const incomingEmpty = !incoming.address && !(incoming.samples?.length) && incoming.judgedMin === undefined
  if (incomingEmpty) return existing
  const samples = (incoming.samples?.length ? incoming.samples : existing?.samples) || []
  return { ...incoming, samples }
}

export async function POST(request: NextRequest) {
  if (!await checkApiAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await request.json()
    const { action } = body

    const result = await getMainDoc()
    if (!result) {
      return NextResponse.json({ error: 'No data found' }, { status: 404 })
    }

    const { ref, data } = result
    const sites = (data.sites || []) as RawSite[]

    if (action === 'add') {
      const { name, start, end, foreman, tobiRate, dokoRate } = body
      const parties = resolvePartiesFromBody(body, data)
      if (!name) {
        return NextResponse.json({ error: '現場名を入力してください' }, { status: 400 })
      }

      const newId = 'site_' + Date.now()
      const newSite: RawSite = {
        id: newId,
        name,
        start: start || '',
        end: end || '',
        foreman: Number(foreman) || 0,
        archived: false,
        tobiRate: Number(tobiRate) || 0,
        dokoRate: Number(dokoRate) || 0,
        rates: [],
        ...parties,
      }

      await updateDoc(ref, { sites: [...sites, newSite].map(stripUndefinedDeep) })
      await logActivity('admin', 'site.add', `${name} を追加`)
      return NextResponse.json({ success: true, site: newSite })
    }

    if (action === 'update') {
      const { id, name, start, end, foreman, archived, tobiRate, dokoRate, rates, subconRates, workSchedule, commute } = body
      const parties = resolvePartiesFromBody(body, data)
      if (!id) {
        return NextResponse.json({ error: 'id required' }, { status: 400 })
      }

      const idx = sites.findIndex(s => s.id === id)
      if (idx === -1) {
        return NextResponse.json({ error: 'Site not found' }, { status: 404 })
      }

      const updated = [...sites]
      const isChild = !!sites[idx].parentId
      updated[idx] = {
        ...updated[idx],
        ...(name !== undefined && { name }),
        ...(start !== undefined && { start }),
        ...(end !== undefined && { end }),
        ...(foreman !== undefined && { foreman: Number(foreman) }),
        ...(archived !== undefined && { archived: Boolean(archived) }),
        ...(tobiRate !== undefined && { tobiRate: Number(tobiRate) }),
        ...(dokoRate !== undefined && { dokoRate: Number(dokoRate) }),
        ...(rates !== undefined && { rates }),
        ...(workSchedule !== undefined && { workSchedule: workSchedule as SiteWorkScheduleRaw | null }),
        // commute は素通しにしない（凍結後は不変・古い空フォームからの上書き消去を防ぐ）
        // 2026-09-15 修正: 通勤データを持たない現場（笹塚など）で空フォームを送ると mergeCommute が undefined を返し、
        //   `commute: undefined` を書こうとして Firestore が拒否 → 保存全体が 500 で失敗していた（画面は無反応）
        ...(() => {
          if (commute === undefined) return {}
          const merged = mergeCommute(updated[idx].commute, commute)
          return merged === undefined ? {} : { commute: merged }
        })(),
        ...parties,
      }
      if (typeof body.workType === 'string' && body.workType.trim() && isChild) {
        updated[idx].workType = body.workType.trim()
      }
      // 親現場の「自分の工種名」（例: 仮設工事・社長 2026-09-26）。工種サイトを持つ親現場で、
      //   工種を選ばない日の呼び方（出面のタグ・請求書の行）に使う。空で送れば消す
      if (!isChild && typeof body.workType === 'string') {
        const wt = body.workType.trim()
        if (wt) updated[idx].workType = wt
        else delete updated[idx].workType
      }
      // 工種サイト: 引き継ぎ項目は親の値に戻す（子の画面から送られても変えない）
      if (isChild) {
        const parent = updated.find(x => x.id === sites[idx].parentId)
        if (parent) updated[idx] = inheritFromParent(updated[idx], parent)
      } else {
        // 親現場: 工種サイトへ引き継ぎ項目を書き写す
        for (let i = 0; i < updated.length; i++) {
          if (updated[i].parentId === id) updated[i] = inheritFromParent(updated[i], updated[idx])
        }
      }

      const updateData: Record<string, unknown> = { sites: updated.map(stripUndefinedDeep) }

      // Save subconRates to assign[siteId].subconRates
      if (subconRates !== undefined) {
        const assign = (data.assign || {}) as Record<string, Record<string, unknown>>
        const siteAssign = assign[id] || { workers: [], subcons: [] }
        siteAssign.subconRates = subconRates
        assign[id] = siteAssign
        updateData.assign = assign
      }

      await updateDoc(ref, updateData)

      // Log rate changes if rates array was updated
      if (rates !== undefined) {
        const siteName = updated[idx].name || id
        const latestRate = Array.isArray(rates) && rates.length > 0 ? rates[rates.length - 1] : null
        if (latestRate) {
          await logActivity('admin', 'rates.site', `${siteName} 単価変更: 鳶¥${latestRate.tobiRate} 土工¥${latestRate.dokoRate}`)
        }
      }

      if (commute?.judgedMin !== undefined && sites[idx]?.commute?.judgedMin === undefined) {
        await logActivity('admin', 'site.commute', `${updated[idx].name || id} 通勤時間を凍結: 判定値${commute.judgedMin}分`)
      }
      await logActivity('admin', 'site.update', `${id} を更新`)
      return NextResponse.json({ success: true })
    }

    if (action === 'delete') {
      const { id } = body
      if (!id) {
        return NextResponse.json({ error: 'id required' }, { status: 400 })
      }

      // 工種サイトが残っている親現場は削除できない（出面の入力先が宙に浮くため）
      const kids = sites.filter(s => s.parentId === id)
      if (kids.length > 0) {
        return NextResponse.json({ error: `工種（${kids.map(k => k.workType || k.name).join('・')}）が残っているため削除できません。先に工種を削除またはアーカイブしてください` }, { status: 409 })
      }

      // Remove from sites array
      const filtered = sites.filter(s => s.id !== id)
      if (filtered.length === sites.length) {
        return NextResponse.json({ error: 'Site not found' }, { status: 404 })
      }

      const updateData: Record<string, unknown> = { sites: filtered }

      // Remove assign entry
      const assign = (data.assign || {}) as Record<string, Record<string, unknown>>
      if (assign[id]) {
        delete assign[id]
        updateData.assign = assign
      }

      // Remove mforeman entries for this site
      const mforeman = (data.mforeman || {}) as Record<string, unknown>
      let mforemanChanged = false
      for (const key of Object.keys(mforeman)) {
        if (key.startsWith(id + '_')) {
          delete mforeman[key]
          mforemanChanged = true
        }
      }
      if (mforemanChanged) {
        updateData.mforeman = mforeman
      }

      await updateDoc(ref, updateData)
      await logActivity('admin', 'site.delete', `${id} を削除`)
      return NextResponse.json({ success: true })
    }

    // 工種（出面の入力先）を親現場の下に追加する（2026-09-15）
    if (action === 'addWorkType') {
      const { parentId, workType } = body as { parentId?: string; workType?: string }
      const wt = String(workType || '').trim()
      const parent = sites.find(x => x.id === parentId)
      if (!parent || !wt) return NextResponse.json({ error: '親現場と工種名が必要です' }, { status: 400 })
      if (parent.parentId) return NextResponse.json({ error: '工種の下に工種は作れません' }, { status: 400 })
      if (sites.some(x => x.parentId === parent.id && (x.workType || '') === wt)) {
        return NextResponse.json({ error: `「${wt}」は既にあります` }, { status: 409 })
      }
      const child = inheritFromParent({
        id: 'site_' + Date.now(),
        name: '',
        parentId: parent.id,
        workType: wt,
        archived: false,
        // 単価は親の単価を初期値にする（工種ごとに単価タブで変える）
        tobiRate: parent.tobiRate || 0,
        dokoRate: parent.dokoRate || 0,
        rates: (parent.rates || []).map(r => ({ ...r })),
      }, parent)
      const updateData: Record<string, unknown> = { sites: [...sites, child].map(stripUndefinedDeep) }
      // 月別の職長（代理）も親と同じにする
      const mforeman = (data.mforeman || {}) as Record<string, { wid: number }>
      let mfChanged = false
      for (const [k, v] of Object.entries(mforeman)) {
        if (k.startsWith(parent.id + '_')) { mforeman[`${child.id}_${k.slice(parent.id.length + 1)}`] = v; mfChanged = true }
      }
      if (mfChanged) updateData.mforeman = mforeman
      await updateDoc(ref, updateData)
      await logActivity('admin', 'site.addWorkType', `${parent.name} に工種「${wt}」を追加`)
      return NextResponse.json({ success: true, site: child })
    }

    if (action === 'setDeputy') {
      const { siteId, ym, workerId } = body
      if (!siteId || !ym) {
        return NextResponse.json({ error: 'siteId and ym required' }, { status: 400 })
      }
      const mforeman = (data.mforeman || {}) as Record<string, { wid: number }>
      const key = `${siteId}_${ym}`
      mforeman[key] = { wid: Number(workerId) }
      // 工種サイトにも同じ月の職長を設定（職長は親現場と共通）
      for (const kid of sites.filter(x => x.parentId === siteId)) mforeman[`${kid.id}_${ym}`] = { wid: Number(workerId) }
      await updateDoc(ref, { mforeman })
      return NextResponse.json({ success: true })
    }

    if (action === 'removeDeputy') {
      const { siteId, ym } = body
      if (!siteId || !ym) {
        return NextResponse.json({ error: 'siteId and ym required' }, { status: 400 })
      }
      const mforeman = (data.mforeman || {}) as Record<string, { wid: number }>
      const key = `${siteId}_${ym}`
      delete mforeman[key]
      for (const kid of sites.filter(x => x.parentId === siteId)) delete mforeman[`${kid.id}_${ym}`]
      await updateDoc(ref, { mforeman })
      return NextResponse.json({ success: true })
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  } catch (error) {
    console.error('Sites POST error:', error)
    return NextResponse.json({ error: String(error) }, { status: 500 })
  }
}

/**
 * 請負体制（元請・一次・担当の二次）から siteType と client（請求先名）を導いて保存用に返す（2026-09-15）。
 * ownerId が送られてこない旧クライアントは、送られてきた siteType / client をそのまま使う。
 */
function resolvePartiesFromBody(body: Record<string, unknown>, data: Record<string, unknown>): Partial<RawSite> {
  const companies = ((data.subcons || []) as { id: string; name: string; roles?: string[] }[])
  const out: Partial<RawSite> = {}
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : undefined)
  if (body.gcId !== undefined) out.gcId = str(body.gcId) || ''
  if (body.primeId !== undefined) out.primeId = str(body.primeId) || ''
  if (body.ownerId !== undefined) {
    out.ownerId = str(body.ownerId) || ''
    if (out.ownerId) {
      const r = resolveSiteParties({ gcId: out.gcId, primeId: out.primeId, ownerId: out.ownerId }, companies)
      out.siteType = r.siteType
      out.client = r.billToName
      return out
    }
  }
  if (body.siteType !== undefined) out.siteType = body.siteType as 'direct' | 'support'
  if (body.client !== undefined) out.client = String(body.client)
  return out
}

/**
 * Firestore は undefined の値を拒否する（保存全体が失敗する）。現場レコードは画面の任意項目が多く、
 * 空のまま送られると undefined が混ざるため、書き込み直前に取り除く（2026-09-15・笹塚が保存できなかった件）。
 * ※ グローバルの ignoreUndefinedProperties は使わない。updateDoc で { map: { k: undefined } } が
 *   空マップ置換（データ消失）に化けるため（CLAUDE.md の Firestore 書き込み安全ルール）。
 */
function stripUndefinedDeep<T>(v: T): T {
  if (Array.isArray(v)) return v.map(stripUndefinedDeep) as unknown as T
  if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (x === undefined) continue
      out[k] = stripUndefinedDeep(x)
    }
    return out as T
  }
  return v
}
