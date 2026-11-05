import { DiffEditor, type DiffOnMount } from '@monaco-editor/react'
import type * as Monaco from 'monaco-editor'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { GraphNode, Hotspot, ReviewComment, ReviewModel } from '../../shared/types'
import { isOpenThread } from '../../shared/threads'
import type { CommentTarget } from './App'
import { LINE_TYPES, Thread } from './Discussion'
import { LEVEL_LABEL } from './NodeContext'
import { LEVEL_COLOR, LEVEL_TAG, type Run } from './util'
import { useViewZones, type ZoneSpec } from './viewZones'

interface Props {
  model: ReviewModel
  node?: GraphNode
  hotspots: Hotspot[]
  run: Run
  /** The line of a new comment. The code shows a comment box below this line. */
  commentTarget?: CommentTarget
  onCommentLine(target: CommentTarget): void
  onClearTarget(): void
  onComments(comments: ReviewComment[] | undefined): void
  /** Called when the user asks to see a thread in the Discussion panel. */
  onOpenComment(comment: ReviewComment): void
  /** Called when the user clicks the marker of a flagged unit. */
  onSelect(id: string): void
}

/** What a click on a glyph in the margin opens. The key is the line number on one side. */
interface GlyphTargets {
  comments: Map<number, ReviewComment>
  hotspots: { original: Map<number, string>; modified: Map<number, string> }
}

