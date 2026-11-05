import { useEffect, useRef, useState } from 'react'
import type { Settings } from '../../shared/types'
import type { Run } from './util'

interface Props {
  settings: Settings
  run: Run
  onSettings(settings: Settings): void
}

function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}

/** Top bar button with a popup that lists the saved workspaces: Plastic workspaces and git clones of GitHub repositories. */
export function WorkspacePicker({ settings, run, onSettings }: Props): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState('')
  const root = useRef<HTMLDivElement>(null)
  const saved = settings.workspaces ?? (settings.workspace ? [settings.workspace] : [])

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

  const apply = async (next: Partial<Settings>): Promise<boolean> => {
    const result = await run(() => window.api.setSettings(next))
    if (result) onSettings(result)
    return !!result
  }

  const switchTo = async (workspace: string): Promise<void> => {
    if (await apply({ workspace })) {
      setTyped('')
      setOpen(false)
    }
  }

  const browse = async (): Promise<void> => {
    const folder = await window.api.pickFolder()
    if (folder) await switchTo(folder)
  }

  return (
    <div className="workspace-picker" ref={root}>
      <button
        className="workspace-button"
        onClick={() => setOpen(!open)}
        title={
          settings.workspace
            ? `${settings.source === 'github' ? 'GitHub repository' : 'Plastic workspace'}: ${settings.workspace}\nClick to switch, add or remove workspaces.`
            : 'Choose a workspace'
        }
      >
        📁 {settings.workspace ? folderName(settings.workspace) : 'Choose workspace'} ▾
      </button>
      {open && (
        <div className="workspace-popup">
          <div className="muted">Plastic workspaces and git clones of GitHub repositories. The app runs cm, or git and gh, in the chosen one, and Claude Code opens there.</div>
          <ul>
            {saved.map((w) => (
              <li key={w} className={w === settings.workspace ? 'current' : ''}>
                <a onClick={() => switchTo(w)} title={`Switch to ${w}. The open review closes.`}>
                  <b>{folderName(w)}</b>
                  <span className="muted">{w}</span>
                </a>
                {w === settings.workspace ? (
                  <span className="workspace-current" title="This is the workspace in use">
                    ✓
                  </span>
                ) : (
                  <button
                    className="ghost small"
                    onClick={() => apply({ workspaces: saved.filter((x) => x !== w) })}
                    title="Remove from this list. The folder on disk does not change."
                  >
                    ✕
                  </button>
                )}
              </li>
            ))}
            {saved.length === 0 && <li className="muted">No workspaces yet.</li>}
          </ul>
          <form
            className="workspace-add"
            onSubmit={(e) => {
              e.preventDefault()
              if (typed.trim()) switchTo(typed.trim())
            }}
          >
            <input value={typed} placeholder="C:/Plastic/MyProject" onChange={(e) => setTyped(e.target.value)} title="Type the path of a Plastic workspace or of a git clone" />
            <button disabled={!typed.trim()} title="Add this folder to the list and switch to it">
              Add
            </button>
            <button type="button" onClick={browse} title="Choose a folder in a dialog, add it to the list and switch to it">
              Browse…
            </button>
          </form>
        </div>
      )}
    </div>
  )
}
