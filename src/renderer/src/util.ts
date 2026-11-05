import type { GraphNode, ReviewComment, ReviewModel } from '../../shared/types'

export type Run = <T>(task: () => Promise<T>) => Promise<T | undefined>

export function readReviewed(key: string): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(`reviewed:${key}`) ?? '[]') as string[])
  } catch {
    return new Set()
  }
}

/** Storage can be unavailable. The reviewed marks then last only for this session. */
export function writeReviewed(key: string, ids: Set<string>): void {
  try {
    localStorage.setItem(`reviewed:${key}`, JSON.stringify([...ids]))
  } catch {
    return
  }
}

export type LeftPanel = 'reviews' | 'prereview' | 'discussion'

export interface Layout {
  /** Width of the left panel. The name stays for the stored layouts from before the activity bar. */
  inboxWidth: number
  /** The panel next to the activity bar. Null hides the panel. It is not undefined, because JSON drops undefined and the default would come back. */
  leftPanel: LeftPanel | null
  sideWidth: number
  graphOpen: boolean
  /** Height of the unit context above the tabs. Undefined lets the content set the height, up to a limit. */
  contextHeight?: number
}

export const DEFAULT_LAYOUT: Layout = { inboxWidth: 340, leftPanel: 'reviews', sideWidth: 760, graphOpen: true }

export function readLayout(): Layout {
  try {
    return { ...DEFAULT_LAYOUT, ...(JSON.parse(localStorage.getItem('layout') ?? '{}') as Partial<Layout>) }
  } catch {
    return DEFAULT_LAYOUT
  }
}

/** Storage can be unavailable. The layout then lasts only for this session. */
export function writeLayout(layout: Layout): void {
  try {
    localStorage.setItem('layout', JSON.stringify(layout))
  } catch {
    return
  }
}

/** Finds the smallest changed unit that holds the commented line, or the file node. */
export function nodeForComment(model: ReviewModel, comment: ReviewComment): GraphNode | undefined {
  const inFile = model.nodes.filter((n) => n.file === comment.file && n.role === 'changed')
  const line = comment.line ?? 0
  const holding = inFile
    .filter((n) => n.kind !== 'file' && line >= n.startLine && line <= n.endLine)
    .sort((a, b) => a.endLine - a.startLine - (b.endLine - b.startLine))
  return holding[0] ?? inFile[0]
}

export type OpenTarget = { reviewId: number } | { branch: string }

/** A GitHub pull request link: "https://github.com/owner/repo/pull/123". */
const PULL_IN_LINK = /github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)/i
/** A git branch name such as "feature/task-123". */
const GIT_BRANCH = /^[\w.\-]+(?:\/[\w.\-]+)*$/
/** A review id in a link: "/codereviews/123", "review=123", "reviewid:123" and the like. */
const REVIEW_IN_LINK = /(?:code-?)?reviews?(?:id)?[/=:#]+(\d+)/i
/** A branch in a link or in a cm spec: "br:/main/task", "branch=/main/task". */
const BRANCH_IN_LINK = /(?:br|branch)[:=](\/[^\s&#?@]+)/i

/**
 * Reads what the user pasted: a Plastic review link (for example from a chat message), a GitHub pull
 * request link, a review id, or a branch name. Returns undefined for other text. A git branch name
 * is a plain word, so it is accepted only when gitBranches is true.
 */
export function parseOpenTarget(text: string, gitBranches = false): OpenTarget | undefined {
  const trimmed = text.trim()
  if (/^\d+$/.test(trimmed)) return { reviewId: Number(trimmed) }
  let decoded = trimmed
  try {
    decoded = decodeURIComponent(trimmed)
  } catch {
    decoded = trimmed
  }
  const pull = PULL_IN_LINK.exec(decoded)
  if (pull) return { reviewId: Number(pull[1]) }
  const review = REVIEW_IN_LINK.exec(decoded)
  if (review) return { reviewId: Number(review[1]) }
  const branch = BRANCH_IN_LINK.exec(decoded)
  if (branch) return { branch: branch[1].replace(/@.*$/, '') }
  if (/^\/[^:]+$/.test(trimmed)) return { branch: trimmed }
  if (gitBranches && GIT_BRANCH.test(trimmed)) return { branch: trimmed }
  return undefined
}

export function shortUser(user: string): string {
  return user.replace(/@.*$/, '')
}

export function shortDate(date: string): string {
  const d = new Date(date)
  return Number.isNaN(d.getTime()) ? date : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** Okabe-Ito palette. The colors stay apart for the common kinds of color blindness. */
export const CLUSTER_COLORS = ['#0072B2', '#E69F00', '#009E73', '#CC79A7', '#56B4E9', '#F0E442', '#D55E00', '#999999']

/**
 * Color of each AI pre-review level. High and medium look alike for some color-blind users, so the
 * UI always shows LEVEL_TAG next to the color.
 */
export const LEVEL_COLOR = { high: '#D55E00', medium: '#E69F00', low: '#56B4E9' } as const
export const LEVEL_TAG = { high: '⚠H', medium: '⚠M', low: '⚠L' } as const

const DARK_TEXT = '#111418'
const LIGHT_TEXT = '#ffffff'

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** The text color with the higher WCAG contrast on a #rrggbb background. White text on a bright fill is hard to read for color-blind users. */
export function textOn(background: string): string {
  const l = luminance(background)
  return (l + 0.05) / (luminance(DARK_TEXT) + 0.05) > 1.05 / (l + 0.05) ? DARK_TEXT : LIGHT_TEXT
}
