---
name: launch-public
description: >
  启动本仓库的 CMUX Agent Remote。只说「拉起来」「运行起来」「启动」时默认只起本地服务，不开公网也不开 Tailscale。
  「拉起来到公网」「运行到公网」「开到公网」「挂公网」才用 Sealtun 公网暴露。
  「拉起来到 tailscale」「运行到 tailscale」才开 Tailscale Serve。
  「拉起来到公网和 tailscale」两个入口一起开。
  飞书是独立开关，可与本地 / 公网 / Tailscale / 双入口 / 刷新任意组合。默认不发。
  只有本轮说「同步飞书」「发飞书」「并同步飞书」（如「拉起来并同步飞书」「拉起来到公网并同步飞书」）才发送地址、Access PIN 和可粘贴的 Agent HTTP 控制说明。
  也用于公网原地刷新、更新线上服务，或关闭相应入口 / 停掉 Agent Remote。
  当用户说上述语句、或运行 /launch-public 时使用。
metadata:
  short-description: Agent Remote 默认本地且不发飞书；入口和飞书都要明确说
---

# 启动 Agent Remote

按用户请求启动本机服务和选定入口。Skill 本身不授予额外外部操作权限。

仓库根：本 skill 所在 repo。端口固定 `4318`。服务只听回环，不要加 `--lan`。
共用依赖：`bun`、`tmux`、`curl`、`lsof`；公网需要 `sealtun`，Tailscale 需要 `tailscale`，发送飞书才需要 `lark-cli`。

