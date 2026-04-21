import { NextRequest, NextResponse } from 'next/server'
import { checkApiAuth } from '@/lib/auth'
import { db } from '@/lib/firebase'
import { doc, getDoc, setDoc } from 'firebase/firestore'
import { getWorkerByToken } from '@/lib/workers'

// ────────────────────────────────────────
// 各スタッフ個別の期間計算（入社日ベース、1年サイクル）
// ────────────────────────────────────────

interface Period {
  start: string  // YYYY-MM-DD
  end: string    // YYYY-MM-DD
  index: number  // 1 = 1年目, 2 = 2年目, ...
}

function getCurrentPeriod(hireDate: string, refDate: Date = new Date()): Period | null {
  if (!hireDate) return null
  const hire = new Date(hireDate + 'T00:00:00')
  if (isNaN(hire.getTime())) return null

  // 入社日から1年ごとの期間を計算し、refDateが含まれる期間を返す
  let start = new Date(hire)
  let index = 1
  while (true) {
    const next = new Date(start)
    next.setFullYear(next.getFullYear() + 1)
    if (next > refDate) break
    start = next
    index++
  }
  const end = new Date(start)
  end.setFullYear(end.getFullYear() + 1)
  end.setDate(end.getDate() - 1)

  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
    index,
  }
}

function getPeriodByIndex(hireDate: string, index: number): Period | null {
  if (!hireDate || index < 1) return null
  const hire = new Date(hireDate + 'T00:00:00')
  if (isNaN(hire.getTime())) return null
  const start = new Date(hire)
  start.setFullYear(start.getFullYear() + (index - 1))
  const end = new Date(start)
  end.setFullYear(end.getFullYear() + 1)
  end.setDate(end.getDate() - 1)
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
    index,
  }
}

interface Purchase {
  id: string
  date: string
  amount: number
  item: string
  registeredAt: string
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
    periodAnchors: data.periodAnchors || {},
    records: data.records || {},
  }
}

async function saveToolBudgetData(data: ToolBudgetData): Promise<void> {
  await setDoc(doc(db, 'demmen', 'toolBudget'), data)
}

// 対象: 技能実習生・特定技能のみ（日本人・事務・役員・退職は除外）
function isForeignActiveWorker(w: { visa?: string; retired?: string; job?: string }): boolean {
  if (w.retired) return false
  if (!w.visa) return false
  if (w.visa === 'none') return false
  // visaが jisshu* or tokutei* のみ対象
  return w.visa.startsWith('jisshu') || w.visa.startsWith('tokutei')
}

