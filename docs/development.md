# 开发指南

本项目使用 Bun workspaces、Hono、SQLite、React 18、Vite 和 Zod。启动配置见 [部署指南](deployment.md)，所有 HTTP / WebSocket 对外合同统一维护在 [Agent 接入指南](agent-guide.md)。

## 本地开发与验证

在仓库根目录执行。若 4318 已有服务，复用它，只启动前端；服务端改动需要使用对应源码运行的 API 服务。

```bash
bun install --frozen-lockfile
# API watch：4318
tmux new-session -d -s agent-remote-api-dev 'bun run dev'
# Web：4319，代理 API 到 4318
tmux new-session -d -s agent-remote-web-dev 'bun run dev:web'
# 查看日志
tmux capture-pane -pt agent-remote-api-dev -S -80
tmux capture-pane -pt agent-remote-web-dev -S -80
# 停止自己启动的开发服务
tmux kill-session -t agent-remote-api-dev
tmux kill-session -t agent-remote-web-dev
```

提交代码前执行相应检查：

```bash
bun run typecheck
bun run test
bun run build
git diff --check
```

TypeScript 覆盖源码、测试与 scripts；Vitest 覆盖 API、状态、Hook、实时连接和前端交互规则。构建产物在 `apps/web/dist`。纯文档修改检查链接、合同与实际命令，不需要为文字变动新增测试；修改在线指南时运行 `bun run test -- apps/server/test/agent-context.test.ts`。

涉及前端交互时按影响验证登录、树筛选、切换会话、发送失败保留草稿、普通历史、TUI 翻页和文件操作。真实 cmux 写操作使用专用测试 workspace，不向工作中的会话注入测试输入。自动化通过不代表真实 cmux 或公网已验收。

需要完整 HTTP 真机验收时运行 `python3 scripts/verify-agent-http.py`。脚本会在 tmux 中启动隔离测试服务、创建测试 workspace 并执行无害命令，最后清理；需要 Bun、tmux 与正在运行的 cmux。隔离必须同时指定 `CAR_DATA_DIR`、`CAR_DB` 和 `--db`，启动后核验数据库与 Hook 路径；没有 `--data-dir` 参数。不要用默认运行数据做 PIN 轮换或 Session 测试。

## 架构与文件归属

```text
浏览器 / HTTP 客户端
        │ HTTP / WebSocket
        ▼
API ── 服务层 ── cmux Adapter ── cmux CLI / 终端
        │             │
        ▼             ▼
  文件 / Git     State Engine ◀── Agent Hooks
                      │
                SQLite / Realtime
```

| 目录 | 职责 |
| --- | --- |
| `apps/server/src/api/` | 鉴权后的参数、响应与路由 |
| `apps/server/src/services/` | 终端流程、现场聚合、文件与 Git 等业务 |
| `apps/server/src/cmux/` | CmuxClient 接口、CLI 调用、进程发现、画面与控制 |
| `apps/server/src/hooks/` | 各 Agent 原生事件归一化 |
| `apps/server/src/state/` | 状态转换、时间规则与 SQLite 存储 |
| `apps/server/src/realtime/` | 分级轮询、订阅与 WebSocket 推送 |
| `apps/server/src/security/` | PIN、Session、限流与鉴权 |
| `apps/web/src/pages/`、`features/` | 页面组装与功能交互 |
| `apps/web/src/stores/`、`realtime/` | 状态、按 surface 缓存、连接与恢复 |
| `packages/protocol/` | 跨端 Zod schema、类型、注意力分组 |
| `packages/shared/` | 时间、文本清洗、缓存等纯函数 |
| `scripts/` | Hook 安装、卸载和真机验收 |

功能组件放 features，复用 UI 放 components。高频网格通过按 surface 的订阅更新，不放进全局 React Context。路由负责 HTTP 边界，业务流程放 services，cmux 命令细节留在 adapter。文件与 Git 模块独立于 cmux，surface 只提供入口和目录提示。

`docs/agent-guide.md` 是在线指南唯一源，路由在 SPA 回退之前处理。修改接口时同时更新共享 schema、实现及该指南，其他文档只写受众需要的操作解释。

## 状态与刷新

cmux 提供拓扑、进程、画面和控制；Hook 提供回合、工具、批准与结束等语义事件；时间和进程检测补充失活判断。没有 Hook 时通过输出变化推断状态。

| 状态 | 含义 |
| --- | --- |
| `WORKING` | 正在执行回合 |
| `NEEDS_APPROVAL` / `NEEDS_INPUT` | 等待批准 / 输入 |
| `RESPONDED_UNREAD` | 已回复、用户尚未查看 |
| `IDLE` | 进程存在、当前空闲 |
| `POSSIBLY_STALE` | 工作中长时间没有活动，默认阈值 10 分钟 |
| `ERROR` / `CLOSED` | 明确异常 / 进程已退出 |

注意力排序、分组与统计由 protocol 的 `buildInbox` 生成，前端单 Agent 更新后也重新计算。优先级为 ERROR → NEEDS_APPROVAL → NEEDS_INPUT → RESPONDED_UNREAD → POSSIBLY_STALE → WORKING → IDLE → CLOSED。状态仅用于观察，不是任务成功协议。

