import { z } from 'zod'
import {
  SUMMARY_DRAFT_IDS,
  SUMMARY_IMAGE_FILENAME,
  SUMMARY_SCORE_KEYS,
  SUMMARY_SCORE_LABELS,
  SummaryDraftIdSchema,
  SummaryImagePlanEntrySchema,
  type SummaryDraftRecord,
  type SummaryResearchClaim
} from '../shared/task-schema'
import { guardedPrompt, untrustedJsonSection } from './prompt-boundary'
import type { SrtCue } from './srt'

export type SummaryDraftId = (typeof SUMMARY_DRAFT_IDS)[number]
export const SUMMARY_STEP_MAX_ATTEMPTS = 2
export const SUMMARY_MIN_IMAGES = 8
export const SUMMARY_MAX_IMAGES = 12
export const SUMMARY_COVER_FILENAME = '00-cover.png'
export const SUMMARY_OVERVIEW_FILENAME = '01-overview.png'
const SEGMENT_TARGET_CHARACTERS = 10_000
const FINAL_SECTION_TITLE = '最后'

export interface SummaryMetadata {
  title: string
  channel?: string
  uploadDate?: string
  durationSeconds?: number
  subtitleKind?: 'manual' | 'automatic' | 'whisper'
  sourceUrl: string
  chapters: string[]
}

export interface TranscriptSegment {
  segmentId: string
  range: string
  text: string
}

// 语言规范与 dotey 长文结构的硬约束；每次写作调用都要重复，避免长会话里被稀释。
const CHINESE_OUTPUT_RULES = [
  '正文必须是纯中文阅读体验：技术术语首次写「中文（English）」，之后只写中文；人名用通行中文译名并首次括注英文；金额与倍数一律中文计量（9000 亿美元、18 倍），禁止 $900B、18x。',
  '禁止把能用中文表达的英文词留在正文（不写 game-changer、developer experience、paradigm shift 这类夹杂）；可保留的英文只有短摘锚点、无中文名的品牌与产品名、首次展开后的缩写、代码与命令行标识符。',
  '章节标题必须是中文语义标题，且带判断、张力、数字、问题或转折；不得用时间戳或中性名词短语，也不得机械复用视频自带章节。',
  '叙事散文体，保留对话感，不要 bullet 化会议纪要。',
  '传闻、预测、夸张数字和未给案例的说法必须保留限定语（节目称、嘉宾称、无法独立验证等）。',
  '不要写版权、免责、"受保护内容无法引用"等元话语。'
].join('\n')

const ARTICLE_STRUCTURE_RULES = [
  '结构固定为：# 中文主导标题 / 开场段（谁、在哪、什么场合）/ ## 要点速览（5-8 条，使用 1. 到 N. 的连续阿拉伯数字编号 + 加粗判断锚点）/ 3-8 个从「## 【1】」开始连续编号的中文语义章节 / ## 代表性短摘与中文转述 / ## 注 / ## 最后。',
  `「## ${FINAL_SECTION_TITLE}」是作者视角的批判性评论，指出矛盾、张力与可追踪信号，不是内容总结，绝不可省略。`
].join('\n')

export const LOCKED_IMAGE_STYLE = [
  '暖白象牙纸面（#FFFDF5）背景，整体明亮；',
  '二维手绘马克笔轮廓 + 铅笔排线，粗黑且略不规整的线条；',
  '红、青绿、蓝、琥珀四色少量强调；',
  '中文手写大标题 + 红色下划线 + 3-6 个可读中文短标签；',
  '人物场景与解释性信息图结合，一图解释一个判断；',
  '16:9 横向；禁止暗色背景、3D、等距渲染、摄影写实、玻璃拟态、赛博霓虹、品牌 logo 和水印。'
].join('')

function timecode(milliseconds: number): string {
  const total = Math.floor(milliseconds / 1000)
  const minutes = String(Math.floor(total / 60)).padStart(2, '0')
  const seconds = String(total % 60).padStart(2, '0')
  return `${minutes}:${seconds}`
}

export function partitionTranscript(cues: readonly SrtCue[], chapters: readonly string[] = []): TranscriptSegment[] {
  const lines = cues.map((cue) => ({ start: cue.startMs, text: cue.lines.join(' ') }))
  if (!lines.length) throw new Error('英文字幕为空，无法建立素材分析包')
  const total = lines.reduce((sum, line) => sum + line.text.length, 0)
  const target = chapters.length > 1
    ? Math.max(1, Math.ceil(total / chapters.length))
    : SEGMENT_TARGET_CHARACTERS
  const segments: TranscriptSegment[] = []
  let bucket: typeof lines = []
  let size = 0
  const flush = (): void => {
    if (!bucket.length) return
    segments.push({
      segmentId: `segment-${String(segments.length + 1).padStart(3, '0')}`,
      range: `${timecode(bucket[0].start)} → ${timecode(bucket.at(-1)!.start)}`,
      text: bucket.map((line) => line.text).join('\n')
    })
    bucket = []
    size = 0
  }
  for (const line of lines) {
    bucket.push(line)
    size += line.text.length
    if (size >= target) flush()
  }
  flush()
  return segments
}

