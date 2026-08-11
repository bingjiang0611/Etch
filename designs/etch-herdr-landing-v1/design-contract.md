# Etch 官网 V2 原型 · 设计合同

状态：高保真可点原型，未进入正式实现，未部署。
交付位置：`designs/etch-herdr-landing-v1/`
预览：`python3 -m http.server 4313 --directory designs` → <http://localhost:4313/etch-herdr-landing-v1/index.html>

V2 校准方式：2026-08-11 实际打开 `/Applications/Etch.app` v0.2.18，逐屏核对了新建任务弹窗、任务队列、网页翻译工作台和双语字幕工作台；原型不再引用任何 App 页面截图。

本文件记录三件事：**哪些是假设**、**每个字段映射到哪段真实源码**、**从 herdr.dev 借了什么又没借什么**。

---

## 1. 产品定位与首屏主张

首屏说明 Etch 是**跑在用户自己 Mac 上的本地视频与网页内容工作站**。

这里的「本地」= 应用与媒体处理都在本机执行，**不等于支持本地文件导入**。
`etch/CLAUDE.md` 明确写了「本地视频导入是 planned 能力，不属于现行 URL-only L3 合同」，
所以首屏 release-note 原样保留官网那句 `仅支持 HTTP(S) URL · 暂不支持本地文件导入`，
并且原型的新建/导入入口一个都没有画。

- 唯一主 CTA：下载公开版 v0.2.18（DMG），全页出现 3 次（nav / hero / 底部 CTA），指向同一个 URL。
- 次 CTA：查看 GitHub 源码。
- 没有第三个竞争性按钮，没有邮件订阅、没有价格、没有 newsletter。

## 2. 假设清单

| # | 假设 | 依据 / 风险 |
|---|---|---|
| A1 | 当前公开版是 **v0.2.18** | `package.json` version = `0.2.18`，且 `website/index.html` 的 CTA、JSON-LD、标题都是 0.2.18。注意 git tag 最新只到 `v0.2.14`，**下载链接的可用性以官网现有链接为准，本原型只是原样沿用，未做可达性验证**。 |
| A2 | 落地页正文沿用官网现有文案 | 用户要求「保留官网真实信息和 CTA」。三类任务、B站三条事实、运行环境四行、当前边界，均逐字沿用 `website/index.html`；“为什么能恢复”整段按后续反馈删除。 |
| A3 | 原型里的任务标题、URL、cue 正文、长文段落、术语表是**示例数据** | 页面上以「这是原型，不是真实 App」+「正文是标注过的示例数据」显式标注；`示例任务 ·` 前缀、`EXAMPLE-ID`、`example.com` 都是可辨识占位符。 |
| A4 | 示例 cue 主题选「注意力头」 | 不是凭空编的：`src/renderer/ui.tsx` 的 `PresetDemo` 组件内置的演示 cue 就是 `attention head / 注意力头`。示例句子不署名任何讲者。 |
| A5 | 落地页叙述文本用 SF Pro 栈，App 区域用 Menlo 栈 | 真实 App 现在整体等宽（`app.css --font-nib: Menlo, "PingFang SC", monospace`），官网正文用 `-apple-system / SF Pro Text / PingFang SC`。两者都是真实来源，原型按「App 区 = App 字体，叙述区 = 官网字体」分工。**未使用 Inter。** |
| A6 | 三类任务各停在一个不同的真实状态 | 字幕停在 `review` checkpoint、总结停在 `illustrate` checkpoint、文档停在 `review` checkpoint；文档完成校对后才进入完整性验证与 HTML 四方向预览。三者都是 schema 允许的合法状态组合。 |

### 明确没有做的事（禁编造清单）

- **没有 speaker / 说话人**字段——`task.json` 没有这个持久化数据。
- **没有 Token 用量**——真实 `WorkbenchView.tsx` 的 `<dt>Token</dt>` 恒为 `—`，没有真实数据，原型直接不渲染该行（已被自动化断言覆盖）。
- **没有 source/final 媒体切换、没有本地文件导入、没有托盘**——`CLAUDE.md` 列为未实现或 planned。
- **没有编造 AI 能力**：不写「AI 自动配音」「一键成片」「智能纠错」之类；配图、外部核验都按真实白名单与 checkpoint 语义描述。
- **没有编造指标**：不放「10 万用户」「节省 90% 时间」这类 data slop（这也是刻意不借 herdr 首屏 metrics 的原因）。
- **没有承诺公证**：release-note 保留「Apple Development 签名，未经公证」。

