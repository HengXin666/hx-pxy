import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react"
import { Activity, BookOpen, Cable, CheckCircle2, ChevronDown, ChevronRight, CircleAlert, Gauge, Link2, ListTree, LoaderCircle, Network, Pencil, Plus, RefreshCw, Save, ScrollText, Server } from "lucide-react"

import { ConfirmDialog } from "@/components/confirm-dialog"
import { EditProxyServiceForm } from "@/components/edit-proxy-service-form"
import { LiveLogsPanel, TrafficPanel } from "@/components/service-observability"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { api } from "@/lib/api"
import { strategyMeta } from "@/lib/proxy-groups"
import type { DataPlaneStatus, ListenerKind, ListenerRecord, NodeRecord, ProxyGroup, ProxyGroupStrategy, ResidentialChannel, RoutingAction, RoutingRulesConfig, RoutingRuleSet, SharedInboundSettings, Subscription } from "@/lib/types"
import { cn, formatDate } from "@/lib/utils"

interface RoutingPageProps {
  onNotice: (message: string, tone?: "success" | "error") => void
}

const strategies: Array<{ value: ProxyGroupStrategy; label: string }> = (
  ["url-test", "fallback", "round-robin", "consistent-hashing", "sticky-sessions", "manual"] as const
).map((value) => ({ value, label: strategyMeta[value].label }))

const regions = [
  { value: "jp", label: "日本" }, { value: "hk", label: "香港" }, { value: "tw", label: "台湾" },
  { value: "sg", label: "新加坡" }, { value: "us", label: "美国" }, { value: "kr", label: "韩国" },
]

const kinds: Array<{ value: ListenerKind; label: string }> = [
  { value: "mixed", label: "Mixed" }, { value: "http", label: "HTTP" }, { value: "socks", label: "SOCKS5" },
  { value: "vless", label: "VLESS WS" }, { value: "vmess", label: "VMess WS" }, { value: "trojan", label: "Trojan WS" },
]

