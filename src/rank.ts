/**
 * Free-lane capability rating — a hand-maintained editorial order.
 *
 * These scores are NOT a benchmark: nothing here came from running an eval.
 * They are one person's judgement, written down so the settings card and the
 * model picker put the model you are most likely to want first. `source:
 * 'table'` says exactly that, and the card labels it 人工评级 in the badge
 * tooltip.
 *
 * Two rules keep the table honest:
 *   1. Anything not in {@link MANUAL_RANKS} is scored by a keyword heuristic and
 *      capped at {@link HEURISTIC_CEILING}, which sits below the lowest rated
 *      model. A model that appears upstream tomorrow therefore lands at the
 *      bottom of the list instead of outranking a rating that was written on
 *      purpose.
 *   2. The grade letter is derived from the score, never stored beside it, so a
 *      retuned number can never disagree with its own letter.
 *
 * Editing the order means editing this file only: change the score and reason in
 * {@link MANUAL_RANKS}, or the keyword weights in {@link TIER_WORDS} for the
 * fallback. Nothing else in the plugin needs to know about it.
 */

export type Grade = 'S' | 'A' | 'B' | 'C'

export interface RankInput {
  id: string
  contextWindow?: number
  reasoning?: boolean
  effortValues?: readonly string[]
}

export interface ModelRank {
  /** 0–100, higher is more capable. Only meaningful inside this free lane. */
  score: number
  grade: Grade
  /** `table` = hand rating, `heuristic` = keyword guess pending a rating. */
  source: 'table' | 'heuristic'
  /** Why this number, shown in the card tooltip. */
  note: string
}

/** Grade boundaries, read top down; the last entry is the floor. */
const GRADE_BANDS: ReadonlyArray<readonly [Grade, number]> = [
  ['S', 90],
  ['A', 80],
  ['B', 70],
  ['C', 0],
]

/**
 * Manual ratings for the ids observed on the lane (catalogue of 2026-10-18).
 *
 * The scores are a judgement of "how good is this at the work this harness
 * does — long tool-calling coding turns — relative to the other free ids", not
 * a claim about public benchmarks. A new id belongs here as soon as you have
 * used it enough to have an opinion; the `reason` is what makes the entry
 * reviewable later instead of looking like magic.
 */
const MANUAL_RANKS = new Map<string, { score: number; reason: string }>([
  [
    'space-bunny-free',
    {
      score: 96,
      reason: 'DSH 自家模型：工具调用最稳，长会话里不跑偏，1M 上下文 + 完整档位（low→max）。日常写代码的首选。',
    },
  ],
  [
    'deepseek-v4.1-flash-free',
    {
      score: 93,
      reason: 'DeepSeek V4.1 的 flash 档：通用推理和代码都属第一梯队，代价是只有 low/high/max 三档，中间档位缺失。',
    },
  ],
  [
    'glm-5.3-flash-free',
    {
      score: 88,
      reason: 'GLM-5.3：中文与结构化输出好，工具调用稳；flash 档比同代旗舰弱一档，上下文 200K。',
    },
  ],
  [
    'nemotron-3.5-super-vl-free',
    {
      score: 85,
      reason: 'Super VL：1M 上下文 + 视觉输入，档位最全（none→xhigh）；强在视觉与长文档，纯代码略逊于前面三个。',
    },
  ],
  [
    'mimo-v2.6-flash-free',
    {
      score: 83,
      reason: '小米 MiMo V2.6：开源同门里推理扎实，1M 上下文、视觉可用；上游没声明档位，只能吃默认档。',
    },
  ],
  [
    'longcat-2.5-preview-free',
    {
      score: 74,
      reason: '1M 上下文 + 视觉，但仍是 preview，预览版的行为稳定性按打折算。',
    },
  ],
  [
    'big-pickle',
    {
      score: 72,
      reason: '200K 上下文，上游既没声明档位也没公布家族信息，实际能力只能靠实测判断 —— 放在 B 段。',
    },
  ],
  [
    'nemotron-3.5-lightning-free',
    {
      score: 66,
      reason: 'lightning 档就是为速度牺牲深度的那一档；262144 的上下文看着大，但推理深度是这批里最浅的。',
    },
  ],
  // `beam-free` has no keyword that means anything here ("beam" is neither a
  // family nor a tier), so it is rated by hand rather than left to the
  // fallback: the fallback would file a model we have actually used under
  // "unknown", which is worse than a considered guess.
  [
    'beam-free',
    {
      score: 64,
      reason: '1M 上下文、档位齐全（low→max），但没有视觉；实测工具调用偏慢，长会话里比 super-vl 更容易松动，放在 C 段上沿。',
    },
  ],
])

