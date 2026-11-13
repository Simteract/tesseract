import { createServer } from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import type { Draft, GraphNode, McpInfo, ReviewFilter, ReviewModel, ReviewSummary, Selection } from '../shared/types'
import { clusterDiff, clusterRelations, diffFence, nodeDiff, renderThread, shortUser, threadsOf } from './context'
import { codeLanguage } from './languages'
import type { ReviewService } from './review'

/** Upper limit of diff lines that get_cluster returns. It keeps one answer inside the context of the client. */
const CLUSTER_DIFF_LINES = 1500

/** Upper limit of source lines that get_node shows for a unit without a diff. */
const SOURCE_LINES = 120

const INSTRUCTIONS = [
  'Tesseract is a code review app for Plastic SCM and GitHub. These tools read the review that is open in the app. On GitHub, a review is a pull request.',
  'Start with get_overview. It lists clusters (groups of related changes) and the suggested reading path.',
  'draft_comment and draft_reply do not post anything. They create drafts that the user posts or discards in the app.'
].join(' ')

/** The parts of the app that the MCP tools use. index.ts implements it. */
export interface McpHost {
  service(): ReviewService
  activeKey(): string | undefined
  open(model: ReviewModel, show: boolean): void
  select(nodeId: string): void
  selection(): Selection
  listReviews(filter: ReviewFilter): Promise<ReviewSummary[]>
  addDraft(draft: Omit<Draft, 'id' | 'createdAt'>): Draft
}

type ToolResult = { content: { type: 'text'; text: string }[] }

const text = (lines: string | string[]): ToolResult => ({
  content: [{ type: 'text', text: Array.isArray(lines) ? lines.join('\n') : lines }]
})

export function mcpCommand(url: string): string {
  return `claude mcp add --transport http --scope user tesseract ${url}`
}

/**
 * Starts the MCP endpoint on localhost. A failure to listen does not stop the app. A browser sends
 * an Origin header and an MCP client does not, so the endpoint refuses requests with an Origin.
 */