export function RoutingPage({ onNotice }: RoutingPageProps) {
  const [nodes, setNodes] = useState<NodeRecord[]>([])
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([])
  const [groups, setGroups] = useState<ProxyGroup[]>([])
  const [listeners, setListeners] = useState<ListenerRecord[]>([])
  const [residentialChannels, setResidentialChannels] = useState<ResidentialChannel[]>([])
  const [status, setStatus] = useState<DataPlaneStatus | null>(null)
  const [routingRules, setRoutingRules] = useState<RoutingRulesConfig>({ rule_sets: [] })
  // Shared-inbound settings decide whether a new service opens its own port or
  // joins the one-client entry points; the banner and the create form read it.
  const [sharedInbound, setSharedInbound] = useState<SharedInboundSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<{ listener: ListenerRecord; group?: ProxyGroup } | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [editing, setEditing] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [nodeResult, subscriptionResult, groupResult, listenerResult, statusResult, ruleResult, residentialResult, settingsResult] = await Promise.all([
        api.listNodes(), api.listSubscriptions(), api.listProxyGroups(), api.listListeners(), api.dataPlaneStatus(), api.routingRules(), api.listResidentialChannels(), api.globalSettings(),
      ])
      setNodes(nodeResult.items.filter((item) => !["disabled", "retired"].includes(item.lifecycle_state)))
      setSubscriptions(subscriptionResult.items.filter((item) => item.enabled))
      setGroups(groupResult.items)
      // Members of a shared entry point keep their own row (their credential
      // and group live there) and are listed as services like any other. The
      // aggregate carrier row is filtered out: it holds no credential and no
      // group of its own, so it must never be editable or deletable.
      const visibleListeners = listenerResult.items.filter((item) => !item.shared_inbound_aggregate)
      setListeners(visibleListeners)
      // 首次进入默认展开, 否则「节点成员」要再点一次, 看起来像没节点。
      // 见 .agents/notes/implemented/bug-fix/2026-09-18-routing-members-collapsed.md
      setExpanded((current) => current.size ? current : new Set(visibleListeners.map((item) => item.id)))
      setResidentialChannels(residentialResult.items)
      setStatus(statusResult)
      setRoutingRules(ruleResult)
      setSharedInbound(settingsResult.shared_inbound ?? null)
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "加载代理服务失败", "error")
    } finally {
      setLoading(false)
    }
  }, [onNotice])

  useEffect(() => { void load() }, [load])

  // Resolve each service's member list once per data load instead of on every
  // render; with thousands of nodes this filter chain is the page's hot path.
  const serviceNodes = useMemo(() => {
    const byListener = new Map<string, NodeRecord[]>()
    for (const listener of listeners) {
      const group = groups.find((item) => item.id === listener.proxy_group_id)
      byListener.set(listener.id, resolveServiceNodes(group, nodes))
    }
    return byListener
  }, [groups, listeners, nodes])

  async function apply() {
    setBusy(true)
    try {
      setStatus(await api.applyDataPlane())
      onNotice("Mihomo 配置已重新编译并应用")
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "应用数据面失败", "error")
      setStatus(await api.dataPlaneStatus().catch(() => null))
    } finally { setBusy(false) }
  }

  async function removeService() {
    if (!deleteTarget) return
    setBusy(true)
    try {
      await api.deleteListener(deleteTarget.listener.id, deleteTarget.listener.version)
      if (deleteTarget.group) await api.deleteProxyGroup(deleteTarget.group.id, deleteTarget.group.version)
      setDeleteTarget(null)
      await load()
      onNotice("代理服务及其入口已删除")
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "删除代理服务失败", "error")
    } finally { setBusy(false) }
  }

  return (
    <div className="space-y-4 xl:flex xl:h-full xl:min-h-0 xl:flex-col xl:gap-4 xl:space-y-0">
      <div className="flex shrink-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold">代理服务</h1>
          <p className="mt-1 max-w-3xl text-sm leading-5 text-muted-foreground">每项服务同时定义入口 IP、端口、登录账号，以及它可以使用的跨订阅节点规则。</p>
        </div>
        <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:shrink-0">
          <Button variant="outline" onClick={() => void load()} disabled={loading || busy}><RefreshCw className={loading ? "animate-spin" : ""} />刷新</Button>
          <Button onClick={() => void apply()} disabled={busy}>{busy ? <LoaderCircle className="animate-spin" /> : <Server />}重新应用</Button>
        </div>
      </div>

      <div className="shrink-0"><DataPlaneBand status={status} loading={loading} /></div>

      {sharedInbound?.mode === "shared" && (
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-info-border bg-info-muted px-3 py-2 text-xs text-info-foreground">
          <Cable className="size-3.5 shrink-0" />
          <span className="font-medium">共享入口已启用</span>
          <span className="text-muted-foreground">{`全部 HTTP / SOCKS5 / Mixed 服务共用本机 ${sharedInbound.mixed_bind_address || "0.0.0.0"}:${sharedInbound.mixed_port || 7890}，全部 VLESS / VMess / Trojan 服务共用内部端口 ${sharedInbound.ws_port || 7891}`}{sharedInbound.ws_public_host ? `（公网 ${sharedInbound.ws_public_host}:${sharedInbound.ws_public_port || 443}）` : "（未配置公网域名，订阅暂不可用）"}。</span>
          <span className="text-muted-foreground">1 个客户端进程即可覆盖所有代理组与协议；在「全局配置 → 性能与运行」可关闭。</span>
        </div>
      )}

      {/*
        高度锁必须跟双栏同断点 (xl)。lg 锁高、xl 才两列时, 单列里
        flex-1 min-h-0 会把服务行压成 0 高。
        见 .agents/notes/implemented/bug-fix/2026-09-18-proxy-service-list-collapses.md
      */}
      <div className="grid gap-4 xl:min-h-0 xl:flex-1 xl:grid-cols-[minmax(0,1.2fr)_minmax(390px,0.8fr)]">
        <section className="flex min-h-0 flex-col overflow-hidden rounded-lg border bg-card">
          <PanelHeader title="服务列表" description="入口与节点策略保持一一对应" count={listeners.length} />
          {listeners.length === 0 ? <EmptyState /> : <div className="min-h-48 divide-y overflow-y-auto xl:min-h-0 xl:flex-1">{listeners.map((listener) => {
            const group = groups.find((item) => item.id === listener.proxy_group_id)
            const residential = residentialChannels.find((channel) => channel.listener_id === listener.id)
            return <ServiceRow key={listener.id} listener={listener} group={group} groups={groups} routingRules={routingRules} nodes={serviceNodes.get(listener.id) ?? []} subscriptions={subscriptions} allNodes={nodes} residential={residential} expanded={expanded.has(listener.id)} editing={editing === listener.id} onToggle={() => setExpanded((current) => { const next = new Set(current); if (next.has(listener.id)) next.delete(listener.id); else next.add(listener.id); return next })} onEdit={() => { setExpanded((current) => new Set(current).add(listener.id)); setEditing(listener.id) }} onCloseEdit={() => setEditing(null)} onRoutingChanged={setRoutingRules} onChanged={async () => { setEditing(null); await load() }} onDelete={() => setDeleteTarget({ listener, group })} onNotice={onNotice} />
          })}</div>}
        </section>
        <CreateProxyServiceForm nodes={nodes} subscriptions={subscriptions} sharedInbound={sharedInbound} onCreated={load} onNotice={onNotice} />
      </div>

      <ConfirmDialog open={deleteTarget !== null} title="删除代理服务" description={`将关闭 ${deleteTarget?.listener.bind_address ?? ""}:${deleteTarget?.listener.port ?? ""}，并删除其专属节点策略。`} busy={busy} onCancel={() => setDeleteTarget(null)} onConfirm={() => void removeService()} />
    </div>
  )
}

async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value)
    return true
  } catch {
    return false
  }
}

function endpointAddress(listener: ListenerRecord, endpoint: ListenerRecord["public_endpoint"]): string {
  const configuredHost = endpoint?.host?.trim()
  const bindHost = listener.bind_address.trim()
  const host = configuredHost || (isPublicBindAddress(bindHost) ? bindHost : "")
  if (!host) return ""
  const formattedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host
  return `${formattedHost}:${endpoint?.port || listener.port}`
}

function isPublicBindAddress(value: string): boolean {
  return value !== "127.0.0.1" && value !== "::1" && value !== "0.0.0.0" && value !== "::" && !value.startsWith("127.")
}