/**
 * Ceiling for a keyword estimate, set below the lowest manual rating (64) so an
 * unknown id can never displace a rating someone wrote on purpose.
 */
export const HEURISTIC_CEILING = 61

/**
 * Keyword weights for the fallback. Ordered: the first hit per group wins, so
 * `nemotron-3.5-lightning` is discounted once, not twice.
 */
const TIER_WORDS: ReadonlyArray<readonly [string, number]> = [
  ['super', 8],
  ['ultra', 8],
  ['pro', 6],
  ['max', 4],
  ['preview', -6],
  ['lightning', -8],
  ['flash', -8],
  ['lite', -8],
  ['mini', -8],
  ['nano', -8],
  ['tiny', -8],
]

/** Baseline for an id with no tier word and no version: "unknown, not bad". */
const HEURISTIC_BASE = 60

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value))
}

function gradeOf(score: number): Grade {
  for (const [grade, min] of GRADE_BANDS) {
    if (score >= min) return grade
  }
  return 'C'
}

/** `v4.1` → major 4, minor 1. A missing version contributes nothing. */
function versionOf(id: string): { major: number; minor: number } {
  const match = /v(\d+)(?:\.(\d+))?/i.exec(id)
  if (match === null) return { major: 0, minor: 0 }
  return { major: Number(match[1] ?? 0), minor: Number(match[2] ?? 0) }
}

/**
 * Score an id nobody has rated yet.
 *
 * Only weak, checkable signals are used: the version number in the id, a tier
 * word, and whether the upstream metadata says the model reasons and how deep
 * its ladder is. Nothing here pretends to know quality — the ceiling keeps the
 * result below every rating.
 */
export function heuristicRank(model: RankInput): ModelRank {
  const id = model.id.toLowerCase()
  const { major, minor } = versionOf(id)
  let score = HEURISTIC_BASE
  if (major > 0) {
    score += 3 * clamp(major - 1, 0, 5)
    score += 2 * clamp(minor, 0, 4)
  }
  for (const [word, delta] of TIER_WORDS) {
    if (id.includes(word)) {
      score += delta
      break
    }
  }
  const levels = model.effortValues?.length ?? 0
  const reasons = model.reasoning === true && levels > 0
  return {
    score: clamp(score, 0, HEURISTIC_CEILING),
    grade: gradeOf(clamp(score, 0, HEURISTIC_CEILING)),
    source: 'heuristic',
    note: reasons
      ? `自动估计（关键词：${id}）· 声明了 ${levels} 档推理。还没人工评级，加进 MANUAL_RANKS 就能定住。`
      : '自动估计（只看 id 里的版本号和档位词）· 还没人工评级，加进 MANUAL_RANKS 就能定住。',
  }
}

/** Rate one model. Hand table first, keyword heuristic otherwise. */
export function rankModel(model: RankInput): ModelRank {
  const rated = MANUAL_RANKS.get(model.id)
  if (rated === undefined) return heuristicRank(model)
  return {
    score: rated.score,
    grade: gradeOf(rated.score),
    source: 'table',
    note: `人工评级（不是跑分）· ${rated.reason}`,
  }
}

/** Every hand rating, newest table order preserved — for the "按能力" legend. */
export function ratedModelIds(): string[] {
  return [...MANUAL_RANKS.keys()]
}

/**
 * Strongest first. Ties break on context window, then on ladder depth, then on
 * id, so the order is total and stable across refreshes — two models that score
 * equally never swap places between renders.
 */
export function compareByCapability(a: RankInput, b: RankInput): number {
  return (
    rankModel(b).score - rankModel(a).score ||
    (b.contextWindow ?? 0) - (a.contextWindow ?? 0) ||
    (b.effortValues?.length ?? 0) - (a.effortValues?.length ?? 0) ||
    a.id.localeCompare(b.id)
  )
}