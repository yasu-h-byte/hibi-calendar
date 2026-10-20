'use client'

/**
 * 一次（山岡建設工業）への請求書の印刷面（2026-10-20）。
 * 山岡の請求書フォーマット（2023.09版・A4横）に倣う: 左に宛名・請求年月日・今回請求額・登録番号・工事名称・明細・税率内訳、
 * 右に支払区分・注文番号の枠・振込先・発注者・現場コード・承認欄。工種（大林組の控え）ごとに1枚。
 * 金額は lib/prime-invoice.ts で計算した凍結内容をそのまま描く（ここで計算しない）。
 */
import type { PrimeInvoiceBundle, PrimeSheet } from '@/lib/prime-invoice'

const yen = (v: number) => '¥' + Math.round(v).toLocaleString()
const num = (v: number) => Math.round(v).toLocaleString()
/** 令和の年・月・日（マス目に入れる） */
function reiwaParts(iso: string): { y: string; m: string; d: string } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) return { y: '', m: '', d: '' }
  const era = parseInt(m[1], 10) - 2018
  return { y: era === 1 ? '元' : String(era), m: String(parseInt(m[2], 10)), d: String(parseInt(m[3], 10)) }
}
const md = (iso: string) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso); return m ? { m: parseInt(m[2], 10), d: parseInt(m[3], 10) } : { m: 0, d: 0 } }

/** 登録番号を1桁ずつ枠に入れる（T + 13桁） */
function RegNoBoxes({ regNo }: { regNo: string }) {
  const chars = (regNo || '').replace(/\s/g, '').split('')
  const cells = Array.from({ length: 14 }, (_, i) => chars[i] || '')
  return (
    <div className="prime-regno">
      {cells.map((c, i) => <span key={i} className="prime-regno-cell">{c}</span>)}
    </div>
  )
}

function PostalBoxes({ postal }: { postal: string }) {
  const digits = (postal || '').replace(/\D/g, '').split('')
  const cells = Array.from({ length: 7 }, (_, i) => digits[i] || '')
  return (
    <span className="prime-postal">
      〒 {cells.slice(0, 3).map((c, i) => <span key={i} className="prime-postal-cell">{c}</span>)}<span className="mx-0.5">−</span>{cells.slice(3).map((c, i) => <span key={i + 3} className="prime-postal-cell">{c}</span>)}
    </span>
  )
}

