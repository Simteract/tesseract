import type { Cluster, GraphNode, Hotspot } from '../../shared/types'
import { LEVEL_TAG } from './util'

interface Props {
  /** Units on the reading path, in order. */
  path: GraphNode[]
  clusters: Cluster[]
  selectedId?: string
  reviewedIds: Set<string>
  /** Units that the AI pre-review flagged, most important first. */
  hotspots: Hotspot[]
  onSelect(id: string): void
  /** 0-based position of the selected unit on the reading path, or -1. */
  position: number
  total: number
  /** 0-based position of the selected cluster in reading order, or -1. */
  clusterPosition: number
  clusterTotal: number
  reviewed?: boolean
  onFirst(): void
  onLast(): void
  onStep(delta: number): void
  onStepCluster(delta: number): void
  onToggleReviewed?(): void
}

interface Group {
  clusterId?: string
  label: string
  nodes: GraphNode[]
}

/** Splits the reading path into runs of the same cluster. Units without a cluster go in an "Other" group. */
function groupByCluster(path: GraphNode[], clusters: Cluster[]): Group[] {
  const labels = new Map(clusters.map((c) => [c.id, c.label]))
  const groups: Group[] = []
  for (const node of path) {
    const last = groups.at(-1)
    if (last && last.clusterId === node.clusterId) last.nodes.push(node)
    else groups.push({ clusterId: node.clusterId, label: '', nodes: [node] })
  }
  let clusterNumber = 0
  for (const g of groups) {
    const name = g.clusterId === undefined ? undefined : labels.get(g.clusterId)
    g.label = name === undefined ? 'Other' : `Cluster ${++clusterNumber}: ${name}`
  }
  return groups
}

/**
 * Fixed bar for the reading path. Every button has a fixed width, so no button moves when the
 * selection changes.
 */
export function Navigator(props: Props): React.JSX.Element {
  const { position, total, clusterPosition, clusterTotal, reviewed } = props
  const atStart = position <= 0
  const flagged = new Set(props.hotspots.map((h) => h.nodeId))
  const nodeLabel = new Map(props.path.map((n) => [n.id, n.label]))
  const atEnd = position === total - 1
  return (
    <nav className="navigator">
      <button onClick={props.onFirst} disabled={total === 0 || position === 0} title="Go to the first unit on the reading path (Home)">
        ⏮
      </button>
      <button onClick={() => props.onStepCluster(-1)} disabled={clusterTotal === 0 || (clusterPosition <= 0 && atStart)} title="Go to the start of this cluster, or to the previous cluster if you are at the start (Shift+P)">
        {'⏪︎'}
      </button>
      <button onClick={() => props.onStep(-1)} disabled={atStart} title="Go to the previous unit on the reading path (p)">
        ◀
      </button>
      <span className="nav-position" title="Position of the selected unit on the reading path. The reading path puts callers before callees.">
        <span>
          Unit <b>{position >= 0 ? position + 1 : '-'}</b>/{total}
        </span>
        <span>
          Cluster <b>{clusterPosition >= 0 ? clusterPosition + 1 : '-'}</b>/{clusterTotal}
        </span>
      </span>
      <button onClick={() => props.onStep(1)} disabled={total === 0 || atEnd} title="Go to the next unit on the reading path (n)">
        ▶
      </button>
      <button onClick={() => props.onStepCluster(1)} disabled={clusterTotal === 0 || clusterPosition === clusterTotal - 1} title="Go to the first unit of the next cluster (Shift+N)">
        {'⏩︎'}
      </button>
      <button onClick={props.onLast} disabled={total === 0 || atEnd} title="Go to the last unit on the reading path (End)">
        ⏭
      </button>
      <select className="nav-pick" value={position >= 0 ? props.selectedId : ''} onChange={(e) => props.onSelect(e.target.value)} title="Jump to any unit on the reading path. The list is grouped by cluster. ✓ marks reviewed units. ⚠ marks units that the AI pre-review flagged.">
        {position < 0 && <option value="">Pick a unit…</option>}
        {props.hotspots.length > 0 && (
          <optgroup label="AI pre-review: check first">
            {props.hotspots.map((h) => (
              <option key={`hotspot-${h.nodeId}`} value={h.nodeId}>
                {`${LEVEL_TAG[h.level]} ${h.title} (${nodeLabel.get(h.nodeId) ?? ''})`}
              </option>
            ))}
          </optgroup>
        )}
        {groupByCluster(props.path, props.clusters).map((group, i) => (
          <optgroup key={`${group.clusterId ?? 'other'}-${i}`} label={group.label}>
            {group.nodes.map((n) => (
              <option key={n.id} value={n.id}>
                {`${(n.order ?? 0) + 1}. ${props.reviewedIds.has(n.id) ? '✓ ' : ''}${flagged.has(n.id) ? '⚠ ' : ''}${n.label} (+${n.added} -${n.removed})`}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <button
        className={`nav-reviewed ${reviewed ? 'done' : ''}`}
        disabled={!props.onToggleReviewed}
        onClick={props.onToggleReviewed}
        title="Mark the selected unit as reviewed, or clear the mark (r). The mark is stored only in this app, not on the server."
      >
        {reviewed ? '✓ Reviewed' : 'Mark reviewed'}
      </button>
    </nav>
  )
}
