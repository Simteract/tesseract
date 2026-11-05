import { useEffect, useState } from 'react'
import type { ReviewFilter, ReviewSummary, SourceKind } from '../../shared/types'
import { parseOpenTarget, shortDate, shortUser, type Run } from './util'

interface Props {
  disabled: boolean
  source?: SourceKind
  run: Run
  onOpenReview(id: number): void
  onOpenBranch(branch: string): void
  onOpenLocal(): void
}

const FILTERS: { key: ReviewFilter; label: string; hint: string }[] = [
  { key: 'assigned', label: 'Assigned', hint: 'Show the reviews where you are a reviewer' },
  { key: 'mine', label: 'Mine', hint: 'Show the reviews that you created' },
  { key: 'recent', label: 'Recent', hint: 'Show the newest reviews of all users' }
]

export function Inbox({ disabled, source, run, onOpenReview, onOpenBranch, onOpenLocal }: Props): React.JSX.Element {
  const [filter, setFilter] = useState<ReviewFilter>('recent')
  const [reviews, setReviews] = useState<ReviewSummary[]>([])
  const [hideDone, setHideDone] = useState(true)
  const [target, setTarget] = useState('')
  const [search, setSearch] = useState('')

  const refresh = (): void => {
    if (!disabled) run(() => window.api.listReviews(filter)).then((r) => r && setReviews(r))
  }
  useEffect(refresh, [filter, disabled])

  const shown = reviews.filter(
    (r) => (!hideDone || r.status !== 'Reviewed') && (!search || `${r.id} ${r.title} ${r.owner}`.toLowerCase().includes(search.toLowerCase()))
  )

  return (
    <nav className="inbox">
      <form
        className="open-branch"
        onSubmit={(e) => {
          e.preventDefault()
          const parsed = parseOpenTarget(target, source === 'github')
          if (!parsed) return
          if ('reviewId' in parsed) onOpenReview(parsed.reviewId)
          else onOpenBranch(parsed.branch)
          setTarget('')
        }}
      >
        <input
          placeholder={source === 'github' ? 'Pull request link, number or branch' : 'Review link, review id or /main/branch'}
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          disabled={disabled}
          title={
            source === 'github'
              ? 'Paste a GitHub pull request link, type a pull request number, or type a branch name such as feature/task-123'
              : 'Paste a Plastic review link (for example from a chat message), type a review id, or type the full name of a branch such as /main/task-123'
          }
        />
        <button
          disabled={disabled || !parseOpenTarget(target, source === 'github')}
          title="Open the review. A branch opens without a review: the graph shows only the changes that the branch adds, and there are no comments. Tip: press Ctrl+V anywhere outside a text box to open a copied review link."
        >
          Open
        </button>
      </form>
      <button
        className="local-changes"
        disabled={disabled}
        onClick={onOpenLocal}
        title={
          source === 'github'
            ? 'Review your own work before you push: the commits that are not pushed yet, and the changes that are not committed.'
            : 'Review your own work before you check in: the pending changes of the workspace, with the files on disk.'
        }
      >
        Review my local changes
      </button>
      <div className="segmented">
        {FILTERS.map((f) => (
          <button key={f.key} className={filter === f.key ? 'active' : ''} onClick={() => setFilter(f.key)} title={f.hint}>
            {f.label}
          </button>
        ))}
        <button className="ghost" onClick={refresh} title="Load the review list again from the server">
          ⟳
        </button>
      </div>
      <input placeholder="Filter reviews" value={search} onChange={(e) => setSearch(e.target.value)} title="Show only reviews whose id, title or owner contains this text" />
      <label className="check" title="Hide the reviews with the status Reviewed">
        <input type="checkbox" checked={hideDone} onChange={(e) => setHideDone(e.target.checked)} /> Hide reviewed
      </label>
      <ul className="review-list">
        {shown.map((r) => (
          <li key={r.id} onClick={() => onOpenReview(r.id)} title={`${r.title}\nClick to load the changes and comments of review ${r.id}`}>
            <div className="review-title">{r.title.replace(/^Review of (branch|changeset) /, '')}</div>
            <div className="review-meta">
              <span className={`status status-${r.status.replace(/\s+/g, '-').toLowerCase()}`}>{r.status}</span>
              <span>{shortUser(r.owner)}</span>
              <span>{shortDate(r.date)}</span>
            </div>
          </li>
        ))}
        {shown.length === 0 && <li className="muted">No reviews</li>}
      </ul>
    </nav>
  )
}
