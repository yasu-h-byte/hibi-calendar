import { DeduraMark } from './Brand'

/**
 * スタッフ・職長スマホ画面の上の帯（2026-09-30 第2次デザイン刷新「案1 UDホワイト」）。
 *
 * 旧（2026-07 案C）はチャコールの濃色ベタに白抜き文字だった。案1 では白地に濃い文字＋紺の頭文字にして、
 * 管理画面と同じ見た目にそろえる。白地×ほぼ黒の文字はコントラストが最も高く、直射日光の下でも読める。
 * 主役ボタン（出勤登録）のアンバーはそのまま残す。
 *
 * スタッフ（/attendance/[token]）・職長（/attendance/foreman/[token]）・マイページ（/mypage/[token]）で共通。
 */
export default function StaffHeader({ label, name, sub, note }: {
  /** 名前の上の小さな見出し（例: 職長・マイページ）。無ければ出さない */
  label?: string
  name: string
  /** 名前の下の行（ベトナム語名・現場名など） */
  sub?: string | null
  /** さらに下の薄い行（今日の日付など） */
  note?: string | null
}) {
  return (
    <div className="bg-white border-b border-hibi-line px-4 py-3.5">
      <div className="max-w-lg mx-auto flex items-center gap-3">
        <div className="w-11 h-11 rounded-full bg-hibi-navy text-white text-base font-bold flex items-center justify-center shrink-0" aria-hidden="true">
          {name.slice(0, 1)}
        </div>
        <div className="flex-1 min-w-0">
          {label && <div className="text-xs text-hibi-sub">{label}</div>}
          <div className="text-lg sm:text-xl font-bold text-gray-900 truncate">{name}</div>
          {sub && <div className="text-sm text-hibi-sub truncate">{sub}</div>}
          {note && <div className="text-xs text-hibi-sub mt-0.5">{note}</div>}
        </div>
        <DeduraMark size={22} />
      </div>
    </div>
  )
}
