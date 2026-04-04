import { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  Header, Footer, AlignmentType, HeadingLevel, BorderStyle, WidthType,
  ShadingType, PageNumber, LevelFormat, PageBreak } from 'docx';
import fs from 'fs';

// ── Helpers ──
const border = { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' };
const borders = { top: border, bottom: border, left: border, right: border };
const cellMargins = { top: 60, bottom: 60, left: 100, right: 100 };
const headerShading = { fill: '1B2A4A', type: ShadingType.CLEAR };
const altShading = { fill: 'F5F7FA', type: ShadingType.CLEAR };
const accentShading = { fill: 'EBF5FF', type: ShadingType.CLEAR };

function text(t, opts = {}) { return new TextRun({ text: t, font: 'Yu Gothic', ...opts }); }
function bold(t, opts = {}) { return text(t, { bold: true, ...opts }); }
function para(children, opts = {}) {
  return new Paragraph({ children: Array.isArray(children) ? children : [children], spacing: { after: 120 }, ...opts });
}
function heading(t, level = HeadingLevel.HEADING_1) {
  return new Paragraph({ heading: level, children: [bold(t, { size: level === HeadingLevel.HEADING_1 ? 28 : level === HeadingLevel.HEADING_2 ? 24 : 22 })], spacing: { before: 300, after: 150 } });
}
function bullet(t, opts = {}) {
  return new Paragraph({ numbering: { reference: 'bullets', level: 0 }, spacing: { after: 60 }, children: Array.isArray(t) ? t : [text(t)], ...opts });
}
function numbered(t, ref = 'numbers', opts = {}) {
  return new Paragraph({ numbering: { reference: ref, level: 0 }, spacing: { after: 60 }, children: Array.isArray(t) ? t : [text(t)], ...opts });
}

function tableRow(cells, isHeader = false, isAlt = false, isAccent = false) {
  return new TableRow({
    children: cells.map((c) => new TableCell({
      borders,
      margins: cellMargins,
      width: { size: c.width || 2340, type: WidthType.DXA },
      shading: isHeader ? headerShading : isAccent ? accentShading : isAlt ? altShading : undefined,
      children: [para([text(c.text || c, {
        bold: isHeader || c.bold, color: isHeader ? 'FFFFFF' : '333333', size: 18, font: 'Yu Gothic'
      })], { alignment: c.align || AlignmentType.LEFT })]
    }))
  });
}

function simpleTable(headers, rows, widths) {
  const totalW = widths.reduce((a, b) => a + b, 0);
  return new Table({
    width: { size: totalW, type: WidthType.DXA },
    columnWidths: widths,
    rows: [
      tableRow(headers.map((h, i) => ({ text: h, width: widths[i] })), true),
      ...rows.map((row, ri) => tableRow(row.map((c, i) => {
        if (typeof c === 'string') return { text: c, width: widths[i] };
        return { ...c, width: widths[i] };
      }), false, ri % 2 === 1))
    ]
  });
}

// ── Document ──
const doc = new Document({
  styles: {
    default: { document: { run: { font: 'Yu Gothic', size: 21 } } },
    paragraphStyles: [
      { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { size: 28, bold: true, font: 'Yu Gothic', color: '1B2A4A' },
        paragraph: { spacing: { before: 360, after: 200 }, outlineLevel: 0 } },
      { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { size: 24, bold: true, font: 'Yu Gothic', color: '1B2A4A' },
        paragraph: { spacing: { before: 240, after: 160 }, outlineLevel: 1 } },
      { id: 'Heading3', name: 'Heading 3', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { size: 22, bold: true, font: 'Yu Gothic', color: '2E5090' },
        paragraph: { spacing: { before: 180, after: 120 }, outlineLevel: 2 } },
    ]
  },
  numbering: {
    config: [
      { reference: 'bullets', levels: [{ level: 0, format: LevelFormat.BULLET, text: '\u2022', alignment: AlignmentType.LEFT,
        style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
      { reference: 'numbers', levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT,
        style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
      { reference: 'paren', levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '(%1)', alignment: AlignmentType.LEFT,
        style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
    ]
  },
  sections: [{
    properties: {
      page: {
        size: { width: 11906, height: 16838 },
        margin: { top: 1440, right: 1260, bottom: 1260, left: 1260 }
      }
    },
    headers: {
      default: new Header({ children: [
        new Paragraph({ alignment: AlignmentType.RIGHT, children: [
          text('株式会社日比建設 — 変形労働時間制ご相談資料', { size: 16, color: '888888' })
        ]})
      ]})
    },
    footers: {
      default: new Footer({ children: [
        new Paragraph({ alignment: AlignmentType.CENTER, children: [
          text('- ', { size: 16, color: '888888' }),
          new TextRun({ children: [PageNumber.CURRENT], size: 16, color: '888888' }),
          text(' -', { size: 16, color: '888888' }),
        ]})
      ]})
    },
    children: [
      // ════════════════════════════════════════
      // タイトル
      // ════════════════════════════════════════
      new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 60 }, children: [
        bold('変形労働時間制の導入と月給設計に関するご相談', { size: 32, color: '1B2A4A' })
      ]}),
      new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 100 }, children: [
        text('改訂版', { size: 22, color: '2E5090', bold: true })
      ]}),
      new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 400 }, children: [
        text('株式会社日比建設 → エムテック協同組合 Chiさま', { size: 20, color: '666666' })
      ]}),

      // ════════════════════════════════════════
      // 1. 背景・目的
      // ════════════════════════════════════════
      heading('1. 背景・目的'),
      para([text('現在、当社では技能実習生3名・特定技能7名（全員ベトナム人）を雇用しております。')]),
      para([text('このたび、以下の目的で'), bold('1ヶ月単位の変形労働時間制'), text('の導入を検討しております。')]),
      bullet([text('土曜出勤時の割増賃金の適正化（所定内に含めることで割増を回避）')]),
      bullet([text('会社都合の休業（0.6補償）の解消（カレンダーで休日を事前確定）')]),
      bullet([text('閑散月（年末年始・GW・夏季休暇）の人件費の適正化')]),
      bullet([text('月給制の要件を満たしつつ、合理的な基本給設計を実現すること')], { spacing: { after: 200 } }),

      // ════════════════════════════════════════
      // 2. 変形労働時間制の概要
      // ════════════════════════════════════════
      heading('2. 変形労働時間制の概要'),
      simpleTable(
        ['項目', '内容'],
        [
          ['制度', '1ヶ月単位の変形労働時間制'],
          ['所定労働時間', '1日7時間'],
          ['勤務時間', '8:00～17:00'],
          ['休憩', '10:00-10:30 / 12:00-13:00 / 15:00-15:30（計120分）'],
          ['残業の定義', '月の法定上限時間（暦日数×40÷7）を超えた分のみ'],
          ['残業手当', '時給 × 1.25 × 法定超過時間'],
        ],
        [2800, 6586]
      ),
      para([]),

      heading('法定上限早見表', HeadingLevel.HEADING_3),
      simpleTable(
        ['月の暦日数', '法定上限時間', '7hでの最大所定日数'],
        [
          ['28日', '160.0h', '22日'],
          ['29日', '165.7h', '23日'],
          ['30日', '171.4h', '24日'],
          ['31日', '177.1h', '25日'],
        ],
        [3128, 3128, 3130]
      ),
      para([]),

      // ════════════════════════════════════════
      // 3. カレンダー運用方針
      // ════════════════════════════════════════
      heading('3. 就業カレンダーの運用方針'),

      heading('カレンダーは現場ごとに作成', HeadingLevel.HEADING_3),
      para([text('建設業では元請から届くカレンダーが現場ごとに異なります（土曜出勤の有無、工程変更等）。')]),
      para([text('そのため、就業カレンダーは'), bold('現場ごとに作成'), text('し、各スタッフは配置先の現場のカレンダーに署名します。')]),

      heading('カレンダーを現場ごとに作成するメリット', HeadingLevel.HEADING_3),
      simpleTable(
        ['状況', '会社共通カレンダーの場合', '現場ごとカレンダーの場合'],
        [
          ['現場Aが土曜出勤', '共通カレンダーが土曜休みなら → 休日出勤（35%割増）', '現場Aのカレンダーで土曜を出勤日に設定 → 所定内（割増なし）'],
          ['現場Bが土曜休み', '問題なし', '現場Bのカレンダーで土曜を休日に設定 → 問題なし'],
          ['現場Cが雨天で中止', '共通カレンダーが出勤日なら → 0.6補償発生', '現場Cのカレンダーで事前に調整可能'],
        ],
        [2200, 3593, 3593]
      ),
      para([]),
      para([bold('→ 現場ごとにカレンダーを作ることで、割増賃金も0.6補償も発生しない運用が可能になります。')]),

      heading('月途中で現場が変わる場合', HeadingLevel.HEADING_3),
      para([text('スタッフが月の途中で現場を異動する場合は、以下の運用とします：')]),
      bullet([text('異動前の現場のカレンダーに署名済み → そのまま有効')]),
      bullet([text('異動先の現場のカレンダーにも追加で署名')]),
      bullet([text('給与計算は個人の月間合計実績で行うため、現場の数に関係なく正確に計算可能')]),
      para([]),

      heading('毎月の運用フロー', HeadingLevel.HEADING_3),
      simpleTable(
        ['時期', 'やること', '担当'],
        [
          ['20日頃', '元請から翌月カレンダーを入手', '職長'],
          ['～25日', '各現場の出勤日/休日をシステムに入力・法定上限チェック（自動）', '職長'],
          ['～月末', '事業責任者が承認 → 所定日数・所定時間が確定', '事業責任者'],
          ['承認後', 'Messengerでリンク送信 → スタッフが署名', '事務'],
          ['翌月1日～', 'カレンダー通りに勤務開始', '全員'],
        ],
        [1600, 5786, 2000]
      ),
      para([]),

      // ════════════════════════════════════════
      // 4. 月給設計の方針
      // ════════════════════════════════════════
      new Paragraph({ children: [new PageBreak()] }),
      heading('4. 月給設計の方針（ご確認事項）'),

      heading('基本的な考え方', HeadingLevel.HEADING_3),
      numbered([bold('完全週休2日（土日休み）＋大型休暇'), text('を織り込んだ最少稼働月（20日程度）を想定')]),
      numbered([text('この最少ラインの所定時間（'), bold('140h = 20日×7h'), text('）をベースに基本給を設定')]),
      numbered([bold('基本給 = 時給 × 140h（月額固定）'), text(' — 毎月同額が保証される')]),
      numbered([text('稼働が多い月は、20日を超えた分を'), bold('追加所定手当'), text('として別途支給')]),
      numbered([text('残業は月の法定上限を超えた分のみ — '), bold('変形労働時間制により判定')], 'numbers', { spacing: { after: 200 } }),

      heading('給与の3層構造', HeadingLevel.HEADING_3),
      simpleTable(
        ['構成要素', '計算方法', '性質'],
        [
          ['基本給（固定）', '時給 × 140h（20日×7h）', '毎月同額・減額なし（月給制の要件）'],
          ['追加所定手当', '時給 × (実出勤日数 − 20日) × 7h', '稼働が多い月のみ発生・割増なし'],
          ['残業手当', '時給 × 1.25 × 法定超過時間', '月の法定上限を超えた分のみ'],
        ],
        [2600, 3786, 3000]
      ),
      para([]),
      para([text('※ 基本給は毎月固定であり、閑散月でも繁忙月でも同額が保証されます。')]),
      para([text('※ 追加所定手当は、スタッフの実出勤日数に基づいて算出されます（所定内労働のため割増なし）。')]),
      para([text('※ 欠勤控除は自己都合の欠勤のみ対象（会社都合の休業は控除不可）。')]),

      heading('追加所定手当の考え方', HeadingLevel.HEADING_3),
      para([text('現場ごとにカレンダーが異なるため、スタッフの実際の出勤日数は配置先現場によって変わります。')]),
      simpleTable(
        ['ケース', '実出勤日数', '基本給（固定）', '追加所定手当', '合計（残業除く）'],
        [
          ['現場A（土曜出勤あり）', '24日', '358,120円', '2,558 × 28h = 71,624円', '429,744円'],
          ['現場B（完全週休2日）', '22日', '358,120円', '2,558 × 14h = 35,812円', '393,932円'],
          ['閑散月（GW等）', '20日', '358,120円', '0円', '358,120円'],
        ],
        [2200, 1400, 1800, 2600, 1386]
      ),
      para([text('※ 時給2,558円のスタッフの場合の例')]),
      para([]),

      // ════════════════════════════════════════
      // 5. 具体的な計算例
      // ════════════════════════════════════════
      heading('5. 具体的な計算例（時給2,558円のスタッフ）'),

      heading('【ケース1】24日稼働の月（通常月・土曜出勤あり）', HeadingLevel.HEADING_3),
      simpleTable(
        ['項目', '計算', '金額'],
        [
          ['基本給（固定）', '2,558円 × 140h', '358,120円'],
          ['追加所定手当', '2,558円 × 28h（4日×7h）', '71,624円'],
          ['残業手当', '2,558 × 1.25 × 36h', '115,110円'],
          [{ text: '支給合計', bold: true }, '', { text: '544,854円', bold: true }],
        ],
        [2800, 3986, 2600]
      ),
      para([text('※ 残業36hは仮の数字（日々の残業の月合計が法定超過した分）')]),
      para([]),

      heading('【ケース2】20日稼働の月（GW・年末年始等）', HeadingLevel.HEADING_3),
      simpleTable(
        ['項目', '計算', '金額'],
        [
          ['基本給（固定）', '2,558円 × 140h', '358,120円'],
          ['追加所定手当', 'なし（20日 = ベースライン）', '0円'],
          ['残業手当', '2,558 × 1.25 × 20h', '63,950円'],
          [{ text: '支給合計', bold: true }, '', { text: '422,070円', bold: true }],
        ],
        [2800, 3986, 2600]
      ),
      para([]),

      heading('【参考】年間支給額の比較', HeadingLevel.HEADING_3),
      para([text('年間所定日数268日・残業月平均36hを想定した場合：')]),
      simpleTable(
        ['方式', '年間基本給+追加手当', '年間残業代', '年間合計'],
        [
          ['月給固定（24日ベース）', '5,156,928円', '1,384,560円', '6,541,488円'],
          ['本案（20日ベース＋追加手当）', '4,798,808円', '1,384,560円', '6,183,368円'],
          [{ text: '差額', bold: true }, '', '', { text: '▲358,120円/年・人', bold: true }],
        ],
        [2800, 2262, 2062, 2262]
      ),
      para([text('※ 時給単価は同一であり、スタッフの時間あたり報酬は変わりません。'), text('閑散月の「実際は稼働していない時間分の支払い」がなくなることによる差額です。')]),
      para([]),

      // ════════════════════════════════════════
      // 6. 法的要件の確認事項
      // ════════════════════════════════════════
      new Paragraph({ children: [new PageBreak()] }),
      heading('6. 法的要件の確認事項'),
      para([text('以下の点について、技能実習機構・JACの審査基準に照らしてご確認をお願いいたします。')]),

      numbered([bold('月給制の要件について')], 'paren'),
      bullet([text('基本給を月額固定（最少稼働月ベース）で設定し、稼働が多い月に追加所定手当を支給する形は「月給制」として認められるか')]),
      bullet([text('基本給が毎月同額であり下がることはない点は、月給制の趣旨（仕事の繁閑により報酬が変動しない）に合致すると考えているが、問題ないか')]),
      bullet([text('JACの受入マニュアルでは「所定労働日数が変動しても月給制で支給」との記載があるが、基本給固定＋追加手当の構成は適合するか')], { spacing: { after: 200 } }),

      numbered([bold('カレンダーと署名の運用について')], 'paren'),
      bullet([text('就業カレンダーを現場ごとに作成し、スタッフが配置先現場のカレンダーに署名する運用で問題ないか')]),
      bullet([text('月途中で現場を異動する場合、異動先の現場カレンダーにも追加署名する対応で問題ないか')], { spacing: { after: 200 } }),

      numbered([bold('最低賃金のチェックについて')], 'paren'),
      bullet([text('東京都最低賃金（2025年度：1,226円）× 1.1 = 1,349円')]),
      bullet([text('当社の時給設定（例：2,558円）は上記を大幅に上回っている')]),
      bullet([text('月給÷年間平均月所定時間での判定でも問題ないか確認したい')], { spacing: { after: 200 } }),

      numbered([bold('変形労働時間制との併用について')], 'paren'),
      bullet([text('1ヶ月単位の変形労働時間制と月給制を併用することに問題はないか')]),
      bullet([text('現場ごとにカレンダーを作成し、所定日数が現場・月によって変動する運用は適法か')], { spacing: { after: 200 } }),

      numbered([bold('技能実習計画の変更届について')], 'paren'),
      bullet([text('所定労働時間を6h40mから7hに変更する場合の届出手続き')]),
      bullet([text('変形労働時間制の導入に伴う実習計画の変更が必要か')], { spacing: { after: 200 } }),

      numbered([bold('不利益変更について')], 'paren'),
      bullet([text('時給単価自体は変更せず、月給の算出基礎となる所定時間の考え方を変更する')]),
      bullet([text('スタッフの実質的な時間あたり報酬は変わらないため、不利益変更には該当しないと考えているが、問題ないか')], { spacing: { after: 200 } }),

      // ════════════════════════════════════════
      // 7. 管理体制の全体像
      // ════════════════════════════════════════
      heading('7. 管理体制の全体像'),

      simpleTable(
        ['管理項目', '単位', '説明'],
        [
          ['基本給', '会社共通', '時給 × 140h（20日ベース）で全員統一。現場に依存しない'],
          ['追加所定手当', '個人の実績', 'その月の実出勤日数が20日を超えた分。現場に関係なく個人ベースで算出'],
          ['就業カレンダー', '現場ごと', '元請カレンダーに基づき現場ごとに作成。割増・補償を回避する鍵'],
          ['署名', 'スタッフ×現場', '配置先現場のカレンダーに署名。月途中の異動は追加署名で対応'],
          ['残業判定', '個人の月合計', '法定上限（暦日数×40÷7）との比較。現場ではなく個人の合計で判定'],
          ['出面記録', '現場×日', '「どの現場で何日働いたか」を日ごとに記録。原価按分に使用'],
        ],
        [2200, 1800, 5386]
      ),
      para([]),

      heading('システムでの管理機能', HeadingLevel.HEADING_3),
      bullet([text('就業カレンダーの作成・承認・署名をシステムで一元管理')]),
      bullet([text('法定上限チェックの自動化（暦日数×40÷7）— 超過時は警告表示')]),
      bullet([text('月次の給与計算の自動化（基本給＋追加所定手当＋残業手当＋欠勤控除）')]),
      bullet([text('在留資格の細分化管理（実習1号/2号/3号、特定1号/2号）')]),
      bullet([text('在留期限のアラート管理（180日/90日/30日前に自動警告）')]),
      bullet([text('監理団体向けの出面データExcel出力機能')]),
      para([]),

      // ════════════════════════════════════════
      // 8. 導入スケジュール
      // ════════════════════════════════════════
      heading('8. 導入スケジュール（予定）'),
      simpleTable(
        ['#', 'ステップ', '時期', '状態'],
        [
          ['1', 'Chiさんとの協議・確認（本資料）', '3月', '← 今ここ'],
          ['2', 'Chiさんとの打ち合わせ', '4月13日', '予定済'],
          ['3', '労使協定の締結', '4月中', '未着手'],
          ['4', '就業規則の変更（6h40m→7h、休憩140分→120分）', '4月中', '未着手'],
          ['5', '雇用契約書の更新（各スタッフの署名取得）', '4月中', '未着手'],
          ['6', '労基署への届出（変形労働時間制の労使協定届＋就業規則変更届）', '4月中', '未着手'],
          ['7', '技能実習機構への届出（実習計画の変更届）', '4月中', '未着手'],
          ['8', '新制度での運用開始', '5月1日', '目標'],
        ],
        [500, 5086, 1600, 2200]
      ),
      para([]),

      // ── 締め ──
      new Paragraph({ border: { top: { style: BorderStyle.SINGLE, size: 6, color: '1B2A4A', space: 1 } }, spacing: { before: 300, after: 200 }, children: [] }),
      para([text('以上、ご確認のほどよろしくお願いいたします。')]),
      para([text('ご不明な点がございましたら、お気軽にお問い合わせください。')]),
      para([]),
      para([bold('株式会社日比建設')]),
      para([text('東京都清瀬市')]),
    ]
  }]
});

const buffer = await Packer.toBuffer(doc);
fs.writeFileSync('/Users/yasuhito.h/claude_code/hibi-calendar/docs/chiさん確認用_変形労働時間制と月給設計.docx', buffer);
console.log('Document created successfully!');