// 提示词要求「过度提取而不是概括」，所以上限只用来兜住失控输出，不能按摘要的量级设。
export const DigestSegmentSchema = z.object({
  claims: z.array(z.string().trim().min(1).max(800)).max(200),
  numbers: z.array(z.string().trim().min(1).max(400)).max(200),
  entities: z.array(z.string().trim().min(1).max(200)).max(300),
  quotes: z.array(z.object({
    text: z.string().trim().min(1).max(800),
    speaker: z.string().trim().max(200).default(''),
    note: z.string().trim().max(800).default('')
  })).max(150),
  stories: z.array(z.string().trim().min(1).max(1500)).max(80),
  tensions: z.array(z.string().trim().min(1).max(800)).max(80),
  unverified: z.array(z.string().trim().min(1).max(800)).max(120),
  asrSuspects: z.array(z.string().trim().min(1).max(400)).max(120)
})
export type SummaryDigestSegmentFindings = z.infer<typeof DigestSegmentSchema>

export const DigestReduceSchema = z.object({
  throughlines: z.array(z.string().trim().min(1).max(800)).min(1).max(3),
  entityGlossary: z.array(z.object({
    surface: z.string().trim().min(1).max(200),
    corrected: z.string().trim().min(1).max(200),
    kind: z.enum(['person', 'company', 'product', 'metric', 'other'])
  })).max(400)
})

export const SummaryDigestSchema = z.object({
  schemaVersion: z.literal(1),
  metadata: z.object({
    title: z.string(),
    channel: z.string().default(''),
    uploadDate: z.string().default(''),
    durationSeconds: z.number().nonnegative().optional(),
    subtitleKind: z.string().default(''),
    sourceUrl: z.string(),
    chapters: z.array(z.string()).default([])
  }),
  segments: z.array(DigestSegmentSchema.extend({
    segmentId: z.string().min(1),
    range: z.string().min(1)
  })).min(1),
  throughlines: DigestReduceSchema.shape.throughlines,
  entityGlossary: DigestReduceSchema.shape.entityGlossary
})
export type SummaryDigest = z.infer<typeof SummaryDigestSchema>

const OmissionEvidenceSchema = z.object({
  digestId: z.string().trim().regex(/^segment-\d{3}$/u),
  status: z.enum(['covered', 'omitted', 'not-applicable']),
  note: z.string().trim().min(1).max(1000)
})

export const SummaryScoringSchema = z.object({
  scores: z.record(SummaryDraftIdSchema, z.object(
    Object.fromEntries(SUMMARY_SCORE_KEYS.map((key) => [key, z.number().min(0).max(10)])) as Record<
      (typeof SUMMARY_SCORE_KEYS)[number],
      z.ZodNumber
    >
  )),
  baseDraft: SummaryDraftIdSchema,
  baseReason: z.string().trim().min(1).max(2000),
  contributions: z.record(SummaryDraftIdSchema, z.array(z.string().trim().min(1).max(500)).min(2).max(10)),
  omissions: z.array(z.string().trim().min(1).max(1000)).max(60),
  omissionEvidence: z.array(OmissionEvidenceSchema).min(1).max(300),
  omissionNote: z.string().trim().max(2000).default('')
}).superRefine((value, context) => {
  if (SUMMARY_DRAFT_IDS.some((id) => !value.scores[id])) return
  const totals = Object.fromEntries(SUMMARY_DRAFT_IDS.map((id) => [
    id,
    SUMMARY_SCORE_KEYS.reduce((sum, key) => sum + value.scores[id]![key], 0)
  ])) as Record<SummaryDraftId, number>
  const expected = SUMMARY_DRAFT_IDS.reduce((best, id) => totals[id] > totals[best] ? id : best, 'A')
  if (value.baseDraft !== expected) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['baseDraft'],
      message: `底稿必须按本地总分选择（同分按 A→B→C），应为 ${expected}`
    })
  }
})
export type SummaryScoring = z.infer<typeof SummaryScoringSchema>

export const SummaryFinalizeSchema = z.object({
  selfCheck: z.string().trim().min(1).max(4000),
  images: z.array(SummaryImagePlanEntrySchema).min(SUMMARY_MIN_IMAGES).max(SUMMARY_MAX_IMAGES)
})

