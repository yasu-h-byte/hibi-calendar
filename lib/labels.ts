/**
 * バッジ・ラベル表示の共通ヘルパー（2026-05-27 集約）
 *
 * 以前は visaBadge / orgBadge / jobBadge が attendance、cost、workers、
 * tool-budget の 4 ファイルに散在し、shape も挙動も微妙に違っていた:
 *   - 一方は "実習1号"、他方は "技能実習" を返す → ラベルドリフト
 *   - 一方は null 許容、他方は空文字 → 呼び出し側の null 判定が不揃い
 *
 * 本モジュールに集約。役職分類は lib/jobs.ts を参照（label 系のみここ）。
 */

// ─────────────────────────────────────────────────────────────
// ビザ
// ─────────────────────────────────────────────────────────────

/** ビザ別バッジ情報。日本人は null（バッジを出さない） */
export interface VisaBadge {
  label: string
  cls: string
}

/**
 * ビザコード → バッジ表示情報
 * 日本人（visa='none' or 空）は null を返す
 *
 * - jisshu1/2/3 → 実習1/2/3号（オレンジ）
 * - jisshu (旧) → 技能実習（オレンジ）
 * - tokutei1/2 → 特定1/2号（ピンク）
 * - tokutei (旧) → 特定技能（ピンク）
 */
export function visaBadge(visa: string | undefined | null): VisaBadge | null {
  if (!visa || visa === 'none') return null
  if (visa.startsWith('jisshu')) {
    const num = visa.replace('jisshu', '')
    return { label: num ? `実習${num}号` : '技能実習', cls: 'bg-orange-100 text-orange-700' }
  }
  if (visa.startsWith('tokutei')) {
    const num = visa.replace('tokutei', '')
    return { label: num ? `特定${num}号` : '特定技能', cls: 'bg-pink-100 text-pink-700' }
  }
  return null
}

/** ビザコード → ラベル文字列のみ（バッジ色不要な場合） */
export function visaLabel(visa: string | undefined | null): string {
  const b = visaBadge(visa)
  return b ? b.label : ''
}

// ─────────────────────────────────────────────────────────────
// 所属 (org × visa)
// ─────────────────────────────────────────────────────────────

/**
 * 所属バッジの CSS クラス
 *   外国人 → visa 色（実習: オレンジ、特定: ピンク）
 *   日本人 → org 色（hfu: 紫、hibi: 青）
 */
export function orgBadgeCls(org: string | undefined | null, visa: string | undefined | null): string {
  const v = visaBadge(visa)
  if (v) return v.cls
  return org === 'hfu' ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'
}

/**
 * 所属バッジのラベル
 *   外国人 → ビザ短縮表記（実習1号 / 特定2号 など）
 *   日本人 → 会社名（HFU / 日比）
 */
export function orgBadgeLabel(org: string | undefined | null, visa: string | undefined | null): string {
  const v = visaBadge(visa)
  if (v) return v.label
  return org === 'hfu' ? 'HFU' : '日比'
}

// ─────────────────────────────────────────────────────────────
// 職種
// ─────────────────────────────────────────────────────────────

export interface JobBadge {
  label: string
  cls: string
}

/**
 * 職種コード → ラベル + 色クラスのペア（人員マスタ等の表示用）
 * Japanese-input compatibility（旧データで `'とび'` 等の日本語コードが入っている場合）も対応
 */
export function jobBadge(jobType?: string | null): JobBadge {
  switch (jobType) {
    case 'yakuin': case '役員': return { label: '役員', cls: 'bg-red-100 text-red-700' }
    case 'shokucho': case '職長': return { label: '職長', cls: 'bg-blue-100 text-blue-700' }
    case 'tobi': case 'とび': return { label: 'とび', cls: 'bg-green-100 text-green-700' }
    case 'tobi_apprentice': return { label: '鳶見習い', cls: 'bg-lime-100 text-lime-700' }
    case 'doko': case '土工': return { label: '土工', cls: 'bg-gray-200 text-gray-600' }
    case 'jimu': case '事務': return { label: '事務', cls: 'bg-purple-100 text-purple-700' }
    default: return { label: jobType || '—', cls: 'bg-gray-100 text-gray-500' }
  }
}

// ─────────────────────────────────────────────────────────────
// スタッフ画面の日越並記（2026-10-02 総合点検）
// ─────────────────────────────────────────────────────────────
//
// スタッフ（ベトナム人）のスマホ画面は日本語とベトナム語を必ず並記する（docs/ui-design.md「言語表示ルール」）。
// 旧: 文言が画面ごとの直書きで、あとから足した所（過去の日の修正・最近5日の状態・月の確認カード・
//     カレンダー署名の凡例・通信失敗の 'Error' など）が日本語だけ・英語だけになっていた。
// 新: 並記の文言はここに集め、画面はここから読む（app/attendance/[token]・components/attendance の
//     MonthConfirmCard / RestReportModal / LeaveRequestModal / HomeLongLeaveModal / CalendarApprovalModal）。
//     新しい文言を足すときもここに足す。色（クラス名）はここに置かない。

