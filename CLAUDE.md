# Etch

## 稳定架构约定

- Etch 是独立 Electron + React + TypeScript macOS App；原 `youtube-bilingual-subs` skill 只作只读行为参考，不是运行时依赖。
- `task.json` 是任务状态权威；队列索引只在内存中维护，并在启动时从任务目录重建。任何 worker 提交必须经过 step lease + revision/fingerprint CAS。
- renderer 只能通过窄 preload IPC 访问主进程；不得直接读文件、spawn、启用 Node integration 或引入任意命令 IPC。
- 四 Provider 只使用本地 `claude`、`codex exec`、`qodercli`、`opencode run` CLI；不得改用 SDK、app-server 或常驻 server。
- 外部进程统一使用独立 process group、durable registry 与参数数组；成功以验证后原子提交产物为准，不以退出码 0 为准。
- 工作流产品约束源：`../workflows/youtube-bilingual-subs-app.md`；实施方案：`../docs/rfc/Etch/etch-mvp.md`。

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
- 人工验证队列、设置、工具健康、Chrome cookies 参数、应用菜单、通知、电源 assertion、强杀恢复与 task manifest/内存索引重建。
- 使用真实 URL 生成并验证一个短视频硬字幕成品；真实工具不健康时明确记录阻塞，不得写“L2 通过”。
- 托盘与本地文件导入当前未实现，不属于现行 L2 合同。

### L3 端到端用户路径

- 真实覆盖 YouTube 有字幕、YouTube→Whisper、X/通用 URL。
- 真实覆盖 Claude/Codex/Qoder/OpenCode 四 Provider 的翻译、resume 与全局审计。
- 覆盖三任务跨阶段并发、低清/超长/术语歧义/session 丢失 checkpoint、局部重试、样式重压、完成 brief。
- 只有上述全部成功才能宣称 Etch MVP 完成；登录态、平台或环境阻塞逐项列残余风险。
- 本地视频导入是 planned 能力，不属于现行 URL-only L3 合同。
