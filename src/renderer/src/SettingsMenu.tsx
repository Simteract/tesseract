import { useEffect, useRef, useState } from 'react'
import { parsePatterns } from '../../shared/glob'
import type { Settings, StoreKind, StoreSize } from '../../shared/types'
import { clearMarks, countMarks, type Run } from './util'

interface Props {
  settings: Settings
  run: Run
  onSettings(settings: Settings): void
  /** Called after a clear, so the window can drop the cleared data that it holds. */
  onCleared(kinds: ClearKind[]): void
}

/** The stores of the main process, and the marks that the window keeps in its own storage. */
export type ClearKind = StoreKind | 'marks'

interface ClearItem {
  kind: ClearKind
  label: string
  hint: string
}

const CLEAR_ITEMS: ClearItem[] = [
  { kind: 'explanations', label: 'Context explanations', hint: 'Claude explanations of the units that are not changed.' },
  { kind: 'summaries', label: 'Cluster summaries', hint: 'Claude summaries of the clusters.' },
  { kind: 'prereviews', label: 'AI pre-reviews', hint: 'The AI check results.' },
  { kind: 'walkthroughs', label: 'Walkthroughs', hint: 'The walkthroughs, with the answers to your questions.' },
  { kind: 'drafts', label: 'AI draft comments', hint: 'Drafts that are not posted yet. Posted comments stay on the server.' },
  { kind: 'marks', label: 'Reviewed marks', hint: 'The "reviewed" marks of the units and the "Got it" marks of the walkthroughs. They are saved on this computer only.' },
  { kind: 'revisions', label: 'Downloaded files', hint: 'File revisions from the server. The next load downloads them again. The open review reloads.' }
]

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

/** The list of saved data in Settings. Each kind has a check box, and one button clears the checked kinds of all reviews. */
function SavedData({ run, onCleared }: { run: Run; onCleared(kinds: ClearKind[]): void }): React.JSX.Element {
  const [sizes, setSizes] = useState<Record<StoreKind, StoreSize>>()
  const [marks, setMarks] = useState(0)
  const [checked, setChecked] = useState<Set<ClearKind>>(new Set())
  const refresh = (): void => {
    window.api.storeSizes().then(setSizes)
    setMarks(countMarks())
  }
  useEffect(refresh, [])
  const toggle = (kind: ClearKind): void =>
    setChecked((current) => {
      const next = new Set(current)
      if (next.has(kind)) next.delete(kind)
      else next.add(kind)
      return next
    })
  const sizeText = (kind: ClearKind): string => {
    if (kind === 'marks') return `${marks} ${marks === 1 ? 'list' : 'lists'}`
    const size = sizes?.[kind]
    return size ? `${size.count} · ${formatBytes(size.bytes)}` : ''
  }
  const clear = async (): Promise<void> => {
    const kinds = CLEAR_ITEMS.filter((item) => checked.has(item.kind))
    if (!window.confirm(`Delete this saved data of all reviews?\n\n${kinds.map((k) => `- ${k.label}`).join('\n')}`)) return
    const stores = kinds.map((k) => k.kind).filter((k): k is StoreKind => k !== 'marks')
    if (stores.length) await run(() => window.api.clearStores(stores))
    if (checked.has('marks')) clearMarks()
    onCleared(kinds.map((k) => k.kind))
    setChecked(new Set())
    refresh()
  }
  return (
    <>
      <b>Saved data</b>
      <div className="muted">Claude results stay saved until the code changes. Clear them to ask Claude again from scratch. Each kind is cleared for all reviews.</div>
      <div className="saved-data">
        {CLEAR_ITEMS.map((item) => (
          <label key={item.kind} title={item.hint}>
            <input type="checkbox" checked={checked.has(item.kind)} onChange={() => toggle(item.kind)} />
            <span>{item.label}</span>
            <span className="muted">{sizeText(item.kind)}</span>
          </label>
        ))}
      </div>
      <div className="settings-actions">
        <span className="muted" />
        <button className="small" disabled={checked.size === 0} onClick={clear} title="Delete the checked data of all reviews. You confirm first.">
          Clear checked
        </button>
      </div>
    </>
  )
}

/** Build outputs that a code review rarely needs. The "Add common" button adds the missing ones. */
const COMMON_PATTERNS = ['*.dll', '*.pdb', '*.lib', '*.exe', '*.so', '*.dylib', '*.exp', '*.target', '*.modules']

/** Top bar button with a popup for the app settings. Now it holds only the exclude patterns. */
export function SettingsMenu({ settings, run, onSettings, onCleared }: Props): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const saved = settings.excludePatterns ?? []
  const [text, setText] = useState(saved.join('\n'))
  const root = useRef<HTMLDivElement>(null)
  const patterns = parsePatterns(text)
  const changed = patterns.join('\n') !== saved.join('\n')

  useEffect(() => {
    if (open) setText((settings.excludePatterns ?? []).join('\n'))
  }, [open, settings.excludePatterns])

  useEffect(() => {
    if (!open) return
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

  const save = async (): Promise<void> => {
    const result = await run(() => window.api.setSettings({ excludePatterns: patterns }))
    if (result) onSettings(result)
  }

  const addCommon = (): void => {
    const missing = COMMON_PATTERNS.filter((p) => !patterns.includes(p))
    setText([...patterns, ...missing].join('\n'))
  }

  return (
    <div className="workspace-picker" ref={root}>
      <button className="ghost" onClick={() => setOpen(!open)} title="Settings: files to hide from reviews">
        ⚙{saved.length > 0 ? ` ${saved.length} hidden` : ''}
      </button>
      {open && (
        <div className="workspace-popup settings-popup">
          <b>Hide files from reviews</b>
          <div className="muted">
            One glob pattern per line. "*" matches inside one folder, "**" across folders. A pattern matches at any depth, and a folder name hides the whole folder. Start a
            pattern with "/" to match from the repository root. Lines that start with "#" are notes.
          </div>
          <textarea
            value={text}
            rows={8}
            spellCheck={false}
            placeholder={'*.dll\n*.pdb\nBinaries/\n/MyGame/Plugins/**/ThirdParty'}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="settings-actions">
            <button type="button" className="ghost small" onClick={addCommon} title={`Add the patterns that are missing: ${COMMON_PATTERNS.join(' ')}`}>
              Add common binaries
            </button>
            <span className="muted">Applies when you open a review next time.</span>
            <button className="primary small" disabled={!changed} onClick={save} title="Save the patterns in the app settings">
              Save
            </button>
          </div>
          <SavedData run={run} onCleared={onCleared} />
        </div>
      )}
    </div>
  )
}
