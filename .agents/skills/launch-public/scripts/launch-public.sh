#!/usr/bin/env bash
# 启动（或复用）本机 Agent Remote。
#   start         仅本地 127.0.0.1:4318
#   start-public  本地 + Sealtun 公网
#   refresh       构建并原地重启；复用已有隧道，不新建
#   stop          停本地服务；有对应 Sealtun 隧道则 stop
# stdout 只打一行 JSON；PIN 只出现在 JSON 的 pin 字段。日志走 stderr。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
SESSION="agent-remote-web"
PORT=4318
DB="${CAR_DB:-${HOME}/.cmux-agent-remote/state.db}"
ACTION="${1:-start}"

die() {
  local msg="$1"
  printf '{"ok":false,"error":%s}\n' "$(json_str "$msg")"
  exit 1
}

json_str() {
  bun -e 'process.stdout.write(JSON.stringify(process.argv[1] ?? ""))' -- "$1"
}

need() {
  command -v "$1" >/dev/null 2>&1 || die "缺少命令：$1"
}

http_code() {
  curl -sS -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:${PORT}/" 2>/dev/null || true
}

local_up() {
  local code
  code="$(http_code)"
  [[ "$code" != "000" && "$code" != "" ]]
}

read_pin() {
  bun -e '
    import { Database } from "bun:sqlite";
    const path = process.argv[1];
    try {
      const db = new Database(path, { readonly: true });
      const row = db.query("SELECT value FROM settings WHERE key = ?").get("access_pin");
      process.stdout.write(typeof row?.value === "string" ? row.value : "");
    } catch {
      process.stdout.write("");
    }
  ' -- "$DB"
}

