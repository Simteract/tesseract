import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  type CommitRange,
  type Draft,
  type Explanation,
  type GraphNode,
  type HotspotLevel,
  LOAD_CANCELLED,
  type PreReview,
  type Progress,
  type ReviewComment,
  type ReviewModel,
  type Settings,
  type Walkthrough,
  type WalkthroughLevel
} from '../../shared/types'
import { AssetPanel } from './AssetPanel'
import { BlueprintPanel } from './BlueprintPanel'
import { CodePanel } from './CodePanel'
import { CommitsMenu } from './CommitsMenu'
import { Discussion } from './Discussion'
import { GraphView } from './GraphView'
import { Inbox } from './Inbox'
import { Navigator } from './Navigator'
import { hotspotDraft, NodeContext } from './NodeContext'
import { formatSeconds, PreReviewPanel } from './PreReviewPanel'
import { ReviewStatus } from './ReviewStatus'
import { SettingsPanel } from './SettingsPanel'
import { Splitter } from './Splitter'
import { StatusBar } from './StatusBar'
import { WalkthroughPanel } from './WalkthroughPanel'
import { WorkspacePicker } from './WorkspacePicker'
import { DEFAULT_LAYOUT, nodeForComment, parseOpenTarget, readLayout, readReviewed, readStepsDone, writeLayout, writeReviewed, writeStepsDone, type Layout, type LeftPanel } from './util'

/** The graph keeps at least this width, so a wide side panel cannot push it out of the window. */
const MIN_GRAPH_WIDTH = 200
/** A status bar notice hides itself after this time. */
const NOTICE_SECONDS = 10
const ACTIVITY_BAR_WIDTH = 52
const MIN_LEFT_WIDTH = 220
const MAX_LEFT_WIDTH = 900
const MIN_SIDE_WIDTH = 360
const MIN_CONTEXT_HEIGHT = 60
/** The code below the unit context keeps at least this height. */
const MIN_CODE_HEIGHT = 200

/** Seconds since startedAt, updated once a second. It is 0 when startedAt is undefined. */
function useElapsedSeconds(startedAt: number | undefined): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (startedAt === undefined) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [startedAt])
  return startedAt === undefined ? 0 : Math.max(0, Math.floor((now - startedAt) / 1000))
}

function walkKey(modelKey: string, level: WalkthroughLevel): string {
  return `${modelKey}|${level}`
}

export interface CommentTarget {
  path: string
  line: number
}

