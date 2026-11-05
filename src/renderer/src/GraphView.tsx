import cytoscape, { type Core, type ElementDefinition } from 'cytoscape'
import fcose from 'cytoscape-fcose'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Explanation, HotspotLevel, ReviewModel } from '../../shared/types'
import { ExplainButton, ExplanationText } from './NodeContext'
import { CLUSTER_COLORS, LEVEL_COLOR, LEVEL_TAG, nodeForComment, textOn } from './util'

cytoscape.use(fcose)

/** Zoom factor per pixel of wheel scroll. One wheel notch is about 100 px, so it changes the zoom about 1.16 times. */
export const WHEEL_ZOOM_RATE = 0.0015

/** Zoom factor per pixel of vertical middle-button drag. 200 px of drag change the zoom about 2.7 times. */
export const DRAG_ZOOM_RATE = 0.005

const MIDDLE_BUTTON = 1
const RIGHT_BUTTON = 2

/**
 * Middle-button drag zooms around the point where the drag started. Up zooms in, down zooms out.
 * Right-button drag pans the graph. Cytoscape panning and box selection are off, so a left-button drag only moves nodes.
 * The listeners use the capture phase, so cytoscape does not also handle these drags.
 * The wheel zooms at the cursor here, because the cytoscape wheel zoom works only while cytoscape panning is on.
 */
function enableMouseNavigation(element: HTMLElement, instance: Core): () => void {
  let drag: { button: number; x: number; y: number; zoom: number; pan: cytoscape.Position; point: cytoscape.Position } | undefined
  const onDown = (e: MouseEvent): void => {
    if (e.button !== MIDDLE_BUTTON && e.button !== RIGHT_BUTTON) return
    e.preventDefault()
    e.stopPropagation()
    const box = element.getBoundingClientRect()
    drag = {
      button: e.button,
      x: e.clientX,
      y: e.clientY,
      zoom: instance.zoom(),
      pan: { ...instance.pan() },
      point: { x: e.clientX - box.left, y: e.clientY - box.top }
    }
  }
  const onMove = (e: MouseEvent): void => {
    if (!drag) return
    e.preventDefault()
    if (drag.button === RIGHT_BUTTON) instance.pan({ x: drag.pan.x + e.clientX - drag.x, y: drag.pan.y + e.clientY - drag.y })
    else instance.zoom({ level: drag.zoom * Math.exp((drag.y - e.clientY) * DRAG_ZOOM_RATE), renderedPosition: drag.point })
  }
  const onUp = (e: MouseEvent): void => {
    if (e.button === drag?.button) drag = undefined
  }
  const onWheel = (e: WheelEvent): void => {
    e.preventDefault()
    const box = element.getBoundingClientRect()
    instance.zoom({ level: instance.zoom() * Math.exp(-e.deltaY * WHEEL_ZOOM_RATE), renderedPosition: { x: e.clientX - box.left, y: e.clientY - box.top } })
  }
  const onContextMenu = (e: MouseEvent): void => e.preventDefault()
  element.addEventListener('mousedown', onDown, true)
  element.addEventListener('wheel', onWheel, { passive: false })
  element.addEventListener('contextmenu', onContextMenu)
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
  return () => {
    element.removeEventListener('mousedown', onDown, true)
    element.removeEventListener('wheel', onWheel)
    element.removeEventListener('contextmenu', onContextMenu)
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
  }
}

interface Props {
  model: ReviewModel
  selectedId?: string
  reviewed: Set<string>
  /** Units that the AI pre-review flagged, with their level. */
  hotspots: Map<string, HotspotLevel>
  /** Claude explanations of context units, by node id. A hover on the node shows the text. */
  explanations: Record<string, Explanation>
  explaining: Set<string>
  onExplain(nodeIds: string[], force: boolean): void
  /** Called with undefined when the user clicks the empty background. */
  onSelect(id: string | undefined): void
}

