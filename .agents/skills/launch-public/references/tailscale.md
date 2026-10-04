# Tailscale Serve 操作

用于用户明确说「拉起来到 tailscale」或「公网和 tailscale」一起。入口只在 tailnet 内可达，使用 Serve，不使用 Funnel。公网与私有入口均代理同一 `http://127.0.0.1:4318`，不加 `--lan`，不硬编码设备域名。

## 检查与复用

在仓库根目录执行：

```bash
command -v bun tmux curl tailscale
tailscale status --json
tailscale serve status --json
tmux list-sessions
curl --noproxy '*' -fsS --max-time 5 http://127.0.0.1:4318/ -o /dev/null
```

- 从 `tailscale status --json` 检查 `BackendState` 为 `Running`，读取 `Self.DNSName` 并移除末尾点，组成 `https://<DNSName>/`。未连接或未登录时通过 Mac 客户端连接；需要用户登录时提供明确操作，不反复重试。
- **必须检查 JSON 状态**：前台 Serve 的配置在 `Foreground` 各项下，纯文本 `tailscale serve status` 可能显示 `No serve config`，即使转发已经生效。检查顶层及 `Foreground` 内的 `TCP`、`Web` 与 `AllowFunnel`。
- 已有 HTTPS `443` 的 `/` 正确代理到本地 `4318`、无 Funnel 且在本项目 tmux 中运行，就直接复用。端口或根路径被其他服务占用时不要覆盖，也不要运行 `serve reset`；明确报告冲突，选择未占用 HTTPS 端口时在命令和 URL 中保持一致。
- 已有正确转发但不在 tmux 时先确认进程归属，再迁移本项目转发；不要误停其他服务。已被 Funnel 公开的端口不能当作私有入口直接复用。
- 服务 `4318` 已正常运行就复用，包括公网脚本启动的服务；不轮换 PIN，不新开端口。

## 启动本地服务（仅缺少时）

仅 Tailscale 时不要运行 `start-public`，也不要求安装或登录 Sealtun。本地服务未运行时先：

```bash
bash .agents/skills/launch-public/scripts/launch-public.sh start
```

已有 `4318` 服务直接复用，不轮换 PIN，不新开端口。服务保持回环监听。

## 启动转发

确认不存在冲突后执行：

```bash
tmux new-session -d -s agent-remote-tailscale \
  'tailscale serve --https=443 http://127.0.0.1:4318'
tmux capture-pane -pt agent-remote-tailscale -S -80
```

不加 `--bg`：前台 Serve 由 tmux 托管，停止该进程就撤销相应转发，Mac 重启后需重新拉起。

若日志显示 `Serve is not enabled on your tailnet`，打开日志中当前节点的授权链接。涉及登录态按项目路由使用 OpenCLI，优先复用登录态。启用 Serve 所需的 HTTPS certificates；页面可能默认勾选可选的 Funnel，**取消 Funnel 勾选再提交 Enable HTTPS**。这一配置包含在用户开启 Serve 的授权范围内，无需重复确认；没有登录态或权限时把授权链接交给用户完成，保留等待中的 tmux session，并明确入口尚未就绪。授权成功后先检查原进程，它通常会自动继续，不重复启动。

## 验证与交付

从设备状态读取实际域名；以下命令中的 `<DNSName>` 必须替换：

```bash
tailscale serve status --json
curl --noproxy '*' -fsS --max-time 20 'https://<DNSName>/'
curl --noproxy '*' -fsS --max-time 20 'https://<DNSName>/api/health'
```

首次证书签发可能导致 TLS 握手暂时超时，可在检查 tmux 日志和配置后有限重试，总等待最多 120 秒；仍失败就报告证书或连接问题，不宣称成功。不要关闭证书校验。确认 HTTPS 首页与本地首页一致；有前端更新时比较 `apps/web/dist/index.html` 的资源哈希。系统代理可能干扰检查，因此 curl 显式使用 `--noproxy '*'`。

回复实际 URL、验证范围和原 PIN 的查看方式。手机需连接同一 tailnet 并有访问权限；在 Mac 上验证不代表手机已经验收。双入口分别报告地址与结果。报告 session `agent-remote-tailscale`、实际启动命令、HTTPS 端口和目标 `4318`，并提供：

```bash
# 转发日志
tmux capture-pane -pt agent-remote-tailscale -S -80
# 项目日志 / 原 PIN
tmux capture-pane -pt agent-remote-web -S -80
# 仅停止本项目 Tailscale 入口
tmux kill-session -t agent-remote-tailscale
```

## 刷新与停止

- 仅 Tailscale 部署更新：可跑 `launch-public.sh refresh`（会重启本地服务、不新建公网隧道），保留 `agent-remote-tailscale`；确认端口归属后才能停止服务，不能误杀未知监听。不得调用 `start-public`。
- 公网 / 双入口更新：使用主 skill 的公网 `refresh` 流程，保留 Tailscale session；验证所有原有入口。
- 关闭 Tailscale：只停止确认属于本项目的 `agent-remote-tailscale` session，检查 JSON 中该转发消失。若遇到旧 `--bg` 配置，确认归属后用对应端口 / 路径的 `serve ... off` 停止，先读本机 `tailscale serve --help`；不全局 `reset`，不 `tailscale down`。
- 关闭公网：只 `sealtun stop` 本项目隧道，不停共用本地服务。
- 停掉整个项目：关闭两种已存在的入口，再停止本地服务。不要把“停止一个入口”解释成“停止整个项目”。

官方参考：[Serve](https://tailscale.com/docs/features/tailscale-serve)、[CLI](https://tailscale.com/docs/reference/tailscale-cli/serve)。
