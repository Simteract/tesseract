import type { Node } from 'web-tree-sitter'
import type { ParsedClass, ParsedFile, ParsedFunction } from './cpp'

/** Items that hold declarations. A change inside one, but outside a function, goes to a declarations unit of the item. */
const TYPE_ITEMS = ['struct_item', 'enum_item', 'union_item', 'trait_item', 'impl_item']

/** Reads functions and type items from a Rust syntax tree. A method gets the name of its impl or trait type as its class. */
export function readRust(root: Node): ParsedFile {
  const functions: ParsedFunction[] = []
  for (const fn of root.descendantsOfType('function_item')) {
    const name = fn?.childForFieldName('name')?.text
    if (!fn || !name) continue
    const className = enclosingType(fn)
    functions.push({
      qualifiedName: className ? `${className}::${name}` : name,
      name,
      className,
      startLine: fn.startPosition.row + 1,
      endLine: fn.endPosition.row + 1,
      calls: calledNames(fn)
    })
  }
  const classes: ParsedClass[] = []
  for (const item of root.descendantsOfType(TYPE_ITEMS)) {
    const name = item ? typeItemName(item) : undefined
    if (!item || !name) continue
    classes.push({ name, startLine: item.startPosition.row + 1, endLine: item.endPosition.row + 1 })
  }
  return { functions, classes }
}

/** The impl item names its type in the 'type' field. The other items name it in the 'name' field. */
function typeItemName(item: Node): string | undefined {
  const node = item.type === 'impl_item' ? item.childForFieldName('type') : item.childForFieldName('name')
  return node ? baseTypeName(node) : undefined
}

/** 'Vec<T>' gives 'Vec', and 'crate::roads::Lane' gives 'Lane'. */
function baseTypeName(node: Node): string {
  return node.text.replace(/<[\s\S]*$/, '').split('::').pop()!.trim()
}

function enclosingType(node: Node): string | undefined {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.type === 'impl_item' || parent.type === 'trait_item') return typeItemName(parent)
    if (parent.type === 'function_item') return undefined
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
    case 'scoped_identifier':
      return node.childForFieldName('name')?.text
    case 'generic_function': {
      const inner = node.childForFieldName('function')
      return inner ? lastName(inner) : undefined
    }
    default:
      return undefined
  }
}
