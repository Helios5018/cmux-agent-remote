# Agent 接入指南：HTTP 与 WebSocket

合同版本：agentApiVersion 1。仅需 HTTP 客户端，不需要安装 Skill、MCP 或 SDK。

本文件是接口合同与调用示例的唯一文档源，服务通过 `/agent-guide.md` 提供相同正文。章节依次覆盖接入、认证、HTTP 合同、操作示例、失败恢复、客户端状态和 WebSocket；首次使用从第 1 节开始。

## 1. 接入条件与最短流程

先取得用户授权范围、可信的 `baseUrl` 和 Access PIN。baseUrl 是服务根地址，不含网页的 `#/`、`#/s/...`。所有下文路径都相对于 baseUrl。Access PIN 用来登录，Session Cookie 用来持续调用；Hook 密钥独立且只用于本机 Hook，外部 Agent 不使用它。

最短流程：`POST /api/auth/login` → `GET /api/info` → `GET /api/tree` → `GET /api/surfaces/<UUID>/context` → 核对目标后 `POST .../input` → 观察输出和实际任务结果。

下面是一套可直接在 Python 3 中运行的 HTTP 示例；把它保存在客户端自己的私有状态目录或进程内，不写进远端项目仓库。依赖只有标准库，所有正文用 JSON 序列化，所有查询参数用 URL 编码。`http()` 不自动重试请求，也拒绝重定向，避免写操作被重放或凭证被转发到另一个地址。

```python
import getpass, json, os, pathlib, urllib.request, urllib.parse, http.cookiejar

baseUrl = input("可信服务根地址: ").rstrip("/")
privateDir = pathlib.Path(input("客户端私有状态目录（绝对路径）: ")).expanduser()
privateDir.mkdir(parents=True, exist_ok=True, mode=0o700)
os.chmod(privateDir, 0o700)
jarPath = privateDir / "cookies.txt"
jar = http.cookiejar.MozillaCookieJar(str(jarPath))
if jarPath.exists():
    jar.load(ignore_discard=True)

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar), NoRedirect())

def http(method, path, body=None, query=None, raw=None, headers=None, binary=False):
    url = baseUrl + path
    if query:
        url += "?" + urllib.parse.urlencode(query)
    hdr = dict(headers or {})
    data = raw
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        hdr["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=hdr, method=method)
    with opener.open(req, timeout=120) as response:
        payload = response.read()
        if binary:
            return payload
        if response.headers.get_content_type() != "application/json":
            raise RuntimeError("非合同响应；写请求的结果未知，不自动重试")
        return json.loads(payload)

session = http("GET", "/api/auth/session")
if not session["authenticated"]:
    pin = getpass.getpass("Access PIN: ")
    http("POST", "/api/auth/login", {"token": pin})
    del pin
    # 创建前限制权限，避免 Cookie 曾以宽松权限落盘。
    fd = os.open(jarPath, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.close(fd)
    os.chmod(jarPath, 0o600)
    jar.save(ignore_discard=True)
info = http("GET", "/api/info")
assert info["agentApiVersion"] == 1
# 首次保存 instanceId；已有记录时必须比较，不能直接覆盖预期值。
tree = http("GET", "/api/tree")
# 根据用户任务，在 tree.workspaces[].panes[].surfaces[] 中选择真实 UUID。
surfaceId = input("已核对的目标 surface UUID: ")
context = http("GET", f"/api/surfaces/{surfaceId}/context")
assert context["instanceId"] == info["instanceId"]
print(context)
```

在已有 Agent 中发送任务：先核对实例、UUID、程序、目录与任务授权，再调用：

```python
task = input("本次任务正文: ")
result = http("POST", f"/api/surfaces/{surfaceId}/input", {"text": task, "submit": True})
assert result.get("ok") is True
observed = http("GET", f"/api/surfaces/{surfaceId}/context")
```

不要把未知前台程序当 Shell。普通 Shell 收到的任务文本会被当命令执行；Agent 收到的 Shell 命令也可能仅被当作对话。

## 2. 登录、连接身份与会话复用

