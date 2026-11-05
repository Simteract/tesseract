import { randomUUID } from 'node:crypto'
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import windowIcon from '../../build/icon.ico?asset'
import type { CommitRange, Draft, Explanation, GraphNode, McpInfo, NewDraft, PreReview, PreReviewStatus, Progress, ReviewFilter, ReviewModel, Selection, Settings } from '../shared/types'
import { buildFixPrompt, EXPLAIN_BATCH, explainContext, launchClaude, preReview, summarizeCluster } from './claude'
import { initParsers } from './languages'
import { startMcpServer } from './mcp'
import { ReviewService } from './review'
import { openSource, sourceKind } from './source'
import { checkForUpdates, installUpdate, startUpdater, updateInfo } from './updater'

const DEFAULT_MCP_PORT = 47821

const settingsFile = (): string => join(app.getPath('userData'), 'settings.json')
const summariesFile = (): string => join(app.getPath('userData'), 'summaries.json')
const draftsFile = (): string => join(app.getPath('userData'), 'drafts.json')
const preReviewsFile = (): string => join(app.getPath('userData'), 'prereviews.json')
const explanationsFile = (): string => join(app.getPath('userData'), 'explanations.json')

let window: BrowserWindow | undefined
let settings: Settings = { workspace: '', me: '' }
let service: ReviewService | undefined
let summaries: Record<string, string> = {}
let preReviews: Record<string, PreReview> = {}
/** Explanations of context units, by explanationKey. The relation part depends on the change, so each review has its own explanations. */
let explanations: Record<string, Explanation> = {}
let drafts: Draft[] = []
let selection: Selection = {}
let mcpKey: string | undefined
let mcpInfo: McpInfo = { url: '', running: false, command: '', error: 'The MCP server did not start yet' }

function loadJson<T>(path: string, fallback: T): T {
  try {
    if (!existsSync(path)) return fallback
    const value = JSON.parse(readFileSync(path, 'utf8'))
    return Array.isArray(fallback) ? value : { ...fallback, ...value }
  } catch {
    return fallback
  }
}

/** A new revision of any file makes the saved pre-review stale. */
function preReviewKey(model: ReviewModel): string {
  return `${model.key}|${model.files.map((f) => f.headRevId).join(',')}`
}

/** A new revision of the file makes the saved explanation stale. */
function explanationKey(model: ReviewModel, node: GraphNode): string {
  return `${model.key}|${node.id}|${model.files.find((f) => f.path === node.file)?.headRevId ?? ''}`
}

/** Explanations saved before the relation part are plain strings. They are dropped, because they have no relation part. */
function loadExplanations(): Record<string, Explanation> {
  const saved = loadJson<Record<string, unknown>>(explanationsFile(), {})
  return Object.fromEntries(Object.entries(saved).filter(([, value]) => typeof value === 'object' && value !== null)) as Record<string, Explanation>
}

function savedExplanations(model: ReviewModel): Record<string, Explanation> {
  const found: Record<string, Explanation> = {}
  for (const node of model.nodes) {
    const text = node.role === 'context' ? explanations[explanationKey(model, node)] : undefined
    if (text) found[node.id] = text
  }
  return found
}

/** Claude runs at the same time for one explain request. More runs finish sooner but load the machine and the account limits. */
const EXPLAIN_RUNS = 3

/**
 * Explains the context units in batches, a few batches at a time, because each Claude run is slow.
 * Each batch saves its result when it ends, so a failed batch does not lose the others.
 */
async function explainUnits(modelKey: string, nodeIds: string[], force: boolean): Promise<Record<string, Explanation>> {
  const s = reviewService()
  const model = s.model(modelKey)
  const wanted = new Set(nodeIds)
  const nodes = model.nodes.filter((n) => wanted.has(n.id) && n.role === 'context' && (force || !explanations[explanationKey(model, n)]))
  const batches: GraphNode[][] = []
  for (let i = 0; i < nodes.length; i += EXPLAIN_BATCH) batches.push(nodes.slice(i, i + EXPLAIN_BATCH))
  const errors: unknown[] = []
  const worker = async (): Promise<void> => {
    for (let batch = batches.shift(); batch; batch = batches.shift()) {
      try {
        const result = await explainContext(s, model, batch, settings.workspace)
        for (const node of batch) if (result[node.id]) explanations[explanationKey(model, node)] = result[node.id]
        writeFileSync(explanationsFile(), JSON.stringify(explanations))
      } catch (e) {
        errors.push(e)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(EXPLAIN_RUNS, batches.length) }, worker))
  if (errors.length) throw errors[0]
  return savedExplanations(model)
}

