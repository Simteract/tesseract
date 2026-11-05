import { useEffect, useMemo, useRef, useState } from 'react'
import { type BpGraphDiff, type BpLinkDiff, type BpNodeDiff, graphChanged, pinLabel, pinType } from '../../shared/bpdiff'
import type { BpNode, BpPin, GraphNode, ReviewModel } from '../../shared/types'
import { DRAG_ZOOM_RATE, WHEEL_ZOOM_RATE } from './GraphView'

interface Props {
  model: ReviewModel
  node: GraphNode
}

/** Sizes of the drawn nodes, in graph units. The Blueprint editor uses a similar scale. */
const HEADER_HEIGHT = 26
const PIN_ROW = 20
const CHAR_WIDTH = 7
const MIN_NODE_WIDTH = 120
const PIN_COLUMN_GAP = 24

/** Zoom limits of the canvas. */
const MIN_ZOOM = 0.05
const MAX_ZOOM = 3

/** Wire colors by pin category, from the Okabe-Ito palette. Exec wires are white, like in the editor. */
const PIN_COLORS: Record<string, string> = {
  exec: '#f0f0f0',
  bool: '#cc79a7',
  real: '#009e73',
  float: '#009e73',
  double: '#009e73',
  int: '#56b4e9',
  int64: '#56b4e9',
  byte: '#56b4e9',
  string: '#e69f00',
  name: '#e69f00',
  text: '#e69f00',
  object: '#0072b2',
  class: '#0072b2',
  softobject: '#0072b2',
  struct: '#f0e442',
  delegate: '#d55e00',
  mcdelegate: '#d55e00'
}

/** The marks and the words that each change state shows, so no state depends on color alone. */
const CHANGE_MARK: Record<BpNodeDiff['change'], string> = {
  added: '+ added',
  removed: '− removed',
  changed: '~ changed',
  moved: '↔ moved',
  same: ''
}

interface Box {
  diff: BpNodeDiff
  x: number
  y: number
  width: number
  height: number
  inputs: BpPin[]
  outputs: BpPin[]
}

interface View {
  x: number
  y: number
  zoom: number
}

interface Point {
  x: number
  y: number
}

const MIDDLE_BUTTON = 1
const RIGHT_BUTTON = 2

/** A canvas drag. RMB pans. MMB zooms around point, the drag start on the canvas, like in the graph view. */
interface ViewDrag {
  button: number
  x: number
  y: number
  point: Point
  view: View
}

/** A node that the user drags with LMB. Start is the mouse position, and offset is the node offset when the drag began. */
interface NodeDrag {
  id: string
  start: Point
  offset: Point
}

