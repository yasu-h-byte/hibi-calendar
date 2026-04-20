import { NextRequest, NextResponse } from 'next/server'
import { checkApiAuth } from '@/lib/auth'
import { db } from '@/lib/firebase'
import { doc, getDoc, setDoc } from 'firebase/firestore'
import { getWorkerByToken } from '@/lib/workers'

// 年度ヘルパー: 10月〜翌9月
function getCurrentFy(): string {
  const now = new Date()
  const m = now.getMonth() + 1 // 1-12
  const y = now.getFullYear()
  // 10月〜12月 → 当年度、1月〜9月 → 前年度
  return String(m >= 10 ? y : y - 1)
}

interface Purchase {
  id: string
  date: string      // YYYY-MM-DD
  amount: number
  item: string
  registeredAt: string
}

interface ToolBudgetRecord {
  workerId: number
  fy: string
  budget: number
  purchases: Purchase[]
}

interface ToolBudgetData {
  defaultBudget: number
  budgetByVisa?: Record<string, number>   // 在留資格別予算（外国人）
  budgetByRole?: Record<string, number>   // ロール別予算（日本人: 役員/職長/とび/土工）
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
    budgetByRole: data.budgetByRole || {},
    records: data.records || {},
  }
}

// 予算額を解決: 個別設定 > 在留資格別 > ロール別 > デフォルト
function resolveBudget(tbData: ToolBudgetData, visa?: string, jobType?: string): number {
  if (visa && visa !== 'none' && tbData.budgetByVisa?.[visa]) return tbData.budgetByVisa[visa]
  if (jobType && tbData.budgetByRole?.[jobType]) return tbData.budgetByRole[jobType]
  return tbData.defaultBudget || 30000
}

async function saveToolBudgetData(data: ToolBudgetData): Promise<void> {
  await setDoc(doc(db, 'demmen', 'toolBudget'), data)
}

export async function GET(request: NextRequest) {
  try {
    const token = request.nextUrl.searchParams.get('token')

    // スタッフ: 自分の残額のみ
    if (token) {
      const worker = await getWorkerByToken(token)
      if (!worker) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

      const tbData = await getToolBudgetData()
      const fy = request.nextUrl.searchParams.get('fy') || getCurrentFy()
      const key = `${worker.id}_${fy}`
      const record = tbData.records[key]

      if (!record) {
        const budget = resolveBudget(tbData, worker.visaType, worker.jobType)
        return NextResponse.json({ budget, used: 0, remaining: budget, purchases: [] })
      }

      const used = record.purchases.reduce((sum, p) => sum + p.amount, 0)
      return NextResponse.json({
        budget: record.budget,
        used,
        remaining: record.budget - used,
        purchases: record.purchases,
      })
    }

    // 管理者/事務: 全スタッフ一覧
    if (!await checkApiAuth(request)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const fy = request.nextUrl.searchParams.get('fy') || getCurrentFy()
    const tbData = await getToolBudgetData()

    // 対象スタッフ一覧（退職者以外の全員）
    const mainSnap = await getDoc(doc(db, 'demmen', 'main'))
    const workers: { id: number; name: string; visa: string; job?: string; org?: string; retired?: string }[] =
      mainSnap.exists() ? (mainSnap.data().workers || []) : []
    const activeWorkers = workers.filter(w => !w.retired)

    const result = activeWorkers.map(w => {
      const key = `${w.id}_${fy}`
      const record = tbData.records[key]
      const budget = record?.budget ?? resolveBudget(tbData, w.visa, w.job)
      const purchases = record?.purchases || []
      const used = purchases.reduce((sum: number, p: Purchase) => sum + p.amount, 0)
      return {
        workerId: w.id,
        workerName: w.name,
        visa: w.visa || '',
        job: w.job || '',
        org: w.org || '',
        budget,
        used,
        remaining: budget - used,
        purchases,
      }
    })

    return NextResponse.json({
      fy,
      currentFy: getCurrentFy(),
      defaultBudget: tbData.defaultBudget,
      budgetByVisa: tbData.budgetByVisa || {},
      budgetByRole: tbData.budgetByRole || {},
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
      const { workerId, fy, date, amount, item, budget } = body
      if (!workerId || !fy || !date || !amount) {
        return NextResponse.json({ error: 'Missing fields' }, { status: 400 })
      }

      const tbData = await getToolBudgetData()
      const key = `${workerId}_${fy}`

      if (!tbData.records[key]) {
        tbData.records[key] = {
          workerId,
          fy,
          budget: budget || tbData.defaultBudget,
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
      const { workerId, fy, purchaseId } = body
      if (!workerId || !fy || !purchaseId) {
        return NextResponse.json({ error: 'Missing fields' }, { status: 400 })
      }

      const tbData = await getToolBudgetData()
      const key = `${workerId}_${fy}`
      if (tbData.records[key]) {
        tbData.records[key].purchases = tbData.records[key].purchases.filter(p => p.id !== purchaseId)
        await saveToolBudgetData(tbData)
      }
      return NextResponse.json({ success: true })
    }

    // 予算額変更（個別）
    if (action === 'setBudget') {
      const { workerId, fy, budget } = body
      if (!workerId || !fy || budget === undefined) {
        return NextResponse.json({ error: 'Missing fields' }, { status: 400 })
      }

      const tbData = await getToolBudgetData()
      const key = `${workerId}_${fy}`
      if (!tbData.records[key]) {
        tbData.records[key] = { workerId, fy, budget: Number(budget), purchases: [] }
      } else {
        tbData.records[key].budget = Number(budget)
      }
      await saveToolBudgetData(tbData)
      return NextResponse.json({ success: true })
    }

    // デフォルト予算 / 在留資格別・ロール別予算の設定
    if (action === 'setDefaultBudget') {
      const { defaultBudget, budgetByVisa, budgetByRole } = body
      const tbData = await getToolBudgetData()
      if (defaultBudget !== undefined) tbData.defaultBudget = Number(defaultBudget)
      if (budgetByVisa) tbData.budgetByVisa = budgetByVisa
      if (budgetByRole) tbData.budgetByRole = budgetByRole
      await saveToolBudgetData(tbData)
      return NextResponse.json({ success: true })
    }

    // 年度リセット（新年度作成）
    if (action === 'resetFy') {
      const { fy } = body
      if (!fy) return NextResponse.json({ error: 'Missing fy' }, { status: 400 })

      const tbData = await getToolBudgetData()

      // 対象スタッフ取得（退職者以外の全員）
      const mainSnap = await getDoc(doc(db, 'demmen', 'main'))
      const workers: { id: number; visa: string; job?: string; retired?: string }[] =
        mainSnap.exists() ? (mainSnap.data().workers || []) : []
      const activeWorkers = workers.filter(w => !w.retired)

      for (const w of activeWorkers) {
        const key = `${w.id}_${fy}`
        if (!tbData.records[key]) {
          const budget = resolveBudget(tbData, w.visa, w.job)
          tbData.records[key] = { workerId: w.id, fy, budget, purchases: [] }
        }
      }

      await saveToolBudgetData(tbData)
      return NextResponse.json({ success: true, count: activeWorkers.length })
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  } catch (error) {
    console.error('Tool budget POST error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
