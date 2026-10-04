import { execFile } from "node:child_process";

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** 命令执行器抽象：测试里可以换成假的，不需要真的 cmux。 */
export type CommandRunner = (args: string[], options?: { timeoutMs?: number }) => Promise<ExecResult>;

export interface CreateCliRunnerOptions {
  /** cmux 可执行文件路径，默认 PATH 上的 cmux。 */
  binary?: string;
  /** 默认超时。 */
  timeoutMs?: number;
  /** 额外环境变量，例如 CMUX_SOCKET_PATH。 */
  env?: Record<string, string>;
}

/**
 * 真实的 cmux CLI runner。
 *
 * 刻意使用 execFile 而不是 shell，参数以数组传递，
 * 避免用户 prompt 里的引号 / $() 被 shell 解释（这是一个远程输入面，必须防注入）。
 */
export function createCliRunner(options: CreateCliRunnerOptions = {}): CommandRunner {
  const binary = options.binary ?? "cmux";
  const defaultTimeout = options.timeoutMs ?? 10_000;

  return (args, callOptions) =>
    new Promise<ExecResult>((resolve) => {
      execFile(
        binary,
        args,
        {
          timeout: callOptions?.timeoutMs ?? defaultTimeout,
          maxBuffer: 8 * 1024 * 1024,
          env: { ...process.env, CMUX_QUIET: "1", ...options.env },
        },
        (error, stdout, stderr) => {
          if (error) {
            const code = typeof (error as { code?: unknown }).code === "number"
              ? ((error as { code: number }).code)
              : 1;
            resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? error.message), code });
            return;
          }
          resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), code: 0 });
        },
      );
    });
}
