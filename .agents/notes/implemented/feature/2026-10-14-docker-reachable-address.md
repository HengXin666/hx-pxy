# Agent Note: Docker copies use host address candidates, not public domains

Status: implemented

The dead-end refusal for loopback / WS / unauthenticated services is superseded by
.agents/notes/implemented/feature/2026-10-15-docker-access-entry.md.

## Problem

A container cannot dial the host listener at its own loopback address or at an unspecified bind address. A public domain can resolve to an edge rather than this host.

## Decision

GET /api/v1/system/network exposes up, non-loopback IPv4 candidates, excluding sysfs TUN devices. docker0 is preferred deterministically, then br-* and LAN. This is address discovery, not reachability proof. The copy helper only accepts ordinary HTTP/SOCKS/Mixed listeners, rejects loopback bindings and uses a specific bind address when present. Wildcard bindings use the discovered candidate. It never falls back to the public domain.

The Docker action opens a usage dialog and reuses the existing token-scoped URI
export to obtain authentication only on demand. It keeps percent-encoded credentials,
uses the effective shared carrier bind/port, and strips public TLS, path and display
fragment when targeting the plain Mihomo socket. HTTP/Mixed yields `http://`, SOCKS
yields `socks5h://`. Shared authentication selects the desired exit; bare `IP:port`
is insufficient. Credentials never appear in success notices or persistent storage.
Clipboard rejection leaves a selectable read-only URI and an explicit retry button.
WS entries show the channel/service Mihomo subscription and client-side landing
instructions instead of pretending they support ordinary proxy environment variables.

## Alternatives considered

- **Do nothing / copy the public endpoint:** it works for public clients, but unnecessarily sends local-container requests through an edge and cannot express direct host access.
- **Always copy host.docker.internal:** it is convenient on Docker Desktop, but Linux requires explicit host-gateway configuration.
- **Inspect every container network:** it identifies the selected network more accurately, but a generic service copy action has no selected container. The diagnostic surface handles individual containers instead.
- **Keep copying bare IP:port:** avoids reading credentials, but cannot authenticate
  the connection or select a shared service. The existing URI export avoids adding
  a second secret-bearing API, and the dialog explicitly warns about credential handling.

## Consequences

Firewall isolation, custom bridges and rootless Docker may make the candidate unreachable. The UI explains authentication and binding requirements. WS entries cannot be converted to plain host proxies by changing the hostname. Public TLS belongs to the reverse proxy, not the direct ordinary Mihomo socket. IPv6-specific bindings are bracketed by the helper; discovery currently offers IPv4 only. The dialog holds a credential-bearing URI until closed; a missing export or a disabled service fails closed.

## Testing

internal/api/system_network_test.go and web/e2e/docker-endpoint.test.ts cover candidate filtering, protocol/binding rejection, escaped credentials, direct-socket scheme selection and no domain fallback. Browser regressions cover successful and denied clipboard access and WS instructions on desktop/mobile.
