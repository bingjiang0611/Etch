import { lookup } from 'node:dns/promises'
import { Agent as HttpAgent, request as httpRequest, type AgentOptions, type IncomingMessage } from 'node:http'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'
import { BlockList, isIP } from 'node:net'
import { Readable } from 'node:stream'
import {
  createMarkdownBlocks,
  parseMarkdownBlocks,
  type DocumentMedia,
  type DocumentMetadata,
  type DocumentProcessingMode,
  type MarkdownBlock,
  type MarkdownBlockInput,
  type MarkdownDocument
} from '../../core/document'
import { documentTranslationBudgetError } from '../../core/document-translation'

export const DOCUMENT_SOURCE_MAX_BYTES = 2 * 1024 * 1024
export const DOCUMENT_MEDIA_MAX_BYTES = 10 * 1024 * 1024
export const DOCUMENT_SOURCE_MAX_REDIRECTS = 5
export const DOCUMENT_SOURCE_TIMEOUT_MS = 15_000
export const DOCUMENT_MEDIA_MAX_ITEMS = 32

export type DocumentFetch = typeof fetch
export type DocumentHostResolver = (hostname: string) => Promise<readonly string[]>
export type DocumentProxyResolver = (url: string) => Promise<string | undefined>

export interface DocumentSourceOptions {
  fetch?: DocumentFetch
  resolveHostname?: DocumentHostResolver
  resolveProxy?: DocumentProxyResolver
  processingMode?: DocumentProcessingMode
  targetLanguage?: string
  maxResponseBytes?: number
  maxRedirects?: number
  timeoutMs?: number
  signal?: AbortSignal
  now?: () => Date
}

export interface FetchedDocumentSource {
  sourceRaw: string
  sourceDocument: MarkdownDocument
  sourceMetadata: DocumentMetadata
  mediaManifest: DocumentMedia[]
}

export interface FetchedDocumentMedia {
  bytes: Uint8Array
  contentType: string
  finalUrl: string
}

export type DocumentSourceErrorCode =
  | 'invalid-url'
  | 'unsafe-url'
  | 'host-lookup-failed'
  | 'redirect-failed'
  | 'http-error'
  | 'response-too-large'
  | 'unsupported-content-type'
  | 'empty-content'
  | 'translation-too-large'
  | 'invalid-x-response'
  | 'media-failed'

export class DocumentSourceError extends Error {
  constructor(readonly code: DocumentSourceErrorCode, message: string) {
    super(message)
    this.name = 'DocumentSourceError'
  }
}

interface FetchContext {
  fetcher?: DocumentFetch
  resolveHostname: DocumentHostResolver
  resolveProxy?: DocumentProxyResolver
  maxResponseBytes: number
  maxRedirects: number
  signal: AbortSignal
}

interface XStatusRoute {
  username: string
  tweetId: string
}

interface DraftDecoration {
  start: number
  end: number
  open: string
  close: string
  priority: number
}

type SupportedMediaContentType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'image/avif' | 'image/svg+xml'

const SUPPORTED_MEDIA_CONTENT_TYPES = new Set<SupportedMediaContentType>([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/svg+xml'
])

const redirects = new Set([301, 302, 303, 307, 308])
const blockedIpv4 = new BlockList()
const blockedIpv6 = new BlockList()

for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4]
] as const) blockedIpv4.addSubnet(network, prefix, 'ipv4')

for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['::ffff:0:0', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001:2::', 48],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8]
] as const) blockedIpv6.addSubnet(network, prefix, 'ipv6')

export async function fetchDocumentSource(input: string, options: DocumentSourceOptions = {}): Promise<FetchedDocumentSource> {
  const sourceUrl = parseSourceUrl(input)
  const maxResponseBytes = boundedInteger(options.maxResponseBytes, DOCUMENT_SOURCE_MAX_BYTES, DOCUMENT_SOURCE_MAX_BYTES)
  const maxRedirects = boundedInteger(options.maxRedirects, DOCUMENT_SOURCE_MAX_REDIRECTS, 10, true)
  const timeoutMs = boundedInteger(options.timeoutMs, DOCUMENT_SOURCE_TIMEOUT_MS, 60_000)
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const context: FetchContext = {
    fetcher: options.fetch,
    resolveHostname: options.resolveHostname ?? resolvePublicAddresses,
    resolveProxy: options.resolveProxy,
    maxResponseBytes,
    maxRedirects,
    signal: options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal
  }
  const common = {
    processingMode: options.processingMode ?? 'auto' as const,
    targetLanguage: options.targetLanguage?.trim() || 'zh-CN',
    fetchedAt: (options.now ?? (() => new Date()))().toISOString()
  }

  const xRoute = xStatusRoute(sourceUrl)
  if (xRoute) {
    await assertSafeUrl(sourceUrl, context.resolveHostname)
    return fetchXDocument(sourceUrl, xRoute, common, context)
  }
  return fetchWebDocument(sourceUrl, common, context)
}

export async function fetchDocumentMedia(input: string, options: DocumentSourceOptions = {}): Promise<FetchedDocumentMedia> {
  const sourceUrl = parseSourceUrl(input)
  const maxResponseBytes = boundedInteger(options.maxResponseBytes, DOCUMENT_MEDIA_MAX_BYTES, DOCUMENT_MEDIA_MAX_BYTES)
  const maxRedirects = boundedInteger(options.maxRedirects, DOCUMENT_SOURCE_MAX_REDIRECTS, 10, true)
  const timeoutMs = boundedInteger(options.timeoutMs, DOCUMENT_SOURCE_TIMEOUT_MS, 60_000)
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const context: FetchContext = {
    fetcher: options.fetch,
    resolveHostname: options.resolveHostname ?? resolvePublicAddresses,
    resolveProxy: options.resolveProxy,
    maxResponseBytes,
    maxRedirects,
    signal: options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal
  }
  const { finalUrl, response } = await fetchWithRedirects(sourceUrl, 'image/*', context)
  const contentType = responseContentType(response)
  if (!SUPPORTED_MEDIA_CONTENT_TYPES.has(contentType as SupportedMediaContentType)) {
    void response.body?.cancel().catch(() => undefined)
    throw new DocumentSourceError('unsupported-content-type', `不支持的媒体 Content-Type：${contentType || '(missing)'}`)
  }
  const declaredContentType = contentType as SupportedMediaContentType
  const bytes = await readLimitedBytes(response, maxResponseBytes)
  const detectedContentType = detectedMediaContentType(bytes)
  if (detectedContentType !== declaredContentType) {
    throw new DocumentSourceError(
      'unsupported-content-type',
      `媒体 Content-Type 与内容不匹配：声明 ${declaredContentType}，检测为 ${detectedContentType ?? 'unknown'}`
    )
  }
  return {
    bytes,
    contentType: declaredContentType,
    finalUrl: finalUrl.toString()
  }
}

