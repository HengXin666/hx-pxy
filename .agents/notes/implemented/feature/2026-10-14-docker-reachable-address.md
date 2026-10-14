# Agent Note: Docker copies use host address candidates, not public domains

Status: implemented

## Problem

A container cannot dial the host listener at its own loopback address or at an unspecified bind address. A public domain can resolve to an edge rather than this host.

## Decision

GET /api/v1/system/network exposes up, non-loopback IPv4 candidates, excluding sysfs TUN devices. docker0 is preferred deterministically, then br-* and LAN. This is address discovery, not reachability proof. The copy helper only accepts ordinary HTTP/SOCKS/Mixed listeners, rejects loopback bindings and uses a specific bind address when present. Wildcard bindings use the discovered candidate. It never falls back to the public domain.

## Alternatives considered

- **Do nothing / copy the public endpoint:** it works for public clients, but unnecessarily sends local-container requests through an edge and cannot express direct host access.
- **Always copy host.docker.internal:** it is convenient on Docker Desktop, but Linux requires explicit host-gateway configuration.
- **Inspect every container network:** it identifies the selected network more accurately, but a generic service copy action has no selected container. The diagnostic surface handles individual containers instead.

## Consequences

Firewall isolation, custom bridges and rootless Docker may make the candidate unreachable. The UI explains authentication and binding requirements. WS/TLS entries cannot be converted to plain host proxies by changing the hostname. IPv6-specific bindings are bracketed by the helper; discovery currently offers IPv4 only.

## Testing

internal/api/system_network_test.go and web/e2e/docker-endpoint.test.ts cover candidate filtering, protocol/binding rejection and no domain fallback.