wait_local() {
  local i
  for i in $(seq 1 40); do
    if local_up; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

wait_local_down() {
  local i
  for i in $(seq 1 20); do
    if ! local_up; then
      return 0
    fi
    sleep 0.25
  done
  return 1
}

sealtun_logged_in() {
  sealtun status --json 2>/dev/null | bun -e '
    const raw = await Bun.stdin.text();
    try {
      const d = JSON.parse(raw);
      process.exit(d.loggedIn ? 0 : 1);
    } catch {
      process.exit(1);
    }
  '
}

find_tunnel() {
  sealtun list --json 2>/dev/null | bun -e '
    const port = String(process.argv[1] ?? "4318");
    const raw = await Bun.stdin.text();
    let list = [];
    try { list = JSON.parse(raw); } catch { process.exit(2); }
    if (!Array.isArray(list)) process.exit(2);
    const match = list.find((t) =>
      String(t.localPort ?? "") === port ||
      String(t.targetUrl ?? "").includes(":" + port)
    );
    if (!match) process.exit(2);
    process.stdout.write(JSON.stringify(match));
  ' -- "$PORT"
}

annotate_session() {
  tmux set-option -oq -t "$SESSION" @note 'Agent Remote Web 控制中心；停止后浏览器和手机无法访问'
  tmux set-option -t "$SESSION" @project 'Agent-Remote'
  tmux set-option -t "$SESSION" @lifecycle 'persistent'
  tmux set-option -t "$SESSION" @port "$PORT"
}

start_server() {
  local rotate="${1:-}"
  if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >&2; then
    die ":${PORT} 已被占用；请核对进程归属，不自动终止占用进程或更换固定端口"
  fi
  local cmd="bun run start -- --trust-proxy --pin-length 6"
  if [[ "$rotate" == "rotate" ]]; then
    cmd="${cmd} --rotate-pin"
  fi
  echo "starting ${SESSION}: ${cmd}" >&2
  tmux new-session -d -s "$SESSION" -c "$ROOT" "$cmd"
  if ! wait_local; then
    die "服务启动超时：tmux capture-pane -pt ${SESSION} -S -80"
  fi
  annotate_session
}

ensure_server() {
  local rotate="${1:-}"
  if local_up && tmux has-session -t "$SESSION" 2>/dev/null; then
    annotate_session
    echo "reuse tmux session ${SESSION}" >&2
    return 0
  fi

  if local_up; then
    echo "reuse existing listener on :${PORT} (not in tmux ${SESSION})" >&2
    return 0
  fi

  if tmux has-session -t "$SESSION" 2>/dev/null; then
    echo "tmux session ${SESSION} exists but :${PORT} is down; restarting" >&2
    tmux kill-session -t "$SESSION" 2>/dev/null || true
  fi

  start_server "$rotate"
}

refresh_server() {
  echo "building latest Agent Remote" >&2
  bun run build >&2

  if tmux has-session -t "$SESSION" 2>/dev/null; then
    echo "restarting tmux session ${SESSION} in place" >&2
    tmux kill-session -t "$SESSION"
    wait_local_down || die "停止 ${SESSION} 后 :${PORT} 仍被占用；为避免误杀未知进程，已停止原地刷新"
  elif local_up; then
    die ":${PORT} 正在运行，但不属于 tmux ${SESSION}；为避免误杀未知进程，已停止原地刷新"
  fi

  # 原地更新保留数据库中的现有 PIN；仅首次公网把服务拉起来时轮换 PIN。
  start_server
}

reuse_tunnel() {
  local info status id
  command -v sealtun >/dev/null 2>&1 || return 1
  if info="$(find_tunnel)"; then
    status="$(printf '%s' "$info" | bun -e 'const t=JSON.parse(await Bun.stdin.text()); process.stdout.write(String(t.status ?? ""))')"
    id="$(printf '%s' "$info" | bun -e 'const t=JSON.parse(await Bun.stdin.text()); process.stdout.write(String(t.tunnelId ?? ""))')"
    if [[ "$status" != "active" && -n "$id" ]]; then
      echo "starting stopped sealtun tunnel ${id}" >&2
      sealtun start "$id" >&2
      info="$(find_tunnel)" || return 1
    else
      echo "reuse sealtun tunnel ${id}" >&2
    fi
    printf '%s' "$info"
    return 0
  fi
  return 1
}

ensure_tunnel() {
  local info
  if info="$(reuse_tunnel)"; then
    printf '%s' "$info"
    return 0
  fi

  echo "creating sealtun https tunnel for port ${PORT}" >&2
  sealtun expose "$PORT" --rate-limit 60/m --audit >&2
  find_tunnel || die "sealtun expose 成功但 list 里没有 4318 隧道"
}

emit_result() {
  local tunnel_json="${1:-}"
  local pin="$2"
  bun -e '
    const rawTunnel = process.argv[1] ?? "";
    const pin = process.argv[2];
    const session = process.argv[3];
    const port = Number(process.argv[4]);
    const local = "http://127.0.0.1:" + port;
    let tunnel = null;
    if (rawTunnel) {
      try { tunnel = JSON.parse(rawTunnel); } catch { tunnel = null; }
    }
    const url = tunnel
      ? String(tunnel.endpoint || (tunnel.host ? "https://" + tunnel.host : ""))
      : local;
    if (tunnel && !url) {
      process.stderr.write("sealtun 隧道没有 endpoint\n");
      process.exit(1);
    }
    process.stdout.write(JSON.stringify({
      ok: true,
      url,
      pin,
      port,
      tmux_session: session,
      tunnel_id: tunnel?.tunnelId ?? "",
      tunnel_status: tunnel?.status ?? "",
      local,
      logs: "tmux attach -t " + session,
      stop_server: "tmux kill-session -t " + session,
      stop_tunnel: tunnel?.tunnelId ? "sealtun stop " + tunnel.tunnelId : "",
    }) + "\n");
  ' -- "$tunnel_json" "$pin" "$SESSION" "$PORT"
}

stop_all() {
  local info id
  if tmux has-session -t "$SESSION" 2>/dev/null; then
    tmux kill-session -t "$SESSION"
    echo "killed tmux ${SESSION}" >&2
  fi
  if command -v sealtun >/dev/null 2>&1; then
    if info="$(find_tunnel)"; then
      id="$(printf '%s' "$info" | bun -e 'const t=JSON.parse(await Bun.stdin.text()); process.stdout.write(String(t.tunnelId ?? ""))')"
      if [[ -n "$id" ]]; then
        sealtun stop "$id" >&2 || true
        echo "stopped sealtun ${id}" >&2
      fi
    fi
  fi
  printf '{"ok":true,"stopped":true,"tmux_session":%s}\n' "$(json_str "$SESSION")"
}

need bun
need tmux
need curl

if [[ "$ACTION" == "stop" ]]; then
  stop_all
  exit 0
fi

if [[ "$ACTION" != "start" && "$ACTION" != "start-public" && "$ACTION" != "refresh" ]]; then
  die "未知参数：${ACTION}（只用 start / start-public / refresh / stop）"
fi

need lsof
echo '现有 tmux 任务与实际 TCP 监听（端口备注仅供参考）：' >&2
tmux list-sessions -F '#{session_name} | #{@project} | port=#{@port} | #{@note}' >&2 2>/dev/null || true
lsof -nP -iTCP -sTCP:LISTEN >&2 || true

if [[ "$ACTION" == "start-public" ]]; then
  need sealtun
  sealtun_logged_in || die "sealtun 未登录。先在本机执行 sealtun login，完成浏览器授权后再跑。"
fi

cd "$ROOT"
if [[ ! -d node_modules ]]; then
  echo "bun install" >&2
  bun install >&2
fi
if [[ ! -f apps/web/dist/index.html ]]; then
  echo "bun run build" >&2
  bun run build >&2
fi

if [[ "$ACTION" == "refresh" ]]; then
  refresh_server
elif [[ "$ACTION" == "start-public" ]]; then
  ensure_server rotate
else
  ensure_server
fi

TUNNEL=""
if [[ "$ACTION" == "start-public" ]]; then
  TUNNEL="$(ensure_tunnel)"
elif [[ "$ACTION" == "refresh" ]]; then
  TUNNEL="$(reuse_tunnel || true)"
fi

PIN="$(read_pin)"
[[ -n "$PIN" ]] || die "读不到 Access PIN（${DB} 里没有 access_pin）"

emit_result "$TUNNEL" "$PIN"
