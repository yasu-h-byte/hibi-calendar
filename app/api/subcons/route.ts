import { NextRequest, NextResponse } from 'next/server'
import { checkApiAuth, requireCap } from '@/lib/auth'
import { db } from '@/lib/firebase'
import { doc, getDoc, runTransaction, deleteField } from '@/lib/fsdb'
import { logActivity } from '@/lib/activity'
import { COMPANY_ROLES } from '@/lib/companies'
import { subconDeleteBlockReason } from '@/lib/master-refs'

/** roles を検証して正規化（未知の値は捨てる。空なら undefined） */
function normalizeRoles(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined
  const ok = Array.from(new Set(v.filter(r => COMPANY_ROLES.some(x => x.key === r)))) as string[]
  return ok.length ? ok : undefined
}

export async function GET(request: NextRequest) {
  // 2026-09-26: 読み取りも権限表どおり（lib/permissions.ts masters.view）。旧: ログインしていれば職長でも読めた
  { const denied = await requireCap(request, 'masters.view'); if (denied) return denied }
  try {
    const snap = await getDoc(doc(db, 'demmen', 'main'))
    if (!snap.exists()) return NextResponse.json({ subcons: [], siteAssign: {}, sites: [] })
    const data = snap.data()

    // Build subcon -> sites assignment map and per-site rate override map
    const assign = (data.assign || {}) as Record<string, {
      workers?: number[]
      subcons?: string[]
      subconRates?: Record<string, { rate?: number; otRate?: number }>
    }>
    const sites = ((data.sites || []) as { id: string; name: string; archived?: boolean }[])
      .filter(s => !s.archived)
      .map(s => ({ id: s.id, name: s.name }))

    const subconSites: Record<string, string[]> = {}
    const subconRates: Record<string, Record<string, { rate?: number; otRate?: number }>> = {}
    for (const [siteId, val] of Object.entries(assign)) {
      const subs = (val.subcons || []) as string[]
      for (const scId of subs) {
        if (!subconSites[scId]) subconSites[scId] = []
        subconSites[scId].push(siteId)
      }
      // per-site rate overrides
      if (val.subconRates) {
        for (const [scId, rateOv] of Object.entries(val.subconRates)) {
          if (!subconRates[scId]) subconRates[scId] = {}
          subconRates[scId][siteId] = rateOv
        }
      }
    }

    return NextResponse.json({ subcons: data.subcons || [], subconSites, subconRates, sites })
  } catch (error) {
    console.error('Subcons GET error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  // 2026-09-26: 取引先マスタの編集は事務・代表（lib/permissions.ts masters.edit）
  const denied = await requireCap(request, 'masters.edit')
  if (denied) return denied
  try {
    const body = await request.json()
    const { action } = body
    // 2026-10-02 総合点検: 旧は main を読んで subcons 配列・assign マップを丸ごと書き戻していた（同時の書き込みが消える）。
    //   ここから下は runTransaction の中で動く。操作の記録は確定してから書く。各 action の中身は従来のまま
    const pendingLogs: [string, string, string][] = []
    const log = (userId: string, act: string, details: string) => { pendingLogs.push([userId, act, details]) }
    const docRef = doc(db, 'demmen', 'main')
    const response: Response = await runTransaction(db, async (tx) => {
    pendingLogs.length = 0
    const snap = await tx.get(docRef)
    if (!snap.exists()) return NextResponse.json({ error: 'Data not found' }, { status: 404 })
    const subcons = (snap.data().subcons || []) as Record<string, unknown>[]

    if (action === 'add') {
      const { name, type, rate, otRate, note, companyGroup } = body
      if (!name) return NextResponse.json({ error: '名前を入力してください' }, { status: 400 })
      // 同名の取引先の二重登録を防ぐ（表記ゆれで同じ会社が2件になると集計が割れる）
      const norm = (x: string) => String(x).replace(/[\s　]|株式会社|（株）|\(株\)|有限会社|（有）/g, '')
      const dup = subcons.find(sc => norm(String(sc.name || '')) === norm(name))
      if (dup) return NextResponse.json({ error: `「${dup.name}」が既に登録されています`, existingId: dup.id }, { status: 409 })
      // ID に「_」を入れない（出面のキー `{現場}_{外注ID}_{年月}_{日}` は「_」区切りで、旧の ID（例 `________99u1`）は
      //   集計で外注を見つけられず原価・請求から抜けていた・2026-10-02 点検。読む側は parseSdKey で旧 ID にも対応済み）
      const id = (name.toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 16) || 'sc') + Date.now().toString(36).slice(-6)
      // companyGroup: 兼業業者を1社としてまとめるためのグループ名（任意）
      // 例: 「株式会社A（鳶）」「株式会社A（土工）」を companyGroup="株式会社A" でグルーピング
      const newSubcon: Record<string, unknown> = {
        id, name, type: type || '鳶業者',
        rate: Number(rate) || 0, otRate: Number(otRate) || 0, note: note || '',
      }
      const roles = normalizeRoles(body.roles)
      if (roles) newSubcon.roles = roles
      if (companyGroup && String(companyGroup).trim()) {
        newSubcon.companyGroup = String(companyGroup).trim()
      }
      // 応援の請求書（2026-09-25）の宛名用データ。元請・一次・同業のみ意味を持つ
      if (body.postal && String(body.postal).trim()) newSubcon.postal = String(body.postal).trim()
      if (body.address && String(body.address).trim()) newSubcon.address = String(body.address).trim()
      if (body.honorific && String(body.honorific).trim()) newSubcon.honorific = String(body.honorific).trim()
      if (body.paymentTerms && typeof body.paymentTerms === 'object') newSubcon.paymentTerms = body.paymentTerms
      subcons.push(newSubcon)
      tx.update(docRef, { subcons })
      log('admin', 'subcon.add', `${name} を追加`)
      return NextResponse.json({ success: true, subcon: newSubcon })
    }

    if (action === 'update') {
      const { id, ...updates } = body
      delete updates.action
      const idx = subcons.findIndex(s => s.id === id)
      if (idx === -1) return NextResponse.json({ error: 'Not found' }, { status: 404 })
      if (updates.roles !== undefined) {
        const roles = normalizeRoles(updates.roles)
        if (!roles) return NextResponse.json({ error: '役割を1つ以上選んでください' }, { status: 400 })
        updates.roles = roles
      }
      if (updates.rate !== undefined) updates.rate = Number(updates.rate)
      if (updates.otRate !== undefined) updates.otRate = Number(updates.otRate)
      // companyGroup: 空文字／null は「クリア指示」として扱う。
      //   updates から削除して spread を汚さず、その後 spread 結果から明示的に消す
      //   （updates のみ削除だと既存値が残ってしまうため両方の処理が必要）
      const shouldClearCompanyGroup =
        body.companyGroup === '' || body.companyGroup === null ||
        (updates.companyGroup !== undefined && !String(updates.companyGroup || '').trim())
      if (updates.companyGroup !== undefined) {
        const cg = String(updates.companyGroup || '').trim()
        if (cg) updates.companyGroup = cg
        else delete updates.companyGroup
      }
      subcons[idx] = { ...subcons[idx], ...updates }
      if (shouldClearCompanyGroup) {
        delete (subcons[idx] as Record<string, unknown>).companyGroup
      }
      tx.update(docRef, { subcons })
      log('admin', 'subcon.update', `${id} を更新`)
      return NextResponse.json({ success: true })
    }

    if (action === 'updateSiteRates') {
      const { subconId, siteRates } = body as {
        subconId: string
        siteRates: Record<string, number | null>
      }
      if (!subconId || !siteRates || typeof siteRates !== 'object') {
        return NextResponse.json({ error: 'subconId and siteRates required' }, { status: 400 })
      }

      if (!/^[A-Za-z0-9_-]+$/.test(subconId)) return NextResponse.json({ error: 'subconId の形式が不正です' }, { status: 400 })
      const assign = (snap.data().assign || {}) as Record<string, {
        workers?: number[]
        subcons?: string[]
        subconRates?: Record<string, { rate?: number; otRate?: number }>
      }>

      // 2026-10-02 総合点検:
      //   - 旧は assign マップ丸ごとの書き戻し → この現場・この外注のキーだけをドット記法で書く
      //   - 旧は `{ rate }` で置き換えていたので、現場マスタで入れた残業単価（otRate）の上書きが、
      //     取引先を保存するたびに消えていた → 変わらない現場は書かず、変える現場も otRate はそのまま残す
      const update: Record<string, unknown> = {}
      const changed: string[] = []
      for (const [siteId, rate] of Object.entries(siteRates)) {
        if (!/^[A-Za-z0-9_-]+$/.test(siteId)) return NextResponse.json({ error: 'siteId の形式が不正です' }, { status: 400 })
        const cur = assign[siteId]?.subconRates?.[subconId]
        const nextRate = (rate === null || rate === 0 || !rate) ? null : Number(rate)
        if (nextRate === null) {
          if (!cur) continue   // もともと無い → 何もしない
          // 削除: その現場・外注先の上書きを消す（空になった subconRates はそのまま空マップで残る。読む側は未設定と同じ扱い）
          update[`assign.${siteId}.subconRates.${subconId}`] = deleteField()
        } else {
          if (cur && cur.rate === nextRate) continue   // 変わっていない → 書かない（otRate を触らない）
          const next: { rate: number; otRate?: number } = { rate: nextRate }
          if (typeof cur?.otRate === 'number' && cur.otRate > 0) next.otRate = cur.otRate
          update[`assign.${siteId}.subconRates.${subconId}`] = next
        }
        changed.push(siteId)
      }
      if (changed.length > 0) {
        tx.update(docRef, update)
        log('admin', 'subcon.updateSiteRates', `${subconId} の現場別単価を更新（${changed.length}現場）`)
      }
      return NextResponse.json({ success: true, changed })
    }

    if (action === 'delete') {
      const { id } = body
      const filtered = subcons.filter(s => s.id !== id)
      if (filtered.length === subcons.length) return NextResponse.json({ error: 'Not found' }, { status: 404 })
      // 出面・請負体制・配置・請求書から参照があれば削除しない（lib/master-refs.ts・2026-10-02 総合点検）。
      //   旧: 確認なしに消え、過去月の外注人工・外注費が全画面から消えた（compute() は見つからない外注を飛ばす）
      {
        const blocked = await subconDeleteBlockReason(String(id), snap.data() as Parameters<typeof subconDeleteBlockReason>[1])
        if (blocked) return NextResponse.json({ error: blocked }, { status: 409 })
      }
      tx.update(docRef, { subcons: filtered })
      log('admin', 'subcon.delete', `${id} を削除`)
      return NextResponse.json({ success: true })
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
    })
    for (const [u, a, d] of pendingLogs) await logActivity(u, a, d)
    return response
  } catch (error) {
    console.error('Subcons POST error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