/** Pre-reviews in progress, by model key. A second request for the same model waits for the first run. */
const runningPreReviews = new Map<string, Promise<PreReview>>()

/** Runs a pre-review and tells the window when it starts and ends, so the window shows the state for every caller. */
function startPreReview(modelKey: string): Promise<PreReview> {
  const running = runningPreReviews.get(modelKey)
  if (running) return running
  const s = reviewService()
  const model = s.model(modelKey)
  const send = (status: PreReviewStatus): void => window?.webContents.send('prereview', status)
  send({ modelKey, startedAt: Date.now() })
  const task = preReview(s, model, settings.workspace)
    .then((result) => {
      preReviews[preReviewKey(model)] = result
      writeFileSync(preReviewsFile(), JSON.stringify(preReviews))
      send({ modelKey, result })
      return result
    })
    .catch((e: unknown) => {
      send({ modelKey })
      throw e
    })
    .finally(() => runningPreReviews.delete(modelKey))
  runningPreReviews.set(modelKey, task)
  return task
}

function addDrafts(fields: NewDraft[]): Draft[] {
  const added = fields.map((f): Draft => ({ ...f, id: randomUUID(), createdAt: new Date().toISOString() }))
  drafts.push(...added)
  saveDrafts()
  return added
}

function saveDrafts(): void {
  writeFileSync(draftsFile(), JSON.stringify(drafts, null, 2))
  window?.webContents.send('drafts', drafts)
}

function progress(message: string, done?: number, total?: number): void {
  window?.webContents.send('progress', { message, done, total } satisfies Progress)
}

function reviewService(): ReviewService {
  if (!settings.workspace) throw new Error('Choose a workspace first')
  service ??= new ReviewService(openSource(settings.workspace), join(app.getPath('userData'), 'revisions'), progress, () => settings.excludePatterns ?? [])
  return service
}

async function applySettings(next: Partial<Settings>): Promise<Settings> {
  const workspace = next.workspace?.trim().replace(/[\\/]+$/, '')
  if (workspace && !existsSync(workspace)) throw new Error(`Folder not found: ${workspace}`)
  const workspaceChanged = workspace !== undefined && workspace !== settings.workspace
  const previous = settings.workspace
  settings = { ...settings, ...next, ...(workspace !== undefined ? { workspace } : {}) }
  const saved = settings.workspaces ?? (previous ? [previous] : [])
  settings.workspaces = saved
  if (settings.workspace && !saved.some((w) => w.toLowerCase() === settings.workspace.toLowerCase())) settings.workspaces = [...saved, settings.workspace]
  if (workspaceChanged) {
    service = undefined
    settings.me = settings.workspace ? await openSource(settings.workspace).whoami().catch(() => '') : ''
  }
  settings.source = settings.workspace ? sourceKind(settings.workspace) : undefined
  writeFileSync(settingsFile(), JSON.stringify(settings, null, 2))
  return settings
}

