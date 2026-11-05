import { useEffect, useRef, useState } from 'react'
import { type Commit, type CommitRange, NOT_COMMITTED_ID, type ReviewModel } from '../../shared/types'
import { shortDate, shortUser } from './util'

interface Props {
  model: ReviewModel
  onRange(range: CommitRange | undefined): void
}

/** The newest commit that the user saw in a review, by review key. It survives restarts. */
interface LastSeen {
  id: string
  date: string
}

/** The model key without the range part, so all ranges of one review share the last seen commit. */
function reviewKey(model: ReviewModel): string {
  return model.key.replace(/@[^@]*$/, '')
}

function readLastSeen(key: string): LastSeen | undefined {
  try {
    return JSON.parse(localStorage.getItem(`lastSeen:${key}`) ?? 'null') ?? undefined
  } catch {
    return undefined
  }
}

/** Storage can be unavailable. The "new since last visit" button then does not show. */
function writeLastSeen(key: string, seen: LastSeen): void {
  try {
    localStorage.setItem(`lastSeen:${key}`, JSON.stringify(seen))
  } catch {
    return
  }
}

/**
 * Top bar button that lists the commits of the review and opens only a range of them. It also offers
 * the commits that came after the last visit, so a second review round shows only the new fixes.
 */
export function CommitsMenu({ model, onRange }: Props): React.JSX.Element | null {
  const { commits } = model
  const plastic = model.source === 'plastic'
  const noun = plastic ? 'changesets' : 'commits'
  const [open, setOpen] = useState(false)
  const [first, setFirst] = useState(0)
  const [last, setLast] = useState(0)
  const [newSince, setNewSince] = useState<{ index: number; seen: LastSeen }>()
  const root = useRef<HTMLDivElement>(null)
  const indexOf = (id: string | undefined): number => commits.findIndex((c) => c.id === id)
  const current = model.range ? [indexOf(model.range.first), indexOf(model.range.last)] : [0, commits.length - 1]

  useEffect(() => {
    const newest = commits.at(-1)
    if (!newest || model.local) return
    const key = reviewKey(model)
    const seen = readLastSeen(key)
    const seenIndex = commits.findIndex((c) => c.id === seen?.id)
    setNewSince(seen && seenIndex >= 0 && seenIndex < commits.length - 1 ? { index: seenIndex + 1, seen } : undefined)
    writeLastSeen(key, { id: newest.id, date: new Date().toISOString() })
  }, [commits])

  useEffect(() => {
    if (!open) return
    setFirst(current[0])
    setLast(current[1])
    const onDown = (e: MouseEvent): void => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (commits.length === 0 || (model.local && commits.length === 1)) return null

  const label = (c: Commit): string => (c.id === NOT_COMMITTED_ID ? '✎' : plastic ? `cs:${c.id}` : c.id.slice(0, 7))
  const low = Math.min(first, last)
  const high = Math.max(first, last)
  const isAll = low === 0 && high === commits.length - 1
  const sameAsCurrent = low === current[0] && high === current[1]
  const choose = (index: number, extend: boolean): void => {
    if (extend) setLast(index)
    else {
      setFirst(index)
      setLast(index)
    }
  }
  const apply = (from: number, to: number): void => {
    setOpen(false)
    onRange(from === 0 && to === commits.length - 1 ? undefined : { first: commits[from].id, last: commits[to].id })
  }
  const buttonText = model.range ? `${noun} ${current[0] + 1}-${current[1] + 1} of ${commits.length}` : `all ${commits.length} ${noun}`

  return (
    <div className="workspace-picker commits-menu" ref={root}>
      <button className={`ghost ${model.range ? 'range-on' : ''}`} onClick={() => setOpen(!open)} title={`Choose the ${noun} to review`}>
        {model.range ? '◧ ' : ''}
        {buttonText} ▾
      </button>
      {newSince && !model.range && (
        <button
          className="new-since"
          onClick={() => apply(newSince.index, commits.length - 1)}
          title={`Review only the ${noun} that came after your last visit on ${shortDate(newSince.seen.date)}`}
        >
          {commits.length - newSince.index} new since your last visit
        </button>
      )}
      {open && (
        <div className="workspace-popup commits-popup">
          <div className="muted">
            Click a {noun.slice(0, -1)} to review only that one. Shift+click another one to review the range between them. The diff also holds the changes that a merge
            from the parent branch brought in.
          </div>
          <ul>
            {commits
              .map((c, i) => ({ c, i }))
              .reverse()
              .map(({ c, i }) => (
                <li key={c.id} className={i >= low && i <= high ? 'current' : ''} onClick={(e) => choose(i, e.shiftKey)}>
                  <span className="commit-pick">{i >= low && i <= high ? '■' : '□'}</span>
                  <a title={c.title}>
                    <b>
                      {label(c)} {c.title.split('\n')[0]}
                    </b>
                    <span className="muted">
                      {c.id === NOT_COMMITTED_ID ? 'the files on disk' : `${shortUser(c.author)} · ${shortDate(c.date)}`}
                      {newSince && i === newSince.index ? ' · first new since your last visit' : ''}
                    </span>
                  </a>
                </li>
              ))}
          </ul>
          <div className="settings-actions">
            <button className="ghost small" disabled={!model.range} onClick={() => apply(0, commits.length - 1)} title={`Review all ${commits.length} ${noun} again`}>
              All {noun}
            </button>
            <span className="muted">
              {high - low + 1} of {commits.length} chosen
            </span>
            <button className="primary small" disabled={sameAsCurrent} onClick={() => apply(low, high)} title={isAll ? `Review all ${noun}` : `Review only the chosen ${noun}`}>
              Review {isAll ? 'all' : 'chosen'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
