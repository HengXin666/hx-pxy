import { useMemo, useState } from "react"
import { Check, LoaderCircle, Save } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { api } from "@/lib/api"
import { strategyMeta } from "@/lib/proxy-groups"
import type { ListenerKind, ListenerRecord, NodeRecord, ProxyGroup, ProxyGroupStrategy, Subscription } from "@/lib/types"

type Notice = (message: string, tone?: "success" | "error") => void

export function EditProxyServiceForm({ listener, group, nodes, subscriptions, onSaved, onCancel, onNotice }: { listener: ListenerRecord; group: ProxyGroup; nodes: NodeRecord[]; subscriptions: Subscription[]; onSaved: () => Promise<void>; onCancel: () => void; onNotice: Notice }) {
  const initialMode = group.source_spec.include_direct ? "direct" : group.source_spec.subscription_ids?.length ? "rule" : "manual"
  const [name, setName] = useState(group.name)
  const [mode, setMode] = useState<"direct" | "rule" | "manual">(initialMode)
  const [strategy, setStrategy] = useState<ProxyGroupStrategy>(group.strategy)
  const [subscriptionIDs, setSubscriptionIDs] = useState(group.source_spec.subscription_ids ?? [])
  const [nodeIDs, setNodeIDs] = useState(group.source_spec.node_ids)
  const [limit, setLimit] = useState(group.source_spec.limit ?? 0)
  const [maxLatency, setMaxLatency] = useState(group.source_spec.max_latency_ms ?? 2000)
  const [kind, setKind] = useState<ListenerKind>(listener.kind)
  const [bindAddress, setBindAddress] = useState(listener.bind_address)
  const [port, setPort] = useState(listener.port)
  const [enabled, setEnabled] = useState(listener.enabled)
  const [publicHost, setPublicHost] = useState(listener.public_endpoint?.host ?? "")
  const [publicPort, setPublicPort] = useState(String(listener.public_endpoint?.port || listener.port))
  const [publicTLS, setPublicTLS] = useState(listener.public_endpoint?.tls ?? false)
  const [wsPath, setWSPath] = useState(listener.transport?.ws_path ?? "/__hx-proxy__/hx-proxy")
  const [replaceAuth, setReplaceAuth] = useState(false)
  const [clearAuth, setClearAuth] = useState(false)
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [saving, setSaving] = useState(false)
  const advanced = ["vless", "vmess", "trojan"].includes(kind)
  const boundAddress = advanced ? "127.0.0.1" : bindAddress.trim()
  const nonLoopback = boundAddress !== "" && !["127.0.0.1", "::1", "localhost"].includes(boundAddress)
  const authConfigured = (listener.auth_configured && !clearAuth) || replaceAuth
  const valid = name.trim() && port > 0 && port < 65536 && (mode === "direct" || (mode === "rule" ? subscriptionIDs.length : nodeIDs.length)) && (!advanced || (publicHost.trim() && wsPath.startsWith("/"))) && (!replaceAuth || (username.trim() && password)) && (!nonLoopback || authConfigured)

  const selectedSummary = useMemo(() => mode === "direct" ? "当前服务器 DIRECT" : mode === "rule" ? `${subscriptionIDs.length} 个订阅，Top ${limit || "全部"}` : `${nodeIDs.length} 个固定节点`, [limit, mode, nodeIDs.length, subscriptionIDs.length])

  async function save() {
    setSaving(true)
    try {
      await api.updateProxyService({
        group_id: group.id,
        group_version: group.version,
        name: name.trim(),
        strategy: mode === "direct" ? "manual" : strategy,
        source_spec: mode === "direct" ? { node_ids: [], include_direct: true } : mode === "rule" ? { ...group.source_spec, node_ids: [], subscription_ids: subscriptionIDs, max_latency_ms: maxLatency, limit: limit || undefined, sort_by: "latency", include_direct: false } : { node_ids: nodeIDs, include_direct: false },
        empty_behavior: mode === "direct" ? "direct" : "fail-closed",
        enabled: group.enabled,
        fallback_target_id: group.fallback_target_id,
        // Carried through unchanged: this form does not edit the egress chain, and
        // omitting it would silently drop the chain on an unrelated save.
        dialer_proxy_group_id: group.dialer_proxy_group_id,
        listener_id: listener.id,
        listener_version: listener.version,
        listener: {
          name: `${name.trim()} 入口`,
          kind,
          bind_address: boundAddress,
          port,
          auth: replaceAuth ? { username: username.trim(), password } : undefined,
          clear_auth: clearAuth,
          transport: advanced ? { type: "ws", ws_path: wsPath.trim() } : undefined,
          public_endpoint: publicHost.trim() ? { host: publicHost.trim(), port: advanced ? 443 : (Number(publicPort) || port), tls: advanced || publicTLS } : undefined,
          enabled,
        },
      })
      await onSaved()
      onNotice("代理服务已校验、保存并重新应用")
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "保存代理服务失败", "error")
      // A failed composite save bumps the group/listener versions during the
      // rollback; reload so the form is rebuilt with current versions and a
      // retry does not hit a stale optimistic-lock conflict.
      await onSaved()
    } finally { setSaving(false) }
  }

  return <div className="space-y-4 p-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><div><div className="text-sm font-semibold">实时编辑服务</div><div className="mt-0.5 text-[11px] text-muted-foreground">{selectedSummary}</div></div><div className="flex gap-2"><Button variant="outline" onClick={onCancel} disabled={saving}>取消</Button><Button onClick={() => void save()} disabled={saving || !valid}>{saving ? <LoaderCircle className="animate-spin" /> : <Save />}{saving ? "正在校验并应用" : "保存并应用"}</Button></div></div>
    <div className="grid gap-3 md:grid-cols-3"><Field label="服务名称"><Input value={name} onChange={(event) => setName(event.target.value)} /></Field><Field label="节点来源"><Select value={mode} onValueChange={(value) => setMode(value as typeof mode)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="direct">服务器直连</SelectItem><SelectItem value="rule">跨订阅规则</SelectItem><SelectItem value="manual">固定节点</SelectItem></SelectContent></Select></Field><Field label="出站策略"><Select value={strategy} onValueChange={(value) => setStrategy(value as ProxyGroupStrategy)} disabled={mode === "direct"}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{Object.entries(strategyMeta).map(([value, meta]) => <SelectItem key={value} value={value}>{meta.label}</SelectItem>)}</SelectContent></Select></Field></div>
    {mode === "rule" && <div className="grid gap-3 md:grid-cols-[1fr_120px_140px]"><CheckGrid title="订阅" items={subscriptions.map((item) => ({ id: item.id, label: item.name }))} selected={subscriptionIDs} onChange={setSubscriptionIDs} /><Field label="最多节点"><Input type="number" min={0} max={500} value={limit} onChange={(event) => setLimit(Number(event.target.value))} /></Field><Field label="最大延迟 ms"><Input type="number" min={0} max={60000} value={maxLatency} onChange={(event) => setMaxLatency(Number(event.target.value))} /></Field></div>}
    {mode === "manual" && <CheckGrid title="固定节点" items={nodes.map((item) => ({ id: item.id, label: `${item.display_name} · ${item.last_latency_ms == null ? "未测试" : `${item.last_latency_ms}ms`}` }))} selected={nodeIDs} onChange={setNodeIDs} />}
    <div className="border-t pt-4"><div className="mb-3 text-xs font-semibold">入口配置</div><div className="grid gap-3 md:grid-cols-4"><Field label="协议"><Select value={kind} onValueChange={(value) => setKind(value as ListenerKind)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{["mixed", "http", "socks", "vless", "vmess", "trojan"].map((value) => <SelectItem key={value} value={value}>{value.toUpperCase()}{["vless", "vmess", "trojan"].includes(value) ? " WS" : ""}</SelectItem>)}</SelectContent></Select></Field><Field label="绑定 IP"><Input value={advanced ? "127.0.0.1" : bindAddress} onChange={(event) => setBindAddress(event.target.value)} disabled={advanced} />{nonLoopback && !authConfigured && <span className="block text-xs text-destructive">非环回监听地址（如 0.0.0.0）必须设置用户名/密码认证</span>}{nonLoopback && authConfigured && <span className="block text-xs text-muted-foreground">非环回地址监听 0.0.0.0，内网/Docker 容器可直接访问，公网由防火墙保护</span>}</Field><Field label="端口"><Input type="number" min={1} max={65535} value={port} onChange={(event) => setPort(Number(event.target.value))} /></Field><label className="flex h-8 items-center gap-2 self-end rounded-md border bg-card px-3 text-xs"><Checkbox checked={enabled} onCheckedChange={(value) => setEnabled(value === true)} />启用入口</label></div></div>
    {advanced && <div className="grid gap-3 md:grid-cols-2"><Field label="Cloudflare / 雷池域名"><Input value={publicHost} onChange={(event) => setPublicHost(event.target.value)} /></Field><Field label="WebSocket Path（固定前缀 /__hx-proxy__/）"><Input value={wsPath} onChange={(event) => setWSPath(event.target.value)} /></Field></div>}
    {!advanced && <div className="grid gap-3 md:grid-cols-2"><Field label="公网主机名 / IP（可选）"><Input value={publicHost} onChange={(event) => setPublicHost(event.target.value)} placeholder="VPS 公网地址" /></Field><Field label="公网端口"><Input type="number" min={1} max={65535} value={publicPort} onChange={(event) => setPublicPort(event.target.value)} /></Field><label className="flex items-center gap-2 rounded-md border bg-card px-3 py-2 text-xs md:col-span-2"><Checkbox checked={publicTLS} onCheckedChange={(value) => setPublicTLS(value === true)} />公网 HTTP 端点使用 TLS</label></div>}
    <div className="grid gap-3 md:grid-cols-2"><label className="flex items-center gap-2 rounded-md border bg-card px-3 py-2 text-xs"><Checkbox checked={replaceAuth} onCheckedChange={(value) => { setReplaceAuth(value === true); if (value) setClearAuth(false) }} />设置新凭据</label><label className="flex items-center gap-2 rounded-md border bg-card px-3 py-2 text-xs"><Checkbox checked={clearAuth} onCheckedChange={(value) => { setClearAuth(value === true); if (value) setReplaceAuth(false) }} disabled={advanced} />清除现有认证</label></div>
    {replaceAuth && <div className="grid gap-3 md:grid-cols-2"><Field label={advanced ? "用户备注" : "用户名"}><Input value={username} onChange={(event) => setUsername(event.target.value)} /></Field><Field label={kind === "vless" || kind === "vmess" ? "UUID" : "密码"}><Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} /></Field></div>}
  </div>
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="block space-y-1.5"><span className="text-xs font-medium">{label}</span>{children}</label> }
function CheckGrid({ title, items, selected, onChange }: { title: string; items: Array<{ id: string; label: string }>; selected: string[]; onChange: (ids: string[]) => void }) { return <div><div className="mb-1.5 text-xs font-medium">{title}</div><div className="grid max-h-36 gap-px overflow-y-auto rounded-md border bg-border sm:grid-cols-2">{items.map((item) => { const checked = selected.includes(item.id); return <label key={item.id} className="flex items-center gap-2 bg-card px-3 py-2 text-xs"><Checkbox checked={checked} onCheckedChange={(value) => onChange(value === true ? [...selected, item.id] : selected.filter((id) => id !== item.id))} /><span className="min-w-0 flex-1 truncate">{item.label}</span>{checked && <Check className="size-3 text-primary" />}</label> })}</div></div> }
