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
const publicReleaseVersion = packageJson.version
const publicDmgUrl = `https://github.com/bingjiang0611/Etch/releases/download/v${publicReleaseVersion}/Etch-${publicReleaseVersion}-arm64.dmg`

describe('documentation capability contract', () => {
  it('derives the public release identity from package.json', () => {
    expect(website).toContain(`"softwareVersion": "${publicReleaseVersion}"`)
    expect(website).toContain(`公开版 ${packageJson.version}`)
    expect(website).toContain('"description": "本地视频与网页内容工作站，支持双语硬字幕、视频总结、网页翻译与 B站投稿"')
    expect(readme).toContain(`当前公开版 \`v${packageJson.version}\``)
    expect(website).toContain(publicDmgUrl)
    expect(readme).toContain(`Etch-${publicReleaseVersion}-arm64.dmg`)
  })

  it('keeps the public input and release scope truthful', () => {
    expect(website).toContain('仅支持 HTTP(S) URL')
    expect(website).not.toContain('选择本地文件')
    expect(readme).toContain('当前只支持 URL 输入')
    expect(readme).toContain('| Implemented |')
    expect(readme).toContain('| Partial |')
    expect(readme).toContain('| Planned |')
    expect(readme).toContain('未经 Apple 公证')
  })

  it('keeps all three task types in the public release contract', () => {
    expect(website).toContain(`公开版 v${publicReleaseVersion} 提供<b>双语硬字幕、视频总结和网页翻译</b>`)
    expect(readme).toContain('**双语硬字幕**')
    expect(readme).toContain('**视频总结**')
    expect(readme).toContain('**网页翻译**')
    expect(readmeEn).toContain('bilingual hard subtitles, video summaries, and web translation')
    expect(readmeJa).toContain('英中ハード字幕、動画要約、Web 翻訳の 3 種類のタスク')
    expect(website).toContain(`公开 v${publicReleaseVersion} 已包含`)
    expect(website).toContain('真实视频与真实 Provider 的完整 L3 尚未执行')
    expect(readme).toContain(`公开 \`v${publicReleaseVersion}\` 已包含该投稿流程`)
    expect(readmeEn).toContain(`included in the public \`v${publicReleaseVersion}\` installer`)
    expect(readmeJa).toContain(`公開 \`v${publicReleaseVersion}\` インストーラーに含まれて`)
  })

  it('keeps social-card metadata safe for chunked preview crawlers', () => {
    const metadataValues = [
      website.match(/<title>([^<]*)<\/title>/)?.[1],
      website.match(/<meta name="description" content="([^"]*)"/)?.[1],
      ...[...website.matchAll(/<meta property="og:(?:title|description|image:alt)" content="([^"]*)"/g)]
        .map((match) => match[1]),
    ]
    expect(metadataValues).toHaveLength(5)
    for (const value of metadataValues) {
      expect(value).toBeDefined()
      expect([...(value ?? '')].every((character) => (character.codePointAt(0) ?? 0) <= 0x7f)).toBe(true)
    }
    expect(website).toContain('property="og:locale" content="zh_CN"')
  })

  it('keeps localized READMEs discoverable and aligned with the release contract', () => {
    expect(readme).toContain('./README_EN.md')
    expect(readme).toContain('./README_JA.md')

    for (const localized of [readmeEn, readmeJa]) {
      expect(localized).toContain(`Etch-${publicReleaseVersion}-arm64.dmg`)
      expect(localized).toContain(packageJson.version)
      expect(localized).toContain(publicReleaseVersion)
      expect(localized).toContain('HTTP(S)')
      expect(localized).toContain('./README.md')
    }

    expect(readmeEn).toContain('./README_JA.md')
    expect(readmeJa).toContain('./README_EN.md')
  })
})
