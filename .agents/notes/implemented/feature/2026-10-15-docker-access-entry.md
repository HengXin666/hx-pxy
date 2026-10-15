# Agent Note: Docker access offers a previewed companion entry instead of a dead end

Status: implemented

Supersedes the "reject and explain" part of
.agents/notes/implemented/feature/2026-10-14-docker-reachable-address.md (address
discovery and the credential-on-demand export described there still hold).

## Problem

「复制 Docker 使用地址」 validated only the service it was opened on. A loopback
dedicated listener, any VLESS / VMess / Trojan service, or a service without
credentials ended in a refusal ("该入口不能作为容器直连代理 ……"). The operator learned
the rule but had no path forward, although the control plane already knew everything
needed to build one: the egress (group or pinned node), the Docker bridges, and how to
create an authenticated listener safely.

## Decision

The server assesses (`internal/dockeraccess`, `GET /api/v1/listeners/{id}/docker-access`)
and returns one stable state: `ready` (an entry a container can dial), `needs_entry`
(a previewed plan), `client_landing` (residential channels keep their subscription /
control URL), or `blocked` (only the operator can fix it: service disabled, no Docker
bridge, a stranded companion). The UI branches on `state` and `reason`, never on text,
and shows copy buttons only for `ready`.

`needs_entry` previews a companion **Docker entry**: a Mixed listener with generated
credentials and the source's exact egress (`proxy_group_id` + `node_id`). Placement:

1. the existing shared Mixed entry when it is enabled and bound non-loopback — a new
   username on an already open port, no new port at all;
2. otherwise exactly one Docker bridge gateway address (docker0 first, then br-*
   compose bridges; the operator may pick another) with a port from 17890–17989 that no
   listener row uses and the host can bind. Never 0.0.0.0, never a LAN address.

`POST` applies only with `confirm: true` and the `plan.id` digest the preview showed; a
changed source, bridge or port yields a new id and the stale confirmation gets 409.
`DELETE` revokes (deletes the companion). The link lives in `docker_access_entries`
(migration 40), cascading on either listener. The shared-inbound migrator skips linked
companions so a bridge-bound entry is never folded back onto a loopback carrier.
Deleting a service in the UI revokes its companion first.

Mixed companions yield both `http://` (HTTP_PROXY / HTTPS_PROXY) and `socks5h://`
(ALL_PROXY, remote DNS) URIs.

## Alternatives considered

- **Rebind the source listener in place** to the bridge: breaks every host-side client
  using 127.0.0.1, and is impossible for WebSocket kinds (they must stay loopback behind
  the reverse proxy).
- **Rebind the shared Mixed carrier** when it is loopback: affects every member service
  at once; a companion touches nothing else.
- **Multi-address bind targets on one listener**: Mihomo listeners take one `listen`
  address, so this is N compiled listeners anyway; a separate row keeps one meaning per
  row and is reversible. Revisit if per-network membership grows (see C in the PR).
- **Auto-open firewall rules**: changes host policy outside HX's ownership; the dialog
  only shows a subnet-scoped example command.

## Consequences

A companion is a visible service row badged 「Docker 入口」; it follows edits to the
source's group but not a later re-pin of the source node. A removed bridge strands a
bridge companion (`entry_unreachable`) until revoked and recreated. Reachability is
still not proven: isolated networks, rootless Docker and host firewalls can block it.

## Testing

internal/dockeraccess (assessment table + apply/revoke/rollback with fakes),
internal/store/docker_access_test.go (cascade, uniqueness), internal/api/docker_access_test.go
(routes, 409 on stale plan), internal/sharedinbound (companions are not migrated),
web/e2e/docker-endpoint.test.ts and web/e2e/network-routing-regression.mjs (ready
direct, WS preview with no copy button, gateway switch, apply, revoke) at 1440/390 px.