export function startMcpServer(host: McpHost, port: number): Promise<McpInfo> {
  const url = `http://127.0.0.1:${port}/mcp`
  const server = createServer(async (req, res) => {
    if (!req.url?.startsWith('/mcp')) {
      res.writeHead(404).end()
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' }).end()
      return
    }
    if (req.headers.origin) {
      res.writeHead(403).end('Requests from web pages are not allowed')
      return
    }
    const mcp = buildMcp(host)
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      enableDnsRebindingProtection: true,
      allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`]
    })
    res.on('close', () => {
      void transport.close()
      void mcp.close()
    })
    try {
      await mcp.connect(transport)
      await transport.handleRequest(req, res)
    } catch (e) {
      if (!res.headersSent) res.writeHead(500).end(String(e))
    }
  })
  return new Promise((resolve) => {
    server.once('error', (e) => resolve({ url, running: false, error: e.message, command: mcpCommand(url) }))
    server.listen(port, '127.0.0.1', () => resolve({ url, running: true, command: mcpCommand(url) }))
  })
}

function buildMcp(host: McpHost): McpServer {
  const mcp = new McpServer({ name: 'tesseract', version: '0.1.0' }, { instructions: INSTRUCTIONS })

  const active = (): ReviewModel => {
    const key = host.activeKey()
    if (!key) throw new Error('No review is open. Call open_review first.')
    return host.service().model(key)
  }

  const nodeById = (model: ReviewModel, id: string): GraphNode => {
    const node = model.nodes.find((n) => n.id === id)
    if (!node) throw new Error(`Unknown node ${id}. Take node ids from get_overview or get_cluster.`)
    return node
  }

  mcp.registerTool(
    'list_reviews',
    {
      title: 'List code reviews',
      description: 'Lists code reviews (Plastic reviews or GitHub pull requests). "assigned" are the reviews where the user is a reviewer, "mine" are the reviews the user created.',
      inputSchema: { filter: z.enum(['assigned', 'mine', 'recent']).default('assigned') }
    },
    async ({ filter }) => {
      const reviews = await host.listReviews(filter)
      if (!reviews.length) return text('No reviews found.')
      return text(reviews.map((r) => `- ${r.id} | ${r.status} | ${r.title} | by ${shortUser(r.owner)} | ${r.date}`))
    }
  )

  mcp.registerTool(
    'open_review',
    {
      title: 'Open a review',
      description:
        'Loads a code review by id, the changes of a branch without a review, or the local changes that are not pushed or checked in yet. The other tools then work on it. Returns the overview.',
      inputSchema: {
        review_id: z.number().int().optional().describe('Plastic code review id, or GitHub pull request number'),
        branch: z.string().optional().describe('Branch name such as /main/task-123 in Plastic or feature/x in git, used when there is no review'),
        local: z.boolean().optional().describe('Open the local changes of the workspace: unpushed commits and changes that are not committed (git), or pending changes (Plastic)'),
        show_in_app: z.boolean().default(true).describe('Also show the review in the app window')
      }
    },
    async ({ review_id, branch, local, show_in_app }) => {
      const service = host.service()
      let model: ReviewModel
      if (review_id !== undefined) model = await service.loadReview(review_id)
      else if (branch) model = await service.loadBranch(branch)
      else if (local) model = await service.loadLocal()
      else throw new Error('Give review_id, branch or local')
      host.open(model, show_in_app)
      return text(overview(model))
    }
  )

  mcp.registerTool(
    'get_overview',
    {
      title: 'Review overview',
      description: 'Shows the open review: files, clusters of related changes, the suggested reading path, and the number of open threads.'
    },
    async () => text(overview(active()))
  )

  mcp.registerTool(
    'get_cluster',
    {
      title: 'Cluster details',
      description: 'Shows one cluster: its units, its calls to and from code outside the cluster, and the diff of its files.',
      inputSchema: { cluster_id: z.string() }
    },
    async ({ cluster_id }) => {
      const model = active()
      const cluster = model.clusters.find((c) => c.id === cluster_id)
      if (!cluster) throw new Error(`Unknown cluster ${cluster_id}`)
      const nodes = cluster.nodeIds.map((id) => nodeById(model, id))
      const relations = clusterRelations(model, cluster)
      return text([
        `# Cluster ${cluster.id}: ${cluster.label}`,
        `+${cluster.added} -${cluster.removed}, ${nodes.length} units`,
        '',
        '## Units',
        ...nodes.map(nodeLine),
        '',
        '## Relations to code outside the cluster',
        ...(relations.length ? relations : ['(none found)']),
        '',
        '## Diff',
        ...clusterDiff(host.service(), model, cluster, CLUSTER_DIFF_LINES)
      ])
    }
  )

  mcp.registerTool(
    'get_node',
    {
      title: 'Unit details',
      description: 'Shows one unit (a function, the declarations of a class, or a whole file): who calls it, what it calls, comments on it, and its diff.',
      inputSchema: { node_id: z.string() }
    },
    async ({ node_id }) => text(describeNode(host.service(), active(), nodeById(active(), node_id)))
  )

  mcp.registerTool(
    'get_threads',
    {
      title: 'Discussion threads',
      description: 'Shows the review comments as threads, with the code the reviewer saw. An open thread is a change request that nobody discarded yet.',
      inputSchema: {
        open_only: z.boolean().default(false),
        file: z.string().optional().describe('Only threads on files whose path contains this text')
      }
    },
    async ({ open_only, file }) => {
      const service = host.service()
      const model = active()
      const threads = threadsOf(model.comments).filter((t) => (!open_only || t.open) && (!file || t.root.file?.includes(file)))
      if (!threads.length) return text('No threads match.')
      const parts = [`${threads.length} threads. Reply with draft_reply and the thread id.`]
      for (const thread of threads) parts.push('', ...(await renderThread(service, thread, `Thread ${thread.root.id}`)))
      return text(parts)
    }
  )

  mcp.registerTool(
    'draft_comment',
    {
      title: 'Draft a review comment',
      description: 'Creates a draft comment in the app. The user reads it and decides to post it to the review or to discard it.',
      inputSchema: {
        text: z.string().min(1),
        path: z.string().optional().describe('Workspace path of a changed file, as get_overview shows it'),
        line: z.number().int().positive().optional().describe('1-based line in the new version of the file'),
        type: z.enum(['comment', 'change', 'question']).default('comment').describe('"change" is a change request')
      }
    },
    async ({ text: body, path, line, type }) => {
      const model = active()
      if (!model.review) throw new Error('This branch has no code review, so it cannot hold comments')
      if ((line === undefined) !== (path === undefined)) throw new Error('Give path and line together, or neither for a general comment')
      if (path && !model.files.some((f) => f.path === path)) throw new Error(`${path} is not a changed file of this review`)
      const cmType = type[0].toUpperCase() + type.slice(1)
      const draft = host.addDraft({ modelKey: model.key, kind: 'comment', text: body, path, line, type: path ? cmType : undefined })
      return text(`Draft ${draft.id} is in the app. It is not posted until the user approves it.`)
    }
  )

  mcp.registerTool(
    'draft_reply',
    {
      title: 'Draft a reply',
      description: 'Creates a draft reply to a thread. Set discard to true to say that the change request is done or rejected. The user approves it in the app.',
      inputSchema: {
        thread_id: z.number().int(),
        text: z.string().min(1),
        discard: z.boolean().default(false)
      }
    },
    async ({ thread_id, text: body, discard }) => {
      const model = active()
      const root = model.comments.find((c) => c.id === thread_id)
      if (!root) throw new Error(`Unknown thread ${thread_id}. Take ids from get_threads.`)
      const draft = host.addDraft({ modelKey: model.key, kind: 'reply', text: body, threadId: root.id, guid: root.guid, discard })
      return text(`Draft ${draft.id} is in the app. It is not posted until the user approves it.`)
    }
  )

  mcp.registerTool(
    'show_in_app',
    {
      title: 'Show a unit in the app',
      description: 'Selects a unit in the graph of the app, so the user sees its code. Use it to point the user at something.',
      inputSchema: { node_id: z.string() }
    },
    async ({ node_id }) => {
      const node = nodeById(active(), node_id)
      host.select(node.id)
      return text(`The app now shows ${node.qualifiedName}.`)
    }
  )

  mcp.registerTool(
    'get_selection',
    {
      title: 'What the user looks at',
      description: 'Returns the unit that the user selected in the app, with its details. Use it when the user says "this" or "here".'
    },
    async () => {
      const { modelKey, nodeId } = host.selection()
      if (!modelKey) return text('The user has no review open.')
      const model = host.service().model(modelKey)
      const node = nodeId ? model.nodes.find((n) => n.id === nodeId) : undefined
      if (!node) return text(`Open review: ${title(model)}. No unit is selected.`)
      return text([`Open review: ${title(model)}`, '', ...describeNode(host.service(), model, node)])
    }
  )

  return mcp
}

