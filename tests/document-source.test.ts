import { describe, expect, it, vi } from 'vitest'
import {
  fetchDocumentMedia,
  fetchDocumentSource,
  finalizeDocumentMedia,
  type DocumentHostResolver
} from '../src/main/content/document-source'
import type { DocumentMedia } from '../src/core/document'

const now = () => new Date('2026-08-09T00:00:00.000Z')
const publicResolver: DocumentHostResolver = async () => ['8.8.8.8']

function htmlResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...Object.fromEntries(new Headers(init.headers).entries()) }
  })
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json; charset=utf-8' } })
}

function mediaResponse(bytes: Uint8Array | string, contentType: string): Response {
  return new Response(bytes as BodyInit, { headers: { 'Content-Type': contentType } })
}

describe('fetchDocumentSource', () => {
  it('extracts a clean article, metadata and remote-media manifest from a normal webpage', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => htmlResponse(`<!doctype html>
      <html lang="en">
        <head>
          <title>Fallback title</title>
          <meta property="og:title" content="A Clean Article">
          <meta name="author" content="Ada Example">
          <link rel="canonical" href="/canonical">
        </head>
        <body>
          <nav>Products Pricing</nav>
          <article>
            <h1>A Clean Article</h1>
            <p>This is a sufficiently long English opening paragraph for reliable language detection.</p>
            <div class="cookie-banner">We use cookies</div>
            <img src="/images/chart.png" alt="Adoption chart">
            <h2>References</h2>
            <p><a href="/research">Research source</a></p>
          </article>
          <footer>Privacy Terms</footer>
        </body>
      </html>`))

    const result = await fetchDocumentSource('https://example.com/article#section', {
      fetch: fetcher,
      resolveHostname: publicResolver,
      processingMode: 'translate',
      now
    })

    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: 'GET', redirect: 'manual' })
    expect(result.sourceRaw).toContain('<nav>Products Pricing</nav>')
    expect(result.sourceMetadata).toMatchObject({
      processingMode: 'translate',
      contentType: 'web',
      sourceUrl: 'https://example.com/article',
      canonicalUrl: 'https://example.com/canonical',
      sourceTitle: 'A Clean Article',
      author: 'Ada Example',
      sourceLanguage: 'en',
      targetLanguage: 'zh-CN',
      fetchedAt: '2026-08-09T00:00:00.000Z'
    })
    expect(result.sourceDocument.blocks.map((block) => block.type)).toEqual([
      'heading', 'paragraph', 'image', 'heading', 'paragraph'
    ])
    expect(result.sourceDocument.blocks.map((block) => block.markdown).join('\n')).not.toMatch(/Products|cookies|Privacy/u)
    expect(result.sourceDocument.blocks.at(-1)?.markdown).toBe('[Research source](https://example.com/research)')
    expect(result.mediaManifest).toEqual([{
      id: 'media-001',
      kind: 'image',
      index: 1,
      sourceUrl: 'https://example.com/images/chart.png',
      blockId: 'block-0003',
      alt: 'Adoption chart',
      status: 'remote'
    }])
  })

  it('drops invalid or oversized language metadata before manifest commit', async () => {
    const result = await fetchDocumentSource('https://example.com/article', {
      fetch: vi.fn<typeof fetch>(async () => htmlResponse(`<html lang="${'invalid'.repeat(20)}"><article><p>Short body.</p></article></html>`)),
      resolveHostname: publicResolver,
      now
    })

    expect(result.sourceMetadata.sourceLanguage).toBeUndefined()
  })

  it('keeps a long body for the pipeline cost checkpoint while preserving convert-only mode', async () => {
    const paragraphs = Array.from({ length: 13 }, (_, index) => `<p>Section ${index + 1}: ${'reliable source text '.repeat(700)}</p>`).join('')
    const fetcher = vi.fn<typeof fetch>(async () => htmlResponse(`<html lang="en"><body>${paragraphs}</body></html>`))

    const pendingConfirmation = await fetchDocumentSource('https://example.com/oversized', {
      fetch: fetcher,
      resolveHostname: publicResolver,
      processingMode: 'auto',
      now
    })
    expect(pendingConfirmation.sourceDocument.blocks).toHaveLength(13)
    expect(pendingConfirmation.sourceDocument.warnings).toContain('未检测到 article/main，已从页面主体提取；请检查正文边界')

    const converted = await fetchDocumentSource('https://example.com/oversized', {
      fetch: fetcher,
      resolveHostname: publicResolver,
      processingMode: 'convert',
      now
    })
    expect(converted.sourceDocument.blocks).toHaveLength(13)
    expect(converted.sourceDocument.warnings).toContain('未检测到 article/main，已从页面主体提取；请检查正文边界')
  })

  it('routes an X status URL to FxTwitter and reconstructs article blocks and media', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      expect(String(input)).toBe('https://api.fxtwitter.com/alice/status/123')
      return jsonResponse({
        tweet: {
          author: { name: 'Alice Example', screen_name: 'alice' },
          created_at: '2026-08-08T12:00:00Z',
          replies: 2,
          retweets: 3,
          likes: 5,
          bookmarks: 7,
          views: 11,
          article: {
            title: 'Build systems',
            cover_media: { media_info: { original_img_url: 'https://pbs.twimg.com/cover.jpg' } },
            media_entities: [{ media_id: 'img-1', media_info: { original_img_url: 'https://pbs.twimg.com/body.png' } }],
            content: {
              blocks: [
                { type: 'header-one', text: 'Build systems', inlineStyleRanges: [], entityRanges: [] },
                {
                  type: 'unstyled',
                  text: 'Read docs',
                  inlineStyleRanges: [{ offset: 0, length: 4, style: 'BOLD' }],
                  entityRanges: [{ offset: 5, length: 4, key: 0 }]
                },
                { type: 'atomic', text: '', entityRanges: [{ offset: 0, length: 1, key: 1 }] },
                { type: 'atomic', text: '', entityRanges: [{ offset: 0, length: 1, key: 2 }] },
                { type: 'unordered-list-item', text: 'Keep structure', inlineStyleRanges: [], entityRanges: [] }
              ],
              entityMap: [
                { key: 0, value: { type: 'LINK', data: { url: 'https://example.com/docs' } } },
                { key: 1, value: { type: 'MEDIA', data: { mediaItems: [{ mediaId: 'img-1' }] } } },
                { key: 2, value: { type: 'DIVIDER', data: {} } }
              ]
            }
          }
        }
      })
    })

    const result = await fetchDocumentSource('https://x.com/alice/status/123?s=20', {
      fetch: fetcher,
      resolveHostname: publicResolver,
      now
    })

    expect(result.sourceMetadata).toMatchObject({
      contentType: 'x-article',
      sourceUrl: 'https://x.com/alice/status/123?s=20',
      sourceTitle: 'Build systems',
      author: 'Alice Example',
      screenName: 'alice',
      tweetId: '123',
      engagement: { replies: 2, retweets: 3, likes: 5, bookmarks: 7, views: 11 },
      coverImageUrl: 'https://pbs.twimg.com/cover.jpg'
    })
    expect(result.sourceDocument.blocks.map((block) => block.type)).toEqual([
      'heading', 'image', 'paragraph', 'image', 'divider', 'unordered-list-item'
    ])
    expect(result.sourceDocument.blocks[2].markdown).toBe('**Read** [docs](https://example.com/docs)')
    expect(result.mediaManifest.map((entry) => ({ kind: entry.kind, sourceUrl: entry.sourceUrl, sourceId: entry.sourceId }))).toEqual([
      { kind: 'cover', sourceUrl: 'https://pbs.twimg.com/cover.jpg', sourceId: 'cover' },
      { kind: 'image', sourceUrl: 'https://pbs.twimg.com/body.png', sourceId: 'img-1' }
    ])
  })

  it('uses the X language field for short Chinese posts in auto mode', async () => {
    const result = await fetchDocumentSource('https://x.com/alice/status/456', {
      fetch: vi.fn<typeof fetch>(async () => jsonResponse({
        tweet: {
          lang: 'zh',
          text: '今天发布新版本。',
          author: { name: 'Alice', screen_name: 'alice' }
        }
      })),
      resolveHostname: publicResolver,
      now
    })

    expect(result.sourceMetadata.sourceLanguage).toBe('zh-CN')
    expect(result.sourceDocument.blocks[0].markdown).toBe('今天发布新版本。')
  })

  it('rejects literal and DNS-resolved private destinations before fetch', async () => {
    const fetcher = vi.fn<typeof fetch>()

    for (const url of [
      'http://127.0.0.1/private',
      'http://[::1]/private',
      'http://[::ffff:127.0.0.1]/private',
      'https://user:password@example.com/private'
    ]) {
      await expect(fetchDocumentSource(url, {
        fetch: fetcher,
        resolveHostname: publicResolver
      })).rejects.toMatchObject({ code: 'unsafe-url' })
    }
    await expect(fetchDocumentSource('https://internal.example/private', {
      fetch: fetcher,
      resolveHostname: async () => ['192.168.1.8']
    })).rejects.toMatchObject({ code: 'unsafe-url' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('manually follows redirects and re-checks the destination against SSRF rules', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(null, {
      status: 302,
      headers: { Location: 'http://169.254.169.254/latest/meta-data' }
    }))

    await expect(fetchDocumentSource('https://example.com/start', {
      fetch: fetcher,
      resolveHostname: publicResolver
    })).rejects.toMatchObject({ code: 'unsafe-url' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('follows an allowed redirect manually and records the final URL', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => String(input).includes('/start')
      ? new Response(null, { status: 302, headers: { Location: 'https://www.example.com/article' } })
      : htmlResponse('<article><h1>Final page</h1><p>Redirected body.</p></article>'))

    const result = await fetchDocumentSource('https://example.com/start', {
      fetch: fetcher,
      resolveHostname: publicResolver,
      now
    })

    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(result.sourceMetadata.canonicalUrl).toBe('https://www.example.com/article')
    expect(result.sourceDocument.blocks.map((block) => block.markdown)).toEqual(['# Final page', 'Redirected body.'])
  })

  it('rejects unsupported content types and both declared and streamed oversized bodies', async () => {
    await expect(fetchDocumentSource('https://example.com/file', {
      fetch: vi.fn<typeof fetch>(async () => new Response('binary', { headers: { 'Content-Type': 'application/octet-stream' } })),
      resolveHostname: publicResolver
    })).rejects.toMatchObject({ code: 'unsupported-content-type' })

    await expect(fetchDocumentSource('https://example.com/large', {
      fetch: vi.fn<typeof fetch>(async () => htmlResponse('small', { headers: { 'Content-Length': '1000' } })),
      resolveHostname: publicResolver,
      maxResponseBytes: 64
    })).rejects.toMatchObject({ code: 'response-too-large' })

    await expect(fetchDocumentSource('https://example.com/streamed', {
      fetch: vi.fn<typeof fetch>(async () => htmlResponse(`<article><p>${'x'.repeat(100)}</p></article>`)),
      resolveHostname: publicResolver,
      maxResponseBytes: 64
    })).rejects.toMatchObject({ code: 'response-too-large' })
  })

  it('rejects pages whose media count exceeds the bounded localization budget', async () => {
    const images = Array.from({ length: 33 }, (_, index) => `<img src="/image-${index}.png" alt="${index}">`).join('')
    await expect(fetchDocumentSource('https://example.com/gallery', {
      fetch: vi.fn<typeof fetch>(async () => htmlResponse(`<article><h1>Gallery</h1>${images}</article>`)),
      resolveHostname: publicResolver
    })).rejects.toMatchObject({ code: 'media-failed' })
  })
})

describe('finalizeDocumentMedia', () => {
  const failedImage: DocumentMedia = {
    id: 'media-001',
    kind: 'image',
    index: 1,
    sourceUrl: 'https://example.com/image.png',
    localPath: 'assets/image.png',
    status: 'failed'
  }

  it('keeps a web image remote with a warning when localization fails', () => {
    expect(finalizeDocumentMedia('web', [failedImage])).toEqual({
      mediaManifest: [{
        id: 'media-001',
        kind: 'image',
        index: 1,
        sourceUrl: 'https://example.com/image.png',
        status: 'remote'
      }],
      warnings: ['图片 1 本地化失败，已保留远程引用：https://example.com/image.png']
    })
  })

  it('bounds remote-media warnings before they enter the task manifest', () => {
    const result = finalizeDocumentMedia('web', [{
      ...failedImage,
      sourceUrl: `https://example.com/image.png?signature=${'x'.repeat(1000)}`
    }])
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0].length).toBe(500)
  })

  it('requires every X image to be localized while allowing explicitly skipped video', () => {
    expect(() => finalizeDocumentMedia('x-article', [failedImage])).toThrow('X 媒体 1 未完成本地化')
    expect(finalizeDocumentMedia('x-post', [{
      id: 'media-001',
      kind: 'video',
      index: 1,
      sourceUrl: 'https://video.example/clip.mp4',
      status: 'skipped'
    }])).toMatchObject({ warnings: [] })
  })
})