function ServiceRow({ listener, group, groups, routingRules, nodes, subscriptions, allNodes, residential, expanded, editing, onToggle, onEdit, onCloseEdit, onRoutingChanged, onChanged, onDelete, onNotice }: { listener: ListenerRecord; group?: ProxyGroup; groups: ProxyGroup[]; routingRules: RoutingRulesConfig; nodes: NodeRecord[]; subscriptions: Subscription[]; allNodes: NodeRecord[]; residential?: ResidentialChannel; expanded: boolean; editing: boolean; onToggle: () => void; onEdit: () => void; onCloseEdit: () => void; onRoutingChanged: (config: RoutingRulesConfig) => void; onChanged: () => Promise<void>; onDelete: () => void; onNotice: RoutingPageProps["onNotice"] }) {
  const [action, setAction] = useState("")
  const [detailTab, setDetailTab] = useState("members")
  const spec = group?.source_spec
  const sourceText = spec?.include_direct && !spec.subscription_ids?.length && !spec.node_ids.length
    ? "当前服务器 DIRECT 出口"
    : spec?.subscription_ids?.length
    ? `${spec.subscription_ids.length} 个订阅${spec.regions?.length ? ` · ${spec.regions.map(regionLabel).join("/")}` : ""} · Top ${spec.limit || "全部"}`
    : `${spec?.node_ids.length || 0} 个固定节点`

  async function copyShareLink(format: "v2rayn" | "clash" | "sing-box" | "uri", client: string) {
    if (!listener.share_path) return
    const ok = await copyText(api.listenerShareURL(listener.share_path, format))
    onNotice(ok ? `${client} 订阅链接已复制` : "复制失败，请手动复制", ok ? "success" : "error")
  }

  async function copyEndpoint() {
    // 复制入口地址时，公开端点缺省就直接用本机监听地址。
    // 不少场景（管理员本机、同主机容器等）连接 127.0.0.1 本就是通的，
    // 不再强制要求公网域名才能复制入口地址。
    const address = endpointAddress(listener, publicEndpoint) || `${listener.bind_address}:${listener.port}`
    const ok = await copyText(address)
    onNotice(ok ? "入口地址已复制" : "复制失败，请手动复制", ok ? "success" : "error")
  }

  async function copyResidentialURL(kind: "clash" | "control") {
    const value = kind === "clash" ? residential?.subscription_url : residential?.control_url
    if (!value) {
      onNotice(kind === "clash" ? "请先为住宅渠道配置声明节点和可用公网端点" : "该住宅渠道没有可用的自动化控制 URL", "error")
      return
    }
    const ok = await copyText(value)
    const label = kind === "clash" ? "Clash / Mihomo 订阅" : "自动化控制 URL"
    onNotice(ok ? `${label}已复制` : "复制失败，请手动复制", ok ? "success" : "error")
  }

  async function copyConnectionURI() {
    if (!listener.share_path) return
    try {
      const content = await api.listenerShareContent(listener.share_path)
      const ok = await copyText(content.trimEnd())
      onNotice(ok ? "认证连接 URI 已复制" : "复制失败，请手动复制", ok ? "success" : "error")
    } catch (cause) {
      onNotice(cause instanceof Error ? cause.message : "读取认证连接 URI 失败", "error")
    }
  }

  const memberCount = nodes.length + (group?.source_spec.include_direct ? 1 : 0)
  const healthyCount = nodes.filter((node) => node.lifecycle_state === "healthy").length + (group?.source_spec.include_direct ? 1 : 0)
  const publicEndpoint = residential?.public_endpoint ?? listener.public_endpoint
  function runAction(value: string) {
    setAction(value)
    if (value === "residential-clash") void copyResidentialURL("clash")
    else if (value === "residential-control") void copyResidentialURL("control")
    else if (value === "address") void copyEndpoint()
    else if (value === "auth-uri") void copyConnectionURI()
    else if (value === "edit") { setDetailTab("edit"); onEdit() }
    else if (value === "delete") onDelete()
    else if (!residential) { const [format = "clash", client = format] = value.split(":"); void copyShareLink(format as "v2rayn" | "clash" | "sing-box" | "uri", client) }
    window.setTimeout(() => setAction(""), 0)
  }
  return (
    <div>
    <div className="grid cursor-pointer gap-3 px-3 py-3 hover:bg-muted/60 lg:grid-cols-[minmax(0,1fr)_minmax(180px,0.7fr)_auto] lg:items-center" onClick={onToggle}>
      <div className="flex min-w-0 items-start gap-2.5">
        <Button variant="ghost" size="icon" className="size-7" onClick={(event) => { event.stopPropagation(); onToggle() }} aria-label={expanded ? "收起节点" : "展开节点"}>{expanded ? <ChevronDown /> : <ChevronRight />}</Button>
        <div className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-card text-muted-foreground"><Cable className="size-4" /></div>
        <div className="min-w-0"><div className="flex flex-wrap items-center gap-1.5"><span className="font-medium">{residential?.name || group?.name || listener.name}</span><Badge variant="outline">{listener.kind.toUpperCase()}</Badge>{listener.shared_inbound && <Badge variant="outline">共享入口</Badge>}{residential && <Badge variant="outline">住宅会话</Badge>}<Badge variant={healthyCount === memberCount && memberCount > 0 ? "success" : "warning"}>{healthyCount}/{memberCount} 可用</Badge><Badge variant={listener.auth_configured ? "warning" : "secondary"}>{listener.auth_configured ? "账号认证" : "无认证"}</Badge></div><div className="mt-1 font-mono text-[11px] text-muted-foreground">本机 {listener.bind_address}:{listener.port}{endpointAddress(listener, publicEndpoint) ? ` · 公网 ${endpointAddress(listener, publicEndpoint)}` : " · 未配置公网端点"}</div></div>
      </div>
      <div className="min-w-0"><div className="flex items-center gap-1.5 text-xs font-medium"><Network className="size-3.5" />{group ? strategyLabel(group.strategy) : "组已缺失"}</div><div className="mt-1 truncate text-[11px] text-muted-foreground" title={sourceText}>{sourceText}</div></div>
      <div className="w-full lg:w-[200px]">
        <Select value={action} onValueChange={runAction}><SelectTrigger onClick={(event) => event.stopPropagation()} className="h-8"><Link2 className="mr-1 size-3.5" /><SelectValue placeholder="服务操作" /></SelectTrigger><SelectContent><SelectItem value="edit">编辑服务</SelectItem>{!residential && listener.share_path && <><SelectItem value="clash:Clash / Mihomo">复制 Clash / Mihomo 订阅</SelectItem><SelectItem value="v2rayn:v2rayN / v2rayNG">复制 v2rayN / v2rayNG 订阅</SelectItem><SelectItem value="v2rayn:Shadowrocket">复制 Shadowrocket 订阅</SelectItem><SelectItem value="sing-box:sing-box / NekoBox">复制 sing-box / NekoBox 订阅</SelectItem><SelectItem value="auth-uri">复制认证连接 URI</SelectItem></>}{residential ? <><SelectItem value="residential-clash">复制 Clash / Mihomo 订阅</SelectItem><SelectItem value="residential-control">复制自动化控制 URL</SelectItem></> : <SelectItem value="address">复制入口地址</SelectItem>}<SelectItem value="delete" className="text-destructive">删除服务</SelectItem></SelectContent></Select>
      </div>
    </div>
    {expanded && <div className="border-t bg-muted/70 px-3 py-3 sm:px-4">
      <Tabs value={editing ? "edit" : detailTab} onValueChange={(value) => { setDetailTab(value); if (value === "edit") onEdit(); else if (editing) onCloseEdit() }}>
        <TabsList className="max-w-full overflow-x-auto">
          <TabsTrigger value="members"><ListTree className="mr-1.5 size-3.5" />节点成员</TabsTrigger>
          <TabsTrigger value="traffic"><Activity className="mr-1.5 size-3.5" />流量统计</TabsTrigger>
          <TabsTrigger value="routes" disabled={!group}><BookOpen className="mr-1.5 size-3.5" />路由策略</TabsTrigger>
          <TabsTrigger value="logs"><ScrollText className="mr-1.5 size-3.5" />实时日志</TabsTrigger>
          <TabsTrigger value="edit" disabled={!group}><Pencil className="mr-1.5 size-3.5" />动态编辑</TabsTrigger>
        </TabsList>
        <TabsContent value="members"><div className="overflow-hidden rounded-md border bg-card">{group?.source_spec.include_direct && <ServiceMember name="DIRECT（当前服务器出口）" protocol="DIRECT" state="可用" latency={null} source="本机" />}{nodes.map((node) => <ServiceMember key={node.id} name={node.display_name} protocol={node.protocol.toUpperCase()} state={node.lifecycle_state} latency={node.last_latency_ms} source={node.sources.map((item) => item.subscription_name).join("、") || "固定节点"} />)}{memberCount === 0 && <div className="px-3 py-4 text-center text-xs text-muted-foreground">当前规则没有命中可用节点</div>}</div></TabsContent>
        <TabsContent value="traffic"><TrafficPanel listenerId={listener.id} groupId={group?.id} nodes={nodes} /></TabsContent>
        <TabsContent value="routes">{group && <GroupRoutingPanel group={group} groups={groups} config={routingRules} onSaved={onRoutingChanged} onNotice={onNotice} />}</TabsContent>
        <TabsContent value="logs"><LiveLogsPanel listenerId={listener.id} /></TabsContent>
        <TabsContent value="edit">{group && <div className="overflow-hidden rounded-md border bg-card"><EditProxyServiceForm listener={listener} group={group} nodes={allNodes} subscriptions={subscriptions} onSaved={onChanged} onCancel={() => { setDetailTab("members"); onCloseEdit() }} onNotice={onNotice} /></div>}</TabsContent>
      </Tabs>
    </div>}
    </div>
  )
}