/** Shows the changes of one Blueprint asset as node graphs, in place of the code diff. */
export function BlueprintPanel({ model, node }: Props): React.JSX.Element {
  const [graphs, setGraphs] = useState<BpGraphDiff[]>()
  const [graphName, setGraphName] = useState(graphFromUnit(node.id))
  const [selected, setSelected] = useState<string>()
  const [changesOnly, setChangesOnly] = useState(false)
  const [view, setView] = useState<View>({ x: 0, y: 0, zoom: 1 })
  const canvas = useRef<SVGSVGElement>(null)
  const drag = useRef<ViewDrag>(undefined)
  const nodeDrag = useRef<NodeDrag>(undefined)
  /** Moves that the user made in this view, by node id. They only change the drawing, never the asset. */
  const [offsets, setOffsets] = useState(new Map<string, Point>())

  useEffect(() => {
    let live = true
    setGraphs(undefined)
    window.api.getBlueprintDiff({ modelKey: model.key, path: node.file }).then((result) => live && setGraphs(result))
    return () => {
      live = false
    }
  }, [model.key, node.file])

  useEffect(() => {
    setGraphName(graphFromUnit(node.id))
    setSelected(undefined)
  }, [node.id])

  const graph = graphs?.find((g) => g.name === graphName) ?? graphs?.find(graphChanged) ?? graphs?.[0]
  const savedBoxes = useMemo(() => (graph ? layout(graph) : new Map<string, Box>()), [graph])
  const boxes = useMemo(() => moveBoxes(savedBoxes, offsets), [savedBoxes, offsets])

  useEffect(() => setOffsets(new Map()), [savedBoxes])

  const fit = (onlyChanged: boolean): void => {
    const element = canvas.current
    if (!element || boxes.size === 0) return
    const all = [...boxes.values()].filter((b) => b.diff.node.className !== 'EdGraphNode_Comment')
    const changed = all.filter((b) => b.diff.change !== 'same')
    const target = onlyChanged && changed.length > 0 ? changed : all
    if (target.length === 0) return
    const left = Math.min(...target.map((b) => b.x)) - 60
    const top = Math.min(...target.map((b) => b.y)) - 60
    const right = Math.max(...target.map((b) => b.x + b.width)) + 60
    const bottom = Math.max(...target.map((b) => b.y + b.height)) + 60
    const zoom = clamp(Math.min(element.clientWidth / (right - left), element.clientHeight / (bottom - top)), MIN_ZOOM, 1.2)
    setView({ zoom, x: (element.clientWidth - (right - left) * zoom) / 2 - left * zoom, y: (element.clientHeight - (bottom - top) * zoom) / 2 - top * zoom })
  }

  useEffect(() => fit(true), [savedBoxes])

  const focus = (id: string): void => {
    const box = boxes.get(id)
    const element = canvas.current
    setSelected(id)
    if (!box || !element) return
    const zoom = Math.max(view.zoom, 0.8)
    setView({ zoom, x: element.clientWidth / 2 - (box.x + box.width / 2) * zoom, y: element.clientHeight / 2 - (box.y + box.height / 2) * zoom })
  }

  const onWheel = (e: React.WheelEvent): void => {
    const rect = canvas.current!.getBoundingClientRect()
    const px = e.clientX - rect.left
    const py = e.clientY - rect.top
    const zoom = clamp(view.zoom * Math.exp(-e.deltaY * WHEEL_ZOOM_RATE), MIN_ZOOM, MAX_ZOOM)
    const scale = zoom / view.zoom
    setView({ zoom, x: px - (px - view.x) * scale, y: py - (py - view.y) * scale })
  }

  const onMouseDown = (e: React.MouseEvent): void => {
    if (e.button !== MIDDLE_BUTTON && e.button !== RIGHT_BUTTON) return
    e.preventDefault()
    const rect = canvas.current!.getBoundingClientRect()
    drag.current = { button: e.button, x: e.clientX, y: e.clientY, point: { x: e.clientX - rect.left, y: e.clientY - rect.top }, view }
  }
  const startNodeDrag = (id: string, e: React.MouseEvent): void => {
    if (e.button !== 0) return
    e.stopPropagation()
    setSelected(id)
    nodeDrag.current = { id, start: { x: e.clientX, y: e.clientY }, offset: offsets.get(id) ?? { x: 0, y: 0 } }
  }
  const onMouseMove = (e: React.MouseEvent): void => {
    const moving = nodeDrag.current
    if (moving) {
      const offset = { x: moving.offset.x + (e.clientX - moving.start.x) / view.zoom, y: moving.offset.y + (e.clientY - moving.start.y) / view.zoom }
      setOffsets((old) => new Map(old).set(moving.id, offset))
      return
    }
    const start = drag.current
    if (!start) return
    if (start.button === RIGHT_BUTTON) {
      setView({ ...start.view, x: start.view.x + e.clientX - start.x, y: start.view.y + e.clientY - start.y })
      return
    }
    const zoom = clamp(start.view.zoom * Math.exp((start.y - e.clientY) * DRAG_ZOOM_RATE), MIN_ZOOM, MAX_ZOOM)
    const scale = zoom / start.view.zoom
    const { x: px, y: py } = start.point
    setView({ zoom, x: px - (px - start.view.x) * scale, y: py - (py - start.view.y) * scale })
  }
  const endDrag = (): void => {
    drag.current = undefined
    nodeDrag.current = undefined
  }

  if (!graphs) return <div className="bp-panel muted bp-empty">Reading the Blueprint…</div>
  if (graphs.length === 0 || !graph) {
    return <div className="bp-panel muted bp-empty">This asset has no Blueprint graphs, or the reader cannot read its format.</div>
  }

  const changes = graph.nodes.filter((n) => n.change !== 'same' && n.change !== 'moved' && n.node.className !== 'EdGraphNode_Comment')
  const selectedDiff = selected ? graph.nodes.find((n) => n.node.id === selected) : undefined
  const comments = [...boxes.values()].filter((b) => b.diff.node.className === 'EdGraphNode_Comment')
  const nodeBoxes = [...boxes.values()]
    .filter((b) => b.diff.node.className !== 'EdGraphNode_Comment')
    .sort((a, b) => Number(a.diff.node.id === selected) - Number(b.diff.node.id === selected))

  return (
    <div className="bp-panel">
      <div className="bp-toolbar">
        {graphs.map((g) => (
          <button
            key={g.name}
            className={`ghost small bp-tab ${g.name === graph.name ? 'on' : ''} ${graphChanged(g) ? '' : 'unchanged'}`}
            onClick={() => {
              setGraphName(g.name)
              setSelected(undefined)
            }}
            title={graphChanged(g) ? `${g.added} added, ${g.removed} removed, ${g.changed} changed (nodes and wires)` : 'No changes in this graph'}
          >
            {g.name}
            {graphChanged(g) && <span className="bp-counts"> +{g.added} −{g.removed} ~{g.changed}</span>}
          </button>
        ))}
        <span className="bp-spacer" />
        <label className="bp-check" title="Fade the nodes that did not change">
          <input type="checkbox" checked={changesOnly} onChange={(e) => setChangesOnly(e.target.checked)} /> Fade unchanged
        </label>
        {offsets.size > 0 && (
          <button className="ghost small" onClick={() => setOffsets(new Map())} title="Put the nodes that you moved back to their places in the asset">
            Reset moves
          </button>
        )}
        <button className="ghost small" onClick={() => fit(true)} title="Zoom to the changed nodes">
          Fit changes
        </button>
        <button className="ghost small" onClick={() => fit(false)} title="Zoom to the whole graph">
          Fit all
        </button>
      </div>
      <div className="bp-body">
        <div className="bp-stage">
          <svg
            ref={canvas}
            className="bp-canvas"
            onWheel={onWheel}
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onMouseUp={endDrag}
            onMouseLeave={endDrag}
            onContextMenu={(e) => e.preventDefault()}
            onClick={(e) => e.target === canvas.current && setSelected(undefined)}
          >
            <defs>
              <pattern id="bp-grid" width="16" height="16" patternUnits="userSpaceOnUse" patternTransform={`translate(${view.x} ${view.y}) scale(${view.zoom})`}>
                <path d="M 16 0 L 0 0 0 16" fill="none" stroke="#262a31" strokeWidth={1 / view.zoom} />
              </pattern>
            </defs>
            <rect width="100%" height="100%" fill="url(#bp-grid)" pointerEvents="none" />
            <g transform={`translate(${view.x} ${view.y}) scale(${view.zoom})`}>
              {comments.map((box) => (
                <g key={box.diff.node.id} className={`bp-comment ${box.diff.change}`}>
                  <rect x={box.x} y={box.y} width={box.width} height={box.height} rx={4} />
                  <text x={box.x + 8} y={box.y + 18}>
                    {box.diff.node.title.split('\n')[0]}
                  </text>
                </g>
              ))}
              {graph.links.map((link) => (
                <Wire key={`${link.from.node}/${link.from.pin}>${link.to.node}/${link.to.pin}/${link.change}`} link={link} boxes={boxes} faded={changesOnly && link.change === 'same'} />
              ))}
              {nodeBoxes.map((box) => (
                <NodeBox key={`${box.diff.node.id}/${box.diff.change}`} box={box} selected={box.diff.node.id === selected} faded={changesOnly && (box.diff.change === 'same' || box.diff.change === 'moved')} onMouseDown={(e) => startNodeDrag(box.diff.node.id, e)} />
              ))}
            </g>
          </svg>
          <BlueprintLegend />
        </div>
        <aside className="bp-side">
          {selectedDiff ? (
            <NodeDetails diff={selectedDiff} onClose={() => setSelected(undefined)} />
          ) : (
            <>
              <div className="bp-side-title">Changes in {graph.name}</div>
              {changes.length === 0 && <div className="muted">Only wires or positions changed.</div>}
              {changes.map((n) => (
                <button key={`${n.node.id}/${n.change}`} className={`bp-change ${n.change}`} onClick={() => focus(n.node.id)}>
                  <span className="bp-mark">{CHANGE_MARK[n.change]}</span>
                  <span className="bp-change-title">{n.node.title}</span>
                  {n.details.slice(0, 3).map((d) => (
                    <span key={d} className="bp-detail">
                      {d}
                    </span>
                  ))}
                </button>
              ))}
            </>
          )}
        </aside>
      </div>
    </div>
  )
}

