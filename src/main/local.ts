import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, closeSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Local revision ids start here. Server revision ids and git blob ids stay below 2^52, so the ranges do not overlap.
 * The highest local id is 2^53 - 1, which is still a safe JavaScript integer.
 */
const LOCAL_ID_BASE = 2 ** 52

/** A file with a zero byte in its first bytes is binary. Git uses the same test. A UTF-16 file has zero bytes too, so its byte order mark makes it text. */
const BINARY_SNIFF_BYTES = 8000

/**
 * Revisions of files on disk, for the review of local changes. The id comes from a hash of the content.
 * A changed file thus gets a new id, and the revision cache and the saved AI results never show old content.
 */
export class LocalRevisions {
  private readonly paths = new Map<number, string>()

  /** Returns the revision id of the file at path, or 0 when the file does not exist. */
  add(path: string): number {
    if (!existsSync(path)) return 0
    const hash = createHash('sha1').update(readFileSync(path)).digest('hex')
    const id = LOCAL_ID_BASE + parseInt(hash.slice(0, 13), 16)
    this.paths.set(id, path)
    return id
  }

  /** Copies the local revisions into dir/<revId> and returns the ids that are not local. */
  fetch(revIds: number[], dir: string): number[] {
    mkdirSync(dir, { recursive: true })
    const rest: number[] = []
    for (const id of revIds) {
      const path = this.paths.get(id)
      if (!path) rest.push(id)
      else if (!existsSync(join(dir, String(id)))) copyFileSync(path, join(dir, String(id)))
    }
    return rest
  }
}

export function isBinaryFile(path: string): boolean {
  if (!existsSync(path)) return false
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(BINARY_SNIFF_BYTES)
    const read = readSync(fd, buffer, 0, BINARY_SNIFF_BYTES, 0)
    const utf16 = (buffer[0] === 0xff && buffer[1] === 0xfe) || (buffer[0] === 0xfe && buffer[1] === 0xff)
    return !utf16 && buffer.subarray(0, read).includes(0)
  } finally {
    closeSync(fd)
  }
}
