import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PORT, type AgentKind } from "@car/protocol";
import { MIN_PIN_LENGTH } from "./security/token.ts";
import { DEFAULT_AUDIT_MAX_AGE_DAYS, DEFAULT_AUDIT_MAX_ROWS } from "./state/store.ts";

export interface ServerConfig {
  host: string;
  port: number;
  /** 人输入的 Access PIN（纯数字，默认 4 位）。 */
  pin: string;
  /** 机器用的 Hook 密钥（长随机串，只走本机回环）。 */
  hookToken: string;
  /** 自动生成 PIN 时的位数。 */
  pinLength: number;
  dataDir: string;
  dbPath: string;
  auditMaxAgeDays: number;
  auditMaxRows: number;
  /** 前端构建产物目录；不存在时只提供 API。 */
  staticDir: string;
  staleAfterMs: number;
  /**
   * 部署在 Tunnel / 反向代理后面时打开：
   * 用 X-Forwarded-For 作为限流维度，用 X-Forwarded-Proto 决定 Cookie 的 Secure 标记。
   */
  trustProxy: boolean;
  /** 用假的 cmux 数据跑，便于没有 cmux 的环境演示 / 测试。 */
  demo: boolean;
  /** 输出最多保留多少行。 */
  maxOutputLines: number;
  /** 「加载更早的历史」单次最多回溯多少行。 */
  maxHistoryLines: number;
  /** 翻页后等 TUI 重绘多久再截图；太快会读到旧画面。 */
  scrollRedrawDelayMs: number;
  /**
   * 新建 surface 时「顺手起一个 Agent」执行的命令。
   *
   * 默认是 ~/.zshrc 里的别名（带跳过确认的参数）—— 手机上没法一路点确认。
   * 这是一份白名单：前端只能从 claude/codex/grok/pi 里选，不能传任意命令。
   */
  launchCommands: Record<AgentKind, string>;
}

