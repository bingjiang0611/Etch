import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, stat } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import type { DocumentHtmlPage } from '../shared/ipc'
import type { DocumentHtmlDirection, TaskManifest } from '../shared/task-schema'
import { fingerprint, sha256File } from './core/fingerprint'
import type { IndexStore } from './storage/index-store'
import { writeJsonAtomic } from './storage/atomic-json'
import { writeTextAtomic } from './storage/atomic-text'
import { readContainedFile } from './storage/safe-artifact'
import type { TaskStore } from './storage/task-store'

type Artifact = TaskManifest['artifacts'][string]
type BrowserVerification = { issues: string[] }
export type DocumentHtmlBrowserVerifier = (
  htmlPath: string,
  desktopScreenshotPath: string,
  mobileScreenshotPath: string
) => Promise<BrowserVerification>

const MAX_MARKDOWN_BYTES = 10 * 1024 * 1024
const MAX_HTML_BYTES = 20 * 1024 * 1024
const MAX_MEDIA_BYTES = 25 * 1024 * 1024
const SAFE_RUN_ID = /^[a-f0-9-]{36}$/u
const OFFLINE_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src 'none'; script-src 'none'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; media-src 'none'"
const DIRECTIONS: Record<DocumentHtmlDirection, {
  name: string
  templateId: string
  dials: [string, string, string]
  className: string
  description: string
}> = {
  A: {
    name: '杂志长文',
    templateId: 'article-magazine',
    dials: ['serif 72%', 'density 55%', 'contrast 42%'],
    className: 'direction-a',
    description: '编辑部式 masthead、双栏节奏与醒目引文。'
  },
  B: {
    name: '极简阅读',
    templateId: 'minimal',
    dials: ['serif 38%', 'density 28%', 'contrast 18%'],
    className: 'direction-b',
    description: '单列、宽留白、安静而长时间可读。'
  },
  C: {
    name: '大胆编辑',
    templateId: 'editorial',
    dials: ['serif 84%', 'density 63%', 'contrast 78%'],
    className: 'direction-c',
    description: '强标题、编号章节、pull quote 与不对称构图。'
  },
  D: {
    name: '冷静工业',
    templateId: 'dark-industrial',
    dials: ['serif 12%', 'density 74%', 'contrast 92%'],
    className: 'direction-d',
    description: '暗底、冷蓝 accent、数据化章节导航。'
  }
}

function publicationDirectory(taskDirectory: string, runId: string): string {
  if (!SAFE_RUN_ID.test(runId)) throw new Error('HTML publication run ID 非法')
  return join(taskDirectory, '.etch-publications', 'html', runId)
}

function artifactPath(taskDirectory: string, runId: string, name: string): { absolute: string; relative: string } {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name)) throw new Error(`HTML publication 文件名非法：${name}`)
  const relative = join('.etch-publications', 'html', runId, name)
  return { absolute: join(taskDirectory, relative), relative }
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