export function finalizeDocumentMedia(
  contentType: DocumentMetadata['contentType'],
  media: readonly DocumentMedia[]
): { mediaManifest: DocumentMedia[]; warnings: string[] } {
  const warnings: string[] = []
  const mediaManifest = media.map((entry) => {
    const status = entry.status === 'localized' && !entry.localPath ? 'failed' as const : entry.status
    if (contentType !== 'web' && entry.kind !== 'video' && status !== 'localized') {
      throw new DocumentSourceError('media-failed', `X 媒体 ${entry.index} 未完成本地化：${entry.sourceUrl}`)
    }
    if (contentType !== 'web' && entry.kind === 'video' && status !== 'localized' && status !== 'skipped') {
      throw new DocumentSourceError('media-failed', `X 视频 ${entry.index} 未完成本地化或显式跳过：${entry.sourceUrl}`)
    }
    if (contentType === 'web' && status === 'failed') {
      warnings.push(`图片 ${entry.index} 本地化失败，已保留远程引用：${entry.sourceUrl}`)
      const remote: DocumentMedia = { ...entry, status: 'remote' }
      delete remote.localPath
      return remote
    }
    return { ...entry, status }
  })
  return { mediaManifest, warnings: safeDocumentWarnings(warnings) }
}

async function fetchWebDocument(
  sourceUrl: URL,
  common: Pick<DocumentMetadata, 'processingMode' | 'targetLanguage' | 'fetchedAt'>,
  context: FetchContext
): Promise<FetchedDocumentSource> {
  const { finalUrl, response } = await fetchWithRedirects(sourceUrl, 'text/html, application/xhtml+xml', context)
  assertContentType(response, ['text/html', 'application/xhtml+xml'])
  const sourceRaw = await readLimitedText(response, context.maxResponseBytes)
  const root = mainHtml(sourceRaw)
  const markdown = htmlToMarkdown(root.html, finalUrl)
  const parsedBlocks = trimWebNoise(parseMarkdownBlocks(markdown))
  if (!parsedBlocks.length) throw new DocumentSourceError('empty-content', '网页中没有识别到可用正文')

  const sourceTitle = boundedText(firstNonEmpty(
    metaContent(sourceRaw, 'property', 'og:title'),
    metaContent(sourceRaw, 'name', 'twitter:title'),
    htmlTitle(sourceRaw),
    headingText(parsedBlocks)
  ), 1000)
  const canonicalUrl = canonicalLink(sourceRaw, finalUrl)
  const author = boundedText(firstNonEmpty(
    metaContent(sourceRaw, 'name', 'author'),
    metaContent(sourceRaw, 'property', 'article:author')
  ), 500)
  const publishedAt = boundedText(firstNonEmpty(
    metaContent(sourceRaw, 'property', 'article:published_time'),
    metaContent(sourceRaw, 'name', 'date')
  ), 100)
  const sourceLanguage = normalizeLanguage(htmlLanguage(sourceRaw)) ?? inferLanguage(parsedBlocks.map((block) => block.markdown).join('\n'))
  const needsTranslation = common.processingMode === 'translate'
    || (common.processingMode === 'auto' && !/^zh(?:-|$)/iu.test(sourceLanguage ?? ''))
  const budgetError = needsTranslation
    ? documentTranslationBudgetError(parsedBlocks, root.warning ? [root.warning] : [])
    : undefined
  if (budgetError) throw new DocumentSourceError('translation-too-large', budgetError)
  const warnings = safeDocumentWarnings(root.warning ? [root.warning] : [])
  const metadata: DocumentMetadata = {
    ...common,
    contentType: 'web',
    sourceUrl: sourceUrl.toString(),
    ...(finalUrl.toString() !== sourceUrl.toString() ? { canonicalUrl: canonicalUrl ?? finalUrl.toString() } : canonicalUrl ? { canonicalUrl } : {}),
    ...(sourceTitle ? { sourceTitle, title: sourceTitle } : {}),
    ...(author ? { author } : {}),
    ...(publishedAt ? { publishedAt: normalizeDate(publishedAt) ?? publishedAt } : {}),
    ...(sourceLanguage ? { sourceLanguage } : {})
  }
  const sourceDocument: MarkdownDocument = { metadata, blocks: parsedBlocks, warnings }
  return {
    sourceRaw,
    sourceDocument,
    sourceMetadata: metadata,
    mediaManifest: boundedMediaManifest(mediaManifest(parsedBlocks))
  }
}