除健康检查、在线指南和 auth 路由外，以下业务接口都需登录。登录体 `{token: PIN}`，成功返回 `{authenticated:true,serverVersion}` 并设置 `car_session` Cookie。`GET /api/auth/session` 无登录时仍是 200，返回 `authenticated:false`。`POST /api/auth/logout` 撤销当前 Cookie 对应 Session，返回 `authenticated:false`，随后清理客户端 Cookie 文件。

Cookie 有效期为 30 天；服务端也检查 Session 的最近访问时间，并持久化登录信息以支持重启恢复。以实际 session 响应为准，不以本地文件存在推断仍已登录。401 后使用已授权的新凭证登录，不循环猜 PIN。429 必须遵守 `Retry-After` 秒数。

也接受 `Authorization: Bearer <PIN>` 和 `x-car-token: <PIN>`，但没有有效 Cookie 时每次请求会创建一个新 Session，且不会通过这条路径发回 Cookie。持续操作用一次登录后复用 Cookie，尤其删除准备与确认必须是同一 Session。

`GET /api/info` 返回且仅返回：

```json
{"instanceId":"UUID","serverVersion":"0.1.0","agentApiVersion":1,"demo":false,"guidePath":"/agent-guide.md"}
```

响应 `Cache-Control: no-store`。instanceId 来自服务数据库 settings 的 `instance_id`，与 URL、PIN、进程、机器硬件无关。重启、PIN 轮换、隧道更换、数据库备份恢复保持 ID；新数据库产生新 ID；复制数据库也会复制 ID。实际数据库位置由服务端 `config.dbPath` 决定（`CAR_DB` / `--db` 可独立指定），改变数据目录不一定改变数据库。ID 是数据身份提示，不是认证凭据；只有可信地址及正常认证之后才能辅助关联。兼容性增字段保持版本 1，破坏性变更升级 agentApiVersion。

启动流程在显式 PIN 改变或 `--rotate-pin` 时清除持久化 Session，然后建立新的 SessionManager；常规重启不会清除。不要把外部凭证文件变化当成运行进程已经换 PIN，也不要把这一启动行为当作通用实时撤销协议。当前 Session 可通过 logout 撤销，没有按设备管理其他 Session 的接口。

## 3. HTTP 合同

JSON 错误通常为 `{error:{code,message}}`。HTTP 200/201 仍需检查内容类型和响应结构；HTML 是入口或协议异常。除特别说明外，写成功返回 `{ok:true}`。写请求不要配置自动重试。任何接口看到的拓扑、状态、目录可能在下一刻变化，本版没有原子读写、任务幂等或跨客户端锁。

### 发现、现场、终端

