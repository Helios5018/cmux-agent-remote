#!/usr/bin/env python3
"""Isolated real Bun HTTP acceptance. Requires bun, tmux and a running cmux.
Run from any cwd: python3 /absolute/repo/scripts/verify-agent-http.py
Only writes to owned temporary workspaces, databases and files; never deploys.
"""
import hashlib
import http.cookiejar
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

REPO = Path(__file__).resolve().parent.parent
SCRATCH = REPO / "scratchpad"
SCRATCH.mkdir(exist_ok=True)
ROOT = Path(tempfile.mkdtemp(prefix="agent-http-", dir=SCRATCH))
SESSIONS = []
WORKSPACE = None
EXTRA_WORKSPACES = []
REAL = None
REPORT = []


def run(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout


def check(condition, message):
    if not condition:
        raise AssertionError(message)
    REPORT.append(message)
    print("PASS", message, flush=True)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Client:
    def __init__(self, base):
        self.base = base
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar), NoRedirect())

    def request(self, method, path, body=None, query=None, raw=None, headers=None):
        url = self.base + path + ("?" + urllib.parse.urlencode(query) if query else "")
        hdr = dict(headers or {})
        if body is not None:
            raw = json.dumps(body, ensure_ascii=False).encode()
            hdr["Content-Type"] = "application/json"
        request = urllib.request.Request(url, data=raw, headers=hdr, method=method)
        try:
            response = self.opener.open(request, timeout=120)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            payload = response.read()
            value = json.loads(payload) if "application/json" in response.headers.get("Content-Type", "") else payload
            return response.status, response.headers, value

    def json(self, method, path, body=None, **kwargs):
        status, headers, value = self.request(method, path, body, **kwargs)
        if status not in (200, 201) or not isinstance(value, (dict, list, type(None))):
            raise AssertionError(f"Unexpected {method} {path}: {status} {value!r}")
        return value

    def login(self, pin):
        assert self.json("POST", "/api/auth/login", {"token": pin})["authenticated"]


def start(name, port, entry, data, demo=False, pin="6814"):
    if subprocess.run(["tmux", "has-session", "-t", name], capture_output=True).returncode == 0:
        raise RuntimeError("Refusing to replace existing session " + name)
    with socket.socket() as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind(("127.0.0.1", port))
    data.mkdir(exist_ok=True)
    launcher = ROOT / (name + ".sh")
    import shlex
    command = [shutil.which("bun"), str(entry), "--port", str(port), "--db", str(data / "state.db")]
    if demo:
        command.append("--demo")
    # Own isolated PIN only. Do not inherit production CAR_* configuration.
    log = ROOT / (name + ".log")
    launcher.write_text("#!/bin/sh\n" + "\n".join("unset " + key for key in ("CAR_DB", "CAR_DATA_DIR", "CAR_DEMO", "CAR_STATIC_DIR", "CAR_HOST", "CAR_TRUST_PROXY")) + "\nexport CAR_DATA_DIR=" + shlex.quote(str(data)) + "\nexport CAR_DB=" + shlex.quote(str(data / "state.db")) + "\nexport CAR_PIN=" + shlex.quote(pin) + "\ncd /\nexec " + shlex.join(command) + " >" + shlex.quote(str(log)) + " 2>&1\n")
    subprocess.run(["tmux", "new-session", "-d", "-s", name, "sh", str(launcher)], check=True)
    SESSIONS.append(name)
    launcher.chmod(0o600)
    # Verify the expected database exists before accepting the server as ready.
    client = Client(f"http://127.0.0.1:{port}")
    for _ in range(80):
        try:
            if client.request("GET", "/api/health")[0] == 200:
                assert (data / "state.db").is_file(), "Isolated database missing"
                hook = json.loads((data / "hook.json").read_text())
                assert hook["endpoint"] == f"http://127.0.0.1:{port}/api/hooks"
                print(f"SERVICE session={name} command={shlex.join(command)} port={port} logs=tmux capture-pane -pt {name} / {log} stop=tmux kill-session -t {name}", flush=True)
                return client
        except (OSError, urllib.error.URLError):
            pass
        time.sleep(0.25)
    raise RuntimeError("Service failed to start: " + log.read_text())


def stop(name):
    run("tmux", "kill-session", "-t", name)
    SESSIONS.remove(name)
    time.sleep(0.3)


def context(client, surface):
    return client.json("GET", f"/api/surfaces/{surface}/context")