async function fetchXDocument(
  sourceUrl: URL,
  route: XStatusRoute,
  common: Pick<DocumentMetadata, 'processingMode' | 'targetLanguage' | 'fetchedAt'>,
  context: FetchContext
): Promise<FetchedDocumentSource> {
  const apiUrl = new URL(`https://api.fxtwitter.com/${encodeURIComponent(route.username)}/status/${route.tweetId}`)
  const { response } = await fetchWithRedirects(apiUrl, 'application/json', context)
  assertContentType(response, ['application/json'], true)
  const sourceRaw = await readLimitedText(response, context.maxResponseBytes)
  let payload: unknown
  try {
    payload = JSON.parse(sourceRaw)
  } catch {
    throw new DocumentSourceError('invalid-x-response', 'FxTwitter 返回了无效 JSON')
  }
  const root = objectValue(payload)
  const tweet = objectValue(root?.tweet)
  if (!tweet) throw new DocumentSourceError('invalid-x-response', 'FxTwitter 响应缺少 tweet')

  const authorObject = objectValue(tweet.author)
  const author = boundedText(stringValue(authorObject?.name), 500)
  const authorHandle = boundedText(stringValue(authorObject?.screen_name) ?? route.username, 100) ?? route.username
  const article = objectValue(tweet.article)
  const contentType = article ? 'x-article' as const : 'x-post' as const
  const warnings: string[] = ['X 首版只处理当前 status；线程、引用帖与投票不会自动展开']
  const inputs = article
    ? xArticleBlocks(article, warnings, sourceUrl)
    : xPostBlocks(tweet, warnings, sourceUrl)
  const blocks = createMarkdownBlocks(inputs)
  if (!blocks.length) throw new DocumentSourceError('empty-content', 'X 内容为空')

  const articleTitle = stringValue(article?.title)
  const tweetText = stringValue(tweet.text)
  const sourceTitle = boundedText(articleTitle ?? summaryTitle(tweetText ?? author ?? `@${authorHandle}`), 1000) ?? `@${authorHandle}`
  const coverImageUrl = articleCoverUrl(article, sourceUrl)
  const sourceLanguage = normalizeLanguage(stringValue(tweet.lang)) ?? inferLanguage(blocks.map((block) => block.markdown).join('\n'))
  const engagement = compactEngagement(tweet)
  const publishedAt = boundedText(stringValue(tweet.created_at), 100)
  const metadata: DocumentMetadata = {
    ...common,
    contentType,
    sourceUrl: sourceUrl.toString(),
    sourceTitle,
    title: sourceTitle,
    ...(author ? { author } : {}),
    screenName: authorHandle,
    authorUrl: `https://x.com/${encodeURIComponent(authorHandle)}`,
    ...(publishedAt ? { publishedAt: normalizeDate(publishedAt) ?? publishedAt } : {}),
    ...(sourceLanguage ? { sourceLanguage } : {}),
    tweetId: route.tweetId,
    ...(coverImageUrl ? { coverImageUrl } : {}),
    ...(engagement ? { engagement } : {})
  }
  const sourceDocument: MarkdownDocument = { metadata, blocks, warnings: safeDocumentWarnings(warnings) }
  const images = mediaManifest(blocks, coverImageUrl)
  return {
    sourceRaw,
    sourceDocument,
    sourceMetadata: metadata,
    mediaManifest: boundedMediaManifest([...images, ...skippedXVideos(tweet, images.length, sourceUrl)])
  }
}

async function fetchWithRedirects(
  start: URL,
  accept: string,
  context: FetchContext
): Promise<{ finalUrl: URL; response: Response }> {
  let current = new URL(start)
  for (let redirectCount = 0; ; redirectCount += 1) {
    const addresses = await assertSafeUrl(current, context.resolveHostname)
    const response = context.fetcher
      ? await context.fetcher(current, {
          method: 'GET',
          redirect: 'manual',
          headers: { Accept: accept, 'User-Agent': 'Etch/DocumentSource' },
          signal: context.signal
        })
      : await pinnedFetch(current, accept, addresses, context.signal, context.resolveProxy)
    if (redirects.has(response.status)) {
      if (redirectCount >= context.maxRedirects) {
        void response.body?.cancel().catch(() => undefined)
        throw new DocumentSourceError('redirect-failed', `网页重定向超过 ${context.maxRedirects} 次`)
      }
      const location = response.headers.get('location')
      void response.body?.cancel().catch(() => undefined)
      if (!location) throw new DocumentSourceError('redirect-failed', `HTTP ${response.status} 缺少 Location`)
      try {
        current = new URL(location, current)
      } catch {
        throw new DocumentSourceError('redirect-failed', '网页返回了无效重定向地址')
      }
      continue
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined)
      throw new DocumentSourceError('http-error', `网页请求失败（HTTP ${response.status}）`)
    }
    assertDeclaredSize(response, context.maxResponseBytes)
    return { finalUrl: current, response }
  }
}

function parseSourceUrl(input: string): URL {
  const value = input.trim()
  if (!value || value.length > 4096) throw new DocumentSourceError('invalid-url', '请输入有效且长度不超过 4096 的 URL')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new DocumentSourceError('invalid-url', '请输入有效的 http 或 https URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new DocumentSourceError('invalid-url', '文档来源只支持 http 或 https URL')
  }
  if (url.username || url.password) throw new DocumentSourceError('unsafe-url', '文档来源 URL 不允许包含账号或密码')
  url.hash = ''
  return url
}

async function assertSafeUrl(url: URL, resolveHostname: DocumentHostResolver): Promise<readonly string[]> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new DocumentSourceError('unsafe-url', `不安全的 URL 协议：${url.protocol}`)
  if (url.username || url.password) throw new DocumentSourceError('unsafe-url', 'URL 不允许包含账号或密码')
  const rawHostname = url.hostname.replace(/\.$/u, '').toLocaleLowerCase('en-US')
  const hostname = rawHostname.startsWith('[') && rawHostname.endsWith(']') ? rawHostname.slice(1, -1) : rawHostname
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new DocumentSourceError('unsafe-url', `不允许访问本机地址：${hostname || '(empty)'}`)
  }
  const literalFamily = isIP(hostname)
  if (literalFamily) {
    if (!isPublicAddress(hostname)) throw new DocumentSourceError('unsafe-url', `不允许访问非公网地址：${hostname}`)
    return [hostname]
  }

  let addresses: readonly string[]
  try {
    addresses = await resolveHostname(hostname)
  } catch {
    throw new DocumentSourceError('host-lookup-failed', `无法解析文档来源域名：${hostname}`)
  }
  if (!addresses.length) throw new DocumentSourceError('host-lookup-failed', `文档来源域名没有可用地址：${hostname}`)
  const unsafe = addresses.find((address) => !isPublicAddress(address))
  if (unsafe) throw new DocumentSourceError('unsafe-url', `域名 ${hostname} 解析到非公网地址：${unsafe}`)
  return addresses
}