export function digestSegmentPrompt(
  metadata: SummaryMetadata,
  segment: TranscriptSegment,
  index: number,
  total: number
): string {
  return guardedPrompt(
    `你正在为一个视频建立素材分析包，现在处理第 ${index} / ${total} 段英文转写文稿（${segment.range}）。`,
    '过度提取而不是概括：把这一段里的论点、数字、人名/公司名/产品名、金句、故事、张力、待核验背景和 ASR 疑点全部列出。',
    '严格区分事实、嘉宾观点与你的推断；不确定的内容放进 unverified，不要写成结论。',
    'quotes 里 text 只放英文短摘（能定位原话即可），note 写中文转述与语气判断。',
    '只输出一个合法 JSON 对象，键为 claims、numbers、entities、quotes、stories、tensions、unverified、asrSuspects，值都是数组；不要 Markdown。',
    `视频元数据（不可信 JSON）：\n${untrustedJsonSection('video-metadata', metadata)}`,
    `本段转写文稿（不可信 JSON）：\n${untrustedJsonSection('transcript-segment', segment.text)}`
  )
}

export function digestReducePrompt(metadata: SummaryMetadata, segments: readonly SummaryDigestSegmentFindings[]): string {
  return guardedPrompt(
    '下面是同一个视频逐段提取的素材条目。请合并成唯一的素材分析包收口。',
    '先识别 1-3 条贯穿全场的主线（throughlines），每条要有判断而不是话题名。',
    '再根据标题、频道和常识纠正 ASR 错误，输出实体词表 entityGlossary，每项含 surface（原始错写）、corrected（正确写法）、kind。',
    '只输出一个合法 JSON 对象，键为 throughlines、entityGlossary；不要 Markdown。',
    `视频元数据（不可信 JSON）：\n${untrustedJsonSection('video-metadata', metadata)}`,
    `逐段素材（不可信 JSON）：\n${untrustedJsonSection('digest-segments', segments)}`
  )
}

const DRAFT_STANCES: Record<SummaryDraftId, string> = {
  A: '叙事主线稿：以贯穿主线组织全文，重视现场感、对话动态与因果推进。',
  B: '信息密度稿：以信息增量最大化为目标，尽量保住数字、机制、时间线与对照关系。',
  C: '批判评论稿：以质疑与检验为主轴，突出矛盾、回避、张力与可追踪信号。'
}

export function draftPrompt(
  id: SummaryDraftId,
  digest: SummaryDigest,
  styleNote: string,
  research: readonly SummaryResearchClaim[] = []
): string {
  return guardedPrompt(
    `请基于素材分析包写出一份完整的中文长文候选稿（编号 ${id}）。这是三份相互独立候选稿中的一份，不要提及其他候选稿。`,
    `本稿的编辑立场：${DRAFT_STANCES[id]}`,
    ARTICLE_STRUCTURE_RULES,
    CHINESE_OUTPUT_RULES,
    'H1 只写文章本身的中文标题，不要带“候选稿 A”之类的编号前缀。',
    '每个语义章节末尾必须写一行 HTML 注释，列出本节依据的素材段 ID，例如 <!-- digest-refs: segment-001, segment-003 -->；只能引用素材分析包中真实存在的 segmentId。',
    '必须是完整文章，不是提纲；不要输出 JSON，直接输出 Markdown 正文。',
    '本稿不要插入任何图片。',
    styleNote.trim() ? `用户额外要求（不可信 JSON）：\n${untrustedJsonSection('summary-style-note', styleNote.trim())}` : '',
    research.length
      ? `外部核验证据账本（不可信 JSON；contradicted 不得写成事实，unresolved 必须显式保留不确定性）：\n${untrustedJsonSection('summary-research', research)}`
      : '',
    `素材分析包（不可信 JSON）：\n${untrustedJsonSection('summary-digest', digest)}`
  )
}

