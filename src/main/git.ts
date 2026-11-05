import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type ChangeStatus, type Commit, type CommitRange, type FileChange, NOT_COMMITTED_ID, type ReviewComment, type ReviewFilter, type Reviewer, type ReviewSummary } from '../shared/types'
import { isCodePath } from './languages'
import { LocalRevisions } from './local'
import { rangeEnds } from './range'
import type { ReviewSource, ReviewTarget } from './source'

/** The GitHub CLI installer adds gh to the PATH, but an app that was open during the install does not see the new PATH. */
const GH_INSTALL_PATH = 'C:\\Program Files\\GitHub CLI\\gh.exe'

/** The command that starts the GitHub CLI. */
export const GH_COMMAND = existsSync(GH_INSTALL_PATH) ? GH_INSTALL_PATH : 'gh'

const REMOTE = 'origin'

/** Git marks a submodule entry with this mode. A submodule has no text to review. */
const SUBMODULE_MODE = '160000'

const PR_FIELDS = 'number,id,title,author,createdAt,state,isDraft,reviewDecision,headRefName,baseRefName,headRefOid,baseRefOid'

/** GitHub returns at most 100 items of a list in one GraphQL request. The app asks for more pages until the list ends. */
const PAGE_SIZE = 100

const PAGE_INFO = 'pageInfo { hasNextPage endCursor }'
const COMMENT_FIELDS = 'databaseId author { login } body createdAt'

/** A query for one page of a list of the pull request. $after is the cursor of the previous page. */
function pullRequestPageQuery(list: string, fields: string): string {
  return `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { ${list}(first: ${PAGE_SIZE}, after: $after) { nodes { ${fields} } ${PAGE_INFO} } }
  }
}`
}

const ISSUE_COMMENTS_QUERY = pullRequestPageQuery('comments', COMMENT_FIELDS)
const REVIEWS_QUERY = pullRequestPageQuery('reviews', 'databaseId author { login } body state submittedAt')
const THREADS_QUERY = pullRequestPageQuery('reviewThreads', `id isResolved path line originalLine comments(first: ${PAGE_SIZE}) { nodes { ${COMMENT_FIELDS} } ${PAGE_INFO} }`)

/** The next page of the comments of one thread. Only a thread with more than PAGE_SIZE comments needs it. */
const THREAD_COMMENTS_QUERY = `query($id: ID!, $after: String) {
  node(id: $id) { ... on PullRequestReviewThread { comments(first: ${PAGE_SIZE}, after: $after) { nodes { ${COMMENT_FIELDS} } ${PAGE_INFO} } } }
}`

const RESOLVE_MUTATION = 'mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { isResolved } } }'

interface GhAuthor {
  login: string
}

interface GhPullRequest {
  number: number
  id: string
  title: string
  author: GhAuthor | null
  createdAt: string
  state: string
  isDraft: boolean
  reviewDecision: string
  headRefName: string
  baseRefName: string
  headRefOid: string
  baseRefOid: string
}

interface GhComment {
  databaseId: number
  author: GhAuthor | null
  body: string
  createdAt: string
}

interface GhPage<T> {
  nodes: T[]
  pageInfo: { hasNextPage: boolean; endCursor: string | null }
}

type GhReview = Omit<GhComment, 'createdAt'> & { state: string; submittedAt: string }

interface GhThread {
  id: string
  isResolved: boolean
  path: string
  line: number | null
  originalLine: number | null
  comments: GhPage<GhComment>
}

/** Reviews of a GitHub repository. The pull requests come from gh, and the file revisions come from the local git clone. */
export class GitSource implements ReviewSource {
  readonly kind = 'github'
  private readonly gh = GH_COMMAND
  /** Revision ids are numbers in the model. Git names a blob by its hash, so this map holds the hash of each revision id. */
  private readonly blobs = new Map<number, string>()
  private readonly headCommits = new Map<number, string>()
  private readonly local = new LocalRevisions()
  private repository?: { owner: string; name: string }