async function pinnedFetch(
  url: URL,
  accept: string,
  addresses: readonly string[],
  signal: AbortSignal,
  resolveProxy?: DocumentProxyResolver
): Promise<Response> {
  const proxyUrl = await resolveProxy?.(url.toString()).then(documentProxyUrl).catch(() => undefined)
  let lastError: unknown
  for (const address of addresses) {
    try {
      return await requestPinnedAddress(url, accept, address, signal, proxyUrl)
    } catch (error) {
      if (signal.aborted) throw error
      lastError = error
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError ?? 'unknown error')
  throw new DocumentSourceError('http-error', `网页连接失败：${detail}`.slice(0, 500))
}

function requestPinnedAddress(url: URL, accept: string, address: string, signal: AbortSignal, proxyUrl?: string): Promise<Response> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const hostname = url.hostname.replace(/^\[|\]$/gu, '')
    const options = {
      protocol: url.protocol,
      hostname: address,
      family: isIP(address),
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers: {
        Accept: accept,
        Host: url.host,
        'User-Agent': 'Etch/DocumentSource'
      },
      signal,
      ...(proxyUrl ? { agent: proxyAgent(url.protocol, proxyUrl) } : {}),
      ...(url.protocol === 'https:' && !isIP(hostname) ? { servername: hostname } : {})
    }
    const onResponse = (incoming: IncomingMessage): void => {
      const status = incoming.statusCode ?? 0
      if (status < 200 || status > 599) {
        incoming.destroy()
        reject(new DocumentSourceError('http-error', `网页返回了无效 HTTP 状态：${status}`))
        return
      }
      const headers = new Headers()
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) value.forEach((item) => headers.append(name, item))
        else if (value !== undefined) headers.set(name, value)
      }
      const body = Readable.toWeb(incoming) as ReadableStream<Uint8Array>
      resolve(new Response(body, { status, statusText: incoming.statusMessage, headers }))
    }
    const request = url.protocol === 'https:'
      ? httpsRequest(options, onResponse)
      : httpRequest(options, onResponse)
    request.once('error', reject)
    request.end()
  })
}

type ProxyAgentOptions = AgentOptions & { proxyEnv: NodeJS.ProcessEnv }

function proxyAgent(protocol: string, proxyUrl: string): HttpAgent | HttpsAgent {
  const proxyEnv = protocol === 'https:' ? { HTTPS_PROXY: proxyUrl } : { HTTP_PROXY: proxyUrl }
  const options: ProxyAgentOptions = { keepAlive: false, proxyEnv }
  return protocol === 'https:' ? new HttpsAgent(options) : new HttpAgent(options)
}

export function documentProxyUrl(route: string | undefined): string | undefined {
  if (!route?.trim()) return undefined
  for (const entry of route.split(';').map((value) => value.trim()).filter(Boolean)) {
    if (/^DIRECT$/iu.test(entry)) return undefined
    const match = /^(PROXY|HTTP|HTTPS)\s+(.+)$/iu.exec(entry)
    const candidate = match
      ? `${match[1].toUpperCase() === 'HTTPS' ? 'https' : 'http'}://${match[2]}`
      : entry
    try {
      const url = new URL(candidate)
      if ((url.protocol === 'http:' || url.protocol === 'https:') && url.hostname && url.port) return url.toString()
    } catch {
      // Try the next proxy route returned by Electron.
    }
  }
  return undefined
}

function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return !blockedIpv4.check(address, 'ipv4')
  if (family === 6) return !blockedIpv6.check(address, 'ipv6')
  return false
}

async function resolvePublicAddresses(hostname: string): Promise<readonly string[]> {
  return (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address)
}

function assertDeclaredSize(response: Response, maxBytes: number): void {
  const header = response.headers.get('content-length')
  if (!header) return
  const declared = Number(header)
  if (Number.isFinite(declared) && declared > maxBytes) {
    void response.body?.cancel().catch(() => undefined)
    throw new DocumentSourceError('response-too-large', `文档来源响应超过 ${maxBytes} bytes`)
  }
}

async function readLimitedText(response: Response, maxBytes: number): Promise<string> {
  return Buffer.from(await readLimitedBytes(response, maxBytes)).toString('utf8')
}

async function readLimitedBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) throw new DocumentSourceError('empty-content', '文档来源响应为空')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      total += result.value.byteLength
      if (total > maxBytes) throw new DocumentSourceError('response-too-large', `文档来源响应超过 ${maxBytes} bytes`)
      chunks.push(result.value)
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  }
  if (!total) throw new DocumentSourceError('empty-content', '文档来源响应为空')
  return Uint8Array.from(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))))
}

function assertContentType(response: Response, allowed: readonly string[], allowJsonSuffix = false): void {
  const type = responseContentType(response)
  const accepted = type && (allowed.includes(type) || (allowJsonSuffix && type.endsWith('+json')))
  if (!accepted) {
    void response.body?.cancel().catch(() => undefined)
    throw new DocumentSourceError('unsupported-content-type', `不支持的文档来源 Content-Type：${type || '(missing)'}`)
  }
}

function responseContentType(response: Response): string | undefined {
  return response.headers.get('content-type')?.split(';', 1)[0].trim().toLocaleLowerCase('en-US') || undefined
}

