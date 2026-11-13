import type { AssetGroup, AssetKind, AssetProperties, Blueprint, BpGraph, BpNode, BpPin } from '../shared/types'

/** The first four bytes of each Unreal package file. */
const PACKAGE_FILE_TAG = 0x9e2a83c1

/** The oldest UE4 file version that the reader supports. Older packages store the header in other ways. */
const MIN_UE4_VERSION = 518

/** UE5 file versions that change the layout of the header or of the property tags. */
const UE5 = {
  OPTIONAL_RESOURCES: 1003,
  LARGE_WORLD_COORDINATES: 1004,
  REMOVE_OBJECT_EXPORT_PACKAGE_GUID: 1005,
  TRACK_OBJECT_EXPORT_IS_INHERITED: 1006,
  FSOFTOBJECTPATH_REMOVE_ASSET_PATH_FNAMES: 1007,
  ADD_SOFTOBJECTPATH_LIST: 1008,
  SCRIPT_SERIALIZATION_OFFSET: 1010,
  PROPERTY_TAG_EXTENSION: 1011,
  PROPERTY_TAG_COMPLETE_TYPE_NAME: 1012,
  METADATA_SERIALIZATION_OFFSET: 1014,
  VERSE_CELLS: 1015,
  PACKAGE_SAVED_HASH: 1016
}

/** Custom versions that change the layout of the graph pins. The key is the version GUID as four hex words. */
const CUSTOM = {
  UE5_MAIN: '697dd581-e64f41ab-aa4a51ec-beb7b628',
  UE5_RELEASE: 'd89b5e42-24bd4d46-8412aca8-df641779'
}

/** FUE5MainStreamObjectVersion::EdGraphPinSourceIndex adds the source index to each pin. */
const MAIN_EDGRAPH_PIN_SOURCE_INDEX = 50

/** FUE5ReleaseStreamObjectVersion::SerializeFloatPinDefaultValuesAsSinglePrecision adds a flag to each pin type. */
const RELEASE_FLOAT_PIN_PRECISION = 36

/** The package flag of cooked packages. Cooked packages have no graphs. */
const PKG_FILTER_EDITOR_ONLY = 0x80000000

/** EPinContainerType::Map. A map pin also stores the value type. */
const PIN_CONTAINER_MAP = 3

/** Structs that the old property tag format stores as raw bytes, not as nested property tags. */
const NATIVE_STRUCTS = new Set([
  'Guid', 'Vector', 'Vector2D', 'Vector4', 'Rotator', 'Quat', 'LinearColor', 'Color', 'IntPoint', 'IntVector',
  'Box', 'Box2D', 'Plane', 'DateTime', 'Timespan', 'SoftObjectPath', 'SoftClassPath', 'GameplayTagContainer',
  'GameplayTag', 'FrameNumber', 'PerPlatformFloat', 'PerPlatformInt', 'PerPlatformBool', 'Matrix', 'Vector3f', 'Vector3d',
  'StaticMaterial', 'SkeletalMaterial'
])

interface Export {
  className: string
  name: string
  outer: number
  serialOffset: number
  serialSize: number
  scriptStart: number
  scriptEnd: number
}

interface TypeName {
  name: string
  params: TypeName[]
}

type Value = string | number | boolean | undefined | Value[] | { [key: string]: Value }

/** A little-endian reader over the bytes of one package. */
class Reader {
  pos = 0
  constructor(readonly buf: Buffer) {}
  u8(): number { return this.buf.readUInt8(this.pos++) }
  i8(): number { return this.buf.readInt8(this.pos++) }
  i16(): number { const v = this.buf.readInt16LE(this.pos); this.pos += 2; return v }
  u16(): number { const v = this.buf.readUInt16LE(this.pos); this.pos += 2; return v }
  i32(): number { const v = this.buf.readInt32LE(this.pos); this.pos += 4; return v }
  u32(): number { const v = this.buf.readUInt32LE(this.pos); this.pos += 4; return v }
  i64(): number { const v = Number(this.buf.readBigInt64LE(this.pos)); this.pos += 8; return v }
  u64(): number { const v = Number(this.buf.readBigUInt64LE(this.pos)); this.pos += 8; return v }
  f32(): number { const v = this.buf.readFloatLE(this.pos); this.pos += 4; return v }
  f64(): number { const v = this.buf.readDoubleLE(this.pos); this.pos += 8; return v }
  bool(): boolean { return this.u32() !== 0 }
  skip(n: number): void { this.pos += n }
  guid(): string {
    const words = [this.u32(), this.u32(), this.u32(), this.u32()]
    return words.map((w) => w.toString(16).padStart(8, '0')).join('-')
  }
  fstring(): string {
    const length = this.i32()
    if (length === 0) return ''
    if (length > 0) {
      if (length > 1 << 20) throw new Error(`bad string length ${length}`)
      const text = this.buf.toString('latin1', this.pos, this.pos + length - 1)
      this.pos += length
      return text
    }
    if (-length > 1 << 20) throw new Error(`bad string length ${length}`)
    const text = this.buf.toString('utf16le', this.pos, this.pos - length * 2 - 2)
    this.pos -= length * 2
    return text
  }
}