| 场景 | 默认轮询间隔 |
| --- | --- |
| 正在查看的 surface，含普通 Shell | 400 ms |
| 工作中 / 等待用户的 Agent | 1 s |
| 无 Hook 的空闲 Agent | 8 s |
| 有 Hook 的空闲 Agent，且无人查看 | 不轮询 |

只有正在查看的 surface 读彩色网格；后台状态推断读取纯文本。指纹不变不推送内容，但仍检查无 Hook 会话的静止时间。CLI 的 tree / top 有 1 秒缓存，并合并并发读取。

网格和纯文本 revision 独立，不能混用。StateEngine 的 outputRevision 由轮询器维护；context/history 不进入 SnapshotTracker，旧 output/Agent 详情读取仍更新文本快照跟踪器。打开会话与订阅会参与已读处理，context 用于无此副作用的观察。

网页每 15 秒发送 WebSocket 心跳，45 秒无 pong 后重连；销毁后旧回调不能再次连接。重连恢复订阅并同步列表、拓扑、当前画面。断线时三者每 5 秒降级刷新，同轮完成后再安排下一轮。

## cmux 集成约束

### 创建与控制

- 新 surface 只创建 `terminal`。`agent-session` 类型不能用于当前读画面与输入接口。
- 新 tab 懒启动，创建后发送一次 Enter 唤醒 Shell，避免没有 tty 时读屏失败。
- 启动 Agent 使用服务端白名单，配置见部署指南。创建成功仅说明 tab 存在；目录初始化和 Agent 就绪需要读 context/输出核对。
- cmux 调用使用参数数组，不经 shell；向终端发送启动命令时由目标 Shell 执行，路径必须安全引用。
- Codex 会话正文使用 `terminal.paste`，显式传 `submit_key: "none"`，需要提交时再单独发一次 Enter；整段粘贴保留换行，也避免 Codex 将紧随连续输入的 Enter 当成正文。该 RPC 默认自动提交，不能省略 `submit_key`。其他 Agent、Shell 与启动命令继续使用 `send`。
- Option+↑ 使用原生 `send-key alt+up`。`terminal.input` 会将 ESC 转为独立的 Escape 按键，不可用来注入 CSI 转义序列，否则会误触 Codex 的打断。
- 输入、按键、关闭 surface 显式指定目标 ID，不使用“当前终端”。批量关闭校验最新完整 surface 集合。
- cmux 不直接提供 cwd；目标 context 按该 surface 的进程线索探测，创建 surface 的目录提示可从同 pane 进程反查。无法获取时返回空值，不凭标题推断。

输入和创建的部分失败必须保留已知事实，返回真实 UUID 或交付阶段；客户端不能自动重发。错误码和恢复动作统一见接入指南。

### 画面与历史

会话画面使用 `cmux rpc terminal.replay` 的网格，按 `cell_width` 定位字符，保留颜色、样式和光标；纯文本无法还原 TUI。服务端压缩网格表示，只在画面改变时推送。

cmux 不支持由本应用修改终端列数，前端通过缩放与换行适配。历史分两条路：

| 场景 | 实现与限制 |
| --- | --- |
| 普通屏 | replay 只含最多 240 行回滚；更早内容用 `read-screen --scrollback`，返回受配置限制的纯文本，独立于 SnapshotTracker |
| 全屏 TUI | 历史由程序维护，发送 pageup / pagedown 让真实程序翻页；离开时 bottom 复位，最多 12 次 pagedown |

`terminal.replay` 只接收 surface_id，没有扩大回滚参数。当前适配所依赖的 cmux 中，`terminal.scroll` / `terminal.mouse` 无可用的按行滚动行为；前端手势包装整屏翻页。对接其他 cmux 版本时重新核验能力。

## Hook 集成

使用 `bun run install-hooks` 安装，`bun run uninstall-hooks` 卸载。安装器备份配置并合并本项目条目，卸载只移除自己的条目。各 Agent 最终调用：

```bash
scripts/cmux-agent-web-hook <claude|codex|grok> <NativeEventName>
```

| Agent | 用户配置文件 | 挂载事件 |
| --- | --- | --- |
| Claude Code | `~/.claude/settings.json` | SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / Notification / Stop / SessionEnd |
| Codex | `~/.codex/hooks.json` | SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / PermissionRequest / Stop |
| Grok | `~/.grok/hooks/cmux-agent-remote.json` | SessionStart / UserPromptSubmit / PreToolUse / Notification / Stop / SessionEnd |

Pi 支持进程识别、终端查看控制与输出推断，当前没有精确生命周期 Hook。

脚本默认从 `~/.cmux-agent-remote/hook.json` 读取端口和独立密钥。Hook 与 surface 按 `CMUX_SURFACE_ID`、PID 进程关联、sessionId、workspace + Agent 类型唯一命中依次定位。失败不能影响 Agent：脚本任何情况下 exit 0 且 stdout 为空，接收端失败也返回 200，并在正文标记忽略。

## 后续方向

当前没有完整终端模拟器、多用户、云端 Relay、独立 tmux 任务管理或 Project 聚合。tmux 在现有部署中用于托管本服务。

后续可围绕 Pi 精确 Hook、接入诊断、状态来源展示和完成提醒评估需求；这些是候选方向，不构成已支持功能或交付承诺。开发计划和单次验收过程留在 Issue、PR 或原仓库历史，现役文档只维护当前行为。
