import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { type BpGraphDiff, diffBlueprint } from '../shared/bpdiff'
import { excludeMatcher } from '../shared/glob'
import { type Blueprint, type CommitRange, type FileChange, LOAD_CANCELLED, type ReviewComment, type ReviewModel } from '../shared/types'
import { buildGraph } from './graph'
import type { ReviewSource, ReviewTarget } from './source'
import { isUnrealPackage, readBlueprint } from './uasset'

/** Files above this size are not diffed or parsed. They are mostly generated code or data. */
const MAX_TEXT_BYTES = 2_000_000

/** Above this file count the graph gets slow and noisy, so the model gets a warning. */
const LARGE_CHANGE_FILES = 300

export class ReviewService {
  private readonly models = new Map<string, ReviewModel>()
  /** Parsed Blueprints by revision id. Null marks a revision without a Blueprint. */
  private readonly blueprints = new Map<number, Blueprint | null>()
  /** The user name on the server, read once. It marks the comments that the user may edit or delete. */
  private me?: Promise<string>
  /** One controller per running load. cancelLoads aborts them all. */
  private readonly loads = new Set<AbortController>()

  constructor(
    readonly source: ReviewSource,
    private readonly revisionDir: string,
    private readonly progress: (message: string, done?: number, total?: number) => void,
    /** Reads the exclude patterns at each load, so a settings change applies to the next review without a restart. */
    private readonly excludePatterns: () => string[] = () => []
  ) {}

  model(key: string): ReviewModel {
    const model = this.models.get(key)
    if (!model) throw new Error(`Review ${key} is not loaded`)
    return model
  }

  /** The id goes into cm queries as text, so it must be a plain positive integer. */
  loadReview(reviewId: number, range?: CommitRange): Promise<ReviewModel> {
    if (!Number.isSafeInteger(reviewId) || reviewId <= 0) return Promise.reject(new Error(`Not a review id: ${reviewId}`))
    return this.track((signal) => this.readReview(reviewId, signal, range))
  }

  /** git and cm read a name that starts with '-' as an option. The name can come from an MCP client, so the check stops option injection. */
  loadBranch(branch: string, range?: CommitRange): Promise<ReviewModel> {
    const name = branch.trim()
    if (!name || name.startsWith('-') || /[\x00-\x1f]/.test(name)) return Promise.reject(new Error(`Not a branch name: ${branch}`))
    return this.track((signal) => this.readBranch(name, signal, range))
  }

  loadLocal(range?: CommitRange): Promise<ReviewModel> {
    return this.track((signal) => this.readLocal(signal, range))
  }

  /** True while a load runs. The status bar then shows the Cancel button. */
  get loading(): boolean {
    return this.loads.size > 0
  }

  /** Stops all running loads at the next step. Files that are already downloaded stay in the cache for the next load. */
  cancelLoads(): void {
    for (const load of this.loads) load.abort()
  }

  /**
   * Runs a load that cancelLoads can stop. A failed load must clear the progress label, because MCP
   * calls do not go through the renderer, which also clears it.
   */
  private async track(load: (signal: AbortSignal) => Promise<ReviewModel>): Promise<ReviewModel> {
    const controller = new AbortController()
    this.loads.add(controller)
    try {
      return await load(controller.signal)
    } catch (e) {
      this.progress('')
      throw controller.signal.aborted ? new Error(LOAD_CANCELLED) : e
    } finally {
      this.loads.delete(controller)
    }
  }

  private async readReview(reviewId: number, signal: AbortSignal, range?: CommitRange): Promise<ReviewModel> {
    this.progress(`Reading review ${reviewId}`)
    const target = await this.source.readReview(reviewId, range)
    return this.build(this.source.reviewKey(reviewId), target, signal, range)
  }

  private async readBranch(branch: string, signal: AbortSignal, range?: CommitRange): Promise<ReviewModel> {
    this.progress(`Listing changes of ${branch.trim()}`)
    const target = await this.source.readBranch(branch, range)
    return this.build(`branch:${target.branch}`, target, signal, range)
  }

  private async readLocal(signal: AbortSignal, range?: CommitRange): Promise<ReviewModel> {
    this.progress('Listing the local changes')
    const target = await this.source.readLocal(range)
    return this.build(`local:${target.branch}`, target, signal, range, true)
  }

