import { NextRequest, NextResponse } from 'next/server'
import { checkApiAuth, getApiAuthUser, requireCap, callerCan } from '@/lib/auth'
import {
  WORKER_OFFICE_KEYS, WORKER_PUBLIC_KEYS, WORKER_OWNER_ONLY_KEYS, WORKER_WRITABLE_BASE_KEYS, WORKER_WRITABLE_PAY_KEYS,
  WORKER_CLEARABLE_KEYS, getWorkers, isOfficeSideWorker,
} from '@/lib/workers'
import {
  addWorker,
  updateWorker,
  deleteWorker,
  generateWorkerToken,
  revokeWorkerToken,
} from '@/lib/worker-crud'
import { logActivity } from '@/lib/activity'
import { db } from '@/lib/firebase'
import { doc, setDoc, getDocs, collection } from '@/lib/fsdb'

// 2026-06-12 (監査 Sprint2-C): 給与に直結するフィールドの変更を永続監査ログに残す。
//   activityLog は500件で古い順に自動削除されるため、単価変更の証跡が数週間で消えていた。
//   auditTrail コレクションは削除処理を持たない（労基法115条の3年証跡）。
//   birthDate は賃金そのものではないが、号俸制の年齢調整（−4〜+3ピッチ）を左右し、
//   誤入力すると昇給額が静かに変わる。前後の値を追えるようここに含める。
// 2026-10-02 総合点検: 給与の項目は lib/workers.ts の WORKER_OWNER_ONLY_KEYS（WORKER_PAY_KEYS ＋ 旧ルール）から作る。
//   旧はここに手書きの一覧が2つ（PAY_FIELDS / OWNER_ONLY_PAY_FIELDS）あり、rateFrom・prevRate・salaryFrom・prevSalary が
//   どちらにも無かった（事務が書き換えられ、監査ログにも残らなかった）。
// ⚠️ workerId の存在チェックに `!id` を使わないこと。**日比靖仁さんの workerId は 0** で、
//    falsy のため「id required」で弾かれる（2026-08-26 に発生）。undefined/null/'' で判定する。
const PAY_FIELDS: readonly string[] = [...WORKER_OWNER_ONLY_KEYS, 'retired', 'birthDate']

/**
 * 直接の書き換えを代表だけに限る給与欄（lib/permissions.ts workers.editPay・2026-09-26 代表決定）＝ WORKER_OWNER_ONLY_KEYS。
 * 事業責任者は評価の承認・号俸の改定を通して決める（それぞれのAPIがサーバー側で書き込む）。
 * 事務は基本情報（名前・在留・退職日・電話URL等）を編集できるが、ここに入る欄は変えられない。
 */
const OWNER_ONLY_PAY_FIELDS: readonly string[] = WORKER_OWNER_ONLY_KEYS

/** 空・未設定・数値文字列をそろえて比べる（同じ値を送り返すだけなら「変更」にしない） */
const normValue = (v: unknown) => (v === undefined || v === null || v === '' ? null : typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v)) ? Number(v) : v)

/** 給与欄に「値が変わる」書き込みが含まれるか（同じ値を送り返すだけなら含まない） */
function changesPayFields(updates: Record<string, unknown>, before: Record<string, unknown> | undefined): string[] {
  return OWNER_ONLY_PAY_FIELDS.filter(f => {
    if (!(f in updates)) return false
    return JSON.stringify(normValue(updates[f])) !== JSON.stringify(normValue(before?.[f]))
  })
}

const WRITABLE_KEYS = new Set<string>([...WORKER_WRITABLE_BASE_KEYS, ...WORKER_WRITABLE_PAY_KEYS])

/**
 * add / update の body を「書いてよい項目」だけに絞る（許可リスト・2026-10-02 総合点検）。
 * 知らないキー（token・scheduledChanges・prevXxx 以外の勝手な項目など）が混ざっていたら名前を返す（400 にする）。
 */
function pickWritable(body: Record<string, unknown>): { updates: Record<string, unknown>; unknown: string[] } {
  const updates: Record<string, unknown> = {}
  const unknown: string[] = []
  for (const [k, v] of Object.entries(body)) {
    if (k === 'action' || k === 'id') continue
    if (!WRITABLE_KEYS.has(k)) { unknown.push(k); continue }
    updates[k] = v
  }
  return { updates, unknown }
}

