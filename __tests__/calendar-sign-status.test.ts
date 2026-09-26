/**
 * 就業カレンダーの「未署名」の決まり（lib/calendar-sign-status.ts・2026-09-26）
 * 画面 8名・ベル 1名 と食い違った不具合の再発防止（ベルは配置者しか数えていなかった）
 */
import { describe, test, expect } from 'vitest'
import { summarizeSignStatus, buildSignRequestMessage, type SignStatusSite } from '@/lib/calendar-sign-status'

const w = (id: number, signed: boolean, assignedHere = false, reconfirmedAfterRevision = false) =>
  ({ id, name: `W${id}`, signed, assignedHere, reconfirmedAfterRevision })

describe('summarizeSignStatus', () => {
  test('全員×全現場: 自分の現場だけ署名した人は、ほかの承認済み現場が残っていれば未署名', () => {
    const sites: SignStatusSite[] = [
      { siteId: 'sasazuka', status: 'approved', workers: [w(1, true, true), w(2, true)] },
      { siteId: 'idemitsu', status: 'approved', workers: [w(1, false), w(2, true, true)] },
    ]
    const s = summarizeSignStatus(sites)
    expect(s.unsigned.map(x => x.id)).toEqual([1])
    expect(s.unsigned[0]).toMatchObject({ total: 2, signed: 1, remaining: 1 })
    expect(s.signedCount).toBe(1)
  })

  test('承認前の現場はまだ署名できないので数えない', () => {
    const s = summarizeSignStatus([
      { siteId: 'a', status: 'approved', workers: [w(1, true)] },
      { siteId: 'b', status: 'submitted', workers: [w(1, false)] },
      { siteId: 'c', status: null, workers: [w(1, false)] },
    ])
    expect(s.unsigned).toEqual([])
    expect(s.workers[0].total).toBe(1)
  })

  test('承認後に修正された現場: 配置者は再確認するまで未署名、配置されていない人は前の署名のままでよい', () => {
    const s = summarizeSignStatus([
      { siteId: 'a', status: 'approved', wasRevised: true, workers: [w(1, true, true, false), w(2, true, false), w(3, true, true, true)] },
    ])
    expect(s.unsigned.map(x => x.id)).toEqual([1])
  })

  test('送る文面: 個人リンクからの署名を案内し、廃止した名前選択のページには誘導しない', () => {
    const msg = buildSignRequestMessage(2026, 10, ['W1'])
    expect(msg).toContain('2026年10月')
    expect(msg).toContain('出面入力のリンク')
    expect(msg).toContain('W1')
    expect(msg).not.toContain('/calendar/public')
    expect(msg).not.toContain('名前を選んで')
  })
})
