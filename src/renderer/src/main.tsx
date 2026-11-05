import { loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

self.MonacoEnvironment = { getWorker: () => new EditorWorker() }
loader.config({ monaco })

/** Blue for added code and orange for removed code. Red and green look alike for many color-blind users. */
monaco.editor.defineTheme('tesseract', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'diffEditor.insertedTextBackground': '#0072b255',
    'diffEditor.insertedLineBackground': '#0072b228',
    'diffEditorGutter.insertedLineBackground': '#0072b240',
    'diffEditorOverview.insertedForeground': '#0072b2cc',
    'diffEditor.removedTextBackground': '#e69f0050',
    'diffEditor.removedLineBackground': '#e69f0024',
    'diffEditorGutter.removedLineBackground': '#e69f0040',
    'diffEditorOverview.removedForeground': '#e69f00cc'
  }
})

createRoot(document.getElementById('root')!).render(<App />)
