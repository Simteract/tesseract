import { useEffect, useRef, useState } from 'react'
import { parsePatterns } from '../../shared/glob'
import type { Settings } from '../../shared/types'
import type { Run } from './util'

interface Props {
  settings: Settings
  run: Run
  onSettings(settings: Settings): void
  onAiCleared(): void
}

/** Build outputs that a code review rarely needs. The "Add common" button adds the missing ones. */
const COMMON_PATTERNS = ['*.dll', '*.pdb', '*.lib', '*.exe', '*.so', '*.dylib', '*.exp', '*.target', '*.modules']

/** Top bar button with a popup for the app settings. Now it holds only the exclude patterns. */
export function SettingsMenu({ settings, run, onSettings, onAiCleared }: Props): React.JSX.Element {
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

  const clearAi = async (): Promise<void> => {
    if (!window.confirm('Delete all saved AI results of all reviews? This deletes the context explanations, the cluster summaries and the pre-reviews.')) return
    await run(() => window.api.clearAiResults())
    onAiCleared()
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
          <b>Saved AI results</b>
          <div className="settings-actions">
            <span className="muted">Claude results stay saved until the code changes. Clear them to ask Claude again from scratch.</span>
            <button className="small" onClick={clearAi} title="Delete the context explanations, cluster summaries and pre-reviews of all reviews">
              Clear all
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
