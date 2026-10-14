// See .agents/notes/implemented/feature/2026-10-14-docker-reachable-address.md.
export function dockerEndpoint(listener: { kind: string; bind_address: string; port: number }, gateway: string): string | null {
  if (!["http", "socks5", "socks", "mixed"].includes(listener.kind)) return null
  const bind = listener.bind_address.trim()
  if (!bind || bind === "localhost" || bind === "::1" || bind.startsWith("127.")) return null
  const host = bind === "0.0.0.0" || bind === "::" ? gateway.trim() : bind
  if (!host) return null
  return `${host.includes(":") ? `[${host}]` : host}:${listener.port}`
}