---

## 3. 真实字段映射

原型里每一个枚举值、阶段名、状态名、并发池、评分维度、风格方向都能指回源码。
`prototype.js` 顶部按来源分块注释，下表是完整对照。

### 3.1 任务类型

| 原型显示 | 真实值 | 来源 |
|---|---|---|
| 双语硬字幕 | `kind: 'subtitle'` | `src/shared/task-schema.ts` `TaskKindSchema`；`ui.tsx` `taskKindLabel` |
| 视频总结 | `kind: 'summary'` | 同上 |
| 网页翻译 | `kind: 'document'` | 同上 |

### 3.2 阶段序列（阶段数是算出来的，不是编的）

`STAGE_IDS` 共 14 个；`stageBelongsToKind()` 决定某类型跑哪些，其余在创建时就写成 `skipped`。

| 类型 | 阶段 | 数量 |
|---|---|---|
| subtitle | `source inspect english cues` + `translate audit review srt burn verify` | **10**（对应官网「十阶段流水线」） |
| summary | `source inspect english cues` + `digest research summary illustrate` | **8** |
| document | `source inspect translate review verify` | **5** |

来源：`task-schema.ts` 的 `STAGE_IDS` / `SHARED_STAGE_IDS` / `SUBTITLE_ONLY_STAGES` / `SUMMARY_ONLY_STAGES` / `DOCUMENT_STAGE_IDS`。
原型把共享底稿 4 步与本成果分支分两条轨渲染，对应 `WorkbenchView.tsx` 的 `shared-pipeline` + `output-lanes` 结构；共享轨降为背景脉络，当前成果轨承担主要状态提示，未创建的另一成果收成一行复用操作。

### 3.3 阶段中文名

视频两类用 `ui.tsx` `stageLabels`：
`source 抓取 · inspect 探测 · english 英文字幕 · cues 英文清理与审计 · translate 翻译 · audit 术语审计 · review 人工校对 · srt 生成 SRT · burn 压制 · verify 验证 · digest 素材分析 · research 外部核验 · summary 长文整理 · illustrate 配图`

文档用 `DocumentWorkbench.tsx` `DOCUMENT_STAGES`：
`source 抓取 · inspect 正文清洗 · translate 文档翻译 · review 文档校对 · verify 完整性验证`

> 注意：`ui.tsx` 另有一份 `documentStageLabels`（`正文与媒体 / 翻译 / 人工校对`）用于队列列表。
> 原型的工作台区域按 `DocumentWorkbench.tsx` 那一份渲染，因为那才是文档工作台真正显示的名字。

### 3.4 阶段状态

`StageStatusSchema` = `pending ready running checkpoint paused failed completed stale skipped`。
原型的 `data-status` 直接用这些原始值，配色沿用 `app.css` 的 `.rail-node[data-status=...]` 规则。

阶段轨下方的小字回落规则也照抄了两处**不同**的真实实现：
- 视频两类：`ui.tsx stageSubLabel` 回落到**原始英文 status**（所以完成态显示 `completed`）。
- 文档：`DocumentWorkbench.tsx` 回落到**中文 `STAGE_STATUS_LABELS`**（显示 `已完成`）。

### 3.5 并发池

`src/shared/pipeline.ts`：`POOL_KINDS = download whisper agent audit ffmpeg image`，
`POOL_BY_STAGE` = `source→download, english→whisper, cues→audit, translate→agent, audit→audit, burn→ffmpeg, digest→agent, research→agent, summary→agent, illustrate→image`（`inspect / review / srt / verify` 不占池）。

原型据此算出每类任务实际用到的池，并用 `ui.tsx poolState` 的优先级（failed → running → checkpoint → 全完成）与 `poolStateLabel`（`已释放 / 运行中 / 失败 / 待确认 / 空闲`）渲染。
字幕任务看不到 `image` 池、总结任务看不到 `ffmpeg` 池——这正是 `WorkbenchView.tsx` 里 `taskPools` 的过滤行为。

### 3.6 Provider 与模型

