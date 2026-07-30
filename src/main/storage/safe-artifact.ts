import { createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, open, realpath, stat, type FileHandle } from 'node:fs/promises'
import { resolve, sep } from 'node:path'

export interface ContainedFileIdentity {
  device: string
  inode: string
  size: number
  mtimeNs: string
  ctimeNs: string
}

export interface ContainedFile extends ContainedFileIdentity {
  bytes: Buffer
  mtimeMs: number
  sha256: string
}

export interface ContainedFileOptions {
  maxBytes?: number
  expectedSize?: number
  expectedSha256?: string
}

interface OpenedContainedFile {
  handle: FileHandle
  identity: ContainedFileIdentity
  mtimeMs: number
  stats: BigIntStats
}

function assertContained(root: string, path: string, label: string): void {
  if (path === root || !path.startsWith(`${root}${sep}`)) throw new Error(`${label}真实路径无效`)
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
}

function identityOf(info: BigIntStats): ContainedFileIdentity {
  return {
    device: String(info.dev),
    inode: String(info.ino),
    size: Number(info.size),
    mtimeNs: String(info.mtimeNs),
    ctimeNs: String(info.ctimeNs)
  }
}

async function openContainedFile(
  taskDirectory: string,
  relativePath: string,
  label: string,
  options: Omit<ContainedFileOptions, 'expectedSha256'>
): Promise<OpenedContainedFile> {
  const logicalRoot = resolve(taskDirectory)
  const logicalPath = resolve(logicalRoot, relativePath)
  if (logicalPath === logicalRoot || !logicalPath.startsWith(`${logicalRoot}${sep}`)) throw new Error(`${label}路径无效`)

  const root = await realpath(logicalRoot)
  const pathSnapshot = await lstat(logicalPath, { bigint: true })
  if (pathSnapshot.isSymbolicLink() || !pathSnapshot.isFile()) throw new Error(`${label}必须是任务目录内的普通文件`)
  const beforePath = await realpath(logicalPath)
  assertContained(root, beforePath, label)

  const handle = await open(logicalPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = await handle.stat({ bigint: true })
    if (!opened.isFile()) throw new Error(`${label}必须是任务目录内的普通文件`)
    if (!sameFile(pathSnapshot, opened)) throw new Error(`${label}在打开前已变化`)
    if (opened.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${label}大小无效`)
    const size = Number(opened.size)
    if (options.maxBytes !== undefined && size > options.maxBytes) throw new Error(`${label}过大：${size} bytes`)
    if (options.expectedSize !== undefined && size !== options.expectedSize) {
      throw new Error(`${label}大小不匹配：${size}/${options.expectedSize}`)
    }

    const afterPath = await realpath(logicalPath)
    assertContained(root, afterPath, label)
    const pathInfo = await stat(afterPath, { bigint: true })
    if (!sameFile(opened, pathInfo)) throw new Error(`${label}在读取前已变化`)
    return { handle, identity: identityOf(opened), mtimeMs: Number(opened.mtimeNs) / 1_000_000, stats: opened }
  } catch (error) {
    await handle.close()
    throw error
  }
}

export async function inspectContainedFile(
  taskDirectory: string,
  relativePath: string,
  label: string,
  options: Omit<ContainedFileOptions, 'expectedSha256'> = {}
): Promise<ContainedFileIdentity> {
  const opened = await openContainedFile(taskDirectory, relativePath, label, options)
  try {
    const after = await opened.handle.stat({ bigint: true })
    if (!sameFile(opened.stats, after)) throw new Error(`${label}在探测期间已变化`)
    return identityOf(after)
  } finally {
    await opened.handle.close()
  }
}

export async function sha256ContainedFile(
  taskDirectory: string,
  relativePath: string,
  label: string,
  options: ContainedFileOptions = {}
): Promise<ContainedFileIdentity & { sha256: string }> {
  const opened = await openContainedFile(taskDirectory, relativePath, label, options)
  try {
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, opened.identity.size)))
    let position = 0
    while (position < opened.identity.size) {
      const { bytesRead } = await opened.handle.read(
        buffer,
        0,
        Math.min(buffer.length, opened.identity.size - position),
        position
      )
      if (!bytesRead) throw new Error(`${label}在哈希期间提前结束`)
      hash.update(buffer.subarray(0, bytesRead))
      position += bytesRead
    }
    const after = await opened.handle.stat({ bigint: true })
    if (!sameFile(opened.stats, after)) throw new Error(`${label}在哈希期间已变化`)
    const sha256 = hash.digest('hex')
    if (options.expectedSha256 !== undefined && sha256 !== options.expectedSha256) {
      throw new Error(`${label} SHA-256 不匹配`)
    }
    return { ...identityOf(after), sha256 }
  } finally {
    await opened.handle.close()
  }
}

export async function readContainedFile(
  taskDirectory: string,
  relativePath: string,
  label: string,
  options: ContainedFileOptions = {}
): Promise<ContainedFile> {
  const opened = await openContainedFile(taskDirectory, relativePath, label, options)
  try {
    const bytes = await opened.handle.readFile()
    const after = await opened.handle.stat({ bigint: true })
    if (
      !sameFile(opened.stats, after)
      || bytes.length !== Number(after.size)
    ) throw new Error(`${label}在读取期间已变化`)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    if (options.expectedSha256 !== undefined && sha256 !== options.expectedSha256) throw new Error(`${label} SHA-256 不匹配`)
    return { ...opened.identity, bytes, mtimeMs: opened.mtimeMs, sha256 }
  } finally {
    await opened.handle.close()
  }
}
