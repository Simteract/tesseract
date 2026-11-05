import type { ReviewComment } from './types'

/** A GitHub thread is open until somebody resolves it. A Plastic change request is open until a reply discards it. */
export function isOpenThread(root: ReviewComment, replies: ReviewComment[]): boolean {
  if (root.resolved !== undefined) return !root.resolved
  return root.type === 'change' && !replies.some((r) => r.type === 'discarded')
}