export async function GET(request: NextRequest) {
  try {
    const token = request.nextUrl.searchParams.get('token')

    // スタッフ: 自分の残額のみ
    if (token) {
      const worker = await getWorkerByToken(token)
      if (!worker) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
      if (!isForeignActiveWorker({ visa: worker.visaType, retired: worker.retired })) {
        return NextResponse.json({ error: 'Not eligible' }, { status: 403 })
      }

      const tbData = await getToolBudgetData()
      const anchor = tbData.periodAnchors?.[String(worker.id)]
      if (!anchor) {
        // 期間未設定 → 初期値として予算のみ返す
        const budget = (tbData.budgetByVisa?.[worker.visaType] ?? tbData.defaultBudget) || 30000
        return NextResponse.json({ budget, used: 0, remaining: budget, purchases: [], period: null })
      }

      const period = getCurrentPeriod(anchor)
      if (!period) return NextResponse.json({ error: 'Invalid anchor' }, { status: 400 })

      const key = `${worker.id}_${period.start}`
      const record = tbData.records[key]

      const budget = record?.budget ?? ((tbData.budgetByVisa?.[worker.visaType] ?? tbData.defaultBudget) || 30000)
      const purchases = record?.purchases || []
      const used = purchases.reduce((sum, p) => sum + p.amount, 0)

      return NextResponse.json({
        budget,
        used,
        remaining: budget - used,
        purchases,
        period,
      })
    }

    // 管理者/事務: 全外国人スタッフ一覧
    if (!await checkApiAuth(request)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const tbData = await getToolBudgetData()

    // 対象スタッフ取得
    const mainSnap = await getDoc(doc(db, 'demmen', 'main'))
    const workers: { id: number; name: string; visa: string; job?: string; org?: string; retired?: string; hireDate?: string }[] =
      mainSnap.exists() ? (mainSnap.data().workers || []) : []
    const targetWorkers = workers.filter(isForeignActiveWorker)

    const result = targetWorkers.map(w => {
      const anchor = tbData.periodAnchors?.[String(w.id)]
      const defaultBudget = (tbData.budgetByVisa?.[w.visa] ?? tbData.defaultBudget) || 30000

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
          used: 0,
          remaining: defaultBudget,
          purchases: [],
        }
      }

      const period = getCurrentPeriod(anchor)
      const key = period ? `${w.id}_${period.start}` : ''
      const record = key ? tbData.records[key] : null
      const budget = record?.budget ?? defaultBudget
      const purchases = record?.purchases || []
      const used = purchases.reduce((sum: number, p: Purchase) => sum + p.amount, 0)
      return {
        workerId: w.id,
        workerName: w.name,
        visa: w.visa,
        org: w.org || 'hibi',
        hireDate: w.hireDate,
        periodAnchor: anchor,
        period,
        budget,
        used,
        remaining: budget - used,
        purchases,
      }
    })

    return NextResponse.json({
      defaultBudget: tbData.defaultBudget,
      budgetByVisa: tbData.budgetByVisa || {},
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

    // 購入登録
    if (action === 'addPurchase') {
      const { workerId, periodStart, date, amount, item } = body
      if (!workerId || !periodStart || !date || !amount) {
        return NextResponse.json({ error: 'Missing fields' }, { status: 400 })
      }

      // worker情報から期間を検証
      const mainSnap = await getDoc(doc(db, 'demmen', 'main'))
      const workers = mainSnap.exists() ? (mainSnap.data().workers || []) : []
      const w = workers.find((wk: { id: number }) => wk.id === workerId)
      if (!w) return NextResponse.json({ error: 'Worker not found' }, { status: 404 })

      const tbData = await getToolBudgetData()
      const key = `${workerId}_${periodStart}`

      if (!tbData.records[key]) {
        // 新規作成: periodStartから1年後を計算
        const start = new Date(periodStart + 'T00:00:00')
        const end = new Date(start)
        end.setFullYear(end.getFullYear() + 1)
        end.setDate(end.getDate() - 1)
        const hireDate = w.hireDate || periodStart
        const period = getCurrentPeriod(hireDate, start)
        const budget = (tbData.budgetByVisa?.[w.visa] ?? tbData.defaultBudget) || 30000
        tbData.records[key] = {
          workerId,
          periodStart,
          periodEnd: end.toISOString().slice(0, 10),
          periodIndex: period?.index || 1,
          budget,
          purchases: [],
        }
      }

      tbData.records[key].purchases.push({
        id: `p_${Date.now()}`,
        date,
        amount: Number(amount),
        item: item || '',
        registeredAt: new Date().toISOString(),
      })

      await saveToolBudgetData(tbData)
      return NextResponse.json({ success: true })
    }

    // 購入削除
    if (action === 'deletePurchase') {
      const { workerId, periodStart, purchaseId } = body
      if (!workerId || !periodStart || !purchaseId) {
        return NextResponse.json({ error: 'Missing fields' }, { status: 400 })
      }

      const tbData = await getToolBudgetData()
      const key = `${workerId}_${periodStart}`
      if (tbData.records[key]) {
        tbData.records[key].purchases = tbData.records[key].purchases.filter(p => p.id !== purchaseId)
        await saveToolBudgetData(tbData)
      }
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
      if (tbData.records[key]) {
        tbData.records[key].budget = Number(budget)
        await saveToolBudgetData(tbData)
      }
      return NextResponse.json({ success: true })
    }

    // 期間起点日の設定（佐藤さんが手動設定）
    if (action === 'setPeriodAnchor') {
      const { workerId, anchor } = body
      if (!workerId) {
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
      const { defaultBudget, budgetByVisa } = body
      const tbData = await getToolBudgetData()
      if (defaultBudget !== undefined) tbData.defaultBudget = Number(defaultBudget)
      if (budgetByVisa) tbData.budgetByVisa = budgetByVisa
      await saveToolBudgetData(tbData)
      return NextResponse.json({ success: true })
    }

    // 特定期間の取得（履歴閲覧）
    if (action === 'getPeriod') {
      const { workerId, periodIndex } = body
      if (!workerId || !periodIndex) {
        return NextResponse.json({ error: 'Missing fields' }, { status: 400 })
      }

      const mainSnap = await getDoc(doc(db, 'demmen', 'main'))
      const workers = mainSnap.exists() ? (mainSnap.data().workers || []) : []
      const w = workers.find((wk: { id: number }) => wk.id === workerId)
      if (!w || !w.hireDate) return NextResponse.json({ error: 'Worker not found' }, { status: 404 })

      const period = getPeriodByIndex(w.hireDate, Number(periodIndex))
      if (!period) return NextResponse.json({ error: 'Invalid period' }, { status: 400 })

      const tbData = await getToolBudgetData()
      const key = `${workerId}_${period.start}`
      const record = tbData.records[key]
      const budget = record?.budget ?? ((tbData.budgetByVisa?.[w.visa] ?? tbData.defaultBudget) || 30000)
      const purchases = record?.purchases || []
      const used = purchases.reduce((sum: number, p: Purchase) => sum + p.amount, 0)

      return NextResponse.json({
        period,
        budget,
        used,
        remaining: budget - used,
        purchases,
      })
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  } catch (error) {
    console.error('Tool budget POST error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