function GroupRoutingPanel({ group, groups, config, onSaved, onNotice }: { group: ProxyGroup; groups: ProxyGroup[]; config: RoutingRulesConfig; onSaved: (config: RoutingRulesConfig) => void; onNotice: RoutingPageProps["onNotice"] }) {
  const [values, setValues] = useState<Record<string, string>>(() => routeValues(config, group.id, groups))
  const [saving, setSaving] = useState(false)

  useEffect(() => { setValues(routeValues(config, group.id, groups)) }, [config, group.id, groups])

  async function save() {
    setSaving(true)
    try {
      const next: RoutingRulesConfig = { rule_sets: config.rule_sets.map((set) => {
        const routes = expandedRoutes(set, groups).filter((route) => route.proxy_group_id !== group.id)
        const action = actionFromValue(values[set.id] ?? "")
        if (action) routes.push({ proxy_group_id: group.id, action })
        return { ...set, routes, applied_group_ids: undefined, action: undefined }
      }) }
      const saved = await api.updateRoutingRules(next)
      onSaved(saved)
      onNotice(`${group.name} 的路由策略已应用`)
    } catch (error) { onNotice(error instanceof Error ? error.message : "应用路由策略失败", "error") }
    finally { setSaving(false) }
  }

  const aliases = config.rule_sets.filter((set) => set.enabled)
  return <div className="overflow-hidden rounded-md border bg-card">
    <div className="flex items-center justify-between border-b bg-muted/60 px-3 py-2.5"><div><div className="text-xs font-semibold">{group.name} 的独立路由</div><div className="mt-0.5 text-[11px] text-muted-foreground">仅影响绑定到此代理组的入口流量，按站点别名优先级匹配。</div></div><Button size="sm" onClick={() => void save()} disabled={saving}>{saving ? <LoaderCircle className="animate-spin" /> : <Save />}保存策略</Button></div>
    {aliases.length === 0 ? <div className="px-4 py-8 text-center text-xs text-muted-foreground">请先到“站点别名”页面创建网页组。</div> : <div className="divide-y">{aliases.map((set) => <div key={set.id} className="grid gap-2 px-3 py-3 sm:grid-cols-[minmax(180px,1fr)_minmax(220px,320px)] sm:items-center"><div className="min-w-0"><div className="flex items-center gap-2"><span className="truncate text-xs font-medium">{set.name}</span><Badge variant="secondary">{set.rules.length} 项</Badge></div><div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">{set.id}</div></div><Select value={values[set.id] || "none"} onValueChange={(value) => setValues((current) => ({ ...current, [set.id]: value === "none" ? "" : value }))}><SelectTrigger aria-label={`${set.name} 路由动作`}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">不在此组使用</SelectItem><SelectItem value="direct">直连 DIRECT</SelectItem><SelectItem value="reject">阻断 REJECT</SelectItem>{groups.filter((item) => item.enabled).map((item) => <SelectItem key={item.id} value={`group:${item.id}`}>转到 {item.name}</SelectItem>)}</SelectContent></Select></div>)}</div>}
  </div>
}

