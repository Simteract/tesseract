import { structuredPatch } from 'diff'
import { basename, posix } from 'node:path'
import { type AssetDiff, assetChanged } from '../shared/assetdiff'
import { type BpGraphDiff, graphChanged } from '../shared/bpdiff'
import type { Cluster, FileChange, GraphEdge, GraphNode } from '../shared/types'
import type { ParsedFile, ParsedFunction } from './cpp'
import { isCodePath, parseSource } from './languages'

/** Most context nodes one changed node pulls in, per direction. More turns the graph into a hairball. */
const CONTEXT_LIMIT = 6

/** A call name that matches more definitions than this is too ambiguous to draw as an edge. */
const AMBIGUOUS_MATCHES = 2

const RUST_FOLDER_MODULES = ['mod', 'lib', 'main']

interface HeadFunction {
  file: string
  fn: ParsedFunction
  nodeId?: string
}

interface LineChanges {
  added: Set<number>
  removed: Set<number>
}

export interface Graph {
  nodes: GraphNode[]
  edges: GraphEdge[]
  clusters: Cluster[]
}

/**
 * Builds the graph of changed units. `blueprints` holds the Blueprint diff of each changed
 * Blueprint asset, by path. Each changed Blueprint graph becomes one unit. `assets` holds the
 * property diff of each changed asset, by path. A changed property diff becomes one more unit.
 */
export async function buildGraph(files: FileChange[], contents: Map<number, string>, blueprints = new Map<string, BpGraphDiff[]>(), assets = new Map<string, AssetDiff>()): Promise<Graph> {
  const nodes = new Map<string, GraphNode>()
  const edges = new Map<string, GraphEdge>()
  const headFunctions: HeadFunction[] = []
  const deletedCalls = new Map<string, ParsedFunction>()
  const blueprintCalls: { nodeId: string; calls: BlueprintCall[] }[] = []

  for (const file of files) {
    const changedGraphs = (blueprints.get(file.path) ?? []).filter(graphChanged)
    const assetDiff = assets.get(file.path)
    for (const graph of changedGraphs) {
      const node = addNode(nodes, blueprintNode(file, graph))
      blueprintCalls.push({ nodeId: node.id, calls: calledFunctions(graph) })
    }
    if (assetChanged(assetDiff)) addNode(nodes, assetNode(file, assetDiff))
    if (changedGraphs.length > 0 || assetChanged(assetDiff)) continue
    const head = contents.get(file.headRevId)
    const base = contents.get(file.baseRevId)
    const changes = lineChanges(base ?? '', head ?? '')
    if (!file.isCode || (head === undefined && base === undefined)) {
      addNode(nodes, fileNode(file, changes))
      continue
    }
    const headParsed = head !== undefined ? await parseSource(file.path, head) : { functions: [], classes: [] }
    const baseParsed = base !== undefined ? await parseSource(file.path, base) : { functions: [], classes: [] }
    const headIds = new Map<ParsedFunction, string>()
    for (const fn of headParsed.functions) headFunctions.push({ file: file.path, fn })

    const unitFor = (line: number, side: 'head' | 'base'): GraphNode => {
      const parsed = side === 'head' ? headParsed : baseParsed
      const fn = innermost(parsed.functions, line)
      if (fn) {
        const headFn = side === 'head' ? fn : headParsed.functions.find((h) => h.qualifiedName === fn.qualifiedName)
        if (headFn) {
          const node = functionNode(file.path, headFn, 'head')
          headIds.set(headFn, node.id)
          return addNode(nodes, node)
        }
        const deleted = addNode(nodes, functionNode(file.path, fn, 'base'))
        deletedCalls.set(deleted.id, fn)
        return deleted
      }
      const cls = innermost(parsed.classes, line)
      if (cls) {
        const headCls = side === 'head' ? cls : headParsed.classes.find((h) => h.name === cls.name)
        return addNode(nodes, declarationsNode(file.path, headCls ?? cls, headCls ? 'head' : 'base'))
      }
      return addNode(nodes, fileNode(file, { added: new Set(), removed: new Set() }))
    }

    for (const line of changes.added) unitFor(line, 'head').added++
    for (const line of changes.removed) unitFor(line, 'base').removed++
    for (const entry of headFunctions) {
      if (entry.file === file.path && headIds.has(entry.fn)) entry.nodeId = headIds.get(entry.fn)
    }
  }

  linkCalls(nodes, edges, headFunctions, deletedCalls)
  linkBlueprintCalls(nodes, edges, headFunctions, blueprintCalls)
  linkDeclarations(nodes, edges)
  const clusters = clusterNodes(nodes, edges)
  assignReadingOrder(nodes, edges, clusters)
  return { nodes: [...nodes.values()], edges: [...edges.values()], clusters }
}

