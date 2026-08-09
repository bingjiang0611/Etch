# Etch 网页翻译工作流 · 设计合同

状态：高保真设计稿，未进入正式实现。

## 产品决策

Etch 只增加一个顶层任务类型：`网页翻译`。普通网页与 X/Twitter 不拆成两个任务类型；用户粘贴 URL 后由系统自动路由：

- 普通网页 → 通用网页解析。
- `x.com` / `twitter.com` 的 status URL → X 专用解析。

两条链路最终都产出原始 Markdown、中文 Markdown、媒体资产与完整性验证报告，因此队列、人工校对、导出和恢复逻辑应共用。

V1 的 X 能力只承诺单条帖子与 X Article。现有 `tweet-to-obsidian` 没有定义完整 Thread 遍历、Quote、Poll、Card 或视频归档，不应在产品里提前承诺。

## 核心用户路径

1. 用户在现有「新建任务」弹窗选择「网页翻译」。
2. 用户粘贴一条或多条 URL；Etch 在输入区下方显示自动识别结果，不要求用户选择解析器。
3. 英文文章默认精翻为简体中文；中文内容默认仅转换；用户可覆盖为「仅转换」或「统一翻译」。
4. 任务进入五阶段流水线：抓取 → 正文与媒体 → 翻译 → 人工校对 → 完整性验证。
5. 工作台默认显示清洗后的原文和可编辑中文译文；两栏滚动同步，修改自动保存。
6. 用户确认校对后，Etch 执行最终结构验证；通过后可打开原网页或导出 `.md`。

## 页面与状态

- 新建任务：三种任务类型、URL 自动路由、Provider、处理方式、翻译要求与 X V1 边界。
- 普通网页工作台：原文 / 译文双栏、中文预览、任务信息、结构数量核验。
- X Article 工作台：同一工作台骨架，增加作者、handle、内容类型、互动快照和不支持内容警告。
- 抓取失败：保留 URL、任务记录与失败原因；不生成空白 `source.md` 或伪译稿。

设计稿中的文章、作者和计数均明确标记为「设计稿示例内容」，不代表已存在的 Etch 持久化数据。

## 未来 manifest / artifact 映射

推荐新增 `kind: 'document'`，不要把文档翻译塞进现有 `summary`。建议状态：

```ts
document: {
  sourceMode: 'auto'
  resolvedSource?: 'web' | 'x-post' | 'x-article'
  sourceLanguage?: string
  targetLanguage: 'zh-CN'
  blockCount: number
  translatedBlockCount: number
  warnings: string[]
  reviewCompletedAt?: string
}
```

推荐产物：

```text
sourceDocument       source.md
sourceMetadata       metadata.json
mediaManifest        media.json
translatedDocument   translated.zh-CN.md
translationRecord    translation-record.json
documentVerification verification.json
```

`task.json` 只保存状态、数量、身份与 artifact 指针，不保存整篇正文。

## 完整性门禁

普通网页完成前必须核对标题、段落、列表、表格、链接、引用、代码块、脚注、图片位置和首尾正文；相对 URL、协议相对 URL 与 Next.js 图片代理都不能漏抓。

X 内容完成前必须核对封面与每个正文媒体 block，确保本地文件存在且成品不残留远程 `pbs.twimg.com` 图片。视频、Quote、Poll 等不支持项必须显示警告，不能静默丢弃。

## 实施红线

- 当前 schema migration 会把所有非 `summary` 的未知类型当成 `subtitle`；新增 `document` 必须升级 schemaVersion 并补迁移。
- 文档任务不能进入视频 `VideoPreview`、SRT、压制、术语同步或 B站投稿分支。
- 网页正文是外部不可信输入；Provider 调用继续保持 text-only、无工具、空 MCP，并复用 prompt boundary。
- 抓取必须防 SSRF、重定向绕过、内网地址、超大响应、错误 content type 与压缩炸弹。
- 不把 Obsidian CLI、vault 路径、wikilink 或 wiki compiler 引入 Etch；只复用两个 skill 的行为合同。