function expandedRoutes(set: RoutingRuleSet, groups: ProxyGroup[]) {
  if (set.routes?.length) return [...set.routes]
  if (!set.action?.type) return []
  const ids = set.applied_group_ids?.length ? set.applied_group_ids : groups.map((group) => group.id)
  return ids.map((proxy_group_id) => ({ proxy_group_id, action: set.action as RoutingAction }))
}

function routeValues(config: RoutingRulesConfig, groupID: string, groups: ProxyGroup[]): Record<string, string> {
  return Object.fromEntries(config.rule_sets.map((set) => {
    const action = expandedRoutes(set, groups).find((route) => route.proxy_group_id === groupID)?.action
    return [set.id, action?.type === "proxy_group" ? `group:${action.proxy_group_id}` : action?.type ?? ""]
  }))
}

function actionFromValue(value: string): RoutingAction | null {
  if (value === "direct" || value === "reject") return { type: value }
  if (value.startsWith("group:")) return { type: "proxy_group", proxy_group_id: value.slice(6) }
  return null
}

function ServiceMember({ name, protocol, state, latency, source }: { name: string; protocol: string; state: string; latency: number | null | undefined; source: string }) {
  return <div className="grid gap-2 border-b px-3 py-2 text-xs last:border-b-0 sm:grid-cols-[minmax(180px,1fr)_90px_110px_90px_minmax(100px,0.7fr)] sm:items-center"><span className="truncate font-medium" title={name}>{name}</span><Badge variant="outline">{protocol}</Badge><Badge variant={state === "healthy" || state === "可用" ? "success" : state === "quarantined" ? "warning" : "secondary"}>{state}</Badge><span className="tabular-nums text-muted-foreground">{latency == null ? "未测试" : `${latency} ms`}</span><span className="truncate text-muted-foreground" title={source}>{source}</span></div>
}

