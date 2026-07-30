import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sha256File } from '../src/main/core/fingerprint'
import { runProcess } from '../src/main/runtime/process-runner'
import {
  attestCodexTextOnlyExecutableSnapshot,
  createCodexTextOnlyExecutableSnapshot,
  removeCodexTextOnlyExecutableSnapshot,
  removeStaleCodexTextOnlyExecutableSnapshots
} from '../src/main/providers/codex-capability'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('Codex text-only executable snapshot', () => {
  it('creates a private task-local clone, attests the actual clone, and removes it', async () => {
    const taskDirectory = await mkdtemp(join(tmpdir(), 'etch-codex-snapshot-'))
    directories.push(taskDirectory)
    const source = join(taskDirectory, 'source-codex')
    await writeFile(source, '#!/bin/sh\necho "codex-cli test-snapshot"\n', 'utf8')
    await chmod(source, 0o755)

    const snapshot = await createCodexTextOnlyExecutableSnapshot(source, taskDirectory)
    const runner = vi.fn(runProcess)
    const attestation = await attestCodexTextOnlyExecutableSnapshot(snapshot, runner)

    expect(snapshot.executable).not.toBe(source)
    expect(snapshot.executable.startsWith(`${taskDirectory}/.codex-text-only-`)).toBe(true)
    expect(await readFile(snapshot.executable, 'utf8')).toBe(await readFile(source, 'utf8'))
    expect((await stat(snapshot.directory)).mode & 0o777).toBe(0o700)
    expect((await stat(snapshot.executable)).mode & 0o777).toBe(0o700)
    expect(attestation).toEqual({
      version: 'codex-cli test-snapshot',
      sha256: await sha256File(snapshot.executable)
    })
    expect(runner).toHaveBeenCalledWith(expect.objectContaining({ command: snapshot.executable, args: ['--version'], timeoutMs: 60_000 }))

    await removeCodexTextOnlyExecutableSnapshot(snapshot)
    await expect(access(snapshot.directory)).rejects.toThrow()
  })

  it('removes a partially created snapshot when the source copy fails', async () => {
    const taskDirectory = await mkdtemp(join(tmpdir(), 'etch-codex-snapshot-failure-'))
    directories.push(taskDirectory)

    await expect(createCodexTextOnlyExecutableSnapshot(join(taskDirectory, 'missing-codex'), taskDirectory)).rejects.toThrow()

    expect((await readdir(taskDirectory)).filter((name) => name.startsWith('.codex-text-only-'))).toEqual([])
  })

  it('removes only strictly matching stale snapshot directories during startup recovery', async () => {
    const taskDirectory = await mkdtemp(join(tmpdir(), 'etch-codex-stale-snapshot-'))
    directories.push(taskDirectory)
    const stale = '.codex-text-only-123e4567-e89b-42d3-a456-426614174000-ABC123'
    const nonMatching = '.codex-text-only-not-a-snapshot'
    const matchingFile = '.codex-text-only-123e4567-e89b-42d3-a456-426614174001-ABC123'
    await mkdir(join(taskDirectory, stale))
    await writeFile(join(taskDirectory, stale, 'codex'), 'orphan', 'utf8')
    await mkdir(join(taskDirectory, nonMatching))
    await writeFile(join(taskDirectory, matchingFile), 'not a directory', 'utf8')

    await expect(removeStaleCodexTextOnlyExecutableSnapshots(taskDirectory)).resolves.toEqual([stale])

    await expect(access(join(taskDirectory, stale))).rejects.toThrow()
    await expect(access(join(taskDirectory, nonMatching))).resolves.toBeUndefined()
    await expect(access(join(taskDirectory, matchingFile))).resolves.toBeUndefined()
  })
})
