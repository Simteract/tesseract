import type * as Monaco from 'monaco-editor'
import { useEffect, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'

export interface ZoneSpec {
  key: string
  /** The zone shows below this line. */
  line: number
  content: React.ReactNode
}

/** Monaco handles these events as clicks and keys in the code. A zone stops them, so its inputs keep the focus. */
const STOPPED_EVENTS = ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'click', 'dblclick', 'contextmenu', 'keydown', 'keyup', 'keypress']

/** Space above and below the content of a zone, in pixels. */
const ZONE_PADDING = 10

/**
 * A zone is as wide as the longest code line, so it can be wider than the visible code. The
 * content gets the visible width instead, minus this gap for the scroll bar.
 */
const ZONE_RIGHT_GAP = 36
const MIN_ZONE_WIDTH = 240

interface Zone {
  key: string
  id: string
  root: Root
  observer: ResizeObserver
}

/**
 * Shows React content between the lines of a Monaco editor. Each zone has its own React root. A
 * portal does not work here: React reads events at its root container, and the zone must stop the
 * events before they reach Monaco. The zones are made again when a key, a line or `version` changes.
 * A content change only renders again.
 */
export function useViewZones(editor: Monaco.editor.ICodeEditor | undefined, specs: ZoneSpec[], version: unknown): void {
  const zones = useRef<Zone[]>([])
  const layoutKey = specs.map((s) => `${s.key}@${s.line}`).join(',')

  useEffect(() => {
    if (!editor) return
    const created: Zone[] = []
    const contents: HTMLElement[] = []
    const fitWidth = (): void => {
      const width = `${Math.max(MIN_ZONE_WIDTH, editor.getLayoutInfo().contentWidth - ZONE_RIGHT_GAP)}px`
      for (const content of contents) content.style.width = width
    }
    editor.changeViewZones((accessor) => {
      for (const spec of specs) {
        const dom = document.createElement('div')
        dom.className = 'inline-zone'
        const content = document.createElement('div')
        content.className = 'inline-zone-content'
        dom.appendChild(content)
        contents.push(content)
        const root = createRoot(content)
        for (const type of STOPPED_EVENTS) dom.addEventListener(type, (e) => e.stopPropagation())
        const zone: Monaco.editor.IViewZone = { afterLineNumber: spec.line, heightInPx: 40, domNode: dom }
        const id = accessor.addZone(zone)
        const observer = new ResizeObserver(() => {
          const height = Math.ceil(content.getBoundingClientRect().height) + ZONE_PADDING
          if (height === zone.heightInPx) return
          zone.heightInPx = height
          editor.changeViewZones((a) => a.layoutZone(id))
        })
        observer.observe(content)
        created.push({ key: spec.key, id, root, observer })
      }
    })
    zones.current = created
    fitWidth()
    const layoutListener = editor.onDidLayoutChange(fitWidth)
    return () => {
      layoutListener.dispose()
      zones.current = []
      for (const zone of created) zone.observer.disconnect()
      editor.changeViewZones((accessor) => created.forEach((zone) => accessor.removeZone(zone.id)))
      setTimeout(() => created.forEach((zone) => zone.root.unmount()))
    }
  }, [editor, layoutKey, version])

  useEffect(() => {
    for (const zone of zones.current) zone.root.render(specs.find((s) => s.key === zone.key)?.content)
  })
}