function detectedMediaContentType(bytes: Uint8Array): SupportedMediaContentType | undefined {
  if (matchesBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (matchesBytes(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (matchesAscii(bytes, 'GIF87a') || matchesAscii(bytes, 'GIF89a')) return 'image/gif'
  if (matchesAscii(bytes, 'RIFF') && matchesAscii(bytes, 'WEBP', 8)) return 'image/webp'
  if (isAvif(bytes)) return 'image/avif'
  if (isSvg(bytes)) return 'image/svg+xml'
  return undefined
}

function matchesBytes(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  return bytes.length >= offset + signature.length
    && signature.every((value, index) => bytes[offset + index] === value)
}

function matchesAscii(bytes: Uint8Array, signature: string, offset = 0): boolean {
  return matchesBytes(bytes, [...signature].map((character) => character.charCodeAt(0)), offset)
}

function isAvif(bytes: Uint8Array): boolean {
  if (bytes.length < 12 || !matchesAscii(bytes, 'ftyp', 4)) return false
  const boxSize = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).readUInt32BE(0)
  if (boxSize < 12 || boxSize > bytes.length) return false
  for (let offset = 8; offset + 4 <= boxSize; offset += 4) {
    if (matchesAscii(bytes, 'avif', offset) || matchesAscii(bytes, 'avis', offset)) return true
  }
  return false
}

function isSvg(bytes: Uint8Array): boolean {
  let source: string
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return false
  }
  return /^\uFEFF?\s*(?:<\?xml[\s\S]*?\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE\s+svg(?:\s+[^>]*)?>\s*)?<svg(?:\s|>)/iu.test(source)
}

function xStatusRoute(url: URL): XStatusRoute | undefined {
  const hostname = url.hostname.toLocaleLowerCase('en-US').replace(/^www\./u, '').replace(/^mobile\./u, '')
  if (hostname !== 'x.com' && hostname !== 'twitter.com') return undefined
  const match = url.pathname.match(/^\/([^/]+)\/status\/(\d+)(?:\/|$)/u)
  if (!match) return undefined
  let username: string
  try {
    username = decodeURIComponent(match[1])
  } catch {
    return undefined
  }
  return /^[A-Za-z0-9_]{1,15}$/u.test(username) ? { username, tweetId: match[2] } : undefined
}

function mainHtml(html: string): { html: string; warning?: string } {
  const article = largestElement(html, 'article')
  if (article) return { html: article }
  const main = largestElement(html, 'main')
  if (main) return { html: main }
  const body = largestElement(html, 'body')
  return {
    html: body ?? html,
    warning: '未检测到 article/main，已从页面主体提取；请检查正文边界'
  }
}

function largestElement(html: string, tag: string): string | undefined {
  const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'giu')
  const matches = [...html.matchAll(pattern)].map((match) => match[1])
  return matches.sort((left, right) => visibleLength(right) - visibleLength(left))[0]
}

function htmlToMarkdown(input: string, baseUrl: URL): string {
  const protectedBlocks: string[] = []
  let html = input.replace(/<!--[\s\S]*?-->/gu, '')
  html = stripPairedElements(html, 'script|style|noscript|template|nav|footer|aside|form|dialog|button')
  html = stripNoiseContainers(html)
  html = html.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/giu, (_match, body: string) => {
    const code = decodeEntities(body.replace(/^\s*<code\b[^>]*>/iu, '').replace(/<\/code>\s*$/iu, '').replace(/<[^>]+>/gu, ''))
    return protectBlock(`\`\`\`\n${code.trim()}\n\`\`\``, protectedBlocks)
  })
  html = html.replace(/<table\b[^>]*>[\s\S]*?<\/table>/giu, (table) => protectBlock(table.trim(), protectedBlocks))
  html = html.replace(/<ol\b[^>]*>([\s\S]*?)<\/ol>/giu, (_match, body: string) => listMarkdown(body, true, baseUrl))
  html = html.replace(/<ul\b[^>]*>([\s\S]*?)<\/ul>/giu, (_match, body: string) => listMarkdown(body, false, baseUrl))
  html = html.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/giu, (_match, level: string, body: string) => `\n\n${'#'.repeat(Number(level))} ${inlineMarkdown(body, baseUrl)}\n\n`)
  html = html.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/giu, (_match, body: string) => {
    const lines = inlineMarkdown(body, baseUrl).split('\n').filter((line) => line.trim())
    return `\n\n${lines.map((line) => `> ${line.trim()}`).join('\n')}\n\n`
  })
  html = html.replace(/<p\b[^>]*>([\s\S]*?)<\/p>/giu, (_match, body: string) => `\n\n${inlineMarkdown(body, baseUrl)}\n\n`)
  html = html.replace(/<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/giu, (_match, body: string) => `\n\n*${inlineMarkdown(body, baseUrl)}*\n\n`)
  html = inlineMarkdown(html, baseUrl)
    .replace(/<hr\b[^>]*\/?\s*>/giu, '\n\n---\n\n')
    .replace(/<\/?(?:article|main|section|div|header|figure|details|summary|dl|dt|dd)\b[^>]*>/giu, '\n\n')
    .replace(/<[^>]+>/gu, '')
  html = decodeEntities(html)
    .replace(/[\t\f\v]+/gu, ' ')
    .replace(/ +\n/gu, '\n')
    .replace(/\n +/gu, '\n')
    .replace(/ {2,}/gu, ' ')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
  html = html.replace(/@@ETCH_DOCUMENT_BLOCK_(\d+)@@/gu, (_match, index: string) => protectedBlocks[Number(index)] ?? '')
  return `${html.trim()}\n`
}

function inlineMarkdown(input: string, baseUrl: URL): string {
  return input
    .replace(/<img\b[^>]*>/giu, (tag) => {
      const source = remoteUrl(attribute(tag, 'src') ?? attribute(tag, 'data-src'), baseUrl)
      if (!source) return ''
      return `\n\n![${decodeEntities(attribute(tag, 'alt') ?? '')}](${source})\n\n`
    })
    .replace(/<a\b[^>]*>([\s\S]*?)<\/a>/giu, (tag, body: string) => {
      const label = decodeEntities(body.replace(/<[^>]+>/gu, '')).trim()
      const target = remoteUrl(attribute(tag, 'href'), baseUrl)
      return target && label ? `[${label}](${target})` : label
    })
    .replace(/<(?:strong|b)\b[^>]*>([\s\S]*?)<\/(?:strong|b)>/giu, '**$1**')
    .replace(/<(?:em|i)\b[^>]*>([\s\S]*?)<\/(?:em|i)>/giu, '*$1*')
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/giu, '`$1`')
    .replace(/<br\b[^>]*\/?\s*>/giu, '\n')
}

