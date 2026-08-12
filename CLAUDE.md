# Etch

## 稳定架构约定

- Etch 是独立 Electron + React + TypeScript macOS App；原 `youtube-bilingual-subs` skill 只作只读行为参考，不是运行时依赖。
- `task.json` 是任务状态权威；队列索引只在内存中维护，并在启动时从任务目录重建。任何 worker 提交必须经过 step lease + revision/fingerprint CAS。
- 任务分三类：`kind: 'subtitle'` 跑硬字幕，`kind: 'summary'` 跑中文长文总结，`kind: 'document'` 把普通网页、X 单条帖子或 X Article 转成结构保真的 Markdown 并按模式翻译。三类共用同一条阶段序列，不属于本类型的阶段在创建时就写成 `skipped`；文档任务复用 `source → inspect → translate → review → verify` 的调度槽位，但必须在进入任何视频逻辑前分流。新增阶段必须同时补齐 manifest 迁移里的缺阶段填充，否则旧任务会把新阶段当成待执行。
- 总结任务的三稿硬门禁：必须真实生成 A/B/C 三份完整候选稿、六项数值评分、遗漏清单与终稿自检，记录不齐就让阶段 `failed`，不得产出半成品。终稿必须保留「最后」评论区和 8-12 处 `images/NN-slug.png` 配图占位。
- 模型输出不稳定是常态输入，不是异常：需要模型产出结构化 JSON 的提示词必须由 zod schema 渲染契约（`jsonContract`），不得手抄字段上限与枚举；修复轮喂回的失败详情必须经 `describeValidationFailure` 压成逐条中文，并统一用 `VALIDATION_FAILURE_PROMPT_LIMIT` 截断，不得把枚举可选值或字段路径切掉。
- 门禁必须分三级，不得一律 `failed`：①归一化——纯装饰性字段（分类提示类枚举）取值超出范围时归到兜底值，不丢数据也不失败；②降级到运行时——前置探测结果不确定（超时、输出无法解析）时标记「未确认」并放行，由真实调用暴露问题，或按 `checkpoint` 交给用户决定；③硬拦——影响交付正确性的质量门禁（三稿记录、digest 引用真实性、终稿结构、产物哈希）与明确的坏状态（明确未登录、CLI 执行失败）才让阶段 `failed`。
- 一次真实 provider 调用的产物必须可续跑：翻译批次、素材分析分段这类昂贵中间结果都要按 `inputFingerprint` 落盘并 CAS 写进 manifest，重跑只补未完成项；新增多步骤阶段必须同时给出这套续跑记录，不能只把结果留在内存里。
- renderer 只能通过窄 preload IPC 访问主进程；不得直接读文件、spawn、启用 Node integration 或引入任意命令 IPC。
- 四 Provider 只使用本地 `claude`、`codex exec`、`qodercli`、`opencode run` CLI；不得改用 SDK、app-server 或常驻 server。
- 翻译、英文审计、素材分析与长文写作全部跑纯文本隔离调用（禁工具、空 MCP、任何工具标记即视为会话污染）。外部核验与配图是两条允许工具调用的例外，且都必须“只开一个、其余全关”：配图走独立的 `image-adapters` 调用档与 `ImageStreamReader`，只放行图像生成工具、只允许认领本次 run 或本次 Codex thread 的图片，且不复用、不写入翻译的 session generation；外部核验只放行 Web Search（详见下条）。图像能力白名单只能来自实测（当前为 Qoder `ImageGen` 与 Codex `image_generation`），未验证的 Provider 一律在 UI 上置灰并给出原因。
- 外部核验白名单只收实测过的 Provider，当前为 Codex 与 Qoder，且必须三层防御同时成立：① spawn 层收窄可用工具（Codex 只解禁 `standalone_web_search`；Qoder 用随机不可命中的 `--allowed-mcp-server-names` 隔离插件 MCP，再用 `--tools WebSearch` 使 Bash/Edit/Write/Agent/ImageGen 直接不存在）；②权限层拒绝执行（Qoder 必须同时给 `--allowed-tools WebSearch`，否则 `dont_ask` 会把搜索也拒掉，模型会退回记忆作答并把未核验当成核验结果）；③观测层判污染（`inspectResearchStream` / `inspectQoderResearchStream`：init 只能暴露 WebSearch、MCP 必须 disconnected，且只有成功配对的 WebSearch result 才计为真实搜索；出现任何其他工具调用都让阶段失败）。`--strict-mcp-config` 单独压不住插件提供的 MCP server，不得以它作为隔离依据。
- 配图必须由用户在 checkpoint 里确认并选定 agent：`illustrate` 阶段按 `phase` 推进（`agent-pending` → `cover-review` → `rest` → `done`，或 `skipped`），phase 必须进入 inputFingerprint。封面未验收前不得生成其余配图；封面失败直接让阶段失败，章节图失败只记 `pending` 并带缺图交付。
- 图像工具自己选文件名：Qoder 实测落在 `<cwd>/vibe_images/<name>_<ts>.png`，Codex 落在 `generated_images/<thread UUID>/`。Etch 只传逻辑名，按精确 thread/run 归属认领，改名与验收（PNG magic、>10KB、16:9 ±3%）由主进程完成；每张通过后单独 CAS 持久化，不能把其他会话或上一张配图当成本次新产物。
- 外部进程统一使用独立 process group、durable registry 与参数数组；成功以验证后原子提交产物为准，不以退出码 0 为准。
- B站投稿使用安装包内固定版本和 SHA-256 的 `biliup` sidecar；凭证只由主进程通过 `safeStorage` 保存，投稿状态独立于主流水线，提交结果不可验证时必须进入 `unknown` 防止重复投稿。
- 任务分类只是归档位：分类本体存 `AppSettings.taskCategories`，`task.json` 只存 `category` id（空串 = 未分类）；引用已删分类时按未分类渲染而不报错，删分类不改写任何 manifest，改分类不碰阶段状态。
- 工作流产品约束源：`../workflows/youtube-bilingual-subs-app.md`；实施方案：`../docs/rfc/Etch/etch-mvp.md`；视频总结实施方案：`../docs/rfc/Etch/etch-video-summary.md`（行为参考 `youtube-content` skill，不是运行时依赖，也不引入 Obsidian）。
- 静态 HTML、截图或设计稿里的字段必须先映射到 Etch 的 `task.json` / manifest / IPC，再决定是否渲染。没有真实持久化数据的 speaker、Token、source/final 媒体切换等字段不得照搬成假能力；优先复用校对、任务信息、审计术语和样式等真实入口。

