# Agent Note: Capped groups retain their members between applies

Status: implemented

## Problem

A group with `limit` re-ranked its whole pool on every compile. With thousands of
pool nodes and noisy latency samples, a node a few milliseconds faster than an
incumbent evicted it on every probe round: consumers lost a sticky exit, the
compiled YAML changed, and Mihomo hot-reloaded for no real gain.

## Decision

The pipeline gains an optional Retain stage between Sort and Limit
(`internal/pipeline/retain.go`), configured per group as
`source_spec.retain = {margin, min_dwell_seconds}` and only accepted with `limit > 0`
on subscription-sourced groups. Residential channel groups are refused: their exits are
owned by sessions and leases and must stay a separate resource from subscription pools.
Previous members that still pass every predicate and are not quarantined /
disabled / retired keep their seats; a newcomer replaces the weakest unprotected
incumbent only when it is better by more than `margin` in the unit of the first sort
key (ms for latency, points for score; name order never replaces). An incumbent
younger than `min_dwell_seconds` is never replaced.

The previous membership is the table `group_members(group_id, node_fp, joined_at,
last_kept_at, reason)` (migration 41), keyed by node fingerprint and written by the
data plane manager only after Mihomo accepted the configuration, so it always
describes what is actually served. The compiler resolves each group once per
compile (`memberResolver`) so the emitted members, the residential dialer-chain
validator and the recorded membership cannot disagree; the members API runs the
same Retain decision.

## Alternatives considered

- **Hysteresis on the latency samples** (EWMA): smooths noise but still swaps
  members whenever the smoothed order flips, and does nothing for score order.
- **Writing membership during compile**: compile must stay a read of desired state;
  a compile that is then rejected by Mihomo would poison the next retention.
- **Keying by node id**: a subscription refresh can re-create the row of the same
  physical node, which would reset `joined_at` and defeat min dwell.

## Consequences

Retention is opt-in, so existing groups compile exactly as before. A Retain group's
output depends on stored history as well as desired state; the same history still
yields the same document. A failed membership write is logged and only makes the
next compile retain from older state. fill / best modes, L2 tag probes and per-group
snapshot ETags are not part of this change.

## Testing

internal/pipeline/retain_test.go (margin, min dwell, quarantine, parity with Run,
validation), internal/store/group_members_test.go (join time kept, leavers removed,
cascade), internal/proxygroup/retain_test.go, and
internal/dataplane/mihomo/compiler_members_test.go (compile -> record -> compile keeps
the incumbent inside the margin and swaps beyond it).
