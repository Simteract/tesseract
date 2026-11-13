import type { AssetGroup, AssetKind, AssetProperties } from './types'

export type AssetChange = 'added' | 'removed' | 'changed' | 'same'

/**
 * The text for a property that one side does not save. Unreal saves only values that differ from
 * the default, so a missing value is the default, or an array element that does not exist.
 */
export const NOT_SET = '(not set)'

/**
 * One property, or one whole object or DataTable row when it exists on one side only. A whole-group
 * entry has no key. 'same' entries exist only in groups with a change, so the view can show the
 * rest of a changed row.
 */
export interface AssetEntry {
  group: string
  groupKind: AssetGroup['kind']
  key?: string
  change: AssetChange
  before?: string
  after?: string
  /** The properties of a whole added or removed group. */
  props?: Record<string, string>
}

export interface AssetDiff {
  kind: AssetKind
  className: string
  entries: AssetEntry[]
  added: number
  removed: number
  changed: number
}

/** Compares two revisions of an asset. Groups match by name, properties match by path. */
export function diffAssetProperties(base: AssetProperties | undefined, head: AssetProperties | undefined): AssetDiff | undefined {
  const any = head ?? base
  if (!any) return undefined
  const baseGroups = new Map((base?.groups ?? []).map((g) => [g.name, g]))
  const headGroups = new Map((head?.groups ?? []).map((g) => [g.name, g]))
  const entries: AssetEntry[] = []
  for (const group of headGroups.values()) {
    const old = baseGroups.get(group.name)
    if (!old) {
      entries.push({ group: group.name, groupKind: group.kind, change: 'added', props: group.props })
      continue
    }
    const keys = new Set([...Object.keys(old.props), ...Object.keys(group.props)])
    const groupEntries: AssetEntry[] = []
    for (const key of keys) {
      const before = old.props[key]
      const after = group.props[key]
      const change: AssetChange = before === after ? 'same' : before === undefined ? 'added' : after === undefined ? 'removed' : 'changed'
      groupEntries.push({ group: group.name, groupKind: group.kind, key, change, before, after })
    }
    if (groupEntries.some((e) => e.change !== 'same')) entries.push(...groupEntries)
  }
  for (const group of baseGroups.values()) {
    if (!headGroups.has(group.name)) entries.push({ group: group.name, groupKind: group.kind, change: 'removed', props: group.props })
  }
  const count = (change: AssetChange): number => entries.filter((e) => e.change === change).length
  return { kind: any.kind, className: any.className, entries, added: count('added'), removed: count('removed'), changed: count('changed') }
}

export function assetChanged(diff: AssetDiff | undefined): diff is AssetDiff {
  return !!diff && diff.added + diff.removed + diff.changed > 0
}

/** The words for an asset kind, for labels and prompts. */
export function assetKindLabel(kind: AssetKind): string {
  return kind === 'table' ? 'DataTable' : kind === 'defaults' ? 'Blueprint class defaults' : 'asset'
}

/** A short text of the asset changes, for the Claude prompts and the MCP tools. */
export function describeAssetDiff(path: string, diff: AssetDiff | undefined): string {
  if (!diff) return `Asset ${path}: no readable properties`
  const lines = [`${assetKindLabel(diff.kind)} ${path} (${diff.className})`]
  let group = ''
  for (const entry of diff.entries) {
    if (entry.change === 'same') continue
    const sign = entry.change === 'added' ? '+' : entry.change === 'removed' ? '-' : '~'
    const title = `${entry.groupKind === 'row' ? 'Row' : 'Object'} ${entry.group}`
    if (!entry.key) {
      lines.push(`  ${sign} ${title}`)
      for (const [key, value] of Object.entries(entry.props ?? {})) lines.push(`      ${key} = ${value}`)
      continue
    }
    if (entry.group !== group) lines.push(`  ${title}:`)
    group = entry.group
    lines.push(`    ${sign} ${entry.key}: ${entry.before ?? NOT_SET} -> ${entry.after ?? NOT_SET}`)
  }
  return lines.join('\n')
}
