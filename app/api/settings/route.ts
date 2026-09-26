import { NextRequest, NextResponse } from 'next/server'
import { checkApiAuth, clearPasswordCache, getApiAuthUser, requireCap } from '@/lib/auth'
import { db } from '@/lib/firebase'
import { doc, getDoc, setDoc, updateDoc, collection, getDocs } from '@/lib/fsdb'
import { logActivity } from '@/lib/activity'

// 2026-06-12 (監査S3): 管理者層（ADMIN_PASSWORD / SUPER_ADMIN_PASSWORD）かを判定。
//   個人パスワード（事務・役員個人）では「全員のパスワード閲覧・変更」「権限設定」「復元」を
//   実行できないようにする（個人パスワード1つの漏洩が全アカウント乗っ取りに昇格するのを防ぐ）。
async function getAdminTier(request: NextRequest): Promise<'super-admin' | 'admin' | 'personal' | null> {
  const auth = await getApiAuthUser(request)
  if (!auth.authorized) return null
  if (auth.actor === 'super-admin') return 'super-admin'
  // 共通パスワード（旧 'admin'）は API では通らない（2026-09-26・lib/session-token.ts）
  return 'personal'
}

async function getMainDoc() {
  const docRef = doc(db, 'demmen', 'main')
  const docSnap = await getDoc(docRef)
  if (!docSnap.exists()) return null
  return { ref: docRef, data: docSnap.data() }
}

