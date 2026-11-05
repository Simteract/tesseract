import { useEffect, useState } from 'react'
import type { Cluster, Draft, Explanation, GraphNode, Hotspot, HotspotLevel, NewDraft, PreReview, ReviewModel } from '../../shared/types'
import { basename, LEVEL_TAG, type Run } from './util'

interface Props {
  model: ReviewModel
  node?: GraphNode
  cluster?: Cluster
  reviewed: Set<string>
  preReview?: PreReview
  /** Drafts of the open review. They show which flagged units already have a draft. */
  drafts: Draft[]
  onDraftHotspots(hotspots: Hotspot[]): void
  run: Run
  /** Claude explanations of context units, by node id. */
  explanations: Record<string, Explanation>
  /** Context units that Claude explains now. */
  explaining: Set<string>
  onExplain(nodeIds: string[], force: boolean): void
  onClearExplanations(nodeIds: string[]): void
  onSelect(id: string): void
  /** Height that the user set with the splitter. */
  height?: number
}

export function NodeContext({ model, node, cluster, reviewed, preReview, drafts, onDraftHotspots, run, explanations, explaining, onExplain, onClearExplanations, onSelect, height }: Props): React.JSX.Element {
  const [summary, setSummary] = useState<string>()
  const [summarizing, setSummarizing] = useState(false)
  const byId = new Map(model.nodes.map((n) => [n.id, n]))

  useEffect(() => setSummary(undefined), [cluster?.id, model.key])

  const summarize = async (force: boolean): Promise<void> => {
    if (!cluster) return
    setSummarizing(true)
    const text = await run(() => window.api.summarizeCluster({ modelKey: model.key, clusterId: cluster.id, force }))
    setSummarizing(false)
    if (text) setSummary(text)
  }

  const related = (direction: 'out' | 'in'): GraphNode[] =>
    node
      ? model.edges
          .filter((e) => e.kind === 'calls' && (direction === 'out' ? e.source === node.id : e.target === node.id))
          .map((e) => byId.get(direction === 'out' ? e.target : e.source)!)
          .filter(Boolean)
      : []
  const calls = related('out')
  const callers = related('in')
  const hotspot = node ? preReview?.hotspots.find((h) => h.nodeId === node.id) : undefined
  const clusterContext = cluster ? contextOf(model, cluster) : []
  const linkTitle = (n: GraphNode): string => {
    const explanation = explanations[n.id]
    if (!explanation) return n.file
    return [n.file, explanation.does, explanation.relation && `${RELATION_LABEL} ${explanation.relation}`].filter(Boolean).join('\n\n')
  }
  const clusterDone = cluster ? cluster.nodeIds.filter((id) => reviewed.has(id)).length : 0

  return (
    <section className={`context ${height === undefined ? '' : 'sized'}`} style={height === undefined ? undefined : { height }}>
      {node ? (
        <div className="context-head">
          <div>
            <div className="qualified">{node.qualifiedName}</div>
            <div className="muted">
              {basename(node.file)}:{node.startLine}-{node.endLine} · {node.kind} · {node.role === 'context' ? 'not changed' : `+${node.added} −${node.removed}`}
              {node.side === 'base' ? ' · deleted' : ''}
            </div>
          </div>
        </div>
      ) : (
        <div className="muted">Select a node. Keys: n / p unit, Shift+N / Shift+P cluster, h / Shift+H AI hotspot, Home / End, r reviewed, d discussion, g graph.</div>
      )}
      {node?.role === 'context' && (
        <div className="explanation">
          <div className="explanation-head">
            <span className="muted">What this unit does</span>
            <ExplainButton ids={[node.id]} explanations={explanations} explaining={explaining} onExplain={onExplain} />
            {explanations[node.id] && !explaining.has(node.id) && (
              <button className="ghost small" onClick={() => onClearExplanations([node.id])} title="Delete the saved explanation of this unit">
                Clear
              </button>
            )}
          </div>
          {explanations[node.id] && <ExplanationText explanation={explanations[node.id]} />}
        </div>
      )}
      {hotspot && <HotspotNote hotspot={hotspot} draft={<DraftButton model={model} hotspots={[hotspot]} drafts={drafts} onDraft={onDraftHotspots} />} />}
      {node && (calls.length > 0 || callers.length > 0) && (
        <div className="relations">
          {callers.length > 0 && (
            <div>
              <span className="muted">Called by </span>
              {callers.map((n) => (
                <a key={n.id} className={`role-${n.role}`} onClick={() => onSelect(n.id)} title={linkTitle(n)}>
                  {n.qualifiedName}
                </a>
              ))}
            </div>
          )}
          {calls.length > 0 && (
            <div>
              <span className="muted">Calls </span>
              {calls.map((n) => (
                <a key={n.id} className={`role-${n.role}`} onClick={() => onSelect(n.id)} title={linkTitle(n)}>
                  {n.qualifiedName}
                </a>
              ))}
            </div>
          )}
        </div>
      )}
      {cluster && (
        <div className="cluster-box">
          <div className="cluster-head">
            <a onClick={() => onSelect(cluster.id)}>
              <strong>{cluster.label}</strong>
            </a>
            <span className="muted">
              {cluster.nodeIds.length} units · {cluster.files.length} files · +{cluster.added} −{cluster.removed} · {clusterDone}/{cluster.nodeIds.length} reviewed
            </span>
            <button
              disabled={summarizing}
              onClick={() => summarize(!!summary)}
              title="Ask Claude for a short summary of this cluster: what it does, what existing code it touches, and what to check. The app saves the summary."
            >
              {summarizing ? 'Claude is reading…' : summary ? 'Regenerate summary' : 'Summarize with Claude'}
            </button>
            {clusterContext.length > 0 && (
              <ExplainButton ids={clusterContext} explanations={explanations} explaining={explaining} onExplain={onExplain} label="Explain context" />
            )}
            {clusterContext.some((id) => explanations[id] && !explaining.has(id)) && (
              <button
                className="ghost small"
                onClick={() => onClearExplanations(clusterContext.filter((id) => !explaining.has(id)))}
                title="Delete the saved explanations of the context units of this cluster"
              >
                Clear explanations
              </button>
            )}
          </div>
          {summary && <div className="summary" dangerouslySetInnerHTML={{ __html: renderMarkdown(summary) }} />}
        </div>
      )}
    </section>
  )
}

