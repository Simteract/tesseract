import { useEffect, useMemo, useState } from 'react'
import type { Draft, ReviewComment, ReviewModel } from '../../shared/types'
import { isOpenThread } from '../../shared/threads'
import { basename, shortDate, shortUser, type Run } from './util'

interface Props {
  model: ReviewModel
  run: Run
  drafts: Draft[]
  focusFile?: string
  /** The thread to scroll to and highlight. A new object scrolls again, also to the same thread. */
  focusThread?: { id: number }
  onComments(comments: ReviewComment[] | undefined): void
  onJump(comment: ReviewComment): void
}

type Filter = 'all' | 'open' | 'file'

const FILTER_HINT: Record<Filter, string> = {
  all: 'Show all comment threads',
  open: 'Show only the change requests that nobody discarded yet',
  file: 'Show only the threads on the file of the selected unit'
}

const TYPE_LABEL: Record<string, string> = { change: 'Change request', question: 'Question', comment: 'Comment', conversation: 'General' }

export function Discussion({ model, run, drafts, focusFile, focusThread, onComments, onJump }: Props): React.JSX.Element {
  const [filter, setFilter] = useState<Filter>('all')
  const [flashId, setFlashId] = useState<number>()
  const [draft, setDraft] = useState('')
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [note, setNote] = useState('')
  const [showTimeline, setShowTimeline] = useState(false)
  const [notice, setNotice] = useState('')
  const modelKey = model.key

  const threads = useMemo(() => {
    const roots = model.comments.filter((c) => c.parentId === -1 && c.type !== 'timeline')
    return roots.map((root) => ({ root, replies: model.comments.filter((c) => c.parentId === root.id) }))
  }, [model.comments])

  const isOpen = (t: { root: ReviewComment; replies: ReviewComment[] }): boolean =>
    isOpenThread(t.root, t.replies)

  const shown = threads.filter((t) => filter === 'all' || (filter === 'open' ? isOpen(t) : t.root.file === focusFile))
  const timeline = model.comments.filter((c) => c.type === 'timeline')

  /** The filter goes back to "all", because the current filter can hide the thread. */
  useEffect(() => {
    if (!focusThread) return
    setFilter('all')
    setFlashId(focusThread.id)
    const scroll = setTimeout(() => document.querySelector(`.discussion [data-thread="${focusThread.id}"]`)?.scrollIntoView({ block: 'nearest' }))
    const timer = setTimeout(() => setFlashId(undefined), 2500)
    return () => {
      clearTimeout(scroll)
      clearTimeout(timer)
    }
  }, [focusThread])

  if (!model.review) {
    return <div className="empty">This is a branch without a review. Create a review in Plastic, or a pull request on GitHub, to discuss it here.</div>
  }

  const post = async (): Promise<void> => {
    if (!draft.trim()) return
    const comments = await run(() => window.api.addComment({ modelKey, text: draft.trim() }))
    if (comments) {
      setDraft('')
      onComments(comments)
    }
  }

  const editComment = async (comment: ReviewComment, text: string): Promise<boolean> => {
    const comments = await run(() => window.api.editComment({ modelKey, guid: comment.guid, text }))
    if (comments) onComments(comments)
    return !!comments
  }

  const deleteComment = async (comment: ReviewComment): Promise<boolean> => {
    const comments = await run(() => window.api.deleteComment({ modelKey, guid: comment.guid }))
    if (comments) onComments(comments)
    return !!comments
  }

  const sendToClaude = async (threadIds: number[]): Promise<void> => {
    let result = await run(() => window.api.sendToClaude({ modelKey, threadIds, note, ignoreBranch: false }))
    if (result?.branchWarning) {
      if (!window.confirm(`${result.branchWarning}\n\nOpen Claude anyway?`)) return
      result = await run(() => window.api.sendToClaude({ modelKey, threadIds, note, ignoreBranch: true }))
    }
    if (result?.launched) setNotice(`Claude opened in a new terminal. Prompt file: ${result.promptFile}`)
  }

  const copyPrompt = async (threadIds: number[]): Promise<void> => {
    const prompt = await run(() => window.api.buildClaudePrompt({ modelKey, threadIds, note }))
    if (prompt) {
      await navigator.clipboard.writeText(prompt)
      setNotice('Prompt copied to the clipboard.')
    }
  }

  const toggle = (id: number): void => {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelected(next)
  }

  const selectedIds = [...selected].filter((id) => threads.some((t) => t.root.id === id))
  const openIds = threads.filter(isOpen).map((t) => t.root.id)

  return (
    <div className="discussion">
      <div className="panel-head">
        <strong>Discussion</strong>
        <span className="spacer" />
        <button className="ghost" onClick={() => run(() => window.api.refreshComments(modelKey)).then(onComments)} title="Load the comments and reviewer status again from the server">
          ⟳
        </button>
      </div>

      <div className="composer">
        <textarea
          value={draft}
          placeholder="General comment on the whole review. Ctrl+Enter posts it to the review. For a line comment, click the left margin of the line in the code."
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && e.ctrlKey && post()}
        />
        <button onClick={post} disabled={!draft.trim()} title="Add this comment to the review. Everybody on the review can see it.">
          Post
        </button>
      </div>

      <div className="segmented">
        {(['all', 'open', 'file'] as Filter[]).map((f) => (
          <button key={f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)} title={FILTER_HINT[f]}>
            {f === 'all' ? `All (${threads.length})` : f === 'open' ? `Open requests (${openIds.length})` : 'This file'}
          </button>
        ))}
      </div>

      <div className="threads">
        {drafts.map((d) => (
          <DraftCard
            key={d.id}
            draft={d}
            thread={threads.find((t) => t.root.id === d.threadId)?.root}
            onPost={async (text, type) => onComments(await run(() => window.api.postDraft({ id: d.id, text, type })))}
            onDelete={() => run(() => window.api.deleteDraft(d.id))}
          />
        ))}
        {shown.map(({ root, replies }) => (
          <Thread
            key={root.id}
            root={root}
            replies={replies}
            open={isOpen({ root, replies })}
            flash={flashId === root.id}
            checked={selected.has(root.id)}
            onCheck={() => toggle(root.id)}
            onJump={() => onJump(root)}
            onSend={() => sendToClaude([root.id])}
            onReply={async (text, discard) => {
              const comments = await run(() => window.api.replyComment({ modelKey, guid: root.guid, text, discard }))
              onComments(comments)
              return !!comments
            }}
            onEdit={editComment}
            onDelete={deleteComment}
          />
        ))}
        {shown.length === 0 && <div className="muted">No threads.</div>}
        <label className="check" title="Show status changes and other events of the review">
          <input type="checkbox" checked={showTimeline} onChange={(e) => setShowTimeline(e.target.checked)} /> Show history ({timeline.length})
        </label>
        {showTimeline &&
          timeline.map((c) => (
            <div key={c.id} className="timeline">
              {shortDate(c.date)} · {shortUser(c.owner)} · {c.text.replace(/^\[([^\]]+)\]/, '$1: ').replace('#->#', ' → ')}
            </div>
          ))}
      </div>

      <div className="claude-bar">
        <textarea value={note} placeholder="Extra instructions for Claude (optional)" onChange={(e) => setNote(e.target.value)} title="This text is added to the prompt for Claude" />
        <div className="buttons">
          <button
            className="primary"
            disabled={selectedIds.length === 0}
            onClick={() => sendToClaude(selectedIds)}
            title="Open Claude Code in a new terminal in your workspace, with the checked threads and their code. Claude changes the files locally. It does not check in or push."
          >
            Send selected ({selectedIds.length}) to Claude
          </button>
          <button
            disabled={openIds.length === 0}
            onClick={() => sendToClaude(openIds)}
            title="Open Claude Code in a new terminal with all open change requests. Claude changes the files locally. It does not check in or push."
          >
            Send all open requests ({openIds.length})
          </button>
          <button
            className="ghost"
            disabled={selectedIds.length === 0}
            onClick={() => copyPrompt(selectedIds)}
            title="Copy the prompt for the checked threads to the clipboard, to paste it into an AI tool yourself"
          >
            Copy prompt
          </button>
        </div>
        {notice && (
          <div className="notice" onClick={() => setNotice('')}>
            {notice}
          </div>
        )}
      </div>
    </div>
  )
}

