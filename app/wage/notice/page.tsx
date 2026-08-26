'use client'

/**
 * 賃金改定通知書 A4印刷ページ
 *
 * 確定した年次改定（jpWageRevisions/{基準日}）をもとに、本人へ渡す通知書を出力する。
 * - URL: /wage/notice?effective=2026-10-01
 * - `(app)` グループ外に置いてサイドバーを出さない（既存の評価表 印刷と同じ作法）
 * - 1名につきA4縦1枚。ブラウザの印刷からPDF保存もできる
 *
 * 金額は**確定時に凍結した値**（frozen）を使う。あとから号俸表やロジックを変えても、
 * 本人に渡した通知書の数字が動かないようにするため。
 */

import { Suspense, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'

const yen = (v: number | null | undefined) => v == null ? '—' : '¥' + Math.round(v).toLocaleString()

interface Frozen {
  workerId: number
  name: string
  status: string
  grade: string
  oldStep: number | null
  newStep: number | null
  oldDaily: number | null
  newDaily: number | null
  raisePerDay: number
  adjustment: number | null
}

interface Payload {
  effective: string
  status: 'draft' | 'applied'
  appliedAt: string | null
  frozen: Frozen[] | null
}

/** 'YYYY-MM-DD' → '2026年10月1日' */
function jpDate(iso: string): string {
  const [y, m, d] = iso.split('-')
  return `${y}年${Number(m)}月${Number(d)}日`
}

function NoticeBody() {
  const params = useSearchParams()
  const [data, setData] = useState<Payload | null>(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    try {
      const raw = localStorage.getItem('hibi_auth')
      const pw = raw ? JSON.parse(raw)?.password : ''
      if (!pw) { setErr('ログインが必要です'); return }
      const eff = params.get('effective')
      fetch(`/api/jp-wage/revision${eff ? `?effective=${eff}` : ''}`, { headers: { 'x-admin-password': pw } })
        .then(async r => { if (!r.ok) throw new Error(`取得に失敗しました（${r.status}）`); return r.json() })
        .then((j: Payload) => setData(j))
        .catch(e => setErr(e instanceof Error ? e.message : '不明なエラー'))
    } catch { setErr('ログイン情報を読めませんでした') }
  }, [params])

  if (err) return <div style={{ padding: 24, color: '#b91c1c' }}>エラー: {err}</div>
  if (!data) return <div style={{ padding: 24, color: '#666' }}>読み込み中…</div>

  if (data.status !== 'applied' || !data.frozen) {
    return (
      <div style={{ padding: 24, maxWidth: 640 }}>
        <h1 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>まだ確定していません</h1>
        <p style={{ fontSize: 14, color: '#555', lineHeight: 1.9 }}>
          通知書は確定した改定の内容から作ります。<br />
          賃金制度 → 年次改定 で内容を確定してから、もう一度開いてください。
        </p>
      </div>
    )
  }

  // 昇給した人だけ。据え置き・対象外の人に通知書は出さない
  const targets = data.frozen.filter(f => f.raisePerDay > 0)

  return (
    <>
      <style jsx global>{`
        @page { size: A4 portrait; margin: 20mm 18mm; }
        @media print {
          html, body { background: white !important; }
          .no-print { display: none !important; }
          .sheet { box-shadow: none !important; margin: 0 !important; page-break-after: always; }
          .sheet:last-child { page-break-after: auto; }
        }
        body { background: #f5f5f5; margin: 0; font-family: "Noto Sans JP", "Hiragino Sans", "Yu Gothic", sans-serif; }
        .sheet {
          width: 174mm; min-height: 257mm; background: white; margin: 12px auto;
          padding: 0; box-shadow: 0 1px 6px rgba(0,0,0,.15); color: #111;
        }
      `}</style>

      <div className="no-print" style={{ padding: '12px 16px', background: '#1B2A4A', color: 'white', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <b style={{ fontSize: 14 }}>賃金改定通知書</b>
        <span style={{ fontSize: 12, opacity: .85 }}>{jpDate(data.effective)} 適用 ／ {targets.length}名</span>
        <button onClick={() => window.print()} style={{ padding: '6px 14px', background: 'white', color: '#1B2A4A', borderRadius: 4, fontSize: 13, border: 'none', cursor: 'pointer', fontWeight: 700 }}>🖨 印刷 / PDF保存</button>
        <span style={{ fontSize: 11, opacity: .7 }}>1名につきA4縦1枚で出力されます</span>
      </div>

      {targets.length === 0 && (
        <div style={{ padding: 24, color: '#555' }}>昇給の対象者がいません。</div>
      )}

      {targets.map(f => (
        <div key={f.workerId} className="sheet">
          <div style={{ padding: '22mm 16mm 16mm' }}>
            <div style={{ textAlign: 'right', fontSize: 12, color: '#444' }}>{jpDate(data.effective)}</div>

            <div style={{ fontSize: 15, marginTop: 18 }}>
              <b style={{ fontSize: 17 }}>{f.name}</b> 殿
            </div>

            <h1 style={{ textAlign: 'center', fontSize: 20, fontWeight: 700, letterSpacing: '.08em', margin: '26px 0 8px' }}>
              賃金改定通知書
            </h1>
            <div style={{ borderBottom: '1px solid #333', width: 120, margin: '0 auto 26px' }} />

            <p style={{ fontSize: 13.5, lineHeight: 2.1, margin: '0 0 20px' }}>
              日頃の勤務に感謝申し上げます。<br />
              このたび、あなたの賃金を下記のとおり改定いたしましたので通知します。
            </p>

            <div style={{ textAlign: 'center', fontSize: 13, letterSpacing: '.3em', margin: '18px 0 12px' }}>記</div>

            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13.5 }}>
              <tbody>
                <tr>
                  <th style={cellTh}>適用開始日</th>
                  <td style={cellTd}>{jpDate(data.effective)}</td>
                </tr>
                <tr>
                  <th style={cellTh}>改定前の日額</th>
                  <td style={cellTd}>{yen(f.oldDaily)}</td>
                </tr>
                <tr>
                  <th style={cellTh}>改定後の日額</th>
                  <td style={{ ...cellTd, fontWeight: 700, fontSize: 15 }}>{yen(f.newDaily)}</td>
                </tr>
                <tr>
                  <th style={cellTh}>改定額</th>
                  <td style={cellTd}>1日あたり {yen(f.raisePerDay)} の増額</td>
                </tr>
                <tr>
                  <th style={cellTh}>等級・号数</th>
                  <td style={cellTd}>
                    {f.grade === 'doko' ? '土工' : f.grade}　{f.oldStep}号 → <b>{f.newStep}号</b>
                  </td>
                </tr>
                {f.adjustment ? (
                  <tr>
                    <th style={cellTh}>調整給</th>
                    <td style={cellTd}>{yen(f.adjustment)}（上記の日額に含みます）</td>
                  </tr>
                ) : null}
              </tbody>
            </table>

            <p style={{ fontSize: 11.5, color: '#555', lineHeight: 1.9, marginTop: 16 }}>
              ※ 上記は基本給（日額）です。時間外手当・休日手当等は別途支給します。<br />
              ※ 賃金の支払日は翌月25日です。改定後の賃金は{jpDate(data.effective)}以降の勤務分から適用されます。
            </p>

            <div style={{ textAlign: 'right', marginTop: 30, fontSize: 13.5, lineHeight: 2 }}>
              <div>株式会社 日比建設</div>
              <div>代表取締役　日比 靖仁　<span style={{ display: 'inline-block', width: 46, height: 46, border: '1px solid #ccc', borderRadius: '50%', verticalAlign: 'middle', marginLeft: 6 }} /></div>
            </div>

            <div style={{ textAlign: 'center', fontSize: 12, marginTop: 22 }}>以上</div>
          </div>
        </div>
      ))}
    </>
  )
}

const cellTh: React.CSSProperties = {
  border: '1px solid #999', padding: '10px 14px', background: '#f2f4f6',
  textAlign: 'left', width: '34%', fontWeight: 700, fontSize: 13,
}
const cellTd: React.CSSProperties = {
  border: '1px solid #999', padding: '10px 14px', textAlign: 'left',
}

export default function WageNoticePage() {
  return (
    <Suspense fallback={<div style={{ padding: 24, color: '#666' }}>読み込み中…</div>}>
      <NoticeBody />
    </Suspense>
  )
}
