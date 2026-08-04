import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(readFileSync(resolve(projectRoot, 'package.json'), 'utf8')) as { version: string }
const website = readFileSync(resolve(projectRoot, 'website/index.html'), 'utf8')
const readme = readFileSync(resolve(projectRoot, 'README.md'), 'utf8')
const readmeEn = readFileSync(resolve(projectRoot, 'README_EN.md'), 'utf8')
const readmeJa = readFileSync(resolve(projectRoot, 'README_JA.md'), 'utf8')
const dmgUrl = `https://github.com/bingjiang0611/Etch/releases/download/v${packageJson.version}/Etch-${packageJson.version}-arm64.dmg`

describe('documentation capability contract', () => {
  it('keeps the website version and DMG download aligned with package.json', () => {
    expect(website).toContain(`"softwareVersion": "${packageJson.version}"`)
    expect(website).toContain(`Etch ${packageJson.version}`)
    expect(readme).toContain(`当前版本：\`${packageJson.version}\``)
    expect(website).toContain(dmgUrl)
    expect(readme).toContain(`Etch-${packageJson.version}-arm64.dmg`)
  })

  it('keeps the public input and release scope truthful', () => {
    expect(website).toContain('当前仅支持粘贴 HTTP(S) 视频链接')
    expect(website).not.toContain('选择本地文件')
    expect(website).toContain('GitHub Release 提供 Apple Silicon DMG')
    expect(readme).toMatch(/当前输入：\*\*仅支持 HTTP\(S\) URL\*\*/)
    expect(readme).toContain('| Implemented |')
    expect(readme).toContain('| Partial |')
    expect(readme).toContain('| Planned |')
    expect(readme).toContain('GitHub Release 提供 Apple Silicon DMG')
    expect(readme).toContain('当前 DMG 未经 Apple 公证')
  })

  it('presents Bilibili publishing as a shipped DMG capability', () => {
    expect(website).toContain(`下载 v${packageJson.version} · DMG`)
    expect(website).not.toContain('从源码体验 B站投稿')
    expect(website).not.toContain('发行说明')
    expect(website).not.toContain('release-note')
    expect(readme).toContain('公开 DMG 已包含 B站投稿')
    expect(readme).not.toContain('尚不包含 B站投稿')
  })

  it('keeps localized READMEs discoverable and aligned with the release contract', () => {
    expect(readme).toContain('./README_EN.md')
    expect(readme).toContain('./README_JA.md')

    for (const localized of [readmeEn, readmeJa]) {
      expect(localized).toContain(`Etch-${packageJson.version}-arm64.dmg`)
      expect(localized).toContain('HTTP(S)')
      expect(localized).toContain('./README.md')
    }

    expect(readmeEn).toContain('./README_JA.md')
    expect(readmeJa).toContain('./README_EN.md')
  })
})