/** Returns true when the file starts with the tag of an Unreal package. */
export function isUnrealPackage(bytes: Buffer): boolean {
  return bytes.length > 32 && bytes.readUInt32LE(0) === PACKAGE_FILE_TAG
}

/**
 * Reads the graphs of a Blueprint asset. Returns undefined when the package has no Blueprint
 * graphs, for example a mesh, a texture or a cooked package. Throws on a package format that the
 * reader does not know.
 */
export function readBlueprint(bytes: Buffer): Blueprint | undefined {
  return new PackageReader(bytes).blueprint()
}

/**
 * Reads the properties of an asset: a Data Asset, a DataTable with its rows, or the class defaults
 * of a Blueprint. Returns undefined for a cooked package or a package without a main object.
 * Throws on a package format that the reader does not know.
 */
export function readAssetProperties(bytes: Buffer): AssetProperties | undefined {
  return new PackageReader(bytes).assetProperties()
}

/** Top-level exports that hold package data, not the asset. */
const PACKAGE_HELPERS = new Set(['MetaData', 'PackageMetaData'])

/** Asset properties that the editor changes on import or save, not the user. */
const ASSET_NOISE = new Set(['AssetImportData', 'ThumbnailInfo', 'AssetUserData', 'UberGraphFrame'])

/** Classes of sub-objects that hold import and thumbnail data, not the asset. */
const NOISE_OBJECTS = /ImportData$|ThumbnailInfo/