export function App(): React.JSX.Element {
  const [settings, setSettings] = useState<Settings>({ workspace: '', me: '' })
  const [model, setModel] = useState<ReviewModel>()
  const [selectedId, setSelectedId] = useState<string>()
  const [progress, setProgress] = useState<Progress>()
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [reviewed, setReviewed] = useState<Set<string>>(new Set())
  const [commentTarget, setCommentTarget] = useState<CommentTarget>()
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [layout, setLayout] = useState<Layout>(readLayout)
  const [preReview, setPreReview] = useState<{ modelKey: string; result: PreReview }>()
  /** Start time of each running pre-review, by model key. */
  const [preReviewing, setPreReviewing] = useState<Record<string, number>>({})
  const [focusThread, setFocusThread] = useState<{ id: number }>()
  /** Claude explanations of context units, by node id. The model key keeps a late answer away from another review. */
  const [explanations, setExplanations] = useState<{ modelKey: string; byId: Record<string, Explanation> }>()
  const [explaining, setExplaining] = useState<Set<string>>(new Set())
  const [walkLevel, setWalkLevel] = useState<WalkthroughLevel>('new')
  /** Saved walkthroughs, by walkKey. */
  const [walkthroughs, setWalkthroughs] = useState<Record<string, Walkthrough>>({})
  /** Start time of each running walkthrough, by walkKey. */
  const [walking, setWalking] = useState<Record<string, number>>({})
  const [walkPosition, setWalkPosition] = useState(0)
  const [stepsDone, setStepsDone] = useState<Set<number>>(new Set())
  const side = useRef<HTMLElement>(null)

  useEffect(
    () =>
      window.api.onPreReview(({ modelKey, startedAt, result }) => {
        setPreReviewing(({ [modelKey]: _, ...rest }) => (startedAt ? { ...rest, [modelKey]: startedAt } : rest))
        if (result) setPreReview({ modelKey, result })
      }),
    []
  )

  useEffect(
    () =>
      window.api.onWalkthrough(({ modelKey, level, startedAt, result }) => {
        const key = walkKey(modelKey, level)
        setWalking(({ [key]: _, ...rest }) => (startedAt ? { ...rest, [key]: startedAt } : rest))
        if (result) setWalkthroughs((current) => ({ ...current, [key]: result }))
      }),
    []
  )

  useEffect(() => writeLayout(layout), [layout])
  const updateLayout = useCallback((change: Partial<Layout>) => setLayout((current) => ({ ...current, ...change })), [])
  const toggleGraph = useCallback(() => setLayout((current) => ({ ...current, graphOpen: !current.graphOpen })), [])
  /** Shows a left panel. A click on the button of the open panel hides it. */
  const togglePanel = useCallback((panel: LeftPanel) => setLayout((current) => ({ ...current, leftPanel: current.leftPanel === panel ? null : panel })), [])
  const showPanel = useCallback((panel: LeftPanel) => setLayout((current) => ({ ...current, leftPanel: panel })), [])

  useEffect(() => {
    window.api.getSettings().then(setSettings)
    window.api.listDrafts().then(setDrafts)
    const unsubscribe = [window.api.onProgress(setProgress), window.api.onDrafts(setDrafts)]
    return () => unsubscribe.forEach((u) => u())
  }, [])

  const run = useCallback(async <T,>(task: () => Promise<T>): Promise<T | undefined> => {
    setError('')
    try {
      return await task()
    } catch (e) {
      const message = e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e)
      if (message === LOAD_CANCELLED) setNotice(`${LOAD_CANCELLED}.`)
      else setError(message)
      setProgress(undefined)
      return undefined
    }
  }, [])

  /** A review belongs to one workspace, so a switch closes it. */
  const applySettings = (next: Settings): void => {
    if (next.workspace !== settings.workspace) {
      setModel(undefined)
      setSelectedId(undefined)
      setCommentTarget(undefined)
    }
    setSettings(next)
  }

  /** keepId keeps the selected unit after a reload, when the unit is still part of the change. */
  const openModel = useCallback((next: ReviewModel | undefined, keepId?: string) => {
    if (!next) return
    setModel(next)
    setReviewed(readReviewed(next.key))
    setSelectedId(keepId && next.nodes.some((n) => n.id === keepId) ? keepId : next.nodes.find((n) => n.order === 0)?.id)
    setCommentTarget(undefined)
    window.api.getPreReview(next.key).then((result) => setPreReview(result ? { modelKey: next.key, result } : undefined))
    window.api.savedExplanations(next.key).then((byId) => setExplanations({ modelKey: next.key, byId }))
  }, [])

  /** Opens the same review again with only the commits of the range. No range opens all commits. */
  const openRange = (current: ReviewModel, range: CommitRange | undefined, keepId?: string): void => {
    const review = current.review
    run(() => (review ? window.api.loadReview(review.id, range) : current.local ? window.api.loadLocal(range) : window.api.loadBranch(current.branch, range))).then((next) =>
      openModel(next, keepId)
    )
  }

  /** Reads the local changes again, because the files on disk change while the user reviews them. */
  const reloadLocal = (current: ReviewModel): void => {
    run(() => window.api.loadLocal(current.range)).then((next) => openLocal(next, selectedId))
  }

  /** An empty local change opens no model. A blank graph would look like a failed load, so a notice says why. */
  const openLocal = (next: ReviewModel | undefined, keepId?: string): void => {
    if (!next) return
    if (next.files.length > 0 || next.range) {
      openModel(next, keepId)
      return
    }
    if (model?.local) setModel(undefined)
    setNotice(next.source === 'github' ? `No local changes on ${next.branch}: every commit is pushed and nothing is changed on disk.` : 'No pending changes in the workspace.')
  }

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(''), NOTICE_SECONDS * 1000)
    return () => clearTimeout(timer)
  }, [notice])

  useEffect(() => {
    const unsubscribe = [
      window.api.onOpenModel((next) => {
        setProgress(undefined)
        openModel(next)
      }),
      window.api.onSelect(setSelectedId)
    ]
    return () => unsubscribe.forEach((u) => u())
  }, [openModel])

  /**
 * Ctrl+V outside a text box opens a pasted review link or branch. Text boxes and the code keep their
 * own paste. A bare number is ignored here, because a stray paste must not open a random review.
 */
  useEffect(() => {
    const onPaste = (e: ClipboardEvent): void => {
      const target = e.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable], .monaco-editor')) return
      const text = e.clipboardData?.getData('text') ?? ''
      const parsed = /^\s*\d+\s*$/.test(text) ? undefined : parseOpenTarget(text)
      if (!parsed) return
      e.preventDefault()
      if ('reviewId' in parsed) run(() => window.api.loadReview(parsed.reviewId)).then(openModel)
      else run(() => window.api.loadBranch(parsed.branch)).then(openModel)
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [openModel, run])

  useEffect(() => {
    window.api.reportSelection({ modelKey: model?.key, nodeId: selectedId })
  }, [model?.key, selectedId])

  const nodesById = useMemo(() => new Map((model?.nodes ?? []).map((n) => [n.id, n])), [model])
  const readingPath = useMemo(
    () => (model?.nodes ?? []).filter((n) => n.order !== undefined).sort((a, b) => a.order! - b.order!),
    [model]
  )
  const selectedNode = selectedId ? nodesById.get(selectedId) : undefined
  const selectedCluster = model?.clusters.find((c) => c.id === (selectedNode?.clusterId ?? selectedId))
  const codeNode: GraphNode | undefined = selectedNode ?? (selectedCluster ? nodesById.get(selectedCluster.nodeIds[0]) : undefined)

  const modelExplanations = useMemo(() => (explanations && explanations.modelKey === model?.key ? explanations.byId : {}), [explanations, model?.key])

  const explain = useCallback(
    async (nodeIds: string[], force: boolean) => {
      if (!model || nodeIds.length === 0) return
      const modelKey = model.key
      const change = (add: boolean): void =>
        setExplaining((current) => {
          const next = new Set(current)
          nodeIds.forEach((id) => (add ? next.add(id) : next.delete(id)))
          return next
        })
      change(true)
      const byId = await run(() => window.api.explainContext({ modelKey, nodeIds, force }))
      change(false)
      if (byId) setExplanations({ modelKey, byId })
    },
    [model, run]
  )

  const clearExplanations = useCallback(
    async (nodeIds: string[]) => {
      if (!model || nodeIds.length === 0) return
      const modelKey = model.key
      const byId = await run(() => window.api.clearExplanations({ modelKey, nodeIds }))
      if (byId) setExplanations({ modelKey, byId })
    },
    [model, run]
  )

  const modelPreReview = preReview && preReview.modelKey === model?.key ? preReview.result : undefined
  const hotspots = useMemo(() => modelPreReview?.hotspots ?? [], [modelPreReview])
  const hotspotLevels = useMemo(() => new Map<string, HotspotLevel>(hotspots.map((h) => [h.nodeId, h.level])), [hotspots])

  const preReviewStartedAt = model ? preReviewing[model.key] : undefined
  const preReviewSeconds = useElapsedSeconds(preReviewStartedAt)

  const currentWalkKey = model ? walkKey(model.key, walkLevel) : undefined
  const walk = currentWalkKey ? walkthroughs[currentWalkKey] : undefined
  const walkStartedAt = currentWalkKey ? walking[currentWalkKey] : undefined
  const walkSeconds = useElapsedSeconds(walkStartedAt)
  const walkOpen = layout.leftPanel === 'walkthrough' && !!walk
  /** The "Got it" marks belong to one run, so a new run of the same level starts without marks. */
  const doneKey = currentWalkKey && walk ? `${currentWalkKey}|${walk.createdAt}` : undefined

  useEffect(() => {
    if (!model) return
    const modelKey = model.key
    window.api.getWalkthrough({ modelKey, level: walkLevel }).then((result) => {
      if (result) setWalkthroughs((current) => ({ ...current, [walkKey(modelKey, walkLevel)]: result }))
    })
  }, [model?.key, walkLevel])

  useEffect(() => {
    setWalkPosition(0)
    setStepsDone(doneKey ? readStepsDone(doneKey) : new Set())
  }, [doneKey])

  /** Opens a walkthrough step and selects its first unit, so the code shows it. The recap page selects nothing. */
  const goToStep = useCallback(
    (index: number) => {
      if (!walk) return
      const next = Math.min(walk.steps.length, Math.max(0, index))
      setWalkPosition(next)
      const first = walk.steps[next]?.nodeIds[0]
      if (first) setSelectedId(first)
    },
    [walk]
  )

  const stepUnits = useMemo(() => new Set(walkOpen ? (walk?.steps[walkPosition]?.nodeIds ?? []) : []), [walkOpen, walk, walkPosition])

  const toggleStepDone = (index: number): void => {
    if (!doneKey) return
    const next = new Set(stepsDone)
    if (next.has(index)) next.delete(index)
    else next.add(index)
    setStepsDone(next)
    writeStepsDone(doneKey, next)
  }

  const askStep = async (index: number, question: string): Promise<void> => {
    if (!model) return
    const modelKey = model.key
    const level = walkLevel
    const result = await window.api.askWalkthrough({ modelKey, level, step: index, question })
    setWalkthroughs((current) => ({ ...current, [walkKey(modelKey, level)]: result }))
  }

  /** AI pre-review tags stay hidden during a walkthrough, so they do not steer what the reviewer reads. */
  const shownHotspots = useMemo(() => (walkOpen ? [] : hotspots), [walkOpen, hotspots])
  const shownHotspotLevels = useMemo(() => (walkOpen ? new Map<string, HotspotLevel>() : hotspotLevels), [walkOpen, hotspotLevels])

  /** Moves through the flagged units in order of importance, and wraps around at the ends. */
  const stepHotspot = useCallback(
    (delta: number) => {
      if (hotspots.length === 0) return
      const current = hotspots.findIndex((h) => h.nodeId === selectedId)
      const start = current < 0 ? (delta > 0 ? -1 : 0) : current
      setSelectedId(hotspots[(start + delta + hotspots.length) % hotspots.length].nodeId)
    },
    [hotspots, selectedId]
  )

  const toggleReviewed = useCallback(
    (id: string) => {
      if (!model) return
      const next = new Set(reviewed)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      setReviewed(next)
      writeReviewed(model.key, next)
    },
    [model, reviewed]
  )

  const clusterStarts = useMemo(() => {
    const seen = new Set<string>()
    return readingPath.filter((n) => n.clusterId !== undefined && !seen.has(n.clusterId) && !!seen.add(n.clusterId))
  }, [readingPath])
  const position = readingPath.findIndex((n) => n.id === selectedNode?.id)
  const clusterPosition = clusterStarts.findIndex((n) => n.clusterId === selectedCluster?.id)

  const goTo = useCallback(
    (index: number) => {
      const next = readingPath[Math.min(readingPath.length - 1, Math.max(0, index))]
      if (next) setSelectedId(next.id)
    },
    [readingPath]
  )

  const step = useCallback((delta: number) => goTo(position + delta), [goTo, position])

  /** Moves to the first unit of a cluster. Backwards, it first returns to the start of the current cluster. */
  const stepCluster = useCallback(
    (delta: number) => {
      if (clusterStarts.length === 0) return
      const current = clusterStarts[clusterPosition]
      const backToStart = delta < 0 && current !== undefined && current.id !== selectedNode?.id
      const target = backToStart ? current : clusterStarts[Math.min(clusterStarts.length - 1, Math.max(0, clusterPosition + delta))]
      setSelectedId(target.id)
    },
    [clusterStarts, clusterPosition, selectedNode]
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.target instanceof Element && e.target.closest('input, textarea, select, .monaco-editor')) return
      if (e.key === 'n' && walkOpen) goToStep(walkPosition + 1)
      else if (e.key === 'p' && walkOpen) goToStep(walkPosition - 1)
      else if (e.key === 'n') step(1)
      else if (e.key === 'p') step(-1)
      else if (e.key === 'N') stepCluster(1)
      else if (e.key === 'P') stepCluster(-1)
      else if (e.key === 'Home') goTo(0)
      else if (e.key === 'End') goTo(readingPath.length - 1)
      else if (e.key === 'r' && selectedNode?.role === 'changed') toggleReviewed(selectedNode.id)
      else if (e.key === 'd') togglePanel('discussion')
      else if (e.key === 'a') togglePanel('prereview')
      else if (e.key === 'w') togglePanel('walkthrough')
      else if (e.key === 'g') toggleGraph()
      else if (e.key === 'h' && !walkOpen) stepHotspot(1)
      else if (e.key === 'H' && !walkOpen) stepHotspot(-1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [step, stepCluster, goTo, readingPath, toggleReviewed, selectedNode, toggleGraph, togglePanel, stepHotspot, walkOpen, goToStep, walkPosition])

  const setComments = (comments: ReviewComment[] | undefined): void => {
    if (comments) setModel((current) => (current ? { ...current, comments } : current))
  }

  const jumpToComment = (comment: ReviewComment): void => {
    if (!model) return
    const node = nodeForComment(model, comment)
    if (node) setSelectedId(node.id)
  }

  const openThread = (comment: ReviewComment): void => {
    setFocusThread({ id: comment.id })
    showPanel('discussion')
  }

  const runPreReview = (): void => {
    if (model) run(() => window.api.runPreReview(model.key))
  }

  const runWalkthrough = (): void => {
    if (model) run(() => window.api.runWalkthrough({ modelKey: model.key, level: walkLevel }))
  }

  const modelDrafts = drafts.filter((d) => d.modelKey === model?.key)
  const threadCount = model?.comments.filter((c) => c.parentId === -1 && c.type !== 'timeline').length ?? 0
  const changedCount = model?.nodes.filter((n) => n.role === 'changed').length ?? 0
  const reviewedCount = model?.nodes.filter((n) => n.role === 'changed' && reviewed.has(n.id)).length ?? 0
  const leftWidth = layout.leftPanel ? layout.inboxWidth : 0
  const fixedWidth = ACTIVITY_BAR_WIDTH + leftWidth
  const columns = layout.graphOpen
    ? `${ACTIVITY_BAR_WIDTH}px ${leftWidth}px minmax(${MIN_GRAPH_WIDTH}px, 1fr) min(${layout.sideWidth}px, calc(100vw - ${fixedWidth + MIN_GRAPH_WIDTH}px))`
    : `${ACTIVITY_BAR_WIDTH}px ${leftWidth}px 0 1fr`

  const activity = (panel: LeftPanel, icon: string, label: string, hint: string, badge?: React.ReactNode): React.JSX.Element => (
    <button className={`activity ${layout.leftPanel === panel ? 'active' : ''}`} onClick={() => togglePanel(panel)} title={hint}>
      <span className="activity-icon">{icon}</span>
      <span className="activity-label">{label}</span>
      {badge}
    </button>
  )

  return (
    <div className="app" style={{ gridTemplateColumns: columns }}>
      <header className="topbar">
        <button
          className={`ghost graph-toggle ${layout.graphOpen ? 'on' : ''}`}
          onClick={toggleGraph}
          title={`${layout.graphOpen ? 'Hide' : 'Show'} the graph (g). Without the graph, the code panel uses the full width.`}
        >
          Graph
        </button>
        <WorkspacePicker settings={settings} run={run} onSettings={applySettings} />
        {model && (
          <span className="title" title={model.branch}>
            {model.review ? `#${model.review.id} ${model.review.title}` : model.local ? `Local changes on ${model.branch}` : model.branch}
          </span>
        )}
        {!model && <span className="title muted">{settings.me}</span>}
        {model && <CommitsMenu model={model} onRange={(range) => openRange(model, range)} />}
        {model?.local && (
          <button className="ghost small" onClick={() => reloadLocal(model)} title="Read the local changes again from the disk. The selected unit stays selected.">
            ⟳ Reload
          </button>
        )}
        {model && (
          <span className="progress-pill" title="Changed units marked as reviewed. Keys: n next, p previous, r reviewed">
            {reviewedCount}/{changedCount} reviewed
          </span>
        )}
        {model && <ReviewStatus model={model} run={run} onReviewers={(reviewers) => reviewers && setModel({ ...model, reviewers })} />}
      </header>
      <nav className="activity-bar">
        {activity('reviews', '☰', 'Reviews', 'Reviews and branches to open. Click again to hide the panel.')}
        {activity(
          'prereview',
          '⚠',
          'AI check',
          'AI pre-review: Claude flags the units to check first (a). Click again to hide the panel.',
          preReviewStartedAt ? <span className="spinner activity-badge" /> : hotspots.length > 0 ? <span className="activity-badge">{hotspots.length}</span> : undefined
        )}
        {activity(
          'walkthrough',
          '🧭',
          'Walk',
          'Walkthrough: Claude teaches the change step by step (w). Click again to hide the panel.',
          walkStartedAt ? <span className="spinner activity-badge" /> : walk ? <span className="activity-badge">{walk.steps.length}</span> : undefined
        )}
        {activity(
          'discussion',
          '💬',
          'Threads',
          'Comment threads, AI drafts and the Claude buttons (d). Click again to hide the panel.',
          modelDrafts.length > 0 ? <span className="activity-badge draft">{modelDrafts.length} AI</span> : threadCount > 0 ? <span className="activity-badge">{threadCount}</span> : undefined
        )}
        <div className="activity-bottom" />
        {activity('settings', '⚙', 'Settings', 'App settings: Claude models, hidden files and saved data. Click again to hide the panel.')}
      </nav>
      <aside className={`left-panel ${layout.leftPanel ? '' : 'hidden'}`}>
        <div className="left-panel-body" hidden={layout.leftPanel !== 'reviews'}>
          <Inbox
            disabled={!settings.workspace}
            source={settings.source}
            run={run}
            onOpenReview={(id) => run(() => window.api.loadReview(id)).then(openModel)}
            onOpenBranch={(branch) => run(() => window.api.loadBranch(branch)).then(openModel)}
            onOpenLocal={() => run(() => window.api.loadLocal()).then((next) => openLocal(next))}
          />
        </div>
        <div className="left-panel-body" hidden={layout.leftPanel !== 'prereview'}>
          {model ? (
            <PreReviewPanel
              model={model}
              preReview={modelPreReview}
              runningSeconds={preReviewStartedAt === undefined ? undefined : preReviewSeconds}
              drafts={modelDrafts}
              selectedId={selectedNode?.id}
              onRun={runPreReview}
              onSelect={setSelectedId}
              onDraft={(list) => {
                const fields = list.map((h) => hotspotDraft(model, h)).filter((d) => d !== undefined)
                if (fields.length) run(() => window.api.addDrafts(fields))
              }}
            />
          ) : (
            <div className="empty">Open a review first.</div>
          )}
        </div>
        <div className="left-panel-body" hidden={layout.leftPanel !== 'walkthrough'}>
          {model ? (
            <WalkthroughPanel
              model={model}
              walkthrough={walk}
              level={walkLevel}
              runningSeconds={walkStartedAt === undefined ? undefined : walkSeconds}
              position={walkPosition}
              done={stepsDone}
              selectedId={selectedNode?.id}
              onLevel={setWalkLevel}
              onRun={runWalkthrough}
              onPosition={goToStep}
              onToggleDone={toggleStepDone}
              onSelect={setSelectedId}
              onAsk={askStep}
            />
          ) : (
            <div className="empty">Open a review first.</div>
          )}
        </div>
        <div className="left-panel-body" hidden={layout.leftPanel !== 'discussion'}>
          {model ? (
            <Discussion
              model={model}
              run={run}
              drafts={modelDrafts}
              focusFile={codeNode?.file}
              focusThread={focusThread}
              onComments={setComments}
              onJump={jumpToComment}
            />
          ) : (
            <div className="empty">Open a review first.</div>
          )}
        </div>
        <div className="left-panel-body" hidden={layout.leftPanel !== 'settings'}>
          <SettingsPanel
            settings={settings}
            run={run}
            onSettings={applySettings}
            onCleared={(kinds) => {
              const cleared = new Set(kinds)
              if (cleared.has('explanations')) setExplanations(undefined)
              if (cleared.has('prereviews')) setPreReview(undefined)
              if (cleared.has('walkthroughs')) setWalkthroughs({})
              if (cleared.has('marks')) {
                setReviewed(new Set())
                setStepsDone(new Set())
              }
              if (cleared.has('revisions') && model) openRange(model, model.range, selectedId)
            }}
          />
        </div>
        <Splitter
          className="splitter-right"
          direction={1}
          min={MIN_LEFT_WIDTH}
          max={() => Math.min(MAX_LEFT_WIDTH, window.innerWidth - ACTIVITY_BAR_WIDTH - MIN_SIDE_WIDTH)}
          onResize={(inboxWidth) => updateLayout({ inboxWidth })}
          onReset={() => updateLayout({ inboxWidth: DEFAULT_LAYOUT.inboxWidth })}
        />
      </aside>
      <main className={`graph-area ${layout.graphOpen ? '' : 'hidden'}`}>
        {model ? (
          <>
            {model.warnings.map((w) => (
              <div key={w} className="warning">
                {w}
              </div>
            ))}
            <GraphView
              model={model}
              selectedId={selectedId}
              reviewed={reviewed}
              hotspots={shownHotspotLevels}
              explanations={modelExplanations}
              explaining={explaining}
              onExplain={explain}
              stepUnits={stepUnits}
              onSelect={setSelectedId}
            />
          </>
        ) : (
          <div className="empty">Open a review or a branch from the Reviews panel.</div>
        )}
      </main>
      <aside className="side" ref={side}>
        {layout.graphOpen && (
          <Splitter
            className="splitter-left"
            direction={-1}
            min={MIN_SIDE_WIDTH}
            max={() => window.innerWidth - fixedWidth - MIN_GRAPH_WIDTH}
            onResize={(sideWidth) => updateLayout({ sideWidth })}
            onReset={() => updateLayout({ sideWidth: DEFAULT_LAYOUT.sideWidth })}
          />
        )}
        {model && (
          <>
            <Navigator
              path={readingPath}
              clusters={model.clusters}
              selectedId={selectedNode?.id}
              reviewedIds={reviewed}
              hotspots={shownHotspots}
              onSelect={setSelectedId}
              position={position}
              total={readingPath.length}
              clusterPosition={clusterPosition}
              clusterTotal={clusterStarts.length}
              reviewed={selectedNode ? reviewed.has(selectedNode.id) : false}
              onFirst={() => goTo(0)}
              onLast={() => goTo(readingPath.length - 1)}
              onStep={step}
              onStepCluster={stepCluster}
              onToggleReviewed={selectedNode?.role === 'changed' ? () => toggleReviewed(selectedNode.id) : undefined}
            />
            <NodeContext
              model={model}
              node={selectedNode}
              cluster={selectedCluster}
              reviewed={reviewed}
              preReview={walkOpen ? undefined : modelPreReview}
              drafts={modelDrafts}
              onDraftHotspots={(list) => {
                const fields = list.map((h) => hotspotDraft(model, h)).filter((d) => d !== undefined)
                if (fields.length) run(() => window.api.addDrafts(fields))
              }}
              run={run}
              explanations={modelExplanations}
              explaining={explaining}
              onExplain={explain}
              onClearExplanations={clearExplanations}
              onSelect={setSelectedId}
              height={layout.contextHeight}
            />
            <Splitter
              axis="y"
              className="splitter-context"
              direction={1}
              min={MIN_CONTEXT_HEIGHT}
              max={() => Math.max(MIN_CONTEXT_HEIGHT, (side.current?.clientHeight ?? 0) - MIN_CODE_HEIGHT)}
              onResize={(contextHeight) => updateLayout({ contextHeight })}
              onReset={() => updateLayout({ contextHeight: undefined })}
            />
            <div className="code-area">
              {codeNode?.kind === 'blueprint' ? (
                <BlueprintPanel model={model} node={codeNode} />
              ) : codeNode?.kind === 'asset' ? (
                <AssetPanel model={model} node={codeNode} />
              ) : (
              <CodePanel
                model={model}
                node={codeNode}
                hotspots={shownHotspots}
                run={run}
                commentTarget={commentTarget}
                onCommentLine={setCommentTarget}
                onClearTarget={() => setCommentTarget(undefined)}
                onComments={setComments}
                onOpenComment={openThread}
                onSelect={setSelectedId}
              />
              )}
            </div>
          </>
        )}
      </aside>
      <StatusBar progress={progress} error={error} notice={notice} onDismissError={() => setError('')} onDismissNotice={() => setNotice('')} />
    </div>
  )
}
