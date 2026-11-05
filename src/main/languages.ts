import { Language, Parser } from 'web-tree-sitter'
import { blankUnrealMacros, readCpp, type ParsedFile } from './cpp'
import { readRust } from './rust'

export type CodeLanguage = 'cpp' | 'rust'

const EXTENSIONS: Record<CodeLanguage, string[]> = {
  cpp: ['.h', '.hpp', '.hh', '.inl', '.cpp', '.cc', '.cxx', '.c'],
  rust: ['.rs']
}

export function codeLanguage(path: string): CodeLanguage | undefined {
  const lower = path.toLowerCase()
  return (Object.keys(EXTENSIONS) as CodeLanguage[]).find((language) => EXTENSIONS[language].some((ext) => lower.endsWith(ext)))
}

export function isCodePath(path: string): boolean {
  return codeLanguage(path) !== undefined
}

let parsersPromise: Promise<Record<CodeLanguage, Parser>> | undefined

/** Loads tree-sitter and one grammar per language, once. */
export function initParsers(runtimeWasm: string, grammarWasm: Record<CodeLanguage, string>): Promise<Record<CodeLanguage, Parser>> {
  parsersPromise ??= (async () => {
    await Parser.init({ locateFile: () => runtimeWasm })
    const parsers = {} as Record<CodeLanguage, Parser>
    for (const language of Object.keys(grammarWasm) as CodeLanguage[]) {
      parsers[language] = new Parser()
      parsers[language].setLanguage(await Language.load(grammarWasm[language]))
    }
    return parsers
  })()
  return parsersPromise
}

/** Parses a source file with the grammar of its extension. A file in another language gives no units. */
export async function parseSource(path: string, source: string): Promise<ParsedFile> {
  if (!parsersPromise) throw new Error('initParsers was not called')
  const language = codeLanguage(path)
  if (!language) return { functions: [], classes: [] }
  const parser = (await parsersPromise)[language]
  const tree = parser.parse(language === 'cpp' ? blankUnrealMacros(source) : source)
  if (!tree) return { functions: [], classes: [] }
  const parsed = language === 'cpp' ? readCpp(tree.rootNode) : readRust(tree.rootNode)
  tree.delete()
  return parsed
}
