import { useEffect, useMemo, useState } from "react"
import { Bot, Check, Copy, LoaderCircle, RefreshCw } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { api } from "@/lib/api"
import {
  AI_ENTRY_SCENARIOS,
  absolutePublicURL,
  aiEntryRef,
  buildAiEntryPrompt,
  nodesPathFromSharePath,
  rotateNextPathFromRotatePath,
  type AiEntryScenario,
  type AiEntrySource,
} from "@/lib/ai-entry"
import type { ListenerRecord, ResidentialChannel, SystemInfo } from "@/lib/types"

export function AiEntryPage({ onNotice }: { onNotice: (message: string, tone?: "success" | "error") => void }) {
  const [info, setInfo] = useState<SystemInfo | null>(null)
  const [listeners, setListeners] = useState<ListenerRecord[]>([])
  const [channels, setChannels] = useState<ResidentialChannel[]>([])
  const [loading, setLoading] = useState(true)
  const [copiedKey, setCopiedKey] = useState("")

  async function load() {
    setLoading(true)
    try {
      const [systemInfo, listenerList, channelList] = await Promise.all([
        api.systemInfo(),
        api.listListeners(),
        api.listResidentialChannels(),
      ])
      setInfo(systemInfo)
      setListeners(listenerList.items)
      setChannels(channelList.items)
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "加载接入源失败", "error")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [])

  const residentialListenerIDs = useMemo(
    () => new Set(channels.map((channel) => channel.listener_id).filter(Boolean)),
    [channels],
  )

  const proxySources = useMemo(
    () => listeners.filter((listener) =>
      listener.enabled &&
      !listener.shared_inbound_aggregate &&
      Boolean(listener.share_path) &&
      !residentialListenerIDs.has(listener.id),
    ),
    [listeners, residentialListenerIDs],
  )

  const residentialSources = useMemo(
    () => channels.filter((channel) => channel.enabled && Boolean(channel.endpoint?.share_path)),
    [channels],
  )

  async function copyPrompt(key: string, source?: AiEntrySource, scenario?: AiEntryScenario) {
    if (!info) return
    const text = buildAiEntryPrompt({
      version: info.version,
      repositoryUrl: info.repository_url,
      sourceRoot: info.source_root,
      source,
      scenario,
    })
    try {
      await navigator.clipboard.writeText(text)
      setCopiedKey(key)
      window.setTimeout(() => setCopiedKey(""), 1800)
      onNotice("接入说明已复制，粘贴给任意 AI 即可")
    } catch {
      onNotice("浏览器未允许复制，请手动选择文字", "error")
    }
  }

  const adminScenario = AI_ENTRY_SCENARIOS.find((scenario) => scenario.id === "admin")

  return <div className="space-y-4">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">接入 AI</h1>
        <p className="mt-1 max-w-3xl text-sm leading-5 text-muted-foreground">
          选一个接入源，复制给任意 AI。它会拿到<strong>实时节点清单 URL</strong>（每次任务重新 GET，不要缓存），并先读对应的接入文档 —— 不需要你解释端点或字段名。
        </p>
      </div>
      <Button variant="outline" onClick={() => void load()} disabled={loading}><RefreshCw className={loading ? "animate-spin" : ""} />刷新</Button>
    </div>

    {loading && !info ? (
      <div className="flex min-h-48 items-center justify-center gap-2 rounded-lg border bg-card text-sm text-muted-foreground">
        <LoaderCircle className="size-4 animate-spin" />正在读取接入源
      </div>
    ) : info && <>
      <SourceGroup
        title="普通代理"
        hint="GET /nodes/<share-token> 返回当前节点清单。控制面不探测、不选点、不轮询。"
        empty="还没有可接入的普通代理。先在「代理服务」建一个 Listener。"
        copiedKey={copiedKey}
        rows={proxySources.map((listener) => ({
          key: "proxy:" + listener.id,
          name: listener.name,
          badges: [listener.kind.toUpperCase(), listener.shared_inbound ? "共享入口" : ""].filter(Boolean),
          preview: absolutePublicURL(nodesPathFromSharePath(listener.share_path || "")),
          onCopy: () => void copyPrompt("proxy:" + listener.id, {
            kind: "proxy",
            name: listener.name,
            sharePath: listener.share_path || "",
          }),
        }))}
      />

      <SourceGroup
        title="住宅代理"
        hint="同一份节点清单，外加 POST /rot/<token>/next：每个任务开始前先换出口。不要把管理员的 /ctl/ 交给 AI。"
        empty="还没有可接入的住宅渠道。先在「住宅代理」建一个渠道。"
        copiedKey={copiedKey}
        rows={residentialSources.map((channel) => ({
          key: "residential:" + channel.id,
          name: channel.name,
          badges: [
            "住宅",
            channel.mode === "sticky" ? "sticky" : channel.mode,
            channel.rotate_path ? "可换出口" : "无换出口",
          ],
          preview: absolutePublicURL(nodesPathFromSharePath(channel.endpoint.share_path || "")),
          extra: channel.rotate_path
            ? absolutePublicURL(rotateNextPathFromRotatePath(channel.rotate_path))
            : "",
          onCopy: () => void copyPrompt("residential:" + channel.id, {
            kind: "residential",
            name: channel.name,
            sharePath: channel.endpoint.share_path || "",
            rotatePath: channel.rotate_path,
          }),
        }))}
      />

      {adminScenario && (
        <section className="rounded-lg border bg-card">
          <div className="border-b px-4 py-3">
            <h2 className="flex items-center gap-2 text-sm font-semibold"><Bot className="size-4" />{adminScenario.label}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">{adminScenario.intent}。这条不带节点令牌，只指向能力目录。</p>
          </div>
          <div className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="truncate font-mono text-[11px] text-muted-foreground">{adminScenario.docs.map((doc) => doc.path).join("  ")}</p>
            <Button variant="outline" className="shrink-0" onClick={() => void copyPrompt("admin", undefined, adminScenario)}>
              {copiedKey === "admin" ? <Check className="text-success" /> : <Copy />}
              {copiedKey === "admin" ? "已复制" : "复制给 AI"}
            </Button>
          </div>
        </section>
      )}

      <p className="text-xs text-muted-foreground">
        {(() => {
          const { ref, pinned } = aiEntryRef(info.version)
          return <>
            {pinned
              ? <>文档地址钉在 <span className="font-mono">{ref}</span> 上。</>
              : <>当前是开发构建（<span className="font-mono">{info.version}</span>），文档地址取自 <span className="font-mono">main</span>。</>}
            {" "}含令牌的文案等同于订阅 URL，只发给你信任的 AI。
          </>
        })()}
      </p>
    </>}
  </div>
}

function SourceGroup({
  title,
  hint,
  empty,
  rows,
  copiedKey,
}: {
  title: string
  hint: string
  empty: string
  copiedKey: string
  rows: Array<{ key: string; name: string; badges: string[]; preview: string; extra?: string; onCopy: () => void }>
}) {
  return (
    <section className="rounded-lg border bg-card">
      <div className="border-b px-4 py-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
      </div>
      {rows.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted-foreground">{empty}</p>
      ) : (
        <div className="divide-y">
          {rows.map((row) => (
            <div key={row.key} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-sm font-medium">{row.name}</span>
                  {row.badges.map((badge) => <Badge key={badge} variant="outline">{badge}</Badge>)}
                </div>
                {row.preview && <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground" title={row.preview}>{row.preview}</p>}
                {row.extra && <p className="truncate font-mono text-[11px] text-muted-foreground" title={row.extra}>{row.extra}</p>}
              </div>
              <Button variant="outline" className="shrink-0" onClick={row.onCopy} disabled={!row.preview}>
                {copiedKey === row.key ? <Check className="text-success" /> : <Copy />}
                {copiedKey === row.key ? "已复制" : "复制给 AI"}
              </Button>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