长任务备注与端口检查遵循 [部署指南](../../../docs/deployment.md#tmux-任务备注与端口检查)。脚本会列出现有任务和 TCP 监听，启动 / 刷新时写入元数据，复用时补齐备注；手动创建的 Tailscale 等 session 也按该约定填写，`@port` 写其监听端口而非上游目标端口。

## 选择访问方式

| 用户意图 | 执行方式 |
| --- | --- |
| 「拉起来」「运行起来」「启动」「拉起 Agent Remote」「/launch-public」，未指定入口 | **只起本地**。不要跑 Sealtun，不要开 Tailscale |
| 「拉起来到公网」「运行到公网」「开到公网」「挂公网」或明确 Sealtun | Sealtun 公网流程 |
| 「拉起来到 tailscale」「运行到 tailscale」或明确 Tailscale / 私有入口 | 读取 [Tailscale 操作](references/tailscale.md)，不要运行 `start-public` |
| 「拉起来到公网和 tailscale」或明确两个一起 | 先执行 Sealtun 公网流程，再按 Tailscale 操作添加入口；只运行一份本地服务 |
| 另加「同步飞书」「发飞书」「并同步飞书」 | **正交**：先按上面选定的入口启动或刷新，成功后再发飞书。可与本地、公网、Tailscale、双入口、刷新任意组合。没说这句就不要发；不要因为会话里曾经发过就再发 |

默认规则只针对**新启动**。刷新保留现有入口，不要因为「刷新 / 拉起来」就把已有公网或 Tailscale 拆掉，也不要给纯本地部署新建远程入口。停止按用户指定范围执行。新增一种入口不会自动关闭另一种；用户明确要求「只保留」某种入口时，才停止另一种入口。双入口使用相同 PIN，但各域名需要分别登录。Tailscale 不会限制仍在运行的 Sealtun 公网入口。

`launch-public.sh` 参数：`start`（仅本地）、`start-public`（本地 + Sealtun）、`refresh`、`stop`。不要向脚本传 `tailscale` / `both`。

## 拉起本地（默认）

1. 确认 `bun`、`tmux`、`curl`、`lsof` 都在 PATH。缺哪个就停，告诉用户装哪个。
2. 跑脚本：

```bash
bash .agents/skills/launch-public/scripts/launch-public.sh start
```

stdout 是一行 JSON：`ok`、`url`（此时等于 `local`）、`pin`、`port`、`tmux_session`、`local`、`logs`、`stop_server`。`ok != true` 时按 `error` 修。

3. 只验证 `http://127.0.0.1:4318/`。回复本地地址、tmux session、看日志和停止命令。不要把本地地址说成公网地址。没说同步飞书就不要发飞书。

## 拉起公网

1. 确认 `bun`、`tmux`、`sealtun`、`curl`、`lsof` 都在 PATH。缺哪个就停，告诉用户装哪个。没说同步飞书时不检查 `lark-cli`。
2. 跑脚本（超时至少 180s；`sealtun expose` 可能要等 Pod ready）：

```bash
bash .agents/skills/launch-public/scripts/launch-public.sh start-public
```

stdout 是一行 JSON：`ok`、`url`、`pin`、`port`、`tmux_session`、`tunnel_id`、`local`、`logs`、`stop_server`、`stop_tunnel`。`ok != true` 时按 `error` 修，不要发飞书。

3. 验证本地与公网首页能访问。双入口模式继续执行 Tailscale 流程，再汇总两条地址及各自可达性；部分成功时明确报告，保留已成功入口。没说同步飞书就直接回复地址与管理命令。

## 飞书通知（本轮必须明确说同步）

飞书不改变入口选择。本轮没说「同步飞书」「发飞书」「并同步飞书」就跳过整节，即使会话里以前发过也不要发。说了才检查 `lark-cli`，按**本轮实际启用的入口**发送（本地用 `http://127.0.0.1:4318`，公网用 Sealtun URL，Tailscale 用 tailnet HTTPS；双入口就两段）。

确认 `lark-cli` 可用。收集用于辨认当前宿主机的低敏设备信息。只收集设备名称、型号、系统版本、CPU 架构、当前默认网卡的局域网 IP；不要收集或发送序列号、Hardware UUID、MAC 地址、Apple ID、用户名、完整网络配置：

```bash
device_name="$(scutil --get ComputerName 2>/dev/null || hostname -s)"
device_model="$(sysctl -n hw.model 2>/dev/null || echo 未知)"
os_version="$(sw_vers -productName) $(sw_vers -productVersion) ($(sw_vers -buildVersion))"
cpu_arch="$(uname -m)"
default_interface="$(route -n get default 2>/dev/null | awk '/interface:/{print $2; exit}')"
lan_ip="$(ipconfig getifaddr "$default_interface" 2>/dev/null || echo 未连接)"
```

把可整段粘贴的控制说明发给用户。先解析收件人，再按模板填入后发送。飞书正文唯一源是 `templates/feishu-notice.md`，不要自己改写成短通知。单入口用该入口 URL；双入口分别渲染两份模板合并成一条消息，共用 PIN。标题标明「本地」「公网」或「Tailscale」，Tailscale 段补充「访问设备必须连接同一 tailnet 且有访问权限」，不要把两个 URL 塞进一个 `__URL__` 占位符。

```bash
# 收件人邮箱与备用 open_id 写在本机 ~/.cmux-agent-remote/feishu-recipient.env（EMAIL=、OPEN_ID=），不入库
. ~/.cmux-agent-remote/feishu-recipient.env
lark-cli contact +search-user --query "$EMAIL" --as user --format json
```

用返回的 `open_id`。搜不到再用该文件里的 `$OPEN_ID`。`title` 按入口写：本地「Agent Remote 已在本地」，公网「Agent Remote 已上公网」，Tailscale「Agent Remote 已上 Tailscale」；刷新在后面加「（原地刷新）」。然后：

```bash
template=".agents/skills/launch-public/templates/feishu-notice.md"
title="Agent Remote 已上公网"
notice="$(sed -e "s|__TITLE__|$title|g" -e "s|__URL__|$url|g" -e "s|__PIN__|$pin|g" \
  -e "s|__DEVICE_NAME__|$device_name|g" -e "s|__DEVICE_MODEL__|$device_model|g" \
  -e "s|__OS_VERSION__|$os_version|g" -e "s|__CPU_ARCH__|$cpu_arch|g" \
  -e "s|__LAN_IP__|$lan_ip|g" "$template")"
lark-cli im +messages-send --as user --user-id <open_id> --markdown "$notice"
```

飞书失败仍要把 `url` / `pin` 和指南地址当面告诉用户。

回复用户时写清：入口地址与访问条件、验证结果、tmux session 名、启动命令、端口、看日志、怎么停。PIN 已经在飞书里就不要再贴一遍；未发飞书时可给用户原服务日志的查看命令。

## 运行中原地刷新

服务已经在运行且代码有改动时，优先原地更新，不要另起端口、tmux session 或隧道。仅 Tailscale 部署按 [Tailscale 操作](references/tailscale.md) 刷新，不调用 `start-public`。纯本地或已有公网 / 双入口执行：

```bash
bash .agents/skills/launch-public/scripts/launch-public.sh refresh
```

`refresh` 会先构建最新前端，再重启同名 `agent-remote-web`，复用端口 `4318` 和数据库中的现有 PIN。已有 Sealtun 隧道则复用（停着的会 `start`），**不会新建**公网入口。不要为了发布代码而 stop / cleanup 隧道；只有用户要公网且原入口确实无法复用时才创建新入口，并明确告知用户地址发生变化。

如果 `4318` 正在监听但不属于 `agent-remote-web`，脚本会停止并报错，禁止为追求原地更新而误杀未知进程。刷新后必须验证本地 HTTP 状态；原本就有公网时再验公网。前端有改动时还要确认远程 HTML 引用的资源哈希与 `apps/web/dist/index.html` 一致。

双入口刷新后还要验证 Tailscale URL，保留 `agent-remote-tailscale`。刷新同样默认不发飞书；本轮说了同步飞书才按上面发送，标题标明原地刷新和对应入口。

## 关掉

- 「关掉公网」：从 `sealtun list --json` 找到目标为本项目 `4318` 的 tunnel，执行 `sealtun stop <tunnel_id>`；保留本地服务与 Tailscale。不要调用下面的 `stop` 脚本。
- 「关掉 Tailscale」：按 Tailscale 参考停止本项目转发，保留本地服务和公网入口。
- 「关掉两个入口」：执行上述两项，保留本地服务。
- 「停掉 Agent Remote / 全部停掉」：停止本项目 Tailscale 转发及 Sealtun 隧道，再停止 `agent-remote-web`。没有部署过的入口无需安装对应工具。

以下脚本停止本地服务；若本机有 Sealtun 且存在对应隧道，会一并 `sealtun stop`（保留云端入口，不 `cleanup`）。若还有 Tailscale，必须另外停止其 session：

```bash
bash .agents/skills/launch-public/scripts/launch-public.sh stop
```

用户明确说删掉隧道资源时才 `sealtun cleanup <tunnel_id>`。

## 约束

- 本地新启：`--trust-proxy --pin-length 6`，不轮换 PIN。
- 公网首次把服务拉起来：`--trust-proxy --pin-length 6 --rotate-pin`。已在跑则复用，不因添加入口轮换 PIN。
- 原地刷新用 `--trust-proxy --pin-length 6` 重启，保留现有 PIN。
- Sealtun 已有指向 4318 的隧道就复用；停着的先 `sealtun start`。只有明确要公网且没有可复用隧道时才 `sealtun expose 4318 --rate-limit 60/m --audit`。
- 不要打印 Hook 密钥，不要把 PIN 写进仓库 / commit / 文档。
- 飞书设备信息仅用于区分当前运行宿主机；禁止发送序列号、Hardware UUID、MAC 地址、Apple ID、用户名等可持久识别设备或用户的信息。
- sealtun 未登录：让用户本机跑 `sealtun login`，等浏览器授权，再重跑脚本。不要替用户开交互式 login 死等。