function CreateProxyServiceForm({ nodes, subscriptions, sharedInbound, onCreated, onNotice }: { nodes: NodeRecord[]; subscriptions: Subscription[]; sharedInbound: SharedInboundSettings | null; onCreated: () => Promise<void>; onNotice: RoutingPageProps["onNotice"] }) {
  // In shared mode the bind address and port belong to the aggregate listener,
  // so the form shows them read-only and the backend derives the real endpoint.
  const shared = sharedInbound?.mode === "shared"
  const [name, setName] = useState("")
  const [strategy, setStrategy] = useState<ProxyGroupStrategy>("manual")
  const [sourceMode, setSourceMode] = useState<"direct" | "rule" | "manual">("direct")
  const [selectedSubscriptions, setSelectedSubscriptions] = useState<string[]>([])
  const [selectedNodes, setSelectedNodes] = useState<string[]>([])
  const [selectedRegions, setSelectedRegions] = useState<string[]>(["jp"])
  const [limit, setLimit] = useState(5)
  const [maxLatency, setMaxLatency] = useState(2000)
  const [kind, setKind] = useState<ListenerKind>("mixed")
  const [bindAddress, setBindAddress] = useState("0.0.0.0")
  const [port, setPort] = useState(7890)
  const [authEnabled, setAuthEnabled] = useState(true)
  const [username, setUsername] = useState("hx-user")
  const [password, setPassword] = useState<string>(crypto.randomUUID())
  const [publicHost, setPublicHost] = useState("")
  const [publicPort, setPublicPort] = useState("")
  const [publicTLS, setPublicTLS] = useState(false)
  const [wsPath, setWSPath] = useState("/__hx-proxy__/hx-proxy")
  const [submitting, setSubmitting] = useState(false)

  const estimated = useMemo(() => sourceMode === "direct" ? 1 : sourceMode === "manual" ? selectedNodes.length : nodes.filter((node) => {
    if (!node.sources.some((source) => selectedSubscriptions.includes(source.subscription_id))) return false
    if (node.last_latency_ms == null || node.last_latency_ms > maxLatency) return false
    return selectedRegions.length === 0 || selectedRegions.some((region) => matchesRegion(node.display_name, region))
  }).slice(0, limit).length, [limit, maxLatency, nodes, selectedNodes.length, selectedRegions, selectedSubscriptions, sourceMode])

  async function submit(event: FormEvent) {
    event.preventDefault()
    const nonLoopback = bindAddress.trim() !== "" && !["127.0.0.1", "::1", "localhost"].includes(bindAddress.trim())
    if (nonLoopback && !authEnabled) {
      onNotice("非环回监听地址（如 0.0.0.0）必须启用用户名密码认证", "error")
      return
    }
    setSubmitting(true)
    try {
      await api.createProxyService({
        name: name.trim(), strategy,
        source_spec: sourceMode === "direct" ? { node_ids: [], include_direct: true } : sourceMode === "rule" ? {
          node_ids: [], subscription_ids: selectedSubscriptions, regions: selectedRegions, states: ["candidate", "healthy", "degraded"],
          max_latency_ms: maxLatency, sort_by: "latency", limit, include_direct: false,
        } : { node_ids: selectedNodes, include_direct: false },
        empty_behavior: sourceMode === "direct" ? "direct" : "fail-closed",
        listener: {
          name: `${name.trim()} 入口`, kind, bind_address: bindAddress.trim(), port,
          auth: authEnabled ? { username: username.trim(), password } : undefined,
          transport: advanced ? { type: "ws", ws_path: wsPath.trim() } : undefined,
          public_endpoint: publicHost.trim() ? { host: publicHost.trim(), port: advanced ? 443 : (Number(publicPort) || port), tls: advanced || publicTLS } : undefined,
        },
      })
      setName("")
      await onCreated()
      onNotice(shared ? `代理服务已加入共享入口：${username.trim()}` : `代理服务已启动：${bindAddress}:${port}`)
    } catch (error) { onNotice(error instanceof Error ? error.message : "创建代理服务失败", "error") }
    finally { setSubmitting(false) }
  }

  const validSource = sourceMode === "direct" || (sourceMode === "rule" ? selectedSubscriptions.length > 0 : selectedNodes.length > 0)
  const advanced = kind === "vless" || kind === "vmess" || kind === "trojan"
  const nonLoopback = bindAddress.trim() !== "" && !["127.0.0.1", "::1", "localhost"].includes(bindAddress.trim())
  function changeKind(next: ListenerKind) {
    setKind(next)
    const nextAdvanced = next === "vless" || next === "vmess" || next === "trojan"
    if (nextAdvanced) {
      setBindAddress("127.0.0.1")
      setAuthEnabled(true)
      if (!username) setUsername("hx-user")
      if ((next === "vless" || next === "vmess") && !password) setPassword(crypto.randomUUID())
    }
  }
  function changeSourceMode(next: "direct" | "rule" | "manual") {
    setSourceMode(next)
    if (next === "direct") setStrategy("manual")
  }
  return (
    <form onSubmit={submit} className="overflow-hidden rounded-lg border bg-card lg:min-h-0 lg:overflow-y-auto">
      <PanelHeader title="新建代理服务" description="入口与聚合规则一次创建" />
      <div className="space-y-4 p-3">
        <Field label="服务名称"><Input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：日本低延迟出口" required /></Field>
        <Field label="节点来源"><ChipSet values={[{ value: "direct", label: "服务器直连" }, { value: "rule", label: "跨订阅规则" }, { value: "manual", label: "固定节点" }]} current={sourceMode} onChange={changeSourceMode} /></Field>
        {sourceMode === "direct" ? <div className="flex items-center gap-2 rounded-md border bg-muted/60 px-3 py-2 text-xs"><Server className="size-4 text-success" />流量使用当前服务器网络出口</div> : sourceMode === "rule" ? <>
          <Field label={`订阅（已选 ${selectedSubscriptions.length}）`}><CheckList items={subscriptions.map((item) => ({ id: item.id, label: item.name }))} selected={selectedSubscriptions} onChange={setSelectedSubscriptions} empty="暂无已启用订阅" /></Field>
          <Field label="地区"><MultiChipSet values={regions} current={selectedRegions} onChange={setSelectedRegions} /></Field>
          <div className="grid grid-cols-2 gap-2"><Field label="最多节点"><Input type="number" min={1} max={500} value={limit} onChange={(event) => setLimit(Number(event.target.value))} /></Field><Field label="最大延迟 ms"><Input type="number" min={1} max={60000} value={maxLatency} onChange={(event) => setMaxLatency(Number(event.target.value))} /></Field></div>
          <div className="flex items-center gap-2 rounded-md border bg-muted/60 px-3 py-2 text-xs"><Gauge className="size-4 text-info" />当前指标预计命中 {estimated} 个节点</div>
        </> : <Field label={`固定节点（已选 ${selectedNodes.length}）`}><CheckList items={nodes.map((item) => ({ id: item.id, label: `${item.display_name} · ${item.last_latency_ms == null ? "未测试" : `${item.last_latency_ms}ms`}` }))} selected={selectedNodes} onChange={setSelectedNodes} empty="暂无活动节点" /></Field>}
        <Field label="出站策略"><ChipSet values={strategies} current={strategy} onChange={setStrategy} /></Field>
        <div className="border-t pt-3"><div className="mb-3 text-xs font-semibold">入口与登录</div><div className="space-y-3"><Field label="入口协议"><ChipSet values={kinds} current={kind} onChange={changeKind} /></Field>{shared ? <div className="flex items-start gap-2 rounded-md border border-info-border bg-info-muted px-3 py-2 text-xs text-info-foreground"><Cable className="mt-0.5 size-3.5 shrink-0" /><span>共享入口模式：本服务将复用现有入口（{advanced ? `VLESS / VMess / Trojan 内部端口 ${sharedInbound?.ws_port || 7891}` : `Mixed 端口 ${sharedInbound?.mixed_port || 7890}`}），按用户名自动分流，不会再占用新的端口。</span></div> : null}<div className="grid grid-cols-[1fr_110px] gap-2"><Field label="绑定 IP"><Input value={bindAddress} onChange={(event) => setBindAddress(event.target.value)} disabled={advanced || shared} required />{!advanced && nonLoopback && !authEnabled && <span className="block text-xs text-destructive">非环回监听地址（如 0.0.0.0）必须启用用户名密码认证</span>}{!advanced && nonLoopback && authEnabled && <span className="block text-xs text-muted-foreground">监听 0.0.0.0 供内网 / Docker 容器访问，公网由防火墙保护</span>}</Field><Field label="本地端口"><Input type="number" min={1} max={65535} value={port} onChange={(event) => setPort(Number(event.target.value))} disabled={shared} required /></Field></div>{advanced && <div className="grid grid-cols-[1fr_140px] gap-2"><Field label="Cloudflare 域名"><Input value={publicHost} onChange={(event) => setPublicHost(event.target.value)} placeholder="proxy.example.com" required /></Field><Field label="WebSocket Path（固定前缀 /__hx-proxy__/）"><Input value={wsPath} onChange={(event) => setWSPath(event.target.value)} placeholder="/__hx-proxy__/hx-proxy" required /></Field></div>}{!advanced && <div className="grid grid-cols-[1fr_110px] gap-2"><Field label="公网主机名 / IP（可选）"><Input value={publicHost} onChange={(event) => setPublicHost(event.target.value)} placeholder="VPS 公网地址" /></Field><Field label="公网端口"><Input type="number" min={1} max={65535} value={publicPort} onChange={(event) => setPublicPort(event.target.value)} placeholder={String(port)} /></Field></div>}{!advanced && publicHost.trim() && <label className="flex items-center gap-2 rounded-md border bg-muted/60 px-3 py-2 text-xs"><Checkbox checked={publicTLS} onCheckedChange={(value) => setPublicTLS(value === true)} />公网 HTTP 端点使用 TLS</label>}{!advanced && <><label className="flex items-center gap-2 rounded-md border bg-muted/60 px-3 py-2 text-xs"><Checkbox checked={authEnabled || shared} disabled={shared} onCheckedChange={(value) => setAuthEnabled(value === true)} />启用账号认证</label>{shared && <p className="text-xs text-muted-foreground">共享入口必须启用账号认证：Mihomo 依靠登录名把每个服务分流到它自己的代理组。</p>}</>}{authEnabled && <div className="grid grid-cols-2 gap-2"><Field label={advanced ? "用户备注" : "用户名"}><Input value={username} onChange={(event) => setUsername(event.target.value)} required /></Field><Field label={kind === "vless" || kind === "vmess" ? "UUID" : "密码"}><Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} required /></Field></div>}</div></div>
        <Button type="submit" disabled={submitting || !name.trim() || !validSource || (nonLoopback && !authEnabled) || (authEnabled && (!username.trim() || !password)) || (advanced && (!publicHost.trim() || !wsPath.startsWith("/")))} className="w-full">{submitting ? <LoaderCircle className="animate-spin" /> : <Plus />}创建并启动</Button>
      </div>
    </form>
  )
}