// GET: return defaultRates from demmen/main
export async function GET(request: NextRequest) {
  if (!await checkApiAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const action = request.nextUrl.searchParams.get('action')
    // 2026-09-26: 既定単価（action なし・現場マスタが読む）以外はすべて代表だけ（lib/permissions.ts system.admin）。
    //   旧: 自社・HFU の振込先などをどの個人パスワードでも読めた
    if (action) {
      const denied = await requireCap(request, 'system.admin')
      if (denied) return denied
    }
    const result = await getMainDoc()
    if (!result) {
      return NextResponse.json({ defaultRates: { tobiRate: 0, dokoRate: 0 } })
    }

    if (action === 'getUserPasswords') {
      // 監査S3: 個人パスワードでは全員のパスワードを閲覧不可（権限昇格防止）
      const tier = await getAdminTier(request)
      if (tier !== 'super-admin' && tier !== 'admin') {
        return NextResponse.json({ error: 'この操作には管理者パスワードが必要です' }, { status: 403 })
      }
      const userPasswords = (result.data.userPasswords as Record<string, string>) || {}
      return NextResponse.json({ userPasswords })
    }

    if (action === 'getCompanyProfile') {
      const companyProfile = result.data.companyProfile || null
      return NextResponse.json({ companyProfile })
    }

    if (action === 'getHfuInvoice') {
      // HFU → 日比建設 の請求書の設定（lib/hfu-invoice.ts）
      const hfuInvoice = result.data.hfuInvoice || null
      return NextResponse.json({ hfuInvoice })
    }

    const defaultRates = (result.data.defaultRates as { tobiRate: number; dokoRate: number; baseDays?: number }) || { tobiRate: 0, dokoRate: 0 }
    return NextResponse.json({ defaultRates: { ...defaultRates, baseDays: defaultRates.baseDays ?? 20 } })
  } catch (error) {
    console.error('Settings GET error:', error)
    return NextResponse.json({ error: 'Failed to fetch settings' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  if (!await checkApiAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // 2026-09-26: 設定の変更はすべて代表だけ（lib/permissions.ts system.admin）
  const denied = await requireCap(request, 'system.admin')
  if (denied) return denied

  try {
    const body = await request.json()
    const { action } = body

    // 旧 savePermissions（役割ごとのメニュー表示の編集）は廃止。権限は lib/permissions.ts に一本化（2026-09-26）

    if (action === 'saveUserPasswords') {
      // 監査S3: 全員のパスワード変更は管理者パスワード限定（個人パスワードからの全員ロックアウト防止）
      const tier = await getAdminTier(request)
      if (tier !== 'super-admin' && tier !== 'admin') {
        return NextResponse.json({ error: 'この操作には管理者パスワードが必要です' }, { status: 403 })
      }
      const { userPasswords } = body
      if (!userPasswords || typeof userPasswords !== 'object') {
        return NextResponse.json({ error: 'userPasswords required' }, { status: 400 })
      }
      const docRef = doc(db, 'demmen', 'main')
      const { updateDoc } = await import('@/lib/fsdb')
      await updateDoc(docRef, { userPasswords })
      clearPasswordCache()  // キャッシュを即時無効化して新パスワードを即座に有効にする
      await logActivity('admin', 'settings.userPasswords', `個人パスワードを更新 (${tier})`)
      return NextResponse.json({ success: true })
    }

    if (action === 'saveDefaultRates') {
      const { tobiRate, dokoRate, baseDays } = body
      if (typeof tobiRate !== 'number' || typeof dokoRate !== 'number') {
        return NextResponse.json({ error: '単価は数値で入力してください' }, { status: 400 })
      }

      const docRef = doc(db, 'demmen', 'main')
      const docSnap = await getDoc(docRef)
      if (!docSnap.exists()) {
        return NextResponse.json({ error: 'No data found' }, { status: 404 })
      }

      const data = docSnap.data()
      const oldRates = (data.defaultRates as { tobiRate: number; dokoRate: number; baseDays?: number }) || { tobiRate: 0, dokoRate: 0 }
      let newBaseDays = typeof baseDays === 'number' ? baseDays : (oldRates.baseDays ?? 20)
      if (newBaseDays < 1 || newBaseDays > 31) newBaseDays = 20  // 安全なデフォルトに戻す
      // ⚠️ 旧コードは setDoc(docRef, { ...data, defaultRates: ... }) で demmen/main を全置換していた。
      //   read→write の間に他リクエスト（出面承認・有給更新等）が走ると、その変更を上書きで失う race
      //   condition があった。defaultRates のみピンポイント更新に変更（2026-05-07 修正）。
      await updateDoc(docRef, { defaultRates: { tobiRate, dokoRate, baseDays: newBaseDays } })
      await logActivity('admin', 'rates.default', `鳶 ¥${oldRates.tobiRate}→¥${tobiRate}, 土工 ¥${oldRates.dokoRate}→¥${dokoRate}, ベース日数 ${oldRates.baseDays ?? 20}→${newBaseDays}`)
      return NextResponse.json({ success: true })
    }

    if (action === 'saveCompanyProfile') {
      // 応援の請求書（docs/peer-invoice.md）の発行者情報。銀行口座を含むため管理者パスワード限定
      const tier = await getAdminTier(request)
      if (tier !== 'super-admin' && tier !== 'admin') {
        return NextResponse.json({ error: 'この操作には管理者パスワードが必要です' }, { status: 403 })
      }
      const { companyProfile } = body
      if (!companyProfile || typeof companyProfile !== 'object') {
        return NextResponse.json({ error: 'companyProfile required' }, { status: 400 })
      }
      const docRef = doc(db, 'demmen', 'main')
      const { updateDoc } = await import('@/lib/fsdb')
      await updateDoc(docRef, { companyProfile })
      await logActivity('admin', 'settings.companyProfile', `請求書の自社情報を更新 (${tier})`)
      return NextResponse.json({ success: true })
    }

    if (action === 'saveHfuInvoice') {
      // HFU → 日比建設 の請求書（docs/peer-invoice.md）。HFU の銀行口座を含むため管理者パスワード限定
      const tier = await getAdminTier(request)
      if (tier !== 'super-admin' && tier !== 'admin') {
        return NextResponse.json({ error: 'この操作には管理者パスワードが必要です' }, { status: 403 })
      }
      const { hfuInvoice } = body
      if (!hfuInvoice || typeof hfuInvoice !== 'object' || !hfuInvoice.profile || typeof hfuInvoice.profile !== 'object') {
        return NextResponse.json({ error: 'hfuInvoice required' }, { status: 400 })
      }
      const tobiRate = Math.max(0, Math.round(Number(hfuInvoice.tobiRate) || 0))
      const dokoRate = Math.max(0, Math.round(Number(hfuInvoice.dokoRate) || 0))
      const pt = hfuInvoice.paymentTerms
      const paymentTerms = pt && (pt.payMonthOffset === 1 || pt.payMonthOffset === 2)
        ? { closing: 'end', payMonthOffset: pt.payMonthOffset, payDay: pt.payDay === 'end' ? 'end' : Math.min(28, Math.max(1, Number(pt.payDay) || 25)) }
        : { closing: 'end', payMonthOffset: 1, payDay: 'end' }
      const docRef = doc(db, 'demmen', 'main')
      const { updateDoc } = await import('@/lib/fsdb')
      await updateDoc(docRef, { hfuInvoice: { profile: hfuInvoice.profile, tobiRate, dokoRate, paymentTerms } })
      await logActivity('admin', 'settings.hfuInvoice', `HFU → 日比建設 の請求書設定を更新（鳶 ¥${tobiRate.toLocaleString()}・土工 ¥${dokoRate.toLocaleString()}）(${tier})`)
      return NextResponse.json({ success: true })
    }

    if (action === 'backup') {
      const result = await getMainDoc()
      if (!result) {
        return NextResponse.json({ error: 'No data found' }, { status: 404 })
      }

      // Also export all att_YYYYMM documents (attendance data)
      const attDocs: Record<string, Record<string, unknown>> = {}
      const colRef = collection(db, 'demmen')
      const colSnap = await getDocs(colRef)
      for (const docSnap of colSnap.docs) {
        if (docSnap.id.startsWith('att_')) {
          attDocs[docSnap.id] = docSnap.data()
        }
      }

      return NextResponse.json({
        backup: {
          ...result.data,
          _attDocs: attDocs,
        },
      })
    }

    if (action === 'restore') {
      // 監査S3: 全データ置換の最危険操作。super-admin（靖仁さん）限定 + 復元前セーフティ退避。
      //   旧: checkApiAuth のみ（事務の個人パスワードでも実行可能）で setDoc 全置換だった。
      const tier = await getAdminTier(request)
      if (tier !== 'super-admin') {
        return NextResponse.json({ error: 'データ復元は super-admin のみ実行できます' }, { status: 403 })
      }
      const { data } = body
      if (!data || typeof data !== 'object') {
        return NextResponse.json({ error: '有効なJSONデータが必要です' }, { status: 400 })
      }

      // Safety checks
      if (!data.workers && !data.sites) {
        return NextResponse.json({ error: 'workers または sites フィールドが見つかりません。有効なバックアップファイルか確認してください' }, { status: 400 })
      }

      // 復元前に現在の main をセーフティ退避（誤復元からの復帰用）
      // ※ backups コレクションの rules スキーマ（sourceId + data 必須）に準拠
      const current = await getMainDoc()
      if (current) {
        const safetyRef = doc(db, 'backups', `pre-restore-${Date.now()}`)
        await setDoc(safetyRef, {
          sourceId: 'demmen/main',
          data: current.data,
          createdAt: new Date().toISOString(),
          reason: 'settings.restore 実行前の自動退避',
        })
      }

      // Separate attendance docs from main data
      const attDocs = (data._attDocs || {}) as Record<string, Record<string, unknown>>
      const mainData = { ...data }
      delete mainData._attDocs

      // Restore main document
      const docRef = doc(db, 'demmen', 'main')
      await setDoc(docRef, mainData)

      // Restore attendance documents
      for (const [attDocId, attDocData] of Object.entries(attDocs)) {
        if (attDocId.startsWith('att_') && attDocData && typeof attDocData === 'object') {
          const attDocRef = doc(db, 'demmen', attDocId)
          await setDoc(attDocRef, attDocData)
        }
      }

      await logActivity('admin', 'settings.restore', 'JSONバックアップから全データを復元 (super-admin)')
      return NextResponse.json({ success: true })
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  } catch (error) {
    console.error('Settings POST error:', error)
    return NextResponse.json({ error: String(error) }, { status: 500 })
  }
}