/** The suffix that a user-defined struct adds to each field name, for example "_12_8F3A...". */
const STRUCT_FIELD_SUFFIX = /_\d+_[0-9A-F]{32}(?=\[|$)/

/** The text value of each element of a set. A set has keys but no values. */
const IN_SET = 'in set'

class PackageReader {
  private readonly r: Reader
  private ue4 = 0
  private ue5 = 0
  private flags = 0
  private readonly custom = new Map<string, number>()
  private names: string[] = []
  /** The soft object paths of the package. When the list exists, each soft path in an object is an index into it. */
  private softPaths: string[] = []
  private imports: { className: string; name: string; outer: number }[] = []
  private exports: Export[] = []

  constructor(bytes: Buffer) {
    this.r = new Reader(bytes)
    this.readSummary()
  }

  private readSummary(): void {
    const r = this.r
    if (r.u32() !== PACKAGE_FILE_TAG) throw new Error('not an Unreal package')
    const legacy = r.i32()
    if (legacy > -7 || legacy < -9) throw new Error(`unsupported package version ${legacy}`)
    r.i32()
    this.ue4 = r.i32()
    this.ue5 = legacy <= -8 ? r.i32() : 0
    r.i32()
    if (this.ue4 < MIN_UE4_VERSION) throw new Error(`package from an old engine (file version ${this.ue4})`)
    if (this.ue5 >= UE5.PACKAGE_SAVED_HASH) {
      r.skip(20)
      r.i32()
    }
    const customCount = r.i32()
    for (let i = 0; i < customCount; i++) {
      const key = r.guid()
      this.custom.set(key, r.i32())
    }
    if (this.ue5 < UE5.PACKAGE_SAVED_HASH) r.i32()
    r.fstring()
    this.flags = r.u32()
    const nameCount = r.i32()
    const nameOffset = r.i32()
    let softPathCount = 0
    let softPathOffset = 0
    if (this.ue5 >= UE5.ADD_SOFTOBJECTPATH_LIST) {
      softPathCount = r.i32()
      softPathOffset = r.i32()
    }
    if (!this.cooked()) r.fstring()
    r.skip(8)
    const exportCount = r.i32()
    const exportOffset = r.i32()
    const importCount = r.i32()
    const importOffset = r.i32()

    r.pos = nameOffset
    for (let i = 0; i < nameCount; i++) {
      this.names.push(r.fstring())
      r.skip(4)
    }
    r.pos = importOffset
    for (let i = 0; i < importCount; i++) {
      r.skip(8)
      const className = this.fname()
      const outer = r.i32()
      const name = this.fname()
      if (!this.cooked()) r.skip(8)
      if (this.ue5 >= UE5.OPTIONAL_RESOURCES) r.skip(4)
      this.imports.push({ className, name, outer })
    }
    r.pos = exportOffset
    for (let i = 0; i < exportCount; i++) {
      const classIndex = r.i32()
      r.skip(8)
      const outer = r.i32()
      const name = this.fname()
      r.skip(4)
      const serialSize = r.i64()
      const serialOffset = r.i64()
      r.skip(12)
      if (this.ue5 < UE5.REMOVE_OBJECT_EXPORT_PACKAGE_GUID) r.skip(16)
      if (this.ue5 >= UE5.TRACK_OBJECT_EXPORT_IS_INHERITED) r.skip(4)
      r.skip(4 + 4 + 4)
      if (this.ue5 >= UE5.OPTIONAL_RESOURCES) r.skip(4)
      r.skip(20)
      let scriptStart = 0
      let scriptEnd = -1
      if (this.ue5 >= UE5.SCRIPT_SERIALIZATION_OFFSET) {
        scriptStart = r.i64()
        scriptEnd = r.i64()
      }
      this.exports.push({ className: '', name, outer, serialOffset, serialSize, scriptStart, scriptEnd, classIndex } as Export & { classIndex: number })
    }
    for (const e of this.exports as (Export & { classIndex: number })[]) e.className = this.objectName(e.classIndex)
    r.pos = softPathOffset
    for (let i = 0; i < softPathCount; i++) this.softPaths.push(this.fullSoftPath())
  }

  private cooked(): boolean {
    return (this.flags & PKG_FILTER_EDITOR_ONLY) !== 0
  }

  private fname(): string {
    const index = this.r.i32()
    const number = this.r.i32()
    const base = this.names[index]
    if (base === undefined) throw new Error(`bad name index ${index}`)
    return number > 0 ? `${base}_${number - 1}` : base
  }

  private objectName(index: number): string {
    if (index > 0) return this.exports[index - 1]?.name ?? ''
    if (index < 0) return this.imports[-index - 1]?.name ?? ''
    return ''
  }

  private objectRef(): string {
    return this.objectName(this.r.i32())
  }

  blueprint(): Blueprint | undefined {
    if (this.cooked()) return undefined
    const asset = this.exports.find((e) => /Blueprint$/.test(e.className) && !e.className.endsWith('GeneratedClass'))
    if (!asset) return undefined
    const graphIndexes = new Set<number>()
    this.exports.forEach((e, i) => {
      if (e.className === 'EdGraph') graphIndexes.add(i + 1)
    })
    if (graphIndexes.size === 0) return undefined
    const assetProps = this.properties(asset)
    const graphs = new Map<number, BpGraph>()
    for (const index of graphIndexes) graphs.set(index, { name: this.exports[index - 1].name, nodes: [] })
    this.exports.forEach((e, i) => {
      const graph = graphs.get(e.outer)
      if (!graph || e.className === 'EdGraph') return
      graph.nodes.push(this.node(e, i + 1))
    })
    return {
      className: asset.className,
      parent: typeof assetProps.ParentClass === 'string' ? assetProps.ParentClass : undefined,
      graphs: [...graphs.values()].filter((g) => g.nodes.length > 0).sort((a, b) => graphOrder(a) - graphOrder(b) || a.name.localeCompare(b.name))
    }
  }

  /**
   * The main object is the top-level export of the asset. A Blueprint uses its class default object
   * instead, because the Blueprint object itself holds only editor data.
   */
  assetProperties(): AssetProperties | undefined {
    if (this.cooked()) return undefined
    const top = this.exports
      .map((e, i) => ({ e, index: i + 1 }))
      .filter(({ e }) => e.outer === 0 && !PACKAGE_HELPERS.has(e.className) && !e.className.endsWith('GeneratedClass'))
    const blueprint = top.find(({ e }) => /Blueprint$/.test(e.className))
    const main = blueprint ? top.find(({ e }) => e.name === `Default__${blueprint.e.name}_C`) : top.find(({ e }) => !e.name.startsWith('Default__'))
    if (!main) return undefined
    const kind: AssetKind = blueprint ? 'defaults' : main.e.className === 'DataTable' ? 'table' : 'data'
    const mainProps = flattenAsset(this.properties(main.e))
    const rows = kind === 'table' ? this.tableRows(main.e) : []
    const groups: AssetGroup[] = [{ name: main.e.name, kind: 'object', props: mainProps }, ...rows]
    this.exports.forEach((e, i) => {
      if (e.outer !== main.index || i + 1 === main.index || NOISE_OBJECTS.test(e.className)) return
      try {
        const props = flattenAsset(this.properties(e))
        if (Object.keys(props).length > 0) groups.push({ name: e.name, kind: 'object', props })
      } catch (error) {
        console.warn(`Cannot read the sub-object ${e.name}:`, error)
      }
    })
    return { className: blueprint?.e.className ?? main.e.className, kind, groups }
  }

  /** Reads the rows of a DataTable. UDataTable::Serialize writes them after the object properties. */
  private tableRows(e: Export): AssetGroup[] {
    const r = this.r
    const end = e.serialOffset + e.serialSize
    this.skipObjectGuid()
    const count = r.i32()
    if (count < 0 || count > 1_000_000) throw new Error(`bad row count ${count}`)
    const rows: AssetGroup[] = []
    for (let i = 0; i < count && r.pos < end; i++) {
      const name = this.fname()
      rows.push({ name, kind: 'row', props: flattenAsset(this.taggedProperties(end)) })
    }
    return rows
  }

  private node(e: Export, index: number): BpNode {
    const node: BpNode = { id: e.name, className: e.className, title: e.className, x: 0, y: 0, props: {}, pins: [] }
    try {
      const props = this.properties(e)
      node.props = flattenProps(props)
      node.x = typeof props.NodePosX === 'number' ? props.NodePosX : 0
      node.y = typeof props.NodePosY === 'number' ? props.NodePosY : 0
      if (typeof props.NodeWidth === 'number') node.width = props.NodeWidth
      if (typeof props.NodeHeight === 'number') node.height = props.NodeHeight
      if (typeof props.NodeComment === 'string' && props.NodeComment) node.comment = props.NodeComment
      node.title = nodeTitle(e.className, props)
      this.skipObjectGuid()
      node.pins = this.pins(index)
    } catch (error) {
      node.error = error instanceof Error ? error.message : String(error)
    }
    return node
  }

  /** Reads the tagged properties of an export. The reader then stands at the end of the properties. */
  private properties(e: Export): Record<string, Value> {
    const r = this.r
    r.pos = e.serialOffset + e.scriptStart
    if (this.ue5 >= UE5.PROPERTY_TAG_EXTENSION && r.u8() & 0x02) r.skip(1)
    const props = this.taggedProperties(e.serialOffset + e.serialSize)
    if (e.scriptEnd >= 0) r.pos = e.serialOffset + e.scriptEnd
    return props
  }

  /** UObject::Serialize writes a flag, and a GUID when the object has one, after the properties. */
  private skipObjectGuid(): void {
    if (this.r.bool()) this.r.skip(16)
  }

  private taggedProperties(limit: number): Record<string, Value> {
    const r = this.r
    const props: Record<string, Value> = {}
    while (r.pos < limit) {
      const name = this.fname()
      if (name === 'None') break
      const tag = this.ue5 >= UE5.PROPERTY_TAG_COMPLETE_TYPE_NAME ? this.tag() : this.oldTag()
      const start = r.pos
      if (tag.size < 0 || start + tag.size > limit) throw new Error(`property ${name} goes past its parent`)
      let value: Value
      try {
        value = tag.type.name === 'BoolProperty' ? tag.boolValue : this.value(tag.type, tag.size, tag.native)
      } catch {
        value = undefined
      }
      r.pos = start + tag.size
      const key = tag.arrayIndex > 0 ? `${name}[${tag.arrayIndex}]` : name
      if (value !== undefined) props[key] = value
    }
    return props
  }

  private tag(): { type: TypeName; size: number; arrayIndex: number; boolValue: boolean; native: boolean } {
    const r = this.r
    const type = this.typeName()
    const size = r.i32()
    const flags = r.u8()
    const arrayIndex = flags & 0x01 ? r.i32() : 0
    if (flags & 0x02) r.skip(16)
    if (flags & 0x04) {
      const extensions = r.u8()
      if (extensions & 0x02) r.skip(1 + 4)
    }
    return { type, size, arrayIndex, boolValue: (flags & 0x10) !== 0, native: (flags & 0x08) !== 0 }
  }

  private typeName(): TypeName {
    const name = this.fname()
    const count = this.r.i32()
    const params: TypeName[] = []
    for (let i = 0; i < count; i++) params.push(this.typeName())
    return { name, params }
  }

  private oldTag(): { type: TypeName; size: number; arrayIndex: number; boolValue: boolean; native: boolean } {
    const r = this.r
    const typeName = this.fname()
    const size = r.i32()
    const arrayIndex = r.i32()
    const type: TypeName = { name: typeName, params: [] }
    let boolValue = false
    if (typeName === 'StructProperty') {
      type.params.push({ name: this.fname(), params: [] })
      r.skip(16)
    } else if (typeName === 'BoolProperty') {
      boolValue = r.u8() !== 0
    } else if (typeName === 'ByteProperty' || typeName === 'EnumProperty') {
      const enumName = this.fname()
      if (enumName !== 'None') type.params.push({ name: enumName, params: [] })
    } else if (typeName === 'ArrayProperty' || typeName === 'SetProperty' || typeName === 'OptionalProperty') {
      type.params.push({ name: this.fname(), params: [] })
    } else if (typeName === 'MapProperty') {
      type.params.push({ name: this.fname(), params: [] }, { name: this.fname(), params: [] })
    }
    if (r.u8()) r.skip(16)
    if (this.ue5 >= UE5.PROPERTY_TAG_EXTENSION) {
      const extensions = r.u8()
      if (extensions & 0x02) r.skip(1 + 4)
    }
    const native = typeName === 'StructProperty' && NATIVE_STRUCTS.has(type.params[0]?.name ?? '')
    return { type, size, arrayIndex, boolValue, native }
  }

  private value(type: TypeName, size: number, native: boolean): Value {
    const r = this.r
    switch (type.name) {
      case 'IntProperty': return r.i32()
      case 'Int8Property': return r.i8()
      case 'Int16Property': return r.i16()
      case 'Int64Property': return r.i64()
      case 'UInt16Property': return r.u16()
      case 'UInt32Property': return r.u32()
      case 'UInt64Property': return r.u64()
      case 'FloatProperty': return round(r.f32())
      case 'DoubleProperty': return round(r.f64())
      case 'NameProperty': return this.fname()
      case 'StrProperty': return r.fstring()
      case 'TextProperty': return this.text()
      case 'EnumProperty': return shortEnum(this.fname())
      case 'ByteProperty': return size === 8 ? shortEnum(this.fname()) : r.u8()
      case 'ObjectProperty':
      case 'ClassProperty':
      case 'InterfaceProperty':
      case 'WeakObjectProperty': return this.objectRef()
      case 'SoftObjectProperty':
      case 'SoftClassProperty': return this.softPath()
      case 'BoolProperty': return r.u8() !== 0
      case 'MapProperty': return this.map(type, size)
      case 'SetProperty': return this.set(type, size)
      case 'StructProperty': return this.struct(type.params[0]?.name ?? '', size, native)
      case 'ArrayProperty': return this.array(type.params[0] ?? { name: '', params: [] }, size)
      default: return undefined
    }
  }

  private struct(structName: string, size: number, native: boolean): Value {
    return native ? this.nativeStruct(structName, size) : this.taggedProperties(this.r.pos + size)
  }

  /**
   * Reads a struct that has its own binary form. The size is 0 inside a container. Then the file
   * version tells if the floating point fields are doubles (large world coordinates).
   */
  private nativeStruct(structName: string, size: number): Value {
    const r = this.r
    const doubles = (count: number): boolean => (size > 0 ? size >= count * 8 : this.ue5 >= UE5.LARGE_WORLD_COORDINATES)
    const reals = (count: number): string => {
      const wide = doubles(count)
      return `(${Array.from({ length: count }, () => round(wide ? r.f64() : r.f32())).join(', ')})`
    }
    const ints = (count: number, read: () => number): string => `(${Array.from({ length: count }, read).join(', ')})`
    switch (structName) {
      case 'Guid': return r.guid()
      case 'Vector2D': return reals(2)
      case 'Vector':
      case 'Rotator': return reals(3)
      case 'Vector4':
      case 'Quat':
      case 'Plane': return reals(4)
      case 'Vector3f': return ints(3, () => round(r.f32()))
      case 'Vector3d': return ints(3, () => round(r.f64()))
      case 'IntPoint': return ints(2, () => r.i32())
      case 'IntVector': return ints(3, () => r.i32())
      case 'LinearColor': return ints(4, () => round(r.f32()))
      case 'Color': return ints(4, () => r.u8())
      case 'FrameNumber': return r.i32()
      case 'DateTime':
      case 'Timespan': return r.i64()
      case 'SoftObjectPath':
      case 'SoftClassPath': return this.softPath()
      case 'GameplayTag': return this.fname()
      case 'GameplayTagContainer': {
        const count = r.i32()
        if (count < 0 || count > 10000) throw new Error(`bad tag count ${count}`)
        return Array.from({ length: count }, () => this.fname()).sort().join(', ')
      }
      default: return undefined
    }
  }

  /** Reads one element of an array, a set or a map. The limit is the end of the whole container. */
  private element(type: TypeName, limit: number): Value {
    if (type.name !== 'StructProperty') return this.value(type, 0, false)
    const structName = type.params[0]?.name ?? ''
    if (!structName) throw new Error('struct element without a struct name')
    return NATIVE_STRUCTS.has(structName) ? this.nativeStruct(structName, 0) : this.taggedProperties(limit)
  }

  private array(inner: TypeName, size: number): Value {
    const r = this.r
    const end = r.pos + size
    const count = r.i32()
    if (count < 0 || count > 1_000_000) throw new Error(`bad array count ${count}`)
    let element = inner
    if (inner.name === 'StructProperty' && this.ue5 < UE5.PROPERTY_TAG_COMPLETE_TYPE_NAME) {
      this.fname()
      this.fname()
      r.skip(16)
      const structName = this.fname()
      r.skip(16)
      if (r.u8()) r.skip(16)
      if (this.ue5 >= UE5.PROPERTY_TAG_EXTENSION) {
        const extensions = r.u8()
        if (extensions & 0x02) r.skip(1 + 4)
      }
      element = { name: 'StructProperty', params: [{ name: structName, params: [] }] }
    }
    const items: Value[] = []
    for (let i = 0; i < count && r.pos < end; i++) {
      const item = this.element(element, end)
      if (item === undefined) return undefined
      items.push(item)
    }
    return items
  }

  /**
   * Reads a map. A map saves the keys that it removed from its archetype first, then its entries.
   * The keys become "{key}" parts of the property path.
   */
  private map(type: TypeName, size: number): Value {
    const r = this.r
    const end = r.pos + size
    const [keyType, valueType] = type.params
    if (!keyType || !valueType) return undefined
    this.skipRemovedKeys(keyType, end)
    const count = r.i32()
    if (count < 0 || count > 1_000_000) throw new Error(`bad map count ${count}`)
    const entries: Record<string, Value> = {}
    for (let i = 0; i < count && r.pos < end; i++) {
      const key = this.element(keyType, end)
      const value = this.element(valueType, end)
      if (key === undefined || value === undefined) return undefined
      entries[`{${keyText(key)}}`] = value
    }
    return entries
  }

  private set(type: TypeName, size: number): Value {
    const r = this.r
    const end = r.pos + size
    const itemType = type.params[0]
    if (!itemType) return undefined
    this.skipRemovedKeys(itemType, end)
    const count = r.i32()
    if (count < 0 || count > 1_000_000) throw new Error(`bad set count ${count}`)
    const items: Record<string, Value> = {}
    for (let i = 0; i < count && r.pos < end; i++) {
      const item = this.element(itemType, end)
      if (item === undefined) return undefined
      items[`{${keyText(item)}}`] = IN_SET
    }
    return items
  }

  private skipRemovedKeys(keyType: TypeName, limit: number): void {
    const removed = this.r.i32()
    if (removed < 0 || removed > 1_000_000) throw new Error(`bad removed key count ${removed}`)
    for (let i = 0; i < removed; i++) this.element(keyType, limit)
  }

  private softPath(): string {
    if (this.softPaths.length > 0) return this.softPaths[this.r.i32()] ?? ''
    return this.fullSoftPath()
  }

  private fullSoftPath(): string {
    const r = this.r
    if (this.ue5 >= UE5.FSOFTOBJECTPATH_REMOVE_ASSET_PATH_FNAMES) {
      const pkg = this.fname()
      const asset = this.fname()
      const sub = r.fstring()
      return pkg === 'None' ? '' : `${pkg}.${asset}${sub ? `:${sub}` : ''}`
    }
    const path = this.fname()
    const sub = r.fstring()
    return path === 'None' ? '' : `${path}${sub ? `:${sub}` : ''}`
  }

  /** Reads an FText. Only the plain, localized and string table forms are known, the others throw. */
  private text(): string {
    const r = this.r
    r.i32()
    const history = r.i8()
    if (history === -1) return r.bool() ? r.fstring() : ''
    if (history === 0) {
      r.fstring()
      r.fstring()
      return r.fstring()
    }
    if (history === 11) {
      this.fname()
      return r.fstring()
    }
    throw new Error(`unknown text history ${history}`)
  }

  /** Reads the pins of a graph node. UEdGraphNode::Serialize writes them after the object properties. */
  private pins(nodeIndex: number): BpPin[] {
    const r = this.r
    const count = r.i32()
    if (count < 0 || count > 10000) throw new Error(`bad pin count ${count}`)
    const pins: BpPin[] = []
    for (let i = 0; i < count; i++) {
      if (r.bool()) continue
      const owner = r.i32()
      r.guid()
      if (owner !== nodeIndex) throw new Error('pin of another node')
      pins.push(this.pin())
    }
    return pins
  }

  private pin(): BpPin {
    const r = this.r
    r.i32()
    const id = r.guid()
    const name = this.fname()
    const friendlyName = this.text()
    if ((this.custom.get(CUSTOM.UE5_MAIN) ?? 0) >= MAIN_EDGRAPH_PIN_SOURCE_INDEX) r.i32()
    r.fstring()
    const direction = r.u8() === 1 ? 'out' : 'in'
    const category = this.fname()
    const subCategory = this.fname()
    const subCategoryObject = this.objectRef()
    const container = r.u8()
    if (container === PIN_CONTAINER_MAP) {
      this.fname()
      this.fname()
      r.i32()
      r.skip(12)
    }
    r.skip(8)
    r.i32()
    const memberName = this.fname()
    r.skip(16)
    r.skip(8)
    if ((this.custom.get(CUSTOM.UE5_RELEASE) ?? 0) >= RELEASE_FLOAT_PIN_PRECISION) r.skip(4)
    const defaultValue = r.fstring()
    const autoDefault = r.fstring()
    const defaultObject = this.objectRef()
    const defaultText = this.text()
    const links = this.pinRefs()
    this.pinRefs()
    this.pinRef()
    this.pinRef()
    r.skip(16)
    const bits = r.u32()
    const type = subCategoryObject || (subCategory !== 'None' ? subCategory : '') || (memberName !== 'None' ? memberName : '')
    const pin: BpPin = { id, name, direction, category, links, hidden: (bits & 1) !== 0 }
    if (friendlyName) pin.label = friendlyName
    if (type) pin.type = type
    if (container > 0) pin.container = ['', 'array', 'set', 'map'][container]
    const value = defaultObject || defaultText || defaultValue
    if (value && value !== autoDefault) pin.value = value
    else if (value) pin.autoValue = value
    return pin
  }

  private pinRefs(): { node: string; pin: string }[] {
    const count = this.r.i32()
    if (count < 0 || count > 10000) throw new Error(`bad link count ${count}`)
    const refs: { node: string; pin: string }[] = []
    for (let i = 0; i < count; i++) {
      const ref = this.pinRef()
      if (ref) refs.push(ref)
    }
    return refs
  }

  private pinRef(): { node: string; pin: string } | undefined {
    if (this.r.bool()) return undefined
    const node = this.objectRef()
    const pin = this.r.guid()
    return node ? { node, pin } : undefined
  }
}

/** Keeps 3 decimals, or 7 digits for a very large value such as FLT_MAX, which marks "no value" in curves. */
function round(value: number): number {
  return Math.abs(value) >= 1e9 ? Number(value.toPrecision(7)) : Math.round(value * 1000) / 1000
}

function shortEnum(value: string): string {
  return value.includes('::') ? value.slice(value.lastIndexOf('::') + 2) : value
}

/** Shows the event graph first, then the functions and the macros. */
function graphOrder(graph: BpGraph): number {
  if (graph.name === 'EventGraph') return 0
  if (graph.name.startsWith('UserConstructionScript')) return 1
  return 2
}

function member(props: Record<string, Value>, key: string): string | undefined {
  const ref = props[key]
  if (ref && typeof ref === 'object' && !Array.isArray(ref) && typeof ref.MemberName === 'string') return ref.MemberName
  return undefined
}

/** Makes a short node title, similar to the title in the Blueprint editor. */
function nodeTitle(className: string, props: Record<string, Value>): string {
  const kind = className.replace(/^K2Node_/, '').replace(/^EdGraphNode_/, '')
  const fn = member(props, 'FunctionReference')
  const variable = member(props, 'VariableReference')
  const event = member(props, 'EventReference')
  const custom = typeof props.CustomFunctionName === 'string' ? props.CustomFunctionName : undefined
  if (className === 'EdGraphNode_Comment') return typeof props.NodeComment === 'string' ? props.NodeComment : 'Comment'
  if (custom) return kind === 'CustomEvent' ? `Event ${custom}` : custom
  if (event) return `Event ${event.replace(/^Receive/, '')}`
  if (fn) return kind === 'CallFunction' || kind === 'CallArrayFunction' || kind === 'CallParentFunction' ? fn : `${kind} ${fn}`
  if (variable) return kind === 'VariableGet' ? variable : kind === 'VariableSet' ? `Set ${variable}` : `${kind} ${variable}`
  const macro = props.MacroGraphReference
  if (macro && typeof macro === 'object' && !Array.isArray(macro) && typeof macro.MacroGraph === 'string') return macro.MacroGraph
  for (const key of ['StructType', 'TargetType', 'Enum', 'DelegateReference']) {
    const value = props[key]
    if (typeof value === 'string' && value) return `${kind} ${value}`
  }
  return kind
}

/** Keeps the readable properties of a node for the diff, and drops the layout and the editor state. */
function flattenProps(props: Record<string, Value>): Record<string, string> {
  const skip = new Set(['NodePosX', 'NodePosY', 'NodeWidth', 'NodeHeight', 'NodeGuid', 'ErrorMsg', 'ErrorType', 'bHasCompilerMessage', 'bCommentBubbleVisible', 'bCommentBubblePinned', 'AdvancedPinDisplay', 'EnabledState', 'bCommentBubbleMakeVisible'])
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(props)) {
    if (skip.has(key) || value === undefined) continue
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value)
    if (text === '{}' || text === '[]' || text === '') continue
    out[key] = text
  }
  return out
}

function keyText(key: Value): string {
  return typeof key === 'object' ? JSON.stringify(key) : String(key)
}

function cleanKey(key: string): string {
  return key.replace(STRUCT_FIELD_SUFFIX, '')
}

/** Flattens the properties of an asset to readable paths, for example "Weapons[2].Damage" or "Costs{Gold}". */
function flattenAsset(props: Record<string, Value>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(props)) if (!ASSET_NOISE.has(key)) flattenValue(cleanKey(key), value, out)
  return out
}

function flattenValue(path: string, value: Value, out: Record<string, string>): void {
  if (value === undefined || value === '') return
  if (Array.isArray(value)) {
    value.forEach((item, i) => flattenValue(`${path}[${i}]`, item, out))
    return
  }
  if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) flattenValue(key.startsWith('{') ? `${path}${key}` : `${path}.${cleanKey(key)}`, item, out)
    return
  }
  out[path] = String(value)
}
