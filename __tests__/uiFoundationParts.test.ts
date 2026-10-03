/**
 * UI/UX 磨き込み 土台②（2026-10-03）の呼び出し口のテスト。
 *   - lib/confirm-dialog.ts: ホストが無ければ window.confirm / prompt に落ちる。ホストがあればそちらへ。confirmDanger は「元に戻せません。」を必ず添える
 *   - lib/notify.ts: 失敗の帯の文面（通信の失敗は定型文・サーバの断りはその文）。ホストが無ければ window.alert に落ちる
 *   - lib/hooks/discardGuard.ts: 未保存ガードの窓は赤の「保存せずに閉じる」
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { confirmDialog, confirmDanger, confirmWithReason, registerConfirmHost, type ConfirmOptions } from '@/lib/confirm-dialog'
import { notify, failedMessage, registerNotifyHost, NETWORK_FAILED_DETAIL, type NotifyMessage } from '@/lib/notify'
import { confirmDiscardDialog } from '@/lib/hooks/discardGuard'

type W = { window?: { confirm: ReturnType<typeof vi.fn>; prompt: ReturnType<typeof vi.fn>; alert: ReturnType<typeof vi.fn> } }
const g = globalThis as unknown as W

describe('confirmDialog（ホスト無し → window.confirm）', () => {
  const confirm = vi.fn(); const prompt = vi.fn(); const alert = vi.fn()
  beforeEach(() => { g.window = { confirm, prompt, alert }; confirm.mockReset(); prompt.mockReset(); registerConfirmHost(null) })
  afterEach(() => { delete g.window })

  it('title と description をつなげて確かめ、OK なら true', async () => {
    confirm.mockReturnValueOnce(true)
    await expect(confirmDialog({ title: '提出しますか？', description: '承認待ちになります。', confirmLabel: '提出する' })).resolves.toBe(true)
    expect(confirm).toHaveBeenCalledWith('提出しますか？\n承認待ちになります。')
    confirm.mockReturnValueOnce(false)
    await expect(confirmDialog({ title: 'x', confirmLabel: 'y' })).resolves.toBe(false)
  })
  it('confirmDanger は「元に戻せません。」を1回だけ添える', async () => {
    confirm.mockReturnValue(true)
    await confirmDanger({ title: '取り消しますか？', description: '番号は欠番になります。', confirmLabel: '取り消す' })
    expect(confirm).toHaveBeenLastCalledWith('取り消しますか？\n番号は欠番になります。\n元に戻せません。')
    await confirmDanger({ title: '消しますか？', confirmLabel: '消す' })
    expect(confirm).toHaveBeenLastCalledWith('消しますか？\n元に戻せません。')
    await confirmDanger({ title: 'a', description: 'b。元に戻せません。', confirmLabel: 'c' })
    expect(confirm).toHaveBeenLastCalledWith('a\nb。元に戻せません。')
  })
  it('confirmWithReason は prompt に落ち、空や取り消しは null', async () => {
    prompt.mockReturnValueOnce(' 現場都合 ')
    await expect(confirmWithReason({ title: '直します', confirmLabel: '保存する', reason: { label: '直す理由' } })).resolves.toBe('現場都合')
    prompt.mockReturnValueOnce(null)
    await expect(confirmWithReason({ title: 'x', confirmLabel: 'y', reason: { label: 'r' } })).resolves.toBeNull()
    prompt.mockReturnValueOnce('   ')
    await expect(confirmWithReason({ title: 'x', confirmLabel: 'y', reason: { label: 'r' } })).resolves.toBeNull()
  })
})

describe('confirmDialog（ホストあり）', () => {
  afterEach(() => registerConfirmHost(null))
  it('ホストに渡し、理由つきは理由を返す', async () => {
    const seen: ConfirmOptions[] = []
    registerConfirmHost(async opts => { seen.push(opts); return { ok: true, reason: '理由' } })
    await expect(confirmDialog({ title: 't', confirmLabel: 'c', tone: 'danger' })).resolves.toBe(true)
    await expect(confirmWithReason({ title: 't2', confirmLabel: 'c', reason: { label: 'l' } })).resolves.toBe('理由')
    expect(seen.map(s => s.title)).toEqual(['t', 't2'])
    expect(seen[0].tone).toBe('danger')
  })
  it('未保存ガードは赤の「保存せずに閉じる」。変更が無ければ窓を出さない', async () => {
    const seen: ConfirmOptions[] = []
    registerConfirmHost(async opts => { seen.push(opts); return { ok: false } })
    await expect(confirmDiscardDialog(false)).resolves.toBe(true)
    await expect(confirmDiscardDialog(true)).resolves.toBe(false)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ tone: 'danger', confirmLabel: '保存せずに閉じる', cancelLabel: '閉じずに戻る' })
  })
})

describe('notify', () => {
  afterEach(() => { registerNotifyHost(null); delete g.window })

  it('failedMessage: サーバの断りはその文、通信の失敗は定型文、hint は後ろに', () => {
    expect(failedMessage('保存', '9月分は締めた月です')).toMatchObject({ kind: 'error', title: '保存できませんでした', detail: '9月分は締めた月です', sticky: true })
    expect(failedMessage('承認', new TypeError('Failed to fetch')).detail).toBe(NETWORK_FAILED_DETAIL)
    expect(failedMessage('承認', undefined).detail).toBe(NETWORK_FAILED_DETAIL)
    expect(failedMessage('承認', '通信エラーが発生しました').detail).toBe(NETWORK_FAILED_DETAIL)
    expect(failedMessage('承認', '権限がありません', '政仁さんに頼んでください').detail).toBe('権限がありません 政仁さんに頼んでください')
  })
  it('ホストがあれば帯へ。成功は消える・失敗は残る', () => {
    const got: NotifyMessage[] = []
    registerNotifyHost(m => got.push(m))
    notify.success('保存しました')
    notify.failed('提出', 'もう提出済みです')
    expect(got[0]).toMatchObject({ kind: 'success', title: '保存しました' })
    expect(got[0].sticky).toBeFalsy()
    expect(got[1]).toMatchObject({ kind: 'error', title: '提出できませんでした', detail: 'もう提出済みです', sticky: true })
  })
  it('ホストが無ければ window.alert に落ちる', () => {
    const alert = vi.fn()
    g.window = { confirm: vi.fn(), prompt: vi.fn(), alert }
    notify.error('見出し', '理由')
    expect(alert).toHaveBeenCalledWith('見出し\n理由')
  })
})