function DataPlaneBand({ status, loading }: { status: DataPlaneStatus | null; loading: boolean }) {
  const running = status?.running === true
  return <section className="grid overflow-hidden rounded-lg border bg-card md:grid-cols-[220px_1fr]"><div className={cn("flex items-center gap-3 px-4 py-4", running ? "bg-success-muted" : status?.state === "failed" ? "bg-destructive/10" : "bg-muted/60")}>{loading ? <LoaderCircle className="size-5 animate-spin" /> : running ? <CheckCircle2 className="size-5 text-success" /> : <CircleAlert className="size-5 text-warning" />}<div><div className="font-semibold">{loading ? "检测中" : running ? "Mihomo 运行中" : status?.available ? "Mihomo 空闲" : "Mihomo 不可用"}</div><div className="mt-0.5 text-[11px] text-muted-foreground">{status?.listener_count ?? 0} 个活动入口</div></div></div><div className="grid gap-2 px-4 py-3 text-xs sm:grid-cols-3"><Info label="进程" value={status?.pid ? `PID ${status.pid}` : "—"} /><Info label="最近应用" value={formatDate(status?.last_apply_at)} /><Info label="版本" value={status?.version || "—"} /></div></section>
}

function CheckList({ items, selected, onChange, empty }: { items: Array<{ id: string; label: string }>; selected: string[]; onChange: (ids: string[]) => void; empty: string }) {
  return <div className="max-h-40 overflow-y-auto rounded-md border">{items.length === 0 ? <div className="px-3 py-4 text-center text-xs text-muted-foreground">{empty}</div> : items.map((item) => { const checked = selected.includes(item.id); return <label key={item.id} className="flex cursor-pointer items-center gap-2 border-b px-3 py-2 text-xs last:border-b-0 hover:bg-muted/60"><Checkbox checked={checked} onCheckedChange={(value) => onChange(value === true ? [...selected, item.id] : selected.filter((id) => id !== item.id))} /><span className="min-w-0 flex-1 truncate">{item.label}</span></label> })}</div>
}

