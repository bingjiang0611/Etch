/* global URL, console, process */
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const defaultName = `Etch-${packageJson.version}-arm64.dmg`
const dmgPath = resolve(process.argv[2] ?? join('dist', defaultName))
const mountPoint = mkdtempSync(join(tmpdir(), 'etch-dmg-'))
const verifier = fileURLToPath(new URL('./verify-macos-app.mjs', import.meta.url))
let attached = false
let failure

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  if (result.error || result.status !== 0) {
    const detail = output.trim()
    throw new Error(`${command} ${args.join(' ')} 失败${detail ? `：${detail}` : ''}`)
  }
  return output
}

try {
  if (!existsSync(dmgPath)) throw new Error(`DMG 不存在：${dmgPath}`)
  if (basename(dmgPath) !== defaultName) {
    throw new Error(`DMG 文件名必须为 ${defaultName}，实际为 ${basename(dmgPath)}`)
  }
  run('hdiutil', ['verify', dmgPath])
  run('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mountPoint, dmgPath])
  attached = true

  const allowed = new Set([
    '.background',
    '.background.tiff',
    '.DS_Store',
    '.fseventsd',
    '.Trashes',
    '.VolumeIcon.icns',
    'Applications',
    'Etch.app'
  ])
  const unexpected = readdirSync(mountPoint).filter((entry) => !allowed.has(entry))
  if (unexpected.length) throw new Error(`DMG 包含未预期的顶层内容：${unexpected.join(', ')}`)

  const appPath = join(mountPoint, 'Etch.app')
  if (!existsSync(appPath) || !lstatSync(appPath).isDirectory()) {
    throw new Error('DMG 缺少 Etch.app')
  }
  const applications = join(mountPoint, 'Applications')
  if (!existsSync(applications) || !lstatSync(applications).isSymbolicLink()) {
    throw new Error('DMG 缺少 Applications symlink')
  }
  if (readlinkSync(applications) !== '/Applications') {
    throw new Error(`Applications symlink 指向异常：${readlinkSync(applications)}`)
  }

  run(process.execPath, [verifier, appPath])
  console.log(`Etch DMG 验证通过：${basename(dmgPath)}，卷内 App 为 arm64 ad-hoc hardened runtime`)
} catch (error) {
  failure = error
}
if (attached) {
  try {
    run('hdiutil', ['detach', mountPoint])
  } catch (error) {
    failure ??= error
  }
}
rmSync(mountPoint, { recursive: true, force: true })
if (failure) throw failure
