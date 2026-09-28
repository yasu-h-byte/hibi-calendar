/**
 * 書類庫（スタッフの在留カード・雇用契約書などの保管）— 2026-09-28 第1段階。
 *
 * ## 仕組み
 * - ファイル本体は Firebase Storage（東京・本番モード＝外から直接は読めない/書けない）。
 *   ブラウザは、サーバが発行した「15分だけ有効な署名つきURL」で Storage に直接アップロード・閲覧する
 *   （Vercel の API は本文 4.5MB までなので、スキャンした PDF を API 経由で送ると落ちるため）。
 * - 書類の情報（種類・期限・新旧）は Firestore `staffDocs/{docId}`。
 * - 同じ人・同じ種類で新しい書類を「最新」として入れると、それまでの最新は「旧版」になる（消さない）。
 *
 * 閲覧・登録できるのは 代表・事業責任者・事務（lib/permissions.ts の staffDocs.*）。
 * 在留カードは機微な個人情報なので、職長・役員・スタッフ本人には見せない（代表決定 2026-09-28）。
 *
 * クライアント・サーバー両方から import する（サーバー専用の依存を入れないこと）。
 */

export type StaffDocType =
  | 'residence_card'
  | 'passport'
  | 'contract'
  | 'visa_permit'
  | 'certificate'
  | 'health'
  | 'other'

export interface StaffDocTypeDef {
  key: StaffDocType
  label: string
  /** 期限（有効期限・契約満了）を持つ書類か */
  hasExpiry: boolean
  /** 期限欄の呼び名 */
  expiryLabel?: string
  hint: string
}

export const STAFF_DOC_TYPES: StaffDocTypeDef[] = [
  { key: 'residence_card', label: '在留カード', hasExpiry: true, expiryLabel: '在留期限', hint: '表・裏をまとめて1件で入れる' },
  { key: 'contract', label: '雇用契約書・雇用条件書', hasExpiry: true, expiryLabel: '契約満了日', hint: '更新・賃金改定のたびに新しいものを入れる' },
  { key: 'passport', label: 'パスポート', hasExpiry: true, expiryLabel: '有効期限', hint: '顔写真のページ' },
  { key: 'visa_permit', label: '在留資格の許可・申請書類', hasExpiry: false, hint: '許可通知・申請の控えなど' },
  { key: 'certificate', label: '資格・合格証', hasExpiry: false, hint: '技能検定・特別教育の修了証など' },
  { key: 'health', label: '健康診断', hasExpiry: false, hint: '雇入れ時・定期健診の結果' },
  { key: 'other', label: 'その他', hasExpiry: false, hint: '上のどれにも当たらないもの' },
]

export function staffDocTypeDef(t: string): StaffDocTypeDef {
  return STAFF_DOC_TYPES.find(d => d.key === t) || STAFF_DOC_TYPES[STAFF_DOC_TYPES.length - 1]
}

/**
 * ファイル名から書類の種類を推し量る（2026-09-28）。
 * 登録フォームの種類が既定の「在留カード」のままで、フォンの雇用契約書が在留カードとして
 * 登録された。種類は空から選ばせ、ファイル名で見当がつくときは自動で選び、
 * 選んだ種類とファイル名が食い違えば警告する。見当がつかなければ null。
 */
export function inferDocType(fileName: string): StaffDocType | null {
  const n = (fileName || '').normalize('NFC').toLowerCase()
  if (/契約|条件書|contract|hop ?dong|hợp đồng/.test(n)) return 'contract'
  if (/在留カード|在留卡|residence|zairyu|the cu tru|thẻ cư trú/.test(n)) return 'residence_card'
  if (/パスポート|旅券|passport|ho chieu|hộ chiếu/.test(n)) return 'passport'
  if (/健康診断|健診|health/.test(n)) return 'health'
  if (/許可|申請|通知書|permit/.test(n)) return 'visa_permit'
  if (/合格|修了|技能検定|資格|certificate/.test(n)) return 'certificate'
  return null
}

/** ベトナム人スタッフ全員にそろっているべき書類（「不足」の表示に使う） */
export const REQUIRED_STAFF_DOC_TYPES: StaffDocType[] = ['residence_card', 'contract', 'passport']

