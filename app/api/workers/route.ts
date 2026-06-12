import { NextRequest, NextResponse } from 'next/server'
import { checkApiAuth, getApiAuthUser } from '@/lib/auth'
import { getWorkers } from '@/lib/workers'
import {
  addWorker,
  updateWorker,
  deleteWorker,
  generateWorkerToken,
  revokeWorkerToken,
} from '@/lib/worker-crud'
import { logActivity } from '@/lib/activity'
import { db } from '@/lib/firebase'
import { doc, setDoc, getDocs, collection } from 'firebase/firestore'

// 2026-06-12 (監査 Sprint2-C): 給与に直結するフィールドの変更を永続監査ログに残す。
//   activityLog は500件で古い順に自動削除されるため、単価変更の証跡が数週間で消えていた。
//   auditTrail コレクションは削除処理を持たない（労基法115条の3年証跡）。
const PAY_FIELDS = ['rate', 'hourlyRate', 'salary', 'otMul', 'useOldRules', 'retired'] as const

export async function GET(request: NextRequest) {
  if (!await checkApiAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const workers = await getWorkers()
    return NextResponse.json({ workers })
  } catch (error) {
    console.error('Failed to fetch workers:', error)
    return NextResponse.json({ error: 'Failed to fetch workers' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  if (!await checkApiAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await request.json()
    const { action } = body

    if (action === 'add') {
      const { name, org, visa, job, rate, hourlyRate, otMul, hireDate, salary, visaExpiry, dispatchTo, dispatchFrom, useOldRules } = body
      if (!name) {
        return NextResponse.json({ error: '名前を入力してください' }, { status: 400 })
      }
      const workerData: Parameters<typeof addWorker>[0] = {
        name,
        org: org || 'hibi',
        visa: visa || 'none',
        job: job || 'tobi',
        rate: Number(rate) || 0,
        otMul: Number(otMul) || 1.25,
        hireDate: hireDate || '',
      }
      if (hourlyRate !== undefined && hourlyRate !== '' && Number(hourlyRate) > 0) {
        (workerData as Record<string, unknown>).hourlyRate = Number(hourlyRate)
      }
      if (salary !== undefined && salary !== '' && Number(salary) > 0) {
        (workerData as Record<string, unknown>).salary = Number(salary)
      }
      if (visaExpiry) {
        (workerData as Record<string, unknown>).visaExpiry = visaExpiry
      }
      if (dispatchTo && String(dispatchTo).trim()) {
        (workerData as Record<string, unknown>).dispatchTo = String(dispatchTo).trim()
      }
      if (dispatchFrom && String(dispatchFrom).trim()) {
        (workerData as Record<string, unknown>).dispatchFrom = String(dispatchFrom).trim()
      }
      if (useOldRules === true) {
        (workerData as Record<string, unknown>).useOldRules = true
      }
      const worker = await addWorker(workerData)
      await logActivity('admin', 'worker.add', `${name} を追加`)
      return NextResponse.json({ success: true, worker })
    }

    if (action === 'update') {
      const { id, ...updates } = body
      if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
      delete updates.action
      if (updates.rate !== undefined) updates.rate = Number(updates.rate) || 0
      if (updates.hourlyRate !== undefined) {
        const hr = Number(updates.hourlyRate)
        updates.hourlyRate = hr > 0 ? hr : 0
      }
      if (updates.otMul !== undefined) updates.otMul = Number(updates.otMul) || 1.25
      if (updates.salary !== undefined) {
        const sal = Number(updates.salary)
        updates.salary = sal > 0 ? sal : 0
      }
      if (updates.dispatchTo !== undefined) {
        updates.dispatchTo = String(updates.dispatchTo || '').trim()
      }
      if (updates.dispatchFrom !== undefined) {
        updates.dispatchFrom = String(updates.dispatchFrom || '').trim()
      }
      // 2026-06-12 (監査 Sprint2-C): 給与系フィールドの old→new を永続記録（更新前に現値を取得）
      const beforeWorkers = await getWorkers()
      const beforeW = beforeWorkers.find(w => w.id === Number(id)) as Record<string, unknown> | undefined

      // useOldRules: true なら保存、false/undefined ならフィールドを削除
      const useOldRulesNew = updates.useOldRules === true
      if (updates.useOldRules === true) {
        updates.useOldRules = true
      } else if ('useOldRules' in updates) {
        // チェック解除時は削除（明示的に false で残すと将来のフラグ追加で混乱しやすい）
        const { deleteField } = await import('firebase/firestore')
        updates.useOldRules = deleteField()
      }
      await updateWorker(id, updates)

      // 給与系フィールドの差分を auditTrail へ（削除されない永続コレクション）
      const changes: Record<string, { from: unknown; to: unknown }> = {}
      for (const f of PAY_FIELDS) {
        if (!(f in updates)) continue
        const oldV = beforeW?.[f] ?? null
        const newV = f === 'useOldRules' ? useOldRulesNew : (updates[f] ?? null)
        if (JSON.stringify(oldV) !== JSON.stringify(newV)) changes[f] = { from: oldV, to: newV }
      }
      if (Object.keys(changes).length > 0) {
        const auth = await getApiAuthUser(request)
        const actor = auth.authorized ? String(auth.actor) : 'unknown'
        const at = new Date().toISOString()
        const detail = Object.entries(changes).map(([k, v]) => `${k}: ${v.from ?? '—'} → ${v.to ?? '—'}`).join(', ')
        await setDoc(doc(db, 'auditTrail', `worker-${id}-${Date.now()}`), {
          type: 'worker.payChange',
          workerId: Number(id),
          workerName: beforeW?.name || '',
          changes,
          actor,
          at,
        })
        await logActivity('admin', 'worker.payChange', `${beforeW?.name || `ID:${id}`} 給与系変更: ${detail}（操作者: ${actor}）`)
      } else {
        await logActivity('admin', 'worker.update', `ID:${id} を更新`)
      }
      return NextResponse.json({ success: true })
    }

    if (action === 'delete') {
      const { id } = body
      if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

      // 2026-06-12 (監査 Sprint2-C): 出面実績のあるスタッフの削除をブロック。
      //   main.workers から消すと computeMonthly の起点が消え、過去の全月次集計・
      //   Excel・原価からその人が遡って消えてしまう（支払済み金額の証跡が壊れる）。
      //   正しい運用は「退職日の設定」（翌月以降に自動で集計から外れる）。
      {
        const allDocs = await getDocs(collection(db, 'demmen'))
        const marker = `_${id}_`
        let foundYm: string | null = null
        allDocs.forEach(snap => {
          if (foundYm || !snap.id.startsWith('att_')) return
          const d = (snap.data().d || {}) as Record<string, unknown>
          for (const key of Object.keys(d)) {
            if (key.includes(marker)) { foundYm = snap.id.slice(4); break }
          }
        })
        if (foundYm) {
          return NextResponse.json({
            error: `出面実績（${foundYm} 等）があるため削除できません。削除すると過去の給与集計からも消えてしまいます。代わりに「退職日」を設定してください（翌月以降は自動で集計対象外になります）`,
          }, { status: 409 })
        }
      }

      await deleteWorker(id)
      await logActivity('admin', 'worker.delete', `ID:${id} を削除`)
      return NextResponse.json({ success: true })
    }

    if (action === 'generateToken') {
      const { id } = body
      if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
      const token = await generateWorkerToken(id)
      return NextResponse.json({ success: true, token })
    }

    if (action === 'revokeToken') {
      const { id } = body
      if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
      await revokeWorkerToken(id)
      return NextResponse.json({ success: true })
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  } catch (error) {
    console.error('Workers POST error:', error)
    return NextResponse.json({ error: String(error) }, { status: 500 })
  }
}