function listMarkdown(body: string, ordered: boolean, baseUrl: URL): string {
  const items = [...body.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/giu)]
    .map((match) => inlineMarkdown(match[1], baseUrl).replace(/<[^>]+>/gu, '').replace(/\s+/gu, ' ').trim())
    .filter(Boolean)
  return items.length ? `\n\n${items.map((item) => `${ordered ? '1.' : '-'} ${item}`).join('\n')}\n\n` : ''
}

function protectBlock(block: string, blocks: string[]): string {
  const index = blocks.push(block) - 1
  return `\n\n@@ETCH_DOCUMENT_BLOCK_${index}@@\n\n`
}

function stripPairedElements(html: string, tags: string): string {
  const pattern = new RegExp(`<(${tags})\\b[^>]*>[\\s\\S]*?<\\/\\1>`, 'giu')
  let result = html
  for (let pass = 0; pass < 5; pass += 1) {
    const next = result.replace(pattern, '')
    if (next === result) break
    result = next
  }
  return result
}

function stripNoiseContainers(html: string): string {
  const pattern = /<(div|section)\b([^>]*(?:class|id)\s*=\s*(?:"[^"]*(?:cookie|newsletter|subscribe|related-post|related-content|sidebar|social-share|site-footer)[^"]*"|'[^']*(?:cookie|newsletter|subscribe|related-post|related-content|sidebar|social-share|site-footer)[^']*'))[^>]*>[\s\S]*?<\/\1>/giu
  let result = html
  for (let pass = 0; pass < 3; pass += 1) result = result.replace(pattern, '')
  return result
}