/** The context units that the cluster calls or that call the cluster. */
export function contextOf(model: ReviewModel, cluster: Cluster): string[] {
  const members = new Set(cluster.nodeIds)
  const context = new Set(model.nodes.filter((n) => n.role === 'context').map((n) => n.id))
  const found = new Set<string>()
  for (const edge of model.edges) {
    if (members.has(edge.source) && context.has(edge.target)) found.add(edge.target)
    if (members.has(edge.target) && context.has(edge.source)) found.add(edge.source)
  }
  return [...found]
}

const RELATION_LABEL = 'Relation to the change:'

/** Shows what a context unit does, and how the unit and the change affect each other. */
export function ExplanationText({ explanation }: { explanation: Explanation }): React.JSX.Element {
  return (
    <>
      <div>{explanation.does}</div>
      {explanation.relation && (
        <div className="explanation-relation">
          <strong>{RELATION_LABEL}</strong> {explanation.relation}
        </div>
      )}
    </>
  )
}

interface ExplainButtonProps {
  ids: string[]
  explanations: Record<string, Explanation>
  explaining: Set<string>
  onExplain(nodeIds: string[], force: boolean): void
  /** Label for more than one unit. The button adds the count. */
  label?: string
}

/** Asks Claude to explain context units. With all units explained, the button explains them again. */
export function ExplainButton({ ids, explanations, explaining, onExplain, label }: ExplainButtonProps): React.JSX.Element {
  const busy = ids.filter((id) => explaining.has(id)).length
  const missing = ids.filter((id) => !explanations[id] && !explaining.has(id))
  const again = missing.length === 0 && busy === 0
  const text = busy
    ? label
      ? `Claude is reading ${busy} units…`
      : 'Claude is reading…'
    : label
      ? `${label} (${again ? ids.length : missing.length})`
      : again
        ? 'Explain again'
        : 'Explain with Claude'
  const title = again
    ? 'Ask Claude again. The new text replaces the saved one.'
    : 'Ask Claude what the unit does, and how the unit and the change affect each other. Units that already have an explanation are skipped. The app saves the text and shows it when you hover the node in the graph.'
  return (
    <button className="small" disabled={busy > 0} onClick={() => onExplain(again ? ids : missing, again)} title={title}>
      {busy > 0 && <span className="spinner" />}
      {text}
    </button>
  )
}

