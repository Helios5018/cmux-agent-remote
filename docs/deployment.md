# 部署与配置

首次安装见 [README](../README.md)。以下命令均在仓库根目录执行；服务和隧道等长驻进程放在 tmux 中，已有实例优先复用原端口、session 和入口。

## tmux 任务备注与端口检查

创建 session 时填写 `@note`（用途和停止影响）、`@project`、`@lifecycle`（`persistent` / `temporary`），有监听端口时填写 `@port`（多个端口用逗号分隔）。备注由启动方自动填写；重建时重新写入，复用时补齐。临时任务的备注说明完成条件。

新开端口前先浏览任务，再核对系统实际监听：

```bash
tmux list-sessions -F '#{session_name} | #{@project} | port=#{@port} | #{@note}'
lsof -nP -iTCP -sTCP:LISTEN
```

使用独立 tmux socket 时也检查相关 server；UDP 任务另查 `lsof -nP -iUDP`。`@port` 仅作线索，启动后还需核验实际监听。同一服务优先复用，其他任务占用可选端口时另选空闲端口；本项目固定 `4318`，冲突时核对归属，不自动终止占用进程。

`launch-public.sh` 会输出上述清单，并在新启前检查 `4318` 是否被监听；启动成功后为 `agent-remote-web` 写入元数据，复用时保留已有备注并补齐缺失备注。手动启动可用 `tmux set-option -t <session> @note '用途和停止影响'` 等命令填写；Tailscale 的 `@port` 应填实际 HTTPS 监听端口。

## 启动配置

默认监听 `127.0.0.1:4318`，首次生成 Access PIN，后续从数据库复用。常用配置：

| 参数 / 环境变量 | 用途 |
| --- | --- |
| `--lan` | 监听 `0.0.0.0`，供局域网访问 |
| `--host` / `CAR_HOST`、`--port` / `CAR_PORT` | 指定监听地址和端口 |
| `--demo` / `CAR_DEMO=1` | 使用假 cmux 会话；文件接口仍访问真实 Mac |
| `--trust-proxy` / `CAR_TRUST_PROXY=1` | 信任代理提供的来源 IP 与协议头 |
| `--pin` / `CAR_PIN` | 指定 4–12 位数字 PIN；不要写入公开配置或提交 |
| `--pin-length` / `CAR_PIN_LENGTH` | 自动生成 PIN 的位数，默认 4；不会自动改变已有 PIN |
| `--rotate-pin` | 启动时生成新 PIN，并使旧登录失效 |
| `--unlock` | 启动时清除登录锁定 |
| `--rotate-hook-token` | 启动时轮换独立 Hook 密钥 |
| `CAR_DATA_DIR` | 数据目录，默认 `~/.cmux-agent-remote/` |
| `--db` / `CAR_DB` | 独立指定数据库路径，默认在数据目录下 |
| `CAR_AUDIT_MAX_AGE_DAYS` | 审计保留天数，正整数，默认 30；非法值回落默认值 |
| `CAR_AUDIT_MAX_ROWS` | 审计保留条数，正整数，默认 100000；非法值回落默认值 |
| `--static` / `CAR_STATIC_DIR` | 指定前端构建目录 |

命令行参数优先于对应环境变量。完整启动参数可通过 `bun run start -- --help` 查看。更改启动参数需要重启原服务，不要在已占用端口上另启实例。

### 配置新建 Agent 的命令

现有会话的查看与控制不依赖这些配置。通过网页新建 Agent 时，服务端使用以下白名单命令：

| 环境变量 | 当前默认值 |
| --- | --- |
| `CAR_LAUNCH_CLAUDE` | `c-d` |
| `CAR_LAUNCH_CODEX` | `codex-d` |
| `CAR_LAUNCH_GROK` | `g-d` |
| `CAR_LAUNCH_PI` | `pi` |

前三个默认值是自定义 Shell 别名，新安装通常需要覆盖。先在 cmux 终端中确认对应命令可用，再配置服务。例如使用标准 CLI 命令名，首次启动可以写成：