function trimWebNoise(blocks: readonly MarkdownBlock[]): MarkdownBlock[] {
  const trailingHeading = blocks.findIndex((block) => block.type === 'heading' && /^(?:#+\s*)?(?:related (?:posts|content)|get the .*newsletter)$/iu.test(block.markdown.trim()))
  const kept = trailingHeading >= 0 ? blocks.slice(0, trailingHeading) : [...blocks]
  return kept.filter((block) => {
    const plain = block.markdown.replace(/!?(?:\[([^\]]*)\])?\([^)]*\)/gu, '$1').replace(/[*_#>`-]/gu, '').trim()
    if (/^copy$/iu.test(plain)) return false
    if (/^(?:accept|reject|manage) (?:all )?cookies?$/iu.test(plain)) return false
    return !/^(?:we (?:use|value) cookies|cookie settings)/iu.test(plain)
  })
}

function xArticleBlocks(article: Record<string, unknown>, warnings: string[], sourceUrl: URL): MarkdownBlockInput[] {
  const content = objectValue(article.content)
  const rawBlocks = Array.isArray(content?.blocks) ? content.blocks : []
  const entities = new Map<string, Record<string, unknown>>()
  const rawEntityMap = Array.isArray(content?.entityMap) ? content.entityMap : []
  for (const item of rawEntityMap) {
    const entry = objectValue(item)
    const value = objectValue(entry?.value)
    if (entry && value) entities.set(String(entry.key), value)
  }
  const mediaById = new Map<string, Record<string, unknown>>()
  for (const item of Array.isArray(article.media_entities) ? article.media_entities : []) {
    const media = objectValue(item)
    if (!media) continue
    const id = stringValue(media.media_id) ?? stringValue(media.id_str) ?? stringValue(media.id)
    if (id) mediaById.set(id, media)
  }

  const inputs: MarkdownBlockInput[] = []
  for (const [index, value] of rawBlocks.entries()) {
    const block = objectValue(value)
    if (!block) continue
    const type = stringValue(block.type) ?? 'unstyled'
    const text = stringValue(block.text) ?? ''
    if (type === 'atomic') {
      const entityRange = objectValue(Array.isArray(block.entityRanges) ? block.entityRanges[0] : undefined)
      const entity = entityRange ? entities.get(String(entityRange.key)) : undefined
      const entityType = stringValue(entity?.type)?.toLocaleUpperCase('en-US')
      if (entityType === 'DIVIDER') {
        inputs.push({ type: 'divider', markdown: '---' })
        continue
      }
      if (entityType === 'MEDIA') {
        const data = objectValue(entity?.data)
        const mediaItems = Array.isArray(data?.mediaItems) ? data.mediaItems : []
        for (const mediaItem of mediaItems) {
          const item = objectValue(mediaItem)
          const mediaId = stringValue(item?.mediaId) ?? stringValue(item?.media_id)
          const media = mediaId ? mediaById.get(mediaId) : undefined
          const url = remoteUrl(mediaImageUrl(media), sourceUrl)
          if (url) inputs.push({ type: 'image', markdown: `![X Article image](${url})`, sourceId: mediaId })
          else warnings.push(`X Article 第 ${index + 1} 个媒体块缺少可用图片`)
        }
        continue
      }
      warnings.push(`X Article 第 ${index + 1} 个 atomic block 暂不支持`)
      continue
    }
    if (!text.trim()) continue
    const decorated = decorateDraftText(text, block, entities, sourceUrl)
    if (type === 'header-one') inputs.push({ type: 'heading', level: 1, markdown: `# ${decorated}` })
    else if (type === 'header-two') inputs.push({ type: 'heading', level: 2, markdown: `## ${decorated}` })
    else if (type === 'unordered-list-item') inputs.push({ type: 'unordered-list-item', markdown: `- ${decorated}` })
    else if (type === 'ordered-list-item') inputs.push({ type: 'ordered-list-item', markdown: `1. ${decorated}` })
    else inputs.push({ type: 'paragraph', markdown: decorated })
  }

  const title = stringValue(article.title)
  if (title && !inputs.some((block) => block.type === 'heading' && block.level === 1)) {
    inputs.unshift({ type: 'heading', level: 1, markdown: `# ${title}` })
  }
  const cover = articleCoverUrl(article, sourceUrl)
  if (cover) {
    const position = inputs[0]?.type === 'heading' && inputs[0].level === 1 ? 1 : 0
    inputs.splice(position, 0, { type: 'image', markdown: `![${title ?? 'X Article cover'}](${cover})`, sourceId: 'cover' })
  }
  return inputs
}

function xPostBlocks(tweet: Record<string, unknown>, warnings: string[], sourceUrl: URL): MarkdownBlockInput[] {
  const inputs: MarkdownBlockInput[] = []
  const text = stringValue(tweet.text)
  if (text?.trim()) inputs.push({ type: 'paragraph', markdown: text.trim() })
  const media = objectValue(tweet.media)
  const candidates = [
    ...(Array.isArray(media?.photos) ? media.photos : []),
    ...(Array.isArray(media?.all) ? media.all : [])
  ]
  const seen = new Set<string>()
  let skippedVideos = 0
  for (const candidate of candidates) {
    if (typeof candidate === 'string') {
      const url = remoteUrl(candidate, sourceUrl)
      if (url && !seen.has(url)) inputs.push({ type: 'image', markdown: `![X image](${url})` })
      if (url) seen.add(url)
      continue
    }
    const item = objectValue(candidate)
    if (!item) continue
    const type = stringValue(item.type)?.toLocaleLowerCase('en-US')
    if (type === 'video' || type === 'gif') {
      skippedVideos += 1
      continue
    }
    const url = remoteUrl(stringValue(item.url) ?? stringValue(item.media_url_https) ?? stringValue(item.original_img_url), sourceUrl)
    if (url && !seen.has(url)) inputs.push({ type: 'image', markdown: `![X image](${url})`, sourceId: stringValue(item.id) })
    if (url) seen.add(url)
  }
  if (skippedVideos) warnings.push(`已跳过 ${skippedVideos} 个 X 视频/GIF 媒体`)
  return inputs
}

function decorateDraftText(
  text: string,
  block: Record<string, unknown>,
  entities: ReadonlyMap<string, Record<string, unknown>>,
  sourceUrl: URL
): string {
  const decorations: DraftDecoration[] = []
  for (const value of Array.isArray(block.inlineStyleRanges) ? block.inlineStyleRanges : []) {
    const range = objectValue(value)
    const style = stringValue(range?.style)?.toLocaleUpperCase('en-US')
    const offset = integerValue(range?.offset)
    const length = integerValue(range?.length)
    if (offset === undefined || length === undefined || length <= 0) continue
    if (style === 'BOLD') decorations.push({ start: offset, end: offset + length, open: '**', close: '**', priority: 1 })
    if (style === 'ITALIC') decorations.push({ start: offset, end: offset + length, open: '*', close: '*', priority: 2 })
  }
  for (const value of Array.isArray(block.entityRanges) ? block.entityRanges : []) {
    const range = objectValue(value)
    const entity = range ? entities.get(String(range.key)) : undefined
    if (stringValue(entity?.type)?.toLocaleUpperCase('en-US') !== 'LINK') continue
    const data = objectValue(entity?.data)
    const target = remoteUrl(stringValue(data?.url) ?? stringValue(data?.expanded_url), sourceUrl)
    const offset = integerValue(range?.offset)
    const length = integerValue(range?.length)
    if (target && offset !== undefined && length !== undefined && length > 0) {
      decorations.push({ start: offset, end: offset + length, open: '[', close: `](${target})`, priority: 0 })
    }
  }
  return applyDecorations(text, decorations)
}

function applyDecorations(text: string, decorations: readonly DraftDecoration[]): string {
  const valid = decorations.filter((item) => item.start >= 0 && item.end > item.start && item.end <= text.length)
  let output = ''
  for (let index = 0; index <= text.length; index += 1) {
    const closing = valid.filter((item) => item.end === index).sort((left, right) => right.start - left.start || right.priority - left.priority)
    const opening = valid.filter((item) => item.start === index).sort((left, right) => right.end - left.end || left.priority - right.priority)
    output += closing.map((item) => item.close).join('')
    output += opening.map((item) => item.open).join('')
    if (index < text.length) output += text[index]
  }
  return output
}

function mediaManifest(blocks: readonly MarkdownBlock[], coverImageUrl?: string): DocumentMedia[] {
  const manifest: DocumentMedia[] = []
  for (const block of blocks) {
    if (block.type !== 'image') continue
    const image = markdownImage(block.markdown)
    if (!image) continue
    manifest.push({
      id: `media-${String(manifest.length + 1).padStart(3, '0')}`,
      kind: coverImageUrl && image.sourceUrl === coverImageUrl ? 'cover' : 'image',
      index: manifest.length + 1,
      sourceUrl: image.sourceUrl,
      blockId: block.id,
      ...(image.alt ? { alt: image.alt } : {}),
      ...(block.sourceId ? { sourceId: block.sourceId } : {}),
      status: 'remote'
    })
  }
  return manifest
}

function skippedXVideos(tweet: Record<string, unknown>, offset: number, sourceUrl: URL): DocumentMedia[] {
  const media = objectValue(tweet.media)
  const candidates = Array.isArray(media?.all) ? media.all : []
  const videos: DocumentMedia[] = []
  for (const candidate of candidates) {
    const item = objectValue(candidate)
    const type = stringValue(item?.type)?.toLocaleLowerCase('en-US')
    if (type !== 'video' && type !== 'gif') continue
    const mediaUrl = remoteUrl(stringValue(item?.url) ?? stringValue(item?.video_url) ?? stringValue(item?.thumbnail_url), sourceUrl)
    if (!mediaUrl) continue
    const index = offset + videos.length + 1
    videos.push({ id: `media-${String(index).padStart(3, '0')}`, kind: 'video', index, sourceUrl: mediaUrl, status: 'skipped' })
  }
  return videos
}

function markdownImage(markdown: string): { alt: string; sourceUrl: string } | undefined {
  const match = markdown.trim().match(/^!\[([^\]]*)\]\((.+)\)$/u)
  return match ? { alt: match[1], sourceUrl: match[2] } : undefined
}

function articleCoverUrl(article: Record<string, unknown> | undefined, sourceUrl: URL): string | undefined {
  const cover = objectValue(article?.cover_media)
  return remoteUrl(mediaImageUrl(cover), sourceUrl)
}

function mediaImageUrl(media: Record<string, unknown> | undefined): string | undefined {
  const info = objectValue(media?.media_info)
  return stringValue(info?.original_img_url)
    ?? stringValue(media?.original_img_url)
    ?? stringValue(media?.media_url_https)
    ?? stringValue(media?.url)
}

function compactEngagement(tweet: Record<string, unknown>): DocumentMetadata['engagement'] {
  const engagement = {
    replies: integerValue(tweet.replies),
    retweets: integerValue(tweet.retweets),
    likes: integerValue(tweet.likes),
    bookmarks: integerValue(tweet.bookmarks),
    views: integerValue(tweet.views)
  }
  return Object.values(engagement).some((value) => value !== undefined) ? engagement : undefined
}

function metaContent(html: string, attributeName: string, attributeValue: string): string | undefined {
  for (const match of html.matchAll(/<meta\b[^>]*>/giu)) {
    if (attribute(match[0], attributeName)?.toLocaleLowerCase('en-US') === attributeValue.toLocaleLowerCase('en-US')) {
      return decodeEntities(attribute(match[0], 'content') ?? '').trim() || undefined
    }
  }
  return undefined
}

function htmlTitle(html: string): string | undefined {
  const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/iu)?.[1]
  return title ? decodeEntities(title.replace(/<[^>]+>/gu, '')).trim() || undefined : undefined
}