const STYLE: cytoscape.StylesheetJson = [
  {
    selector: 'node',
    style: {
      label: 'data(label)',
      'font-size': 11,
      'font-family': 'Segoe UI, sans-serif',
      color: 'data(textColor)',
      'text-valign': 'center',
      'text-halign': 'center',
      'text-wrap': 'wrap',
      shape: 'round-rectangle',
      width: 'data(w)',
      height: 'data(h)',
      'background-color': 'data(color)',
      'border-width': 1,
      'border-color': '#0b0c0f'
    }
  },
  {
    selector: ':parent',
    style: {
      label: 'data(label)',
      'text-valign': 'top',
      'text-halign': 'center',
      'font-size': 13,
      'font-weight': 'bold',
      color: 'data(textColor)',
      'text-background-color': 'data(color)',
      'text-background-opacity': 1,
      'text-background-padding': '3px',
      'text-background-shape': 'roundrectangle',
      'text-margin-y': -4,
      'background-color': 'data(color)',
      'background-opacity': 0.07,
      'border-color': 'data(color)',
      'border-width': 1,
      'border-opacity': 0.6,
      padding: '18px'
    }
  },
  { selector: 'node.blueprint', style: { shape: 'cut-rectangle' } },
  { selector: 'node.context', style: { 'background-color': '#2a2e37', color: '#a5acb8', 'border-style': 'dashed', 'border-color': '#5c6370', 'font-size': 10 } },
  { selector: 'node.deleted', style: { 'border-color': '#D55E00', 'border-style': 'double', 'border-width': 4,'text-decoration': 'line-through' } as cytoscape.Css.Node },
  { selector: 'node.has-comments', style: { 'border-color': '#F0E442', 'border-width': 2 } },
  { selector: 'node.reviewed', style: { opacity: 0.4 } },
  { selector: 'node.hotspot-high', style: { 'underlay-color': LEVEL_COLOR.high, 'underlay-opacity': 0.75, 'underlay-padding': 9 } },
  { selector: 'node.hotspot-medium', style: { 'underlay-color': LEVEL_COLOR.medium, 'underlay-opacity': 0.6, 'underlay-padding': 7 } },
  { selector: 'node.hotspot-low', style: { 'underlay-color': LEVEL_COLOR.low, 'underlay-opacity': 0.5, 'underlay-padding': 5 } },
  { selector: 'node.selected', style: { 'border-color': '#ffffff', 'border-width': 3, opacity: 1 } },
  {
    selector: 'edge',
    style: {
      width: 1.4,
      'curve-style': 'bezier',
      'line-color': '#6b7385',
      'target-arrow-color': '#6b7385',
      'target-arrow-shape': 'triangle',
      'arrow-scale': 0.8
    }
  },
  { selector: 'edge.declares', style: { 'line-style': 'dashed', 'target-arrow-shape': 'none', 'line-color': '#4a5160' } },
  { selector: 'edge.highlight', style: { 'line-color': '#e8eaf0', 'target-arrow-color': '#e8eaf0', width: 2.2 } },
  { selector: 'edge.hovered', style: { 'line-color': '#ffffff', 'target-arrow-color': '#ffffff', width: 3.5, 'arrow-scale': 1.1, opacity: 1 } },
  { selector: '.faded', style: { opacity: 0.35 } }
]

/**
 * Label and size of a unit node. The hotspot tag and the comment count are text, so they do not
 * depend on color. The size grows with the text, so the label stays inside the node.
 */
/** The end of an edge that a click goes to: the target, or the source when the target is the selected unit. */
function edgeDestination(edge: { source: string; target: string }, selectedId: string | undefined): string {
  return edge.target === selectedId ? edge.source : edge.target
}

/** Mark on a context unit that has a Claude explanation. */
const EXPLAINED_MARK = 'ⓘ'

/** Distance in pixels between the mouse and the hover box. */
const TOOLTIP_OFFSET = 14

/** The hover box opens toward the larger free side of the graph, so the graph edge does not cut it. */
function tooltipPlace(point: { x: number; y: number }, graph: HTMLElement | null): React.CSSProperties {
  const width = graph?.clientWidth ?? 0
  const height = graph?.clientHeight ?? 0
  return {
    ...(point.x > width / 2 ? { right: width - point.x + TOOLTIP_OFFSET } : { left: point.x + TOOLTIP_OFFSET }),
    ...(point.y > height / 2 ? { bottom: height - point.y + TOOLTIP_OFFSET } : { top: point.y + TOOLTIP_OFFSET })
  }
}

function nodeLabel(
  name: string,
  change: string | undefined,
  level: HotspotLevel | undefined,
  comments: number,
  explained = false
): { label: string; w: number; h: number } {
  const marks = [level ? LEVEL_TAG[level] : '', change ?? '', comments ? `💬${comments}` : '', explained ? EXPLAINED_MARK : ''].filter(Boolean).join('  ')
  const label = marks ? `${name}\n${marks}` : name
  const lines = label.split('\n')
  return { label, w: Math.max(...lines.map((l) => l.length)) * 6.4 + 16, h: lines.length * 14 + 10 }
}