  /**
   * A range model gets its own key, so its reviewed marks, summaries and AI check stay apart from the
   * model of the whole review. A unit that changed again then shows as not reviewed.
   */
  private async build(reviewKey: string, { review, branch, commits, files: allFiles }: ReviewTarget, signal: AbortSignal, range?: CommitRange, local = false): Promise<ReviewModel> {
    signal.throwIfAborted()
    const key = range ? `${reviewKey}@${range.first}..${range.last}` : reviewKey
    const warnings: string[] = []
    const excluded = excludeMatcher(this.excludePatterns())
    const files = allFiles.filter((f) => !excluded(f.path))
    const hidden = allFiles.length - files.length
    if (hidden > 0) warnings.push(`${hidden} files are hidden by the exclude patterns in Settings (⚙).`)
    if (files.length > LARGE_CHANGE_FILES) warnings.push(`This change has ${files.length} files. The graph can be slow and crowded.`)
    const textFiles = files.filter((f) => f.itemType === 'F' || (f.itemType === 'B' && isBlueprintPath(f.path)))
    const revIds = textFiles.flatMap((f) => [f.baseRevId, f.headRevId])
    this.progress('Downloading file revisions')
    await this.source.fetchRevisions(revIds, this.revisionDir, (done, total) => this.progress('Downloading file revisions', done, total), signal)
    signal.throwIfAborted()
    const contents = new Map<number, string>()
    const blueprints = new Map<string, BpGraphDiff[]>()
    for (const file of textFiles) {
      if (isBlueprintPath(file.path)) {
        blueprints.set(file.path, this.blueprintDiff(file))
        continue
      }
      for (const id of [file.baseRevId, file.headRevId]) {
        const text = this.readRevision(id)
        if (text !== null) contents.set(id, text)
      }
    }
    this.progress('Parsing the code and building the graph')
    const graph = await buildGraph(files, contents, blueprints)
    signal.throwIfAborted()
    const comments = review ? await this.loadComments(review.id, files) : []
    const reviewers = review ? await this.source.reviewers(review.id) : []
    const model: ReviewModel = { key, source: this.source.kind, review, branch, commits, range, local, files, ...graph, comments, reviewers, warnings }
    this.models.set(key, model)
    this.progress('')
    return model
  }

  /**
   * A comment without a revision gets the head revision of its file, so the fix prompt can show the code around the line.
   * The comments of the current user get the mine mark.
   */
  private async loadComments(reviewId: number, files: FileChange[]): Promise<ReviewComment[]> {
    this.me ??= this.source.whoami().catch(() => '')
    const [comments, me] = await Promise.all([this.source.comments(reviewId), this.me])
    for (const comment of comments) {
      comment.mine = !!me && comment.type !== 'timeline' && comment.owner.toLowerCase() === me.toLowerCase()
      if (comment.revisionId > 0 || !comment.file) continue
      comment.revisionId = files.find((f) => f.path === comment.file)?.headRevId ?? 0
    }
    return comments
  }

  async refreshComments(key: string): Promise<ReviewComment[]> {
    const model = this.model(key)
    if (!model.review) return []
    model.comments = await this.loadComments(model.review.id, model.files)
    return model.comments
  }

  readRevision(revId: number): string | null {
    const path = join(this.revisionDir, String(revId))
    if (revId <= 0 || !existsSync(path) || statSync(path).size > MAX_TEXT_BYTES) return null
    return decodeText(readFileSync(path))
  }

  /** Reads a Blueprint revision. Returns undefined for a missing revision or an asset without graphs. */
  readBlueprint(revId: number): Blueprint | undefined {
    if (this.blueprints.has(revId)) return this.blueprints.get(revId) ?? undefined
    const path = join(this.revisionDir, String(revId))
    let blueprint: Blueprint | undefined
    if (revId > 0 && existsSync(path)) {
      const bytes = readFileSync(path)
      try {
        blueprint = isUnrealPackage(bytes) ? readBlueprint(bytes) : undefined
      } catch (e) {
        console.error(`Cannot read the Blueprint of revision ${revId}:`, e)
      }
    }
    this.blueprints.set(revId, blueprint ?? null)
    return blueprint
  }

  blueprintDiff(file: FileChange): BpGraphDiff[] {
    return diffBlueprint(this.readBlueprint(file.baseRevId), this.readBlueprint(file.headRevId))
  }

  async ensureRevision(revId: number): Promise<string | null> {
    await this.source.fetchRevisions([revId], this.revisionDir)
    return this.readRevision(revId)
  }
}

export function isBlueprintPath(path: string): boolean {
  return path.toLowerCase().endsWith('.uasset')
}

function decodeText(bytes: Buffer): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le')
  const text = bytes.toString('utf8')
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}
