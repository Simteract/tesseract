import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import type { ChangeStatus, Commit, FileChange, ReviewComment, ReviewSummary, Reviewer } from '../shared/types'
import { isCodePath } from './languages'
import { isBinaryFile, type LocalRevisions } from './local'

const FIELD_SEPARATOR = '#~#'

/**
 * The change status of each 'cm status' code. CO is a checkout, which can have no content change.
 * Ignored, cloaked and other codes are left out.
 */
const PENDING_STATUS: Record<string, ChangeStatus> = {
  CH: 'C',
  CO: 'C',
  RP: 'C',
  AD: 'A',
  CP: 'A',
  PR: 'A',
  DE: 'D',
  LD: 'D',
  MV: 'M',
  LM: 'M'
}

/** Number of 'revid;file' pairs in one 'cm getfile' call. It keeps the command line under the Windows limit. */
const GETFILE_BATCH = 40

export class Cm {
  constructor(private readonly workspace: string) {}

  run(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn('cm', args, { cwd: this.workspace, windowsHide: true })
      const out: Buffer[] = []
      const err: Buffer[] = []
      child.stdout.on('data', (d: Buffer) => out.push(d))
      child.stderr.on('data', (d: Buffer) => err.push(d))
      child.on('error', reject)
      child.on('close', (code) => {
        const stdout = Buffer.concat(out).toString('utf8')
        if (code === 0) resolve(stdout)
        else reject(new Error(`cm ${args[0]} failed (${code}): ${Buffer.concat(err).toString('utf8') || stdout}`))
      })
    })
  }

  async whoami(): Promise<string> {
    return (await this.run(['whoami'])).trim()
  }

  async workspaceBranch(): Promise<string> {
    const info = await this.run(['wi'])
    const match = /Branch\s+([^@\r\n]+)@/.exec(info)
    return match ? match[1].trim() : info.trim()
  }

  async findReviews(query: string): Promise<ReviewSummary[]> {
    const xml = await this.run(['find', 'review', query, '--xml', '--encoding=utf-8'])
    return parseRecords(xml, 'REVIEW').map(toReview)
  }

  async branchName(objectId: number): Promise<string> {
    return (await this.run(['find', 'branch', `where id=${objectId}`, '--format={name}', '--nototal'])).trim()
  }

  async changesetNumber(objectId: number): Promise<number> {
    return Number((await this.run(['find', 'changeset', `where id=${objectId}`, '--format={changesetid}', '--nototal'])).trim())
  }

  /**
   * Lists the files that the branch changes. '--integration' drops the changes merged in from the parent branch.
   * '--integration' lists only the changes that are not merged into the parent yet, so it is empty for a merged branch.
   * A merged branch can still have an open review, so an empty result falls back to mergedBranchDiff.
   */
  async diffBranch(branch: string): Promise<FileChange[]> {
    const pending = await this.diff([`br:${branch}`, '--integration'])
    return pending.length > 0 ? pending : this.mergedBranchDiff(branch)
  }

  /**
   * After a merge of parent changeset S into the branch, the branch head holds S plus the own changes
   * of the branch. So the diff from S to the head lists only the own changes. The plain branch diff
   * also lists every file of the merge, e.g. 2170 files instead of 81.
   */
  private async mergedBranchDiff(branch: string): Promise<FileChange[]> {
    const parent = branch.slice(0, branch.lastIndexOf('/'))
    const quoted = (name: string): string => name.replace(/'/g, "''")
    if (!parent) return this.diff([`br:${branch}`])
    const merges = await this.run(['find', 'merge', `where dstbranch='br:${quoted(branch)}'`, `--format={srcbranch}${FIELD_SEPARATOR}{srcchangeset}`, '--nototal'])
    const lastParentMerge = Math.max(
      0,
      ...merges
        .split(/\r?\n/)
        .map((line) => line.split(FIELD_SEPARATOR))
        .filter(([source]) => source === `br:${parent}`)
        .map(([, changeset]) => Number(changeset) || 0)
    )
    const changesets = await this.run(['find', 'changeset', `where branch='${quoted(branch)}'`, '--format={changesetid}', '--nototal'])
    const head = Math.max(0, ...changesets.split(/\r?\n/).map((line) => Number(line) || 0))
    return lastParentMerge > 0 && head > 0 ? this.diff([`cs:${lastParentMerge}`, `cs:${head}`]) : this.diff([`br:${branch}`])
  }

  diffChangeset(changeset: number): Promise<FileChange[]> {
    return this.diff([`cs:${changeset}`])
  }

  /** Lists the files that changed after changeset 'from', up to changeset 'to'. */
  diffRange(from: string, to: string): Promise<FileChange[]> {
    return this.diff([`cs:${from}`, `cs:${to}`])
  }

  /** The changesets of a branch, oldest first. */
  async branchChangesets(branch: string): Promise<Commit[]> {
    const xml = await this.run(['find', 'changeset', `where branch='${branch.replace(/'/g, "''")}'`, '--xml', '--encoding=utf-8'])
    return parseRecords(xml, 'CHANGESET')
      .map((r) => ({ id: r.CHANGESETID, parentId: r.PARENT, title: r.COMMENT ?? '', author: r.OWNER, date: r.DATE }))
      .sort((a, b) => Number(a.id) - Number(b.id))
  }

  private async diff(specArgs: string[]): Promise<FileChange[]> {
    const format = ['{status}', '{type}', '{baserevid}', '{revid}', '{srccmpath}', '{path}'].join(FIELD_SEPARATOR)
    const out = await this.run(['diff', ...specArgs, '--repositorypaths', `--format=${format}`])
    return out
      .split(/\r?\n/)
      .filter((line) => line.includes(FIELD_SEPARATOR))
      .map((line) => line.split(FIELD_SEPARATOR))
      .filter(([, type]) => type !== 'D' && type !== 'X')
      .map(([status, type, base, rev, src, path]) => {
        const cleanPath = unquote(path)
        const srcPath = unquote(src)
        return {
          path: cleanPath,
          srcPath: srcPath && srcPath !== cleanPath ? srcPath : undefined,
          status: status as ChangeStatus,
          itemType: type,
          baseRevId: Number(base),
          headRevId: status === 'D' ? -1 : Number(rev),
          isCode: isCodePath(cleanPath)
        }
      })
  }

  /**
   * Lists the pending changes of the workspace. The base side is the revision that the workspace loaded,
   * and the head side is the file on disk. A moved item line has two more fields: the similarity and the source path.
   */
  async pendingChanges(local: LocalRevisions): Promise<FileChange[]> {
    const out = await this.run(['status', '--all', '--machinereadable', '--includeRevId', `--fieldseparator=${FIELD_SEPARATOR}`, '--noheader'])
    const files: FileChange[] = []
    for (const line of out.split(/\r?\n/)) {
      const fields = line.split(FIELD_SEPARATOR)
      const status = PENDING_STATUS[fields[0]]
      if (!status) continue
      const moved = status === 'M'
      const [srcPath, diskPath, isDir, revId] = moved ? fields.slice(2) : [undefined, ...fields.slice(1)]
      if (!diskPath || isDir === 'True') continue
      const path = this.toRepositoryPath(diskPath)
      files.push({
        path,
        srcPath: moved && srcPath ? this.toRepositoryPath(srcPath) : undefined,
        status,
        itemType: !isCodePath(path) && isBinaryFile(diskPath) ? 'B' : 'F',
        baseRevId: status === 'A' ? 0 : Number(revId),
        headRevId: status === 'D' ? -1 : local.add(diskPath),
        isCode: isCodePath(path)
      })
    }
    return files
  }

  /** Downloads each revision into 'dir/<revid>' once. Later calls reuse the cached files. */
  async fetchRevisions(revIds: number[], dir: string, onProgress?: (done: number, total: number) => void, signal?: AbortSignal): Promise<void> {
    mkdirSync(dir, { recursive: true })
    const missing = [...new Set(revIds)].filter((id) => id > 0 && !existsSync(join(dir, String(id))))
    for (let i = 0; i < missing.length; i += GETFILE_BATCH) {
      signal?.throwIfAborted()
      onProgress?.(i, missing.length)
      const pairs = missing.slice(i, i + GETFILE_BATCH).map((id) => `revid:${id};${join(dir, String(id))}`)
      await this.run(['getfile', ...pairs])
    }
    if (missing.length > 0) onProgress?.(missing.length, missing.length)
  }

  async findComments(reviewId: number): Promise<ReviewComment[]> {
    const xml = await this.run(['find', 'changereviewcomment', `where reviewid=${reviewId} order by date asc`, '--xml', '--encoding=utf-8'])
    return parseRecords(xml, 'CHANGEREVIEWCOMMENT').map((r) => ({
      id: Number(r.ID),
      guid: r.GUID,
      owner: r.OWNER,
      date: r.DATE,
      text: r.COMMENT ?? '',
      type: r.TYPE,
      parentId: Number(r.PARENT),
      revisionId: Number(r.REVISIONID),
      line: r.LINE ? Number(r.LINE) : undefined,
      changeset: Number(r.CHANGESET)
    }))
  }

  /** Maps revision ids to repository paths. 'cm find revision' prints workspace paths, so the workspace root is cut off. */
  async revisionPaths(revIds: number[]): Promise<Map<number, string>> {
    const result = new Map<number, string>()
    const ids = [...new Set(revIds)].filter((id) => id > 0)
    for (let i = 0; i < ids.length; i += 50) {
      const where = 'where ' + ids.slice(i, i + 50).map((id) => `id=${id}`).join(' or ')
      const out = await this.run(['find', 'revision', where, `--format={id}${FIELD_SEPARATOR}{item}`, '--nototal'])
      for (const line of out.split(/\r?\n/)) {
        const [id, item] = line.split(FIELD_SEPARATOR)
        if (item) result.set(Number(id), this.toRepositoryPath(item.trim()))
      }
    }
    return result
  }

  private toRepositoryPath(workspacePath: string): string {
    const rel = relative(this.workspace, workspacePath)
    return '/' + rel.split(sep).join('/')
  }

  async reviewers(reviewId: number): Promise<Reviewer[]> {
    const out = await this.run(['codereview', 'reviewer', 'list', String(reviewId), `--format={user}${FIELD_SEPARATOR}{status}${FIELD_SEPARATOR}{type}`])
    return out
      .split(/\r?\n/)
      .filter((line) => line.includes(FIELD_SEPARATOR))
      .map((line) => {
        const [user, status, type] = line.split(FIELD_SEPARATOR)
        return { user: user.trim(), status, type }
      })
  }

  async addComment(reviewId: number, text: string, path?: string, line?: number, type?: string): Promise<void> {
    const args = ['codereview', 'comment', 'add', String(reviewId), `-c=${text}`]
    if (path && line) args.push(`--path=${path}`, `--line=${line}`, `--type=${type ?? 'Comment'}`)
    await this.run(args)
  }

  async replyComment(guid: string, text: string, discard: boolean): Promise<void> {
    const args = ['codereview', 'comment', 'reply', guid, `-c=${text}`]
    if (discard) args.push('--discard')
    await this.run(args)
  }

  async editComment(guid: string, text: string): Promise<void> {
    await this.run(['codereview', 'comment', 'edit', guid, `-c=${text}`])
  }

  async deleteComment(guid: string): Promise<void> {
    await this.run(['codereview', 'comment', 'delete', guid])
  }

  async setMyStatus(reviewId: number, status: string, comment?: string): Promise<void> {
    const args = ['codereview', 'review', String(reviewId), `--${status}`]
    if (comment) args.push(`-c=${comment}`)
    await this.run(args)
  }
}

