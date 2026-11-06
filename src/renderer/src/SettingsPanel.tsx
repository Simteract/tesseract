import { useEffect, useState } from 'react'
import { parsePatterns } from '../../shared/glob'
import { AI_EFFORTS, AI_MODELS, AI_TASK_DEFAULTS, CLAUDE_DEFAULT, type AiTask, type AiTaskSettings, type Settings, type StoreKind, type StoreSize } from '../../shared/types'
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

type Page = 'claude' | 'files' | 'data'

/** The settings pages. The words let the search find a page by a term that is not in its labels. */
const PAGES: { page: Page; label: string; title: string; words: string }[] = [
  { page: 'claude', label: 'Claude', title: 'Claude model and effort', words: 'ai model effort fable opus sonnet haiku thinking' },
  { page: 'files', label: 'Files', title: 'Hide files from reviews', words: 'exclude ignore glob pattern binaries folder' },
  { page: 'data', label: 'Saved data', title: 'Saved data', words: 'cache clear delete storage disk size' }
]

/** True when each word of the query occurs in one of the texts. An empty query matches all. */
function matches(query: string, ...texts: string[]): boolean {
  const haystack = texts.join(' ').toLowerCase()
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word))
}

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

/** The list of saved data. Each kind has a check box, and one button clears the checked kinds of all reviews. */
function SavedData({ run, onCleared, items }: { run: Run; onCleared(kinds: ClearKind[]): void; items: ClearItem[] }): React.JSX.Element {
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
      <div className="muted">Claude results stay saved until the code changes. Clear them to ask Claude again from scratch. Each kind is cleared for all reviews.</div>
      <div className="saved-data">
        {items.map((item) => (
          <label key={item.kind} title={item.hint}>
            <input type="checkbox" checked={checked.has(item.kind)} onChange={() => toggle(item.kind)} />
            <span>{item.label}</span>
            <span className="muted">{sizeText(item.kind)}</span>
          </label>
        ))}
      </div>
      <div className="settings-actions">
        <span className="muted">{checked.size > 0 ? `${checked.size} checked` : ''}</span>
        <button className="small" disabled={checked.size === 0} onClick={clear} title="Delete the checked data of all reviews. You confirm first.">
          Clear checked
        </button>
      </div>
    </>
  )
}

/** Build outputs that a code review rarely needs. The "Add common" button adds the missing ones. */
const COMMON_PATTERNS = ['*.dll', '*.pdb', '*.lib', '*.exe', '*.so', '*.dylib', '*.exp', '*.target', '*.modules']

/** The patterns of files to hide. The patterns are saved only with the Save button. */
function HiddenFiles({ settings, run, onSettings }: Pick<Props, 'settings' | 'run' | 'onSettings'>): React.JSX.Element {
  const saved = settings.excludePatterns ?? []
  const [text, setText] = useState(saved.join('\n'))
  const patterns = parsePatterns(text)
  const changed = patterns.join('\n') !== saved.join('\n')

  useEffect(() => setText((settings.excludePatterns ?? []).join('\n')), [settings.excludePatterns])

  const save = async (): Promise<void> => {
    const result = await run(() => window.api.setSettings({ excludePatterns: patterns }))
    if (result) onSettings(result)
  }

  const addCommon = (): void => {
    const missing = COMMON_PATTERNS.filter((p) => !patterns.includes(p))
    setText([...patterns, ...missing].join('\n'))
  }

  return (
    <>
      <div className="muted">
        One glob pattern per line. "*" matches inside one folder, "**" across folders. A pattern matches at any depth, and a folder name hides the whole folder. Start a pattern
        with "/" to match from the repository root. Lines that start with "#" are notes.
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
        <span className="muted">{saved.length} saved. Applies when you open a review next time.</span>
        <button className="primary small" disabled={!changed} onClick={save} title="Save the patterns in the app settings">
          Save
        </button>
      </div>
    </>
  )
}

const TASKS: { task: AiTask; label: string; hint: string }[] = [
  { task: 'summary', label: 'Cluster summaries', hint: 'The summary of a cluster.' },
  { task: 'explain', label: 'Context explanations', hint: 'The explanations of the units that are not changed.' },
  { task: 'prereview', label: 'AI pre-review', hint: 'The AI check of the whole change. It reads the most code.' },
  { task: 'walkthrough', label: 'Walkthrough', hint: 'The step by step lesson over the change.' },
  { task: 'ask', label: 'Walkthrough questions', hint: 'The answers to your questions about a walkthrough step.' },
  { task: 'fix', label: 'Send to Claude Code', hint: 'The interactive Claude Code session that applies the review feedback.' }
]

const capitalize = (text: string): string => text[0].toUpperCase() + text.slice(1)

/**
 * The model and effort of each kind of AI task. A change is saved at once and applies to the next Claude run.
 * A choice equal to the app default is not saved, so a later app default applies to the task.
 */