| 方法与路径 | 参数、返回与副作用 |
| --- | --- |
| GET `/agent-guide.md` | 匿名 Markdown，`text/markdown; charset=utf-8`、`no-cache`；缺失或空源文件 503，不返回 SPA HTML |
| GET `/api/health` | 匿名 `{ok,version,demo,now}`，`no-store`；只证明 HTTP 存活，cmux 和存储诊断见下项 |
| GET `/api/diagnostics` | 需登录，`no-store`；运行诊断合同见下文；读取不触发 cmux 调用或数据库清理 |
| GET `/api/info` | 实例合同见上节 |
| GET `/api/tree` | `{workspaces,pidIndex,fetchedAt}`；Workspace → Pane → Surface，含普通 Shell；读取同时同步状态引擎拓扑 |
| GET `/api/agents` | `{summary,groups,generatedAt}`；groups 含 `{group,agents}`，group 为 NEEDS_YOU / WORKING / IDLE |
| GET `/api/agents/:surfaceId` | `{agent,snapshot}`，snapshot 可 null；**会标记已读**，可能把 RESPONDED_UNREAD 改为 IDLE |
| GET `/api/agents/:surfaceId/cwd` | `{path:string或null}`，只探测目标 surface；不是项目身份，失败或不存在可为 null |
| POST `/api/agents/:surfaceId/read` | 无正文；`{ok,agent}`，显式已读 |
| GET `/api/surfaces/:surfaceId/context` | surfaceId 必须 UUID；聚合合同见下一节；不标记已读、不推进输出 tracker、不发按键 |
| GET `/api/surfaces/:surfaceId/output` | 可选 `lines`（默认服务配置 400）、`scrollback=1`；`{surfaceId,surfaceRef?,workspaceId?,content,revision,fetchedAt}`；此旧接口仍更新 SnapshotTracker，状态推断由轮询器负责，避免频繁改变读取限额 |
| GET `/api/surfaces/:surfaceId/grid` | 彩色网格 `{surfaceId,columns,viewportRows,scrollbackRows,historyRows,scrolledRows,altScreen,foreground,background,cursorColor?,cursor,styles,spans,revision,fetchedAt}`；用于还原 TUI；底层 replay 的回滚最多 240 行 |
| GET `/api/surfaces/:surfaceId/history` | `lines` 默认且最多为服务配置（默认 5000），至少 1；`drop` 默认 0，去掉与网格重叠的尾部；`{text,totalLines,droppedTail,truncated}`，纯文本 scrollback、不进 tracker；不保证全屏 TUI 历史可取 |
| POST `/api/surfaces/:surfaceId/input` | `{text,submit?:true}`，text 最多 20000 个 JS 字符；submit false 只打字；空 text 且 submit true 只发 Enter；成功仅确认输入交付 |
| POST `/api/surfaces/:surfaceId/key` | `{key,confirm?,repeat?}`；repeat 默认为 1，仅 ctrl+c 允许设为 2（服务端间隔 100 ms 连按，用于退出 Agent；不自动重试，返回成功仅表示按键已发送）；key 为 enter / escape / tab / up / down / left / right / ctrl+c / ctrl+p / alt+up；ctrl+c 需 confirm true，缺少返回 428；不提供 ctrl+d。alt+up 对应 Codex 的 Option+↑（排队消息 / 异步提问） |
| POST `/api/surfaces/:surfaceId/scroll` | `{action:"pageup"或"pagedown"或"bottom"}`；`{ok,grid}`；改变真实 TUI 视图，bottom 最多 12 步 pagedown；结束后主动复位 |
| POST `/api/surfaces/:surfaceId/title` | `{title}`，trim 后 1–80 字符；修改真实 tab 标题 |
| POST `/api/surfaces/:surfaceId/close` | `{confirm:true}`，关真实 tab 并结束其中进程；最后一个 tab 409 LAST_SURFACE；未确认 428 |
| GET `/api/audit` | `{entries:[{at,action,surfaceId?,detail?}]}`，最近 100 条元数据，不含 prompt、终端全文，不是任务记录 |

运行诊断返回 `{now,demo,startedAt,uptimeMs,topology,hooks,storage,audit,recentErrors}`，时间戳及持续时间单位均为毫秒，尚未发生的时间戳为 `null`：

- `topology`：`{status,lastAttemptAt,lastSuccessAt,consecutiveFailures,staleAfterMs}`，反映后台轮询；未接入轮询器时为 `null`。`status` 为 `unknown`（尚未完成）、`ok`、`degraded`（刷新失败）或 `stale`（上次成功已超过 `staleAfterMs`，默认 10 秒）。失败不覆盖上次成功时间，成功清零连续失败次数；成功取得空拓扑也算成功。`demo:true` 时这些结果来自假 cmux。
- `hooks`：`{lastReceivedAt,lastAppliedAt,lastAgent,lastOutcome}`。接收时间只统计通过鉴权及信封校验的事件；应用时间仅在状态引擎成功关联并应用事件后更新。`lastOutcome` 为 `applied`、`ignored`（不关心的事件）、`unresolved`（未关联到 surface）或 `null`（未收到或尚未完成处理）。事件名、payload 不进入诊断；长期无事件可能只是空闲，不直接判为故障。
- `storage`：`{driver,persistent}`，驱动为 `bun` / `node`（真实 SQLite）或 `memory`（显式无存储测试替身）；SQLite `:memory:` 的 `persistent` 也是 `false`。生产 SQLite 打开失败会报错，不会自动降级。
- `audit`：`{maxAgeMs,maxRows,cleanupIntervalMs,cleanupBatchSize,lastAttemptAt,lastSuccessAt,consecutiveFailures}`。保留策略及清理状态；启动清理一次，运行期间每 5 分钟或每写入 `min(100,maxRows)` 条再清理。每次成功清理后同时满足年龄和条数限制，批次间最多暂超 `cleanupBatchSize-1` 条；清理失败时限制可能暂时无法满足。
- `recentErrors`：最近最多 20 条 `{at,source,code,message}`，新错误在前，仅保存在本次进程内存中。`source` 为 `topology` / `surface.grid` / `surface.text`（后台轮询）、`api`（未处理异常）或 `audit.cleanup`；`code` 仅保留已知安全代码，否则为 `UNKNOWN`，`message` 为固定中文摘要，不返回异常原文、路径、命令或堆栈。恢复后历史错误仍保留，当前是否恢复应看对应状态和时间。