export interface ParseArgsResult {
  config: ServerConfig;
  help: boolean;
  /** 用户显式指定了 PIN（命令行或环境变量）。 */
  pinProvided: boolean;
  /** 强制换一个新的 PIN，并让所有旧 Session 失效。 */
  rotatePin: boolean;
  /** 强制换一个新的 Hook 密钥。 */
  rotateHookToken: boolean;
  /** 解除所有登录锁定。 */
  unlock: boolean;
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): ParseArgsResult {
  const dataDir = env["CAR_DATA_DIR"] ?? join(homedir(), ".cmux-agent-remote");
  const config: ServerConfig = {
    host: env["CAR_HOST"] ?? "127.0.0.1",
    port: Number(env["CAR_PORT"] ?? DEFAULT_PORT),
    pin: env["CAR_PIN"] ?? "",
    hookToken: "",
    pinLength: Number(env["CAR_PIN_LENGTH"] ?? MIN_PIN_LENGTH),
    dataDir,
    dbPath: env["CAR_DB"] ?? join(dataDir, "state.db"),
    auditMaxAgeDays: Number(env["CAR_AUDIT_MAX_AGE_DAYS"] ?? DEFAULT_AUDIT_MAX_AGE_DAYS),
    auditMaxRows: Number(env["CAR_AUDIT_MAX_ROWS"] ?? DEFAULT_AUDIT_MAX_ROWS),
    staticDir: env["CAR_STATIC_DIR"] ?? "",
    staleAfterMs: Number(env["CAR_STALE_AFTER_MS"] ?? 10 * 60 * 1000),
    trustProxy: env["CAR_TRUST_PROXY"] === "1",
    demo: env["CAR_DEMO"] === "1",
    maxOutputLines: Number(env["CAR_MAX_OUTPUT_LINES"] ?? 400),
    maxHistoryLines: Number(env["CAR_MAX_HISTORY_LINES"] ?? 5000),
    scrollRedrawDelayMs: Number(env["CAR_SCROLL_REDRAW_DELAY_MS"] ?? 160),
    launchCommands: {
      claude: env["CAR_LAUNCH_CLAUDE"] ?? "c-d",
      codex: env["CAR_LAUNCH_CODEX"] ?? "codex-d",
      grok: env["CAR_LAUNCH_GROK"] ?? "g-d",
      pi: env["CAR_LAUNCH_PI"] ?? "pi",
    },
  };
  let help = false;
  let pinProvided = config.pin.length > 0;
  let rotatePin = false;
  let rotateHookToken = false;
  let unlock = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i] ?? "";
    switch (arg) {
      case "--help":
      case "-h":
        help = true;
        break;
      case "--port":
        config.port = Number(next());
        break;
      case "--host":
        config.host = next();
        break;
      case "--lan":
        // 局域网测试：0.0.0.0:4318
        config.host = "0.0.0.0";
        break;
      case "--pin":
        config.pin = next();
        pinProvided = config.pin.length > 0;
        break;
      case "--pin-length":
        config.pinLength = Number(next());
        break;
      case "--rotate-pin":
        rotatePin = true;
        break;
      case "--rotate-hook-token":
        rotateHookToken = true;
        break;
      case "--unlock":
        unlock = true;
        break;
      case "--trust-proxy":
        config.trustProxy = true;
        break;
      case "--db":
        config.dbPath = next();
        break;
      case "--static":
        config.staticDir = next();
        break;
      case "--demo":
        config.demo = true;
        break;
      default:
        break;
    }
  }

  if (!Number.isFinite(config.port) || config.port <= 0) config.port = DEFAULT_PORT;
  if (!Number.isSafeInteger(config.auditMaxAgeDays) || config.auditMaxAgeDays <= 0 ||
      !Number.isSafeInteger(config.auditMaxAgeDays * 86_400_000)) config.auditMaxAgeDays = DEFAULT_AUDIT_MAX_AGE_DAYS;
  if (!Number.isSafeInteger(config.auditMaxRows) || config.auditMaxRows <= 0) config.auditMaxRows = DEFAULT_AUDIT_MAX_ROWS;
  if (!Number.isFinite(config.pinLength)) config.pinLength = MIN_PIN_LENGTH;
  if (!Number.isFinite(config.maxHistoryLines) || config.maxHistoryLines <= 0) config.maxHistoryLines = 5000;
  if (!Number.isFinite(config.scrollRedrawDelayMs) || config.scrollRedrawDelayMs < 0) {
    config.scrollRedrawDelayMs = 160;
  }

  return { config, help, pinProvided, rotatePin, rotateHookToken, unlock };
}

export const HELP_TEXT = `CMUX Agent Remote

用法:
  cmux-agent-remote [options]

监听:
  --port <n>            端口（默认 4318）
  --host <addr>         监听地址（默认 127.0.0.1，只有本机能连）
  --lan                 监听 0.0.0.0，供同一 Wi-Fi 下的手机访问
  --trust-proxy         部署在 Tunnel / 反向代理后面时打开（按真实来源 IP 限流 + Secure Cookie）

登录:
  --pin <digits>        指定 Access PIN（4-12 位数字，默认首次启动随机生成后复用）
  --pin-length <n>      自动生成 PIN 的位数（默认 4）
  --rotate-pin          重新生成 PIN，并让所有已登录设备失效
  --rotate-hook-token   重新生成 Hook 密钥（需要重启各 Agent 会话）
  --unlock              解除因连续输错而产生的登录锁定

其它:
  --db <path>           SQLite 路径（默认 ~/.cmux-agent-remote/state.db）
  --static <dir>        前端静态文件目录
  --demo                使用内置假数据（没有 cmux 也能跑）
  -h, --help            显示帮助

环境变量:
  CAR_AUDIT_MAX_AGE_DAYS 审计保留天数（正整数，默认 30）
  CAR_AUDIT_MAX_ROWS     审计保留条数（正整数，默认 100000）
  CAR_LAUNCH_CLAUDE     新建 surface 时起 Claude 的命令（默认 c-d）
  CAR_LAUNCH_CODEX      同上，Codex（默认 codex-d）
  CAR_LAUNCH_GROK       同上，Grok（默认 g-d）
  CAR_LAUNCH_PI         同上，Pi（默认 pi）
`;