export function PrimeInvoiceSheetPage({ b, s, pageNo, pages }: { b: PrimeInvoiceBundle; s: PrimeSheet; pageNo: number; pages: number }) {
  const issuer = b.issuer
  const from = md(b.billingPeriod.from), to = md(b.billingPeriod.to)
  const gcIsObayashi = /大林/.test(s.projectName) || true
  const ordererOther = ''
  const taxRatePct = Math.round((b.taxRate ?? 0.1) * 100)
  const watermark = b.status === 'void' ? '取り消し' : b.status === 'issued' ? '' : b.status === 'pending' ? '確認1待ち' : b.status === 'checked' ? '確認2待ち' : '下書き'
  return (
    <section className="prime-page">
      {watermark && <div className="prime-watermark">{watermark}</div>}
      <div className="prime-grid">
        {/* ── 左：宛名・本体 ── */}
        <div className="prime-left">
          <div className="prime-row-top">
            <div className="prime-addr">
              <div className="prime-to"><span className="prime-to-name">{b.companyName}</span><span className="prime-to-honor">御中</span></div>
              <div className="prime-me">
                <PostalBoxes postal={issuer?.postal || ''} />
                <div className="prime-me-line"><span className="prime-me-label">住所</span>{issuer?.address || ''}</div>
                <div className="prime-me-line prime-me-company"><span className="prime-me-label">会社名</span>{issuer?.name || ''}</div>
                <div className="prime-me-line"><span className="prime-me-label">電話</span>{issuer?.tel || ''}</div>
              </div>
            </div>
            <div className="prime-title-col">
              <div className="prime-title">請　求　書</div>
              <div className="prime-date-box">
                <span className="prime-date-label">請求年月日</span>
                <span className="prime-date-era">令和</span><span className="prime-date-cell">{reiwaParts(b.issueDate || b.invoiceDate).y}</span><span>年</span>
                <span className="prime-date-cell">{reiwaParts(b.issueDate || b.invoiceDate).m}</span><span>月</span>
                <span className="prime-date-cell">{reiwaParts(b.issueDate || b.invoiceDate).d}</span><span>日</span>
              </div>
              <div className="prime-total-box"><span className="prime-total-label">今回請求額</span><span className="prime-total-amt">{yen(s.total)}</span></div>
            </div>
          </div>

          <div className="prime-regno-wrap">
            <div className="prime-regno-title">適格請求書発行事業者登録番号</div>
            <RegNoBoxes regNo={issuer?.invoiceRegNo || ''} />
          </div>

          <table className="prime-table prime-site">
            <tbody>
              <tr>
                <th>工事名称</th><td className="prime-site-name">{s.projectName || b.siteName}</td>
                <th>工事種類</th><td className="prime-site-trade">{s.tradeName}</td>
              </tr>
            </tbody>
          </table>

          <table className="prime-table prime-lines">
            <thead>
              <tr><th className="prime-c-m">月</th><th className="prime-c-d">日</th><th className="prime-c-desc">摘　要</th><th className="prime-c-qty">数量</th><th className="prime-c-unit">単位</th><th className="prime-c-rate">単価</th><th className="prime-c-amt">金額</th></tr>
            </thead>
            <tbody>
              <tr><td>{from.m}</td><td>{from.d}</td><td className="prime-desc">今回請求金（標準税率対象）</td><td className="prime-num">1</td><td className="prime-ctr">式</td><td className="prime-num">{num(s.amount)}</td><td className="prime-num">{num(s.amount)}</td></tr>
              <tr><td></td><td>～</td><td></td><td></td><td></td><td></td><td className="prime-num">0</td></tr>
              <tr><td>{to.m}</td><td>{to.d}</td><td></td><td></td><td></td><td></td><td className="prime-num">0</td></tr>
              {[0, 1, 2, 3].map(i => <tr key={i}><td></td><td></td><td></td><td></td><td></td><td></td><td className="prime-num">0</td></tr>)}
              <tr className="prime-sub"><td colSpan={6} className="prime-right">小　計</td><td className="prime-num">{num(s.amount)}</td></tr>
              <tr className="prime-sub"><td colSpan={6} className="prime-right">請求金額合計（消費税込金額）</td><td className="prime-num prime-bold">{num(s.total)}</td></tr>
            </tbody>
          </table>

          <table className="prime-table prime-taxes">
            <thead>
              <tr><th className="prime-tax-h">消費税率毎の請求内訳</th><th>税抜金額</th><th className="prime-op">＋</th><th>消費税額</th><th className="prime-op">＝</th><th>税込金額</th></tr>
            </thead>
            <tbody>
              <tr><td className="prime-tax-l">税率 {taxRatePct}%（標準税率）対象請求金額</td><td className="prime-num">{num(s.amount)}</td><td className="prime-op">＋</td><td className="prime-num">{num(s.tax)}</td><td className="prime-op">＝</td><td className="prime-num">{num(s.total)}</td></tr>
              <tr><td className="prime-tax-l">税率 　%（軽減税率・非課税）対象請求金額</td><td className="prime-num"></td><td className="prime-op">＋</td><td className="prime-num">0</td><td className="prime-op">＝</td><td className="prime-num">0</td></tr>
            </tbody>
          </table>
        </div>

        {/* ── 右：支払区分・振込先・発注者・承認欄 ── */}
        <div className="prime-right-col">
          <table className="prime-table prime-paykind">
            <tbody>
              <tr>
                <th rowSpan={2} className="prime-paykind-h">支払<br />区分</th>
                <td>1.払切(請書)　3.精算(請書)　4.内払(契約済)</td>
              </tr>
              <tr><td>2.払切(見積書・雑小口)　6.内払(未契約)</td></tr>
            </tbody>
          </table>
          <table className="prime-table prime-order">
            <tbody>
              {['注文番号', '契約金額', '増減額', '前回迄の請求額'].map(k => <tr key={k}><th>{k}</th><td></td></tr>)}
              <tr><th>今回請求額　第　　回</th><td></td></tr>
              <tr><th>差引残額</th><td></td></tr>
            </tbody>
          </table>
          <table className="prime-table prime-bank">
            <tbody>
              <tr><th>振込銀行</th><td>{issuer?.bank?.bankName || ''}</td></tr>
              <tr><th>支店名</th><td><span className="prime-branch">{(issuer?.bank?.branch || '').replace(/支店$/, '')}</span><span className="prime-branch-suffix">支店</span></td></tr>
              <tr><th>口座種類</th><td>{issuer?.bank?.accountType || ''}</td></tr>
              <tr><th>口座番号</th><td><span className="prime-no">NO.</span>{issuer?.bank?.accountNo || ''}</td></tr>
              <tr><th>口座名義</th><td>{issuer?.bank?.holder || ''}</td></tr>
            </tbody>
          </table>
          <div className="prime-orderer">
            発注者【 <span className={gcIsObayashi ? 'prime-circled' : ''}>大林組</span>・大林F・栄友・アサヒ・松下・その他(<span className="prime-other">{ordererOther}</span>) 】
          </div>
          <table className="prime-table prime-codes">
            <tbody>
              <tr><th>現場コード</th><td className="prime-code-cells"><span /><span /><span /><span /><span className="prime-dash">−</span><span /><span /><span className="prime-dash">−</span><span /><span /></td></tr>
              <tr><th>発注コード</th><td className="prime-code-cells"><span /><span /><span /><span /><span /><span /></td></tr>
            </tbody>
          </table>
          <table className="prime-table prime-costs">
            <thead><tr><th>工種</th><th>費目</th><th>金　額</th></tr></thead>
            <tbody>{[0, 1, 2].map(i => <tr key={i}><td></td><td></td><td></td></tr>)}</tbody>
          </table>
          <table className="prime-table prime-direct">
            <tbody><tr><th>直払　・　戻入払</th><td><span className="prime-small">(戻入先)</span></td></tr></tbody>
          </table>
          <table className="prime-table prime-sign">
            <thead><tr><th className="prime-sign-s">社　長</th><th className="prime-sign-s">経　理</th><th className="prime-sign-w" colSpan={2}>工 事 部</th><th className="prime-sign-s">担当者</th></tr></thead>
            <tbody><tr><td></td><td></td><td></td><td></td><td></td></tr></tbody>
          </table>
          <div className="prime-ver">2023.09版{pages > 1 ? `　${pageNo}/${pages}` : ''}{b.no ? `　${b.no}` : ''}</div>
        </div>
      </div>
    </section>
  )
}