```bash
tmux new-session -d -s agent-remote-web 'CAR_LAUNCH_CLAUDE=claude CAR_LAUNCH_CODEX=codex CAR_LAUNCH_GROK=grok CAR_LAUNCH_PI=pi bun run start'
```

命令最终在目标终端的 Shell 中执行，可使用该 Shell 已配置的别名；网页只传 Agent 枚举，不接收任意启动命令。更新服务时保留自己的配置。

## 远程访问

**自己在手机、平板或另一台电脑上访问，推荐 Tailscale Serve**：访问设备加入同一 Tailscale 网络（tailnet），通过私有 HTTPS 入口连接 Mac，进入应用后仍需 Access PIN。需要让未加入 tailnet 的设备访问时，使用 Sealtun 公网入口。两种入口可以同时存在，共用一份本地服务。

使用 [launch-public skill](../.agents/skills/launch-public/SKILL.md) 时：只说「拉起来 / 运行起来」默认只起本地服务；「拉起来到公网」才开 Sealtun；「拉起来到 tailscale」开 Tailscale Serve；「拉起来到公网和 tailscale」两个一起。新增入口不会自动关闭原有入口。

| 访问范围 | 服务配置 |
| --- | --- |
| 本机浏览器 | 使用默认回环地址 |
| 同一局域网 | 加 `--lan`，从其他设备访问 `http://<Mac局域网IP>:4318` |
| Tailscale 私有访问（个人设备推荐） | 保持回环监听，Tailscale Serve 将 HTTPS 入口转发到 `127.0.0.1:4318` |
| HTTPS 隧道 / 反向代理 | 代理指向 `127.0.0.1:4318`，服务保持回环监听；可信代理下启用 `--trust-proxy` |

仅监听回环时，其他设备不能通过 Mac 的局域网或 VPN IP 直连。需要相应监听地址，或由本机代理转发。公网入口应使用 HTTPS，并在入口层限制可访问的人或设备；本应用登录后即有控制权，没有多用户权限分级。

启用 `--trust-proxy` 的前提是请求来自可信代理，代理应正确设置来源与协议头，防止客户端伪造。该选项会影响来源 IP 限流和 Cookie 的 Secure 标记。代理还需支持 `/ws` 的 WebSocket 升级、大文件上传和音视频 Range 请求。

### Tailscale Serve

Mac 与访问设备安装并连接 Tailscale，加入同一 tailnet，且访问规则允许连接。Mac 需保持开机、联网且不进入系统睡眠。先确认本地 `http://127.0.0.1:4318` 可访问；已有 Agent Remote 服务直接复用，未启动时按 README 启动。

先检查现有转发，确认 HTTPS `443` 的根路径未被其他服务占用；已正确转发到 `4318` 时复用，不重复创建 session：

```bash
tailscale status --json
tailscale serve status --json

# 新建本项目转发，前台 Serve 由 tmux 托管
tmux new-session -d -s agent-remote-tailscale \
  'tailscale serve --https=443 http://127.0.0.1:4318'

# 查看实际入口与首次启用提示
tmux capture-pane -pt agent-remote-tailscale -S -80
```