function AiModels({ settings, run, onSettings, tasks }: Pick<Props, 'settings' | 'run' | 'onSettings'> & { tasks: typeof TASKS }): React.JSX.Element {
  const change = async (task: AiTask, value: AiTaskSettings): Promise<void> => {
    const current = { ...settings.ai?.[task], ...value }
    const defaults = AI_TASK_DEFAULTS[task]
    const cleaned: AiTaskSettings = {
      ...(current.model && current.model !== defaults.model ? { model: current.model } : {}),
      ...(current.effort && current.effort !== defaults.effort ? { effort: current.effort } : {})
    }
    const result = await run(() => window.api.setSettings({ ai: { ...settings.ai, [task]: cleaned } }))
    if (result) onSettings(result)
  }
  const optionLabel = (task: AiTask, kind: 'model' | 'effort', value: string): string => {
    const text = value === CLAUDE_DEFAULT ? 'Claude Code default' : kind === 'model' ? capitalize(value) : value
    return AI_TASK_DEFAULTS[task][kind] === value ? `${text} (app default)` : text
  }
  return (
    <>
      <div className="muted">
        A stronger model or more effort gives better results, but takes longer and uses more of your limits. "Claude Code default" lets Claude Code choose. If a model is
        not available, the task uses the Claude Code default.
      </div>
      <div className="ai-models">
        {tasks.map(({ task, label, hint }) => (
          <div key={task} className="ai-model-row" title={hint}>
            <span className="ai-model-name">{label}</span>
            <div className="ai-model-pickers">
              <select
                className="small"
                value={settings.ai?.[task]?.model ?? AI_TASK_DEFAULTS[task].model}
                onChange={(e) => change(task, { model: e.target.value as AiTaskSettings['model'] })}
                aria-label={`${label} model`}
                title="Model"
              >
                {[CLAUDE_DEFAULT, ...AI_MODELS].map((m) => (
                  <option key={m} value={m}>
                    {optionLabel(task, 'model', m)}
                  </option>
                ))}
              </select>
              <select
                className="small"
                value={settings.ai?.[task]?.effort ?? AI_TASK_DEFAULTS[task].effort}
                onChange={(e) => change(task, { effort: e.target.value as AiTaskSettings['effort'] })}
                aria-label={`${label} effort`}
                title="Effort"
              >
                {[CLAUDE_DEFAULT, ...AI_EFFORTS].map((effort) => (
                  <option key={effort} value={effort}>
                    {optionLabel(task, 'effort', effort)}
                  </option>
                ))}
              </select>
            </div>
          </div>
        ))}
      </div>
    </>
  )
}

/**
 * Left panel with the app settings on pages: Claude models, files to hide, and saved data.
 * A search shows the matching rows of all pages at once. A page title that matches shows the whole page.
 * Hidden pages stay mounted, so unsaved patterns and check boxes survive a page change.
 */
export function SettingsPanel({ settings, run, onSettings, onCleared }: Props): React.JSX.Element {
  const [page, setPage] = useState<Page>('claude')
  const [query, setQuery] = useState('')
  const searching = query.trim() !== ''

  const pageMatches = (p: (typeof PAGES)[number]): boolean => matches(query, p.label, p.title, p.words)
  const [claude, files, data] = PAGES
  const tasks = pageMatches(claude) ? TASKS : TASKS.filter((t) => matches(query, t.label, t.hint))
  const filesShown = pageMatches(files) || matches(query, 'glob pattern line folder repository root notes common binaries')
  const items = pageMatches(data) ? CLEAR_ITEMS : CLEAR_ITEMS.filter((i) => matches(query, i.label, i.hint))

  const shown: Record<Page, boolean> = searching
    ? { claude: tasks.length > 0, files: filesShown, data: items.length > 0 }
    : { claude: page === 'claude', files: page === 'files', data: page === 'data' }
  const title = (p: Page): string => PAGES.find((x) => x.page === p)?.title ?? ''

  return (
    <div className="panel settings-panel">
      <div className="panel-head">
        <strong>Settings</strong>
      </div>
      <input
        type="search"
        className="settings-search"
        placeholder="Search settings"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
        aria-label="Search settings"
      />
      {!searching && (
        <div className="segmented settings-pages" role="tablist">
          {PAGES.map((p) => (
            <button key={p.page} role="tab" aria-selected={page === p.page} className={`small ${page === p.page ? 'active' : ''}`} onClick={() => setPage(p.page)}>
              {p.label}
            </button>
          ))}
        </div>
      )}
      <div className="panel-body">
        <section className="settings-section" hidden={!shown.claude}>
          <h3>{title('claude')}</h3>
          <AiModels settings={settings} run={run} onSettings={onSettings} tasks={tasks} />
        </section>
        <section className="settings-section" hidden={!shown.files}>
          <h3>{title('files')}</h3>
          <HiddenFiles settings={settings} run={run} onSettings={onSettings} />
        </section>
        <section className="settings-section" hidden={!shown.data}>
          <h3>{title('data')}</h3>
          <SavedData run={run} onCleared={onCleared} items={items} />
        </section>
        {searching && !shown.claude && !shown.files && !shown.data && <div className="empty">No settings match "{query.trim()}".</div>}
      </div>
    </div>
  )
}
