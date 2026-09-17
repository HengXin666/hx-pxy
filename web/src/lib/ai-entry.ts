/*
 * 「交给 AI」文案的唯一事实来源。
 *
 * 两个地方读它:
 *   1. web/src/pages/about-page.tsx —— 管理员复制这段文字, 粘贴给任意 AI;
 *   2. scripts/verify-ai-entry.ts   —— 门禁, 断言文案引用的事实在磁盘上真的存在。
 *
 * 因此本文件**不导入任何模块**: 门禁在 CI 里直接 import 它, 不经过 Vite、不解析 @/ 别名、
 * 也不需要 npm ci。改动前先读
 * .agents/notes/implemented/feature/2026-09-17-ai-entry-prompt.md。
 *
 * 为什么文档 URL 带版本号: 钉在**运行中的版本**上而不是 main 分支。否则程序还是 v0.12.0,
 * AI 读到的却是 main 上还没发布的接口面 —— 这正是要避免的「口径不一」。非发布构建
 * (version=dev) 退回 main, 并在文案里显式说明。
 */

export interface AiEntryDoc {
  /** 仓库内相对路径。门禁断言它在磁盘上存在**且已进入 git**, 否则外部 AI 取不到。 */
  path: string
  /** 给 AI 看的一句话说明, 帮助它选对文件。 */
  title: string
  /**
   * 该文件还没进任何 Release tag。这时无论程序跑在哪个版本, 地址都必须指向 main ——
   * 否则已发布版本的用户拿到的是 404, 因为文件在**那个 tag 里根本不存在**。
   *
   * 这个标记**不由人维护**: scripts/verify-ai-entry.ts 断言它与 git 的事实一致
   * (文件是否出现在最新的 Release tag 中)。下一个 Release 收进该文件后门禁会失败,
   * 逼你把它删掉, 地址随即自动钉回版本号。
   */
  unreleased?: boolean
}

export interface AiEntryScenario {
  /** 稳定 id, 只用于 React key 与门禁。 */
  id: string
  /** 用户一眼能认出的诉求名。 */
  label: string
  /** 这个诉求要干什么 —— 用业务语言, 不是接口语言。 */
  intent: string
  docs: AiEntryDoc[]
}

/** 场景注册表。新增场景只需在这里加一项, 页面与门禁自动跟随。 */
export const AI_ENTRY_SCENARIOS: AiEntryScenario[] = [
  {
    id: "proxy",
    label: "接入代理",
    intent: "把我的程序 / 爬虫 / 浏览器自动化接到 HX-ProxyGroup 的节点上",
    docs: [
      { path: ".agents/skills/hx-consumer-api/SKILL.md", title: "程序内接入: 节点清单 API、直拨与不兼容协议" },
    ],
  },
  {
    id: "residential",
    label: "接入住宅代理",
    intent: "用住宅渠道的出口 IP, 并且每个任务开始前先换一个新出口",
    docs: [
      { path: "docs/RESIDENTIAL_AI_QUICKSTART.md", title: "住宅代理对接指南 (给 AI / 自动化)" },
      { path: "docs/RESIDENTIAL_INTEGRATION_STANDARD.md", title: "多服务并用的并发契约: 租约与版本护栏" },
    ],
  },
  {
    id: "admin",
    label: "配置控制面",
    intent: "用程序或 AI 建订阅 / 建组 / 建 Listener, 不读 Go 源码",
    docs: [
      { path: ".agents/skills/hx-proxy-admin/SKILL.md", title: "用能力目录驱动管理 API", unreleased: true },
    ],
  },
]

/** 全部被引用的文档路径, 供门禁遍历。 */
export const AI_ENTRY_PATHS: string[] = AI_ENTRY_SCENARIOS.flatMap((scenario) =>
  scenario.docs.map((doc) => doc.path),
)

const RELEASE_CHARACTER = /^[0-9A-Za-z._-]$/

/** 发布版本形如 v0.12.0; dev / 空值等非发布构建退回 main。 */
export function aiEntryRef(version: string): { ref: string; pinned: boolean } {
  const trimmed = version.trim()
  const isRelease =
    trimmed.length > 1 &&
    trimmed.startsWith("v") &&
    Array.from(trimmed.slice(1)).every((character) => RELEASE_CHARACTER.test(character))
  return isRelease ? { ref: trimmed, pinned: true } : { ref: "main", pinned: false }
}

const DEFAULT_REPOSITORY_URL = "https://github.com/HengXin666/HX-ProxyGroup"

function trimTrailingSlashes(value: string): string {
  let result = value.trim()
  while (result.endsWith("/")) result = result.slice(0, -1)
  return result
}

export interface AiEntryPromptOptions {
  /** 控制面运行版本, 来自 GET /api/v1/system/info。 */
  version: string
  /** 仓库地址, 来自 SystemInfo.repository_url。 */
  repositoryUrl?: string
  /** 本机源码根目录; 只有后端确实跑在源码 checkout 里时才有值。 */
  sourceRoot?: string
  /** 用户选中的诉求; 省略时留一句占位提示。 */
  scenario?: AiEntryScenario
}

/** 文档在原始仓库里的地址。 */
export function aiEntryRawURL(repositoryUrl: string, ref: string, path: string): string {
  return trimTrailingSlashes(repositoryUrl || DEFAULT_REPOSITORY_URL) + "/raw/" + ref + "/" + path
}

/** 一段可以直接粘给任意 AI 的话。 */
export function buildAiEntryPrompt(options: AiEntryPromptOptions): string {
  const repository = trimTrailingSlashes(options.repositoryUrl || DEFAULT_REPOSITORY_URL)
  const { ref, pinned } = aiEntryRef(options.version)
  const root = options.sourceRoot ? trimTrailingSlashes(options.sourceRoot) : ""
  const lines: string[] = [
    "我在用 HX-ProxyGroup (代理控制面, 版本 " + options.version.trim() + ")。",
    "动手前先按下面地址读接入文档, 不要猜端点、字段名或枚举值。",
    "",
  ]

  // 每个文件单独定地址: 未发布的文件即使程序是发布版也必须走 main, 否则死链。
  const docRef = (doc: AiEntryDoc) => (doc.unreleased ? "main" : ref)

  for (const scenario of AI_ENTRY_SCENARIOS) {
    lines.push("· " + scenario.label + " —— " + scenario.intent)
    for (const doc of scenario.docs) {
      lines.push("    " + aiEntryRawURL(repository, docRef(doc), doc.path))
    }
  }

  if (root) {
    lines.push("", "这台机器上就有源码, 以下文件与运行版本完全一致, 优先读它们:")
    for (const path of AI_ENTRY_PATHS) lines.push("    " + root + "/" + path)
  }

  lines.push(
    "",
    "我的诉求: " +
      (options.scenario
        ? options.scenario.label + " —— " + options.scenario.intent
        : "<补一句你要做什么>"),
  )

  if (!pinned) {
    lines.push(
      "",
      "注: 当前是开发构建, 上面的文档取自 main 分支, 可能领先于本机运行版本; 有本机源码时以它为准。",
    )
  }
  return lines.join(String.fromCharCode(10))
}