export default function PrimeInvoiceDocument({ b }: { b: PrimeInvoiceBundle }) {
  return (
    <div className="prime-root">
      {b.sheets.map((s, i) => <PrimeInvoiceSheetPage key={i} b={b} s={s} pageNo={i + 1} pages={b.sheets.length} />)}
      <style jsx global>{`
        @media print {
          aside, header, nav, .no-print { display: none !important; }
          @page { size: A4 landscape; margin: 8mm; }
          .prime-page { page-break-after: always; margin: 0 !important; box-shadow: none !important; }
          .prime-page:last-child { page-break-after: auto; }
          * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
          main, .prime-root { padding: 0 !important; margin: 0 !important; max-width: 100% !important; background: white !important; }
        }
        .prime-root { background: white; color: #111; font-family: -apple-system, "Hiragino Sans", "Noto Sans CJK JP", "Yu Gothic", sans-serif; font-size: 0.82rem; }
        .prime-page { position: relative; width: 100%; max-width: 277mm; min-height: 192mm; margin: 0 auto 16px; padding: 7mm 8mm 6mm; background: white; box-shadow: 0 1px 6px rgba(0,0,0,.12); box-sizing: border-box; }
        .prime-watermark { position: absolute; left: 50%; top: 45%; transform: translate(-50%, -50%) rotate(-18deg); font-size: 4.5rem; font-weight: 900; color: rgba(200, 30, 30, .12); letter-spacing: .3em; pointer-events: none; white-space: nowrap; }
        .prime-grid { display: grid; grid-template-columns: 1fr 88mm; gap: 7mm; }
        .prime-row-top { display: grid; grid-template-columns: 44% 1fr; gap: 6mm; align-items: start; }
        .prime-to { display: flex; align-items: baseline; gap: 8px; margin: 2px 0 6px; }
        .prime-to-name { font-size: 1.25rem; font-weight: 700; text-decoration: underline; text-underline-offset: 4px; }
        .prime-to-honor { font-size: .9rem; }
        .prime-me { margin-top: 4px; line-height: 1.7; }
        .prime-postal { display: inline-flex; align-items: center; gap: 3px; font-size: .82rem; margin-bottom: 2px; }
        .prime-postal-cell { display: inline-block; width: 14px; height: 18px; border: 1px solid #333; text-align: center; line-height: 18px; font-size: .78rem; }
        .prime-me-line { display: flex; gap: 10px; align-items: baseline; }
        .prime-me-label { color: #333; font-size: .74rem; width: 42px; flex: none; }
        .prime-me-company { font-size: 1.2rem; font-weight: 700; }
        .prime-title-col { text-align: center; padding-top: 2px; }
        .prime-title { font-size: 2rem; font-weight: 700; letter-spacing: .45em; padding: 0 .2em 2px .45em; border-bottom: 2px solid #333; display: inline-block; margin-bottom: 8px; }
        .prime-date-box { border: 1px solid #333; padding: 0 10px 0 0; font-size: .86rem; margin-bottom: 8px; text-align: left; display: flex; align-items: center; gap: 4px; }
        .prime-date-label { margin-right: 10px; padding: 5px 10px; border-right: 1px solid #333; white-space: nowrap; }
        .prime-date-era { margin-right: 2px; }
        .prime-date-cell { display: inline-block; min-width: 28px; padding: 0 4px; border: 1px solid #333; text-align: center; line-height: 20px; margin: 0 2px; }
        .prime-total-box { border: 2px solid #333; padding: 0 10px 0 0; display: flex; align-items: center; justify-content: space-between; gap: 10px; }
        .prime-total-label { font-size: .9rem; padding: 10px 12px; border-right: 1px solid #333; align-self: stretch; display: flex; align-items: center; white-space: nowrap; }
        .prime-date-box span, .prime-total-amt { white-space: nowrap; }
        .prime-total-amt { font-size: 1.85rem; font-weight: 800; letter-spacing: .02em; }
        .prime-regno-wrap { margin-top: 8px; border: 1px solid #333; padding: 3px 8px 6px; display: block; width: 60%; box-sizing: border-box; }
        .prime-regno-title { text-align: center; font-size: .76rem; border-bottom: 1px solid #333; margin-bottom: 4px; }
        .prime-regno { display: flex; gap: 3px; justify-content: space-between; }
        .prime-regno-cell { display: inline-block; flex: 1; height: 27px; border: 1px solid #333; text-align: center; line-height: 27px; font-size: 1.15rem; font-weight: 700; }
        .prime-table { width: 100%; border-collapse: collapse; margin-top: 8px; }
        .prime-table th, .prime-table td { border: 1px solid #333; padding: 3px 6px; font-size: .8rem; vertical-align: middle; }
        .prime-table th { font-weight: 600; background: #fafafa; text-align: center; white-space: nowrap; }
        .prime-site th { width: 54px; }
        .prime-site td { height: 30px; }
        .prime-site-name { font-size: .88rem; }
        .prime-site-trade { font-size: .82rem; width: 30%; }
        .prime-lines td { height: 23px; }
        .prime-c-m, .prime-c-d { width: 24px; }
        .prime-c-qty { width: 56px; } .prime-c-unit { width: 38px; } .prime-c-rate { width: 88px; } .prime-c-amt { width: 100px; }
        .prime-desc { text-align: center; }
        .prime-num { text-align: right; font-variant-numeric: tabular-nums; }
        .prime-ctr { text-align: center; }
        .prime-right { text-align: right; font-weight: 600; }
        .prime-bold { font-weight: 800; font-size: .88rem; }
        .prime-taxes th, .prime-taxes td { font-size: .76rem; }
        .prime-taxes td { height: 22px; }
        .prime-tax-h { width: 42%; }
        .prime-tax-l { font-size: .76rem; }
        .prime-op { width: 18px; text-align: center; border-left: none !important; border-right: none !important; }
        .prime-paykind td { font-size: .68rem; height: 18px; }
        .prime-paykind-h { width: 36px; }
        .prime-order th { width: 46%; font-size: .74rem; text-align: left; }
        .prime-order td { height: 18px; }
        .prime-bank th { width: 34%; font-size: .76rem; }
        .prime-bank td { height: 19px; }
        .prime-branch { display: inline-block; min-width: 60%; }
        .prime-branch-suffix { float: right; font-size: .72rem; }
        .prime-no { font-size: .64rem; margin-right: 12px; }
        .prime-orderer { font-size: .72rem; margin-top: 8px; }
        .prime-circled { display: inline-block; border: 1.5px solid #333; border-radius: 50%; padding: 0 3px; font-weight: 700; }
        .prime-other { display: inline-block; min-width: 30px; }
        .prime-codes th { width: 30%; font-size: .72rem; }
        .prime-codes td { height: 18px; }
        .prime-code-cells { display: flex; gap: 2px; align-items: center; }
        .prime-code-cells span { display: inline-block; width: 13px; height: 15px; border: 1px solid #555; }
        .prime-code-cells .prime-dash { border: none; width: auto; height: auto; line-height: 1; }
        .prime-costs td { height: 16px; }
        .prime-direct th { width: 48%; font-size: .74rem; }
        .prime-direct td { height: 30px; vertical-align: top; }
        .prime-small { font-size: .64rem; color: #444; }
        .prime-sign th { font-size: .76rem; }
        .prime-sign-s { width: 20%; }
        .prime-sign-w { width: 40%; }
        .prime-sign td { height: 50px; }
        .prime-ver { text-align: right; font-size: .66rem; color: #444; margin-top: 4px; }
        @media (prefers-color-scheme: dark) { .prime-root, .prime-page { color: #111; } }
      `}</style>
    </div>
  )
}
