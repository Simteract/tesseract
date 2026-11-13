import { useEffect, useState } from 'react'
import { type AssetChange, type AssetDiff, type AssetEntry, assetKindLabel, NOT_SET } from '../../shared/assetdiff'
import type { GraphNode, ReviewModel } from '../../shared/types'

interface Props {
  model: ReviewModel
  node: GraphNode
}

/** A text mark and a word for each change, so the change does not depend on color. */
const CHANGE_TEXT: Record<AssetChange, string> = { added: '+ added', removed: '− removed', changed: '~ changed', same: '' }

/** The table shows at most this many rows, so a very large asset keeps the view fast. */
const MAX_ROWS = 2000

interface Row {
  key: string
  change: AssetChange
  before?: string
  after?: string
}

interface Group {
  name: string
  kind: AssetEntry['groupKind']
  /** Set when the whole object or row exists on one side only. */
  whole?: AssetChange
  rows: Row[]
}

/** Shows the property changes of one asset as a table, in place of the code diff. */
export function AssetPanel({ model, node }: Props): React.JSX.Element {
  const [diff, setDiff] = useState<AssetDiff | null>()
  const [filter, setFilter] = useState('')
  const [showSame, setShowSame] = useState(false)

  useEffect(() => {
    let live = true
    setDiff(undefined)
    window.api.getAssetDiff({ modelKey: model.key, path: node.file }).then((result) => live && setDiff(result ?? null))
    return () => {
      live = false
    }
  }, [model.key, node.file])

  if (diff === undefined) return <div className="bp-panel muted bp-empty">Reading the asset…</div>
  if (!diff) return <div className="bp-panel muted bp-empty">The reader cannot read the properties of this asset.</div>

  const query = filter.trim().toLowerCase()
  const groups = groupEntries(diff.entries, showSame, query)
  let budget = MAX_ROWS
  const hidden = groups.reduce((sum, g) => sum + g.rows.length, 0) - MAX_ROWS

  return (
    <div className="bp-panel">
      <div className="bp-toolbar">
        <b>{assetKindLabel(diff.kind)}</b>
        <span className="muted">{diff.className}</span>
        <span className="bp-counts" title={`${diff.added} added, ${diff.removed} removed, ${diff.changed} changed`}>
          +{diff.added} −{diff.removed} ~{diff.changed}
        </span>
        <span className="bp-spacer" />
        <input
          type="search"
          className="asset-filter"
          placeholder="Filter properties"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && setFilter('')}
        />
        <label className="bp-check" title="Also show the fields that did not change in a changed object or row">
          <input type="checkbox" checked={showSame} onChange={(e) => setShowSame(e.target.checked)} /> Show unchanged fields
        </label>
      </div>
      <div className="asset-body">
        {groups.length === 0 ? (
          <div className="muted bp-empty">No properties match the filter.</div>
        ) : (
          <table className="asset-table">
            <thead>
              <tr>
                <th>Change</th>
                <th>Property</th>
                <th>Before</th>
                <th>After</th>
              </tr>
            </thead>
            {groups.map((group) => {
              const rows = group.rows.slice(0, Math.max(0, budget))
              budget -= rows.length
              if (rows.length === 0 && budget <= 0) return null
              return (
                <tbody key={`${group.kind}:${group.name}`}>
                  <tr className={`asset-group ${group.whole ?? ''}`}>
                    <th colSpan={4}>
                      {group.kind === 'row' ? 'Row' : 'Object'} {group.name}
                      {group.whole && <span className="asset-whole"> ({CHANGE_TEXT[group.whole].slice(2)} {group.kind === 'row' ? 'row' : 'object'})</span>}
                    </th>
                  </tr>
                  {rows.map((row) => (
                    <tr key={row.key} className={`asset-row ${row.change}`}>
                      <td className="asset-change">{CHANGE_TEXT[row.change]}</td>
                      <td className="asset-key">{row.key}</td>
                      <td className={`asset-value ${row.before === undefined ? 'muted' : ''}`}>{row.before ?? (group.whole ? '' : NOT_SET)}</td>
                      <td className={`asset-value ${row.after === undefined ? 'muted' : ''}`}>{row.after ?? (group.whole ? '' : NOT_SET)}</td>
                    </tr>
                  ))}
                </tbody>
              )
            })}
          </table>
        )}
        {hidden > 0 && <div className="muted bp-empty">{hidden} more rows are not shown. Use the filter to find them.</div>}
      </div>
    </div>
  )
}

/** Groups the entries by object or row. A whole added or removed group lists all its properties. */
function groupEntries(entries: AssetEntry[], showSame: boolean, query: string): Group[] {
  const groups = new Map<string, Group>()
  for (const entry of entries) {
    const id = `${entry.groupKind}:${entry.group}`
    let group = groups.get(id)
    if (!group) {
      group = { name: entry.group, kind: entry.groupKind, rows: [] }
      groups.set(id, group)
    }
    if (!entry.key) {
      group.whole = entry.change
      for (const [key, value] of Object.entries(entry.props ?? {})) {
        group.rows.push(entry.change === 'added' ? { key, change: 'added', after: value } : { key, change: 'removed', before: value })
      }
      continue
    }
    if (entry.change === 'same' && !showSame) continue
    group.rows.push({ key: entry.key, change: entry.change, before: entry.before, after: entry.after })
  }
  const matches = (text: string | undefined): boolean => !!text && text.toLowerCase().includes(query)
  return [...groups.values()]
    .map((group) => {
      if (!query || matches(group.name)) return group
      return { ...group, rows: group.rows.filter((r) => matches(r.key) || matches(r.before) || matches(r.after)) }
    })
    .filter((group) => group.rows.length > 0 || (!!group.whole && (!query || matches(group.name))))
}