export function CodePanel({ model, node, hotspots, run, commentTarget, onCommentLine, onClearTarget, onComments, onOpenComment, onSelect }: Props): React.JSX.Element {
  const [texts, setTexts] = useState<{ path: string; base: string; head: string }>()
  const [collapse, setCollapse] = useState(true)
  const [sideBySide, setSideBySide] = useState(false)
  const [showThreads, setShowThreads] = useState(true)
  const [modifiedEditor, setModifiedEditor] = useState<Monaco.editor.ICodeEditor>()
  const editor = useRef<Monaco.editor.IStandaloneDiffEditor>(undefined)
  const monaco = useRef<typeof Monaco>(undefined)
  const decorations = useRef<Monaco.editor.IEditorDecorationsCollection[]>([])
  const targets = useRef<GlyphTargets>({ comments: new Map(), hotspots: { original: new Map(), modified: new Map() } })
  const file = node ? model.files.find((f) => f.path === node.file) : undefined
  const canComment = !!model.review && file?.status !== 'D'
  /** The mouse handlers are added once at mount, so they read the newest values through this ref. */
  const handlers = useRef({ onOpenComment, onSelect, onCommentLine, canComment, path: file?.path })
  handlers.current = { onOpenComment, onSelect, onCommentLine, canComment, path: file?.path }

  useEffect(() => {
    if (!file) return
    let live = true
    Promise.all([window.api.getFile(file.baseRevId), window.api.getFile(file.headRevId)]).then(([base, head]) => {
      if (live) setTexts({ path: file.path, base: base ?? '', head: head ?? '' })
    })
    return () => {
      live = false
    }
  }, [file?.path, file?.baseRevId, file?.headRevId])

  const threads = useMemo(
    () =>
      model.comments
        .filter((c) => c.file === file?.path && c.line && c.parentId === -1 && c.type !== 'timeline')
        .map((root) => ({ root, replies: model.comments.filter((c) => c.parentId === root.id) })),
    [model.comments, file?.path]
  )

  const reply = async (root: ReviewComment, text: string, discard: boolean): Promise<boolean> => {
    const comments = await run(() => window.api.replyComment({ modelKey: model.key, guid: root.guid, text, discard }))
    onComments(comments)
    return !!comments
  }

  const editComment = async (comment: ReviewComment, text: string): Promise<boolean> => {
    const comments = await run(() => window.api.editComment({ modelKey: model.key, guid: comment.guid, text }))
    onComments(comments)
    return !!comments
  }

  const deleteComment = async (comment: ReviewComment): Promise<boolean> => {
    const comments = await run(() => window.api.deleteComment({ modelKey: model.key, guid: comment.guid }))
    onComments(comments)
    return !!comments
  }

  const loaded = !!file && texts?.path === file.path
  const zones: ZoneSpec[] = !loaded
    ? []
    : [
        ...(showThreads
          ? threads.map(({ root, replies }) => ({
              key: `thread-${root.id}`,
              line: root.line!,
              content: (
                <Thread
                  root={root}
                  replies={replies}
                  open={isOpenThread(root, replies)}
                  onJump={() => onOpenComment(root)}
                  jumpLabel="Discussion ↗"
                  jumpHint="Show this thread in the Discussion panel, where you can send it to Claude"
                  onReply={(text, discard) => reply(root, text, discard)}
                  onEdit={editComment}
                  onDelete={deleteComment}
                />
              )
            }))
          : []),
        ...(commentTarget && commentTarget.path === file.path
          ? [
              {
                key: 'new-comment',
                line: commentTarget.line,
                content: <NewComment model={model} target={commentTarget} run={run} onComments={onComments} onClose={onClearTarget} />
              }
            ]
          : [])
      ]
  useViewZones(modifiedEditor, zones, texts)

  const reveal = (): void => {
    const diff = editor.current
    const lanes = monaco.current?.editor.GlyphMarginLane
    if (!diff || !lanes || !node || texts?.path !== node.file) return
    for (const d of decorations.current) d.clear()
    const side = node.side === 'base' ? diff.getOriginalEditor() : diff.getModifiedEditor()
    const range = { startLineNumber: node.startLine, startColumn: 1, endLineNumber: node.endLine, endColumn: 1 }
    decorations.current = [side.createDecorationsCollection([{ range, options: { isWholeLine: true, className: 'unit-range', linesDecorationsClassName: 'unit-bar' } }])]

    const comments = threads.map((t) => t.root)
    targets.current = { comments: new Map(comments.map((c) => [c.line!, c])), hotspots: { original: new Map(), modified: new Map() } }
    decorations.current.push(
      diff.getModifiedEditor().createDecorationsCollection(
        comments.map((c) => ({
          range: { startLineNumber: c.line!, startColumn: 1, endLineNumber: c.line!, endColumn: 1 },
          options: {
            isWholeLine: true,
            className: 'comment-line',
            glyphMarginClassName: 'comment-glyph',
            glyphMargin: { position: lanes.Left },
            glyphMarginHoverMessage: { value: 'Click to show this thread in the Discussion panel' }
          }
        }))
      )
    )

    const byId = new Map(model.nodes.map((n) => [n.id, n]))
    for (const sideName of ['original', 'modified'] as const) {
      const flagged = hotspots
        .map((h) => ({ hotspot: h, unit: byId.get(h.nodeId) }))
        .filter(({ unit }) => unit?.file === node.file && (unit.side === 'base') === (sideName === 'original'))
      for (const { unit } of flagged) targets.current.hotspots[sideName].set(unit!.startLine, unit!.id)
      const sideEditor = sideName === 'original' ? diff.getOriginalEditor() : diff.getModifiedEditor()
      decorations.current.push(
        sideEditor.createDecorationsCollection(
          flagged.flatMap(({ hotspot, unit }) => {
            const message = { value: `**${LEVEL_TAG[hotspot.level]} AI ${LEVEL_LABEL[hotspot.level]}: ${hotspot.title}**\n\n${hotspot.reason}` }
            return [
              {
                range: { startLineNumber: unit!.startLine, startColumn: 1, endLineNumber: unit!.endLine, endColumn: 1 },
                options: {
                  isWholeLine: true,
                  className: `hotspot-range level-${hotspot.level}`,
                  overviewRuler: { color: LEVEL_COLOR[hotspot.level], position: monaco.current!.editor.OverviewRulerLane.Left }
                }
              },
              {
                range: { startLineNumber: unit!.startLine, startColumn: 1, endLineNumber: unit!.startLine, endColumn: 1 },
                options: {
                  glyphMarginClassName: `hotspot-glyph level-${hotspot.level}`,
                  glyphMargin: { position: lanes.Right },
                  glyphMarginHoverMessage: unit!.id === node.id ? message : [message, { value: 'Click to select this unit' }]
                }
              }
            ]
          })
        )
      )
    }
    side.revealLineNearTop(node.startLine)
  }

  useEffect(reveal, [node?.id, texts, threads, hotspots])
  /** The diff event is added once at mount, so it calls the newest reveal through this ref. */
  const revealLatest = useRef(reveal)
  revealLatest.current = reveal

  /**
   * A click in the glyph margin opens what the margin shows on that line: a thread, then a flagged
   * unit. A click on an empty margin of the new code starts a line comment.
   */
  const onMount: DiffOnMount = (diff, instance) => {
    editor.current = diff
    monaco.current = instance
    setModifiedEditor(diff.getModifiedEditor())
    diff.onDidUpdateDiff(() => revealLatest.current())
    for (const sideName of ['original', 'modified'] as const) {
      const sideEditor = sideName === 'original' ? diff.getOriginalEditor() : diff.getModifiedEditor()
      sideEditor.onMouseDown((e) => {
        const line = e.target.position?.lineNumber
        if (e.target.type !== instance.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || !line) return
        const current = handlers.current
        const comment = sideName === 'modified' ? targets.current.comments.get(line) : undefined
        const unitId = targets.current.hotspots[sideName].get(line)
        if (comment && (!unitId || !e.target.element?.classList.contains('hotspot-glyph'))) current.onOpenComment(comment)
        else if (unitId) current.onSelect(unitId)
        else if (sideName === 'modified' && current.canComment && current.path) current.onCommentLine({ path: current.path, line })
      })
    }
    reveal()
  }

  if (!node || !file) return <div className="empty">Select a node in the graph.</div>

  return (
    <div className="code-panel">
      <div className="code-toolbar">
        <span className="path" title={file.path}>
          {file.status} {file.path}
          {file.srcPath ? ` (moved from ${file.srcPath})` : ''}
        </span>
        <label className="check" title="Show only the changed lines and a few lines around them">
          <input type="checkbox" checked={collapse} onChange={(e) => setCollapse(e.target.checked)} /> Hide unchanged
        </label>
        <label className="check" title="Show the old and the new code next to each other. Comment threads show only in the inline view.">
          <input type="checkbox" checked={sideBySide} onChange={(e) => setSideBySide(e.target.checked)} /> Side by side
        </label>
        <label className="check" title="Show the comment threads below their lines in the code">
          <input type="checkbox" checked={showThreads} onChange={(e) => setShowThreads(e.target.checked)} /> Threads ({threads.length})
        </label>
        <button
          disabled={!canComment}
          title={canComment ? 'Comment on the line where the cursor is. You can also click the left margin of a line.' : 'Only reviews can hold comments'}
          onClick={() => {
            const line = editor.current?.getModifiedEditor().getPosition()?.lineNumber ?? node.startLine
            onCommentLine({ path: file.path, line })
          }}
        >
          Comment on line
        </button>
      </div>
      {file.itemType !== 'F' ? (
        <div className="empty">Binary file. No text diff.</div>
      ) : (
        <DiffEditor
          key={file.path}
          original={texts?.path === file.path ? texts.base : ''}
          modified={texts?.path === file.path ? texts.head : ''}
          language={file.isCode ? (file.path.toLowerCase().endsWith('.rs') ? 'rust' : 'cpp') : undefined}
          theme="tesseract"
          onMount={onMount}
          options={{
            readOnly: true,
            automaticLayout: true,
            renderSideBySide: sideBySide,
            hideUnchangedRegions: { enabled: collapse, contextLineCount: 4, minimumLineCount: 6 },
            glyphMargin: true,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            fontSize: 12,
            renderOverviewRuler: true
          }}
        />
      )}
    </div>
  )
}

