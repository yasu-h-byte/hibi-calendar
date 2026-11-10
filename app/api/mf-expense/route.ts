/**
 * 経費の事前チェック（/expense-check）の API（2026-11-08・docs/mf-expense-check.md）。
 * 見る・設定は expenseCheck.view / expenseCheck.edit、MF との接続・切断は代表だけ（system.admin）。
 * 第1段階は見るだけ。MF の申請には何も書かない。
 */
import { NextRequest, NextResponse } from 'next/server'
import { actorLabel, requireCap } from '@/lib/auth'
import { logActivity } from '@/lib/activity'
import {
  createMfAuthorizeUrl, disconnectMf, getMfConnectionStatus, isMfConfigured, selectMfOffice, MF_REDIRECT_URI,
} from '@/lib/mf-expense-client.server'
import {
  loadMfWorkerOptions, loadMfItems, loadMfMembers, loadMfReceiptState, loadMfRejected, loadMfReminders, loadMfRouteTable, loadMfRunState, loadMfSettings, loadMfSyncedAt,
  loadOpenExpenseChecks, runMfExpenseCheck, saveExpenseReview, saveMfMemberLink, saveMfSettings, syncMfExpenseStatus,
} from '@/lib/mf-expense-run.server'
import { mfExpenseSettingsError, normalizeMfExpenseSettings, normalizeMfReviewNote, type MfOrg } from '@/lib/mf-expense-rules'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(request: NextRequest) {
  const denied = await requireCap(request, 'expenseCheck.view')
  if (denied) return denied
  try {
    const [connection, runState, settings, items, members, reminders, checks, receiptState, routeTable, rejected, syncedAt] = await Promise.all([
      getMfConnectionStatus(), loadMfRunState(), loadMfSettings(), loadMfItems(), loadMfMembers(),
      loadMfReminders(), loadOpenExpenseChecks(), loadMfReceiptState(), loadMfRouteTable(), loadMfRejected(), loadMfSyncedAt(),
    ])
    const workers = await loadMfWorkerOptions('hibi', Object.values(members).map(m => m.workerId))
    // HFU はスイッチを入れている間だけ見せる
    const hfu = settings.hfuEnabled
      ? await Promise.all([loadMfRunState('hfu'), loadMfItems('hfu'), loadMfMembers('hfu'), loadMfReminders('hfu'), loadMfRejected('hfu')])
      : null
    const hfuWorkers = hfu ? await loadMfWorkerOptions('hfu', Object.values(hfu[2]).map(m => m.workerId)) : []
    const withOrg = <T,>(rows: T[], org: MfOrg) => rows.map(r => ({ ...r, org }))
    return NextResponse.json({
      connection, runState, receiptState, settings,
      runStateHfu: hfu ? hfu[0] : null,
      items: [...withOrg(items, 'hibi'), ...withOrg(hfu ? hfu[1] : [], 'hfu')],
      members: [...withOrg(Object.values(members), 'hibi'), ...withOrg(hfu ? Object.values(hfu[2]) : [], 'hfu')],
      reminders: [...withOrg(reminders, 'hibi'), ...withOrg(hfu ? hfu[3] : [], 'hfu')],
      checks: checks.filter(c => settings.hfuEnabled || (c.org ?? 'hibi') === 'hibi'),
      rejected: [...rejected, ...(hfu ? hfu[4] : [])],
      syncedAt,
      workers: [...withOrg(workers, 'hibi'), ...withOrg(hfuWorkers, 'hfu')],
      routeTable,
      redirectUri: MF_REDIRECT_URI,
    })
  } catch (e) {
    console.error('経費の事前チェックの読み込みエラー:', e)
    return NextResponse.json({ error: '読み込みに失敗しました' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  const action = body?.action
  try {
    if (action === 'connect' || action === 'disconnect' || action === 'selectOffice') {
      const denied = await requireCap(request, 'system.admin')
      if (denied) return denied
      const actor = await actorLabel(request)
      if (action === 'connect') {
        if (!isMfConfigured()) return NextResponse.json({ error: 'MF経費の鍵が Vercel に設定されていません' }, { status: 400 })
        return NextResponse.json({ url: await createMfAuthorizeUrl(actor) })
      }
      if (action === 'disconnect') {
        await disconnectMf()
        await logActivity(actor, 'mf-expense', 'MF経費との接続を切りました')
        return NextResponse.json({ ok: true })
      }
      const officeId = typeof body?.officeId === 'string' ? body.officeId : ''
      if (!(await selectMfOffice(officeId))) return NextResponse.json({ error: '事業者が見つかりません' }, { status: 400 })
      await logActivity(actor, 'mf-expense', 'MF経費の事業者を選びました')
      return NextResponse.json({ ok: true })
    }

    // 画面を開いたときの読み直し。見られる人なら誰が開いても一覧を最新にする（MF には書かない）
    if (action === 'sync') {
      const denied = await requireCap(request, 'expenseCheck.view')
      if (denied) return denied
      return NextResponse.json(await syncMfExpenseStatus())
    }

    if (action === 'run' || action === 'saveSettings' || action === 'saveMember' || action === 'saveReview') {
      const denied = await requireCap(request, 'expenseCheck.edit')
      if (denied) return denied
      const actor = await actorLabel(request)
      const org: MfOrg = body?.org === 'hfu' ? 'hfu' : 'hibi'
      if (action === 'run') {
        const result = await runMfExpenseCheck({ actor, force: true, org })
        return NextResponse.json(result, { status: result.ok ? 200 : result.status === 'error' ? 502 : 409 })
      }
      if (action === 'saveSettings') {
        const settings = normalizeMfExpenseSettings(body?.settings as Parameters<typeof normalizeMfExpenseSettings>[0])
        const err = mfExpenseSettingsError(settings)
        if (err) return NextResponse.json({ error: err }, { status: 400 })
        await saveMfSettings(settings)
        await logActivity(actor, 'mf-expense', '経費の事前チェックの設定を変更しました')
        return NextResponse.json({ ok: true })
      }
      if (action === 'saveReview') {
        const reportId = typeof body?.reportId === 'string' ? body.reportId : ''
        if (!/^[\w-]+$/.test(reportId)) return NextResponse.json({ error: '入力が正しくありません' }, { status: 400 })
        let note: string | null = null
        if (body?.note !== null) {
          const n = normalizeMfReviewNote(body?.note)
          if (!n.ok) return NextResponse.json({ error: n.error }, { status: 400 })
          note = n.note
        }
        const who = await saveExpenseReview(reportId, note, actor)
        if (who === null) return NextResponse.json({ error: 'この申請はもう要確認の一覧にありません。画面を開き直してください' }, { status: 404 })
        await logActivity(actor, 'mf-expense', note === null ? `経費の確認を取り消し: ${who}` : `経費を確認: ${who}「${note}」`)
        return NextResponse.json({ ok: true })
      }
      const mfId = typeof body?.mfId === 'string' ? body.mfId : ''
      const workerId = body?.workerId
      if (!/^[\w-]+$/.test(mfId) || !(workerId === null || typeof workerId === 'number')) {
        return NextResponse.json({ error: '入力が正しくありません' }, { status: 400 })
      }
      if (workerId !== null && !(await loadMfWorkerOptions(org, [workerId])).some(w => w.id === workerId)) {
        return NextResponse.json({ error: org === 'hfu' ? 'HFU の技能実習生を選んでください' : '日比建設の作業員を選んでください' }, { status: 400 })
      }
      if (!(await saveMfMemberLink(mfId, workerId, org))) return NextResponse.json({ error: 'MF の従業員が見つかりません' }, { status: 404 })
      await logActivity(actor, 'mf-expense', `MFの従業員の結びつけを変更: ${mfId} → ${workerId ?? '作業員ではない'}`)
      return NextResponse.json({ ok: true })
    }

    return NextResponse.json({ error: '不明な操作です' }, { status: 400 })
  } catch (e) {
    console.error('経費の事前チェックの操作エラー:', e)
    return NextResponse.json({ error: '処理に失敗しました' }, { status: 500 })
  }
}
