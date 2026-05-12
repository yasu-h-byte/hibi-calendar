import { NextRequest, NextResponse } from 'next/server'
import { checkApiAuth } from '@/lib/auth'
import { getWorkers } from '@/lib/workers'
import {
  addWorker,
  updateWorker,
  deleteWorker,
  generateWorkerToken,
  revokeWorkerToken,
} from '@/lib/worker-crud'
import { logActivity } from '@/lib/activity'

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
      // useOldRules: true なら保存、false/undefined ならフィールドを削除
      if (updates.useOldRules === true) {
        updates.useOldRules = true
      } else if ('useOldRules' in updates) {
        // チェック解除時は削除（明示的に false で残すと将来のフラグ追加で混乱しやすい）
        const { deleteField } = await import('firebase/firestore')
        updates.useOldRules = deleteField()
      }
      await updateWorker(id, updates)
      await logActivity('admin', 'worker.update', `ID:${id} を更新`)
      return NextResponse.json({ success: true })
    }

    if (action === 'delete') {
      const { id } = body
      if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
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
