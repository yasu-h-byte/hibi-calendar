/**
 * 書類庫 API（2026-09-28 第1段階）。仕組みは lib/staff-docs.ts の冒頭を参照。
 *
 * GET  /api/staff-docs                 → 書類の一覧（ファイルの中身・URL は返さない）
 * GET  /api/staff-docs?open=ID&i=0     → そのファイルを見るための署名つきURL（15分）
 * POST { action: 'prepare', workerId, type, files:[{name,contentType,size}] }
 *        → 置き場のパスと、ブラウザが直接 PUT する署名つきURL（まだ記録は作らない）
 * POST { action: 'commit', docId, workerId, type, files, title?, validFrom?, expiresOn?, note?, makeCurrent? }
 *        → アップロード済みか確かめて記録を作る。makeCurrent なら同じ人・同じ種類の最新を旧版にする
 * POST { action: 'update', docId, type?, title?, validFrom?, expiresOn?, note? }
 * POST { action: 'setStatus', docId, status: 'current'|'old' }
 * POST { action: 'delete', docId }     → ファイルごと削除（代表だけ）
 *
 * 権限は lib/permissions.ts の staffDocs.view / staffDocs.edit / staffDocs.delete。
 */
import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { getApiAuthUser, requireCap } from '@/lib/auth'
import { db } from '@/lib/firebase'
import { collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc } from '@/lib/fsdb'
import { getMainData } from '@/lib/compute'
import { logActivity } from '@/lib/activity'
import {
  STAFF_DOC_TYPES, STAFF_DOC_ALLOWED_TYPES, STAFF_DOC_MAX_FILE_BYTES, STAFF_DOC_MAX_FILES,
  safeFileName, isValidIsoDate, type StaffDoc, type StaffDocFile, type StaffDocType,
} from '@/lib/staff-docs'
import { signedUploadUrl, signedReadUrl, fileMeta, deleteFile, getStaffDocsBucket } from '@/lib/storage-admin'

export const dynamic = 'force-dynamic'

const COL = 'staffDocs'

async function actorLabel(request: NextRequest): Promise<string> {
  const a = await getApiAuthUser(request)
  if (!a.authorized) return 'unknown'
  return a.actor === 'super-admin' ? 'super-admin' : `worker:${a.actor}`
}

function storageUnavailable() {
  return NextResponse.json({ error: 'ファイルの置き場に接続できません（サーバー設定を確認してください）' }, { status: 503 })
}

const isDocType = (t: unknown): t is StaffDocType => STAFF_DOC_TYPES.some(d => d.key === t)

/** 任意の日付欄: 空なら undefined、形式が違えば 'invalid' */
function optDate(v: unknown): string | undefined | 'invalid' {
  if (v === undefined || v === null || v === '') return undefined
  return isValidIsoDate(v) ? v : 'invalid'
}

function optText(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined
  const t = v.trim().slice(0, max)
  return t || undefined
}

async function readAll(): Promise<StaffDoc[]> {
  const snap = await getDocs(collection(db, COL))
  const out: StaffDoc[] = []
  snap.forEach((d: { id: string; data: () => Record<string, unknown> }) => out.push({ ...(d.data() as unknown as StaffDoc), id: d.id }))
  return out
}

/** Firestore に undefined を書かない（フィールドごと消える事故を避ける） */
function compact<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T
}

