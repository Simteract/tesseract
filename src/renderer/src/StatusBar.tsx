import { useEffect, useState } from 'react'
import type { McpInfo, Progress, UpdateInfo } from '../../shared/types'

/** The status label. A task that counts its steps also gets "done/total" and a thin bar under the label. */
function ProgressLabel({ progress }: { progress: Progress }): React.JSX.Element {
  const { message, done, total } = progress
  const counted = done !== undefined && total !== undefined && total > 0
  return (
    <span className="busy">
      {message}
      {counted && ` ${done}/${total}`}…
      {counted && (
        <span className="busy-bar" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
          <span style={{ width: `${(100 * done) / total}%` }} />
        </span>
      )}
    </span>
  )
}

function McpButton(): React.JSX.Element | null {
  const [mcp, setMcp] = useState<McpInfo>()
  const [notice, setNotice] = useState('')
  useEffect(() => void window.api.getMcpInfo().then(setMcp), [])
  if (!mcp) return null
  const copyCommand = async (): Promise<void> => {
    if (!mcp.running) return
    await navigator.clipboard.writeText(mcp.command)
    setNotice('copied')
    setTimeout(() => setNotice(''), 2000)
  }
  return (
    <button
      className={`ghost small mcp ${mcp.running ? 'on' : 'off'}`}
      onClick={copyCommand}
      title={mcp.running ? `MCP server at ${mcp.url}\nClick to copy the command that adds it to Claude Code:\n${mcp.command}` : `MCP server is off: ${mcp.error}`}
    >
      MCP {notice || (mcp.running ? 'on' : 'off')}
    </button>
  )
}

/** The app version, the state of the last update check, and the button that checks now or installs the update. */
function UpdateStatus(): React.JSX.Element {
  const [update, setUpdate] = useState<UpdateInfo>()
  useEffect(() => {
    window.api.getUpdate().then(setUpdate)
    return window.api.onUpdate(setUpdate)
  }, [])
  const check = (
    <button className="ghost small" onClick={() => window.api.checkForUpdates()} title="Look for a newer version on GitHub now.">
      Check for updates
    </button>
  )
  let status: React.ReactNode = null
  switch (update?.state) {
    case 'dev':
      status = <span className="muted" title="This app does not run from an installer, so it does not update.">dev build</span>
      break
    case 'checking':
      status = <span className="muted">Checking for updates…</span>
      break
    case 'latest':
      status = (
        <>
          <span className="muted" title={`Last check: ${new Date(update.checkedAt).toLocaleString()}`}>
            ✓ Up to date
          </span>
          {check}
        </>
      )
      break
    case 'downloading':
      status = (
        <span className="busy">
          Downloading {update.version}: {update.percent}%
          <span className="busy-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={update.percent}>
            <span style={{ width: `${update.percent}%` }} />
          </span>
        </span>
      )
      break
    case 'ready':
      status = (
        <button className="small update" onClick={() => window.api.installUpdate()} title="Close the app, install the new version and start it again.">
          ⬆ Restart to update to {update.version}
        </button>
      )
      break
    case 'error':
      status = (
        <>
          <span className="update-error" title={update.message}>
            ⚠ Update check failed: {update.message}
          </span>
          {check}
        </>
      )
      break
    default:
      status = check
  }
  return (
    <>
      {update && <span className="muted">v{update.current}</span>}
      {status}
    </>
  )
}

/** The bar at the bottom of the window: the app name and version, the task progress, errors, MCP and updates. */
interface StatusBarProps {
  progress?: Progress
  error: string
  /** A short message that is not an error, for example that there is nothing to review. */
  notice: string
  onDismissError(): void
  onDismissNotice(): void
}

export function StatusBar({ progress, error, notice, onDismissError, onDismissNotice }: StatusBarProps): React.JSX.Element {
  return (
    <footer className="statusbar">
      <strong className="brand">Tesseract</strong>
      <UpdateStatus />
      {progress?.message && <ProgressLabel progress={progress} />}
      {progress?.message && progress.cancellable && (
        <button className="small" onClick={() => window.api.cancelLoad()} title="Stop loading this review. Files that are already downloaded stay saved for the next time.">
          ✕ Cancel
        </button>
      )}
      {notice && (
        <span className="status-notice" onClick={onDismissNotice} title="Click to dismiss">
          ⓘ {notice}
        </span>
      )}
      {error && (
        <span className="error" onClick={onDismissError} title={`${error}\nClick to dismiss`}>
          {error}
        </span>
      )}
      <span className="spacer" />
      <McpButton />
    </footer>
  )
}