/**
 * 空文字・null で送られた項目を「消す」に分ける（2026-10-02 総合点検。lib/workers.ts WORKER_CLEARABLE_KEYS）。
 * 旧: 画面は `retired: form.retired || undefined` と送り、キーごと落ちて変更なしになっていた＝誤った退職日を画面から消せなかった。
 * 消せない項目（名前・所属・職種・入社日など）に空が来たら、その項目は「変更なし」として外す。
 */
function splitClears(updates: Record<string, unknown>): { updates: Record<string, unknown>; unsetFields: string[] } {
  const next: Record<string, unknown> = {}
  const unsetFields: string[] = []
  for (const [k, v] of Object.entries(updates)) {
    if (v === '' || v === null) {
      if (WORKER_CLEARABLE_KEYS.includes(k)) unsetFields.push(k)
      continue
    }
    next[k] = v
  }
  return { updates: next, unsetFields }
}

export async function GET(request: NextRequest) {
  // auth: any-login — 中身は役割で絞る（給与欄は workers.view、トークンは workers.edit のみ）
  if (!await checkApiAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const workers = await getWorkers()
    // 2026-09-26: 給与欄は workers.view（事務所の人）だけ、電話URLのトークンは workers.edit（事務・代表）だけに返す。
    //   旧: 職長の画面（評価入力）からも全員の時給・月給・電話URLが取れた
    // 2026-10-02: 給与欄は pay.view（役割＝事務・事業責任者・代表 かつ 本人＝靖仁・政仁・森田）だけ
    const canSeePay = await callerCan(request, 'pay.view')
    const canSeeOffice = await callerCan(request, 'workers.view')
    const canSeeToken = await callerCan(request, 'workers.edit')
    // 2026-10-02 総合点検: 代表(0)・政仁さん(1)・役員・事務の合言葉は最終承認などの鍵を兼ねるので代表だけに返す
    //   （画面には tokenHidden: true で「代表のみ」と出す）。旧: 事務が政仁さんの合言葉を読んで最終承認まで一人でできた
    const canSeeOfficeToken = await callerCan(request, 'system.admin')
    // 2026-10-02: 相手ごとに返す項目を許可リストで決める（lib/workers.ts）。
    //   給与を見られる人 = 全部 ／ 事務・役員 = 給与以外の人員マスタ ／ 職長 = 名前・所属・職種など最小限。
    //   旧（#56）: 給与を見られない人を職長と同じ最小限にしていたため、奥寺さん・佐藤さんの人員マスタで
    //   スマホURLが「まだ」になり（発行し直すと今のリンクが切れる）、保存で家族・禁煙の欄が消えた
    const keys: readonly string[] | null = canSeePay ? null : canSeeOffice ? WORKER_OFFICE_KEYS : WORKER_PUBLIC_KEYS
    const shaped = workers.map(w => {
      const src = w as unknown as Record<string, unknown>
      const o: Record<string, unknown> = keys ? Object.fromEntries(keys.filter(k => k in src).map(k => [k, src[k]])) : { ...src }
      if (!canSeeToken) delete o.token
      else if (!canSeeOfficeToken && isOfficeSideWorker(w)) { delete o.token; if (w.token) o.tokenHidden = true }
      return o
    })
    return NextResponse.json({ workers: shaped })
  } catch (error) {
    console.error('Failed to fetch workers:', error)
    return NextResponse.json({ error: 'Failed to fetch workers' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  // 2026-09-26: 人員マスタの編集は権限表の workers.edit（事務・代表）。給与欄は下で workers.editPay（代表）
  const denied = await requireCap(request, 'workers.edit')
  if (denied) return denied

  try {
    const body = await request.json()
    const { action } = body

    if (action === 'add') {
      const { name, org, visa, job, rate, hourlyRate, otMul, hireDate, birthDate, jpGrade, jpStep, salary, visaExpiry, dispatchTo, dispatchFrom, useOldRules, canDrive, breakShortenMin, breakShortenFrom, nonSmoker, children, payrollNo } = body
      if (!name) {
        return NextResponse.json({ error: '名前を入力してください' }, { status: 400 })
      }
      // 2026-10-02 総合点検: 書いてよい項目だけ（lib/workers.ts の許可リスト）。知らない項目が混ざっていたら断る
      {
        const { unknown } = pickWritable(body as Record<string, unknown>)
        if (unknown.length > 0) {
          return NextResponse.json({ error: `人員マスタに無い項目です: ${unknown.join('・')}` }, { status: 400 })
        }
      }
      // 2026-10-02 総合点検: 新規追加でも給与欄（日額・時給・月給・号俸・旧ルール）を入れられるのは代表だけ。
      //   旧: update は workers.editPay を見ていたのに add は見ておらず、事務が給与つきで登録できた。
      //   残業倍率の既定値 1.25・日額 0 は「入れていない」とみなす
      {
        const payGiven = WORKER_WRITABLE_PAY_KEYS.filter(k => {
          const v = normValue((body as Record<string, unknown>)[k])
          if (v === null || v === 0 || v === false) return false
          if (k === 'otMul' && Number(v) === 1.25) return false
          return true
        })
        if (payGiven.length > 0) {
          const payDenied = await requireCap(request, 'workers.editPay')
          if (payDenied) {
            return NextResponse.json({ error: `給与欄（${payGiven.join('・')}）を入れられるのは代表だけです。給与欄を空にして登録し、代表に伝えてください` }, { status: 403 })
          }
        }
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
      // キャシュモ管理の従業員番号（文字列・任意）
      if (payrollNo !== undefined && String(payrollNo).trim()) {
        (workerData as Record<string, unknown>).payrollNo = String(payrollNo).trim()
      }
      // 生年月日は労働者名簿の必須記載事項（労基法107条）。号俸制の年齢調整にも使う
      if (birthDate) {
        (workerData as Record<string, unknown>).birthDate = String(birthDate)
      }
      if (typeof canDrive === 'boolean') {
        (workerData as Record<string, unknown>).canDrive = canDrive
      }
      // 賞与の手当（禁煙手当・子ども手当）。docs/wage-system.md
      if (typeof nonSmoker === 'boolean') {
        (workerData as Record<string, unknown>).nonSmoker = nonSmoker
      }
      if (Array.isArray(children)) {
        (workerData as Record<string, unknown>).children =
          (children as unknown[]).map(String).filter(c => /^\d{4}-\d{2}$/.test(c))
      }
      if (Number(breakShortenMin) > 0 && breakShortenFrom) {
        (workerData as Record<string, unknown>).breakShortenMin = Number(breakShortenMin)
        ;(workerData as Record<string, unknown>).breakShortenFrom = String(breakShortenFrom)
      }
      // 号俸制（日本人社員）。未設定だと年次改定が確定できない
      if (jpGrade) {
        (workerData as Record<string, unknown>).jpGrade = String(jpGrade)
        if (jpStep) (workerData as Record<string, unknown>).jpStep = Number(jpStep)
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
      const { id } = body
      if (id === undefined || id === null || id === '') return NextResponse.json({ error: 'id required' }, { status: 400 })
      // 2026-10-02 総合点検: 書いてよい項目だけ（許可リスト）。旧: body のキーを何でもマージしていた（token・prevRate も通った）
      const picked = pickWritable(body as Record<string, unknown>)
      if (picked.unknown.length > 0) {
        return NextResponse.json({ error: `人員マスタに無い項目です: ${picked.unknown.join('・')}` }, { status: 400 })
      }
      // 空文字・null は「その項目を消す」（退職日・在留期限・メモなど。lib/workers.ts WORKER_CLEARABLE_KEYS）
      const split = splitClears(picked.updates)
      const updates: Record<string, unknown> = split.updates
      const unsetFields: string[] = split.unsetFields
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
      if (updates.payrollNo !== undefined) {
        updates.payrollNo = String(updates.payrollNo || '').trim()
      }
      if (updates.dispatchFrom !== undefined) {
        updates.dispatchFrom = String(updates.dispatchFrom || '').trim()
      }
      // 賞与の手当（2026-08-31 追加）。子は誕生年月 'YYYY-MM' のみ受け付ける
      if (updates.nonSmoker !== undefined) {
        updates.nonSmoker = updates.nonSmoker === true
      }
      if (updates.children !== undefined) {
        updates.children = Array.isArray(updates.children)
          ? (updates.children as unknown[]).map(String).filter(c => /^\d{4}-\d{2}$/.test(c))
          : []
      }
      // useOldRules: true なら保存、false（空・null も）ならフィールドを削除。送られていなければ変更なし
      // 2026-06-13 (監査 Sprint3): deleteField() は配列要素内では機能しないため、
      //   unsetFields で updateWorker に「マージ後に delete するキー」を渡す方式に変更
      if ('useOldRules' in picked.updates) {
        if (picked.updates.useOldRules === true) updates.useOldRules = true
        else { delete updates.useOldRules; if (!unsetFields.includes('useOldRules')) unsetFields.push('useOldRules') }
      }

      // 2026-06-12 (監査 Sprint2-C): 給与系フィールドの old→new を永続記録（更新前に現値を取得）
      const beforeWorkers = await getWorkers()
      const beforeW = beforeWorkers.find(w => w.id === Number(id)) as Record<string, unknown> | undefined
      if (!beforeW) return NextResponse.json({ error: 'Worker not found' }, { status: 404 })

      // 給与欄の直接の書き換えは代表だけ（画面は全項目を送り返すので「値が変わるとき」だけ判定）。消す（空で送る）も変更
      const effective: Record<string, unknown> = { ...updates, ...Object.fromEntries(unsetFields.map(k => [k, null])) }
      const payChanged = changesPayFields(effective, beforeW)
      if (payChanged.length > 0) {
        const payDenied = await requireCap(request, 'workers.editPay')
        if (payDenied) {
          return NextResponse.json({ error: `給与欄（${payChanged.join('・')}）の変更は代表のみです。評価の承認・号俸の改定から行ってください` }, { status: 403 })
        }
      }

      await updateWorker(Number(id), updates as Parameters<typeof updateWorker>[1], unsetFields)

      // 給与系フィールドの差分を auditTrail へ（削除されない永続コレクション）。消した項目も「→ —」で残す
      const changes: Record<string, { from: unknown; to: unknown }> = {}
      for (const f of PAY_FIELDS) {
        if (!(f in effective)) continue
        const oldV = f === 'useOldRules' ? !!beforeW?.useOldRules : (beforeW?.[f] ?? null)
        const newV = f === 'useOldRules' ? effective[f] === true : (effective[f] ?? null)
        if (JSON.stringify(normValue(oldV)) !== JSON.stringify(normValue(newV))) changes[f] = { from: oldV, to: newV }
      }
      if (Object.keys(changes).length > 0) {
        const auth = await getApiAuthUser(request)
        const actor = auth.authorized ? String(auth.actor) : 'unknown'
        const at = new Date().toISOString()
        const detail = Object.entries(changes).map(([k, v]) => `${k}: ${v.from ?? '—'} → ${v.to ?? '—'}`).join(', ')
        try {
          await setDoc(doc(db, 'auditTrail', `worker-${id}-${Date.now()}`), {
            type: 'worker.payChange',
            workerId: Number(id),
            workerName: beforeW?.name || '',
            changes,
            actor,
            at,
          })
        } catch (e) {
          // rules 未デプロイ等で監査ログ書込に失敗しても、更新自体は成立させる
          // （activityLog 側には必ず残す）
          console.error('[workers] auditTrail 書込失敗:', e)
        }
        await logActivity('admin', 'worker.payChange', `${beforeW?.name || `ID:${id}`} 給与系変更: ${detail}（操作者: ${actor}）`)
      } else {
        await logActivity('admin', 'worker.update', `ID:${id} を更新`)
      }
      return NextResponse.json({ success: true })
    }

    if (action === 'delete') {
      const { id } = body
      if (id === undefined || id === null || id === '') return NextResponse.json({ error: 'id required' }, { status: 400 })

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

    if (action === 'generateToken' || action === 'revokeToken') {
      const { id } = body
      if (id === undefined || id === null || id === '') return NextResponse.json({ error: 'id required' }, { status: 400 })
      // 2026-10-02 総合点検: 代表(0)・政仁さん(1)・役員・事務の合言葉は最終承認などの鍵を兼ねる（lib/foreman-todo.ts managerByToken）。
      //   発行・失効は代表だけ。旧: 人員マスタを編集できる事務が政仁さんの合言葉を発行し直して読めた
      const target = (await getWorkers()).find(w => w.id === Number(id))
      if (!target) return NextResponse.json({ error: 'Worker not found' }, { status: 404 })
      if (isOfficeSideWorker(target)) {
        const denied = await requireCap(request, 'system.admin')
        if (denied) return NextResponse.json({ error: '代表・事業責任者・役員・事務のスマホURLは代表だけが発行・失効できます' }, { status: 403 })
      }
      if (action === 'revokeToken') {
        await revokeWorkerToken(id)
        await logActivity('admin', 'worker.revokeToken', `${target.name} のスマホURLを失効`)
        return NextResponse.json({ success: true })
      }
      const token = await generateWorkerToken(id)
      await logActivity('admin', 'worker.generateToken', `${target.name} のスマホURLを発行`)
      return NextResponse.json({ success: true, token })
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  } catch (error) {
    console.error('Workers POST error:', error)
    return NextResponse.json({ error: String(error) }, { status: 500 })
  }
}
