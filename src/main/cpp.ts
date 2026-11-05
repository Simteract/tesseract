import type { Node } from 'web-tree-sitter'

export interface ParsedFunction {
  qualifiedName: string
  name: string
  className?: string
  startLine: number
  endLine: number
  calls: string[]
}

export interface ParsedClass {
  name: string
  startLine: number
  endLine: number
}

export interface ParsedFile {
  functions: ParsedFunction[]
  classes: ParsedClass[]
}

/** Unreal macros that tree-sitter cannot read. 'class MYGAME_API UFoo' parses as a class named MYGAME_API without this. */
const UNREAL_MACRO = /\b(?:[A-Z0-9_]+_API|UCLASS|USTRUCT|UENUM|UINTERFACE|UPROPERTY|UFUNCTION|UDELEGATE|UMETA|UPARAM|GENERATED_BODY|GENERATED_UCLASS_BODY|GENERATED_USTRUCT_BODY)\b/g

/** Replaces Unreal macros and their argument lists with spaces. Newlines stay, so line numbers do not move. */
export function blankUnrealMacros(source: string): string {
  const chars = source.split('')
  for (const match of source.matchAll(UNREAL_MACRO)) {
    let end = match.index + match[0].length
    let i = end
    while (i < source.length && (source[i] === ' ' || source[i] === '\t')) i++
    if (source[i] === '(' && !match[0].endsWith('_API')) {
      let depth = 0
      for (; i < source.length; i++) {
        if (source[i] === '(') depth++
        else if (source[i] === ')' && --depth === 0) break
      }
      end = i + 1
    }
    for (let j = match.index; j < end && j < chars.length; j++) if (chars[j] !== '\n' && chars[j] !== '\r') chars[j] = ' '
  }
  return chars.join('')
}

/** Reads functions and classes from a C++ syntax tree. Unreal macros make some trees contain errors, but function boundaries stay correct. */
export function readCpp(root: Node): ParsedFile {
  const functions: ParsedFunction[] = []
  for (const fn of root.descendantsOfType('function_definition')) {
    if (!fn) continue
    const nameNode = functionNameNode(fn)
    if (!nameNode) continue
    const rawName = nameNode.text.replace(/\s+/g, '')
    const segments = rawName.split('::')
    const name = segments[segments.length - 1]
    const className = segments.length > 1 ? segments[segments.length - 2] : enclosingClass(fn)
    functions.push({
      qualifiedName: className && segments.length === 1 ? `${className}::${name}` : rawName,
      name,
      className,
      startLine: fn.startPosition.row + 1,
      endLine: fn.endPosition.row + 1,
      calls: calledNames(fn)
    })
  }
  const classes: ParsedClass[] = []
  for (const cls of root.descendantsOfType(['class_specifier', 'struct_specifier'])) {
    const name = cls?.childForFieldName('name')
    if (!cls || !name || !cls.childForFieldName('body')) continue
    classes.push({ name: name.text, startLine: cls.startPosition.row + 1, endLine: cls.endPosition.row + 1 })
  }
  return { functions, classes }
}

function functionNameNode(fn: Node): Node | null {
  let declarator = fn.childForFieldName('declarator')
  while (declarator && declarator.type !== 'function_declarator') {
    declarator = declarator.childForFieldName('declarator')
  }
  return declarator?.childForFieldName('declarator') ?? null
}

function enclosingClass(node: Node): string | undefined {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.type === 'class_specifier' || parent.type === 'struct_specifier') {
      return parent.childForFieldName('name')?.text
    }
  }
  return undefined
}

function calledNames(fn: Node): string[] {
  const names = new Set<string>()
  for (const call of fn.descendantsOfType('call_expression')) {
    const target = call?.childForFieldName('function')
    const name = target ? lastName(target) : undefined
    if (name) names.add(name)
  }
  return [...names]
}

function lastName(node: Node): string | undefined {
  switch (node.type) {
    case 'identifier':
    case 'field_identifier':
      return node.text
    case 'field_expression':
      return node.childForFieldName('field')?.text
    case 'qualified_identifier':
    case 'template_function':
    case 'template_method': {
      const name = node.childForFieldName('name')
      return name ? lastName(name) : undefined
    }
    default:
      return undefined
  }
}