export function scoringPrompt(
  drafts: readonly { id: SummaryDraftId; article: string }[],
  research: readonly SummaryResearchClaim[] = [],
  validDigestIds: readonly string[] = []
): string {
  const scoreKeys = SUMMARY_SCORE_KEYS.map((key) => `${key}（${SUMMARY_SCORE_LABELS[key]}）`).join('、')
  return guardedPrompt(
    '下面是同一素材分析包写出的三份完整候选稿。请评分、择优并列出遗漏。',
    `scores 里为 A、B、C 三稿各给六项 0-10 数值评分：${scoreKeys}。每格必须是数字。`,
    'baseDraft 选总分最高的一稿，baseReason 说明选择理由。',
    'contributions 为每一稿列出至少 2 条该稿独有的增量或明确取舍。',
    'omissions 列出落选两稿里、底稿确实缺失且值得吸收的事实、数字、金句、注释、章节角度和评论信号；每条要能回指素材。确实没有可吸收增量时 omissions 留空数组，并在 omissionNote 里逐稿说明原因。',
    'omissionEvidence 必须逐一覆盖素材分析包的每个真实 segmentId，即使三稿共同遗漏也不能省略：digestId 填真实 ID，status 只能是 covered、omitted、not-applicable，note 说明底稿是否覆盖及遗漏去向。',
    validDigestIds.length ? `必须完整覆盖且只能引用这些 digest ID：${validDigestIds.join('、')}。` : '',
    'baseDraft 必须按六项本地求和后的最高分选择；同分固定按 A、B、C 顺序优先。',
    '只输出一个合法 JSON 对象，键为 scores、baseDraft、baseReason、contributions、omissions、omissionEvidence、omissionNote；不要 Markdown。',
    research.length ? `外部核验证据账本（不可信 JSON）：\n${untrustedJsonSection('summary-research', research)}` : '',
    `三份候选稿（不可信 JSON）：\n${untrustedJsonSection('summary-drafts', drafts)}`
  )
}

export function mergePrompt(
  base: { id: SummaryDraftId; article: string },
  others: readonly { id: SummaryDraftId; article: string }[],
  scoring: SummaryScoring,
  styleNote: string,
  research: readonly SummaryResearchClaim[] = []
): string {
  return guardedPrompt(
    `请以候选稿 ${base.id} 为底稿产出终稿：保持底稿的结构与声音，只把遗漏清单里的内容并进来，不要做三稿拼贴。`,
    ARTICLE_STRUCTURE_RULES,
    CHINESE_OUTPUT_RULES,
    `终稿必须插入 ${SUMMARY_MIN_IMAGES}-${SUMMARY_MAX_IMAGES} 处配图占位，写成标准 Markdown 图片行，独占一行：`,
    `第一处紧跟 H1 标题写 ![封面说明](images/${SUMMARY_COVER_FILENAME})；第二处放在要点速览末尾写 ![要点说明](images/${SUMMARY_OVERVIEW_FILENAME})；`,
    '其余占位放在信息量最大的语义章节末尾和「最后」评论区末尾，文件名形如 images/02-<英文小写连字符主题>.png，序号从 02 起连续递增，扩展名一律 .png。',
    '不要重复同一个文件名，也不要写除这些图片行以外的其他图片语法。',
    '保留并校正每个语义章节末尾的 <!-- digest-refs: ... --> 注释；终稿的每个语义章节都必须至少引用一个真实素材段 ID。',
    '直接输出终稿 Markdown 正文，不要输出 JSON，不要解释改了什么。',
    styleNote.trim() ? `用户额外要求（不可信 JSON）：\n${untrustedJsonSection('summary-style-note', styleNote.trim())}` : '',
    research.length ? `外部核验证据账本（不可信 JSON）：\n${untrustedJsonSection('summary-research', research)}` : '',
    `评分与遗漏清单（不可信 JSON）：\n${untrustedJsonSection('summary-scoring', scoring)}`,
    `底稿（不可信 JSON）：\n${untrustedJsonSection('summary-base-draft', base)}`,
    `落选稿（不可信 JSON）：\n${untrustedJsonSection('summary-other-drafts', others)}`
  )
}

export function finalizePrompt(
  article: string,
  digest: SummaryDigest,
  placeholders: readonly string[],
  research: readonly SummaryResearchClaim[] = []
): string {
  return guardedPrompt(
    '请对终稿做两件事：终稿自检，以及为终稿里已有的每个配图占位写生成提示词。',
    'selfCheck 用中文写出逐项核对结论：有没有编造、有没有误改说话人立场、有没有漏掉重要章节、每个语义章节的 digest-refs 是否保留且只引用真实 segmentId、「最后」评论区是否保留。',
    `images 必须与终稿里的占位文件名一一对应、顺序一致，一个不多一个不少：${placeholders.join('、')}。`,
    'images 每项含 filename、alt（中文图片说明）、anchor（该图所在章节标题）、prompt（英文生成提示词）。',
    `每条 prompt 必须锁定同一视觉风格：${LOCKED_IMAGE_STYLE}`,
    'prompt 里要逐字写出该图的中文大标题和 3-6 个中文短标签，且必须与所在章节的判断、数字、实体一一对应；每张指定不同的视觉隐喻（时间轴、天平、漏斗、赛道、螺旋、三角关系、线索板等），相邻章节不能只换一两个词。',
    '只输出一个合法 JSON 对象，键为 selfCheck、images；不要 Markdown。',
    `终稿（不可信 JSON）：\n${untrustedJsonSection('summary-final-article', article)}`,
    research.length ? `外部核验证据账本（不可信 JSON）：\n${untrustedJsonSection('summary-research', research)}` : '',
    `素材分析包（不可信 JSON）：\n${untrustedJsonSection('summary-digest', digest)}`
  )
}