function inlineMarkdown(value: string): string {
  let output = escapeHtml(value)
  output = output.replace(/`([^`]+)`/gu, '<code>$1</code>')
  output = output.replace(/\*\*([^*]+)\*\*/gu, '<strong>$1</strong>')
  output = output.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/gu, '<a href="$2" rel="noreferrer">$1</a>')
  return output
}

function slug(value: string, index: number, used: Set<string>): string {
  const base = value.normalize('NFKD').toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9\p{Script=Han}]+/gu, '-')
    .replace(/^-|-$/gu, '')
    .slice(0, 60) || `section-${String(index).padStart(2, '0')}`
  let candidate = base
  let suffix = 2
  while (used.has(candidate)) candidate = `${base}-${suffix++}`
  used.add(candidate)
  return candidate
}

function markdownToHtml(markdown: string): { body: string; headings: Array<{ id: string; text: string; level: number }> } {
  const lines = markdown.split(/\r?\n/u)
  const used = new Set<string>()
  const headings: Array<{ id: string; text: string; level: number }> = []
  const output: string[] = []
  let code: string[] | undefined
  let list: { ordered: boolean; items: string[] } | undefined
  const flushList = (): void => {
    if (!list) return
    const tag = list.ordered ? 'ol' : 'ul'
    output.push(`<${tag}>${list.items.map((item) => `<li>${inlineMarkdown(item)}</li>`).join('')}</${tag}>`)
    list = undefined
  }
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (/^```/u.test(line)) {
      flushList()
      if (code) {
        output.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`)
        code = undefined
      } else code = []
      continue
    }
    if (code) {
      code.push(line)
      continue
    }
    const heading = /^(#{1,6})\s+(.+)$/u.exec(line)
    if (heading) {
      flushList()
      const level = heading[1].length
      const text = heading[2].trim()
      const id = slug(text, index + 1, used)
      headings.push({ id, text, level })
      output.push(`<h${level} id="${id}"><a class="anchor" href="#${id}" aria-label="链接到 ${escapeHtml(text)}">#</a>${inlineMarkdown(text)}</h${level}>`)
      continue
    }
    const image = /^!\[([^\]]*)\]\(([^)]+)\)\s*$/u.exec(line.trim())
    if (image) {
      flushList()
      const source = image[2].startsWith('data:image/') ? image[2] : ''
      output.push(source
        ? `<figure><img src="${source}" alt="${escapeHtml(image[1])}" loading="lazy"><figcaption>${escapeHtml(image[1])}</figcaption></figure>`
        : `<figure class="missing-media"><figcaption>${escapeHtml(image[1] || '图片未本地化，HTML 中已省略')}</figcaption></figure>`)
      continue
    }
    const tableDivider = lines[index + 1]
    if (line.includes('|') && tableDivider && /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/u.test(tableDivider)) {
      flushList()
      const cells = (row: string): string[] => row.trim().replace(/^\||\|$/gu, '').split('|').map((cell) => cell.trim())
      const header = cells(line)
      const rows: string[][] = []
      index += 2
      while (index < lines.length && lines[index].trim() && lines[index].includes('|')) {
        rows.push(cells(lines[index]))
        index += 1
      }
      index -= 1
      output.push(`<div class="table-scroll"><table><thead><tr>${header.map((cell) => `<th>${inlineMarkdown(cell)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${header.map((_, cellIndex) => `<td>${inlineMarkdown(row[cellIndex] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`)
      continue
    }
    const listItem = /^\s*(?:(\d+)[.)]|[-*+])\s+(.+)$/u.exec(line)
    if (listItem) {
      const ordered = Boolean(listItem[1])
      if (list && list.ordered !== ordered) flushList()
      list ??= { ordered, items: [] }
      list.items.push(listItem[2])
      continue
    }
    flushList()
    if (!line.trim()) continue
    if (/^---+\s*$/u.test(line)) output.push('<hr>')
    else if (/^>\s?/u.test(line)) output.push(`<blockquote>${inlineMarkdown(line.replace(/^>\s?/u, ''))}</blockquote>`)
    else output.push(`<p>${inlineMarkdown(line)}</p>`)
  }
  flushList()
  if (code) output.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`)
  return { body: output.join('\n'), headings }
}

function styleCss(direction: DocumentHtmlDirection): string {
  const common = `
    :root{color-scheme:light;--ink:#17202a;--paper:#f5f4ed;--accent:#1b365d;--muted:#667085;--rule:rgba(23,32,42,.18)}
    *{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--paper);color:var(--ink);font-family:"Noto Sans SC","PingFang SC","Microsoft YaHei",sans-serif;line-height:1.78}
    main{width:min(100% - 40px,980px);margin:0 auto;padding:64px 0 96px}header{border-bottom:1px solid var(--rule);margin-bottom:48px;padding-bottom:18px;display:flex;justify-content:space-between;gap:24px;align-items:end}
    .kicker{font-size:12px;letter-spacing:.16em;text-transform:uppercase}.reading-meta{font-variant-numeric:tabular-nums;color:var(--muted);font-size:13px}article{min-width:0}h1,h2,h3{line-height:1.16;text-wrap:balance;scroll-margin-top:24px}h1{font-size:clamp(42px,7vw,76px);margin:.2em 0 .65em}h2{font-size:clamp(26px,4vw,42px);margin:2.2em 0 .8em;border-top:1px solid var(--rule);padding-top:.7em}h3{font-size:22px;margin:1.8em 0 .6em}p,li,blockquote{font-size:17px}p{margin:0 0 1.15em}a{color:var(--accent);text-underline-offset:3px}.anchor{opacity:0;margin-left:-1em;padding-right:.35em;text-decoration:none}h1:hover .anchor,h2:hover .anchor,h3:hover .anchor,.anchor:focus{opacity:.55}
    blockquote{margin:2em 0;padding:1em 0 1em 1.25em;border-left:3px solid var(--accent);font-family:"Noto Serif SC","Songti SC",serif;font-size:22px}code{font-family:"SFMono-Regular",Consolas,monospace;background:rgba(27,54,93,.08);padding:.12em .3em}pre{overflow:auto;padding:20px;border:1px solid var(--rule);background:#111923;color:#e7edf5}pre code{background:none;padding:0}.table-scroll{max-width:100%;overflow-x:auto;margin:2em 0}table{width:100%;border-collapse:collapse;font-size:15px}th,td{padding:10px 12px;border:1px solid var(--rule);text-align:left;vertical-align:top}th{background:rgba(27,54,93,.07)}figure{margin:2.4em 0}img{max-width:100%;height:auto;display:block}figcaption{color:var(--muted);font-size:13px;margin-top:8px}.missing-media{border-left:3px solid var(--rule);padding-left:16px}hr{border:0;border-top:1px solid var(--rule);margin:3em 0}footer{width:min(100% - 40px,980px);margin:0 auto 32px;border-top:1px solid var(--rule);padding-top:16px;color:var(--muted);font-size:12px}
    @media(max-width:800px){main{width:min(100% - 28px,680px);padding-top:36px}header{align-items:start;flex-direction:column;margin-bottom:30px}h1{font-size:40px}h2{font-size:28px}p,li{font-size:16px}.anchor{display:none}}
  `
  if (direction === 'A') return `${common} body{background:#f1eee5}article{font-family:"Noto Serif SC","Songti SC",serif}header{font-family:"Noto Sans SC",sans-serif}.kicker{color:#8b2f2f}h2{counter-increment:section}h2:before{content:"0" counter(section) " / ";font-family:"Noto Sans SC";font-size:.42em;color:#8b2f2f;vertical-align:middle}`
  if (direction === 'B') return `${common} main,footer{width:min(100% - 40px,720px)}header{border:0;margin-bottom:70px}h1{font-size:clamp(38px,6vw,58px);font-family:"Noto Serif SC","Songti SC",serif}h2{border:0;padding:0;font-size:30px;margin-top:2.8em}blockquote{border:0;padding:0;color:#394150}`
  if (direction === 'C') return `${common} :root{--paper:#f5efe5;--accent:#b23a28}main{width:min(100% - 40px,1120px)}article{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,2fr);column-gap:54px}article>h1,article>h2,article>h3,article>figure,article>pre,article>blockquote,article>hr{grid-column:1/-1}article>p,article>ul,article>ol{grid-column:2}h1{text-transform:none;font-family:"Noto Serif SC",serif;font-size:clamp(54px,9vw,110px);letter-spacing:-.045em}h2{font-family:"Noto Serif SC",serif}@media(max-width:800px){article{display:block}h1{font-size:48px}}`
  return `${common} :root{color-scheme:dark;--ink:#e7edf5;--paper:#0d141d;--accent:#62b8ff;--muted:#9aa8b8;--rule:rgba(98,184,255,.22)}body{background:#0d141d}header{border-color:var(--accent)}main{width:min(100% - 40px,1080px)}h1,h2,h3{font-family:"SFMono-Regular","Noto Sans SC",monospace}h1{font-size:clamp(42px,7vw,78px)}h2{border-top-color:var(--accent)}blockquote{background:#121d29;padding:20px;border-left-color:var(--accent)}code{background:rgba(98,184,255,.12)}.kicker{color:var(--accent)}`
}

function renderHtml(title: string, markdown: string, direction: DocumentHtmlDirection): string {
  const rendered = markdownToHtml(markdown)
  const toc = rendered.headings.filter((heading) => heading.level <= 2).map((heading) => `<a href="#${heading.id}">${escapeHtml(heading.text)}</a>`).join(' · ')
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <meta http-equiv="Content-Security-Policy" content="${OFFLINE_CSP}">
  <title>${escapeHtml(title)}</title>
  <style>${styleCss(direction)}</style>
</head>
<body class="${DIRECTIONS[direction].className}">
  <main>
    <header><div><div class="kicker">Etch · ${DIRECTIONS[direction].name}</div><div class="reading-meta">单文件 HTML · ${new Date().toLocaleDateString('zh-CN')}</div></div><nav aria-label="章节导航">${toc}</nav></header>
    <article>${rendered.body}</article>
  </main>
  <footer>由 Etch 从已验证 Markdown 发布 · ${escapeHtml(DIRECTIONS[direction].templateId)}</footer>
</body>
</html>\n`
}

function renderPreview(title: string, markdown: string): string {
  const excerpt = escapeHtml(markdown.replace(/^#+\s+/gmu, '').replace(/\s+/gu, ' ').slice(0, 260))
  const cards = Object.entries(DIRECTIONS).map(([id, direction]) => `
    <article class="card ${direction.className}" data-direction="${id}">
      <span class="letter">${id}</span><small>${direction.templateId}</small><h2>${escapeHtml(direction.name)}</h2>
      <p>${excerpt}</p><div class="dials">${direction.dials.map((dial) => `<code>${dial}</code>`).join('')}</div>
    </article>`).join('')
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${OFFLINE_CSP}"><title>${escapeHtml(title)} · 风格预览</title><style>
    *{box-sizing:border-box}body{margin:0;background:#e9e7e1;color:#171b20;font-family:-apple-system,"PingFang SC",sans-serif}.shell{width:min(1180px,100% - 32px);margin:0 auto;padding:32px 0}.intro{display:flex;justify-content:space-between;align-items:end;border-bottom:1px solid #aaa;padding-bottom:16px;margin-bottom:22px}.intro h1{font-size:24px;margin:0}.intro p{margin:0;color:#59616c}.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.card{min-height:330px;padding:24px;border:1px solid #aeb3b8;background:#f8f7f2;overflow:hidden}.card .letter{font:700 42px/1 ui-monospace}.card small{float:right}.card h2{font-size:34px;margin:42px 0 18px}.card p{line-height:1.65}.dials{display:flex;gap:6px;flex-wrap:wrap;margin-top:22px}.dials code{font-size:11px;border:1px solid currentColor;padding:4px 6px}.direction-a{font-family:Georgia,"Songti SC",serif;background:#f1eee5}.direction-a .letter{color:#8b2f2f}.direction-b{background:#fff}.direction-b h2{font-weight:500;margin-top:66px}.direction-c{background:#f4e8da;border-width:4px}.direction-c h2{font:900 46px/1 Georgia,serif}.direction-d{background:#0d141d;color:#e7edf5;border-color:#62b8ff}.direction-d .letter{color:#62b8ff}@media(max-width:800px){.grid{grid-template-columns:1fr}.intro{display:block}.intro p{margin-top:8px}}
  </style></head><body><main class="shell"><div class="intro"><h1>${escapeHtml(title)} · 四方向试衣间</h1><p>三旋钮：字体 / 密度 / 对比度</p></div><section class="grid">${cards}</section></main></body></html>\n`
}

export function documentHtmlStaticIssues(html: string): string[] {
  const issues: string[] = []
  if (!/^<!DOCTYPE html>/u.test(html)) issues.push('缺少 HTML5 doctype')
  if (!html.includes(`content="${OFFLINE_CSP}"`)) issues.push('缺少严格离线 CSP')
  if (/<script\b/iu.test(html)) issues.push('HTML 不允许 script')
  if (/<link\b[^>]*\bhref\s*=\s*["']?\s*(?:https?:)?\/\//iu.test(html)) issues.push('HTML 不允许远程 link')
  if (!/<main[\s>]/u.test(html) || !/<article[\s>]/u.test(html)) issues.push('缺少 main/article 语义结构')
  if (html.includes('class="missing-media"')) issues.push('存在未完成本地化的图片，不能发布不完整 HTML')
  const ids = [...html.matchAll(/\sid="([^"]+)"/gu)].map((match) => match[1])
  if (new Set(ids).size !== ids.length) issues.push('存在重复 anchor ID')
  const anchors = [...html.matchAll(/href="#([^"]+)"/gu)].map((match) => match[1])
  if (anchors.some((anchor) => !ids.includes(anchor))) issues.push('存在无目标的内部 anchor')
  if (/lorem ipsum|TODO|PLACEHOLDER/iu.test(html)) issues.push('存在占位内容')
  if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) issues.push('HTML 超过 20 MiB')
  return issues
}

function mediaMime(path: string): string {
  const extension = extname(path).toLocaleLowerCase('en-US')
  return ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.avif': 'image/avif' } as Record<string, string>)[extension] ?? 'application/octet-stream'
}

export class DocumentHtmlService {
  constructor(
    readonly store: TaskStore,
    readonly index: IndexStore,
    readonly browserVerify?: DocumentHtmlBrowserVerifier
  ) {}

  async page(taskId: string): Promise<DocumentHtmlPage> {
    const { directory, manifest } = await this.#task(taskId)
    const publication = manifest.document.htmlPublication
    const page: DocumentHtmlPage = {
      taskId,
      revision: manifest.revision,
      status: publication.status,
      phase: publication.phase,
      selectedDirection: publication.selectedDirection,
      templateId: publication.templateId,
      errorCode: publication.errorCode
    }
    const preview = manifest.artifacts.documentHtmlPreview
    if (preview?.valid) page.previewHtml = await this.#artifactText(directory, preview, 'HTML 风格预览', 3_000_000)
    const verification = manifest.artifacts.documentHtmlVerification
    if (verification?.valid) {
      const value = JSON.parse(await this.#artifactText(directory, verification, 'HTML 验收记录', 1_000_000)) as { staticValid?: unknown; browserValid?: unknown; issues?: unknown }
      page.verification = {
        staticValid: value.staticValid === true,
        browserValid: value.browserValid === true,
        issues: Array.isArray(value.issues) ? value.issues.filter((item): item is string => typeof item === 'string').slice(0, 100) : []
      }
    }
    return page
  }

  async start(
    taskId: string,
    expectedRevision: number,
    route: 'preview' | 'template' | 'frontend-design' = 'preview',
    templateId?: string
  ): Promise<TaskManifest> {
    const task = await this.#task(taskId)
    this.#assertReady(task.manifest)
    if (task.manifest.revision !== expectedRevision) throw new Error('任务已被更新，请刷新后重试')
    const input = this.#inputArtifact(task.manifest)
    const runId = randomUUID()
    await mkdir(publicationDirectory(task.directory, runId), { recursive: true })
    const started = await this.store.mutate(task.directory, (draft) => {
      this.#assertReady(draft)
      draft.document.htmlPublication = {
        status: 'running',
        phase: 'route',
        inputArtifactKey: input.key,
        inputSha256: input.artifact.sha256,
        publicationRunId: runId,
        ...(templateId ? { templateId } : {})
      }
    }, expectedRevision)
    this.index.upsert(task.directory, started)
    try {
      const markdown = await this.#embeddedMarkdown(task.directory, started, input.artifact)
      const routeValue = { route, templateId: templateId ?? null, input: input.key, sha256: input.artifact.sha256 }
      const punchList = {
        content: { title: started.title, characters: markdown.length, headings: [...markdown.matchAll(/^#{1,6}\s+/gmu)].length },
        interactions: ['semantic-anchor-navigation'],
        assets: Object.keys(started.artifacts).filter((key) => key.startsWith('documentMedia:')),
        states: ['desktop', 'mobile', 'print'],
        designDna: { radius: '0-4px', shadows: 'none', gradients: 'forbidden', typography: 'content-first' },
        gates: ['Chinese typography', 'Taste/Impeccable', 'desktop 1440px', 'mobile 800px']
      }
      const routeFile = artifactPath(task.directory, runId, 'route.json')
      const punchFile = artifactPath(task.directory, runId, 'punch-list.json')
      await Promise.all([writeJsonAtomic(routeFile.absolute, routeValue), writeJsonAtomic(punchFile.absolute, punchList)])
      const inputFingerprint = fingerprint('etch:document-html-route', 1, routeValue)
      const routeArtifact = await this.#artifact(task.directory, routeFile.relative, 'etch-html-router-v1', inputFingerprint)
      const punchArtifact = await this.#artifact(task.directory, punchFile.relative, 'etch-html-punch-list-v1', inputFingerprint)
      const directDirection = route === 'template' ? this.#directionForTemplate(templateId) : undefined
      if (directDirection) {
        return await this.#generate(task.directory, started, runId, markdown, directDirection, { routeArtifact, punchArtifact })
      }
      const preview = renderPreview(started.title, markdown)
      const previewFile = artifactPath(task.directory, runId, 'style-preview.html')
      await writeTextAtomic(previewFile.absolute, preview)
      const previewArtifact = await this.#artifact(task.directory, previewFile.relative, 'etch-html-style-preview-v1', inputFingerprint)
      const checkpointId = randomUUID()
      const checkpointed = await this.store.mutate(task.directory, (draft) => {
        if (draft.document.htmlPublication.publicationRunId !== runId) throw new Error('HTML publication 已变化')
        Object.assign(draft.artifacts, {
          documentHtmlRoute: routeArtifact,
          documentHtmlPunchList: punchArtifact,
          documentHtmlPreview: previewArtifact
        })
        Object.assign(draft.document.htmlPublication, {
          status: 'checkpoint',
          phase: 'preview',
          checkpointId
        })
      }, started.revision)
      this.index.upsert(task.directory, checkpointed)
      return checkpointed
    } catch (error) {
      await this.#fail(task.directory, runId, error)
      throw error
    }
  }

  async resolveStyle(
    taskId: string,
    expectedRevision: number,
    direction: DocumentHtmlDirection
  ): Promise<TaskManifest> {
    const task = await this.#task(taskId)
    const publication = task.manifest.document.htmlPublication
    if (task.manifest.revision !== expectedRevision) throw new Error('任务已被更新，请刷新后重试')
    if (publication.status !== 'checkpoint' || publication.phase !== 'preview' || !publication.publicationRunId || !publication.inputArtifactKey || !publication.inputSha256) {
      throw new Error('任务当前不在 HTML 风格确认 checkpoint')
    }
    const input = task.manifest.artifacts[publication.inputArtifactKey]
    if (!input?.valid || input.sha256 !== publication.inputSha256) throw new Error('HTML 输入 Markdown 已变化，请重新开始')
    const running = await this.store.mutate(task.directory, (draft) => {
      const state = draft.document.htmlPublication
      if (state.checkpointId !== publication.checkpointId) throw new Error('HTML 风格 checkpoint 已变化')
      state.status = 'running'
      state.phase = 'generate'
      state.selectedDirection = direction
      state.templateId = DIRECTIONS[direction].templateId
      delete state.checkpointId
      delete state.errorCode
    }, expectedRevision)
    this.index.upsert(task.directory, running)
    try {
      const markdown = await this.#embeddedMarkdown(task.directory, running, input)
      const selectionFile = artifactPath(task.directory, publication.publicationRunId, 'selection.json')
      await writeJsonAtomic(selectionFile.absolute, { direction, ...DIRECTIONS[direction], selectedAt: new Date().toISOString() })
      const selectionArtifact = await this.#artifact(
        task.directory,
        selectionFile.relative,
        'etch-html-style-selection-v1',
        fingerprint('etch:document-html-selection', 1, { input: input.sha256, direction })
      )
      return await this.#generate(task.directory, running, publication.publicationRunId, markdown, direction, {
        selectionArtifact
      })
    } catch (error) {
      await this.#fail(task.directory, publication.publicationRunId, error)
      throw error
    }
  }

  async exportTo(taskId: string, targetDirectory: string): Promise<string> {
    const { directory, manifest } = await this.#task(taskId)
    const state = manifest.document.htmlPublication
    const artifact = manifest.artifacts.documentHtml
    if (state.status !== 'completed' || !artifact?.valid || !state.inputArtifactKey) throw new Error('HTML 尚未生成并通过验收')
    await readContainedFile(directory, artifact.relativePath, 'HTML 成品', {
      maxBytes: MAX_HTML_BYTES,
      expectedSize: artifact.size,
      expectedSha256: artifact.sha256
    })
    const filename = state.inputArtifactKey === 'translatedMarkdown' ? 'translation.html' : 'source.html'
    const target = resolve(targetDirectory, filename)
    await copyFile(join(directory, artifact.relativePath), target)
    if (await sha256File(target) !== artifact.sha256) throw new Error('HTML 导出后 SHA-256 不一致')
    return target
  }

  async recoverInterrupted(): Promise<void> {
    for (const indexed of this.index.all().filter((task) => task.kind === 'document')) {
      const manifest = await this.store.load(indexed.location)
      if (manifest.document.htmlPublication.status !== 'running') continue
      const recovered = await this.store.mutate(indexed.location, (draft) => {
        draft.document.htmlPublication.status = 'failed'
        draft.document.htmlPublication.errorCode = '上次 HTML publication 异常中断；已验证的 Markdown 不受影响，可重新生成'
      })
      this.index.upsert(indexed.location, recovered)
    }
  }

  async #generate(
    taskDirectory: string,
    manifest: TaskManifest,
    runId: string,
    markdown: string,
    direction: DocumentHtmlDirection,
    extraArtifacts: Record<string, Artifact>
  ): Promise<TaskManifest> {
    const html = renderHtml(manifest.title, markdown, direction)
    const staticValidationIssues = documentHtmlStaticIssues(html)
    if (staticValidationIssues.length) throw new Error(`HTML 静态预检失败：${staticValidationIssues.join('；')}`)
    if (!this.browserVerify) throw new Error('HTML Browser 验收器不可用')
    const htmlFile = artifactPath(taskDirectory, runId, manifest.document.htmlPublication.inputArtifactKey === 'sourceMarkdown' ? 'source.html' : 'translation.html')
    const verificationFile = artifactPath(taskDirectory, runId, 'verification.json')
    const desktopFile = artifactPath(taskDirectory, runId, 'desktop.png')
    const mobileFile = artifactPath(taskDirectory, runId, 'mobile.png')
    await writeTextAtomic(htmlFile.absolute, html)
    const browser = await this.browserVerify(htmlFile.absolute, desktopFile.absolute, mobileFile.absolute)
    const verification = {
      staticValid: true,
      browserValid: browser.issues.length === 0,
      issues: browser.issues,
      checkedAt: new Date().toISOString(),
      direction,
      templateId: DIRECTIONS[direction].templateId
    }
    await writeJsonAtomic(verificationFile.absolute, verification)
    if (!verification.browserValid) throw new Error(`HTML 浏览器验收失败：${verification.issues.join('；')}`)
    const inputFingerprint = fingerprint('etch:document-html', 1, {
      input: manifest.document.htmlPublication.inputSha256,
      direction,
      template: DIRECTIONS[direction].templateId
    })
    const artifacts: Record<string, Artifact> = {
      ...extraArtifacts,
      documentHtml: await this.#artifact(taskDirectory, htmlFile.relative, 'etch-html-generator-v1', inputFingerprint),
      documentHtmlVerification: await this.#artifact(taskDirectory, verificationFile.relative, 'etch-html-preflight-v1', inputFingerprint),
      'documentHtmlScreenshot:desktop': await this.#artifact(taskDirectory, desktopFile.relative, 'etch-html-browser-v1', inputFingerprint),
      'documentHtmlScreenshot:mobile': await this.#artifact(taskDirectory, mobileFile.relative, 'etch-html-browser-v1', inputFingerprint)
    }
    const latest = await this.store.load(taskDirectory)
    const completed = await this.store.mutate(taskDirectory, (draft) => {
      const state = draft.document.htmlPublication
      if (state.publicationRunId !== runId || state.inputSha256 !== manifest.document.htmlPublication.inputSha256) {
        throw new Error('HTML publication 输入已变化')
      }
      Object.assign(draft.artifacts, artifacts)
      Object.assign(state, {
        status: 'completed',
        phase: 'done',
        selectedDirection: direction,
        templateId: DIRECTIONS[direction].templateId,
        completedAt: new Date().toISOString()
      })
      delete state.errorCode
      delete state.checkpointId
    }, latest.revision)
    this.index.upsert(taskDirectory, completed)
    return completed
  }

  async #embeddedMarkdown(taskDirectory: string, manifest: TaskManifest, artifact: Artifact): Promise<string> {
    let markdown = await this.#artifactText(taskDirectory, artifact, 'HTML 输入 Markdown', MAX_MARKDOWN_BYTES)
    for (const [key, mediaArtifact] of Object.entries(manifest.artifacts)) {
      if (!key.startsWith('documentMedia:') || !mediaArtifact.valid || !markdown.includes(mediaArtifact.relativePath)) continue
      const file = await readContainedFile(taskDirectory, mediaArtifact.relativePath, key, {
        maxBytes: MAX_MEDIA_BYTES,
        expectedSize: mediaArtifact.size,
        expectedSha256: mediaArtifact.sha256
      })
      markdown = markdown.split(mediaArtifact.relativePath).join(`data:${mediaMime(mediaArtifact.relativePath)};base64,${file.bytes.toString('base64')}`)
    }
    return markdown
  }

  #inputArtifact(manifest: TaskManifest): { key: 'sourceMarkdown' | 'translatedMarkdown'; artifact: Artifact } {
    const key = manifest.document.resolvedAction === 'translate' ? 'translatedMarkdown' : 'sourceMarkdown'
    const artifact = manifest.artifacts[key]
    if (!artifact?.valid) throw new Error(`缺少有效 ${key} 产物`)
    return { key, artifact }
  }

  #assertReady(manifest: TaskManifest): void {
    if (manifest.kind !== 'document') throw new Error('当前任务不是网页翻译任务')
    if (manifest.pipeline.stages.verify.status !== 'completed') throw new Error('文档尚未通过完整性验证')
  }

  #directionForTemplate(templateId?: string): DocumentHtmlDirection | undefined {
    if (!templateId) return undefined
    return (Object.entries(DIRECTIONS).find(([, direction]) => direction.templateId === templateId)?.[0] as DocumentHtmlDirection | undefined)
  }

  async #fail(taskDirectory: string, runId: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error)
    const current = await this.store.load(taskDirectory).catch(() => undefined)
    if (!current || current.document.htmlPublication.publicationRunId !== runId) return
    const failed = await this.store.mutate(taskDirectory, (draft) => {
      if (draft.document.htmlPublication.publicationRunId !== runId) return
      draft.document.htmlPublication.status = 'failed'
      draft.document.htmlPublication.errorCode = message.slice(0, 500)
    }).catch(() => undefined)
    if (failed) this.index.upsert(taskDirectory, failed)
  }

  async #artifact(taskDirectory: string, relativePath: string, producer: string, inputFingerprint: string): Promise<Artifact> {
    const absolute = join(taskDirectory, relativePath)
    const info = await stat(absolute)
    if (!info.isFile()) throw new Error(`${relativePath} 不是普通文件`)
    return {
      relativePath,
      sha256: await sha256File(absolute),
      size: info.size,
      valid: true,
      producer,
      inputFingerprint
    }
  }

  async #artifactText(taskDirectory: string, artifact: Artifact, label: string, maxBytes: number): Promise<string> {
    const file = await readContainedFile(taskDirectory, artifact.relativePath, label, {
      maxBytes,
      expectedSize: artifact.size,
      expectedSha256: artifact.sha256
    })
    return file.bytes.toString('utf8')
  }

  async #task(taskId: string): Promise<{ directory: string; manifest: TaskManifest }> {
    const indexed = this.index.get(taskId)
    if (!indexed) throw new Error('任务不存在')
    return { directory: indexed.location, manifest: await this.store.load(indexed.location) }
  }
}