Agent 状态为 WORKING / NEEDS_APPROVAL / NEEDS_INPUT / RESPONDED_UNREAD / IDLE / POSSIBLY_STALE / ERROR / CLOSED；常用 Agent 字段包括 agent、sessionId、workspaceId、paneId、surfaceId、status、currentActivity、hookConnected、lastActivityAt、lastViewedAt、outputRevision。状态和输出不构成任务完成协议。

context 响应：

```json
{
  "instanceId":"UUID",
  "surface":{"id":"UUID","title":"Codex","type":"terminal","paneId":null,"workspaceId":"UUID","workspaceTitle":"Project"},
  "agent":{"kind":"codex","sessionId":null,"status":null,"currentActivity":null,"hookConnected":false,"lastActivityAt":null},
  "cwd":null,
  "git":null,
  "output":{"content":"最近文本","fetchedAt":0,"limitLines":200,"limited":false},
  "issues":[{"section":"cwd","code":"CWD_UNAVAILABLE","message":"无法确定目标会话的工作目录"}],
  "fetchedAt":0
}
```

`agent`、`cwd`、`git`、`output` 均可 null。发现类型但尚无状态时保留 kind，status 和 lastActivityAt 为 null，不能默认为 IDLE；`agent:null` 也不证明前台就是 Shell。普通 Shell 没状态、非 Git 目录 `git:null` 都正常。Git 非空为 `{root,branch,hasChanges}`，root 为该仓库或 worktree 根目录；detached 时 branch 为 HEAD；不执行 fetch。

输出最多最近 200 行、64 KiB，截取尾部且保持 UTF-8 完整。limited 表示本次截断或达到读取上限，即使 false 也不能声称历史完整。这里没有 outputRevision；需要时客户端自行比较摘要。时间为毫秒时间戳；总 fetchedAt 是聚合完成时间，分段在期间可能变化，不是事务快照。

context：401 未登录，400 非 UUID，404 拓扑明确不存在，503 核心拓扑失败；已定位但分段失败返回 200、null 和 issues。section 为 cwd / git / output，对应 CWD_UNAVAILABLE / GIT_UNAVAILABLE / OUTPUT_UNAVAILABLE；message 是简短说明，不包含原始命令环境。采集期间目标消失也可能得到部分结果，写前重新核对。

### 创建与拓扑写操作

| 方法与路径 | 参数与响应 |
| --- | --- |
| POST `/api/workspaces` | `{cwd,launch?:null}`；cwd 为存在的绝对目录，1–4096 字符且无控制字符；launch 可 null / claude / codex / grok / pi；201 `{ok,surfaceId,surfaceRef,workspaceId,paneId?,launchError?}` |
| POST `/api/surfaces` | `{paneId,workspaceId?,launch?:null}`；paneId/workspaceId 1–128 字符；201 `{ok,surfaceId,surfaceRef,paneId?,workspaceId?,cwd,launched,launchError?}`；目录根据同 pane 探测，可能为 null |
| POST `/api/workspaces/:workspaceId/panes` | 无正文；在已选/首个 pane 的目标 surface 右侧新建 terminal；201 `{ok,surfaceId,surfaceRef,paneId?,workspaceId?}` |
| POST `/api/workspaces/:workspaceId/title` | `{title}`，trim 后 1–80 字符，修改真实 workspace 名 |
| POST `/api/workspaces/:workspaceId/close` | `{confirm:true,surfaceIds:[当时全部UUID]}`；关闭 workspace 及进程 |
| POST `/api/workspaces/:workspaceId/panes/:paneId/close` | 同上，surfaceIds 为该 pane 当时全部 UUID；逐个关 tab，最后一个 pane 返回 409 LAST_PANE，应使用 workspace close |