## 改完代码后的验证 profile

### L1 静态 oracle

进入本目录，使用 Node 22.22.1：

```bash
PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH" npm run typecheck
PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH" npm run lint
PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH" npm test
PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH" npm run build
PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH" npm run pack
```

检查 `git diff --check`，确认原 skill 无本任务写入；package 后核对 `.app` 为 arm64 且 minimum system version 为 13.5。

### L2 运行时 smoke

- 覆盖安装 `/Applications/Etch.app`，从 Finder 启动而非 dev server。
- 先运行 `npm run smoke:installed`；它会重新 pack、核对 installed `app.asar` 与本次构建一致，并通过重启验证 packaged preload、菜单和 durable IPC。
- 需要 DOM 级 installed smoke 时，可用 Playwright 直接启动 `/Applications/Etch.app/Contents/MacOS/Etch`，核对 packaged main/preload/renderer、真实 userData、安装哈希和关键 DOM；这只算 L2，不替代四 Provider 与多平台 L3。
- 人工验证队列、设置、工具健康、Chrome cookies 参数、应用菜单、通知、电源 assertion、强杀恢复与 task manifest/内存索引重建。
- 使用真实 URL 生成并验证一个短视频硬字幕成品；真实工具不健康时明确记录阻塞，不得写“L2 通过”。
- 总结任务：用真实短视频跑完 `digest → research → summary → illustrate`，确认三稿执行记录可审、外部证据账本可追溯、配图 checkpoint 真的停下来等选 agent、封面验收后才生成其余配图，并验证工作台预览与导出目录（`summary.md` + `images/`）可用。Qoder/Codex 图像 CLI 不可用时记环境阻塞，不得声称配图通过。
- 托盘与本地文件导入当前未实现，不属于现行 L2 合同。

### L3 端到端用户路径

- 真实覆盖 YouTube 有字幕、YouTube→Whisper、X/通用 URL。
- 真实覆盖 Claude/Codex/Qoder/OpenCode 四 Provider 的翻译、resume 与全局审计。
- 总结任务 L3：真实覆盖 YouTube 有字幕与 Whisper 两条路径、封面验收不通过后换 agent 重做、跳过配图、以及强杀后从 `illustrate` checkpoint 恢复；同时回归一条完整字幕任务确认旧流程未退化。
- 覆盖三任务跨阶段并发、低清/超长/术语歧义/session 丢失 checkpoint、局部重试、样式重压、完成 brief。
- 固定窗口工作台至少检查 `1360×860`、`1360×680`、`1100×900`；低高度下重点核对 recovery banner、展开流水线、固定 tabs/footer 是否挤压 cue 列表，以及主区滚动和 editor 最低高度是否仍成立。
- 只有上述全部成功才能宣称 Etch MVP 完成；登录态、平台或环境阻塞逐项列残余风险。
- 本地视频导入是 planned 能力，不属于现行 URL-only L3 合同。
- B站投稿 L3 必须经用户确认后，分别用真实账号完成一次手动投稿、一次自动投稿和一次上传中断恢复；以取得可验证提交回执为成功，不要求审核通过。