function lineChanges(base: string, head: string): LineChanges {
  const added = new Set<number>()
  const removed = new Set<number>()
  if (base === head) return { added, removed }
  for (const hunk of structuredPatch('base', 'head', base, head, '', '', { context: 0 }).hunks) {
    let oldLine = hunk.oldStart
    let newLine = hunk.newStart
    for (const line of hunk.lines) {
      if (line.startsWith('+')) added.add(newLine++)
      else if (line.startsWith('-')) removed.add(oldLine++)
      else if (line.startsWith(' ')) {
        oldLine++
        newLine++
      }
    }
  }
  return { added, removed }
}

function innermost<T extends { startLine: number; endLine: number }>(ranges: T[], line: number): T | undefined {
  let best: T | undefined
  for (const range of ranges) {
    if (line < range.startLine || line > range.endLine) continue
    if (!best || range.endLine - range.startLine < best.endLine - best.startLine) best = range
  }
  return best
}

function addNode(nodes: Map<string, GraphNode>, node: GraphNode): GraphNode {
  const existing = nodes.get(node.id)
  if (existing) {
    if (node.role === 'changed') existing.role = 'changed'
    return existing
  }
  nodes.set(node.id, node)
  return node
}

function functionNode(file: string, fn: ParsedFunction, side: 'head' | 'base', role: GraphNode['role'] = 'changed'): GraphNode {
  return {
    id: `${file}::${fn.qualifiedName}::${side}${fn.startLine}`,
    label: `${fn.name}()`,
    qualifiedName: fn.qualifiedName,
    className: fn.className,
    kind: 'function',
    role,
    file,
    startLine: fn.startLine,
    endLine: fn.endLine,
    side,
    added: 0,
    removed: 0
  }
}

function declarationsNode(file: string, cls: ParsedFile['classes'][number], side: 'head' | 'base'): GraphNode {
  return {
    id: `${file}::${cls.name}::declarations`,
    label: `${cls.name} { }`,
    qualifiedName: cls.name,
    className: cls.name,
    kind: 'declarations',
    role: 'changed',
    file,
    startLine: cls.startLine,
    endLine: cls.endLine,
    side,
    added: 0,
    removed: 0
  }
}

/** The unit id of a Blueprint graph. The Blueprint view reads the graph name back from the id. */
export function blueprintUnitId(path: string, graph: string): string {
  return `${path}::bp:${graph}`
}

function blueprintNode(file: FileChange, graph: BpGraphDiff): GraphNode {
  const asset = basename(file.path).replace(/\.uasset$/i, '')
  return {
    id: blueprintUnitId(file.path, graph.name),
    label: `${asset}.${graph.name}`,
    qualifiedName: `${asset}::${graph.name}`,
    kind: 'blueprint',
    role: 'changed',
    file: file.path,
    startLine: 1,
    endLine: 1,
    side: file.status === 'D' ? 'base' : 'head',
    added: graph.added,
    removed: graph.removed
  }
}

/** The unit id of the property diff of an asset. */
export function assetUnitId(path: string): string {
  return `${path}::asset`
}

function assetNode(file: FileChange, diff: AssetDiff): GraphNode {
  const asset = basename(file.path).replace(/\.uasset$/i, '')
  const suffix = diff.kind === 'table' ? ' rows' : diff.kind === 'defaults' ? '.Defaults' : ''
  return {
    id: assetUnitId(file.path),
    label: `${asset}${suffix}`,
    qualifiedName: `${asset}${suffix.replace('.', '::')}`,
    kind: 'asset',
    role: 'changed',
    file: file.path,
    startLine: 1,
    endLine: 1,
    side: file.status === 'D' ? 'base' : 'head',
    added: diff.added + diff.changed,
    removed: diff.removed + diff.changed
  }
}

interface BlueprintCall {
  name: string
  owner?: string
}

/** Lists the functions that the changed nodes of a Blueprint graph call. */
function calledFunctions(graph: BpGraphDiff): BlueprintCall[] {
  const calls: BlueprintCall[] = []
  for (const diff of graph.nodes) {
    if (diff.change === 'same' || diff.change === 'moved') continue
    const ref = diff.node.props.FunctionReference
    if (!ref) continue
    try {
      const parsed = JSON.parse(ref) as { MemberName?: string; MemberParent?: string }
      if (parsed.MemberName) calls.push({ name: parsed.MemberName, owner: parsed.MemberParent })
    } catch {
      continue
    }
  }
  return calls
}

