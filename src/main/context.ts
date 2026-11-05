import { structuredPatch } from 'diff'
import type { Cluster, GraphNode, ReviewComment, ReviewModel } from '../shared/types'
import { isOpenThread } from '../shared/threads'
import { codeLanguage } from './languages'
import type { ReviewService } from './review'

/** Lines of code shown above and below a commented line. */
const EXCERPT_RADIUS = 6

export function clusterRelations(model: ReviewModel, cluster: Cluster): string[] {
  const ids = new Set(cluster.nodeIds)
  const byId = new Map(model.nodes.map((n) => [n.id, n]))
  const relations: string[] = []
  for (const edge of model.edges) {
    const source = byId.get(edge.source)
    const target = byId.get(edge.target)
    if (edge.kind !== 'calls' || !source || !target) continue
    if (ids.has(edge.source) && !ids.has(edge.target)) relations.push(`- ${source.qualifiedName} calls ${target.qualifiedName} (${target.file})`)
    if (!ids.has(edge.source) && ids.has(edge.target)) relations.push(`- ${source.qualifiedName} (${source.file}) calls ${target.qualifiedName}`)
  }
  return relations
}

/** Returns the unified diff of one file as lines. A range keeps only the hunks that touch those head lines. */
export function fileDiff(service: ReviewService, model: ReviewModel, path: string, range?: { from: number; to: number; side: 'head' | 'base' }): string[] {
  const file = model.files.find((f) => f.path === path)
  if (!file) return []
  const base = service.readRevision(file.baseRevId) ?? ''
  const head = service.readRevision(file.headRevId) ?? ''
  return structuredPatch(path, path, base, head, 'base', 'head', { context: 3 })
    .hunks.filter((h) => {
      if (!range) return true
      const start = range.side === 'head' ? h.newStart : h.oldStart
      const length = range.side === 'head' ? h.newLines : h.oldLines
      return start <= range.to && start + Math.max(length, 1) - 1 >= range.from
    })
    .flatMap((h) => [`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, ...h.lines])
}

/** Builds markdown diff blocks for every file of a cluster until the line budget runs out. */
export function clusterDiff(service: ReviewService, model: ReviewModel, cluster: Cluster, budget: number): string[] {
  const parts: string[] = []
  for (const path of cluster.files) {
    if (budget <= 0) {
      parts.push(`(diff of ${path} left out: line budget used up)`)
      continue
    }
    const status = model.files.find((f) => f.path === path)?.status ?? '?'
    const lines = fileDiff(service, model, path)
    parts.push(`### ${path} (${status})`, '```diff', ...lines.slice(0, budget), '```')
    budget -= lines.length
  }
  return parts
}

export function nodeDiff(service: ReviewService, model: ReviewModel, node: GraphNode): string[] {
  return fileDiff(service, model, node.file, { from: node.startLine, to: node.endLine, side: node.side })
}

export function excerpt(text: string, line: number, radius = EXCERPT_RADIUS): string {
  const lines = text.split(/\r?\n/)
  const from = Math.max(1, line - radius)
  const to = Math.min(lines.length, line + radius)
  const out: string[] = []
  for (let n = from; n <= to; n++) out.push(`${n === line ? '>' : ' '}${String(n).padStart(5)} | ${lines[n - 1]}`)
  return out.join('\n')
}

export interface Thread {
  root: ReviewComment
  replies: ReviewComment[]
  open: boolean
}

/** Groups comments into threads. */
export function threadsOf(comments: ReviewComment[]): Thread[] {
  return comments
    .filter((c) => c.parentId === -1 && c.type !== 'timeline')
    .map((root) => {
      const replies = comments.filter((c) => c.parentId === root.id)
      return { root, replies, open: isOpenThread(root, replies) }
    })
}

export function shortUser(user: string): string {
  return user.replace(/@.*$/, '')
}

export async function renderThread(service: ReviewService, thread: Thread, title: string): Promise<string[]> {
  const { root } = thread
  const where = root.file ? `${root.file}${root.line ? `:${root.line}` : ''}` : 'whole review'
  const parts = [`## ${title}: ${root.type}${thread.open ? ' (open)' : ''} - ${where}`]
  if (root.revisionId > 0 && root.line) {
    const text = await service.ensureRevision(root.revisionId)
    if (text) parts.push('', 'Code the reviewer saw:', '', '```' + (codeLanguage(root.file ?? '') ?? ''), excerpt(text, root.line), '```')
  }
  parts.push('', 'Conversation:', '')
  for (const comment of [root, ...thread.replies]) {
    const indent = comment.id === root.id ? '' : '  '
    const label = comment.type === 'discarded' ? ' (marked as discarded)' : ''
    parts.push(`${indent}- **${shortUser(comment.owner)}**${label}: ${comment.text.replace(/\r?\n/g, `\n${indent}  `)}`)
  }
  return parts
}