launch 是枚举，不接受任意命令。workspace Shell 模式初始化为安全引用目录的 `cd -- <cwd>`；Agent 模式追加服务端白名单命令，仅 cd 成功后启动。

创建成功和初始化发送成功均不证明 cwd 已生效或 Agent 已就绪，必须读 context/输出验证。workspace 的 `launchError` 是字符串；surface 的 `launchError` 是 `{stage:"text_unknown"或"submit_unknown",message}`，出现时 launched 为 null。保留返回的 UUID，不重复创建。初始化正文已写入但 Enter 未确认时先检查画面，必要时只补 Enter。

拓扑批量关闭需最新完整集合（至少一个 ID），变化返回 409 TOPOLOGY_CHANGED；关闭部分失败可能为 503，message 说明已关闭数量，刷新后核对余项。confirm true 仅是请求确认标记，执行依据任务已有授权，不代表系统获得额外用户授权。

### 文件与上传

文件接口不依赖 cmux，可访问当前 macOS 用户允许的文件系统。统一传绝对路径，不推断服务 cwd。所有文件响应 no-store。写操作要求 application/json（上传除外），浏览器 cross-site 写入会被拒绝。错误常见 400 参数/确认令牌错误、403 权限、404 不存在、409 同名、413 超限；批量操作即便 200 也要读 ok/failed。

| 方法与路径 | 参数、响应、限制 |
| --- | --- |
| GET `/api/files/roots` | `{roots:[路径],home:路径}` |
| GET `/api/files/list` | `path`，可选 `q`（最多 200 字符）、`mode=filter或name或content`、`hidden=1`、`offset=0`（0–1000000）；默认 filter 为当前目录过滤，name/content 递归搜索；每页 100 项，`{path,parent,entries,next,limited?}`；entry 为 `{name,path,kind,size,modified,line?,excerpt?}` |
| GET `/api/files/preview` | `path`；`{path,name,size,kind,text?,truncated}`，kind=text/image/video/audio/other；文本最多 128 KiB |
| GET `/api/files/download` | `path`；原始字节，普通文件最多 20 MiB；`inline=1` 仅受支持光栅图像生效 |
| GET/HEAD `/api/files/media` | `path`；鉴权音视频流，单段 Range，206/416，64 KiB 分块，无 20 MiB 播放上限 |
| POST `/api/files/upload` | 原始字节体，**非 multipart**，headers 见下；单文件最多 512 MiB，201 `{id,name,path,size}`；关联头不代表会自动给终端发消息 |
| POST `/api/files/operation` | 下表 JSON 操作，`{ok,paths,failed?,token?}` |

搜索每轮最多 5 秒/20000 项，忽略 node_modules 和 .git，不跟随软链接；内容搜索只查不超过 128 KiB 的可预览文本。next 是下页偏移或 null，limited 表示扫描限额，分页不是稳定快照。

上传必须带齐：`Content-Type: application/octet-stream`、`x-file-name: encodeURIComponent(原文件名)`、`x-file-size: 实际字节数`、`x-surface-id: 已核对的会话ID` 和 Cookie。文件名不含路径分隔符/控制字符，UTF-8 不超过 255 字节；关联 ID 非空且最多 200 字符。上传存到服务数据目录下新 UUID 路径，不覆盖项目文件。响应丢失时先查文件或报告未知，不自动重复上传。