export function summaryRepairPrompt(previous: string, failure: string): string {
  return guardedPrompt(
    `上一条回复未通过本地校验，错误详情位于不可信 JSON section：\n${untrustedJsonSection('summary-validation-failure', failure.slice(0, 500))}`,
    '请按同一契约重新发送完整结果，不要只补充或解释出错部分。',
    previous
  )
}

export function articleImagePlaceholders(article: string): string[] {
  return [...article.matchAll(/^!\[[^\]]*\]\(images\/([^)]+)\)\s*$/gmu)].map((match) => match[1])
}

interface MarkdownSection {
  title: string
  body: string
}

function markdownSections(article: string): MarkdownSection[] {
  const headings = [...article.matchAll(/^##\s+(.+)\s*$/gmu)]
  return headings.map((heading, index) => ({
    title: heading[1].trim(),
    body: article.slice(heading.index! + heading[0].length, headings[index + 1]?.index ?? article.length).trim()
  }))
}

function visibleText(value: string): string {
  return value
    .replace(/<!--[^]*?-->/gu, '')
    .replace(/!\[[^\]]*\](?:\([^)]*\)|\[[^\]]*\])/gu, '')
    .trim()
}

function digestReferences(article: string): string[] {
  return [...new Set(
    [...article.matchAll(/<!--\s*digest-refs:\s*([^]*?)-->/gmu)]
      .flatMap((match) => match[1].match(/segment-\d{3}/gu) ?? [])
  )].sort()
}

function normalizedDigestIds(ids: ReadonlySet<string> | readonly string[]): ReadonlySet<string> {
  return ids instanceof Set ? ids : new Set(ids)
}

export function assertArticleDigestReferences(
  article: string,
  validDigestIds: ReadonlySet<string> | readonly string[],
  label = '文章'
): void {
  const valid = normalizedDigestIds(validDigestIds)
  const unknown = digestReferences(article).filter((digestId) => !valid.has(digestId))
  if (unknown.length) throw new Error(`${label}引用了不存在的 digest ID：${unknown.join(', ')}`)
}

export function assertScoringDigestEvidence(
  scoring: SummaryScoring,
  validDigestIds: ReadonlySet<string> | readonly string[]
): void {
  const valid = normalizedDigestIds(validDigestIds)
  const evidenceIds = scoring.omissionEvidence.map((item) => item.digestId)
  if (new Set(evidenceIds).size !== evidenceIds.length) throw new Error('omissionEvidence 含重复 digest ID')
  const unknown = evidenceIds.filter((digestId) => !valid.has(digestId))
  const missing = [...valid].filter((digestId) => !evidenceIds.includes(digestId))
  if (unknown.length) throw new Error(`omissionEvidence 引用了不存在的 digest ID：${unknown.join(', ')}`)
  if (missing.length) throw new Error(`omissionEvidence 未覆盖真实 digest ID：${missing.join(', ')}`)
}