  constructor(private readonly workspace: string) {}

  private run(command: string, args: string[], input?: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd: this.workspace, windowsHide: true, env: { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' } })
      const out: Buffer[] = []
      const err: Buffer[] = []
      child.stdout.on('data', (d: Buffer) => out.push(d))
      child.stderr.on('data', (d: Buffer) => err.push(d))
      child.on('error', reject)
      child.on('close', (code) => {
        const stdout = Buffer.concat(out)
        if (code === 0) resolve(stdout)
        else reject(new Error(`${command === this.gh ? 'gh' : command} ${args[0]} failed (${code}): ${Buffer.concat(err).toString('utf8') || stdout.toString('utf8')}`))
      })
      child.stdin.end(input ?? '')
    })
  }

  private async git(args: string[], input?: string): Promise<string> {
    return (await this.run('git', args, input)).toString('utf8')
  }

  private async ghJson<T>(args: string[], input?: string): Promise<T> {
    return JSON.parse((await this.run(this.gh, args, input)).toString('utf8')) as T
  }

  /** Owner and name of the repository, from the URL of the remote. */
  private repo(): { owner: string; name: string } {
    if (this.repository) return this.repository
    const url = execFileSync('git', ['config', '--get', `remote.${REMOTE}.url`], { cwd: this.workspace, windowsHide: true }).toString('utf8').trim()
    const match = /github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(url)
    if (!match) throw new Error(`The remote '${REMOTE}' is not a GitHub repository: ${url}`)
    this.repository = { owner: match[1], name: match[2] }
    return this.repository
  }

  async whoami(): Promise<string> {
    return (await this.run(this.gh, ['api', 'user', '--jq', '.login'])).toString('utf8').trim()
  }

  async workspaceBranch(): Promise<string> {
    return (await this.git(['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
  }

  async listReviews(filter: ReviewFilter): Promise<ReviewSummary[]> {
    const list = (args: string[]): Promise<GhPullRequest[]> => this.ghJson(['pr', 'list', '--limit', '100', '--json', PR_FIELDS, ...args])
    const lists =
      filter === 'assigned'
        ? await Promise.all([list(['--search', 'review-requested:@me']), list(['--search', 'reviewed-by:@me'])])
        : [await list(filter === 'mine' ? ['--author', '@me', '--state', 'all'] : ['--state', 'all'])]
    const byNumber = new Map(lists.flat().map((pr) => [pr.number, pr]))
    return [...byNumber.values()].sort((a, b) => b.number - a.number).map(toSummary)
  }

  reviewKey(reviewId: number): string {
    const { owner, name } = this.repo()
    return `github:${owner}/${name}#${reviewId}`
  }

  async readReview(reviewId: number, range?: CommitRange): Promise<ReviewTarget> {
    const pr = await this.ghJson<GhPullRequest>(['pr', 'view', String(reviewId), '--json', PR_FIELDS])
    this.headCommits.set(pr.number, pr.headRefOid)
    await this.fetchCommits([pr.baseRefOid, pr.headRefOid], [`refs/heads/${pr.baseRefName}`, `refs/pull/${pr.number}/head`])
    const base = (await this.git(['merge-base', pr.baseRefOid, pr.headRefOid])).trim()
    return { review: toSummary(pr), branch: pr.headRefName, ...(await this.readCommits(base, pr.headRefOid, range)) }
  }

  /** A branch without a pull request shows the changes since it left the default branch of the remote. */
  async readBranch(branch: string, range?: CommitRange): Promise<ReviewTarget> {
    const name = branch.trim()
    const defaultBranch = (await this.git(['rev-parse', '--abbrev-ref', `${REMOTE}/HEAD`]).catch(() => `${REMOTE}/main`)).trim()
    const base = (await this.git(['merge-base', defaultBranch, name])).trim()
    return { branch: name, ...(await this.readCommits(base, name, range)) }
  }

  /**
   * The commits that are not pushed, plus one entry for the changes that are not committed yet.
   * The base is the fork point with the upstream branch. A branch without an upstream starts at the default branch of the remote.
   */
  async readLocal(range?: CommitRange): Promise<ReviewTarget> {
    const branch = await this.workspaceBranch()
    const upstream = await this.git(['rev-parse', '--abbrev-ref', '@{upstream}']).catch(() => this.git(['rev-parse', '--abbrev-ref', `${REMOTE}/HEAD`]).catch(() => `${REMOTE}/main`))
    const [base, head] = await Promise.all([this.git(['merge-base', upstream.trim(), 'HEAD']), this.git(['rev-parse', 'HEAD'])])
    const commits = await this.commits(base.trim(), head.trim())
    commits.push({ id: NOT_COMMITTED_ID, parentId: head.trim(), title: 'Changes that are not committed', author: '', date: new Date().toISOString() })
    const { from, to } = range ? rangeEnds(commits, range) : { from: base.trim(), to: NOT_COMMITTED_ID }
    return { branch, commits, files: to === NOT_COMMITTED_ID ? await this.diffWorkingTree(from) : await this.diff(from, to) }
  }

  /** The changes from a commit to the files on disk, staged or not. Untracked files that git does not ignore count as added. */
  private async diffWorkingTree(from: string): Promise<FileChange[]> {
    const root = (await this.git(['rev-parse', '--show-toplevel'])).trim()
    const files = await this.diff(from, undefined, root)
    const untracked = (await this.git(['ls-files', '--others', '--exclude-standard', '--full-name', '-z', ':/'])).split('\0').filter(Boolean)
    for (const path of untracked) {
      files.push({ path: '/' + path, status: 'A', itemType: 'F', baseRevId: 0, headRevId: this.local.add(join(root, path)), isCode: isCodePath(path) })
    }
    return files
  }

  /** Lists the commits from base to head and the files of the whole change, or of the range only. */
  private async readCommits(base: string, head: string, range?: CommitRange): Promise<{ commits: Commit[]; files: FileChange[] }> {
    const commits = await this.commits(base, head)
    if (!range) return { commits, files: await this.diff(base, head) }
    const { from, to } = rangeEnds(commits, range)
    return { commits, files: await this.diff(from, to) }
  }

  /** 'git log' prints one record per commit. The fields are split by the unit separator, and the records by the record separator. */
  private async commits(base: string, head: string): Promise<Commit[]> {
    const out = await this.git(['log', '--reverse', '--first-parent', '--format=%H%x1f%P%x1f%an%x1f%aI%x1f%s%x1e', `${base}..${head}`])
    return out
      .split('\x1e')
      .map((record) => record.trim())
      .filter(Boolean)
      .map((record) => {
        const [id, parents, author, date, title] = record.split('\x1f')
        return { id, parentId: parents.split(' ')[0] ?? base, title, author, date }
      })
  }

  /** Fetches only the commits that are missing. A fetch does not change the working tree or the current branch. */
  private async fetchCommits(commits: string[], refs: string[]): Promise<void> {
    const present = await Promise.all(commits.map((c) => this.git(['cat-file', '-e', `${c}^{commit}`]).then(() => true, () => false)))
    if (present.every(Boolean)) return
    await this.git(['fetch', '--no-tags', REMOTE, ...refs])
  }

  /**
   * 'git diff --raw -z' prints ':oldmode newmode oldhash newhash status', then one path, or two paths for a rename or a copy.
   * Without 'to', the diff goes to the files on disk. Git prints a hash of zeros for a file on disk, so the file in root gives the head revision.
   */
  private async diff(from: string, to?: string, root?: string): Promise<FileChange[]> {
    const fields = (await this.git(['diff', '--raw', '-z', '--no-abbrev', '-M', '--no-ext-diff', from, ...(to ? [to] : [])])).split('\0')
    const files: FileChange[] = []
    for (let i = 0; i < fields.length; i++) {
      if (!fields[i].startsWith(':')) continue
      const [oldMode, newMode, oldHash, newHash, letter] = fields[i].slice(1).split(' ')
      const twoPaths = letter.startsWith('R') || letter.startsWith('C')
      const srcPath = twoPaths ? fields[++i] : undefined
      const path = fields[++i]
      if (oldMode === SUBMODULE_MODE || newMode === SUBMODULE_MODE) continue
      files.push({
        path: '/' + path,
        srcPath: letter.startsWith('R') && srcPath ? '/' + srcPath : undefined,
        status: changeStatus(letter),
        itemType: 'F',
        baseRevId: letter.startsWith('C') ? 0 : this.revisionId(oldHash),
        headRevId: root && letter !== 'D' && /^0+$/.test(newHash) ? this.local.add(join(root, path)) : this.revisionId(newHash),
        isCode: isCodePath(path)
      })
    }
    return files
  }

  /** The first 13 hex digits of the hash fit in a safe JavaScript integer. A hash of zeros means no file, so the id is 0. */
  private revisionId(hash: string): number {
    const id = parseInt(hash.slice(0, 13), 16)
    if (id > 0) this.blobs.set(id, hash)
    return id
  }

  /** 'git cat-file --batch' prints '<hash> blob <size>', a new line, the content and one more new line for each hash. */
  async fetchRevisions(revIds: number[], dir: string): Promise<void> {
    mkdirSync(dir, { recursive: true })
    const wanted = [...new Set(this.local.fetch(revIds, dir))].filter((id) => id > 0 && this.blobs.has(id) && !existsSync(join(dir, String(id))))
    if (wanted.length === 0) return
    const out = await this.run('git', ['cat-file', '--batch'], wanted.map((id) => this.blobs.get(id)).join('\n') + '\n')
    let at = 0
    for (const id of wanted) {
      const lineEnd = out.indexOf(0x0a, at)
      const header = out.subarray(at, lineEnd).toString('utf8').split(' ')
      at = lineEnd + 1
      if (header[1] !== 'blob') continue
      const size = Number(header[2])
      writeFileSync(join(dir, String(id)), out.subarray(at, at + size))
      at += size + 1
    }
  }

  /** Reads all pages of a list. variableArgs are gh flags such as '-f', 'owner=x'. The first page has no cursor. Each next page starts after the end cursor of the page before it. */
  private async allPages<T>(query: string, variableArgs: string[], page: (data: unknown) => GhPage<T>): Promise<T[]> {
    const items: T[] = []
    let after: string | null = null
    do {
      const args = ['api', 'graphql', '-f', `query=${query}`, ...variableArgs, ...(after ? ['-f', `after=${after}`] : [])]
      const result = page((await this.ghJson<{ data: unknown }>(args)).data)
      items.push(...result.nodes)
      after = result.pageInfo.hasNextPage ? result.pageInfo.endCursor : null
    } while (after)
    return items
  }

  async comments(reviewId: number): Promise<ReviewComment[]> {
    const { owner, name } = this.repo()
    const variables = ['-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${reviewId}`]
    type PullRequestData = { repository: { pullRequest: Record<string, GhPage<never>> } }
    const list = <T>(query: string, field: string): Promise<T[]> =>
      this.allPages<T>(query, variables, (data) => (data as PullRequestData).repository.pullRequest[field] as GhPage<T>)
    const [issueComments, reviews, threads] = await Promise.all([
      list<GhComment>(ISSUE_COMMENTS_QUERY, 'comments'),
      list<GhReview>(REVIEWS_QUERY, 'reviews'),
      list<GhThread>(THREADS_QUERY, 'reviewThreads')
    ])
    for (const thread of threads) {
      if (!thread.comments.pageInfo.hasNextPage) continue
      const rest = await this.allPages<GhComment>(THREAD_COMMENTS_QUERY, ['-f', `id=${thread.id}`], (data) => (data as { node: GhThread }).node.comments)
      thread.comments.nodes = rest
    }
    const comments: ReviewComment[] = []
    const base = { parentId: -1, revisionId: 0, changeset: 0, type: 'comment' }
    for (const c of issueComments) {
      comments.push({ ...base, id: c.databaseId, guid: `issue:${c.databaseId}`, owner: login(c.author), date: c.createdAt, text: c.body })
    }
    for (const r of reviews) {
      const label = REVIEW_STATES[r.state]
      if (label) comments.push({ ...base, type: 'timeline', id: r.databaseId, guid: `review:${r.databaseId}`, owner: login(r.author), date: r.submittedAt, text: `[${label}]${r.body}` })
      else if (r.state !== 'PENDING' && r.body.trim()) {
        comments.push({ ...base, id: r.databaseId, guid: `reviewbody:${r.databaseId}`, owner: login(r.author), date: r.submittedAt, text: r.body, cannotDelete: true })
      }
    }
    for (const thread of threads) {
      const [root, ...replies] = thread.comments.nodes
      if (!root) continue
      const guid = (c: GhComment): string => `thread:${thread.id}:${c.databaseId}`
      comments.push({
        ...base,
        id: root.databaseId,
        guid: guid(root),
        owner: login(root.author),
        date: root.createdAt,
        text: root.body,
        file: '/' + thread.path,
        line: thread.line ?? thread.originalLine ?? undefined,
        resolved: thread.isResolved
      })
      for (const c of replies) comments.push({ ...base, parentId: root.databaseId, id: c.databaseId, guid: guid(c), owner: login(c.author), date: c.createdAt, text: c.body })
    }
    return comments.sort((a, b) => a.date.localeCompare(b.date))
  }

  async reviewers(reviewId: number): Promise<Reviewer[]> {
    const pr = await this.ghJson<{ reviewRequests: { login?: string; name?: string }[]; latestReviews: { author: GhAuthor | null; state: string }[] }>([
      'pr',
      'view',
      String(reviewId),
      '--json',
      'reviewRequests,latestReviews'
    ])
    const reviewers = new Map<string, Reviewer>()
    for (const r of pr.latestReviews) reviewers.set(login(r.author), { user: login(r.author), status: REVIEWER_STATES[r.state] ?? 'Under review', type: 'Reviewer' })
    for (const r of pr.reviewRequests) {
      const user = r.login ?? r.name ?? ''
      if (user) reviewers.set(user, { user, status: 'Under review', type: 'Requested' })
    }
    return [...reviewers.values()]
  }

  /**
   * GitHub accepts a line comment only on a line that the diff shows, with its context lines.
   * A comment on any other line goes on the whole file, with the line number in the text.
   */
  async addComment(reviewId: number, text: string, path?: string, line?: number): Promise<void> {
    if (!path || !line) {
      await this.run(this.gh, ['pr', 'comment', String(reviewId), '--body-file', '-'], text)
      return
    }
    const commit = this.headCommits.get(reviewId) ?? (await this.ghJson<GhPullRequest>(['pr', 'view', String(reviewId), '--json', 'headRefOid'])).headRefOid
    const endpoint = `repos/${this.repo().owner}/${this.repo().name}/pulls/${reviewId}/comments`
    const filePath = path.replace(/^\//, '')
    const post = (fields: object): Promise<Buffer> => this.run(this.gh, ['api', endpoint, '--method', 'POST', '--input', '-'], JSON.stringify(fields))
    await post({ body: text, commit_id: commit, path: filePath, line, side: 'RIGHT' }).catch(() =>
      post({ body: `Line ${line}: ${text}`, commit_id: commit, path: filePath, subject_type: 'file' })
    )
  }

  /** A reply to a general comment is a new general comment, because GitHub has no threads for general comments. Discard resolves the thread. */
  async replyComment(reviewId: number, guid: string, text: string, discard: boolean): Promise<void> {
    const [kind, threadId, commentId] = guid.split(':')
    if (kind !== 'thread') {
      if (text.trim()) await this.run(this.gh, ['pr', 'comment', String(reviewId), '--body-file', '-'], text)
      return
    }
    const { owner, name } = this.repo()
    if (text.trim()) {
      await this.run(this.gh, ['api', `repos/${owner}/${name}/pulls/${reviewId}/comments/${commentId}/replies`, '--method', 'POST', '--input', '-'], JSON.stringify({ body: text }))
    }
    if (discard) await this.run(this.gh, ['api', 'graphql', '-f', `query=${RESOLVE_MUTATION}`, '-f', `id=${threadId}`])
  }

  /** The guid kind picks the endpoint: "issue" is a general comment, "thread" a line comment, and "reviewbody" the text of a review. */
  async editComment(reviewId: number, guid: string, text: string): Promise<void> {
    const { owner, name } = this.repo()
    const [kind, first, second] = guid.split(':')
    const endpoint =
      kind === 'issue'
        ? `repos/${owner}/${name}/issues/comments/${first}`
        : kind === 'thread'
          ? `repos/${owner}/${name}/pulls/comments/${second}`
          : kind === 'reviewbody'
            ? `repos/${owner}/${name}/pulls/${reviewId}/reviews/${first}`
            : undefined
    if (!endpoint) throw new Error('GitHub cannot edit this kind of comment')
    await this.run(this.gh, ['api', endpoint, '--method', kind === 'reviewbody' ? 'PUT' : 'PATCH', '--input', '-'], JSON.stringify({ body: text }))
  }

  async deleteComment(_reviewId: number, guid: string): Promise<void> {
    const { owner, name } = this.repo()
    const [kind, first, second] = guid.split(':')
    const endpoint = kind === 'issue' ? `repos/${owner}/${name}/issues/comments/${first}` : kind === 'thread' ? `repos/${owner}/${name}/pulls/comments/${second}` : undefined
    if (!endpoint) throw new Error('GitHub cannot delete this kind of comment')
    await this.run(this.gh, ['api', endpoint, '--method', 'DELETE'])
  }

  async setMyStatus(reviewId: number, status: string, comment?: string): Promise<void> {
    if (status === 'reviewed') await this.run(this.gh, ['pr', 'review', String(reviewId), '--approve', '--body-file', '-'], comment ?? '')
    else if (status === 'rework-required') await this.run(this.gh, ['pr', 'review', String(reviewId), '--request-changes', '--body-file', '-'], comment || 'Rework required')
    else throw new Error(`GitHub has no reviewer status '${status}'`)
  }
}

const REVIEW_STATES: Record<string, string> = { APPROVED: 'Approved', CHANGES_REQUESTED: 'Changes requested', DISMISSED: 'Dismissed' }

const REVIEWER_STATES: Record<string, string> = { APPROVED: 'Reviewed', CHANGES_REQUESTED: 'Rework required' }

function login(author: GhAuthor | null): string {
  return author?.login ?? 'ghost'
}

function changeStatus(letter: string): ChangeStatus {
  if (letter === 'A' || letter.startsWith('C')) return 'A'
  if (letter === 'D') return 'D'
  if (letter.startsWith('R')) return 'M'
  return 'C'
}

function reviewStatus(pr: GhPullRequest): string {
  if (pr.state === 'MERGED') return 'Merged'
  if (pr.state === 'CLOSED') return 'Closed'
  if (pr.isDraft) return 'Draft'
  if (pr.reviewDecision === 'APPROVED') return 'Reviewed'
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return 'Rework required'
  return 'Under review'
}

function toSummary(pr: GhPullRequest): ReviewSummary {
  return {
    id: pr.number,
    guid: pr.id,
    title: pr.title,
    owner: login(pr.author),
    date: pr.createdAt,
    status: reviewStatus(pr),
    assignee: '',
    targetType: 'branch',
    targetId: 0
  }
}
