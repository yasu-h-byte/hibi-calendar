import { NextRequest, NextResponse } from 'next/server'
import { checkApiAuth, requireCap } from '@/lib/auth'
import { db } from '@/lib/firebase'
import { doc, getDoc, setDoc } from '@/lib/fsdb'
import { getWorkerByToken, isToolBudgetEligible, toolBudgetDefaultFor } from '@/lib/workers'
import { getCurrentPeriod, getPeriodByIndex, toolBudgetAnchorOf, toolBudgetCarryIn, receiptPeriodOf, type ToolBudgetPeriod, findDuplicatePurchase } from '@/lib/tool-budget-period'
import { addDaysIso, addMonthsSafe } from '@/lib/date-utils'
import {
  isToolSubsidyKind, purchasesBudgetUse, purchasesCompanyAmount, toolSubsidyCompanyAmount, toolSubsidyError,
  TOOL_SUBSIDY_ITEMS, type ToolSubsidyKind,
} from '@/lib/tool-subsidy'

// 期間の計算は lib/tool-budget-period.ts（スタッフのスマホと共通・2026-09-30）
type Period = ToolBudgetPeriod

interface Purchase {
  id: string
  date: string
  amount: number
  item: string
  registeredAt: string
  /** 残高を超えて登録した（事務が確認のうえ通した・2026-09-30）。超過分は翌期の枠から引かれる */
  over?: boolean
  /** 会社半額負担（2026-10-08・外国人の電動インパクト）。company = 会社が負担した額。枠から引くのは amount − company */
  subsidy?: { kind: ToolSubsidyKind; company: number }
}

interface ToolBudgetRecord {
  workerId: number
  periodStart: string  // 期間開始日（入社日基準）
  periodEnd: string
  periodIndex: number
  budget: number
  purchases: Purchase[]
}

interface ToolBudgetData {
  defaultBudget: number
  budgetByVisa?: Record<string, number>
  /** 日本人の職種別既定予算（2026-08-28 追加。キーは job: 'tobi'|'shokucho'|'doko' 等） */
  budgetByJob?: Record<string, number>
  periodAnchors?: Record<string, string>  // workerId(string) -> 期間起点日 YYYY-MM-DD
  records: Record<string, ToolBudgetRecord>
}

async function getToolBudgetData(): Promise<ToolBudgetData> {
  const snap = await getDoc(doc(db, 'demmen', 'toolBudget'))
  if (!snap.exists()) {
    return { defaultBudget: 30000, records: {} }
  }
  const data = snap.data()
  return {
    defaultBudget: data.defaultBudget ?? 30000,
    budgetByVisa: data.budgetByVisa || {},
    budgetByJob: data.budgetByJob || {},
    periodAnchors: data.periodAnchors || {},
    records: data.records || {},
  }
}

async function saveToolBudgetData(data: ToolBudgetData): Promise<void> {
  await setDoc(doc(db, 'demmen', 'toolBudget'), data)
}

/** その人の全期間の購入（2年に1回の確認用） */
function allPurchasesOf(tbData: ToolBudgetData, workerId: number): Purchase[] {
  return Object.values(tbData.records)
    .filter(r => r && Number(r.workerId) === Number(workerId))
    .flatMap(r => r.purchases || [])
}

// 対象判定は lib/workers.ts の isToolBudgetEligible に一元化（2026-08-28）。
// 従来は外国人（技能実習・特定技能）のみだったが、日本人の現場スタッフ
// （役員・事務を除く）も対象に拡大した。