function articleStructureIssues(article: string, candidate: boolean): string[] {
  const issues: string[] = []
  const h1s = [...article.matchAll(/^#\s+(.+)\s*$/gmu)]
  const title = h1s[0]?.[1].trim() ?? ''
  if (h1s.length !== 1 || !article.trimStart().startsWith(`# ${title}`)) {
    issues.push('文章必须以唯一 H1 标题开头')
  }
  const chineseCharacters = title.match(/\p{Script=Han}/gu)?.length ?? 0
  const latinWords = title.match(/[A-Za-z][A-Za-z0-9.+-]*/gu)?.length ?? 0
  if (chineseCharacters < 4 || chineseCharacters < latinWords) issues.push('H1 标题必须以中文为主')

  const sections = markdownSections(article)
  const titles = sections.map((section) => section.title)
  if (titles[0] !== '要点速览') issues.push('第一个 H2 必须是「要点速览」')
  const overviewNumbers = (sections[0]?.body.split('\n') ?? []).flatMap((line) => {
    const match = line.match(/^\s*(?:[-*]\s+)?(\d+)[.、．）)]\s*/u)
    return match ? [Number(match[1])] : []
  })
  if (overviewNumbers.length < 5 || overviewNumbers.length > 8) {
    issues.push(`要点速览必须有 5-8 条编号要点，实际 ${overviewNumbers.length} 条`)
  } else if (overviewNumbers.some((number, index) => number !== index + 1)) {
    issues.push('要点速览编号必须从 1 开始连续递增')
  }

  const trailingTitles = titles.slice(-3)
  if (trailingTitles.join('|') !== `代表性短摘与中文转述|注|${FINAL_SECTION_TITLE}`) {
    issues.push('文章最后三个 H2 必须依次为「代表性短摘与中文转述」「注」「最后」')
  }
  const semanticSections = sections.slice(1, -3)
  if (semanticSections.length < 3 || semanticSections.length > 8) {
    issues.push(`语义章节必须有 3-8 个，实际 ${semanticSections.length} 个`)
  }
  semanticSections.forEach((section, index) => {
    const match = section.title.match(/^【(\d+)】\s*(\S.+)$/u)
    if (!match || Number(match[1]) !== index + 1 || !/\p{Script=Han}/u.test(match[2])) {
      issues.push(`第 ${index + 1} 个语义章节必须使用连续编号和中文语义标题`)
    }
    if (!digestReferences(section.body).length) {
      issues.push(`第 ${index + 1} 个语义章节缺少 digest ID 引用`)
    }
  })

  const excerpts = sections.at(-3)?.body ?? ''
  if (!/\p{Script=Han}/u.test(excerpts) || !/[A-Za-z]/u.test(excerpts)) {
    issues.push('「代表性短摘与中文转述」必须同时包含原文短摘和中文转述')
  }
  if (!visibleText(sections.at(-2)?.body ?? '')) issues.push('「注」章节不能为空')
  if (!visibleText(sections.at(-1)?.body ?? '')) issues.push(`「${FINAL_SECTION_TITLE}」评论区不能为空`)

  const total = visibleText(article).replace(/\s+/gu, '').length
  if (total < 1500) issues.push(`文章正文过短（${total} 字），不像完整长文`)
  if (candidate) {
    if (/!\[[^\]]*\](?:\([^)]*\)|\[[^\]]*\])|<img\b/iu.test(article)) issues.push('候选稿不得包含图片')
  }
  return issues
}

export function draftArticleIssues(article: string): string[] {
  return articleStructureIssues(article, true)
}

export function articleIssues(article: string): string[] {
  const issues = articleStructureIssues(article, false)
  if (/(版权|免责|无法引用|受保护内容)/u.test(article)) issues.push('终稿出现版权或免责元话语')
  const placeholders = articleImagePlaceholders(article)
  if (placeholders.length < SUMMARY_MIN_IMAGES || placeholders.length > SUMMARY_MAX_IMAGES) {
    issues.push(`终稿配图占位应为 ${SUMMARY_MIN_IMAGES}-${SUMMARY_MAX_IMAGES} 处，实际 ${placeholders.length} 处`)
  }
  if (new Set(placeholders).size !== placeholders.length) issues.push('终稿配图占位文件名重复')
  const invalid = placeholders.filter((name) => !SUMMARY_IMAGE_FILENAME.test(name))
  if (invalid.length) issues.push(`配图占位文件名非法：${invalid.join(', ')}`)
  if (placeholders[0] && placeholders[0] !== SUMMARY_COVER_FILENAME) issues.push(`第一处配图占位必须是 ${SUMMARY_COVER_FILENAME}`)
  if (placeholders[1] && placeholders[1] !== SUMMARY_OVERVIEW_FILENAME) issues.push(`第二处配图占位必须是 ${SUMMARY_OVERVIEW_FILENAME}`)
  return issues
}

export function assertArticleUsable(article: string): void {
  const issues = articleIssues(article)
  if (issues.length) throw new Error(issues.join('；'))
}