| action | 其余 JSON 字段与含义 |
| --- | --- |
| create | `{directory,name,kind:"file"或"directory"}`；空文件或目录，不支持正文写入 |
| rename | `{path,name}` |
| copy | `{paths:[...],directory}`，1–100 个源；单次复制最多 10000 项/512 MiB |
| move | `{paths:[...],directory}`，1–100 个源；同名不覆盖；paths 是成功移动的源路径，failed 为 `{path,message}` |
| delete_prepare | `{paths:[...],mode?:"trash"或"permanent"}`，1–100 个源；默认 permanent；返回 paths 和 token，尚未删除 |
| delete | `{token,confirm:true}`；必须同一登录 Session；token 2 分钟有效、一次使用；核对文件/目录内容未变化，最多检查 10000 项；paths 为成功删除项 |

name 1–255 字符，不含路径分隔符或控制字符。同名不覆盖。trash 使用 macOS 废纸篓，mode 绑定准备令牌；不能在 delete 阶段换模式。删除软链接仅删链接本身，禁止删除系统根目录。copy/rename/create 成功 paths 为结果路径。复制不处理软链接与特殊文件，失败时目标可能保留部分内容；跨文件系统移动先暂存复制，核对源内容未变化后发布并移除源文件，沿用复制限额。文件接口不提供编辑正文，需在已有授权下使用明确的 Shell 目标或上传再复制到新的目标路径。

### Git

`path` 是目录绝对路径（最长 8192 字符）。读取不会 fetch；错误为 400 JSON。POST 要 JSON，浏览器 cross-site 写入被拒绝。Git 命令通常超时 15 秒、输出缓冲 8 MiB，超出可能返回错误，不承诺无限列表。

| 方法与路径 | 参数与返回 |
| --- | --- |
| GET `/api/git/status` | `path`；非 Git 为 null，否则 `{root,branch,oid,upstream,ahead,behind,operation,changes,ignored,fetch}`；changes 含 path/originalPath?/index/worktree/conflict/mark |
| GET `/api/git/branches` | `path`；数组 `{ref,name,remote,current,upstream,tracking,oid,subject,date}` |
| GET `/api/git/history` | `path,ref=HEAD,offset=0`，offset 0–100000；每页 50 条，`{commits,next}`；commit `{oid,subject,author,date}` |
| GET `/api/git/commit` | `path,ref`；`{commit,files,parent}`，commit 多 message，files 含 `{path,originalPath?,status}` |
| GET `/api/git/content` | `path,file,mode,ref?`；file 为仓库相对路径；mode=staged/unstaged/untracked/commit；`{text,binary,truncated}`，工作区 mode 读当前文件，staged 读 index，commit 需 ref |
| GET `/api/git/diff` | 同 content 参数，返回 `{text,binary,truncated}`，按 mode 读差异（untracked 为当前文件内容） |
| POST `/api/git/fetch` | `{path,force?:false}`；返回 `{remote,running,attemptedAt?,succeededAt?,error?}`；更新 remote tracking refs，有副作用；不 pull/checkout/commit；默认 5 分钟复用前次结果，force 跳过该缓存；fetch 超时 30 秒 |

ref 接受 HEAD、`refs/heads/...`、`refs/remotes/...` 或完整 40–64 位十六进制提交 ID。Git 文本展示最多 256 Ki 字符；工作区文件预览最多 256 KiB。binary/truncated 要检查。Git date 为原有 ISO 日期字符串；context 和状态事件继续用毫秒时间戳。

## 4. 目录、规则与完整操作示例

workspace 是组织会话的容器，pane 是分屏，surface 是真实 tab；它们都不等同于项目。标题可变且不唯一，短引用如 surface:1 也会变；持久定位使用 UUID。项目按“已核验 instanceId + 具体 checkout/worktree 目录”区分；不同 worktree 不合并。cwd 来自目标进程探测，可能陈旧或 null，Git root 仅作辅助核对。目录迁移后重新确认定位。

了解项目时先取 context，然后按需读取 Git、README、AGENTS.md 等规则。检查父目录与目标子目录适用的规则，不能只读 cwd 下一个 AGENTS.md 就当作全部规则；终端输出不包含完整 Agent 对话。本版不自动递归读项目、不构建摘要或交接卡。

沿用第 1 节的 baseUrl、Cookie 和 http 函数：