export const LEVEL_LABEL = { high: 'High', medium: 'Medium', low: 'Low' } as const

/** Draft type for each level. Low points become questions, because the reviewer must still judge them. */
const DRAFT_TYPE: Record<HotspotLevel, string> = { high: 'Change', medium: 'Change', low: 'Question' }

/** The line comment draft for a flagged unit, on its first line. A deleted unit has no line in the new code, so it gets none. */
export function hotspotDraft(model: ReviewModel, hotspot: Hotspot): NewDraft | undefined {
  const node = model.nodes.find((n) => n.id === hotspot.nodeId)
  if (!node || node.side === 'base') return undefined
  return { modelKey: model.key, kind: 'comment', text: `${hotspot.title}.\n\n${hotspot.reason}`, path: node.file, line: node.startLine, type: DRAFT_TYPE[hotspot.level] }
}

function hasDraft(drafts: Draft[], draft: NewDraft): boolean {
  return drafts.some((d) => d.path === draft.path && d.line === draft.line && d.text.split('\n')[0] === draft.text.split('\n')[0])
}

interface DraftButtonProps {
  model: ReviewModel
  hotspots: Hotspot[]
  drafts: Draft[]
  onDraft(hotspots: Hotspot[]): void
  /** Label for more than one hotspot. */
  label?: string
}

/** Turns flagged units into comment drafts. Units that already have a draft are skipped. */
export function DraftButton({ model, hotspots, drafts, onDraft, label }: DraftButtonProps): React.JSX.Element {
  const open = hotspots.filter((h) => {
    const draft = hotspotDraft(model, h)
    return draft && !hasDraft(drafts, draft)
  })
  const reason = !model.review
    ? 'A branch without a review cannot hold comments'
    : hotspots.every((h) => !hotspotDraft(model, h))
      ? 'A deleted unit has no line for a comment'
      : open.length === 0
        ? 'The draft is in the Discussion tab'
        : 'Make a comment draft from this point. High and medium become change requests, low becomes a question. You can edit the text and the type in the Discussion tab before you post it.'
  return (
    <button className="small" disabled={!model.review || open.length === 0} onClick={() => onDraft(open)} title={reason}>
      {label ? `${label} (${open.length})` : open.length === 0 && model.review && hotspots.some((h) => hotspotDraft(model, h)) ? 'Drafted ✓' : 'Draft comment'}
    </button>
  )
}

function HotspotNote({ hotspot, draft }: { hotspot: Hotspot; draft: React.ReactNode }): React.JSX.Element {
  return (
    <div className={`hotspot-note level-${hotspot.level}`} title="The AI pre-review flagged this unit. Check it with care.">
      <div className="hotspot-head">
        <span className={`chip level-${hotspot.level}`}>{LEVEL_TAG[hotspot.level]} AI: {LEVEL_LABEL[hotspot.level]}</span> <b>{hotspot.title}</b>
        <span className="spacer" />
        {draft}
      </div>
      <div>{hotspot.reason}</div>
    </div>
  )
}

/** Renders the small markdown subset the summary prompt asks for. Text is escaped before the markup is added. */
function renderMarkdown(text: string): string {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return escaped
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/^\s*[-*] (.*)$/gm, '<li>$1</li>')
    .replace(/^#+ (.*)$/gm, '<strong>$1</strong>')
    .replace(/\n/g, '<br/>')
}
