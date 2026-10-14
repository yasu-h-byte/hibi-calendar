/**
 * 休みの予定（2026-10-14 代表「帰国情報や有給申請だけの情報用ページを作って職長たちも見られるように」）。
 *
 * 帰国・有給・欠勤届を1か所に並べる「見るだけ」のページ（/time-off）。職長も見る。
 * - 載せるのは「名前・現場・日付・種類・段階」だけ。申請の理由・メモ・残日数・お金は載せない
 *   （API は許可リストの形 TimeOffItem だけを返す）
 * - 段階: 承認済み（出面に入った有給・最終承認の帰国）／承認待ち（申請中・職長承認まで）／届出（欠勤届）
 * - 同じ人・同じ種類・同じ段階で日が続くものは1行（〜）にまとめる
 *
 * クライアント・サーバー両方から import する（サーバー専用の依存を入れないこと）。
 */

export type TimeOffKind = 'home' | 'leave' | 'absence'
export const TIME_OFF_KIND_LABEL: Record<TimeOffKind, string> = {
  home: '帰国',
  leave: '有給',
  absence: '欠勤届',
}

export type TimeOffStage = 'approved' | 'pending' | 'reported'
export const TIME_OFF_STAGE_LABEL: Record<TimeOffStage, string> = {
  approved: '承認済み',
  pending: '承認待ち',
  reported: '届出',
}

/** 有給・欠勤届を何日先まで出すか（帰国は時期に限らず、まだ終わっていないものすべて・2026-10-14 代表） */
export const TIME_OFF_DAYS_AHEAD = 60

/** API が返す1件（許可リスト。ここに無い項目は返さない） */
export interface TimeOffItem {
  kind: TimeOffKind
  stage: TimeOffStage
  workerId: number
  workerName: string
  /** その月の配置現場（id）。職長の「自分の現場」の絞り込みに使う */
  siteIds: string[]
  start: string  // YYYY-MM-DD
  end: string    // YYYY-MM-DD（同じ日なら start と同じ）
  /** 帰国の復帰日が決まっていない */
  returnUndecided?: boolean
}

export interface TimeOffDay {
  kind: TimeOffKind
  stage: TimeOffStage
  workerId: number
  date: string
}

const nextDay = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d + 1))
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`  // utc-ok: 日付の足し算だけ
}

/** 1日ずつの休みを、同じ人・同じ種類・同じ段階で続く日ごとにまとめる */
export function mergeTimeOffDays(days: TimeOffDay[]): { kind: TimeOffKind; stage: TimeOffStage; workerId: number; start: string; end: string }[] {
  const sorted = [...days].sort((a, b) =>
    a.workerId - b.workerId || a.kind.localeCompare(b.kind) || a.stage.localeCompare(b.stage) || a.date.localeCompare(b.date))
  const out: { kind: TimeOffKind; stage: TimeOffStage; workerId: number; start: string; end: string }[] = []
  for (const d of sorted) {
    const last = out[out.length - 1]
    if (last && last.workerId === d.workerId && last.kind === d.kind && last.stage === d.stage
      && (d.date === last.end || d.date === nextDay(last.end))) {
      last.end = d.date
      continue
    }
    out.push({ kind: d.kind, stage: d.stage, workerId: d.workerId, start: d.date, end: d.date })
  }
  return out
}

/** その日にかかっているか */
export const coversDate = (t: Pick<TimeOffItem, 'start' | 'end'>, iso: string) => t.start <= iso && iso <= t.end

/** 並び: 始まる日 → 種類（帰国・有給・欠勤届）→ 名前 */
export function sortTimeOff<T extends Pick<TimeOffItem, 'start' | 'kind' | 'workerName'>>(list: T[]): T[] {
  const order: Record<TimeOffKind, number> = { home: 0, leave: 1, absence: 2 }
  return [...list].sort((a, b) => a.start.localeCompare(b.start) || order[a.kind] - order[b.kind] || a.workerName.localeCompare(b.workerName, 'ja'))
}