首次若提示 Serve 未启用，打开日志给出的授权链接，启用 HTTPS certificates；取消页面可能默认勾选的可选 Funnel，再提交。Serve 提供 tailnet 内访问，Funnel 用于公网访问，此方案使用 Serve。授权后原进程通常会自动继续，无需重复启动。详见 [Tailscale 官方说明](https://tailscale.com/docs/features/tailscale-serve)。

成功后日志会显示 `https://<设备名>.<tailnet名>.ts.net/`。使用实际输出的地址，不加 `:4318`。访问过程为：

```text
手机（已连接 Tailscale）→ Mac 的 Tailscale HTTPS :443 → 127.0.0.1:4318
```

手机浏览器打开该地址并输入原 Access PIN；PIN 可从 `tmux capture-pane -pt agent-remote-web -S -80` 查看。建议手机切到蜂窝网络验证登录与会话画面更新。

以下 `<实际域名>` 替换为日志给出的域名。首次证书签发可能稍慢，超时后先检查日志再重试，不要跳过证书校验：

```bash
curl --noproxy '*' -fsS --max-time 20 'https://<实际域名>/api/health'
tailscale serve status --json

# 仅停止 Tailscale 入口，保留本地服务
tmux kill-session -t agent-remote-tailscale
```

前台 Serve 配置可能只出现在 JSON 的 `Foreground` 下；纯文本 `tailscale serve status` 显示 `No serve config` 时，仍应检查 JSON 和实际 HTTPS 请求。上述方式没有使用 `--bg`，转发随 tmux 中的进程停止；Mac 重启后需重新启动本地服务和转发 session。

### Sealtun 脚本

仓库提供 [launch-public.sh](../.agents/skills/launch-public/scripts/launch-public.sh)，需要本机有 Bun、tmux、curl、lsof。公网模式另外需要 Sealtun 且已登录。直接运行脚本只负责服务与隧道，不发飞书。skill 也默认不发；只有用户说「同步飞书」时才用 lark-cli 发通知，可与本地、公网、Tailscale 任意组合。

```bash
# 仅本地 127.0.0.1:4318
bash .agents/skills/launch-public/scripts/launch-public.sh start
# 本地 + Sealtun 公网（复用已有隧道，没有则新建）
bash .agents/skills/launch-public/scripts/launch-public.sh start-public
# 构建并原地重启；已有隧道则复用，不新建公网入口
bash .agents/skills/launch-public/scripts/launch-public.sh refresh
# 查看日志
tmux capture-pane -pt agent-remote-web -S -80
# 停止服务；有对应隧道则 stop，保留云端入口资源
bash .agents/skills/launch-public/scripts/launch-public.sh stop
```

脚本固定使用 `agent-remote-web` 和端口 `4318`，服务监听回环并启用代理头。本地新启生成 6 位 PIN 且不轮换已有 PIN；`start-public` 在本脚本新拉起服务时才会 `--rotate-pin`。refresh 保留现有 PIN。脚本输出含 URL 和 PIN，请勿提交或公开日志。

该脚本按默认数据目录设计；自定义 `CAR_DATA_DIR` 时应同时设置指向该目录数据库的 `CAR_DB`，并确保 tmux 中启动的服务继承相同配置。需要自定义端口或复杂启动环境时，使用自行管理的 tmux 启动命令。

### 公网与 Tailscale 同时使用

先启动或复用 Sealtun，再按上面的步骤启动 Tailscale Serve，两者都转发到 `127.0.0.1:4318`。不需要第二份 Agent Remote，也不需要轮换 PIN。两个域名下通常需要分别登录，但看到的是同一套会话、文件与状态。公网入口保留期间，服务仍可从公网访问；Tailscale 的访问限制只作用于私有入口。

只关闭公网时，从 `sealtun list --json` 找到指向本项目 `4318` 的 tunnel，执行 `sealtun stop <tunnel_id>`；只关闭 Tailscale 时停止 `agent-remote-tailscale`。这两种操作都保留共用本地服务。不要用公网脚本的 `stop` 来关闭单个入口，因为它也会停止本地服务。

## 更新与停止

本地、Sealtun 或双入口部署使用上述 `refresh`：重启本地服务，已有隧道则复用，不会因为 refresh 新建公网入口。保留已有 `agent-remote-tailscale` session，并验证当前实际启用的入口。不要为了更新代码删除隧道或换端口；未知进程占用端口时先确认归属。

更新后检查本地和远程首页、`/api/health`、登录后的会话列表。前端有变化时比较远程 HTML 和本地 `apps/web/dist/index.html` 引用的资源哈希。接口指南更新后，检查 `/agent-guide.md` 返回 Markdown 且与源文件一致。

部署必须包含 `docs/agent-guide.md`；它由服务直接读取，不随前端打包。缺失或为空时 `/agent-guide.md` 返回 503。指南按文件读取，无需重启即可反映正文变化。

只停止本地服务使用 `tmux kill-session -t agent-remote-web`，这会让所有入口失去后端。停止整个项目时还需关闭所有已启用入口；Sealtun 脚本的 `stop` 处理本地服务与公网隧道，Tailscale session 需另行停止。

## 数据与权限

登录后可以控制终端，文件接口可访问运行服务的 macOS 用户有权限的整个文件系统。终端输入和按键操作显式指定 `surfaceId`；文件与 Git 接口使用路径，创建和拓扑操作使用各自目标 ID。当前没有只读模式、多用户隔离或内置 2FA。

| 数据 | 保存与清理 |
| --- | --- |
| `state.db` | 状态、配置、Session、未读与审计元数据；不存终端全文和 prompt |
| `hook.json` | 本机 Hook 的地址与独立长密钥，服务启动时写入，权限为 0600 |
| `uploads/YYYY-MM-DD/<UUID>/<原文件名>` | 已上传附件，日期按 UTC；同级 `<UUID>.json` 保存所属 surface、大小等元数据，不记录 prompt |
| 网页草稿 | 仅当前页面内存，刷新或登出即清除 |

上传中断会清理本次暂存目录，成功附件不自动过期，也不会随会话关闭删除。请按需管理 uploads；删除后历史引用失效。数据库包含认证材料，数据目录与其备份应只对受信任用户开放。

审计日志默认同时按 30 天和 10 万条限制保留，超期或超量的旧记录会被删除。启动时清理已有日志，运行期间每 5 分钟及每写入 100 条清理；条数上限小于 100 时按该上限分批。清理间隙最多暂超一个批次减一条。清理失败不影响已经完成的控制操作，会在运行诊断中记录并于下次清理重试。删除释放的数据库页面可供后续写入复用，不主动执行可能阻塞服务的 `VACUUM`，所以文件大小不会立刻缩小。

PIN 登录有按来源的指数锁定及全局失败闸门，429 响应携带 `Retry-After`。Session Cookie 使用 HttpOnly、SameSite=Lax，HTTPS 时添加 Secure。限流不能代替可信网络入口。

Hook 使用独立密钥，接收端只接受本机回环且拒绝带 `X-Forwarded-For` 的请求。cmux CLI 调用使用参数数组；文件写入检查内容类型与浏览器跨站来源，上传使用原始字节体。确认字段防止误操作，不构成额外权限隔离。

## 排障

| 问题 | 处理 |
| --- | --- |
| 找不到 PIN / 登录失败 | 查看原服务日志；确认入口对应正确实例，勿反复尝试旧 PIN |
| 登录锁定 | 等待 Retry-After；需手动解锁时给原启动命令加 `--unlock` 后重启 |
| 需要撤销旧登录 | 给原启动命令加 `--rotate-pin` 后重启，保留原监听、代理和数据配置 |
| Hook 失联 | 检查服务与 Hook 配置，运行安装器；轮换 Hook 密钥后重新打开 Agent 会话 |
| health 正常但没有终端 | 登录后读取 `/api/diagnostics`，核对拓扑最近成功时间、连续失败次数及最近错误；health 只证明 HTTP 存活 |
| 新建 tab 后 Agent 没启动 | 检查白名单命令、CLI 安装与 Shell 环境；复用已创建 tab，观察输出，不重复创建 |
| 代理返回 413 / 上传中断 | 同时检查代理请求体限制与超时；应用上传上限见接入指南 |
| 指南返回 503 | 检查部署中的 `docs/agent-guide.md` 是否存在且非空 |

登录后的 `/api/audit` 可查看最近操作元数据。发送与创建结果未知时的恢复流程见 [Agent 接入指南](agent-guide.md#5-观察未知结果与恢复)。

登录后的 `/api/diagnostics` 提供本次进程的拓扑、Hook、存储模式、审计清理和最近错误摘要；完整字段及判读方式见 [接口合同](agent-guide.md#3-http-合同)。Hook 接收成功但未应用时优先检查 surface 关联；没有新事件可能只是 Agent 空闲。`storage.persistent:false` 表示不会持久化，真实 SQLite 的 `:memory:` 模式也属于此情况；正常生产数据库打开失败会明确报错，不会静默内存降级。