function title(model: ReviewModel): string {
  return model.review ? `${model.review.title} (review ${model.review.id})` : `branch ${model.branch}`
}

function nodeLine(node: GraphNode): string {
  const change = node.role === 'changed' ? ` +${node.added} -${node.removed}` : ' (context)'
  return `- ${node.id} | ${node.qualifiedName} | ${node.file}:${node.startLine}${change}`
}

function overview(model: ReviewModel): string[] {
  const threads = threadsOf(model.comments)
  const path = model.nodes.filter((n) => n.order !== undefined).sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  return [
    `# ${title(model)}`,
    `Branch: ${model.branch}`,
    model.review ? `Status: ${model.review.status}, owner ${shortUser(model.review.owner)}` : '',
    `Reviewers: ${model.reviewers.map((r) => `${shortUser(r.user)} (${r.status})`).join(', ') || 'none'}`,
    `Threads: ${threads.filter((t) => t.open).length} open of ${threads.length}`,
    ...model.warnings.map((w) => `Warning: ${w}`),
    '',
    `## Files (${model.files.length})`,
    ...model.files.map((f) => `- ${f.status} ${f.path}`),
    '',
    '## Clusters',
    ...model.clusters.map((c) => `- ${c.id} | ${c.label} | ${c.nodeIds.length} units, +${c.added} -${c.removed} | ${c.files.join(', ')}`),
    '',
    '## Reading path (node ids for get_node)',
    ...path.map(nodeLine)
  ].filter((line, i) => line !== '' || i > 0)
}

function describeNode(service: ReviewService, model: ReviewModel, node: GraphNode): string[] {
  const byId = new Map(model.nodes.map((n) => [n.id, n]))
  const calls = model.edges.filter((e) => e.kind === 'calls')
  const callers = calls.filter((e) => e.target === node.id).map((e) => byId.get(e.source)?.qualifiedName)
  const callees = calls.filter((e) => e.source === node.id).map((e) => byId.get(e.target)?.qualifiedName)
  const cluster = model.clusters.find((c) => c.id === node.clusterId)
  const comments = model.comments.filter((c) => c.file === node.file && c.line !== undefined && c.line >= node.startLine && c.line <= node.endLine)
  const parts = [
    `# ${node.qualifiedName}`,
    `${node.kind}, ${node.role}, ${node.file}:${node.startLine}-${node.endLine} (${node.side} side), +${node.added} -${node.removed}`,
    cluster ? `Cluster: ${cluster.id} (${cluster.label})` : '',
    `Called by: ${callers.filter(Boolean).join(', ') || 'nothing found'}`,
    `Calls: ${callees.filter(Boolean).join(', ') || 'nothing found'}`,
    comments.length ? `Comments: ${comments.map((c) => `#${c.id} ${shortUser(c.owner)} line ${c.line}: ${c.text.split(/\r?\n/)[0]}`).join(' | ')}` : ''
  ].filter(Boolean)
  const diff = nodeDiff(service, model, node)
  if (diff.length) return [...parts, '', '## Diff', diffFence(node.file), ...diff, '```']
  const file = model.files.find((f) => f.path === node.file)
  const source = file ? service.readRevision(node.side === 'head' ? file.headRevId : file.baseRevId) : null
  if (!source) return parts
  const lines = source.split(/\r?\n/).slice(node.startLine - 1, Math.min(node.endLine, node.startLine - 1 + SOURCE_LINES))
  return [...parts, '', '## Source', '```' + (codeLanguage(node.file) ?? ''), ...lines, '```']
}
