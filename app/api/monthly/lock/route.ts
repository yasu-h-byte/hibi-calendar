import { NextRequest, NextResponse } from 'next/server'
import { getApiAuthUser } from '@/lib/auth'
import { db } from '@/lib/firebase'
import { doc, updateDoc, setDoc, getDocs, collection, query, where } from 'firebase/firestore'
import { logActivity } from '@/lib/activity'
import { getMainData, getAttData, computeMonthly, parseDKey } from '@/lib/compute'
import { validatePayrolls, type PayrollSnapshot } from '@/lib/payroll-validator'

/** JST 基準の当月 YYYYMM */
function currentYmJst(): string {
  const jst = new Date(Date.now() + 9 * 3600 * 1000)
  return `${jst.getUTCFullYear()}${String(jst.getUTCMonth() + 1).padStart(2, '0')}`
}

/**
 * 締め前チェック（2026-06-13 仕様確定）:
 * 「その月一ヶ月分のチェックがすべて終わってから初めて締められる」
 *
 * ① 月の完了: 進行中・未来の月は締め不可（月が終わって翌月になってから）
 * ② 職長チェック: 労働実績（出勤 w>0 / 残業 o>0）のある全「現場×日」に
 *    職長の日次承認（attendanceApprovals の foreman）が付いていること。
 *    組織別締めの場合は、その組織のスタッフの実績がある現場×日のみ対象。
 *    ※ 有給(p)・休み(r)・現場都合(h)・帰国(hk) のみの日は管理プロセス由来のため対象外
 *
 * 戻り値: エラーメッセージ（null = 締めOK）
 */
async function checkReadyToLock(ym: string, org?: string): Promise<string | null> {
  // ① 進行中・未来の月
  if (ym >= currentYmJst()) {
    return `${ym.slice(0, 4)}年${parseInt(ym.slice(4, 6))}月はまだ終わっていないため締められません。月が終わり、入力と職長チェックがすべて完了してから締めてください`
  }

  // ② 職長の日次承認チェック
  const main = await getMainData()
  const att = await getAttData(ym)
  const isHfu = (o?: string) => o === 'hfu' || o === 'HFU'
  const orgKey = org === 'hibi' || org === 'hfu' ? org : 'all'
  const workerOrg = new Map(main.workers.map(w => [w.id, isHfu(w.org) ? 'hfu' : 'hibi']))

  // 労働実績のある (現場, 日) を収集
  const needed = new Map<string, Set<number>>()
  for (const [key, entry] of Object.entries(att.d || {})) {
    if (!entry || typeof entry !== 'object') continue
    const pk = parseDKey(key)
    if (pk.ym !== ym) continue
    const wid = Number(pk.wid)
    const wOrg = workerOrg.get(wid)
    if (!wOrg) continue
    if (orgKey !== 'all' && wOrg !== orgKey) continue
    const e = entry as { w?: number; o?: number }
    if (!((e.w || 0) > 0 || (e.o || 0) > 0)) continue
    if (!needed.has(pk.sid)) needed.set(pk.sid, new Set())
    needed.get(pk.sid)!.add(Number(pk.day))
  }

  if (needed.size === 0) return null  // 実績ゼロ（対象者なし月）は承認チェック不要

  // 当月の職長承認済み (現場_ym_日) を収集
  const approved = new Set<string>()
  const apSnap = await getDocs(collection(db, 'attendanceApprovals'))
  apSnap.forEach(s => {
    if (!s.id.includes(`_${ym}_`)) return
    const d = s.data() as { foreman?: unknown }
    if (d.foreman) approved.add(s.id)
  })

  const siteNames = new Map(main.sites.map(s => [s.id, s.name]))
  const missing: string[] = []
  let missingTotal = 0
  for (const [sid, days] of needed) {
    const md = [...days].filter(d => !approved.has(`${sid}_${ym}_${String(d)}`)).sort((a, b) => a - b)
    if (md.length === 0) continue
    missingTotal += md.length
    missing.push(`${siteNames.get(sid) || sid}: ${md.slice(0, 8).join(',')}日${md.length > 8 ? ` 他${md.length - 8}日` : ''}`)
  }
  if (missing.length > 0) {
    return `職長チェック（日次承認）が完了していないため締められません（未承認 ${missingTotal}日分）。\n${missing.join('\n')}\n出面画面で職長承認を完了してから締めてください`
  }

  // ③ 給与計算の自動検算で critical が残っていないこと（給与が法令準拠で計算できている）
  {
    const siteWorkDaysMap = (main as { siteWorkDays?: Record<string, Record<string, number>> }).siteWorkDays?.[ym] || {}
    const hasCal = Object.keys(siteWorkDaysMap).length > 0
    const baseDays = (main.defaultRates as { baseDays?: number })?.baseDays ?? 20
    const result = computeMonthly(main, att.d, att.sd, ym, main.workDays[ym] || 0, hasCal ? siteWorkDaysMap : undefined, baseDays)
    const targets = result.workers.filter(w => orgKey === 'all' ? true : ((isHfu(w.org) ? 'hfu' : 'hibi') === orgKey))
    const v = validatePayrolls(targets as unknown as PayrollSnapshot[])
    if (v.critical > 0) {
      const names = [...new Set(v.issues.filter(i => i.severity === 'critical').map(i => i.workerName))].slice(0, 8).join('、')
      return `給与計算の自動検算で異常（critical ${v.critical}件: ${names}）が残っているため締められません。月次集計画面で該当スタッフの計算根拠を確認し、出面を修正してから締めてください`
    }
  }

  // ④ 未処理の有給申請（pending / 職長承認止まり）が残っていないこと
  //    締め後に承認されると支払額が変わるため、締め前に処理を完了させる
  {
    const lrSnap = await getDocs(query(collection(db, 'leaveRequests'), where('ym', '==', ym)))
    const pendings: string[] = []
    lrSnap.forEach(s => {
      const d = s.data() as { status?: string; workerName?: string; workerId?: number; day?: number }
      if (d.status !== 'pending' && d.status !== 'foreman_approved') return
      const wOrg = workerOrg.get(Number(d.workerId))
      if (orgKey !== 'all' && wOrg !== orgKey) return
      pendings.push(`${d.workerName || `ID${d.workerId}`}（${d.day}日・${d.status === 'pending' ? '未承認' : '職長承認のみ'}）`)
    })
    if (pendings.length > 0) {
      return `未処理の有給申請が ${pendings.length}件 残っているため締められません:\n${pendings.slice(0, 10).join('、')}\n有給管理画面で承認または却下を済ませてから締めてください`
    }
  }
  return null
}

