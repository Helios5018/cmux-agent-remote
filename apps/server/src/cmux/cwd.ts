import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import type { CmuxPane, CmuxSurface } from "@car/protocol";

/**
 * 「新 tab 开在哪个目录」。
 *
 * cmux 的 `tree` / `top` 都不给 cwd（surface 只有 tty，进程只有 pid/name/path），
 * 所以只能从同 pane 已有进程反查：拿 tty 上的进程 pid，再用 lsof 读它的 cwd。
 * 反查不到就返回 null，让 cmux 用自己的默认目录 —— 猜错目录比没目录更糟。
 */

export type ProcessRunner = (
  command: string,
  args: string[],
) => Promise<{ stdout: string; code: number }>;

/** 一次创建最多试几个进程，别为了猜目录把请求拖慢。 */
const MAX_PROBES = 6;

export const defaultProcessRunner: ProcessRunner = (command, args) =>
  new Promise((resolve) => {
    execFile(command, args, { timeout: 2000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      resolve({ stdout: String(stdout ?? ""), code: error ? 1 : 0 });
    });
  });

/** tty 名只可能是 ttysNNN 这种；挡住任何被塞进参数里的奇怪东西。 */
function isSafeTty(tty: string): boolean {
  return /^tty[a-z0-9]+$/i.test(tty);
}

/**
 * tty 上的进程，**倒序**返回。
 *
 * 倒序是有意的：越靠后越接近前台进程，而登录 shell 的 cwd 经常是过时的
 * （实测某个 shell 还停在已经被移进废纸篓的旧路径上，它的前台 yazi 才是当前目录）。
 */
async function ttyPids(tty: string, run: ProcessRunner): Promise<number[]> {
  if (!isSafeTty(tty)) return [];
  const result = await run("ps", ["-t", tty, "-o", "pid="]);
  if (result.code !== 0) return [];
  const pids = result.stdout
    .split("\n")
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
  return pids.reverse();
}

/** 读一个进程的 cwd。 */
export async function cwdOfPid(pid: number, run: ProcessRunner = defaultProcessRunner): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const result = await run("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-F", "n"]);
  if (result.code !== 0) return null;
  // lsof -F 的输出是每行一个字段，cwd 那行以 n 开头。
  for (const line of result.stdout.split("\n")) {
    if (!line.startsWith("n")) continue;
    const path = line.slice(1).trim();
    if (isUsableDir(path)) return path;
  }
  return null;
}

function isUsableDir(path: string): boolean {
  // 根目录基本等于「没查到」，当作失败继续往下试。
  if (!path.startsWith("/") || path === "/") return false;
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** pane 里 surface 的探测顺序：先选中的，再按原顺序。 */
function orderedSurfaces(pane: CmuxPane): CmuxSurface[] {
  return [...pane.surfaces].sort((a, b) => Number(b.selected) - Number(a.selected));
}

/**
 * 猜一个 pane 的工作目录。
 *
 * Agent 进程优先：`claude` 跑在项目根目录，比它外面那层 shell 靠谱。
 */
export async function resolvePaneCwd(
  pane: CmuxPane,
  run: ProcessRunner = defaultProcessRunner,
): Promise<string | null> {
  let probes = 0;
  for (const surface of orderedSurfaces(pane)) {
    const candidates: number[] = [];
    if (surface.agentPid) candidates.push(surface.agentPid);
    if (surface.tty) candidates.push(...(await ttyPids(surface.tty, run)));

    for (const pid of candidates) {
      if (probes >= MAX_PROBES) return null;
      probes += 1;
      const cwd = await cwdOfPid(pid, run);
      if (cwd) return cwd;
    }
  }
  return null;
}