export async function GET(request: NextRequest) {
  const denied = await requireCap(request, 'staffDocs.view')
  if (denied) return denied

  const open = request.nextUrl.searchParams.get('open')
  if (open) {
    const i = Number(request.nextUrl.searchParams.get('i') || 0)
    const snap = await getDoc(doc(db, COL, open))
    if (!snap.exists()) return NextResponse.json({ error: '書類が見つかりません' }, { status: 404 })
    const d = snap.data() as StaffDoc
    const f = d.files?.[i]
    if (!f) return NextResponse.json({ error: 'ファイルが見つかりません' }, { status: 404 })
    if (!getStaffDocsBucket()) return storageUnavailable()
    const url = await signedReadUrl(f.path, f.name)
    return NextResponse.json({ url })
  }

  const docs = await readAll()
  docs.sort((a, b) => (a.workerId - b.workerId) || a.type.localeCompare(b.type) || (b.uploadedAt || '').localeCompare(a.uploadedAt || ''))
  return NextResponse.json({ docs, storageReady: !!getStaffDocsBucket() })
}

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>
  try { body = await request.json() } catch { return NextResponse.json({ error: 'invalid json' }, { status: 400 }) }
  const action = body.action

  if (action === 'delete') {
    const denied = await requireCap(request, 'staffDocs.delete')
    if (denied) return denied
  } else {
    const denied = await requireCap(request, 'staffDocs.edit')
    if (denied) return denied
  }

  const main = await getMainData()
  const workers = (main.workers || []) as { id: number; name: string }[]
  const workerName = (id: number) => workers.find(w => w.id === id)?.name || `#${id}`

  // ── アップロード準備（署名つきURLを出すだけ・記録はまだ作らない）──
  if (action === 'prepare') {
    const workerId = Number(body.workerId)
    if (!workers.some(w => w.id === workerId)) return NextResponse.json({ error: 'スタッフが見つかりません' }, { status: 400 })
    if (!isDocType(body.type)) return NextResponse.json({ error: '書類の種類が不正です' }, { status: 400 })
    const files = Array.isArray(body.files) ? body.files as { name?: string; contentType?: string; size?: number }[] : []
    if (files.length === 0) return NextResponse.json({ error: 'ファイルを選んでください' }, { status: 400 })
    if (files.length > STAFF_DOC_MAX_FILES) return NextResponse.json({ error: `ファイルは1件につき${STAFF_DOC_MAX_FILES}個までです` }, { status: 400 })
    for (const f of files) {
      if (!STAFF_DOC_ALLOWED_TYPES.includes(String(f.contentType))) {
        return NextResponse.json({ error: `この形式は入れられません: ${f.name}（PDF・JPEG・PNG・HEIC だけ）` }, { status: 400 })
      }
      if (!(Number(f.size) > 0) || Number(f.size) > STAFF_DOC_MAX_FILE_BYTES) {
        return NextResponse.json({ error: `ファイルが大きすぎます: ${f.name}（25MBまで）` }, { status: 400 })
      }
    }
    if (!getStaffDocsBucket()) return storageUnavailable()
    const docId = randomUUID()
    const uploads = await Promise.all(files.map(async (f, i) => {
      const name = safeFileName(String(f.name))
      const path = `staff-docs/${workerId}/${docId}/${i}-${name}`
      const url = await signedUploadUrl(path, String(f.contentType))
      return { path, name, contentType: String(f.contentType), size: Number(f.size), url }
    }))
    return NextResponse.json({ docId, uploads })
  }

  // ── 記録を作る（アップロード済みを確認してから）──
  if (action === 'commit') {
    const docId = String(body.docId || '')
    const workerId = Number(body.workerId)
    if (!/^[0-9a-f-]{36}$/.test(docId)) return NextResponse.json({ error: 'docId が不正です' }, { status: 400 })
    if (!workers.some(w => w.id === workerId)) return NextResponse.json({ error: 'スタッフが見つかりません' }, { status: 400 })
    if (!isDocType(body.type)) return NextResponse.json({ error: '書類の種類が不正です' }, { status: 400 })
    const validFrom = optDate(body.validFrom)
    const expiresOn = optDate(body.expiresOn)
    if (validFrom === 'invalid' || expiresOn === 'invalid') return NextResponse.json({ error: '日付の形式が不正です' }, { status: 400 })
    const prefix = `staff-docs/${workerId}/${docId}/`
    const reqFiles = Array.isArray(body.files) ? body.files as StaffDocFile[] : []
    if (reqFiles.length === 0 || reqFiles.some(f => typeof f.path !== 'string' || !f.path.startsWith(prefix))) {
      return NextResponse.json({ error: 'ファイルの指定が不正です' }, { status: 400 })
    }
    if (!getStaffDocsBucket()) return storageUnavailable()
    const files: StaffDocFile[] = []
    for (const f of reqFiles) {
      const m = await fileMeta(f.path)
      if (!m.exists) return NextResponse.json({ error: `アップロードが完了していません: ${f.name}` }, { status: 409 })
      files.push({ path: f.path, name: safeFileName(f.name), contentType: m.contentType || f.contentType, size: m.size })
    }
    const existing = await getDoc(doc(db, COL, docId))
    if (existing.exists()) return NextResponse.json({ error: 'この書類は既に登録されています' }, { status: 409 })

    const makeCurrent = body.makeCurrent !== false
    const now = new Date().toISOString()
    const by = await actorLabel(request)
    const record: Omit<StaffDoc, 'id'> = compact({
      workerId,
      type: body.type as StaffDocType,
      title: optText(body.title, 80),
      files,
      validFrom,
      expiresOn,
      note: optText(body.note, 500),
      status: makeCurrent ? 'current' : 'old',
      uploadedAt: now,
      uploadedBy: by,
    }) as Omit<StaffDoc, 'id'>
    if (makeCurrent) {
      const all = await readAll()
      for (const d of all.filter(d => d.workerId === workerId && d.type === record.type && d.status === 'current')) {
        await updateDoc(doc(db, COL, d.id), { status: 'old', updatedAt: now })
      }
    }
    await setDoc(doc(db, COL, docId), record)
    await logActivity(by, 'staffDocs.add', `${workerName(workerId)}：${STAFF_DOC_TYPES.find(t => t.key === record.type)?.label}（${files.length}ファイル）を登録`)
    return NextResponse.json({ ok: true, doc: { ...record, id: docId } })
  }

  const docId = String(body.docId || '')
  if (!docId) return NextResponse.json({ error: 'docId が必要です' }, { status: 400 })
  const ref = doc(db, COL, docId)
  const snap = await getDoc(ref)
  if (!snap.exists()) return NextResponse.json({ error: '書類が見つかりません' }, { status: 404 })
  const cur = { ...(snap.data() as StaffDoc), id: docId }
  const by = await actorLabel(request)
  const now = new Date().toISOString()

  if (action === 'update') {
    const patch: Record<string, unknown> = { updatedAt: now }
    if (body.type !== undefined) {
      if (!isDocType(body.type)) return NextResponse.json({ error: '書類の種類が不正です' }, { status: 400 })
      patch.type = body.type
    }
    for (const k of ['validFrom', 'expiresOn'] as const) {
      if (body[k] === undefined) continue
      const v = optDate(body[k])
      if (v === 'invalid') return NextResponse.json({ error: '日付の形式が不正です' }, { status: 400 })
      patch[k] = v ?? ''
    }
    if (body.title !== undefined) patch.title = optText(body.title, 80) ?? ''
    if (body.note !== undefined) patch.note = optText(body.note, 500) ?? ''
    await updateDoc(ref, patch)
    await logActivity(by, 'staffDocs.update', `${workerName(cur.workerId)}：書類の情報を変更`)
    return NextResponse.json({ ok: true })
  }

  if (action === 'setStatus') {
    const status = body.status === 'current' ? 'current' : 'old'
    if (status === 'current') {
      const all = await readAll()
      for (const d of all.filter(d => d.id !== docId && d.workerId === cur.workerId && d.type === cur.type && d.status === 'current')) {
        await updateDoc(doc(db, COL, d.id), { status: 'old', updatedAt: now })
      }
    }
    await updateDoc(ref, { status, updatedAt: now })
    await logActivity(by, 'staffDocs.status', `${workerName(cur.workerId)}：書類を${status === 'current' ? '最新' : '旧版'}に変更`)
    return NextResponse.json({ ok: true })
  }

  if (action === 'delete') {
    if (!getStaffDocsBucket()) return storageUnavailable()
    for (const f of cur.files || []) await deleteFile(f.path)
    await deleteDoc(ref)
    await logActivity(by, 'staffDocs.delete', `${workerName(cur.workerId)}：${STAFF_DOC_TYPES.find(t => t.key === cur.type)?.label}を削除`)
    return NextResponse.json({ ok: true })
  }

  return NextResponse.json({ error: 'unknown action' }, { status: 400 })
}