`ProviderIdSchema` = `claude codex qoder opencode`；`ui.tsx providerNames` = `Claude Code / Codex / Qoder / OpenCode`。
模型显示 `cli-default`，对应 `ModelSelectionSchema` 的 `{ source: 'cli-default' }`。

### 3.7 视频总结的三稿记录

- 三稿 id：`SUMMARY_DRAFT_IDS = ['A','B','C']`，`SummaryDraftRecordSchema.drafts` 强制 `.length(3)`。
- 六项评分维度用 `SUMMARY_SCORE_LABELS`：`事实保真 / 信息完整 / 叙事结构 / 中文可读性 / 对话感 / 最后评论`，取值 0–10（`z.number().min(0).max(10)`），所以满分 60。
- `baseDraft` / `baseReason` / `omissions` 都是 schema 里的真实字段；原型示例取 B 稿为基稿且其总分最高，保持内部一致。
- 长文预览保留「最后」评论区段与 `images/03-attention-heads.png` 占位，符合 `CLAUDE.md`「终稿必须保留『最后』评论区和 8-12 处 `images/NN-slug.png` 配图占位」，文件名也满足 `SUMMARY_IMAGE_FILENAME` 正则 `^\d{2}-[a-z0-9][a-z0-9-]*\.png$`。
- 配图 checkpoint 文案对应 `IllustrationPhaseSchema` 的 `agent-pending`，以及「封面未验收前不得生成其余配图」「图像能力白名单只能来自实测」两条真实约束。

### 3.8 网页翻译

- 内容类型 `普通网页`：`DocumentSourceSchema = web | x-post | x-article`，标签取 `DocumentWorkbench.tsx SOURCE_KIND_LABELS`。
- 处理方式 `自动判断`：`DocumentProcessingModeSchema = auto | convert | translate`，标签取 `PROCESSING_MODE_LABELS`。
- 目标语言 `zh-CN`：`DocumentStateSchema.targetLanguage` 是 `z.literal('zh-CN')`。
- blocks / 标题结构 / 本地媒体 / 完整性验证 / Artifacts / Revision 全部是 `DocumentWorkbench.tsx` 任务信息面板真实存在的行。
- 「发布为网页」四方向 **逐字**取自 `DocumentWorkbench.tsx HTML_DIRECTIONS`，含 `templateId` 与三个 dial 数值：
  `A 杂志长文 article-magazine [72,55,42]` · `B 极简阅读 minimal [38,28,18]` · `C 大胆编辑 editorial [84,63,78]` · `D 冷静工业 dark-industrial [12,74,92]`；
  dial 名称取 `HTML_DIAL_LABELS = 衬线 / 密度 / 对比`。状态文案 `等待选择风格` 对应 `htmlPublication.status = 'checkpoint'`。

### 3.9 工作台骨架与文案

| 原型元素 | 真实来源 |
|---|---|
| `任务队列` 返回、`provider-tag`、`task-source` | `WorkbenchView.tsx` `wb-header` |
| 成果切换 tabs（字幕 ⇄ 总结） | `wb-output-tabs` + `onOpenOutput` |
| `处理流水线` 折叠 + `4 / 4 共享 · 1 / 2 个成果` | `pipeline-collapse` / `pc-mini` |
| `共享底稿 / 两个成果只执行一次` + 当前成果 + 追加成果 | `shared-pipeline` / `output-lanes` / `output-lane-empty` |
| `流水线已暂停在人工校对` + `1 核对术语 / 2 核对译文` | `review-checkpoint-banner`，checkpointId `manual-review` |
| `完成校对并继续` / `等待配图确认` / `处理已完成` | `primaryActionLabel` / `taskActionLabel` |
| `打开原网页` / `导出 Markdown` | `DocumentWorkbench.tsx` `wb-actions` |
| 校对页 `英文原文 / 中文译文 · 简体中文`、`#cueId 时间码`、`Cue N` | `tp-colhead` / `cue-row` |
| 分页 `1–100 / 412` | `REVIEW_PAGE_SIZE = 100` |
| 术语表「统一写法修改先保存在本机草稿…」 | `workbench-glossary-heading`（checkpoint 分支文案） |
| 样式页 `compact 紧凑 / standard 标准 / large 大字` | `SubtitlePresetSchema` + `PresetDemo` |
| B站状态 `未投稿` | `bilibiliPublicationText` 的 `idle` |