export function GraphView({ model, selectedId, reviewed, hotspots, explanations, explaining, onExplain, onSelect }: Props): React.JSX.Element {
  const container = useRef<HTMLDivElement>(null)
  const cy = useRef<Core>(undefined)
  const focusedCluster = useRef<string>(undefined)
  const selectRef = useRef(onSelect)
  selectRef.current = onSelect
  const selectedRef = useRef(selectedId)
  selectedRef.current = selectedId
  const [hover, setHover] = useState<{ kind: 'node' | 'edge'; id: string; x: number; y: number }>()

  const commentCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const comment of model.comments) {
      if (comment.parentId !== -1 || !comment.file || comment.type === 'timeline') continue
      const node = nodeForComment(model, comment)
      if (node) counts.set(node.id, (counts.get(node.id) ?? 0) + 1)
    }
    return counts
  }, [model])
  const nodesById = useMemo(() => new Map(model.nodes.map((n) => [n.id, n])), [model.nodes])

  useEffect(() => {
    if (!container.current) return
    const colorOf = new Map(model.clusters.map((c, i) => [c.id, CLUSTER_COLORS[i % CLUSTER_COLORS.length]]))
    const elements: ElementDefinition[] = [
      ...model.clusters.map((c) => {
        const color = colorOf.get(c.id)!
        return { data: { id: c.id, label: `${c.label}   +${c.added} −${c.removed}`, color, textColor: textOn(color) } }
      }),
      ...model.nodes.map((n) => {
        const color = colorOf.get(n.clusterId ?? '') ?? '#2a2e37'
        return {
          data: {
            id: n.id,
            parent: n.role === 'changed' ? n.clusterId : undefined,
            ...nodeLabel(n.label, n.role === 'changed' ? `+${n.added} −${n.removed}` : undefined, undefined, 0),
            color,
            textColor: textOn(color)
          },
          classes: [n.kind === 'blueprint' ? 'blueprint' : '', n.role === 'context' ? 'context' : '', n.side === 'base' ? 'deleted' : ''].join(' ')
        }
      }),
      ...model.edges.map((e) => ({ data: { id: e.id, source: e.source, target: e.target }, classes: e.kind }))
    ]
    const instance = cytoscape({
      container: container.current,
      elements,
      style: STYLE,
      userPanningEnabled: false,
      boxSelectionEnabled: false,
      minZoom: 0.1,
      maxZoom: 3,
      layout: {
        name: 'fcose',
        quality: 'proof',
        animate: false,
        nodeDimensionsIncludeLabels: true,
        nodeRepulsion: 12000,
        idealEdgeLength: 110,
        nodeSeparation: 90,
        nestingFactor: 0.6,
        tilingPaddingVertical: 30,
        tilingPaddingHorizontal: 30
      } as cytoscape.LayoutOptions
    })
    instance.on('mouseover', 'node', (e) => {
      if (e.target.isParent()) return
      setHover({ kind: 'node', id: e.target.id(), x: e.renderedPosition.x, y: e.renderedPosition.y })
    })
    instance.on('mouseout', 'node', () => setHover(undefined))
    instance.on('mouseover', 'edge', (e) => {
      e.target.addClass('hovered')
      container.current!.style.cursor = 'pointer'
      setHover({ kind: 'edge', id: e.target.id(), x: e.renderedPosition.x, y: e.renderedPosition.y })
    })
    instance.on('mouseout', 'edge', (e) => {
      e.target.removeClass('hovered')
      container.current!.style.cursor = ''
      setHover(undefined)
    })
    instance.on('viewport grab', () => setHover(undefined))
    instance.on('tap', (e) => {
      if (e.target === instance) selectRef.current(undefined)
      else if (e.target.isNode()) selectRef.current(e.target.id())
      else if (e.target.isEdge()) selectRef.current(edgeDestination({ source: e.target.source().id(), target: e.target.target().id() }, selectedRef.current))
    })
    cy.current = instance
    focusedCluster.current = undefined
    const stopMouseNavigation = enableMouseNavigation(container.current, instance)
    const resizeObserver = new ResizeObserver(() => instance.resize())
    resizeObserver.observe(container.current)
    return () => {
      resizeObserver.disconnect()
      stopMouseNavigation()
      instance.destroy()
    }
  }, [model.key, model.nodes, model.edges, model.clusters])

  useEffect(() => {
    const instance = cy.current
    if (!instance) return
    instance.batch(() => {
      instance.elements().removeClass('selected faded highlight reviewed has-comments hotspot-high hotspot-medium hotspot-low')
      instance.nodes().forEach((n) => {
        const unit = nodesById.get(n.id())
        if (!unit) return
        if (reviewed.has(n.id())) n.addClass('reviewed')
        if (commentCounts.has(n.id())) n.addClass('has-comments')
        const level = hotspots.get(n.id())
        if (level) n.addClass(`hotspot-${level}`)
        const change = unit.role === 'changed' ? `+${unit.added} −${unit.removed}` : undefined
        n.data(nodeLabel(unit.label, change, level, commentCounts.get(n.id()) ?? 0, !!explanations[n.id()]))
      })
      const selected = selectedId ? instance.getElementById(selectedId) : undefined
      if (!selected || selected.empty()) return
      selected.addClass('selected')
      if (selected.isParent()) return
      const near = selected.closedNeighborhood()
      instance.elements().not(near).not(near.parents()).not(selected.parents()).addClass('faded')
      selected.connectedEdges().addClass('highlight')
    })
    const selected = selectedId ? instance.getElementById(selectedId) : undefined
    if (!selected || selected.empty()) return
    const cluster = selected.isParent() ? selected : selected.parent()
    if (cluster.nonempty() && cluster.first().id() !== focusedCluster.current) {
      focusedCluster.current = cluster.first().id()
      instance.animate({ fit: { eles: cluster, padding: 30 } }, { duration: 250 })
      return
    }
    const box = selected.renderedBoundingBox()
    if (box.x1 < 0 || box.y1 < 0 || box.x2 > instance.width() || box.y2 > instance.height()) {
      instance.animate({ center: { eles: selected } }, { duration: 200 })
    }
  }, [selectedId, reviewed, hotspots, commentCounts, explanations, nodesById, model.key])

  const contextIds = useMemo(() => model.nodes.filter((n) => n.role === 'context').map((n) => n.id), [model.nodes])
  const hovered = hover?.kind === 'node' ? nodesById.get(hover.id) : undefined
  const hoverExplanation = hovered ? explanations[hovered.id] : undefined
  const hoveredEdge = hover?.kind === 'edge' ? model.edges.find((e) => e.id === hover.id) : undefined
  const edgeEnd = (id: string): string => nodesById.get(id)?.qualifiedName ?? id

  return (
    <div className="graph-wrap">
      <div ref={container} className="graph" />
      {hover && hovered && (hoverExplanation || hovered.role === 'context') && (
        <div className="graph-tooltip" style={tooltipPlace(hover, container.current)}>
          <div className="qualified">{hovered.qualifiedName}</div>
          {hoverExplanation ? (
            <ExplanationText explanation={hoverExplanation} />
          ) : (
            <div className="muted">No explanation yet. Select the unit and click "Explain with Claude".</div>
          )}
        </div>
      )}
      {hover && hoveredEdge && (
        <div className="graph-tooltip" style={tooltipPlace(hover, container.current)}>
          <div className="qualified">{edgeEnd(hoveredEdge.source)}</div>
          <div className="muted">{hoveredEdge.kind === 'calls' ? '→ calls' : '┄ declares'}</div>
          <div className="qualified">{edgeEnd(hoveredEdge.target)}</div>
          <div className="muted">Click to go to {edgeEnd(edgeDestination(hoveredEdge, selectedId))}</div>
        </div>
      )}
      <div className="legend">
        <span>
          <i className="sw changed" /> changed
        </span>
        <span>
          <i className="sw context-unit" /> context (not changed)
        </span>
        <span>
          <i className="sw comments" /> 💬 has comments
        </span>
        <span title="Claude explained this context unit. Hover the node to read the text.">{EXPLAINED_MARK} explained</span>
        <span>
          <i className="sw deleted" /> deleted (struck through)
        </span>
        {hotspots.size > 0 && (
          <span title="Units that the AI pre-review asks you to check. ⚠H is high, ⚠M is medium, ⚠L is low. The glow has the same meaning.">
            <i className="sw hotspot" /> ⚠H / ⚠M / ⚠L AI hotspot
          </span>
        )}
        <span>→ calls</span>
        <span>┄ declares</span>
        <span
          className="muted"
          title={'Left button: click a node or an arrow to select, drag a node to move it.\nMiddle button: drag up to zoom in, down to zoom out.\nRight button: drag to pan.\nWheel: zoom.'}
        >
          🖱 LMB select, move · MMB zoom · RMB pan
        </span>
        {contextIds.length > 0 && (
          <ExplainButton ids={contextIds} explanations={explanations} explaining={explaining} onExplain={onExplain} label="Explain all context" />
        )}
        <button className="ghost" onClick={() => cy.current?.fit(undefined, 30)} title="Zoom and pan so that the whole graph is visible">
          Fit
        </button>
      </div>
    </div>
  )
}