export async function GET(request: NextRequest) {
  try {
    const token = request.nextUrl.searchParams.get('token')

    // スタッフ: 自分の残額のみ
    if (token) {
      const worker = await getWorkerByToken(token)
      if (!worker) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
      if (!isToolBudgetEligible({ visa: worker.visaType, job: worker.jobType, retired: worker.retired, hireDate: worker.hireDate })) {
        return NextResponse.json({ error: 'Not eligible' }, { status: 403 })
      }

      const tbData = await getToolBudgetData()
      const anchor = toolBudgetAnchorOf({ id: worker.id, visa: worker.visaType, hireDate: worker.hireDate }, tbData.periodAnchors).anchor
      if (!anchor) {
        // 期間未設定 → 初期値として予算のみ返す
        const budget = toolBudgetDefaultFor({ visa: worker.visaType, job: worker.jobType }, tbData)
        return NextResponse.json({ budget, used: 0, remaining: budget, purchases: [], period: null })
      }

      const period = getCurrentPeriod(anchor)
      if (!period) {
        // 起点日が未来 = 制度開始前。開始日と予算を予告として返す（残額としては見せない）
        const first = getPeriodByIndex(anchor, 1)
        if (first) {
          const budget = toolBudgetDefaultFor({ visa: worker.visaType, job: worker.jobType }, tbData)
          return NextResponse.json({
            budget, used: 0, remaining: 0, purchases: [], period: first, notStarted: true,
          })
        }
        return NextResponse.json({ error: 'Invalid anchor' }, { status: 400 })
      }

      const key = `${worker.id}_${period.start}`
      const record = tbData.records[key]

      const defaultBudgetT = toolBudgetDefaultFor({ visa: worker.visaType, job: worker.jobType }, tbData)
      const budget = record?.budget ?? defaultBudgetT
      const purchases = record?.purchases || []
      // 会社半額負担の分は枠から引かない（2026-10-08）
      const used = purchasesBudgetUse(purchases)
      // 前の期間からの繰越（2026-09-30）。マイナスは使いすぎの持ち越し
      const carry = toolBudgetCarryIn(anchor, period.index, worker.id, tbData.records, defaultBudgetT)

      return NextResponse.json({
        budget,
        carry,
        used,
        companyPaid: purchasesCompanyAmount(purchases),
        remaining: budget + carry - used,
        purchases,
        period,
      })
    }

    // 管理者/事務: 全スタッフ一覧（2026-09-26: 権限表の toolBudget.view。旧: 職長でも読めた）
    { const denied = await requireCap(request, 'toolBudget.view'); if (denied) return denied }

    const tbData = await getToolBudgetData()

    // 対象スタッフ取得
    const mainSnap = await getDoc(doc(db, 'demmen', 'main'))
    const workers: { id: number; name: string; visa: string; job?: string; org?: string; retired?: string; hireDate?: string }[] =
      mainSnap.exists() ? (mainSnap.data().workers || []) : []
    // filter に直接渡すと第2引数(index)が todayIso と衝突するのでラップする
    const targetWorkers = workers.filter(w => isToolBudgetEligible(w))

    const result = targetWorkers.map(w => {
      // 起点日が未設定のベトナム人は入社日を起点にする（2026-09-30）
      const { anchor, fromHireDate: anchorFromHireDate } = toolBudgetAnchorOf({ id: w.id, visa: w.visa, hireDate: w.hireDate }, tbData.periodAnchors)
      const defaultBudget = toolBudgetDefaultFor({ visa: w.visa, job: w.job }, tbData)

      if (!anchor) {
        // 期間未設定 → 予算のみ表示（登録不可）
        return {
          workerId: w.id,
          workerName: w.name,
          visa: w.visa,
          org: w.org || 'hibi',
          hireDate: w.hireDate,
          periodAnchor: null,
          period: null,
          budget: defaultBudget,
          defaultBudget,
          used: 0,
          remaining: defaultBudget,
          purchases: [],
        }
      }

      // 開始前（起点日が未来）は第1期を「予定」として返し、notStarted で区別する
      const cur = getCurrentPeriod(anchor)
      const period = cur ?? getPeriodByIndex(anchor, 1)
      const notStarted = !cur && !!period
      const key = period ? `${w.id}_${period.start}` : ''
      const record = key ? tbData.records[key] : null
      const budget = record?.budget ?? defaultBudget
      const purchases = record?.purchases || []
      const used = purchasesBudgetUse(purchases)
      // 前の期間からの繰越（2026-09-30）。開始前の人は0
      const carry = period && !notStarted ? toolBudgetCarryIn(anchor, period.index, w.id, tbData.records, defaultBudget) : 0
      return {
        workerId: w.id,
        workerName: w.name,
        visa: w.visa,
        org: w.org || 'hibi',
        hireDate: w.hireDate,
        periodAnchor: anchor,
        periodAnchorFromHireDate: anchorFromHireDate,
        period,
        notStarted,
        budget,
        // この人の区分の既定額（日本人 10万・外国人 3万など）。画面の「デフォルト」表示用
        defaultBudget,
        carry,
        used,
        companyPaid: purchasesCompanyAmount(purchases),
        remaining: budget + carry - used,
        purchases,
      }
    })

    return NextResponse.json({
      defaultBudget: tbData.defaultBudget,
      budgetByVisa: tbData.budgetByVisa || {},
      budgetByJob: tbData.budgetByJob || {},
      workers: result,
    })
  } catch (error) {
    console.error('Tool budget GET error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  if (!await checkApiAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await request.json()
    const { action } = body

    // 2026-09-26: 登録・予算変更は toolBudget.edit（事務・代表）。getPeriod（履歴を見る）は閲覧
    // 2026-10-02 総合点検: getPeriod は権限を見ていなかった（ログインしていれば職長でも任意の人の購入履歴を読めた）
    //   → GET と同じ toolBudget.view
    {
      const denied = await requireCap(request, action === 'getPeriod' ? 'toolBudget.view' : 'toolBudget.edit')
      if (denied) return denied
    }

    // 購入登録
    if (action === 'addPurchase') {
      const { workerId, periodStart, date, amount, item, allowOver, allowDuplicate, subsidyKind } = body
      if (!workerId || !periodStart || !date || !amount) {
        return NextResponse.json({ error: 'Missing fields' }, { status: 400 })
      }
      if (!(Number(amount) > 0)) {
        return NextResponse.json({ error: '金額が正しくありません' }, { status: 400 })
      }

      // worker情報から期間を検証
      const mainSnap = await getDoc(doc(db, 'demmen', 'main'))
      const workers = mainSnap.exists() ? (mainSnap.data().workers || []) : []
      const w = workers.find((wk: { id: number }) => wk.id === workerId)
      if (!w) return NextResponse.json({ error: 'Worker not found' }, { status: 404 })

      const tbData = await getToolBudgetData()

      // ── 登録時のチェック（2026-09-30 代表依頼）──
      //   ① 期間はその人の起点日から数えた期間であること（旧: 入社日で期間番号を出していた）
      //   ② 購入日がその期間の中であること（打ち間違いで別の期間に入るのを防ぐ）
      //   ③ 残高（予算＋前期からの繰越−使用済み）を超えないこと。超える場合は allowOver で明示したときだけ通し、
      //      購入に over を残す（超過分は翌期の枠から差し引かれる・toolBudgetCarryIn）
      //   2026-10-09（代表「あくまで領収書の日付ベースで管理したい」）: ①② を「領収書の日付で期間を決める」に変えた。
      //   画面で開いている期間（periodStart）ではなく、日付の入る期間に記録する（前の期間の領収書・開始前月の領収書も入る）
      const { anchor } = toolBudgetAnchorOf({ id: w.id, visa: w.visa, hireDate: w.hireDate }, tbData.periodAnchors)
      if (!anchor) {
        return NextResponse.json({ error: 'この人の道具代の起点日が設定されていません' }, { status: 400 })
      }
      const rp = receiptPeriodOf(anchor, String(date))
      if ('error' in rp) return NextResponse.json({ error: rp.error }, { status: 400 })
      const period = rp.period
      const key = `${workerId}_${period.start}`
      // ④ 会社半額負担（2026-10-08）: 対象者・対象日・2年に1回をサーバで確かめ、会社負担額もサーバで出す
      let subsidy: Purchase['subsidy'] | undefined
      if (subsidyKind) {
        if (!isToolSubsidyKind(subsidyKind)) return NextResponse.json({ error: '半額負担の品目が正しくありません' }, { status: 400 })
        const err = toolSubsidyError({ kind: subsidyKind, visa: w.visa, date: String(date), others: allPurchasesOf(tbData, w.id) })
        if (err) return NextResponse.json({ error: err }, { status: 400 })
        subsidy = { kind: subsidyKind, company: toolSubsidyCompanyAmount(subsidyKind, Number(amount)) }
      }
      // ⑤ 同じ購入日・同じ金額の登録がもうあれば、allowDuplicate で明示したときだけ通す（2026-10-09 二度押し対策）
      if (!allowDuplicate) {
        const dup = findDuplicatePurchase(allPurchasesOf(tbData, w.id), String(date), Number(amount))
        if (dup) {
          return NextResponse.json({
            error: `${String(date).replace(/-/g, '/')} の ¥${Number(amount).toLocaleString()}（${dup.item || '品名なし'}）がもう登録されています`,
            code: 'duplicate',
          }, { status: 409 })
        }
      }
      // 枠から引くのは本人負担の分だけ
      const useAmount = Number(amount) - (subsidy?.company ?? 0)

      const defaultBudget = toolBudgetDefaultFor({ visa: w.visa, job: w.job }, tbData)
      const cur = tbData.records[key]
      const budgetNow = cur?.budget ?? defaultBudget
      const usedNow = purchasesBudgetUse(cur?.purchases)
      const carryNow = toolBudgetCarryIn(anchor!, period.index, w.id, tbData.records, defaultBudget)
      const remainingNow = budgetNow + carryNow - usedNow
      const over = useAmount > remainingNow
      if (over && !allowOver) {
        return NextResponse.json({
          error: `${subsidy ? `本人負担 ¥${useAmount.toLocaleString()} が` : ''}残高 ¥${Math.max(0, remainingNow).toLocaleString()} を超えています（¥${(useAmount - Math.max(0, remainingNow)).toLocaleString()} 超過）`,
          code: 'over_budget',
          remaining: remainingNow,
          overBy: useAmount - Math.max(0, remainingNow),
        }, { status: 409 })
      }

      if (!cur) {
        tbData.records[key] = {
          workerId,
          periodStart: period.start,
          periodEnd: period.end,
          periodIndex: period.index,
          budget: defaultBudget,
          purchases: [],
        }
      }

      tbData.records[key].purchases.push({
        id: `p_${Date.now()}`,
        date,
        amount: Number(amount),
        item: item || '',
        registeredAt: new Date().toISOString(),
        ...(over ? { over: true } : {}),
        ...(subsidy ? { subsidy } : {}),
      })

      await saveToolBudgetData(tbData)
      // 画面で開いている期間と違う期間に入ったら、画面がそれを伝える
      return NextResponse.json({
        success: true, periodStart: period.start, periodEnd: period.end, periodIndex: period.index,
        otherPeriod: String(periodStart || '') !== period.start,
      })
    }

    // 購入削除
    if (action === 'deletePurchase') {
      const { workerId, periodStart, purchaseId } = body
      if (!workerId || !periodStart || !purchaseId) {
        return NextResponse.json({ error: 'Missing fields' }, { status: 400 })
      }

      const tbData = await getToolBudgetData()
      const key = `${workerId}_${periodStart}`
      // 2026-10-09: 見つからなければ「消した」と返さない（旧: 何もせず success を返していた）
      const rec = tbData.records[key]
      if (!rec || !rec.purchases.some(p => p.id === purchaseId)) {
        return NextResponse.json({ error: 'この購入記録は見つかりません（もう消えているか、別の期間の記録です）' }, { status: 404 })
      }
      rec.purchases = rec.purchases.filter(p => p.id !== purchaseId)
      await saveToolBudgetData(tbData)
      return NextResponse.json({ success: true })
    }

    // 登録済みの購入に会社半額負担を付ける／外す（2026-10-08。10月に普通の購入として入れた分を直す用）
    if (action === 'setPurchaseSubsidy') {
      const { workerId, periodStart, purchaseId, subsidyKind } = body
      if (workerId === undefined || workerId === null || !periodStart || !purchaseId) {
        return NextResponse.json({ error: 'Missing fields' }, { status: 400 })
      }
      const mainSnap = await getDoc(doc(db, 'demmen', 'main'))
      const workers = mainSnap.exists() ? (mainSnap.data().workers || []) : []
      const w = workers.find((wk: { id: number }) => wk.id === Number(workerId))
      if (!w) return NextResponse.json({ error: 'Worker not found' }, { status: 404 })

      const tbData = await getToolBudgetData()
      const rec = tbData.records[`${workerId}_${periodStart}`]
      const p = rec?.purchases.find(x => x.id === purchaseId)
      if (!rec || !p) return NextResponse.json({ error: '購入記録が見つかりません' }, { status: 404 })

      if (subsidyKind === null || subsidyKind === '') {
        delete p.subsidy
      } else {
        if (!isToolSubsidyKind(subsidyKind)) return NextResponse.json({ error: '半額負担の品目が正しくありません' }, { status: 400 })
        const others = allPurchasesOf(tbData, w.id).filter(x => x.id !== purchaseId)
        const err = toolSubsidyError({ kind: subsidyKind, visa: w.visa, date: p.date, others })
        if (err) return NextResponse.json({ error: err }, { status: 400 })
        p.subsidy = { kind: subsidyKind, company: toolSubsidyCompanyAmount(subsidyKind, p.amount) }
        if (!p.item) p.item = TOOL_SUBSIDY_ITEMS[subsidyKind].label
      }
      await saveToolBudgetData(tbData)
      return NextResponse.json({ success: true })
    }

    // 個別予算変更
    if (action === 'setBudget') {
      const { workerId, periodStart, budget } = body
      if (!workerId || !periodStart || budget === undefined) {
        return NextResponse.json({ error: 'Missing fields' }, { status: 400 })
      }

      const tbData = await getToolBudgetData()
      const key = `${workerId}_${periodStart}`

      // レコード未作成の場合は初期化してから予算を設定
      if (!tbData.records[key]) {
        tbData.records[key] = {
          workerId: Number(workerId),
          periodStart,
          // 開始日から1年の前日（旧: ローカル0時を toISOString して JST 環境では1日早くなった）
          periodEnd: addDaysIso(addMonthsSafe(periodStart, 12), -1),
          periodIndex: 1,
          budget: Number(budget),
          purchases: [],
        }
      } else {
        tbData.records[key].budget = Number(budget)
      }
      await saveToolBudgetData(tbData)
      return NextResponse.json({ success: true })
    }

    // 期間起点日の設定（佐藤さんが手動設定）
    if (action === 'setPeriodAnchor') {
      const { workerId, anchor } = body
      // ⚠️ `!workerId` にしないこと。日比靖仁さんの workerId は 0 で falsy のため弾かれる
      if (workerId === undefined || workerId === null || workerId === '') {
        return NextResponse.json({ error: 'Missing workerId' }, { status: 400 })
      }

      const tbData = await getToolBudgetData()
      if (!tbData.periodAnchors) tbData.periodAnchors = {}

      if (anchor === null || anchor === '') {
        delete tbData.periodAnchors[String(workerId)]
      } else {
        tbData.periodAnchors[String(workerId)] = anchor
      }

      await saveToolBudgetData(tbData)
      return NextResponse.json({ success: true })
    }

    // デフォルト予算設定
    if (action === 'setDefaultBudget') {
      const { defaultBudget, budgetByVisa, budgetByJob } = body
      const tbData = await getToolBudgetData()
      if (defaultBudget !== undefined) tbData.defaultBudget = Number(defaultBudget)
      if (budgetByVisa) tbData.budgetByVisa = budgetByVisa
      if (budgetByJob) tbData.budgetByJob = budgetByJob
      await saveToolBudgetData(tbData)
      return NextResponse.json({ success: true })
    }

    // 特定期間の取得（履歴閲覧）
    if (action === 'getPeriod') {
      const { workerId, periodIndex } = body
      // workerId は 0 もありうる（代表）ので !workerId で弾かない
      if (workerId === undefined || workerId === null || !periodIndex) {
        return NextResponse.json({ error: 'Missing fields' }, { status: 400 })
      }

      const mainSnap = await getDoc(doc(db, 'demmen', 'main'))
      const workers = mainSnap.exists() ? (mainSnap.data().workers || []) : []
      const w = workers.find((wk: { id: number }) => wk.id === workerId)
      if (!w) return NextResponse.json({ error: 'Worker not found' }, { status: 404 })

      // 2026-09-30 修正: 履歴も「起点日」から数える（旧: 入社日で数えていて、起点日が入社日と違う人は別の期間を出していた）
      const tbData = await getToolBudgetData()
      const anchor = toolBudgetAnchorOf({ id: w.id, visa: w.visa, hireDate: w.hireDate }, tbData.periodAnchors).anchor
      if (!anchor) return NextResponse.json({ error: '期間の起点日が未設定です' }, { status: 400 })
      const period = getPeriodByIndex(anchor, Number(periodIndex))
      if (!period) return NextResponse.json({ error: 'Invalid period' }, { status: 400 })

      const key = `${workerId}_${period.start}`
      const record = tbData.records[key]
      const defaultBudgetP = toolBudgetDefaultFor({ visa: w.visa, job: w.job }, tbData)
      const budget = record?.budget ?? defaultBudgetP
      const purchases = record?.purchases || []
      const used = purchasesBudgetUse(purchases)
      const carry = toolBudgetCarryIn(anchor, period.index, w.id, tbData.records, defaultBudgetP)

      return NextResponse.json({
        period,
        budget,
        carry,
        used,
        companyPaid: purchasesCompanyAmount(purchases),
        remaining: budget + carry - used,
        purchases,
      })
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  } catch (error) {
    console.error('Tool budget POST error:', error)
    const msg = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ error: 'Server error', detail: msg }, { status: 500 })
  }
}