/** Each state has a mark and a line style, so the legend works without color. The mouse keys match the graph view. */
function BlueprintLegend(): React.JSX.Element {
  return (
    <div className="legend">
      <span>
        <i className="sw bp-added" /> {CHANGE_MARK.added}
      </span>
      <span>
        <i className="sw bp-removed" /> {CHANGE_MARK.removed} (dashed, struck through)
      </span>
      <span>
        <i className="sw bp-changed" /> {CHANGE_MARK.changed} (dotted)
      </span>
      <span title="Only the position of the node changed">{CHANGE_MARK.moved} (position only)</span>
      <span>━ added wire (thick)</span>
      <span>╍ removed wire (dashed)</span>
      <span>~ pin value changed</span>
      <span
        className="muted"
        title={'Left button: click a node to select it, drag a node to move it.\nMiddle button: drag up to zoom in, down to zoom out.\nRight button: drag to pan.\nWheel: zoom.'}
      >
        🖱 LMB select, move · MMB zoom · RMB pan
      </span>
    </div>
  )
}

function NodeBox({ box, selected, faded, onMouseDown }: { box: Box; selected: boolean; faded: boolean; onMouseDown(e: React.MouseEvent): void }): React.JSX.Element {
  const { diff, x, y, width, height, inputs, outputs } = box
  const mark = CHANGE_MARK[diff.change]
  return (
    <g className={`bp-node ${diff.change} ${selected ? 'selected' : ''} ${faded ? 'faded' : ''}`} onMouseDown={onMouseDown}>
      <title>{[diff.node.title, diff.node.className, diff.node.comment, ...diff.details, diff.node.error ? `Read error: ${diff.node.error}` : ''].filter(Boolean).join('\n')}</title>
      <rect className="bp-node-body" x={x} y={y} width={width} height={height} rx={6} />
      <rect className="bp-node-header" x={x} y={y} width={width} height={HEADER_HEIGHT} rx={6} />
      <text className="bp-node-title" x={x + 8} y={y + 17}>
        {diff.node.title}
      </text>
      {mark && (
        <text className="bp-node-mark" x={x + width - 6} y={y - 6} textAnchor="end">
          {mark}
        </text>
      )}
      {inputs.map((pin, i) => (
        <PinRow key={pin.id} pin={pin} base={diff.base} x={x} y={pinY(y, i)} side="in" />
      ))}
      {outputs.map((pin, i) => (
        <PinRow key={pin.id} pin={pin} base={diff.base} x={x + width} y={pinY(y, i)} side="out" />
      ))}
    </g>
  )
}

