# Etch

Etch 是 Apple Silicon macOS 上的本地英中双语硬字幕工作站。它把视频获取、英文字幕获取或转写、Agent CLI 翻译、术语审计、逐句校对、双语字幕压制和成片验证组织成可恢复的任务流水线。

## 当前状态

- 当前版本：`0.1.1`
- 当前输入：**仅支持 HTTP(S) URL**；`local` 仍只是领域 schema 的预留类型，UI 与 pipeline 尚未实现本地文件导入。
- 当前发行：GitHub Release 提供 Apple Silicon DMG。App 使用 ad-hoc 签名，**没有 Developer ID 签名、公证或自动更新**，首次打开可能被 Gatekeeper 拦截。
- 当前平台：Apple Silicon Mac，macOS 13.5 或更高版本。

## Capability matrix

| 状态 | 能力 | 当前边界 |
| --- | --- | --- |
| Implemented | URL 任务队列 | 一次可创建 1–50 个 HTTP(S) URL 任务；支持暂停队列、停止与恢复。 |
| Implemented | 视频与字幕获取 | 使用 `yt-dlp` 获取源视频并优先尝试英文字幕；失败时可回退到本地 Whisper。 |
| Implemented | 本地转写 | 使用 `mlx_whisper`；超过 20 分钟的媒体按固定 20 分钟窗口分段，带 2 秒重叠、逐段缓存、失败续跑与时间轴合并。 |
| Implemented | 四个 Agent CLI adapter | 支持 Claude、Codex、Qoder、OpenCode 的检测、翻译、session resume 与结构化输出校验。 |
| Implemented | 翻译质量工作流 | 支持批次翻译、全局术语审计、历史术语提示、英文源审计、人工逐句编辑和局部修复。 |
| Implemented | 字幕与成片 | 生成双语 SRT，按任务选择紧凑/标准/大字三档字幕预设，使用 FFmpeg 压制并用 ffprobe 验证成片。 |
| Implemented | 可恢复任务状态 | `task.json` 是任务权威；阶段产物使用 run-scoped 不可变候选，提交受 lease、revision 与 fingerprint 约束。 |
| Implemented | 本地运行治理 | 队列索引在启动时从任务目录重建于内存；工具健康、任务发现冲突、退出收敛、通知和防睡眠状态可见或可恢复。 |
| Partial | Provider 兼容性 | adapter 单元/集成测试覆盖四端协议；hermetic E2E 覆盖桌面边界与工具探测。真实账号、具体 CLI 版本和服务端行为仍需在当前机器逐个验证。 |
| Partial | 长媒体资源治理 | 已有确定性分段和恢复；尚无静音点切分、全局磁盘预算或自动缓存清理策略。 |
| Planned | 本地文件导入 | 需要完整实现文件选择、APFS clone/copy、空间检查、字幕探测、canonical media 与恢复，当前没有入口。 |
| Partial | 公开发行 | GitHub Release 提供 arm64 DMG 与 SHA-256；Developer ID、公证、provenance、CI release gate 和自动更新尚未实现。 |

## 运行依赖

- Node.js `22.22.1`（项目 `.nvmrc` 的验证版本；`package.json` 最低要求为 `22.12.0`）
- Apple Silicon Mac，macOS 13.5+
- `yt-dlp`
- 带 `libass` 的 `ffmpeg` 与配套 `ffprobe`
- Python 3.12 与 `mlx_whisper`
- 至少一个已安装并登录的 `claude`、`codex`、`qodercli` 或 `opencode`

Etch 会在设置页检测 executable、版本、关键能力和登录状态。工具不在常规 `PATH` 时，可在设置中指定绝对路径 override。

## 从源码运行与构建

```bash
nvm use
npm ci
npm run dev
```

构建当前源码并验证 Apple Silicon 目录包：

```bash
npm run pack
```

输出位于 `dist/mac-arm64/Etch.app`。该产物是本机开发构建，不是可公开分发的安装包。