interface ThreadProps {
  root: ReviewComment
  replies: ReviewComment[]
  open: boolean
  flash?: boolean
  checked?: boolean
  /** The thread inside the code has no checkbox, because the Claude buttons are in the Discussion panel. */
  onCheck?(): void
  onJump?(): void
  /** Label and hint of the file link. The thread inside the code links to the Discussion panel instead. */
  jumpLabel?: string
  jumpHint?: string
  onSend?(): void
  onReply(text: string, discard: boolean): Promise<boolean>
  /** Edit and delete show only on the comments of the current user. */
  onEdit?(comment: ReviewComment, text: string): Promise<boolean>
  onDelete?(comment: ReviewComment): Promise<boolean>
}

export function Thread({ root, replies, open, flash, checked, onCheck, onJump, jumpLabel, jumpHint, onSend, onReply, onEdit, onDelete }: ThreadProps): React.JSX.Element {
  const [reply, setReply] = useState('')
  const [discard, setDiscard] = useState(false)
  const submit = async (): Promise<void> => {
    if (reply.trim() && (await onReply(reply.trim(), discard))) {
      setReply('')
      setDiscard(false)
    }
  }
  return (
    <div className={`thread ${open ? 'open' : ''} ${flash ? 'flash' : ''}`} data-thread={root.id}>
      <div className="thread-head">
        {onCheck && <input type="checkbox" checked={checked} onChange={onCheck} title="Check this thread to send it to Claude with the buttons at the bottom" />}
        <span className={`chip chip-${root.type}`}>
          {open ? '● ' : ''}
          {TYPE_LABEL[root.type] ?? root.type}
        </span>
        {root.resolved && <span className="chip chip-discarded">✓ resolved</span>}
        {onJump && (jumpLabel || root.file) && (
          <a onClick={onJump} title={jumpHint ?? `${root.file}\nClick to show this line in the code`}>
            {jumpLabel ?? `${basename(root.file!)}${root.line ? `:${root.line}` : ''}`}
          </a>
        )}
        <span className="spacer" />
        {onSend && (
          <button className="ghost small" onClick={onSend} title="Open Claude Code in a new terminal with only this thread. Claude changes the files locally. It does not check in, commit or push.">
            → Claude
          </button>
        )}
      </div>
      <Message comment={root} onEdit={onEdit} onDelete={onDelete} hasReplies={replies.length > 0} />
      {replies.map((r) => (
        <div key={r.id} className="reply">
          <Message comment={r} onEdit={onEdit} onDelete={onDelete} />
        </div>
      ))}
      <div className="reply-box">
        <input value={reply} placeholder="Reply" title="Write a reply. Enter posts it to the review." onChange={(e) => setReply(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
        {root.resolved === false ? (
          <label className="check" title="Post the reply and resolve the thread on GitHub">
            <input type="checkbox" checked={discard} onChange={(e) => setDiscard(e.target.checked)} /> resolve
          </label>
        ) : (
          root.type === 'change' && (
            <label className="check" title="Post the reply as a discard. This closes the change request as not needed.">
              <input type="checkbox" checked={discard} onChange={(e) => setDiscard(e.target.checked)} /> discard
            </label>
          )
        )}
      </div>
    </div>
  )
}

interface DraftProps {
  draft: Draft
  thread?: ReviewComment
  onPost(text: string, type?: string): Promise<void>
  onDelete(): void
}

export const LINE_TYPES = [
  { value: 'Change', label: 'Change request' },
  { value: 'Question', label: 'Question' },
  { value: 'Comment', label: 'Comment' }
]

/** A comment that an AI wrote through MCP. Nothing reaches the server until the user clicks Post. */
function DraftCard({ draft, thread, onPost, onDelete }: DraftProps): React.JSX.Element {
  const [text, setText] = useState(draft.text)
  const [type, setType] = useState(draft.type ?? 'Comment')
  const [busy, setBusy] = useState(false)
  const lineComment = draft.kind === 'comment' && !!draft.path
  const target =
    draft.kind === 'reply'
      ? `Reply to: ${thread ? `${shortUser(thread.owner)}: ${thread.text.split(/\r?\n/)[0]}` : `thread ${draft.threadId}`}`
      : draft.path
        ? `On ${basename(draft.path)}:${draft.line}`
        : 'General comment'
  const post = async (): Promise<void> => {
    setBusy(true)
    await onPost(text.trim(), lineComment ? type : undefined)
    setBusy(false)
  }
  return (
    <div className="thread draft">
      <div className="thread-head">
        <span className="chip chip-draft">AI draft</span>
        {lineComment && (
          <select className="draft-type" value={type} onChange={(e) => setType(e.target.value)} title="Type of the line comment. A change request stays open until somebody discards it.">
            {LINE_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        )}
        <span className="draft-target" title={target}>
          {target}
        </span>
        {draft.discard && <span className="chip chip-discarded">will discard</span>}
      </div>
      <textarea value={text} onChange={(e) => setText(e.target.value)} />
      <div className="reply-box">
        <span className="muted">{shortDate(draft.createdAt)}</span>
        <span className="spacer" />
        <button className="primary small" disabled={busy || !text.trim()} onClick={post} title="Post this AI draft to the review, with your edits. Everybody on the review can see it.">
          Post
        </button>
        <button className="small" disabled={busy} onClick={onDelete} title="Delete this AI draft. Nothing is sent to the server.">

          Discard
        </button>
      </div>
    </div>
  )
}

interface MessageProps {
  comment: ReviewComment
  onEdit?(comment: ReviewComment, text: string): Promise<boolean>
  onDelete?(comment: ReviewComment): Promise<boolean>
  /** A thread root with replies gets a stronger delete warning, because the replies can stay without their root. */
  hasReplies?: boolean
}

function Message({ comment, onEdit, onDelete, hasReplies }: MessageProps): React.JSX.Element {
  const [editing, setEditing] = useState<string>()
  const [busy, setBusy] = useState(false)
  const canEdit = comment.mine && !!onEdit
  const canDelete = comment.mine && !comment.cannotDelete && !!onDelete

  const save = async (): Promise<void> => {
    if (editing === undefined || !editing.trim() || !onEdit) return
    setBusy(true)
    if (await onEdit(comment, editing.trim())) setEditing(undefined)
    setBusy(false)
  }

  const remove = async (): Promise<void> => {
    const first = comment.text.split(/\r?\n/)[0].slice(0, 80)
    const warning = hasReplies ? '\n\nThe replies of this comment can stay in the review without it.' : ''
    if (!onDelete || !window.confirm(`Delete your comment from the review? Everybody loses it, and you cannot undo this.\n\n"${first}"${warning}`)) return
    setBusy(true)
    await onDelete(comment)
    setBusy(false)
  }

  return (
    <div className="message">
      <div className="message-meta">
        <strong>{shortUser(comment.owner)}</strong> {shortDate(comment.date)}
        {comment.type === 'discarded' && <span className="chip chip-discarded">discarded</span>}
        {(canEdit || canDelete) && editing === undefined && (
          <span className="message-actions">
            {canEdit && (
              <button className="ghost small" disabled={busy} onClick={() => setEditing(comment.text)} title="Edit the text of your comment">
                ✎ Edit
              </button>
            )}
            {canDelete && (
              <button className="ghost small" disabled={busy} onClick={remove} title="Delete your comment from the review. You cannot undo this.">
                🗑 Delete
              </button>
            )}
          </span>
        )}
      </div>
      {editing === undefined ? (
        <div className="message-text">{comment.text}</div>
      ) : (
        <div className="message-edit">
          <textarea
            value={editing}
            autoFocus
            onChange={(e) => setEditing(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && e.ctrlKey) save()
              if (e.key === 'Escape') setEditing(undefined)
            }}
          />
          <div className="message-edit-buttons">
            <button className="primary small" disabled={busy || !editing.trim() || editing.trim() === comment.text} onClick={save} title="Save the new text to the review. Ctrl+Enter also saves.">
              Save
            </button>
            <button className="small" disabled={busy} onClick={() => setEditing(undefined)} title="Keep the old text. Esc also cancels.">
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
