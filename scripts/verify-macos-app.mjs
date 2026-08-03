/* global URL, console, process */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const appPath = resolve(process.argv[2] ?? 'dist/mac-arm64/Etch.app')
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const packageLock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'))

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  if (result.error || result.status !== 0) {
    const detail = output.trim()
    throw new Error(`${command} ${args.join(' ')} 失败${detail ? `：${detail}` : ''}`)
  }
  return output
}

function assertIncludes(value, expected, label) {
  if (!value.includes(expected)) throw new Error(`${label} 缺少 ${expected}`)
}

function executableFiles(directory) {
  const files = []
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    const stats = lstatSync(path)
    if (stats.isSymbolicLink()) continue
    if (stats.isDirectory()) files.push(...executableFiles(path))
    else if (stats.isFile() && (stats.mode & 0o111) !== 0) files.push(path)
  }
  return files
}

run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath])

const signedTargets = [
  appPath,
  join(appPath, 'Contents/Frameworks/Etch Helper.app'),
  join(appPath, 'Contents/Frameworks/Etch Helper (GPU).app'),
  join(appPath, 'Contents/Frameworks/Etch Helper (Plugin).app'),
  join(appPath, 'Contents/Frameworks/Etch Helper (Renderer).app')
]
const requiredEntitlements = [
  'com.apple.security.cs.allow-jit',
  'com.apple.security.cs.allow-unsigned-executable-memory',
  'com.apple.security.cs.disable-library-validation'
]

for (const target of signedTargets) {
  const details = run('codesign', ['-d', '--verbose=4', target])
  assertIncludes(details, '(adhoc,runtime)', `${target} 签名 flags`)
  assertIncludes(details, 'TeamIdentifier=not set', `${target} TeamIdentifier`)
  const entitlements = run('codesign', ['-d', '--entitlements', '-', target])
  for (const entitlement of requiredEntitlements) assertIncludes(entitlements, entitlement, `${target} entitlements`)
}

const machOFiles = executableFiles(appPath).filter((path) => run('file', ['-b', path]).includes('Mach-O'))
if (!machOFiles.length) throw new Error('Etch.app 未发现 Mach-O 文件')
for (const path of machOFiles) run('codesign', ['--verify', '--strict', path])

const architectures = run('lipo', ['-archs', join(appPath, 'Contents/MacOS/Etch')]).trim()
if (architectures !== 'arm64') throw new Error(`Etch 架构必须为 arm64，实际为 ${architectures}`)

const plistBuddy = '/usr/libexec/PlistBuddy'
const infoPlist = join(appPath, 'Contents/Info.plist')
const appVersion = run(plistBuddy, ['-c', 'Print :CFBundleShortVersionString', infoPlist]).trim()
const buildVersion = run(plistBuddy, ['-c', 'Print :CFBundleVersion', infoPlist]).trim()
const minimumSystemVersion = run(plistBuddy, ['-c', 'Print :LSMinimumSystemVersion', infoPlist]).trim()
if (packageJson.version !== packageLock.version || packageJson.version !== packageLock.packages?.['']?.version) {
  throw new Error('package.json 与 package-lock.json 版本不一致')
}
if (appVersion !== packageJson.version || buildVersion !== packageJson.version) {
  throw new Error(`App 版本与 package.json 不一致：${appVersion}/${buildVersion}/${packageJson.version}`)
}
if (minimumSystemVersion !== '13.5.0') throw new Error(`Etch 最低系统版本必须为 13.5.0，实际为 ${minimumSystemVersion}`)

const biliupPath = join(appPath, 'Contents/Resources/biliup/biliup')
const biliupMetadata = JSON.parse(readFileSync(join(appPath, 'Contents/Resources/biliup/metadata.json'), 'utf8'))
const biliupHash = createHash('sha256').update(readFileSync(biliupPath)).digest('hex')
if (biliupMetadata.version !== '1.2.2') throw new Error(`biliup 版本未锁定为 1.2.2：${biliupMetadata.version}`)
if (biliupMetadata.upstreamBinarySha256 !== '9810912b4c61d13d9c4d7afc885f9d464150172c83ea41caddbadf10d672d78f') {
  throw new Error(`biliup 上游二进制 SHA-256 元数据不匹配：${biliupMetadata.upstreamBinarySha256}`)
}
if (biliupMetadata.binarySha256 !== biliupHash || biliupHash !== 'ca2980a7419e2905a8e456cdfcea227f5377faaf3dca7b537d4d22870d315b3e') {
  throw new Error(`biliup SHA-256 不匹配：${biliupHash}`)
}
if (run('lipo', ['-archs', biliupPath]).trim() !== 'arm64') throw new Error('biliup sidecar 必须为 arm64')
if (!run(biliupPath, ['--version']).includes('biliup-cli 1.2.2')) throw new Error('biliup sidecar 版本输出不匹配')
const biliupSignature = run('codesign', ['-d', '--verbose=4', biliupPath])
assertIncludes(biliupSignature, 'Identifier=com.baobingjiang.etch.biliup', 'biliup 签名标识')
assertIncludes(biliupSignature, '(adhoc,runtime)', 'biliup 签名 flags')
if (!readFileSync(join(appPath, 'Contents/Resources/biliup/LICENSE'), 'utf8').includes('MIT License')) throw new Error('安装包缺少 biliup MIT 许可证')

console.log(`Etch macOS 包验证通过：${machOFiles.length} 个 Mach-O，arm64，v${appVersion}，biliup ${biliupMetadata.version}，macOS ${minimumSystemVersion}+，ad-hoc hardened runtime`)