### 3.10 视觉 token

颜色**逐字**取自 `src/renderer/styles/app.css` 的深色侧取值（`light-dark()` 的第二个参数）：
`--bg #0b0d10 · --surface #111419 · --line #252b33 · --fg #e8eaed · --muted #88919d · --accent/--blue-strong #438cf5 · --blue #6ba6ff · --focus #94bdff · --ok #6cc79a · --run #7fb2ff · --warn #e0b872 · --danger #e49a9a` 等。
缓动 `--ease-out: cubic-bezier(0.23, 1, 0.32, 1)`、按钮尺寸（`min-height 34px`、`border-radius 7px/6px`）、`mini-bar 120×3px` 也 1:1 沿用；视频成果图为适配首屏内嵌窗口把 `rail-dot` 收到 23px，文档轨仍沿用原尺寸。

V2 额外按实机锁定的壳层：
- 1214 × 768 参考窗口比例；桌面宽度下左侧栏约 196px，对应真实 App 的 218px 源码列宽按预览窗口缩放后的比例。
- 固定左栏是 `Etch / 任务队列 / 统一术语表 / 环境 9/9 可用 / arm64 · v0.2.18`，不再把三类任务做成 App 外的营销标签页。
- 字幕工作台按实机还原为「任务头部 → 人工校对 checkpoint → 折叠流水线 → 左侧视频控制区 + 右侧工作台面板」。
- 网页工作台按实机还原为「任务头部 → 展开流水线 → 发布为网页 → X 内容警告 → 双栏 Markdown 校对 → 底部校对 checkpoint」。
- 视频流水线把原实机的长分叉线改成短“形成成果”交接：共享底稿只显示完成事实，当前人工 checkpoint 集中在蓝色成果轨，追加另一成果缩成次级按钮。

页面唯一图片素材是品牌图标：`assets/favicon.svg` ← `website/favicon.svg`。工作台、任务队列与 B站内容均为 HTML/CSS 组件，不引用真实页面截图。

---

## 4. 交互清单

主交互改为真实 Etch 路径：**左侧任务队列 → 选择任务卡 → 进入对应工作台**。每次选择同步改变任务身份、流水线、工作区、checkpoint 与操作按钮；不再使用 App 外的任务类型标签页。

| # | 交互 | 位置 | 结果 | 层级 |
|---|---|---|---|---|
| 1 | 左侧 `任务队列` | Etch 主导航 | 从任意工作台回到三张示例任务卡 | 主 |
| 2 | 字幕 / 总结 / 网页任务卡 | 真实队列卡片结构 | 进入对应工作台 | 主 |
| 3 | 左侧 `统一术语表` | Etch 主导航 | 展示跨任务术语表 | 主 |
| 4 | 流水线折叠/展开 | 原生 `<details>` | 收起阶段详情，保留摘要进度 | 二级 |
| 5 | 点任意阶段节点 | 阶段轨 | 展开该阶段的 id / status / 并发池详情，再点收起 | 二级 |
| 6 | `追加视频总结 / 追加双语硬字幕` | 流水线成果区 | 复用共享底稿并切换到另一成果工作台 | 二级 |
| 7 | 视频播放 / 前后 5 秒 / 倍速 / 预览模式 | 字幕与总结视频区 | 更新播放反馈，不读取真实媒体 | 二级 |
| 8 | 工作台标签页 | `tp-tabs` | 字幕 4 页 / 总结 3 页 / 文档 3 页 | 二级 |
| 9 | 点 cue 行与分页 | 校对页 | 当前行高亮、区间从 `1–100` 到 `101–200 / 412` | 二级 |
| 10 | `1 核对术语` / `2 核对译文` | checkpoint 步骤 | 切到术语表 / 校对页 | 二级 |
| 11 | 文档 `完成校对` | 双栏校对底部 | `review → verify` 完成，并解锁导出 Markdown 与 HTML 四方向预览 | 二级 |
| 12 | HTML 风格方向 A/B/C/D + 生成 | 网页发布工作流 | 生成 `translation.html` 并显示模板与验收结果 | 二级 |
| 13 | 字幕 `完成校对并继续` | 字幕工作台主操作 | 演示 `review → srt → burn → verify` 完成 | 二级 |
| 14 | 返回 / 打开原网页 / 导出 / 新建任务 | 辅助操作 | 显示明确原型反馈，不执行真实外部副作用 | 辅助 |

