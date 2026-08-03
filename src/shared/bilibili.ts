import { z } from 'zod'

const UnicodeLimitedText = (maximum: number, label: string) => z.string().trim().refine(
  (value) => Array.from(value).length <= maximum,
  `${label}不能超过 ${maximum} 个字符`
)

export const BilibiliCopyrightSchema = z.enum(['original', 'repost'])
export type BilibiliCopyright = z.infer<typeof BilibiliCopyrightSchema>

export const BilibiliPublicationStatusSchema = z.enum([
  'idle',
  'waiting_config',
  'queued',
  'uploading',
  'submitting',
  'submitted',
  'paused',
  'failed',
  'unknown'
])
export type BilibiliPublicationStatus = z.infer<typeof BilibiliPublicationStatusSchema>

export const BilibiliPublicationDraftSchema = z.object({
  title: UnicodeLimitedText(80, '标题').min(1, '标题不能为空'),
  tid: z.number().int().positive(),
  partitionName: z.string().trim().max(100).default(''),
  tags: z.array(UnicodeLimitedText(20, '单个标签').min(1)).min(1, '至少需要一个标签').max(10),
  description: UnicodeLimitedText(2_000, '简介').default(''),
  copyright: BilibiliCopyrightSchema,
  source: UnicodeLimitedText(2_000, '转载来源').default(''),
  coverRelativePath: z.string().min(1).optional(),
  finalSha256: z.string().regex(/^[a-f0-9]{64}$/u)
}).superRefine((value, context) => {
  if (value.copyright === 'repost' && !value.source.trim()) {
    context.addIssue({ code: 'custom', path: ['source'], message: '转载稿件必须填写来源' })
  }
})
export type BilibiliPublicationDraft = z.infer<typeof BilibiliPublicationDraftSchema>

export const BilibiliPublicationSchema = z.object({
  autoPublish: z.boolean().default(false),
  status: BilibiliPublicationStatusSchema.default('idle'),
  attempt: z.number().int().nonnegative().default(0),
  draft: BilibiliPublicationDraftSchema.optional(),
  phaseMessage: z.string().max(300).optional(),
  lastError: z.object({
    code: z.string().min(1).max(100),
    message: z.string().min(1).max(500),
    retryable: z.boolean()
  }).optional(),
  receipt: z.object({
    aid: z.string().regex(/^\d+$/u).optional(),
    bvid: z.string().regex(/^BV[0-9A-Za-z]+$/u).optional(),
    resourceId: z.string().min(1).max(200).optional()
  }).optional(),
  updatedAt: z.string().datetime({ offset: true }).optional(),
  submittedAt: z.string().datetime({ offset: true }).optional()
}).default({ autoPublish: false, status: 'idle', attempt: 0 })
export type BilibiliPublication = z.infer<typeof BilibiliPublicationSchema>

export const BilibiliPublishTemplateSchema = z.object({
  tid: z.number().int().positive().optional(),
  partitionName: z.string().trim().max(100).default(''),
  tags: z.array(UnicodeLimitedText(20, '单个标签').min(1)).max(10).default([]),
  descriptionTemplate: UnicodeLimitedText(2_000, '简介模板').default('{title}\n\n来源：{source_url}')
}).default({ partitionName: '', tags: [], descriptionTemplate: '{title}\n\n来源：{source_url}' })
export type BilibiliPublishTemplate = z.infer<typeof BilibiliPublishTemplateSchema>

export const BilibiliAccountSchema = z.object({
  status: z.enum(['disconnected', 'connected', 'expired']),
  mid: z.string().regex(/^\d+$/u).optional(),
  name: z.string().max(200).optional(),
  avatarDataUrl: z.string().startsWith('data:image/').max(1_500_000).optional(),
  connectedAt: z.string().datetime({ offset: true }).optional(),
  message: z.string().max(300).optional()
})
export type BilibiliAccount = z.infer<typeof BilibiliAccountSchema>

export const BilibiliPartitionSchema = z.object({
  tid: z.number().int().positive(),
  name: z.string().trim().min(1).max(100),
  parentName: z.string().trim().max(100).default('')
})
export type BilibiliPartition = z.infer<typeof BilibiliPartitionSchema>

export const BilibiliQrStateSchema = z.object({
  sessionId: z.string().uuid(),
  status: z.enum(['waiting', 'scanned', 'expired', 'complete', 'failed']),
  qrDataUrl: z.string().startsWith('data:image/png;base64,').optional(),
  expiresAt: z.string().datetime({ offset: true }),
  account: BilibiliAccountSchema.optional(),
  message: z.string().max(300).optional()
})
export type BilibiliQrState = z.infer<typeof BilibiliQrStateSchema>

export function publicationTemplateReady(template: BilibiliPublishTemplate): boolean {
  return Boolean(template.tid && template.tags.length)
}

export function renderBilibiliDescription(template: string, title: string, sourceUrl: string): string {
  return Array.from(template.replaceAll('{title}', title).replaceAll('{source_url}', sourceUrl).trim()).slice(0, 2_000).join('')
}

export function truncateBilibiliTitle(title: string): string {
  const characters = Array.from(title.trim())
  return characters.length <= 80 ? characters.join('') : `${characters.slice(0, 79).join('')}…`
}
