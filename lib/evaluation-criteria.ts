/**
 * 評価項目の定義と各グレードの説明文
 * 評価入力画面で評価者が参照するための基準
 */

export interface CriterionDescription {
  key: string
  label: string
  A: string
  B: string
  C: string
}

export interface CategoryDefinition {
  key: 'japanese' | 'attitude' | 'skill'
  label: string
  icon: string
  color: string         // Tailwind色クラスの接頭辞（例: 'blue', 'green', 'orange'）
  weightLabel: string   // 例: '×1.0'
  criteria: CriterionDescription[]
}

export const EVALUATION_CATEGORIES: CategoryDefinition[] = [
  {
    key: 'japanese',
    label: '日本語能力',
    icon: '🗣',
    color: 'blue',
    weightLabel: '×1.0',
    criteria: [
      {
        key: 'understanding',
        label: '指示理解',
        A: '一度で正確に理解し、確認の質問もできる',
        B: '概ね理解するが、たまに聞き返しが必要',
        C: '繰り返し説明が必要。複雑な指示は通じにくい',
      },
      {
        key: 'reporting',
        label: '報告・連絡',
        A: '自分から日本語で報告・連絡ができる。問題発生時も的確に伝えられる',
        B: '聞かれれば答えられるが、自発的な報告は少ない',
        C: '通訳が必要な場面が多い。報告が遅れることがある',
      },
      {
        key: 'safety',
        label: '安全用語',
        A: '危険予知・安全指示を理解し、他のスタッフにも伝達できる',
        B: '基本的な安全用語（危ない・止まれ・ヘルメット等）は理解している',
        C: '安全に関する指示の理解が不十分。安全面でのリスクがある',
      },
    ],
  },
  {
    key: 'attitude',
    label: '勤務態度',
    icon: '💼',
    color: 'green',
    weightLabel: '×1.5',
    criteria: [
      {
        key: 'punctuality',
        label: '時間厳守・出勤',
        A: '無遅刻・無欠勤（有給除く）。始業前に準備を済ませている',
        B: '年1〜2回の遅刻程度。基本的には時間を守る',
        C: '遅刻・無断欠勤が目立つ。時間管理に課題がある',
      },
      {
        key: 'safetyAwareness',
        label: '安全意識',
        A: 'ヘルメット・安全帯の着用を自ら徹底。周囲の安全にも気を配る',
        B: '注意すれば守る。基本的なルールは理解している',
        C: '繰り返し注意が必要。安全装備の着用忘れや不安全行動がある',
      },
      {
        key: 'teamwork',
        label: '協調性・チームワーク',
        A: '他のスタッフと積極的に協力し、後輩の面倒も見る。現場の雰囲気を良くする',
        B: '与えられた仕事を問題なくこなす。チームワークに支障はない',
        C: '単独行動が多い。コミュニケーションが不足し、チームワークに課題がある',
      },
      {
        key: 'compliance',
        label: '指示遵守',
        A: '職長や先輩社員の指示を正確に守り、自己判断で勝手に変えない。不明点は必ず確認する',
        B: '基本的に指示は守るが、たまに自己判断で省略・変更することがある',
        C: '指示を守らないことが目立つ。自分のやり方で勝手に進めてしまうことがある',
      },
    ],
  },
  {
    key: 'skill',
    label: '職業能力',
    icon: '🔨',
    color: 'orange',
    weightLabel: '×1.2',
    criteria: [
      {
        key: 'level',
        label: '技能レベル',
        A: '一人で任せられる作業が多い。難易度の高い作業もこなせる',
        B: '指示を受ければ一通りの作業ができる。標準的なレベル',
        C: '常に監督が必要。基本的な作業でもミスが多い',
      },
      {
        key: 'speed',
        label: '作業速度・品質',
        A: '日本人と同等以上のスピードと品質。手直しがほとんど不要',
        B: '概ね問題ないレベル。時々確認や手直しが必要',
        C: 'スピード・品質に改善が必要。手直しが頻繁に発生する',
      },
      {
        key: 'planning',
        label: '段取り・準備',
        A: '次の工程を予測して自ら材料・道具を準備できる。段取りが良い',
        B: '言われれば段取りできる。基本的な準備はできる',
        C: '段取りの意識が低い。指示待ちになることが多い',
      },
    ],
  },
]