function PinRow({ pin, base, x, y, side }: { pin: BpPin; base?: BpNode; x: number; y: number; side: 'in' | 'out' }): React.JSX.Element {
  const color = PIN_COLORS[pin.category] ?? '#9aa3b2'
  const old = base?.pins.find((p) => p.id === pin.id)
  const valueChanged = !!old && (old.value ?? '') !== (pin.value ?? '')
  const label = pinLabel(pin) === 'execute' || pinLabel(pin) === 'then' ? '' : pinLabel(pin)
  const value = side === 'in' && pin.links.length === 0 && pin.value ? ` = ${short(pin.value)}` : ''
  const shape =
    pin.category === 'exec' ? (
      <path d={`M ${x - 5} ${y - 5} L ${x + 1} ${y - 5} L ${x + 6} ${y} L ${x + 1} ${y + 5} L ${x - 5} ${y + 5} Z`} fill={pin.links.length ? color : 'none'} stroke={color} />
    ) : (
      <circle cx={x} cy={y} r={4.5} fill={pin.links.length ? color : 'none'} stroke={color} strokeWidth={1.5} />
    )
  return (
    <g className={`bp-pin ${valueChanged ? 'value-changed' : ''}`}>
      <title>{`${pinLabel(pin)}: ${pinType(pin)}${pin.value ? `\nValue: ${pin.value}` : ''}${valueChanged ? `\nBefore: ${old?.value || '(default)'}` : ''}`}</title>
      {shape}
      <text x={side === 'in' ? x + 10 : x - 10} y={y + 4} textAnchor={side === 'in' ? 'start' : 'end'}>
        {valueChanged ? '~ ' : ''}
        {label}
        {value}
      </text>
    </g>
  )
}

function Wire({ link, boxes, faded }: { link: BpLinkDiff; boxes: Map<string, Box>; faded: boolean }): React.JSX.Element | null {
  const from = pinPoint(boxes, link.from.node, link.from.pin, link.change === 'removed')
  const to = pinPoint(boxes, link.to.node, link.to.pin, link.change === 'removed')
  if (!from || !to) return null
  const bend = Math.max(40, Math.abs(to.x - from.x) / 2)
  const color = link.change === 'added' ? '#56b4e9' : link.change === 'removed' ? '#d55e00' : (PIN_COLORS[link.category] ?? '#9aa3b2')
  return (
    <path
      className={`bp-wire ${link.change} ${faded ? 'faded' : ''}`}
      d={`M ${from.x} ${from.y} C ${from.x + bend} ${from.y}, ${to.x - bend} ${to.y}, ${to.x} ${to.y}`}
      stroke={color}
    />
  )
}