/** 日本語とベトナム語の組 */
export interface BiText {
  ja: string
  vi: string
}

/** 「日本語 / Tiếng Việt」の1行にする */
export function biLine(t: BiText): string {
  return `${t.ja} / ${t.vi}`
}

/** 出面の状態（最近5日・今日の登録済み表示） */
export const STAFF_STATUS_BI: Record<import('@/types').AttendanceStatus, BiText> = {
  work: { ja: '出勤', vi: 'Đi làm' },
  overtime: { ja: '出勤', vi: 'Đi làm' },
  rest: { ja: '休み', vi: 'Nghỉ' },
  leave: { ja: '有給', vi: 'Nghỉ phép' },
  site_off: { ja: '現場休み', vi: 'Công trường nghỉ' },
  home_leave: { ja: '帰国中', vi: 'Đang về nước' },
  exam: { ja: '試験', vi: 'Thi' },
  comp: { ja: '会社都合の休み', vi: 'Nghỉ do công ty' },
  none: { ja: '未入力', vi: 'Chưa nhập' },
}

/** スタッフ画面で使う並記の文言 */
export const STAFF_TEXT = {
  // 通信・読み込み
  connError: { ja: 'つうしん エラー', vi: 'Lỗi kết nối' },
  error: { ja: 'エラー', vi: 'Lỗi' },
  retry: { ja: 'もう一度', vi: 'Thử lại' },
  loadFailed: { ja: '読み込めませんでした', vi: 'Không tải được' },
  // 今日の登録
  today: { ja: '今日', vi: 'Hôm nay' },
  registered: { ja: '登録済み', vi: 'Đã đăng ký' },
  notRegistered: { ja: '今日はまだ登録していません', vi: 'Hôm nay chưa đăng ký' },
  saved: { ja: '保存しました', vi: 'Đã lưu' },
  registerWork: { ja: '出勤登録', vi: 'Xác nhận đi làm' },
  nonScheduled: { ja: 'うち所定外', vi: 'Trong đó ngoài giờ' },
  breakShorten: { ja: '休憩短縮', vi: 'Rút ngắn nghỉ' },
  // 過去の日の修正
  edit: { ja: '修正', vi: 'Sửa' },
  start: { ja: '始業', vi: 'Bắt đầu' },
  end: { ja: '終業', vi: 'Kết thúc' },
  breakTime: { ja: '休憩', vi: 'Nghỉ giải lao' },
  breakAm: { ja: '午前休憩', vi: 'Nghỉ sáng' },
  breakPm: { ja: '午後休憩', vi: 'Nghỉ chiều' },
  breakNotTaken: { ja: '未取得', vi: 'Không nghỉ' },
  // 有給・帰国の申請
  chooseDate: { ja: '日付を選択してください', vi: 'Hãy chọn ngày' },
  expiry: { ja: '期限', vi: 'Hạn' },
  rejectedReason: { ja: '却下の理由', vi: 'Lý do từ chối' },
  revoked: { ja: '会社が取り消し', vi: 'Công ty đã hủy' },
  rejected: { ja: '却下', vi: 'Từ chối' },
  leaveReasonExample: { ja: '通院、予定など', vi: 'Đi khám, việc riêng...' },
  flightExample: { ja: '飛行機の予定など', vi: 'Lịch bay...' },
  // 月の出面の確認
  pleaseConfirm: { ja: '確認してください', vi: 'Hãy xác nhận' },
  confirmedAt: { ja: '確認しました', vi: 'Đã xác nhận' },
  reportedAt: { ja: '連絡しました', vi: 'Đã báo' },
  // カレンダーの署名
  signed: { ja: '署名済み', vi: 'Đã ký' },
  work: { ja: '出勤', vi: 'Đi làm' },
  off: { ja: '休み', vi: 'Nghỉ' },
  close: { ja: '閉じる', vi: 'Đóng' },
  sending: { ja: '送信中...', vi: 'Đang gửi...' },
} as const

/** 曜日（日曜はじまり）のベトナム語 */
export const STAFF_DOW_VI = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'] as const

/** 帰国申請の理由（保存している値は日本語）→ ベトナム語 */
export const STAFF_HOME_LEAVE_REASON_VI: Record<string, string> = {
  '一時帰国': 'Về nước tạm thời',
  'ビザ更新帰国': 'Về nước gia hạn visa',
  'その他': 'Khác',
}

/** 「＋20分 休憩短縮」の印（最近5日・承認済みの今日・実労働時間カード） */
export function staffBreakShortenTag(min: number): BiText {
  return { ja: `＋${min}分 ${STAFF_TEXT.breakShorten.ja}`, vi: `+${min} phút ${STAFF_TEXT.breakShorten.vi.toLowerCase()}` }
}
