package mihomo

import (
	"context"
	"fmt"
	"time"

	"github.com/HengXin666/hx-pxy/internal/pipeline"
	"github.com/HengXin666/hx-pxy/internal/proxygroup"
	"github.com/HengXin666/hx-pxy/internal/store"
)

// GroupMemberRepository persists the membership each group was last applied
// with, so the Retain pipeline stage can keep members across applies. It is
// optional: a repository without it compiles exactly as before.
// See .agents/notes/implemented/feature/2026-10-16-group-member-retain.md.
type GroupMemberRepository interface {
	ListGroupMembers(context.Context) (map[string]map[string]time.Time, error)
	ReplaceGroupMembers(context.Context, map[string][]string, time.Time) error
}

// memberResolver is the one resolution of "which nodes does this group
// carry" for a single compile. The emitted member lists and the dialer-chain
// validators both read it, so they can never disagree, and each group's
// pipeline runs once per compile instead of once per caller.
type memberResolver struct {
	candidates    []store.GroupNodeCandidate
	incumbents    map[string]map[string]time.Time
	now           time.Time
	cache         map[string][]string
	fingerprintOf map[string]string
}

func newMemberResolver(candidates []store.GroupNodeCandidate, incumbents map[string]map[string]time.Time, now time.Time) *memberResolver {
	fingerprints := make(map[string]string, len(candidates))
	for _, candidate := range candidates {
		fingerprints[candidate.ID] = candidate.Fingerprint
	}
	return &memberResolver{candidates: candidates, incumbents: incumbents, now: now, cache: map[string][]string{}, fingerprintOf: fingerprints}
}

// addFingerprints covers nodes a group carries through explicit node_ids that
// are not in the subscription candidate set, so their membership is recorded.
func (r *memberResolver) addFingerprints(records []store.NodeConfigRecord) {
	for _, record := range records {
		if _, known := r.fingerprintOf[record.ID]; !known && record.Fingerprint != "" {
			r.fingerprintOf[record.ID] = record.Fingerprint
		}
	}
}

func (r *memberResolver) nodeIDs(record store.ProxyGroupRecord) ([]string, error) {
	if cached, ok := r.cache[record.ID]; ok {
		return cached, nil
	}
	spec, err := decodeSourceSpec(record.SourceSpecJSON)
	if err != nil {
		return nil, fmt.Errorf("decode group %q source spec: %w", record.Name, err)
	}
	resolved := proxygroup.ResolveNodeIDsRetaining(spec, r.candidates, pipeline.Incumbents{JoinedAt: r.incumbents[record.ID], Now: r.now})
	r.cache[record.ID] = resolved
	return resolved, nil
}

// memberships reports, for every group resolved in this compile, the
// fingerprints of the nodes it carries.
func (r *memberResolver) memberships(enabled map[string]string) map[string][]string {
	result := make(map[string][]string, len(enabled))
	for groupID := range enabled {
		ids := r.cache[groupID]
		fingerprints := make([]string, 0, len(ids))
		for _, id := range ids {
			if fingerprint := r.fingerprintOf[id]; fingerprint != "" {
				fingerprints = append(fingerprints, fingerprint)
			}
		}
		result[groupID] = fingerprints
	}
	return result
}

type pendingMembership struct {
	members map[string][]string
	at      time.Time
}

func (c *Compiler) loadIncumbents(ctx context.Context) (map[string]map[string]time.Time, error) {
	repository, ok := c.repository.(GroupMemberRepository)
	if !ok {
		return nil, nil
	}
	incumbents, err := repository.ListGroupMembers(ctx)
	if err != nil {
		return nil, fmt.Errorf("load previous group members: %w", err)
	}
	return overlayPending(incumbents, c.pendingMembers), nil
}

// overlayPending makes the last applied membership win over stored history
// when it could not be written: Retain must start from what Mihomo serves.
func overlayPending(stored map[string]map[string]time.Time, pending *pendingMembership) map[string]map[string]time.Time {
	if pending == nil {
		return stored
	}
	result := make(map[string]map[string]time.Time, len(pending.members))
	for groupID, fingerprints := range pending.members {
		result[groupID] = make(map[string]time.Time, len(fingerprints))
		for _, fingerprint := range fingerprints {
			if joined, ok := stored[groupID][fingerprint]; ok {
				result[groupID][fingerprint] = joined
			} else {
				result[groupID][fingerprint] = pending.at
			}
		}
	}
	return result
}

// recordMembers stores what an applied configuration actually serves. It runs
// only after a successful apply; a failure never undoes the apply. The
// membership is kept as pending so the next compile retains from it and the
// next successful write replaces it.
func (c *Compiler) recordMembers(ctx context.Context, compiled Compiled, now time.Time) error {
	repository, ok := c.repository.(GroupMemberRepository)
	if !ok || compiled.GroupMembers == nil {
		return nil
	}
	if err := repository.ReplaceGroupMembers(ctx, compiled.GroupMembers, now); err != nil {
		c.pendingMembers = &pendingMembership{members: compiled.GroupMembers, at: now}
		return err
	}
	c.pendingMembers = nil
	return nil
}

func (c *Compiler) clock() time.Time {
	if c.now != nil {
		return c.now()
	}
	return time.Now()
}