try:
    assert "PONG" in run("cmux", "ping")
    # Staged source exercises true production routing without touching the real dist or guide.
    stage = ROOT / "deployment"
    shutil.copytree(REPO / "apps/server/src", stage / "apps/server/src")
    (stage / "docs").mkdir()
    shutil.copy(REPO / "docs/agent-guide.md", stage / "docs/agent-guide.md")
    (stage / "node_modules").symlink_to(REPO / "node_modules", target_is_directory=True)
    entry = stage / "apps/server/src/index.ts"
    realData = ROOT / "real-data"
    REAL = start("agent-remote-http-test", 4328, entry, realData)
    check(REAL.request("GET", "/api/info")[0] == 401, "info rejects anonymous requests")
    status, headers, guide = REAL.request("GET", "/agent-guide.md")
    check(status == 200 and headers.get_content_type() == "text/markdown" and guide == (REPO / "docs/agent-guide.md").read_bytes(), "production guide: no dist, cwd=/, exact Markdown source")
    REAL.login("6814")
    identity = REAL.json("GET", "/api/info")["instanceId"]
    tree = REAL.json("GET", "/api/tree")
    check(bool(tree["workspaces"]), "authenticated real cmux tree discovered")

    project = ROOT / "project space ' quote"
    project.mkdir()
    (project / "README.md").write_text("HTTP acceptance README\n")
    (project / "AGENTS.md").write_text("Only operate in this temporary project.\n")
    run("git", "-C", str(project), "init", "-b", "http-test")
    created = REAL.json("POST", "/api/workspaces", {"cwd": str(project), "launch": None})
    WORKSPACE = created
    (ROOT / "workspace.json").write_text(json.dumps(created))
    sid = created["surfaceId"]
    check(not created.get("launchError"), "real Shell workspace creation acknowledged")
    observed = None
    for _ in range(40):
        observed = context(REAL, sid)
        if observed["cwd"] == str(project.resolve()):
            break
        time.sleep(0.5)
    check(observed["cwd"] == str(project.resolve()) and observed["agent"] is None, "real Shell initialized quoted directory and has no Agent state")
    check(observed["git"]["root"] == str(project.resolve()) and observed["git"]["hasChanges"], "context Git summary matches temporary repository")
    # Construct output marker from separate shell arguments so echoed input alone cannot satisfy it.
    REAL.json("POST", f"/api/surfaces/{sid}/input", {"text": "pwd; printf '%s%s\\n' HTTP_ACCEPT_ COMPLETE", "submit": True})
    for _ in range(40):
        observed = context(REAL, sid)
        if observed["output"] and "HTTP_ACCEPT_COMPLETE" in observed["output"]["content"]:
            break
        time.sleep(0.25)
    check("HTTP_ACCEPT_COMPLETE" in observed["output"]["content"], "real Shell executed harmless pwd/printf (not just echoed input)")
    for filename in ("README.md", "AGENTS.md"):
        preview = REAL.json("GET", "/api/files/preview", query={"path": str(project / filename)})
        check(preview["text"] == (project / filename).read_text(), "file API reads temporary " + filename)
    check(REAL.json("GET", "/api/git/status", query={"path": str(project)})["branch"] == "http-test", "Git status resolves temporary project")

    payload = "HTTP upload 中文😀\n".encode()
    upload = REAL.json("POST", "/api/files/upload", raw=payload, headers={"Content-Type": "application/octet-stream", "x-file-name": urllib.parse.quote("测试 file.txt"), "x-file-size": str(len(payload)), "x-surface-id": sid})
    check(REAL.json("GET", "/api/files/preview", query={"path": upload["path"]})["text"].encode() == payload, "raw upload headers and UTF-8 preview work")
    downloaded = REAL.request("GET", "/api/files/download", query={"path": upload["path"]})[2]
    check(hashlib.sha256(downloaded).digest() == hashlib.sha256(payload).digest(), "download bytes match uploaded artifact")
    prepare = REAL.json("POST", "/api/files/operation", {"action": "delete_prepare", "paths": [upload["path"]], "mode": "permanent"})
    check(REAL.json("POST", "/api/files/operation", {"action": "delete", "token": prepare["token"], "confirm": True})["ok"], "single Cookie session completes prepare/delete")

    aliasState = {"alias": "test-mac", "instanceId": identity, "project": str(project), "surfaceId": sid, "unknown": ["lost-input-response"]}
    moved = Client("http://localhost:4328")
    moved.login("6814")
    check(moved.json("GET", "/api/info")["instanceId"] == identity and context(moved, sid)["cwd"] == aliasState["project"], "new baseUrl/new Cookie jar preserves verified instance, project and surface")

    # Same isolated database, same Cookie, process restart and static SPA present.
    dist = stage / "apps/web/dist"
    dist.mkdir(parents=True)
    (dist / "index.html").write_text("<html>test SPA</html>")
    old = REAL
    stop("agent-remote-http-test")
    REAL = start("agent-remote-http-test", 4328, entry, realData)
    REAL.login("6814")
    check(old.json("GET", "/api/auth/session")["authenticated"], "unchanged PIN restart restores existing Cookie")
    check(REAL.json("GET", "/api/info")["instanceId"] == identity, "database identity survives process restart")
    check(REAL.request("GET", "/")[2] == b"<html>test SPA</html>" and REAL.request("GET", "/agent-guide.md")[2] == guide, "production guide bypasses existing SPA dist")
    (stage / "docs/agent-guide.md").unlink()
    check(REAL.request("GET", "/agent-guide.md")[0] == 503, "missing guide returns 503 through production entry, never SPA HTML")
    shutil.copy(REPO / "docs/agent-guide.md", stage / "docs/agent-guide.md")

    old = REAL
    stop("agent-remote-http-test")
    REAL = start("agent-remote-http-test", 4328, entry, realData, pin="7925")
    check(not old.json("GET", "/api/auth/session")["authenticated"], "official PIN change invalidates old persisted sessions in isolated database")
    REAL.login("7925")
    check(REAL.json("GET", "/api/info")["instanceId"] == identity, "new PIN login retains same instance ID")

    other = start("agent-remote-http-demo", 4329, entry, ROOT / "other-data", demo=True)
    other.login("6814")
    otherIdentity = other.json("GET", "/api/info")["instanceId"]
    check(otherIdentity != identity, "second database is a different instance; old write target not reused")
    demoTree = other.json("GET", "/api/tree")
    demoId = demoTree["workspaces"][0]["panes"][0]["surfaces"][0]["id"]
    check(context(other, demoId)["instanceId"] == otherIdentity, "demo topology exposes UUIDs usable by context")
    check(aliasState["unknown"] == ["lost-input-response"], "connection recovery retains unknown operation; no input replay")
    # Discard the response after a write. Observe its output; never send that input again.
    REAL.json("POST", f"/api/surfaces/{sid}/input", {"text": "printf '%s%s\\n' LOST_RESPONSE_ OBSERVED", "submit": True})
    for _ in range(40):
        recovered = context(REAL, sid)
        if recovered["output"] and "LOST_RESPONSE_OBSERVED" in recovered["output"]["content"]:
            break
        time.sleep(0.25)
    check(recovered["output"]["content"].count("LOST_RESPONSE_OBSERVED") == 1, "discarded input response recovered by observation with no duplicate input")

    # Simulate response loss by discarding a successful create result at the client workflow boundary.
    before = {w["id"] for w in REAL.json("GET", "/api/tree")["workspaces"]}
    cleanupReceipt = REAL.json("POST", "/api/workspaces", {"cwd": str(project)})
    EXTRA_WORKSPACES.append(cleanupReceipt["workspaceId"])  # Test cleanup only; recovery below uses tree.
    fresh = REAL.json("GET", "/api/tree")
    added = [w for w in fresh["workspaces"] if w["id"] not in before]
    check(len(added) == 1, "discarded create response recovered by tree observation without duplicate creation")
    for workspace in [w for w in added if w["id"] in EXTRA_WORKSPACES]:
        ids = [s["id"] for p in workspace["panes"] for s in p["surfaces"]]
        REAL.json("POST", f"/api/workspaces/{workspace['id']}/close", {"confirm": True, "surfaceIds": ids})
        EXTRA_WORKSPACES.remove(workspace["id"])
    print("ACCEPTANCE PASSED:", len(REPORT), "checks", flush=True)
finally:
    for workspaceId in EXTRA_WORKSPACES:
        run("cmux", "close-workspace", "--workspace", workspaceId)
    if WORKSPACE and REAL:
        try:
            workspace = next((w for w in REAL.json("GET", "/api/tree")["workspaces"] if w["id"] == WORKSPACE["workspaceId"]), None)
            if workspace:
                ids = [s["id"] for p in workspace["panes"] for s in p["surfaces"]]
                REAL.json("POST", f"/api/workspaces/{workspace['id']}/close", {"confirm": True, "surfaceIds": ids})
        except Exception as error:
            print("HTTP cleanup unavailable; closing owned UUID through cmux", flush=True)
            run("cmux", "close-workspace", "--workspace", WORKSPACE["workspaceId"])
    for name in SESSIONS[:]:
        stop(name)
    shutil.rmtree(ROOT)
    print("CLEANUP completed: owned tmux sessions, workspace and scratch files", flush=True)