describe('fetchDocumentMedia', () => {
  it('downloads only bounded image responses through the same guarded fetch path', async () => {
    const png = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
    const fetched = await fetchDocumentMedia('https://cdn.example.com/image.png', {
      fetch: vi.fn<typeof fetch>(async () => mediaResponse(png, 'image/png')),
      resolveHostname: publicResolver
    })

    expect(fetched).toEqual({
      bytes: png,
      contentType: 'image/png',
      finalUrl: 'https://cdn.example.com/image.png'
    })
    await expect(fetchDocumentMedia('https://cdn.example.com/not-image', {
      fetch: vi.fn<typeof fetch>(async () => new Response('no', { headers: { 'Content-Type': 'text/html' } })),
      resolveHostname: publicResolver
    })).rejects.toMatchObject({ code: 'unsupported-content-type' })
  })

  it.each([
    ['PNG', 'image/png', Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)],
    ['JPEG', 'image/jpeg', Uint8Array.of(0xff, 0xd8, 0xff, 0xe0)],
    ['GIF87a', 'image/gif', new TextEncoder().encode('GIF87a')],
    ['GIF89a', 'image/gif', new TextEncoder().encode('GIF89a')],
    ['WebP', 'image/webp', new TextEncoder().encode('RIFF\u0004\u0000\u0000\u0000WEBP')],
    ['AVIF', 'image/avif', Uint8Array.of(
      0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
      0x61, 0x76, 0x69, 0x66, 0x00, 0x00, 0x00, 0x00,
      0x6d, 0x69, 0x66, 0x31, 0x61, 0x76, 0x69, 0x66
    )],
    ['SVG', 'image/svg+xml', '<?xml version="1.0"?>\n<!-- safe -->\n<svg xmlns="http://www.w3.org/2000/svg"></svg>']
  ])('accepts representative %s content only under its matching MIME', async (_label, contentType, body) => {
    const fetched = await fetchDocumentMedia('https://cdn.example.com/image', {
      fetch: vi.fn<typeof fetch>(async () => mediaResponse(body, contentType)),
      resolveHostname: publicResolver
    })
    expect(fetched.contentType).toBe(contentType)
  })

  it('rejects HTML disguised as SVG even when it contains a nested svg element', async () => {
    await expect(fetchDocumentMedia('https://cdn.example.com/fake.svg', {
      fetch: vi.fn<typeof fetch>(async () => mediaResponse('<html><body><svg></svg></body></html>', 'image/svg+xml')),
      resolveHostname: publicResolver
    })).rejects.toMatchObject({
      code: 'unsupported-content-type',
      message: expect.stringContaining('检测为 unknown')
    })
  })

  it('rejects valid image bytes declared with the wrong supported MIME', async () => {
    await expect(fetchDocumentMedia('https://cdn.example.com/wrong.jpg', {
      fetch: vi.fn<typeof fetch>(async () => mediaResponse(
        Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
        'image/jpeg'
      )),
      resolveHostname: publicResolver
    })).rejects.toMatchObject({
      code: 'unsupported-content-type',
      message: expect.stringContaining('声明 image/jpeg，检测为 image/png')
    })
  })
})
