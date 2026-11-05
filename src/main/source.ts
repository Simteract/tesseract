import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Commit, CommitRange, FileChange, ReviewComment, ReviewFilter, Reviewer, ReviewSummary, SourceKind } from '../shared/types'
import { Cm } from './cm'
import { GitSource } from './git'
import { LocalRevisions } from './local'
import { rangeEnds } from './range'

export type DownloadProgress = (done: number, total: number) => void

export interface ReviewTarget {
  review?: ReviewSummary
  branch: string
  /** All commits of the review, oldest first. */
  commits: Commit[]
  files: FileChange[]
}

/** The version control server that holds the reviews: Plastic through cm, or GitHub through git and gh. */
export interface ReviewSource {
  readonly kind: SourceKind
  whoami(): Promise<string>
  /** The branch that the workspace has now. */
  workspaceBranch(): Promise<string>
  listReviews(filter: ReviewFilter): Promise<ReviewSummary[]>
  /** The model key of a review. Saved summaries and explanations use the key. */
  reviewKey(reviewId: number): string
  /** A range limits the files to the changes of those commits. */
  readReview(reviewId: number, range?: CommitRange): Promise<ReviewTarget>
  readBranch(branch: string, range?: CommitRange): Promise<ReviewTarget>
  /** The changes in the workspace that are not pushed or checked in yet. The head side of a file is the file on disk. */
  readLocal(range?: CommitRange): Promise<ReviewTarget>
  /** Writes each revision to dir/<revId>. Revisions that are already there are not read again. onProgress counts only the revisions to download. */
  fetchRevisions(revIds: number[], dir: string, onProgress?: DownloadProgress): Promise<void>
  /** All comments of a review. Each comment on a file has its file path set. */
  comments(reviewId: number): Promise<ReviewComment[]>
  reviewers(reviewId: number): Promise<Reviewer[]>
  addComment(reviewId: number, text: string, path?: string, line?: number, type?: string): Promise<void>
  replyComment(reviewId: number, guid: string, text: string, discard: boolean): Promise<void>
  /** Changes only the text. The type, file and line of the comment stay. */
  editComment(reviewId: number, guid: string, text: string): Promise<void>
  deleteComment(reviewId: number, guid: string): Promise<void>
  setMyStatus(reviewId: number, status: string, comment?: string): Promise<void>
}

/**
 * A Plastic workspace has a '.plastic' folder, and a git clone has a '.git' folder. Plastic wins when
 * a folder has both, for example a workspace that GitSync mirrors. A folder with neither stays
 * Plastic, because cm also finds the workspace from a subfolder.
 */
export function sourceKind(workspace: string): SourceKind {
  if (existsSync(join(workspace, '.plastic'))) return 'plastic'
  return existsSync(join(workspace, '.git')) ? 'github' : 'plastic'
}

export function openSource(workspace: string): ReviewSource {
  return sourceKind(workspace) === 'github' ? new GitSource(workspace) : new PlasticSource(new Cm(workspace))
}

const PLASTIC_QUERIES: Record<ReviewFilter, string> = {
  assigned: "where assignee='me' order by modifieddate desc limit 100",
  mine: "where owner='me' order by modifieddate desc limit 100",
  recent: 'order by modifieddate desc limit 100'
}

export class PlasticSource implements ReviewSource {
  readonly kind = 'plastic'
  private readonly local = new LocalRevisions()

  constructor(private readonly cm: Cm) {}

  whoami(): Promise<string> {
    return this.cm.whoami()
  }

  workspaceBranch(): Promise<string> {
    return this.cm.workspaceBranch()
  }

  listReviews(filter: ReviewFilter): Promise<ReviewSummary[]> {
    return this.cm.findReviews(PLASTIC_QUERIES[filter])
  }

  reviewKey(reviewId: number): string {
    return `review:${reviewId}`
  }

  async readReview(reviewId: number, range?: CommitRange): Promise<ReviewTarget> {
    const [review] = await this.cm.findReviews(`where id=${reviewId}`)
    if (!review) throw new Error(`Review ${reviewId} not found`)
    if (review.targetType.toLowerCase() === 'branch') {
      const branch = await this.cm.branchName(review.targetId)
      return { review, ...(await this.readBranch(branch, range)) }
    }
    const changeset = await this.cm.changesetNumber(review.targetId)
    return { review, branch: `cs:${changeset}`, commits: [], files: await this.cm.diffChangeset(changeset) }
  }

  async readBranch(branch: string, range?: CommitRange): Promise<ReviewTarget> {
    const name = branch.replace(/^br:/, '').trim()
    const commits = await this.cm.branchChangesets(name)
    if (!range) return { branch: name, commits, files: await this.cm.diffBranch(name) }
    const { from, to } = rangeEnds(commits, range)
    return { branch: name, commits, files: await this.cm.diffRange(from, to) }
  }

  /** Plastic has no local commits: a checkin goes to the server. So the pending changes are one block, without commits. */
  async readLocal(): Promise<ReviewTarget> {
    const [branch, files] = await Promise.all([this.cm.workspaceBranch(), this.cm.pendingChanges(this.local)])
    return { branch, commits: [], files }
  }

  fetchRevisions(revIds: number[], dir: string, onProgress?: DownloadProgress): Promise<void> {
    return this.cm.fetchRevisions(this.local.fetch(revIds, dir), dir, onProgress)
  }

  async comments(reviewId: number): Promise<ReviewComment[]> {
    const comments = await this.cm.findComments(reviewId)
    const paths = await this.cm.revisionPaths(comments.map((c) => c.revisionId))
    for (const comment of comments) comment.file = paths.get(comment.revisionId)
    return comments
  }

  reviewers(reviewId: number): Promise<Reviewer[]> {
    return this.cm.reviewers(reviewId)
  }

  addComment(reviewId: number, text: string, path?: string, line?: number, type?: string): Promise<void> {
    return this.cm.addComment(reviewId, text, path, line, type)
  }

  replyComment(_reviewId: number, guid: string, text: string, discard: boolean): Promise<void> {
    return this.cm.replyComment(guid, text, discard)
  }

  editComment(_reviewId: number, guid: string, text: string): Promise<void> {
    return this.cm.editComment(guid, text)
  }

  deleteComment(_reviewId: number, guid: string): Promise<void> {
    return this.cm.deleteComment(guid)
  }

  setMyStatus(reviewId: number, status: string, comment?: string): Promise<void> {
    return this.cm.setMyStatus(reviewId, status, comment)
  }
}