function PanelHeader({ title, description, count }: { title: string; description: string; count?: number }) { return <div className="flex items-center justify-between border-b bg-muted/60 px-3 py-2.5"><div><div className="text-sm font-semibold">{title}</div><div className="mt-0.5 text-[11px] text-muted-foreground">{description}</div></div>{count != null && <Badge variant="secondary">{count}</Badge>}</div> }
function EmptyState() { return <div className="flex min-h-48 flex-col items-center justify-center px-4 text-center"><Cable className="mb-2 size-7 text-muted-foreground" /><div className="text-sm font-medium">还没有代理服务</div><div className="mt-1 text-xs text-muted-foreground">创建入口并绑定跨订阅节点规则。</div></div> }
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="block space-y-1.5"><span className="text-xs font-medium">{label}</span>{children}</label> }
function Info({ label, value }: { label: string; value: string }) { return <div className="min-w-0"><div className="text-[11px] text-muted-foreground">{label}</div><div className="mt-0.5 block truncate" title={value}>{value}</div></div> }
function Choice({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) { return <Button type="button" size="sm" variant={active ? "default" : "outline"} onClick={onClick}>{children}</Button> }
function ChipSet<T extends string>({ values, current, onChange }: { values: Array<{ value: T; label: string }>; current: T; onChange: (value: T) => void }) { return <div className="flex flex-wrap gap-1.5">{values.map((item) => <Choice key={item.value} active={current === item.value} onClick={() => onChange(item.value)}>{item.label}</Choice>)}</div> }
function MultiChipSet<T extends string>({ values, current, onChange }: { values: Array<{ value: T; label: string }>; current: T[]; onChange: (value: T[]) => void }) { return <div className="flex flex-wrap gap-1.5">{values.map((item) => { const active = current.includes(item.value); return <Choice key={item.value} active={active} onClick={() => onChange(active ? current.filter((value) => value !== item.value) : [...current, item.value])}>{item.label}</Choice> })}</div> }
function strategyLabel(strategy: ProxyGroupStrategy): string { return strategies.find((item) => item.value === strategy)?.label || strategy }
function regionLabel(region: string): string { return regions.find((item) => item.value === region)?.label || region }
function matchesRegion(name: string, region: string): boolean { const lower = name.toLowerCase(); const aliases: Record<string, string[]> = { jp: ["jp", "japan", "日本", "东京", "大阪", "tokyo", "osaka"], hk: ["hk", "香港", "hong kong"], tw: ["tw", "台湾", "台灣", "taipei"], sg: ["sg", "新加坡", "singapore"], us: ["us", "美国", "usa", "los angeles"], kr: ["kr", "韩国", "korea", "seoul"] }; return (aliases[region] || [region]).some((value) => lower.includes(value)) }

function resolveServiceNodes(group: ProxyGroup | undefined, nodes: NodeRecord[]): NodeRecord[] {
  if (!group) return []
  const spec = group.source_spec
  const byID = new Map(nodes.map((node) => [node.id, node]))
  const result = spec.node_ids.map((id) => byID.get(id)).filter((node): node is NodeRecord => Boolean(node))
  if (spec.subscription_ids?.length) {
    const dynamic = nodes.filter((node) => {
      if (!node.sources.some((source) => spec.subscription_ids?.includes(source.subscription_id))) return false
      if (spec.protocols?.length && !spec.protocols.includes(node.protocol.toLowerCase())) return false
      if (spec.states?.length && !spec.states.includes(node.lifecycle_state as typeof spec.states[number])) return false
      if (spec.name_keywords?.length && !spec.name_keywords.some((keyword) => node.display_name.toLowerCase().includes(keyword.toLowerCase()))) return false
      if (spec.regions?.length && !spec.regions.some((region) => matchesRegion(node.display_name, region))) return false
      if (spec.max_latency_ms && (node.last_latency_ms == null || node.last_latency_ms > spec.max_latency_ms)) return false
      return true
    }).sort((left, right) => spec.sort_by === "name"
      ? left.display_name.localeCompare(right.display_name)
      : (left.last_latency_ms ?? Number.MAX_SAFE_INTEGER) - (right.last_latency_ms ?? Number.MAX_SAFE_INTEGER) || left.id.localeCompare(right.id))
    for (const node of (spec.limit ? dynamic.slice(0, spec.limit) : dynamic)) {
      if (!result.some((item) => item.id === node.id)) result.push(node)
    }
  }
  return result
}