构建并挂载验证 Apple Silicon DMG：

```bash
npm run dist:mac
```

输出位于 `dist/Etch-0.1.1-arm64.dmg`。验证脚本会检查 DMG 文件结构，并直接校验卷内 `Etch.app` 的签名、entitlements、arm64 架构、版本和最低系统版本。

## 安装公开 DMG

1. 从 [GitHub Releases](https://github.com/bingjiang0611/Etch/releases) 下载 `Etch-0.1.1-arm64.dmg`。
2. 打开 DMG，把 `Etch.app` 拖入 `Applications`。
3. 首次启动若被 Gatekeeper 拦截，在 Finder 中右键 `Etch.app` 选择“打开”；仍被拦截时，到“系统设置 → 隐私与安全性”选择“仍要打开”。

当前 DMG 未经 Apple 公证。DMG 只是安装容器，不会绕过 Gatekeeper；需要无警告安装的正式发行版仍需 Developer ID Application 签名和 Apple notarization。

## 验证层级

- L1：`npm run verify:l1`，再运行 `npm run pack` 与 `git diff --check`。覆盖类型、lint、Vitest、renderer/main build 和目录包结构。
- 开发 E2E：`npm run e2e:hermetic`。它使用固定 fake tools、隔离 HOME/PATH/env，验证 UI、任务状态和进程合同；它不等于安装包 smoke，也不证明真实 Provider/网络可用。
- L2：先把本次构建的 `Etch.app` 覆盖安装到 `/Applications/Etch.app`，再运行 `npm run smoke:installed` 并人工走查受影响的真实工具路径。
- L3：使用真实 URL、真实媒体和四个已登录 Provider 覆盖完整用户路径。仓库没有把 L3 伪装成可自动通过的脚本；未逐项执行时不得宣称 MVP 全路径通过。

## 数据与隐私边界

- 任务媒体、字幕、日志、manifest 和成片保存在设置中的 workspace（默认 `~/Movies/Bilingual Subs`）。每个任务目录内的 `task.json` 是权威状态。
- 设置、位置注册表、运行注册表、隐藏任务记录和全局术语表位于 Electron 的 `app.getPath('userData')` 目录；任务队列索引只存在于内存，并在每次启动时从任务目录重建。
- 当前代码没有 Etch 自建遥测或 Etch 云端。下载、转写、文件管理与压制在本机执行。
- 翻译、审计与修复会把对应的字幕文本、风格说明和术语上下文交给用户选择的 Agent CLI；内容是否离开设备及其保留策略由该 CLI 与其后端服务决定。
- 默认情况下，媒体工具只接收运行所需的操作环境，Provider 只接收 adapter 声明的凭据/配置变量；显式设置 `ETCH_LEGACY_FULL_CHILD_ENV=1` 会临时恢复旧的完整 child env（仍移除嵌套 Agent 污染变量）。诊断日志记录环境变量名，不记录变量值。
- “删除全部产物”会把已登记的任务目录移到 macOS 废纸篓；“仅移除记录”只从 Etch 隐藏任务，原目录仍保留。删除任务后，全局术语派生来源会重新核对。

## 常见故障

- 工具显示不健康：先看设置页给出的 executable、版本、登录或 `libass` 诊断，再修正 PATH 或配置绝对路径 override。
- 异常退出后任务暂停：Etch 会先核对 durable run registry，避免旧 Provider 进程与恢复任务并发写入；确认恢复摘要后再继续。
- 任务未出现在队列：检查启动诊断中的无效 manifest 或重复 task ID；队列索引会在每次启动时从可读取的 `task.json` 重建。
- Provider 失败：确认相应 CLI 已登录且版本兼容。真实账号/网络问题不能由 hermetic E2E 证明正常。

## 设计文档

- [`CLAUDE.md`](./CLAUDE.md)：稳定架构约定与项目验证 profile。
- 聚合工作区另有目标架构与审计修复 RFC；它们不属于 Etch 独立 Git 仓库，也不是当前文件 inventory。
