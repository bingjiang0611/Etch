import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { sha256File } from '../core/fingerprint'
import { runProcess, type ProcessResult, type ProcessSpec } from '../runtime/process-runner'
import { codexTextOnlyVersionIsSupported } from './adapters'

export function codexTextOnlyExecutableIsSupported(version: string | undefined, sha256: string): boolean {
  return codexTextOnlyVersionIsSupported(version) && /^[0-9a-f]{64}$/u.test(sha256)
}

export interface CodexTextOnlyExecutableSnapshot {
  directory: string
  executable: string
}

export interface CodexTextOnlyExecutableAttestation {
  version: string
  sha256: string
}

type ExternalProcessRunner = (spec: ProcessSpec) => Promise<ProcessResult>

async function codexVersion(executable: string, runner: ExternalProcessRunner): Promise<string> {
  const result = await runner({ command: executable, args: ['--version'], cwd: dirname(executable), timeoutMs: 60_000 })
  if (result.exitCode !== 0 || result.timedOut || result.cancelled
    || result.stdoutTruncated || result.stderrTruncated) {
    throw new Error(`Codex CLI 快照版本探测失败：${result.stderr.trim() || `exit ${result.exitCode ?? 'signal'}`}`)
  }
  const version = `${result.stdout}\n${result.stderr}`.trim().split('\n')[0]
  if (!version) throw new Error('Codex CLI 快照没有返回版本')
  return version
}

export async function createCodexTextOnlyExecutableSnapshot(
  executable: string,
  taskDirectory: string
): Promise<CodexTextOnlyExecutableSnapshot> {
  const directory = await mkdtemp(join(taskDirectory, `.codex-text-only-${randomUUID()}-`))
  const snapshot = { directory, executable: join(directory, 'codex') }
  try {
    await chmod(directory, 0o700)
    await copyFile(executable, snapshot.executable, constants.COPYFILE_FICLONE)
    await chmod(snapshot.executable, 0o700)
    return snapshot
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

export async function attestCodexTextOnlyExecutableSnapshot(
  snapshot: CodexTextOnlyExecutableSnapshot,
  runner: ExternalProcessRunner = runProcess
): Promise<CodexTextOnlyExecutableAttestation> {
  const [version, sha256] = await Promise.all([
    codexVersion(snapshot.executable, runner),
    sha256File(snapshot.executable)
  ])
  return { version, sha256 }
}

export async function removeCodexTextOnlyExecutableSnapshot(
  snapshot: CodexTextOnlyExecutableSnapshot
): Promise<void> {
  await rm(snapshot.directory, { recursive: true, force: true })
}

const STALE_SNAPSHOT_DIRECTORY = /^\.codex-text-only-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-[a-z0-9]+$/iu

export async function removeStaleCodexTextOnlyExecutableSnapshots(taskDirectory: string): Promise<string[]> {
  const removed: string[] = []
  for (const entry of await readdir(taskDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !STALE_SNAPSHOT_DIRECTORY.test(entry.name)) continue
    await rm(join(taskDirectory, entry.name), { recursive: true, force: true })
    removed.push(entry.name)
  }
  return removed
}