```python
projectDir = input("已核对的远端项目绝对目录: ")
listing = http("GET", "/api/files/list", query={"path": projectDir, "hidden": "1"})
readme = http("GET", "/api/files/preview", query={"path": projectDir + "/README.md"})
git = http("GET", "/api/git/status", query={"path": projectDir})
# 根据实际存在的父目录/子目录规则，逐个使用 preview 读取。
```

创建专用 Shell 并执行无害命令：

```python
created = http("POST", "/api/workspaces", {"cwd": projectDir, "launch": None})
shellId = created["surfaceId"]
if created.get("launchError"):
    raise RuntimeError(created["launchError"])  # 保留 created，不重复创建
shellContext = http("GET", f"/api/surfaces/{shellId}/context")
# 等待并观察到 Shell 提示符、目录正确后，才执行：
http("POST", f"/api/surfaces/{shellId}/input", {"text": "pwd", "submit": True})
output = http("GET", f"/api/surfaces/{shellId}/output")
```

上传、引用与下载（小文件示例；大文件用支持流式请求的 HTTP 客户端）：

```python
localFile = pathlib.Path(input("待上传的本地文件: "))
raw = localFile.read_bytes()
upload = http("POST", "/api/files/upload", raw=raw, headers={
    "Content-Type": "application/octet-stream",
    "x-file-name": urllib.parse.quote(localFile.name, safe=""),
    "x-file-size": str(len(raw)), "x-surface-id": surfaceId,
})
preview = http("GET", "/api/files/preview", query={"path": upload["path"]})
# 在确认 surfaceId 仍为目标 Agent 后，用 JSON 传入完整路径；不要把这段对话发给 Shell。
http("POST", f"/api/surfaces/{surfaceId}/input", {
    "text": "请读取这个已上传的文件：" + upload["path"], "submit": True,
})
artifactPath = input("已观察确认的远端产物绝对路径: ")
destination = pathlib.Path(input("本任务本地下载路径: "))
# 避免静默覆盖客户端已有文件。
with destination.open("xb") as out:
    out.write(http("GET", "/api/files/download", query={"path": artifactPath}, binary=True))
```

授权范围内删除本次临时文件（两步使用同一个 Cookie，检查部分失败）：

```python
prepared = http("POST", "/api/files/operation", {
    "action": "delete_prepare", "paths": [upload["path"]], "mode": "permanent",
})
deleted = http("POST", "/api/files/operation", {
    "action": "delete", "token": prepared["token"], "confirm": True,
})
if not deleted["ok"] or deleted.get("failed"):
    print(deleted)  # 核对剩余项，不把成功项再次删除
```

临时 workspace 使用完后，重新读取 tree，从该 workspace 收集完整 surface UUID 集合，再按已有清理授权调用 close。不要关闭不属于本任务的会话。

## 5. 观察、未知结果与恢复

同一客户端对同一 surface 串行发送写请求；这不能阻止其他客户端同时输入。操作前保留最小记录：本地操作 ID、目标 UUID、时间、动作类型、正文长度/摘要和状态，无需默认长期保存完整 prompt。这个本地 ID 没有服务端幂等作用。

输入响应 ok 只证明输入交付被确认；Agent 就绪和业务任务完成必须通过输出、产物及任务要求验证。IDLE、输出不再变化、Hook turn_finished 都不能单独证明业务成功。HTTP 轮询可从 2 秒开始，无变化退到 5–10 秒；context 按需读，频繁观察用 agents/output，避免后台聚合全机输出。