状态与可达性：
- **hover**：只在 `@media (hover:hover) and (pointer:fine)` 生效，避免触屏残留。
- **focus**：全局 `:focus-visible` 2px `--focus` 描边，offset 3px。
- **pressed**：`:active` 用 `scale(.975)`（与 `app.css` 按钮一致）/ `.99` 卡片。
- **禁用**：`opacity .42`（`app.css` 取值），且真的加 `disabled`。
- **键盘**：工作台标签页、风格方向都是 roving tabindex + 方向键 / Home / End；任务队列、左侧导航、`<details>` 与所有按钮原生可聚焦；文档双栏 `tabindex="0"` 可键盘滚动；首个元素是跳到正文的 skip link。
- **reduced motion**：`prefers-reduced-motion: reduce` 下关闭平滑滚动并把动画/过渡压到 0.01ms。
- **390px**：左侧栏收窄为图标轨、任务卡改单列、视频与工作台上下排列、cue 双栏改单列、阶段轨在容器内横向滚动、信息网格改单列。

安全说明：原型用 `innerHTML` 渲染，所有插值都过 `esc()`；数据全是本文件内的作者常量，无用户输入、无网络请求、无 storage 读取。CSP 为 `script-src 'self'`。

---

## 5. 与 herdr.dev 的借鉴边界

参考对象：<https://herdr.dev>。**只借页面结构，不借视觉。**

### 借了（结构性）

1. **可操作 demo 直接嵌在首屏内**，页面初次打开即可看到真实 Etch 窗口，而不是放截图或视频。
2. **demo 自带小标题**，与其他 section 同级。
3. **左侧导航切换场景，主面板整体重渲染**——herdr 是 spaces → agents → tabs；本原型是任务队列 → 工作台 → 面板标签。
4. **demo 之后接编号能力段落**（herdr 五段 → 本页三类任务）。
5. **底部重复同一个主 CTA**。

### 没借（视觉与内容）

1. **不用终端美学**：herdr 的 demo 是 shell/终端；Etch 是 GUI 桌面 App，原型画的是真实 Electron 工作台外壳。
2. **主 CTA 形态不同**：herdr 首屏是 `curl | sh` 安装命令；Etch 是 DMG 下载按钮，不伪装成命令行产品。
3. **首屏不放 metrics**：herdr 有 key metrics；Etch 没有可核实的公开数字，放了就是编造，故省略。
4. **配色、字体、间距、圆角全部另起**：一律来自 `app.css` 与官网，`#0b0d10` + `#438cf5` 冷静桌面工作站，不抄 herdr 任何 token。
5. **不借词汇与叙事**：不出现 herdr 的 "the herd" / "agent runtime" / spaces 之类说法，也不抄它的标题句式。
6. **不用渐变、玻璃卡片堆叠、夸张圆角、Inter**：分隔一律 1px 实线 + 小圆角（6–11px）。
   唯一例外是 `assets/favicon.svg` 内部含渐变——那是 Etch 已发布的真实品牌资源，原样引用，未在 CSS 里新增任何渐变。

---

## 6. 残余风险与下一步

1. **v0.2.18 下载链接未做网络可达性验证**（git tag 只到 v0.2.14）。上线前需确认该 Release 已发布。
2. 原型是纯前端假数据，**没有接 IPC**；若要落地为真官网，demo 应保持静态假数据，不要接真实 `task.json`。
3. 视频总结的 L3（真实视频 + 真实 Provider）按 `CLAUDE.md` 尚未执行，页面已保留「完整 L3 尚未执行」这句限制说明，不要在后续改稿里删掉。
4. B站投稿尚未用真实账号完成 L3，图注已如实标注。
5. 未做深色/浅色双主题。真实 App 用 `light-dark()` 同时支持两套；本原型只做深色侧。若要补，按 `app.css` 的 light 侧取值加 `prefers-color-scheme` 分支即可。
6. 未做真实视频播放器区域（`VideoPreview`）。原型用 cue 校对表代替，避免放一个不能播的假播放器。