export interface StaffDocFile {
  /** Storage 上のパス（staff-docs/{workerId}/{docId}/{index}-{name}） */
  path: string
  name: string
  contentType: string
  size: number
}

export interface StaffDoc {
  id: string
  workerId: number
  type: StaffDocType
  /** 任意の見出し（例: 2026年10月 賃金改定） */
  title?: string
  files: StaffDocFile[]
  /** 効力の開始日 'YYYY-MM-DD'（契約開始日・交付日など・任意） */
  validFrom?: string
  /** 期限 'YYYY-MM-DD'（在留期限・契約満了日・有効期限・任意） */
  expiresOn?: string
  note?: string
  /** current=その種類の最新 / old=旧版（消さずに残す） */
  status: 'current' | 'old'
  uploadedAt: string
  uploadedBy: string
  updatedAt?: string
}

// ── アップロードの制限 ──
export const STAFF_DOC_MAX_FILE_BYTES = 25 * 1024 * 1024
export const STAFF_DOC_MAX_FILES = 10
export const STAFF_DOC_ALLOWED_TYPES = [
  'application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
]

/**
 * Storage のパスに使えるファイル名にする（日本語は残し、パス区切りや制御文字だけ除く）。
 * Mac から入れると日本語の濁点が分解された形（NFD）で届くので、NFC にそろえる
 * （2026-09-28 ホアン君の在留カードで確認。そのままだと同じ名前でも一致しない）。
 */
export function safeFileName(name: string): string {
  const base = (name || 'file').normalize('NFC').split(/[\\/]/).pop() || 'file'
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f#?[\]*]/g, '').replace(/\s+/g, ' ').trim()
  return (cleaned || 'file').slice(0, 120)
}

export function isValidIsoDate(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
  const [y, m, d] = v.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

// ── 期限の状態 ──
export type ExpiryState = 'expired' | 'soon' | 'ok' | 'none'

/** 期限まで何日か（当日=0・過ぎたらマイナス）。期限なしは null */
export function daysUntil(expiresOn: string | undefined, todayIso: string): number | null {
  if (!expiresOn || !isValidIsoDate(expiresOn) || !isValidIsoDate(todayIso)) return null
  const a = Date.UTC(+todayIso.slice(0, 4), +todayIso.slice(5, 7) - 1, +todayIso.slice(8, 10))
  const b = Date.UTC(+expiresOn.slice(0, 4), +expiresOn.slice(5, 7) - 1, +expiresOn.slice(8, 10))
  return Math.round((b - a) / 86400000)
}

/** 期限切れ / 90日以内 / それ以外。在留期限の更新申請は満了の3か月前から出せるので90日で知らせる */
export const EXPIRY_WARN_DAYS = 90
export function expiryState(expiresOn: string | undefined, todayIso: string): ExpiryState {
  const n = daysUntil(expiresOn, todayIso)
  if (n === null) return 'none'
  if (n < 0) return 'expired'
  if (n <= EXPIRY_WARN_DAYS) return 'soon'
  return 'ok'
}

/**
 * 人員マスタとの食い違い（第1段階は在留期限だけ）。
 * 最新の在留カードに入れた在留期限と、人員マスタの在留期限（visaExpiry）が違えば知らせる。
 */
export function masterMismatches(
  worker: { visaExpiry?: string },
  docs: Pick<StaffDoc, 'type' | 'status' | 'expiresOn'>[],
): string[] {
  const out: string[] = []
  const card = docs.find(d => d.type === 'residence_card' && d.status === 'current')
  if (card?.expiresOn && worker.visaExpiry && card.expiresOn !== worker.visaExpiry) {
    out.push(`在留期限: 在留カード ${card.expiresOn} ／ 人員マスタ ${worker.visaExpiry}`)
  }
  if (card?.expiresOn && !worker.visaExpiry) {
    out.push(`在留期限: 在留カード ${card.expiresOn} ／ 人員マスタ 未登録`)
  }
  return out
}

/** 最新版がそろっていない必須書類 */
export function missingRequiredTypes(docs: Pick<StaffDoc, 'type' | 'status'>[]): StaffDocType[] {
  return REQUIRED_STAFF_DOC_TYPES.filter(t => !docs.some(d => d.type === t && d.status === 'current'))
}
