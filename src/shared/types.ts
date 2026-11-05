import type { BpGraphDiff } from './bpdiff'

export interface ReviewSummary {
  id: number
  guid: string
  title: string
  owner: string
  date: string
  status: string
  assignee: string
  targetType: string
  targetId: number
}

/** The server that holds the reviews. */
export type SourceKind = 'plastic' | 'github'

export type ChangeStatus = 'A' | 'C' | 'D' | 'M'

export interface FileChange {
  path: string
  srcPath?: string
  status: ChangeStatus
  itemType: string
  baseRevId: number
  headRevId: number
  isCode: boolean
}

export type UnitKind = 'function' | 'declarations' | 'file' | 'blueprint'

export type NodeRole = 'changed' | 'context'

export interface GraphNode {
  id: string
  label: string
  qualifiedName: string
  className?: string
  kind: UnitKind
  role: NodeRole
  file: string
  /** 1-based first line in the head file, or in the base file when the unit was deleted. */
  startLine: number
  endLine: number
  side: 'head' | 'base'
  added: number
  removed: number
  clusterId?: string
  /** Position in the suggested reading path. Context nodes have no position. */
  order?: number
}

export type EdgeKind = 'calls' | 'declares'

/** Claude explanation of a context unit in one review. */
export interface Explanation {
  /** What the unit does. */
  does: string
  /** How the change affects the unit, or how the unit affects the change. Empty when Claude found no effect. */
  relation: string
}

export interface GraphEdge {
  id: string
  source: string
  target: string
  kind: EdgeKind
}

export interface Cluster {
  id: string
  label: string
  nodeIds: string[]
  files: string[]
  added: number
  removed: number
}

export interface ReviewComment {
  id: number
  guid: string
  owner: string
  date: string
  text: string
  type: string
  parentId: number
  revisionId: number
  line?: number
  changeset: number
  file?: string
  /** Set only on GitHub thread roots. A Plastic thread is open while it is a change request without a discard reply. */
  resolved?: boolean
  /** True when the current user wrote the comment, so the user can edit or delete it. */
  mine?: boolean
  /** True for a comment that the server lets the user edit but not delete, for example the text of a GitHub review. */
  cannotDelete?: boolean
}

export interface Reviewer {
  user: string
  status: string
  type: string
}

/** A Plastic changeset or a git commit of the reviewed branch. The id is the changeset number or the commit hash. */
export interface Commit {
  id: string
  /** The commit before this one. A diff from parentId shows the changes of this commit. */
  parentId: string
  title: string
  author: string
  date: string
}

/** The id of the commit entry that stands for the changes that are not committed yet. */
export const NOT_COMMITTED_ID = 'not-committed'

/** Commits to review, from the first one to the last one, both included. */
export interface CommitRange {
  first: string
  last: string
}

export interface ReviewModel {
  /** The review key, plus the range when the model shows only part of the commits. */
  key: string
  source: SourceKind
  review?: ReviewSummary
  branch: string
  /** All commits of the review, oldest first. It is empty when the source cannot list them. */
  commits: Commit[]
  /** Set when the model shows only some of the commits. */
  range?: CommitRange
  /** Set when the model shows the local changes that are not pushed or checked in yet. */
  local?: boolean
  files: FileChange[]
  nodes: GraphNode[]
  edges: GraphEdge[]
  clusters: Cluster[]
  comments: ReviewComment[]
  reviewers: Reviewer[]
  warnings: string[]
}

export interface Settings {
  workspace: string
  /** Saved workspace paths for quick switching. */
  workspaces?: string[]
  me: string
  /** The server of the current workspace. The main process sets it. */
  source?: SourceKind
  /** Port of the local MCP endpoint. The default is 47821. */
  mcpPort?: number
  /** Glob patterns of files that a review hides, for example "*.dll". See shared/glob.ts for the rules. */
  excludePatterns?: string[]
}

export type ReviewFilter = 'assigned' | 'mine' | 'recent'

export interface ClaudeLaunchResult {
  launched: boolean
  branchWarning?: string
  promptFile?: string
}

/** A comment or reply that an AI wrote through MCP. It stays local until the user posts it. */
export interface Draft {
  id: string
  modelKey: string
  kind: 'comment' | 'reply'
  text: string
  path?: string
  line?: number
  type?: string
  threadId?: number
  guid?: string
  discard?: boolean
  createdAt: string
}

export type NewDraft = Omit<Draft, 'id' | 'createdAt'>

/** What the user looks at in the app. MCP clients read it with get_selection. */
export interface Selection {
  modelKey?: string
  nodeId?: string
}

export interface McpInfo {
  url: string
  running: boolean
  error?: string
  /** The command that registers the server in Claude Code for the current user. */
  command: string
}

/** A pin of a Blueprint node. Links point to pins of other nodes by node name and pin GUID. */
export interface BpPin {
  id: string
  name: string
  label?: string
  direction: 'in' | 'out'
  /** The pin category, for example exec, bool, real, object or struct. */
  category: string
  /** The class, struct or enum of the pin, when the category needs one. */
  type?: string
  container?: string
  /** The default value that the user typed. */
  value?: string
  /** The default value that the node made itself. The view shows it only when it changes. */
  autoValue?: string
  hidden: boolean
  links: { node: string; pin: string }[]
}