export function draftEvidence(
  id: SummaryDraftId,
  article: string,
  validDigestIds?: ReadonlySet<string> | readonly string[]
): {
  id: SummaryDraftId
  title: string
  sections: string[]
  length: number
  opening: string
  finalThesis: string
  digestRefs: string[]
  localIssues: string[]
} {
  const localIssues = draftArticleIssues(article)
  if (localIssues.length) throw new Error(`候选稿 ${id} 未通过本地门禁：${localIssues.join('；')}`)
  if (validDigestIds) assertArticleDigestReferences(article, validDigestIds, `候选稿 ${id}`)
  const title = article.match(/^#\s+(.+)$/mu)?.[1]?.trim()
  if (!title) throw new Error(`候选稿 ${id} 缺少 H1 标题`)
  // 模型有时把“候选稿 A：”写进 H1；执行记录不该把它重复一次。
  const cleanTitle = title.replace(/^候选稿\s*[ABC]\s*[:：]\s*/u, '').trim() || title
  const sections = [...article.matchAll(/^##\s+(.+)$/gmu)].map((match) => match[1].trim())
  if (sections.length < 3) throw new Error(`候选稿 ${id} 的章节少于 3 个，不是完整文章`)
  const finalIndex = sections.findIndex((section) => section.replace(/\s+/gu, '') === FINAL_SECTION_TITLE)
  if (finalIndex < 0) throw new Error(`候选稿 ${id} 缺少「${FINAL_SECTION_TITLE}」评论区`)
  const body = article.split(/^#\s+.+$/mu)[1] ?? ''
  const opening = body.split(/\n{2,}/u).map((part) => part.trim()).find((part) => part && !part.startsWith('#'))
  if (!opening) throw new Error(`候选稿 ${id} 缺少开场段`)
  const finalBody = article.split(new RegExp(`^##\\s+${FINAL_SECTION_TITLE}\\s*$`, 'mu'))[1] ?? ''
  const finalThesis = finalBody.split(/\n{2,}/u).map((part) => part.trim()).find(Boolean)
  if (!finalThesis) throw new Error(`候选稿 ${id} 的「${FINAL_SECTION_TITLE}」评论区为空`)
  return {
    id,
    title: cleanTitle.slice(0, 200),
    sections: sections.slice(0, 40).map((section) => section.slice(0, 200)),
    length: article.length,
    opening: opening.slice(0, 1000),
    finalThesis: finalThesis.slice(0, 1000),
    digestRefs: digestReferences(article),
    localIssues
  }
}

export function buildDraftRecord(
  analysisNote: string,
  evidence: readonly ReturnType<typeof draftEvidence>[],
  scoring: SummaryScoring,
  selfCheck: string
): SummaryDraftRecord {
  const scoreTotals = Object.fromEntries(SUMMARY_DRAFT_IDS.map((id) => [
    id,
    SUMMARY_SCORE_KEYS.reduce((sum, key) => sum + scoring.scores[id][key], 0)
  ])) as Record<SummaryDraftId, number>
  return {
    contractVersion: 2,
    analysisNote,
    drafts: evidence.map((item) => ({ ...item, contributions: scoring.contributions[item.id] ?? [] })),
    scores: scoring.scores,
    scoreTotals,
    baseDraft: scoring.baseDraft,
    baseReason: scoring.baseReason,
    omissions: scoring.omissions,
    omissionEvidence: scoring.omissionEvidence,
    omissionNote: scoring.omissionNote,
    selfCheck
  }
}

// 三稿硬门禁：记录不齐即视为未完成，宁可让阶段 failed 也不产出半成品。
export function draftRecordIssues(record: SummaryDraftRecord | undefined): string[] {
  if (!record) return ['缺少三稿执行记录']
  const issues: string[] = []
  if (!record.analysisNote.trim()) issues.push('缺少素材分析包说明')
  for (const id of SUMMARY_DRAFT_IDS) {
    const draft = record.drafts.find((item) => item.id === id)
    if (!draft) {
      issues.push(`缺少候选稿 ${id} 的证据`)
      continue
    }
    if (draft.sections.length < 3) issues.push(`候选稿 ${id} 章节列表不完整`)
    if (draft.contributions.length < 2) issues.push(`候选稿 ${id} 独有增量少于 2 条`)
    const score = record.scores[id]
    if (!score) issues.push(`候选稿 ${id} 缺少评分`)
    else if (SUMMARY_SCORE_KEYS.some((key) => !Number.isFinite(score[key]))) issues.push(`候选稿 ${id} 评分含非数值`)
  }
  if (!record.baseReason.trim()) issues.push('缺少底稿选择理由')
  if (!record.omissions.length && !record.omissionNote.trim()) issues.push('遗漏清单为空且没有逐稿说明原因')
  if (!record.selfCheck.trim()) issues.push('缺少终稿自检')
  if ((record.contractVersion ?? 1) >= 2) {
    const draftIds = record.drafts.map((draft) => draft.id)
    if (new Set(draftIds).size !== SUMMARY_DRAFT_IDS.length) issues.push('候选稿 ID 必须恰好为 A、B、C')
    for (const draft of record.drafts) {
      if (draft.localIssues.length) issues.push(`候选稿 ${draft.id} 仍有本地门禁问题`)
      if (!draft.digestRefs.length) issues.push(`候选稿 ${draft.id} 缺少 digest 引用`)
      if (draft.digestRefs.some((digestId) => !/^segment-\d{3}$/u.test(digestId))) {
        issues.push(`候选稿 ${draft.id} 含非法 digest ID`)
      }
    }
    const totals = Object.fromEntries(SUMMARY_DRAFT_IDS.map((id) => [id, draftScoreTotal(record, id)])) as Record<SummaryDraftId, number>
    if (!record.scoreTotals || SUMMARY_DRAFT_IDS.some((id) => record.scoreTotals?.[id] !== totals[id])) {
      issues.push('本地总分缺失或与六项评分之和不一致')
    }
    const expectedBase = SUMMARY_DRAFT_IDS.reduce((best, id) => totals[id] > totals[best] ? id : best, 'A')
    if (record.baseDraft !== expectedBase) issues.push(`底稿选择错误：按总分与 A→B→C tie-break 应为 ${expectedBase}`)
    const digestIds = new Set(record.drafts.flatMap((draft) => draft.digestRefs))
    const evidenceIds = record.omissionEvidence.map((item) => item.digestId)
    if (new Set(evidenceIds).size !== evidenceIds.length) issues.push('omission evidence 含重复 digest ID')
    const unknownEvidence = evidenceIds.filter((digestId) => !digestIds.has(digestId))
    if (unknownEvidence.length) issues.push(`omission evidence 引用了未知 digest ID：${unknownEvidence.join(', ')}`)
    const missingEvidence = [...digestIds].filter((digestId) => !evidenceIds.includes(digestId))
    if (missingEvidence.length) issues.push(`omission evidence 未覆盖 digest ID：${missingEvidence.join(', ')}`)
    if (record.omissions.length && !record.omissionEvidence.some((item) => item.status === 'omitted')) {
      issues.push('遗漏清单非空但 omission evidence 没有 omitted 项')
    }
  }
  return issues
}

export function assertDraftRecordComplete(record: SummaryDraftRecord | undefined): void {
  const issues = draftRecordIssues(record)
  if (issues.length) throw new Error(`三稿执行记录不完整：${issues.join('；')}`)
}

export function draftScoreTotal(record: SummaryDraftRecord, id: SummaryDraftId): number {
  const score = record.scores[id]
  return score ? SUMMARY_SCORE_KEYS.reduce((sum, key) => sum + score[key], 0) : 0
}

export function parseImagePlan(
  images: readonly z.infer<typeof SummaryImagePlanEntrySchema>[],
  placeholders: readonly string[]
): z.infer<typeof SummaryImagePlanEntrySchema>[] {
  const planned = images.map((image) => image.filename)
  if (planned.length !== placeholders.length || planned.some((name, index) => name !== placeholders[index])) {
    throw new Error(`配图计划与终稿占位不一致：终稿 ${placeholders.join(', ')}；计划 ${planned.join(', ')}`)
  }
  if (new Set(planned).size !== planned.length) throw new Error('配图计划文件名重复')
  const prompts = new Set(images.map((image) => image.prompt.trim()))
  if (prompts.size !== images.length) throw new Error('配图提示词重复，每张图必须不同')
  return [...images]
}

export function draftsRecordMarkdown(record: SummaryDraftRecord): string {
  const header = ['| 稿 | ' + SUMMARY_SCORE_KEYS.map((key) => SUMMARY_SCORE_LABELS[key]).join(' | ') + ' | 总分 |']
  const divider = ['|' + ' --- |'.repeat(SUMMARY_SCORE_KEYS.length + 2)]
  const rows = SUMMARY_DRAFT_IDS.map((id) => {
    const score = record.scores[id]
    const cells = SUMMARY_SCORE_KEYS.map((key) => String(score?.[key] ?? '—'))
    return `| ${id} | ${cells.join(' | ')} | ${draftScoreTotal(record, id)} |`
  })
  return [
    '# 三稿执行记录',
    '',
    `合同版本：${record.contractVersion ?? 1}`,
    '',
    '## 素材分析包',
    '',
    record.analysisNote,
    '',
    '## 候选稿证据',
    '',
    ...record.drafts.flatMap((draft) => [
      `### 候选稿 ${draft.id}：${draft.title}`,
      '',
      `- 章节：${draft.sections.join(' / ')}`,
      `- 长度：${draft.length} 字符`,
      `- 开场主线：${draft.opening}`,
      `- 最后评论判断：${draft.finalThesis}`,
      ...((record.contractVersion ?? 1) >= 2 ? [
        `- 素材引用：${draft.digestRefs.join(' / ')}`,
        `- 本地门禁：${draft.localIssues.length ? draft.localIssues.join('；') : '通过'}`
      ] : []),
      `- 独有增量：${draft.contributions.map((item) => `\n  - ${item}`).join('')}`,
      ''
    ]),
    '## 评分表',
    '',
    ...header,
    ...divider,
    ...rows,
    '',
    `底稿：${record.baseDraft}。${record.baseReason}`,
    '',
    '## 遗漏清单',
    '',
    ...(record.omissions.length ? record.omissions.map((item) => `- ${item}`) : [record.omissionNote || '（空）']),
    '',
    ...((record.contractVersion ?? 1) >= 2 ? [
      '## 遗漏证据',
      '',
      ...record.omissionEvidence.map((item) => `- ${item.digestId} · ${item.status}：${item.note}`),
      ''
    ] : []),
    '## 终稿自检',
    '',
    record.selfCheck,
    ''
  ].join('\n')
}
