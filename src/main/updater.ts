import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateInfo, UpdateState } from '../shared/types'

/** The GitHub repository that holds the releases. Keep it equal to `build.publish` in package.json. */
const RELEASE_REPO = { owner: 'Simteract', repo: 'tesseract' }

/** Hours between two update checks. Users often keep the app open for days. */
const CHECK_INTERVAL_HOURS = 4

let notify: (info: UpdateInfo) => void = () => {}
let current: UpdateInfo = { state: 'none', current: app.getVersion() }
let checking = false

function setState(state: UpdateState): void {
  current = { ...state, current: app.getVersion() }
  notify(current)
}

export function updateInfo(): UpdateInfo {
  return current
}

/**
 * Checks GitHub for a newer release and downloads it in the background. The updater calls `onChange`
 * when the state changes. The check runs only in an installed app, not in `just dev`.
 */
export function startUpdater(onChange: (info: UpdateInfo) => void): void {
  notify = onChange
  if (!app.isPackaged) {
    setState({ state: 'dev' })
    return
  }
  autoUpdater.autoDownload = true
  autoUpdater.on('update-available', (update) => setState({ state: 'downloading', version: update.version, percent: 0 }))
  autoUpdater.on('update-not-available', () => setState({ state: 'latest', checkedAt: new Date().toISOString() }))
  autoUpdater.on('download-progress', (progress) => {
    if (current.state === 'downloading') setState({ ...current, percent: Math.floor(progress.percent) })
  })
  autoUpdater.on('update-downloaded', (update) => setState({ state: 'ready', version: update.version }))
  autoUpdater.on('error', (error) => setState({ state: 'error', message: error.message }))
  void checkForUpdates()
  setInterval(() => void checkForUpdates(), CHECK_INTERVAL_HOURS * 60 * 60 * 1000)
}

/** Checks now. A check does nothing while another check or a download runs, or when an update waits for a restart. */
export async function checkForUpdates(): Promise<void> {
  if (!app.isPackaged || checking || current.state === 'downloading' || current.state === 'ready') return
  checking = true
  setState({ state: 'checking' })
  try {
    autoUpdater.setFeedURL({ provider: 'github', ...RELEASE_REPO })
    await autoUpdater.checkForUpdates()
  } catch (error) {
    setState({ state: 'error', message: error instanceof Error ? error.message : String(error) })
  } finally {
    checking = false
  }
}

/** Closes the app, runs the downloaded installer without its wizard, and starts the new version. */
export function installUpdate(): void {
  autoUpdater.quitAndInstall(true, true)
}
