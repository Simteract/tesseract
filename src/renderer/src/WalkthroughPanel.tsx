import { useState } from 'react'
import type { ReviewModel, Walkthrough, WalkthroughLevel, WalkthroughStepKind } from '../../shared/types'
import { formatSeconds } from './PreReviewPanel'

interface Props {
  model: ReviewModel
  walkthrough?: Walkthrough
  level: WalkthroughLevel
  /** Seconds since the running walkthrough started, or undefined when none runs. */
  runningSeconds?: number
  /** The open step. The index steps.length is the recap page. */
  position: number
  /** Indexes of the steps that the reviewer marked with "Got it". */
  done: Set<number>
  selectedId?: string
  onLevel(level: WalkthroughLevel): void
  onRun(): void
  onPosition(position: number): void
  onToggleDone(step: number): void
  onSelect(id: string): void
  onAsk(step: number, question: string): Promise<void>
}

const LEVEL_TEXT: Record<WalkthroughLevel, string> = { new: 'New to this code', familiar: 'I know this code' }

const KIND_TEXT: Record<WalkthroughStepKind, string> = { overview: 'Overview', concept: 'Concept', change: 'Change', blueprint: 'Blueprint or asset' }

/** Left panel with the walkthrough: Claude teaches the change step by step, and each step selects its units. */
export function WalkthroughPanel(props: Props): React.JSX.Element {
  const { walkthrough, level, runningSeconds, onLevel, onRun } = props
  const running = runningSeconds !== undefined
  return (
    <div className="panel walkthrough-panel">
      <div className="panel-head">
        <strong>Walkthrough</strong>
      </div>
      <div className="panel-head">
        <select className="small" value={level} disabled={running} onChange={(e) => onLevel(e.target.value as WalkthroughLevel)} title="How much the walkthrough explains. Each level keeps its own result.">
          {(Object.keys(LEVEL_TEXT) as WalkthroughLevel[]).map((l) => (
            <option key={l} value={l}>
              {LEVEL_TEXT[l]}
            </option>
          ))}
        </select>
        <button
          className={`small prereview-button ${running ? 'running' : ''}`}
          disabled={running}
          onClick={onRun}
          title={
            running
              ? 'Claude is reading the change. Keep working, the walkthrough appears when it is done.'
              : 'Ask Claude for a step by step lesson over the change, so that you understand it before you judge it. It can take a few minutes for a big change. The result is saved.'
          }
        >
          {running ? (
            <>
              <span className="spinner" /> Reading {formatSeconds(runningSeconds)}
            </>
          ) : walkthrough ? (
            'Run again'
          ) : (
            'Walk me through'
          )}
        </button>
      </div>
      {!walkthrough ? (
        <p className="muted">
          Claude explains the change in short steps: what it is for, the ideas you need, then each group of changes. Each step selects its units in the graph and the code, and ends
          with questions that you answer by reading the code. AI pre-review tags stay hidden while this panel is open, so they do not steer what you look at.
        </p>
      ) : (
        <WalkthroughBody {...props} walkthrough={walkthrough} />
      )}
    </div>
  )
}

function WalkthroughBody({ model, walkthrough, position, done, selectedId, onPosition, onToggleDone, onSelect, onAsk }: Props & { walkthrough: Walkthrough }): React.JSX.Element {
  const byId = new Map(model.nodes.map((n) => [n.id, n]))
  const steps = walkthrough.steps
  const recap = position >= steps.length
  const step = recap ? undefined : steps[position]
  const unitList = (ids: string[]): React.JSX.Element => (
    <ul className="walkthrough-units">
      {ids.map((id) => (
        <li key={id} className={id === selectedId ? 'current' : ''} onClick={() => onSelect(id)} title="Click to select this unit">
          <span className="mono">{byId.get(id)?.qualifiedName ?? id}</span>
          {byId.get(id)?.role === 'context' && <span className="chip">context</span>}
        </li>
      ))}
    </ul>
  )
  return (
    <div className="panel-body">
      <div className="walkthrough-nav">
        <button className="small" disabled={position === 0} onClick={() => onPosition(position - 1)} title="Previous step (p)">
          ‹ Previous
        </button>
        <span className="muted">{recap ? 'Recap' : `Step ${position + 1} of ${steps.length}`}</span>
        <button className="small" disabled={recap} onClick={() => onPosition(position + 1)} title="Next step (n)">
          Next ›
        </button>
      </div>
      {step ? (
        <div className="walkthrough-step">
          <div className="hotspot-head">
            <span className="chip">{KIND_TEXT[step.kind]}</span>
            <b>{step.title}</b>
          </div>
          <p>{step.text}</p>
          {step.nodeIds.length > 0 && unitList(step.nodeIds)}
          {step.checks.length > 0 && (
            <div className="walkthrough-checks">
              <b>Check this yourself</b>
              <ul>
                {step.checks.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </div>
          )}
          <div>
            <button className="small" onClick={() => onToggleDone(position)} title="Mark the step as understood. The mark is saved on this computer.">
              {done.has(position) ? '✓ Understood' : 'Got it'}
            </button>
          </div>
          {step.answers.map((a, i) => (
            <div key={i} className="walkthrough-answer">
              <div className="muted">Q: {a.question}</div>
              <div>{a.answer}</div>
            </div>
          ))}
          <AskBox key={position} onAsk={(question) => onAsk(position, question)} />
        </div>
      ) : (
        <div className="walkthrough-step">
          {walkthrough.recap && <p>{walkthrough.recap}</p>}
          {walkthrough.uncovered.length > 0 ? (
            <>
              <b>Not covered by the walkthrough ({walkthrough.uncovered.length})</b>
              <div className="muted">Read these units without help.</div>
              {unitList(walkthrough.uncovered)}
            </>
          ) : (
            <div className="muted">The walkthrough covers every changed unit.</div>
          )}
        </div>
      )}
      <ol className="walkthrough-steps">
        {steps.map((s, i) => (
          <li key={i} className={i === position ? 'current' : ''} onClick={() => onPosition(i)}>
            <span className="walkthrough-mark">{done.has(i) ? '✓' : ''}</span>
            {s.title}
          </li>
        ))}
        <li className={recap ? 'current' : ''} onClick={() => onPosition(steps.length)}>
          <span className="walkthrough-mark" />
          Recap
        </li>
      </ol>
      <div className="muted">
        {LEVEL_TEXT[walkthrough.level]} · {new Date(walkthrough.createdAt).toLocaleString()} · keys n / p
      </div>
    </div>
  )
}

/** The follow-up question box of one step. A new step gets a new box, so a half typed question does not move to another step. */
function AskBox({ onAsk }: { onAsk(question: string): Promise<void> }): React.JSX.Element {
  const [question, setQuestion] = useState('')
  const [asking, setAsking] = useState(false)
  const [error, setError] = useState('')
  const send = (): void => {
    if (!question.trim() || asking) return
    setAsking(true)
    setError('')
    onAsk(question)
      .then(() => setQuestion(''))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setAsking(false))
  }
  return (
    <div className="walkthrough-ask">
      <textarea
        rows={2}
        value={question}
        placeholder="Ask Claude about this step"
        disabled={asking}
        onChange={(e) => setQuestion(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send()
        }}
      />
      <button className="small prereview-button" disabled={asking || !question.trim()} onClick={send} title="Send the question (Ctrl+Enter)">
        {asking ? (
          <>
            <span className="spinner" /> Asking
          </>
        ) : (
          'Ask'
        )}
      </button>
      {error && <div className="error">{error}</div>}
    </div>
  )
}