function registerIpc(): void {
  ipcMain.handle('settings:get', () => settings)
  ipcMain.handle('settings:set', (_e, next: Partial<Settings>) => applySettings(next))
  ipcMain.handle('dialog:folder', async () => {
    const options = { title: 'Choose a Plastic workspace or a git clone of a GitHub repository', properties: ['openDirectory' as const] }
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    return result.canceled ? undefined : result.filePaths[0]?.replace(/\\/g, '/')
  })
  ipcMain.handle('reviews:list', (_e, filter: ReviewFilter) => reviewService().source.listReviews(filter))
  ipcMain.handle('review:load', (_e, id: number, range?: CommitRange) => reviewService().loadReview(id, range))
  ipcMain.handle('branch:load', (_e, branch: string, range?: CommitRange) => reviewService().loadBranch(branch, range))
  ipcMain.handle('local:load', (_e, range?: CommitRange) => reviewService().loadLocal(range))
  ipcMain.handle('file:get', (_e, revId: number) => reviewService().readRevision(revId))
  ipcMain.handle('blueprint:diff', (_e, { modelKey, path }: { modelKey: string; path: string }) => {
    const service = reviewService()
    const file = service.model(modelKey).files.find((f) => f.path === path)
    return file ? service.blueprintDiff(file) : []
  })
  ipcMain.handle('comments:refresh', (_e, key: string) => reviewService().refreshComments(key))
  ipcMain.handle('comments:add', async (_e, a: { modelKey: string; text: string; path?: string; line?: number; type?: string }) => {
    const s = reviewService()
    const review = s.model(a.modelKey).review
    if (!review) throw new Error('A branch without a review cannot hold comments')
    await s.source.addComment(review.id, a.text, a.path, a.line, a.type)
    return s.refreshComments(a.modelKey)
  })
  ipcMain.handle('comments:reply', async (_e, a: { modelKey: string; guid: string; text: string; discard: boolean }) => {
    const s = reviewService()
    const review = s.model(a.modelKey).review
    if (!review) throw new Error('No review is loaded')
    await s.source.replyComment(review.id, a.guid, a.text, a.discard)
    return s.refreshComments(a.modelKey)
  })
  ipcMain.handle('comments:edit', async (_e, a: { modelKey: string; guid: string; text: string }) => {
    const s = reviewService()
    const review = s.model(a.modelKey).review
    if (!review) throw new Error('No review is loaded')
    await s.source.editComment(review.id, a.guid, a.text)
    return s.refreshComments(a.modelKey)
  })
  ipcMain.handle('comments:delete', async (_e, a: { modelKey: string; guid: string }) => {
    const s = reviewService()
    const review = s.model(a.modelKey).review
    if (!review) throw new Error('No review is loaded')
    await s.source.deleteComment(review.id, a.guid)
    return s.refreshComments(a.modelKey)
  })
  ipcMain.handle('review:status', async (_e, a: { modelKey: string; status: string; comment?: string }) => {
    const s = reviewService()
    const review = s.model(a.modelKey).review
    if (!review) throw new Error('No review is loaded')
    await s.source.setMyStatus(review.id, a.status, a.comment)
    return s.source.reviewers(review.id)
  })
  ipcMain.handle('cluster:summarize', async (_e, a: { modelKey: string; clusterId: string; force?: boolean }) => {
    const s = reviewService()
    const model = s.model(a.modelKey)
    const cluster = model.clusters.find((c) => c.id === a.clusterId)
    if (!cluster) throw new Error('Unknown cluster')
    const revs = cluster.files.map((p) => model.files.find((f) => f.path === p)?.headRevId).join(',')
    const cacheKey = `${model.key}|${cluster.label}|${revs}`
    if (!a.force && summaries[cacheKey]) return summaries[cacheKey]
    const summary = await summarizeCluster(s, model, cluster, settings.workspace)
    summaries[cacheKey] = summary
    writeFileSync(summariesFile(), JSON.stringify(summaries))
    return summary
  })
  ipcMain.handle('context:get', (_e, modelKey: string) => savedExplanations(reviewService().model(modelKey)))
  ipcMain.handle('context:explain', (_e, a: { modelKey: string; nodeIds: string[]; force?: boolean }) => explainUnits(a.modelKey, a.nodeIds, !!a.force))
  ipcMain.handle('context:clear', (_e, a: { modelKey: string; nodeIds: string[] }) => {
    const model = reviewService().model(a.modelKey)
    const prefixes = a.nodeIds.map((id) => `${model.key}|${id}|`)
    for (const key of Object.keys(explanations)) if (prefixes.some((p) => key.startsWith(p))) delete explanations[key]
    writeFileSync(explanationsFile(), JSON.stringify(explanations))
    return savedExplanations(model)
  })
  ipcMain.handle('ai:clear', () => {
    explanations = {}
    summaries = {}
    preReviews = {}
    writeFileSync(explanationsFile(), '{}')
    writeFileSync(summariesFile(), '{}')
    writeFileSync(preReviewsFile(), '{}')
  })
  ipcMain.handle('prereview:get', (_e, modelKey: string) => preReviews[preReviewKey(reviewService().model(modelKey))] ?? null)
  ipcMain.handle('prereview:run', (_e, modelKey: string) => startPreReview(modelKey))
  ipcMain.handle('claude:prompt', (_e, a: { modelKey: string; threadIds: number[]; note: string }) => {
    const s = reviewService()
    return buildFixPrompt(s, s.model(a.modelKey), a.threadIds, a.note, settings.workspace)
  })
  ipcMain.handle('claude:send', async (_e, a: { modelKey: string; threadIds: number[]; note: string; ignoreBranch: boolean }) => {
    const s = reviewService()
    const model = s.model(a.modelKey)
    if (!a.ignoreBranch && !model.branch.startsWith('cs:')) {
      const current = await s.source.workspaceBranch()
      if (current !== model.branch) {
        return { launched: false, branchWarning: `The workspace is on ${current}, but the review is for ${model.branch}. Switch the workspace first, or continue anyway.` }
      }
    }
    const prompt = await buildFixPrompt(s, model, a.threadIds, a.note, settings.workspace)
    const promptFile = launchClaude(join(app.getPath('userData'), 'claude-runs'), settings.workspace, prompt)
    return { launched: true, promptFile }
  })
  ipcMain.handle('mcp:info', () => mcpInfo)
  ipcMain.handle('update:get', () => updateInfo())
  ipcMain.on('update:check', () => void checkForUpdates())
  ipcMain.on('update:install', () => installUpdate())
  ipcMain.on('selection', (_e, next: Selection) => {
    selection = next
    mcpKey = next.modelKey ?? mcpKey
  })
  ipcMain.handle('drafts:list', () => drafts)
  ipcMain.handle('drafts:delete', (_e, id: string) => {
    drafts = drafts.filter((d) => d.id !== id)
    saveDrafts()
    return drafts
  })
  ipcMain.handle('drafts:add', (_e, fields: NewDraft[]) => addDrafts(fields))
  ipcMain.handle('drafts:post', async (_e, a: { id: string; text: string; type?: string }) => {
    const draft = drafts.find((d) => d.id === a.id)
    if (!draft) throw new Error('The draft does not exist anymore')
    const s = reviewService()
    const review = s.model(draft.modelKey).review
    if (!review) throw new Error('A branch without a review cannot hold comments')
    if (draft.kind === 'reply') {
      if (!draft.guid) throw new Error('The draft has no thread')
      await s.source.replyComment(review.id, draft.guid, a.text, draft.discard ?? false)
    } else {
      await s.source.addComment(review.id, a.text, draft.path, draft.line, a.type ?? draft.type)
    }
    drafts = drafts.filter((d) => d.id !== a.id)
    saveDrafts()
    return s.refreshComments(draft.modelKey)
  })
}

