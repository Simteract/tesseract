import type { Draft, Hotspot, PreReview, ReviewModel } from '../../shared/types'
import { DraftButton, LEVEL_LABEL } from './NodeContext'
import { LEVEL_TAG } from './util'

interface Props {
  model: ReviewModel
  preReview?: PreReview
  /** Seconds since the running pre-review started, or undefined when none runs. */
  runningSeconds?: number
  drafts: Draft[]
  selectedId?: string
  onRun(): void
  onSelect(id: string): void
  onDraft(hotspots: Hotspot[]): void
}

export function formatSeconds(total: number): string {
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/** Left panel with the AI pre-review: the run button, the overview and the flagged units. */
export function PreReviewPanel({ model, preReview, runningSeconds, drafts, selectedId, onRun, onSelect, onDraft }: Props): React.JSX.Element {
  const byId = new Map(model.nodes.map((n) => [n.id, n]))
  const running = runningSeconds !== undefined
  return (
    <div className="panel prereview-panel">
      <div className="panel-head">
        <strong>AI pre-review</strong>
        <span className="spacer" />
        <button
          className={`small prereview-button ${running ? 'running' : ''}`}
          disabled={running}
          onClick={onRun}
          title={
            running
              ? 'Claude is reading the change. Keep working, the results appear when it is done.'
              : 'Ask Claude to read every changed unit and flag the ones that you must check with care: possible bugs, lifetime and threading problems, changed behavior that other code depends on. ' +
                'Flagged units glow in the graph and come first in the unit list. It can take a few minutes for a big change. The result is saved.'
          }
        >
          {running ? (
            <>
              <span className="spinner" /> Reading {formatSeconds(runningSeconds)}
            </>
          ) : preReview ? (
            'Run again'
          ) : (
            'Run AI pre-review'
          )}
        </button>
      </div>
      {!preReview ? (
        <p className="muted">
          Claude reads every changed unit and flags the ones to check first. Use it for big changes. Flagged units get a tag (⚠H high, ⚠M medium, ⚠L low) in the graph, in the
          unit list and in the code.
        </p>
      ) : (
        <div className="panel-body">
          <div className="muted">
            {preReview.hotspots.length} units to check · {new Date(preReview.createdAt).toLocaleString()} · keys h / Shift+H
          </div>
          {preReview.overview && <p>{preReview.overview}</p>}
          <div className="prereview-actions">
            <DraftButton model={model} hotspots={preReview.hotspots} drafts={drafts} onDraft={onDraft} label="Draft all as comments" />
          </div>
          <ol className="hotspot-list">
            {preReview.hotspots.map((h) => (
              <li key={h.nodeId} className={h.nodeId === selectedId ? 'current' : ''} onClick={() => onSelect(h.nodeId)} title="Click to select this unit">
                <div className="hotspot-head">
                  <span className={`chip level-${h.level}`}>
                    {LEVEL_TAG[h.level]} {LEVEL_LABEL[h.level]}
                  </span>
                  <b>{h.title}</b>
                </div>
                <div className="muted mono">{byId.get(h.nodeId)?.qualifiedName}</div>
                <div>{h.reason}</div>
                <div onClick={(e) => e.stopPropagation()}>
                  <DraftButton model={model} hotspots={[h]} drafts={drafts} onDraft={onDraft} />
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  )
}