function unquote(value: string | undefined): string {
  return (value ?? '').trim().replace(/^"(.*)"$/, '$1')
}

function toReview(r: Record<string, string>): ReviewSummary {
  return {
    id: Number(r.ID),
    guid: r.GUID ?? '',
    title: r.TITLE ?? '',
    owner: r.OWNER ?? '',
    date: r.DATE ?? '',
    status: (r.STATUS ?? '').replace(/^Status\s+/, ''),
    assignee: r.ASSIGNEE ?? '',
    targetType: r.TARGETTYPE ?? '',
    targetId: Number((r.TARGET ?? '').replace(/^id:/, ''))
  }
}

/** Reads flat records from 'cm find --xml' output. Each record holds only leaf elements, so a regex is enough. */
export function parseRecords(xml: string, tag: string): Record<string, string>[] {
  const records: Record<string, string>[] = []
  const recordPattern = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g')
  for (const match of xml.matchAll(recordPattern)) {
    const record: Record<string, string> = {}
    for (const field of match[1].matchAll(/<([A-Z_]+)>([\s\S]*?)<\/\1>|<([A-Z_]+)\s*\/>/g)) {
      if (field[1]) record[field[1]] = decodeEntities(field[2])
      else record[field[3]] = ''
    }
    records.push(record)
  }
  return records
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, '&')
}