function htmlLanguage(html: string): string | undefined {
  const tag = html.match(/<html\b[^>]*>/iu)?.[0]
  return tag ? attribute(tag, 'lang') : undefined
}

function canonicalLink(html: string, baseUrl: URL): string | undefined {
  for (const match of html.matchAll(/<link\b[^>]*>/giu)) {
    if (attribute(match[0], 'rel')?.split(/\s+/u).includes('canonical')) return remoteUrl(attribute(match[0], 'href'), baseUrl)
  }
  return undefined
}

function attribute(tag: string, name: string): string | undefined {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`, 'iu')
  const match = tag.match(pattern)
  return match ? match[1] ?? match[2] ?? match[3] : undefined
}

function remoteUrl(value: string | undefined, baseUrl: URL): string | undefined {
  if (!value?.trim()) return undefined
  try {
    const url = new URL(decodeEntities(value.trim()), baseUrl)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined
  } catch {
    return undefined
  }
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    amp: '&', apos: "'", gt: '>', hellip: '…', laquo: '«', ldquo: '“', lsquo: '‘', lt: '<', nbsp: ' ',
    ndash: '–', quot: '"', raquo: '»', rdquo: '”', rsquo: '’', mdash: '—'
  }
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/giu, (entity, code: string) => {
    const numeric = code.startsWith('#x') || code.startsWith('#X')
      ? Number.parseInt(code.slice(2), 16)
      : code.startsWith('#') ? Number.parseInt(code.slice(1), 10) : undefined
    if (numeric !== undefined) {
      return Number.isSafeInteger(numeric) && numeric >= 0 && numeric <= 0x10ffff && !(numeric >= 0xd800 && numeric <= 0xdfff)
        ? String.fromCodePoint(numeric)
        : entity
    }
    return named[code.toLocaleLowerCase('en-US')] ?? entity
  })
}

function visibleLength(html: string): number {
  return html.replace(/<[^>]+>/gu, ' ').replace(/\s+/gu, ' ').trim().length
}

function headingText(blocks: readonly MarkdownBlock[]): string | undefined {
  const heading = blocks.find((block) => block.type === 'heading')
  return heading?.markdown.replace(/^#{1,6}\s+/u, '').trim()
}

function inferLanguage(value: string): string | undefined {
  const naturalLanguage = value
    .replace(/https?:\/\/\S+/gu, ' ')
    .replace(/```[\s\S]*?```|`[^`]*`/gu, ' ')
  const han = [...naturalLanguage.matchAll(/\p{Script=Han}/gu)].length
  const latin = [...naturalLanguage.matchAll(/[A-Za-z]/gu)].length
  if (han >= 4 && han >= latin) return 'zh-CN'
  if (latin >= 20 && latin > han * 2) return 'en'
  return undefined
}

function boundedText(value: string | undefined, maxLength: number): string | undefined {
  const normalized = value?.trim()
  return normalized ? normalized.slice(0, maxLength) : undefined
}

function safeDocumentWarnings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim().slice(0, 500)).filter(Boolean))].slice(0, 100)
}

function boundedMediaManifest(media: DocumentMedia[]): DocumentMedia[] {
  if (media.length > DOCUMENT_MEDIA_MAX_ITEMS) {
    throw new DocumentSourceError('media-failed', `网页包含 ${media.length} 个媒体，超过单任务上限 ${DOCUMENT_MEDIA_MAX_ITEMS}`)
  }
  return media
}

function normalizeLanguage(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined
  const normalized = value.trim().replace(/_/gu, '-').toLocaleLowerCase('en-US')
  if (normalized === 'zh' || normalized.startsWith('zh-')) return 'zh-CN'
  if (normalized === 'en' || normalized.startsWith('en-')) return 'en'
  return normalized.length <= 32 && /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/u.test(normalized) ? normalized : undefined
}

function normalizeDate(value: string): string | undefined {
  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp) ? undefined : new Date(timestamp).toISOString()
}

function summaryTitle(value: string): string {
  const compact = value.replace(/\s+/gu, ' ').trim()
  return compact.length > 80 ? `${compact.slice(0, 79)}…` : compact
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value?.trim())?.trim()
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function integerValue(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN
  return Number.isSafeInteger(number) && number >= 0 ? number : undefined
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number, allowZero = false): number {
  if (value === undefined) return fallback
  const minimum = allowZero ? 0 : 1
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`配置值必须是 ${minimum} 到 ${maximum} 的整数`)
  return Math.min(value, maximum)
}
