# CMUX Agent Remote

Mac 本地的多 Agent Web 控制中心：通过浏览器 / 手机查看并控制 cmux 里的 Claude Code、Codex CLI、Grok Build、Pi。不是远程 Terminal，核心是「谁在干活、谁在等你」。用法入口为 README.md，API 与集成细节见其文档导航。

## 怎么跑

需要 Bun。长驻服务放 tmux，不要前台占终端。

```bash
bun install && bun run build
bun run start                 # 127.0.0.1:4318
bun run start -- --lan        # 同一 Wi-Fi 手机可访问
bun run start -- --demo       # 没有 cmux 时用假数据
bun run test                  # Vitest
bun run typecheck             # tsc -b
bun run dev                   # 服务端 watch
bun run dev:web               # 前端 :4319，代理到 :4318
```

数据目录默认 `~/.cmux-agent-remote/`（PIN / session / hook 配置）。Hook：`bun run install-hooks`。要挂公网先读 `docs/deployment.md`。

技术栈：Bun + Hono + SQLite / React 18 + Vite / Zod；bun workspaces。

### 运行中更新

- 服务已经运行且代码有改动时，优先原地更新：复用原端口、tmux session 和外部入口，不要无故另起一套服务。
- 运行中更新使用 `bash .agents/skills/launch-public/scripts/launch-public.sh refresh`。该动作先构建，再重启 `agent-remote-web`，复用端口 `4318` 和现有 PIN；已有 Sealtun tunnel 则保留，不会新建公网入口。
- 不要为了发布代码而停止或清理 Sealtun 隧道；只有用户要公网且原入口确实无法复用时才创建新入口，并明确告知地址变化。
- 更新完成后验证本地可访问；原本就有公网时再验公网。前端有改动时，确认远程资源哈希与本地 `apps/web/dist/index.html` 一致。

## 目录

```
apps/server/src/   cmux/ hooks/ state/ realtime/ api/ services/ security/
apps/web/src/      pages/ features/ components/ hooks/ stores/ realtime/ styles/
packages/protocol  共享 Zod schema（前后端）
packages/shared    时间、缓存、文本清洗
scripts/           cmux-agent-web-hook + 安装/卸载
```

## 约定

- 文档只维护 README 和 docs 下的 usage、deployment、development、agent-guide 四篇；接口合同唯一源为 `docs/agent-guide.md`，服务直接读取该文件。计划与单次验收不放进公开 docs。
- cmux 控制写操作必须带 `surfaceId`。文件模块使用独立的 `/api/files` 接口，可访问整个 Mac 文件系统，权限由 macOS 当前用户决定，不依赖 surface。登录后即可读写，不再分只读 / 控制模式。
- 首页可以关掉 surface：走 `cmux close-surface`，必须带 `surfaceId`，关的是 cmux 里的真实 tab。workspace 最后一个 tab 关不掉（cmux `invalid_state`）。
- 人用短 PIN，Hook 用长密钥且只收本机回环；Hook 任何失败都必须 exit 0。
- 调 cmux 走参数数组，不经过 shell。SQLite 不存终端全文和 prompt。
- 路由：`#/` 结构树首页，`#/s/:id` 会话，`#/w/:id` 单 workspace 深链。不要把首页改回独立 Inbox。
- 会话页终端走 `cmux rpc terminal.replay` 网格，不要退回纯 `read-screen`。
- 回看历史分两条路，别混：普通屏用 `read-screen --scrollback`（`/history`，纯文本、不进 SnapshotTracker），
  全屏 TUI 只能发 `pageup` 让它自己翻（`/scroll`，离开会话自动 `bottom` 复位）。
  `terminal.replay` 只吃 `surface_id`，回滚 240 行封顶，别再找参数了。
- 别再找「按行滚动 / 转发滚轮」的 cmux 接口：`terminal.scroll`、`terminal.mouse` 实测是空壳
  （不校验参数、画面不动）。TUI 只能整屏翻，前端用手势（`usePageGesture`）包装成翻页。
- 新建 surface 只建 terminal，`--type agent-session` 是死路（读不到画面也发不了输入）。
  起 Agent 走服务端白名单命令（`config.launchCommands`），不收前端传的命令字符串。
  新 tab 懒启动，建完必须发一次回车唤醒，否则没有 tty、读画面直接报错；
  工作目录 cmux 不给，只能 `lsof` 反查同 pane 进程的 cwd。

## 当前范围

v0.1.0，当前能力以 README 与四篇指南为准。支持本地服务经 Sealtun 暴露公网，运行态需另行核验。未做：完整 Terminal Emulator、多用户、云端 Relay、独立 tmux 任务管理、Project 聚合；tmux 当前用于托管本服务。