/**
 * Links Blueprint units to the C++ functions that they call. A Blueprint names the class without
 * the U or A prefix, so the match accepts both prefixes.
 */
function linkBlueprintCalls(nodes: Map<string, GraphNode>, edges: Map<string, GraphEdge>, headFunctions: HeadFunction[], blueprintCalls: { nodeId: string; calls: BlueprintCall[] }[]): void {
  for (const { nodeId, calls } of blueprintCalls) {
    let added = 0
    for (const call of calls) {
      if (added >= CONTEXT_LIMIT) break
      const owners = call.owner ? [call.owner, `U${call.owner}`, `A${call.owner}`] : []
      const matches = headFunctions.filter((h) => h.fn.name === call.name && (owners.length === 0 || owners.includes(h.fn.className ?? '')))
      if (matches.length === 0 || matches.length > AMBIGUOUS_MATCHES) continue
      for (const match of matches) {
        const target = match.nodeId ? nodes.get(match.nodeId) : addNode(nodes, functionNode(match.file, match.fn, 'head', 'context'))
        if (!target) continue
        addEdge(edges, nodeId, target.id, 'calls')
        added++
      }
    }
  }
}

function fileNode(file: FileChange, changes: LineChanges): GraphNode {
  return {
    id: `${file.path}::file`,
    label: basename(file.path),
    qualifiedName: file.path,
    kind: 'file',
    role: 'changed',
    file: file.path,
    startLine: 1,
    endLine: 1,
    side: file.status === 'D' ? 'base' : 'head',
    added: changes.added.size,
    removed: changes.removed.size
  }
}

function addEdge(edges: Map<string, GraphEdge>, source: string, target: string, kind: GraphEdge['kind']): void {
  if (source === target) return
  const id = `${kind}:${source}->${target}`
  if (!edges.has(id)) edges.set(id, { id, source, target, kind })
}

/** Draws call edges by name. Only names that resolve to the caller's class or to few definitions count. */
function linkCalls(
  nodes: Map<string, GraphNode>,
  edges: Map<string, GraphEdge>,
  headFunctions: HeadFunction[],
  deletedCalls: Map<string, ParsedFunction>
): void {
  const byName = new Map<string, HeadFunction[]>()
  for (const entry of headFunctions) {
    const list = byName.get(entry.fn.name) ?? []
    list.push(entry)
    byName.set(entry.fn.name, list)
  }
  const resolve = (callerClass: string | undefined, name: string): HeadFunction[] => {
    const candidates = byName.get(name) ?? []
    const sameClass = candidates.filter((c) => callerClass && c.fn.className === callerClass)
    if (sameClass.length > 0) return sameClass
    return candidates.length <= AMBIGUOUS_MATCHES ? candidates : []
  }
  const nodeFor = (entry: HeadFunction): GraphNode =>
    entry.nodeId ? nodes.get(entry.nodeId)! : addNode(nodes, functionNode(entry.file, entry.fn, 'head', 'context'))

  const callers: { id: string; fn: ParsedFunction }[] = [
    ...headFunctions.filter((e) => e.nodeId).map((e) => ({ id: e.nodeId!, fn: e.fn })),
    ...[...deletedCalls].map(([id, fn]) => ({ id, fn }))
  ]
  for (const caller of callers) {
    let contextCount = 0
    for (const name of caller.fn.calls) {
      for (const target of resolve(caller.fn.className, name)) {
        if (!target.nodeId && contextCount >= CONTEXT_LIMIT) continue
        if (!target.nodeId) contextCount++
        addEdge(edges, caller.id, nodeFor(target).id, 'calls')
      }
    }
  }

  const callerCount = new Map<string, number>()
  for (const entry of headFunctions) {
    if (entry.nodeId) continue
    for (const name of entry.fn.calls) {
      for (const target of resolve(entry.fn.className, name)) {
        if (!target.nodeId) continue
        const count = callerCount.get(target.nodeId) ?? 0
        if (count >= CONTEXT_LIMIT) continue
        callerCount.set(target.nodeId, count + 1)
        addEdge(edges, nodeFor(entry).id, target.nodeId, 'calls')
      }
    }
  }
}

function linkDeclarations(nodes: Map<string, GraphNode>, edges: Map<string, GraphEdge>): void {
  const all = [...nodes.values()]
  for (const decl of all.filter((n) => n.kind === 'declarations')) {
    for (const fn of all) {
      if (fn.kind === 'function' && fn.role === 'changed' && fn.className === decl.className) {
        addEdge(edges, decl.id, fn.id, 'declares')
      }
    }
  }
}