/**
 * 締め時点の支給額スナップショットを保存（2026-06-12 監査 Sprint2-D）。
 *
 * 背景: 月次集計は表示のたびに「現在の」単価・出面で再計算されるため、
 * 締め（給与確定・振込）後に単価変更や出面修正があると、過去月の画面・Excel・
 * 監査PDFが黙って変わり「あの月いくら払ったか」が再現できなかった。
 * 締め時に worker 別支給額を凍結保存し、/api/monthly が現行計算と突合して
 * 差分があれば画面に警告する。
 */
async function savePayrollSnapshot(ym: string, orgKey: 'hibi' | 'hfu' | 'all', lockedBy: string): Promise<void> {
  const main = await getMainData()
  const att = await getAttData(ym)
  const siteWorkDaysMap = (main as { siteWorkDays?: Record<string, Record<string, number>> }).siteWorkDays?.[ym] || {}
  const hasCal = Object.keys(siteWorkDaysMap).length > 0
  const baseDays = (main.defaultRates as { baseDays?: number })?.baseDays ?? 20
  const result = computeMonthly(main, att.d, att.sd, ym, main.workDays[ym] || 0, hasCal ? siteWorkDaysMap : undefined, baseDays)
  const isHfu = (org?: string) => org === 'hfu' || org === 'HFU'
  const workers = result.workers
    .filter(w => orgKey === 'all' ? true : (orgKey === 'hfu' ? isHfu(w.org) : !isHfu(w.org)))
    .map(w => ({
      id: w.id,
      name: w.name,
      salaryNetPay: w.salaryNetPay || 0,
      totalCost: w.totalCost || 0,
    }))
  await setDoc(doc(db, 'payrollSnapshots', `${ym}_${orgKey}`), {
    ym,
    org: orgKey,
    lockedAt: new Date().toISOString(),
    lockedBy,
    workers,
    totalNetPay: workers.reduce((s, w) => s + w.salaryNetPay, 0),
  })
}

export async function POST(request: NextRequest) {
  // 2026-06-12 (監査 Sprint2-B): 操作者を識別して記録。
  //   旧: checkApiAuth + 'admin' 固定名義 → 誰が締め/解除したか追跡不能で、
  //   「締め→こっそり解除→改竄→再締め」が無痕跡で可能だった
  const auth = await getApiAuthUser(request)
  if (!auth.authorized) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const actorLabel = auth.actor === 'super-admin' ? 'super-admin'
    : auth.actor === 'admin' ? 'admin(共通PW)'
    : `workerId=${auth.actor}`

  try {
    const { ym, locked, org } = await request.json()
    if (!ym) {
      return NextResponse.json({ error: 'ym required' }, { status: 400 })
    }

    // 2026-06-13: 締め（locked=true）は「月が終了 + 職長チェック全完了」が前提条件。
    //   進行中の月や未承認日が残る月は締められない（解除には条件なし）
    if (locked) {
      const notReady = await checkReadyToLock(ym, org)
      if (notReady) {
        return NextResponse.json({ error: notReady }, { status: 409 })
      }
    }

    const docRef = doc(db, 'demmen', 'main')

    if (org === 'hibi' || org === 'hfu') {
      // 組織別ロック: locks["202603_hibi"] = true
      const lockKey = `${ym}_${org}`
      await updateDoc(docRef, { [`locks.${lockKey}`]: locked ? true : false })
      const orgLabel = org === 'hibi' ? '日比建設' : 'HFU'
      await logActivity('admin', locked ? 'monthly.lock' : 'monthly.unlock', `${ym} ${orgLabel}を${locked ? '締め' : '締め解除'}（操作者: ${actorLabel}）`)
    } else {
      // 後方互換: org未指定の場合は全体ロック（旧方式）
      await updateDoc(docRef, { [`locks.${ym}`]: locked ? true : false })
      await logActivity('admin', locked ? 'monthly.lock' : 'monthly.unlock', `${ym} を${locked ? '締め' : '締め解除'}（操作者: ${actorLabel}）`)
    }

    // 締め時のみ: 支給額スナップショットを凍結保存（解除時は最後の締め時点を保持）
    if (locked) {
      try {
        await savePayrollSnapshot(ym, org === 'hibi' || org === 'hfu' ? org : 'all', actorLabel)
      } catch (e) {
        // スナップショット失敗で締め自体は妨げない（締めは成立し、差分検知が無効になるだけ）
        console.error('[lock] payrollSnapshot 保存失敗:', e)
      }
    }

    return NextResponse.json({ success: true, locked: !!locked })
  } catch (error) {
    console.error('Lock POST error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
