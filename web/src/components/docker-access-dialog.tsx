import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { api } from "@/lib/api"
import { dockerEndpoint, dockerProxyURI } from "@/lib/docker-endpoint"
import type { ListenerRecord, SharedInboundSettings } from "@/lib/types"

// See .agents/notes/implemented/feature/2026-10-14-docker-reachable-address.md.
export function DockerAccessDialog({ listener, gateway, sharedInbound, subscriptionURL, onClose }: {
  listener: ListenerRecord; gateway: string; sharedInbound: SharedInboundSettings | null
  subscriptionURL?: string; onClose: () => void
}) {
  const [value, setValue] = useState("")
  const [status, setStatus] = useState("正在读取连接信息…")
  const ws = ["vless", "vmess", "trojan"].includes(listener.kind)
  const effective = listener.shared_inbound === "standard" && sharedInbound
    ? { ...listener, bind_address: sharedInbound.mixed_bind_address || "0.0.0.0", port: sharedInbound.mixed_port || 7890 }
    : listener
  const address = dockerEndpoint(effective, gateway)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        if (!listener.enabled) throw new Error("该服务已停用，请启用后再连接")
        if (ws) {
          const url = subscriptionURL || (listener.share_path && api.listenerShareURL(listener.share_path, "clash"))
          if (!url) throw new Error("请先配置公网域名并发布渠道订阅")
          setValue(url)
          setStatus("这是 Mihomo 订阅，不是 HTTP_PROXY 地址。请按下方步骤落地。")
          return
        }
        if (!address) throw new Error("容器无法直连此绑定地址：请在全局配置中检查共享 Mixed 绑定 IP，并确认宿主机网桥地址可达。环回监听仅供宿主本机使用。")
        if (!listener.share_path) throw new Error("该服务没有可用订阅，无法读取认证信息")
        const content = await api.listenerShareContent(listener.share_path)
        if (cancelled) return
        const uri = dockerProxyURI(address, listener.kind, content, listener.auth_configured)
        setValue(uri)
        try {
          await navigator.clipboard.writeText(uri)
          if (!cancelled) setStatus("带认证的 Docker 代理 URI 已复制。")
        } catch {
          if (!cancelled) setStatus("浏览器未允许自动复制，请点击下方复制按钮，或选中文本手动复制。")
        }
      } catch (error) {
        if (!cancelled) setStatus(error instanceof Error ? error.message : "读取连接信息失败")
      }
    }
    void load()
    return () => { cancelled = true }
  }, [address, listener, subscriptionURL, ws])

  async function copy() {
    try { await navigator.clipboard.writeText(value); setStatus("已复制；连接信息含凭据，请勿公开。") }
    catch { setStatus("复制未获授权，请选中连接信息后按 Ctrl+C / Command+C。") }
  }

  return <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
    <DialogContent>
      <DialogHeader><DialogTitle>Docker 使用方式</DialogTitle><DialogDescription>固定入口与认证信息；不会创建新端口或自动修改防火墙。</DialogDescription></DialogHeader>
      <div className="space-y-4 p-5 text-sm">
        <p role="status">{status}</p>
        {value && <><Textarea aria-label={ws ? "Mihomo 订阅 URL" : "Docker 代理 URI"} readOnly value={value} onFocus={event => event.target.select()} className="break-all font-mono text-xs" /><Button onClick={() => void copy()}>复制{ws ? "订阅 URL" : "认证代理 URI"}</Button></>}
        {ws ? <div className="space-y-2 text-xs leading-5 text-muted-foreground">
          <p>VLESS / VMess / Trojan 经 HTTPS 固定端口和 WebSocket Path 路由，不能直接填入 HTTP_PROXY 或 HTTPS_PROXY。</p>
          <p>1. 将此订阅导入容器内或 sidecar 的 Mihomo，保存为 config.yaml；订阅 URL 是凭据，勿公开。</p>
          <p>2. 在客户端配置中启用 mixed-port: 7890。应用与 Mihomo 共享网络命名空间时使用 http://127.0.0.1:7890；不同容器时使用 http://mihomo:7890，且仅在私有 Docker 网络中配置 allow-lan: true。</p>
          <p>3. 应用的 HTTP_PROXY / HTTPS_PROXY 指向该客户端入口。不要把订阅 URL、控制 URL 或源站内部 WS 端口当作普通代理。</p>
        </div> : <div className="space-y-2 text-xs leading-5 text-muted-foreground">
          <p>{listener.kind === "socks" ? "将认证 URI 填入 ALL_PROXY（应用须支持 SOCKS5）。" : "将同一个 http:// 认证 URI 填入 HTTP_PROXY 和 HTTPS_PROXY；HTTPS 目标通过 CONNECT，不要改成 https://。"}</p>
          <p>0.0.0.0 是监听范围，不是连接目标。这里使用宿主机网桥 / LAN 地址和服务认证；共享入口按认证用户名选择出口。</p>
          <p>容器内可用 curl --proxy "$HTTP_PROXY" https://example.com 验证。地址是候选值，隔离网桥、rootless Docker 或防火墙仍可能阻止访问。</p>
        </div>}
      </div>
    </DialogContent>
  </Dialog>
}