/** Finds the drawn position of a pin. A removed wire can end at a pin that exists only in the base node. */
function pinPoint(boxes: Map<string, Box>, nodeId: string, pinId: string, preferBase: boolean): { x: number; y: number } | undefined {
  const box = boxes.get(nodeId)
  if (!box) return undefined
  const inIndex = box.inputs.findIndex((p) => p.id === pinId)
  if (inIndex >= 0) return { x: box.x, y: pinY(box.y, inIndex) }
  const outIndex = box.outputs.findIndex((p) => p.id === pinId)
  if (outIndex >= 0) return { x: box.x + box.width, y: pinY(box.y, outIndex) }
  const basePin = preferBase ? box.diff.base?.pins.find((p) => p.id === pinId) : undefined
  return { x: basePin?.direction === 'out' ? box.x + box.width : box.x, y: box.y + HEADER_HEIGHT / 2 }
}

function NodeDetails({ diff, onClose }: { diff: BpNodeDiff; onClose(): void }): React.JSX.Element {
  const pins = diff.node.pins.filter((p) => !p.hidden)
  return (
    <div className="bp-details">
      <div className="bp-side-title">
        {diff.node.title}
        <button className="ghost small" onClick={onClose} title="Back to the list of changes">
          ✕
        </button>
      </div>
      <div className="muted">{diff.node.className}</div>
      {CHANGE_MARK[diff.change] && <div className={`bp-mark ${diff.change}`}>{CHANGE_MARK[diff.change]}</div>}
      {diff.node.comment && <div className="bp-node-comment">💬 {diff.node.comment}</div>}
      {diff.details.length > 0 && (
        <>
          <div className="bp-side-subtitle">What changed</div>
          {diff.details.map((d) => (
            <div key={d} className="bp-detail">
              {d}
            </div>
          ))}
        </>
      )}
      <div className="bp-side-subtitle">Pins</div>
      {pins.map((p) => (
        <div key={p.id} className="bp-detail">
          {p.direction === 'in' ? '→' : '←'} {pinLabel(p)} <span className="muted">({pinType(p)})</span>
          {p.value ? ` = ${p.value}` : ''}
        </div>
      ))}
      {Object.keys(diff.node.props).length > 0 && (
        <>
          <div className="bp-side-subtitle">Properties</div>
          {Object.entries(diff.node.props).map(([k, v]) => (
            <div key={k} className="bp-detail">
              {k}: <span className="muted">{v}</span>
            </div>
          ))}
        </>
      )}
      {diff.node.error && <div className="error">The reader stopped in this node: {diff.node.error}</div>}
    </div>
  )
}

function layout(graph: BpGraphDiff): Map<string, Box> {
  const boxes = new Map<string, Box>()
  for (const diff of graph.nodes) {
    const node = diff.node
    const visible = node.pins.filter((p) => !p.hidden)
    const inputs = visible.filter((p) => p.direction === 'in')
    const outputs = visible.filter((p) => p.direction === 'out')
    if (node.className === 'EdGraphNode_Comment') {
      boxes.set(node.id, { diff, x: node.x, y: node.y, width: node.width ?? 400, height: node.height ?? 200, inputs, outputs })
      continue
    }
    const pinText = (pins: BpPin[]): number => Math.max(0, ...pins.map((p) => pinLabel(p).length + (p.value ? short(p.value).length + 3 : 0)))
    const width = Math.max(MIN_NODE_WIDTH, node.title.length * CHAR_WIDTH + 24, (pinText(inputs) + pinText(outputs)) * CHAR_WIDTH + PIN_COLUMN_GAP + 30)
    const height = HEADER_HEIGHT + Math.max(inputs.length, outputs.length, 1) * PIN_ROW + 8
    boxes.set(node.id, { diff, x: node.x, y: node.y, width, height, inputs, outputs })
  }
  return boxes
}

/** Applies the user moves to the boxes. Wires follow, because they read the pin points from the moved boxes. */
function moveBoxes(boxes: Map<string, Box>, offsets: Map<string, Point>): Map<string, Box> {
  if (offsets.size === 0) return boxes
  const moved = new Map(boxes)
  for (const [id, offset] of offsets) {
    const box = boxes.get(id)
    if (box) moved.set(id, { ...box, x: box.x + offset.x, y: box.y + offset.y })
  }
  return moved
}

function pinY(top: number, index: number): number {
  return top + HEADER_HEIGHT + 12 + index * PIN_ROW
}

function short(value: string): string {
  return value.length > 24 ? `${value.slice(0, 22)}…` : value
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function graphFromUnit(unitId: string): string {
  const at = unitId.lastIndexOf('::bp:')
  return at >= 0 ? unitId.slice(at + 5) : ''
}