interface NewCommentProps {
  model: ReviewModel
  target: CommentTarget
  run: Run
  onComments(comments: ReviewComment[] | undefined): void
  onClose(): void
}

/** Box for a new line comment, below the line in the code. */
function NewComment({ model, target, run, onComments, onClose }: NewCommentProps): React.JSX.Element {
  const [text, setText] = useState('')
  const [type, setType] = useState('Change')
  const [busy, setBusy] = useState(false)
  const post = async (): Promise<void> => {
    if (!text.trim()) return
    setBusy(true)
    const comments = await run(() => window.api.addComment({ modelKey: model.key, text: text.trim(), path: target.path, line: target.line, type }))
    setBusy(false)
    if (!comments) return
    onComments(comments)
    onClose()
  }
  return (
    <div className="thread new-comment">
      <div className="thread-head">
        <select value={type} onChange={(e) => setType(e.target.value)} title="Type of the line comment. A change request stays open until somebody discards it.">
          {LINE_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
        <span className="muted">Line {target.line}</span>
      </div>
      <textarea
        autoFocus
        value={text}
        placeholder="Write a comment. Ctrl+Enter posts it to the review, Escape cancels."
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && e.ctrlKey) post()
          else if (e.key === 'Escape') onClose()
        }}
      />
      <div className="reply-box">
        <span className="spacer" />
        <button className="primary small" disabled={busy || !text.trim()} onClick={post} title="Add this comment to the review. Everybody on the review can see it.">
          Post
        </button>
        <button className="small" disabled={busy} onClick={onClose} title="Close this box. Nothing is sent to the server.">
          Cancel
        </button>
      </div>
    </div>
  )
}