async function startMcp(): Promise<void> {
  const port = settings.mcpPort ?? DEFAULT_MCP_PORT
  mcpInfo = await startMcpServer(
    {
      service: reviewService,
      activeKey: () => mcpKey,
      open: (model, show) => {
        mcpKey = model.key
        if (!show) return
        selection = { modelKey: model.key }
        window?.webContents.send('mcp:open', model)
      },
      select: (nodeId) => {
        selection = { modelKey: mcpKey, nodeId }
        window?.webContents.send('mcp:select', nodeId)
      },
      selection: () => selection,
      listReviews: (filter) => reviewService().source.listReviews(filter),
      addDraft: (fields) => addDrafts([fields])[0]
    },
    port
  )
}

/**
 * The top bar of the app is the title bar of the window. Windows draws its own window buttons on top
 * of the right end. The height is 1 pixel less than the top bar, so the border under the bar stays visible.
 */
const TITLE_BAR_OVERLAY = { color: '#1d2026', symbolColor: '#e3e6eb', height: 41 }

/**
 * The window shows review text from other people. A link in that text must not load a page in the
 * window or open a new window, because such a page would get the preload API.
 */
function blockNavigation(target: BrowserWindow): void {
  const appUrl = target.webContents.getURL.bind(target.webContents)
  target.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  target.webContents.on('will-navigate', (event, url) => {
    if (url !== appUrl()) event.preventDefault()
  })
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 1680,
    height: 1020,
    title: 'Tesseract',
    icon: windowIcon,
    backgroundColor: '#16181d',
    titleBarStyle: 'hidden',
    titleBarOverlay: TITLE_BAR_OVERLAY,
    autoHideMenuBar: true,
    webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, sandbox: true }
  })
  blockNavigation(window)
  if (process.env['ELECTRON_RENDERER_URL']) window.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else window.loadFile(join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(async () => {
  settings = loadJson(settingsFile(), settings)
  settings.source = settings.workspace && existsSync(settings.workspace) ? sourceKind(settings.workspace) : undefined
  summaries = loadJson(summariesFile(), {})
  explanations = loadExplanations()
  preReviews = loadJson(preReviewsFile(), {})
  drafts = loadJson<Draft[]>(draftsFile(), [])
  const modules = join(app.getAppPath(), 'node_modules')
  await initParsers(join(modules, 'web-tree-sitter', 'web-tree-sitter.wasm'), {
    cpp: join(modules, 'tree-sitter-cpp', 'tree-sitter-cpp.wasm'),
    rust: join(modules, 'tree-sitter-rust', 'tree-sitter-rust.wasm')
  })
  registerIpc()
  await startMcp()
  createWindow()
  startUpdater((info) => window?.webContents.send('update', info))
})

app.on('window-all-closed', () => app.quit())