| 情况 | 恢复动作 |
| --- | --- |
| 执行前明确 400/401/403/428 拒绝 | 记录被拒绝；解决原因后重新核对现场再决定下一步 |
| 401 | 使用可信凭证重登并核验实例；不猜 PIN |
| 429 | 遵守 Retry-After，保留原操作状态 |
| HTML、非合同 JSON、重定向、响应丢失、网络超时 | 写操作记为结果未知；刷新观察，不能只看 200，更不能自动重发 |
| 404 surface | 重读 tree，不拿同名 tab 自动替换旧 UUID |
| INPUT_TEXT_WRITTEN_SUBMIT_UNKNOWN（500） | 正文写入已确认，Enter 结果未知；看画面，必要时只补 Enter，不重发正文 |
| INPUT_DELIVERY_UNKNOWN（500） | 正文或单独 Enter 结果未知；先核对现场，不盲重试 |
| 创建返回 UUID 和 launchError | 复用返回 UUID，检查已有终端及初始化，不再创建 |
| 创建响应整体丢失 | 看最新 tree 识别新增会话；无法确定归属时停止重复创建并报告 |
| 部分关闭/移动/删除失败 | 核对已成功和失败项，只处理确认仍需操作的余项 |
| 新 URL / 新 PIN | 更新连接并重登，原未知操作仍保留，不重放 |
| instanceId 不同 | 视为另一实例或数据重建；重新发现、确认关联后才沿用项目记录和写目标 |

本版没有完整命令 stdout/stderr、退出码 Job API、请求去重存储、任务系统或完整对话读取。无法判断执行结果时如实报告未知，不用重复输入来探测。

## 6. 客户端最少状态与地址恢复

单次使用可只在内存中保存。跨进程继续时，以固定客户端别名（例如 home-mac）保存：

```text
<客户端私有状态目录>/agent-remote/home-mac/
  connection.json  # baseUrl、guidePath、预期 instanceId、凭证来源引用
  cookies.txt      # Session Cookie，0600
  state.json       # 项目目录、已知 UUID、最近观察、未确认操作
```

父目录仅当前用户可访问。凭证与普通项目记录分离，不进入 Git、URL 或日志；优先存秘密管理工具引用，否则本次输入 PIN，仅持久化 Cookie。不长期复制整个结构树、终端历史或项目文档；产物按任务保存，清理无用中间文件。

新地址/凭证必须来自用户或已配置可信渠道，服务不会自动发现。保持别名，更新 baseUrl/凭证来源，用新 baseUrl + guidePath 组成说明入口；地址变化新建 Cookie jar，不手工移植旧域 Cookie。用新凭证登录后核对 info.instanceId；相同保留项目定位，不同重新发现并确认关联。再读 tree/context，旧 UUID 仅作定位线索，已消失或角色变化时重新选择。连接恢复不证明旧操作未执行，保留结果未知记录。

## 7. WebSocket 与终端进阶

WebSocket `/ws` 使用同一 Cookie 鉴权，可先使用 HTTP 轮询，无需实现它才能接入。消息均为 JSON，`type` 决定结构：

| 方向 | type | 其余字段 |
| --- | --- | --- |
| 客户端 → 服务端 | `subscribe` | `surfaceId: UUID或null`，null 表示离开会话 |
| 客户端 → 服务端 | `ping` | 无 |
| 服务端 → 客户端 | `hello` | `serverVersion, now` |
| 服务端 → 客户端 | `agent.status_changed` | `surfaceId, status, agent` |
| 服务端 → 客户端 | `agent.list_changed` | `inbox` |
| 服务端 → 客户端 | `surface.snapshot` | `surfaceId, revision, content`，纯文本 |
| 服务端 → 客户端 | `surface.grid` | `surfaceId, grid`，彩色网格 |
| 服务端 → 客户端 | `pong` | `now` |
| 服务端 → 客户端 | `error` | `code, message` |

订阅属于“正在查看”，会参与已读处理，不用它替代无副作用的 context。重连后恢复订阅，并通过 HTTP 重新读取列表、拓扑和当前画面；此协议不提供断线期间的事件补发。

普通屏历史用 history；全屏 TUI 只能 pageup/pagedown 驱动真实程序翻页，结束主动 bottom，不能依赖网页替 HTTP 客户端复位。底层 terminal.scroll/mouse 不提供可靠按行滚动，replay 没有扩大回滚参数。获取完整文件用 download（遵守 20 MiB 上限），文本预览、Git diff 和终端输出都可能截断。

`POST /api/hooks/:agent` 是本机 Hook 集成入口，使用独立长密钥且只收本机回环；外部 Agent 不调用。公网服务应通过用户提供的可信入口使用；本指南不承担服务发布或凭证分发。