export interface BpNode {
  /** The object name of the node, for example K2Node_CallFunction_12. It stays the same across saves. */
  id: string
  className: string
  title: string
  x: number
  y: number
  width?: number
  height?: number
  comment?: string
  props: Record<string, string>
  pins: BpPin[]
  /** Set when the reader could not read the whole node. */
  error?: string
}

export interface BpGraph {
  name: string
  nodes: BpNode[]
}

export interface Blueprint {
  className: string
  parent?: string
  graphs: BpGraph[]
}

/**
 * The state of the auto updater. 'dev' means that the app does not run from an installer, so it cannot update.
 * 'latest' means that no newer version exists. 'ready' means that the new version is downloaded.
 */
export type UpdateState =
  | { state: 'none' }
  | { state: 'dev' }
  | { state: 'checking' }
  | { state: 'latest'; checkedAt: string }
  | { state: 'downloading'; version: string; percent: number }
  | { state: 'ready'; version: string }
  | { state: 'error'; message: string }

/** The updater state together with the version of the running app. */
export type UpdateInfo = UpdateState & { current: string }

export type HotspotLevel = 'high' | 'medium' | 'low'

/** A changed unit that the AI pre-review asks the reviewer to check with care. */
export interface Hotspot {
  nodeId: string
  level: HotspotLevel
  title: string
  reason: string
}

export interface PreReview {
  createdAt: string
  overview: string
  /** Most important first. */
  hotspots: Hotspot[]
}

/** A pre-review runs while startedAt is set. A finished run carries its result, a failed run has none. */
export interface PreReviewStatus {
  modelKey: string
  startedAt?: number
  result?: PreReview
}

/** The status label of a long task. Done and total are set when the task can count its steps, for example downloads. */
export interface Progress {
  message: string
  done?: number
  total?: number
}

export interface Api {
  getSettings(): Promise<Settings>
  setSettings(settings: Partial<Settings>): Promise<Settings>
  /** Opens the folder dialog. Returns undefined when the user cancels. */
  pickFolder(): Promise<string | undefined>
  listReviews(filter: ReviewFilter): Promise<ReviewSummary[]>
  loadReview(reviewId: number, range?: CommitRange): Promise<ReviewModel>
  loadBranch(branch: string, range?: CommitRange): Promise<ReviewModel>
  /** Loads the local changes that are not pushed (git) or not checked in (Plastic) yet. */
  loadLocal(range?: CommitRange): Promise<ReviewModel>
  getFile(revId: number): Promise<string | null>
  getBlueprintDiff(args: { modelKey: string; path: string }): Promise<BpGraphDiff[]>
  refreshComments(modelKey: string): Promise<ReviewComment[]>
  addComment(args: { modelKey: string; text: string; path?: string; line?: number; type?: string }): Promise<ReviewComment[]>
  replyComment(args: { modelKey: string; guid: string; text: string; discard: boolean }): Promise<ReviewComment[]>
  editComment(args: { modelKey: string; guid: string; text: string }): Promise<ReviewComment[]>
  deleteComment(args: { modelKey: string; guid: string }): Promise<ReviewComment[]>
  setMyStatus(args: { modelKey: string; status: 'reviewed' | 'rework-required' | 'under-review'; comment?: string }): Promise<Reviewer[]>
  summarizeCluster(args: { modelKey: string; clusterId: string; force?: boolean }): Promise<string>
  /** Saved explanations of the context units of a model, by node id. */
  savedExplanations(modelKey: string): Promise<Record<string, Explanation>>
  /** Asks Claude to explain context units. Returns all saved explanations of the model, by node id. */
  explainContext(args: { modelKey: string; nodeIds: string[]; force?: boolean }): Promise<Record<string, Explanation>>
  /** Deletes the saved explanations of the units and returns the explanations that stay. */
  clearExplanations(args: { modelKey: string; nodeIds: string[] }): Promise<Record<string, Explanation>>
  /** Deletes all saved AI results of all reviews: explanations, cluster summaries and pre-reviews. */
  clearAiResults(): Promise<void>
  /** The saved pre-review of the current revisions, if there is one. */
  getPreReview(modelKey: string): Promise<PreReview | null>
  runPreReview(modelKey: string): Promise<PreReview>
  onPreReview(listener: (status: PreReviewStatus) => void): () => void
  buildClaudePrompt(args: { modelKey: string; threadIds: number[]; note: string }): Promise<string>
  sendToClaude(args: { modelKey: string; threadIds: number[]; note: string; ignoreBranch: boolean }): Promise<ClaudeLaunchResult>
  onProgress(listener: (progress: Progress) => void): () => void
  getMcpInfo(): Promise<McpInfo>
  getUpdate(): Promise<UpdateInfo>
  onUpdate(listener: (info: UpdateInfo) => void): () => void
  installUpdate(): void
  checkForUpdates(): void
  reportSelection(selection: Selection): void
  onOpenModel(listener: (model: ReviewModel) => void): () => void
  onSelect(listener: (nodeId: string) => void): () => void
  listDrafts(): Promise<Draft[]>
  onDrafts(listener: (drafts: Draft[]) => void): () => void
  addDrafts(fields: NewDraft[]): Promise<Draft[]>
  /** The type overrides the type of a line comment draft. */
  postDraft(args: { id: string; text: string; type?: string }): Promise<ReviewComment[]>
  deleteDraft(id: string): Promise<Draft[]>
}
