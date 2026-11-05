import type { Blueprint, BpGraph, BpNode, BpPin } from './types'

export type BpChange = 'added' | 'removed' | 'changed' | 'moved' | 'same'

export interface BpNodeDiff {
  node: BpNode
  /** The node in the base revision, when the node exists there. */
  base?: BpNode
  change: BpChange
  /** Readable lines that say what changed, for example "Duration: 1.0 -> 2.5". */
  details: string[]
}

export interface BpLinkDiff {
  /** The output side: node id and pin id. */
  from: { node: string; pin: string }
  to: { node: string; pin: string }
  category: string
  change: 'added' | 'removed' | 'same'
}

export interface BpGraphDiff {
  name: string
  nodes: BpNodeDiff[]
  links: BpLinkDiff[]
  /** Counts of changed nodes and links. A graph with no changes has all counts at 0. */
  added: number
  removed: number
  changed: number
}

/** Compares two revisions of a Blueprint. Nodes match by object name, pins match by pin GUID. */
export function diffBlueprint(base: Blueprint | undefined, head: Blueprint | undefined): BpGraphDiff[] {
  const names = new Set([...(head?.graphs ?? []).map((g) => g.name), ...(base?.graphs ?? []).map((g) => g.name)])
  return [...names].map((name) => diffGraph(name, base?.graphs.find((g) => g.name === name), head?.graphs.find((g) => g.name === name)))
}

export function graphChanged(graph: BpGraphDiff): boolean {
  return graph.added + graph.removed + graph.changed > 0
}

function diffGraph(name: string, base: BpGraph | undefined, head: BpGraph | undefined): BpGraphDiff {
  const baseNodes = new Map((base?.nodes ?? []).map((n) => [n.id, n]))
  const headNodes = new Map((head?.nodes ?? []).map((n) => [n.id, n]))
  const nodes: BpNodeDiff[] = []
  for (const node of headNodes.values()) {
    const old = baseNodes.get(node.id)
    if (!old) nodes.push({ node, change: 'added', details: [] })
    else {
      const details = nodeDetails(old, node)
      const moved = old.x !== node.x || old.y !== node.y
      nodes.push({ node, base: old, change: details.length > 0 ? 'changed' : moved ? 'moved' : 'same', details })
    }
  }
  for (const node of baseNodes.values()) {
    if (!headNodes.has(node.id)) nodes.push({ node, change: 'removed', details: [] })
  }

  const headLinks = linkSet(head)
  const baseLinks = linkSet(base)
  const links: BpLinkDiff[] = []
  for (const [key, link] of headLinks) links.push({ ...link, change: baseLinks.has(key) ? 'same' : 'added' })
  for (const [key, link] of baseLinks) if (!headLinks.has(key)) links.push({ ...link, change: 'removed' })

  const linkChanged = new Set<string>()
  for (const link of links) {
    if (link.change === 'same') continue
    linkChanged.add(link.from.node)
    linkChanged.add(link.to.node)
  }
  for (const diff of nodes) {
    if (diff.change !== 'same' && diff.change !== 'moved') continue
    if (!linkChanged.has(diff.node.id)) continue
    diff.change = 'changed'
    diff.details.push('Wires changed')
  }

  const count = (change: BpChange): number => nodes.filter((n) => n.change === change).length
  const linkCount = (change: 'added' | 'removed'): number => links.filter((l) => l.change === change).length
  return { name, nodes, links, added: count('added') + linkCount('added'), removed: count('removed') + linkCount('removed'), changed: count('changed') }
}

/** Collects each wire once, from the output pin to the input pin. */
function linkSet(graph: BpGraph | undefined): Map<string, Omit<BpLinkDiff, 'change'>> {
  const links = new Map<string, Omit<BpLinkDiff, 'change'>>()
  if (!graph) return links
  for (const node of graph.nodes) {
    for (const pin of node.pins) {
      if (pin.direction !== 'out') continue
      for (const target of pin.links) {
        links.set(`${node.id}/${pin.id}>${target.node}/${target.pin}`, { from: { node: node.id, pin: pin.id }, to: target, category: pin.category })
      }
    }
  }
  return links
}

function pinValue(pin: BpPin): string {
  return pin.value ?? ''
}

function nodeDetails(base: BpNode, head: BpNode): string[] {
  const details: string[] = []
  if (base.title !== head.title) details.push(`Title: ${base.title} -> ${head.title}`)
  if ((base.comment ?? '') !== (head.comment ?? '')) details.push(`Comment: ${base.comment ?? '(none)'} -> ${head.comment ?? '(none)'}`)
  const keys = new Set([...Object.keys(base.props), ...Object.keys(head.props)])
  for (const key of keys) {
    if (key === 'NodeComment') continue
    const a = base.props[key]
    const b = head.props[key]
    if (a !== b) details.push(`${key}: ${a ?? '(none)'} -> ${b ?? '(none)'}`)
  }
  const basePins = new Map(base.pins.map((p) => [p.id, p]))
  const headPins = new Map(head.pins.map((p) => [p.id, p]))
  for (const pin of head.pins) {
    const old = basePins.get(pin.id)
    if (!old) {
      if (!pin.hidden) details.push(`Pin added: ${pinLabel(pin)}`)
      continue
    }
    if (pinValue(old) !== pinValue(pin)) details.push(`${pinLabel(pin)}: ${pinValue(old) || '(default)'} -> ${pinValue(pin) || '(default)'}`)
    if (old.category !== pin.category || old.type !== pin.type) details.push(`${pinLabel(pin)} type: ${pinType(old)} -> ${pinType(pin)}`)
  }
  for (const pin of base.pins) {
    if (!headPins.has(pin.id) && !pin.hidden) details.push(`Pin removed: ${pinLabel(pin)}`)
  }
  return details
}

export function pinLabel(pin: BpPin): string {
  return pin.label || pin.name
}

export function pinType(pin: BpPin): string {
  const base = pin.type ? `${pin.category} ${pin.type}` : pin.category
  return pin.container ? `${pin.container} of ${base}` : base
}

/** A short text of the Blueprint changes, for the Claude prompts and the MCP tools. */
export function describeBlueprintDiff(path: string, graphs: BpGraphDiff[]): string {
  const lines = [`Blueprint ${path}`]
  for (const graph of graphs.filter(graphChanged)) {
    lines.push(`  Graph ${graph.name}:`)
    const title = (id: string): string => graph.nodes.find((n) => n.node.id === id)?.node.title ?? id
    const pinName = (node: string, pin: string): string => {
      const owner = graph.nodes.find((n) => n.node.id === node)
      const found = owner?.node.pins.find((p) => p.id === pin) ?? owner?.base?.pins.find((p) => p.id === pin)
      return found ? pinLabel(found) : '?'
    }
    for (const diff of graph.nodes) {
      if (diff.change === 'added') lines.push(`    + node ${diff.node.title}`)
      if (diff.change === 'removed') lines.push(`    - node ${diff.node.title}`)
      if (diff.change === 'changed') for (const detail of diff.details.filter((d) => d !== 'Wires changed')) lines.push(`    ~ ${diff.node.title}: ${detail}`)
    }
    for (const link of graph.links) {
      if (link.change === 'same') continue
      const sign = link.change === 'added' ? '+' : '-'
      lines.push(`    ${sign} wire ${title(link.from.node)}.${pinName(link.from.node, link.from.pin)} -> ${title(link.to.node)}.${pinName(link.to.node, link.to.pin)}`)
    }
  }
  return lines.join('\n')
}
