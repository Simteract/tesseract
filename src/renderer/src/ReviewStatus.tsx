import type { ReviewModel, Reviewer } from '../../shared/types'
import { shortUser, type Run } from './util'

interface Props {
  model: ReviewModel
  run: Run
  onReviewers(reviewers: Reviewer[] | undefined): void
}

const STATUS_MARK: Record<string, string> = { reviewed: '✓', 'rework-required': '✗', 'under-review': '…' }

function statusKey(status: string): string {
  return status.replace(/\s+/g, '-').toLowerCase()
}

/** Reviewer status of the whole review, in the top bar. Each status has a mark, so it does not depend on color. */
export function ReviewStatus({ model, run, onReviewers }: Props): React.JSX.Element | null {
  if (!model.review) return null
  const setStatus = async (status: 'reviewed' | 'rework-required'): Promise<void> => {
    onReviewers(await run(() => window.api.setMyStatus({ modelKey: model.key, status })))
  }
  return (
    <span className="review-status">
      {model.reviewers.map((r) => (
        <span key={r.user} className={`status status-${statusKey(r.status)}`} title={`${r.user} (${r.type}): ${r.status}`}>
          {STATUS_MARK[statusKey(r.status)] ?? ''} {shortUser(r.user)}
        </span>
      ))}
      {model.source === 'github' ? (
        <>
          <button className="small" onClick={() => setStatus('reviewed')} title="Approve the pull request on GitHub. The author sees it.">
            ✓ Approve
          </button>
          <button className="small" onClick={() => setStatus('rework-required')} title="Request changes on GitHub. The author must change the code first.">
            ✗ Request changes
          </button>
        </>
      ) : (
        <>
          <button className="small" onClick={() => setStatus('reviewed')} title="Set your reviewer status in Plastic to Reviewed. The review owner sees it.">
            ✓ I reviewed it
          </button>
          <button className="small" onClick={() => setStatus('rework-required')} title="Set your reviewer status in Plastic to Rework required. The owner must change the code first.">
            ✗ Rework required
          </button>
        </>
      )}
    </span>
  )
}
