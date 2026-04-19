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
  budgetByVisa?: Record<string, number>
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
    records: data.records || {},
  }
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
        // レコードなし → 予算の在留資格別デフォルト or 全体デフォルト
        const budget = (tbData.budgetByVisa?.[worker.visaType] ?? tbData.defaultBudget) || 30000
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

    // 対象スタッフ一覧（外国人のみ）
    const mainSnap = await getDoc(doc(db, 'demmen', 'main'))
    const workers: { id: number; name: string; visa: string; retired?: string }[] =
      mainSnap.exists() ? (mainSnap.data().workers || []) : []
    const foreignWorkers = workers.filter(w => w.visa && w.visa !== 'none' && !w.retired)

    const result = foreignWorkers.map(w => {
      const key = `${w.id}_${fy}`
      const record = tbData.records[key]
      const budget = record?.budget ?? ((tbData.budgetByVisa?.[w.visa] ?? tbData.defaultBudget) || 30000)
      const purchases = record?.purchases || []
      const used = purchases.reduce((sum: number, p: Purchase) => sum + p.amount, 0)
      return {
        workerId: w.id,
        workerName: w.name,
        visa: w.visa,
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

    // デフォルト予算 / 在留資格別予算の設定
    if (action === 'setDefaultBudget') {
      const { defaultBudget, budgetByVisa } = body
      const tbData = await getToolBudgetData()
      if (defaultBudget !== undefined) tbData.defaultBudget = Number(defaultBudget)
      if (budgetByVisa) tbData.budgetByVisa = budgetByVisa
      await saveToolBudgetData(tbData)
      return NextResponse.json({ success: true })
    }

    // 年度リセット（新年度作成）
    if (action === 'resetFy') {
      const { fy } = body
      if (!fy) return NextResponse.json({ error: 'Missing fy' }, { status: 400 })

      const tbData = await getToolBudgetData()

      // 対象スタッフ取得
      const mainSnap = await getDoc(doc(db, 'demmen', 'main'))
      const workers: { id: number; visa: string; retired?: string }[] =
        mainSnap.exists() ? (mainSnap.data().workers || []) : []
      const foreignWorkers = workers.filter(w => w.visa && w.visa !== 'none' && !w.retired)

      for (const w of foreignWorkers) {
        const key = `${w.id}_${fy}`
        if (!tbData.records[key]) {
          const budget = (tbData.budgetByVisa?.[w.visa] ?? tbData.defaultBudget) || 30000
          tbData.records[key] = { workerId: w.id, fy, budget, purchases: [] }
        }
      }

      await saveToolBudgetData(tbData)
      return NextResponse.json({ success: true, count: foreignWorkers.length })
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  } catch (error) {
    console.error('Tool budget POST error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