/** Groups changed nodes that belong together: linked by an edge, in the same class, or free code in the same file pair. */
function clusterNodes(nodes: Map<string, GraphNode>, edges: Map<string, GraphEdge>): Cluster[] {
  const changed = [...nodes.values()].filter((n) => n.role === 'changed')
  const parent = new Map(changed.map((n) => [n.id, n.id]))
  const find = (id: string): string => {
    let root = id
    while (parent.get(root) !== root) root = parent.get(root)!
    parent.set(id, root)
    return root
  }
  const union = (a: string, b: string): void => {
    if (parent.has(a) && parent.has(b)) parent.set(find(a), find(b))
  }
  for (const edge of edges.values()) union(edge.source, edge.target)
  const groupKeys = (n: GraphNode): string[] =>
    isCodePath(n.file) ? [`stem:${pairKey(n.file)}`, ...(n.className ? [`class:${n.className}`] : [])] : [`dir:${posix.dirname(n.file)}`]
  const firstInGroup = new Map<string, string>()
  for (const node of changed) {
    for (const key of groupKeys(node)) {
      const first = firstInGroup.get(key)
      if (first) union(first, node.id)
      else firstInGroup.set(key, node.id)
    }
  }

  const groups = new Map<string, GraphNode[]>()
  for (const node of changed) {
    const root = find(node.id)
    groups.set(root, [...(groups.get(root) ?? []), node])
  }
  const clusters = [...groups.values()]
    .map((members) => ({
      members,
      added: members.reduce((sum, n) => sum + n.added, 0),
      removed: members.reduce((sum, n) => sum + n.removed, 0)
    }))
    .sort((a, b) => b.added + b.removed - (a.added + a.removed))
    .map(({ members, added, removed }, index): Cluster => {
      const id = `c${index}`
      for (const node of members) node.clusterId = id
      return { id, label: clusterLabel(members), nodeIds: members.map((n) => n.id), files: [...new Set(members.map((n) => n.file))], added, removed }
    })
  return clusters
}

function clusterLabel(members: GraphNode[]): string {
  const classes = [...new Set(members.map((n) => n.className).filter((c): c is string => !!c))]
  if (classes.length > 0) return classes.length > 2 ? `${classes.slice(0, 2).join(' + ')} +${classes.length - 2}` : classes.join(' + ')
  if (members.every((n) => !isCodePath(n.file))) return posix.basename(posix.dirname(members[0].file)) + '/'
  return [...new Set(members.map((n) => stem(n.file)))].slice(0, 2).join(' + ')
}

/** Sorts each cluster so declarations come first, then callers before the functions they call. */
function assignReadingOrder(nodes: Map<string, GraphNode>, edges: Map<string, GraphEdge>, clusters: Cluster[]): void {
  let order = 0
  for (const cluster of clusters) {
    const members = new Set(cluster.nodeIds)
    const incoming = new Map(cluster.nodeIds.map((id) => [id, 0]))
    const outgoing = new Map<string, string[]>()
    for (const edge of edges.values()) {
      if (edge.kind !== 'calls' || !members.has(edge.source) || !members.has(edge.target)) continue
      incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1)
      outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge.target])
    }
    const byPosition = cluster.nodeIds
      .map((id) => nodes.get(id)!)
      .sort((a, b) => kindRank(a) - kindRank(b) || a.file.localeCompare(b.file) || a.startLine - b.startLine)
    const visited = new Set<string>()
    const visit = (node: GraphNode): void => {
      if (visited.has(node.id)) return
      visited.add(node.id)
      node.order = order++
      for (const next of outgoing.get(node.id) ?? []) visit(nodes.get(next)!)
    }
    for (const node of byPosition) if (incoming.get(node.id) === 0) visit(node)
    for (const node of byPosition) visit(node)
  }
}

function kindRank(node: GraphNode): number {
  if (node.kind === 'file') return 3
  return node.kind === 'declarations' ? 0 : node.file.endsWith('.h') ? 1 : 2
}

/** A Rust file name such as 'test' repeats in many folders, so the name gets its folder: 'route/test'. 'mod.rs' and 'lib.rs' take the folder name only. */
function stem(path: string): string {
  const name = posix.basename(path).replace(/\.[^.]+$/, '')
  if (!path.endsWith('.rs')) return name
  const folder = posix.basename(posix.dirname(path))
  return RUST_FOLDER_MODULES.includes(name) ? folder : `${folder}/${name}`
}

/** A C++ header and its source file share a key across folders. A Rust file has no pair, so its key is the full path. */
function pairKey(path: string): string {
  return path.endsWith('.rs') ? path : stem(path)
}
