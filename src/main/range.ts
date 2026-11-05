import type { Commit, CommitRange } from '../shared/types'

/** The two ends of a range diff. The diff starts at the parent of the first commit, so the first commit is part of the diff. */
export function rangeEnds(commits: Commit[], range: CommitRange): { from: string; to: string } {
  const first = commits.find((c) => c.id === range.first)
  const last = commits.find((c) => c.id === range.last)
  if (!first || !last) throw new Error('The chosen commits are not part of this review any more. Open the review again.')
  return { from: first.parentId, to: last.id }
}
