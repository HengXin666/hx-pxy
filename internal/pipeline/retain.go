package pipeline

import (
	"context"
	"fmt"
	"math"
	"sort"
	"time"
)

// StageRetain sits between Sort and Limit. It exists because re-ranking a
// large pool on every probe round reshuffles a limited group's members on
// every apply: a node 1 ms faster than an incumbent evicts it, consumers lose
// their sticky exit, and the data plane reloads for no real gain. Retain keeps
// the previous members that still pass every predicate and are not
// quarantined, and only lets a newcomer take a seat when it is better by more
// than Margin and the incumbent has held the seat for at least MinDwell.
//
// See .agents/notes/implemented/feature/2026-10-16-group-member-retain.md.
const StageRetain = "retain"

// RetainSpec configures the Retain stage. It only has an effect together with
// a total limit: without a limit every passing node is a member anyway.
type RetainSpec struct {
	// Margin is how much better a newcomer must be, in the unit of the first
	// sort key: score points for "score", milliseconds for "latency". "name"
	// ordering has no notion of better, so incumbents simply keep their seat.
	Margin float64 `json:"margin,omitempty"`
	// MinDwellSeconds protects a member from replacement until it has been a
	// member this long, however much better the newcomer is.
	MinDwellSeconds int `json:"min_dwell_seconds,omitempty"`
}

// MaxRetainDwell bounds MinDwellSeconds so a typo cannot freeze a group.
const MaxRetainDwell = 7 * 24 * time.Hour

// Incumbents describes the previous membership of a group: node fingerprint ->
// time it joined. Fingerprints, not node ids, are the identity because a
// subscription refresh may re-create the row of the same physical node.
type Incumbents struct {
	JoinedAt map[string]time.Time
	Now      time.Time
}

// Validate rejects values that cannot be meant.
func (r RetainSpec) Validate() error {
	if r.Margin < 0 || math.IsNaN(r.Margin) || math.IsInf(r.Margin, 0) {
		return fmt.Errorf("retain margin must be a finite number >= 0")
	}
	if r.MinDwellSeconds < 0 || time.Duration(r.MinDwellSeconds)*time.Second > MaxRetainDwell {
		return fmt.Errorf("retain min_dwell_seconds must be between 0 and %d", int(MaxRetainDwell/time.Second))
	}
	return nil
}

// RunRetaining is Run with the previous membership available to the Retain
// stage. A pipeline without a Retain spec, or with no total limit, behaves
// exactly like Run.
func (p *Pipeline) RunRetaining(ctx context.Context, nodes []*Node, incumbents Incumbents) (Result, error) {
	seats := p.limit.Total
	if p.retain == nil || seats <= 0 || len(incumbents.JoinedAt) == 0 {
		return p.Run(ctx, nodes)
	}
	// Run every stage except the total limit, then let Retain choose the
	// seats and record why. The pipeline itself is not mutated.
	result, err := p.run(ctx, nodes, 0)
	if err != nil {
		return result, err
	}
	p.applyRetain(&result, seats, incumbents)
	return result, nil
}

func (p *Pipeline) applyRetain(result *Result, seats int, incumbents Incumbents) {
	metric := retainMetric(p.sortKeys)
	dwell := time.Duration(p.retain.MinDwellSeconds) * time.Second
	type seat struct {
		ctx       *NodeContext
		incumbent bool
		protected bool
		rank      int
	}
	all := make([]seat, 0, len(result.Nodes))
	for rank, nodeCtx := range result.Nodes {
		joined, was := incumbents.JoinedAt[nodeCtx.Node.Fingerprint]
		incumbent := was && nodeCtx.Node.Fingerprint != "" && retainable(nodeCtx.Node.LifecycleState)
		protected := incumbent && dwell > 0 && incumbents.Now.Sub(joined) < dwell
		all = append(all, seat{ctx: nodeCtx, incumbent: incumbent, protected: protected, rank: rank})
	}
	chosen := make(map[int]bool, seats)
	// Incumbents first, best-ranked first, up to the seat count.
	for index := range all {
		if len(chosen) >= seats {
			break
		}
		if all[index].incumbent {
			chosen[index] = true
		}
	}
	// Remaining seats go to the best newcomers.
	for index := range all {
		if len(chosen) >= seats {
			break
		}
		if !chosen[index] {
			chosen[index] = true
		}
	}
	// A newcomer replaces the weakest unprotected incumbent only when it is
	// better by more than the margin. Each newcomer is considered once, best
	// first, so the loop is O(n * seats) and terminates.
	for challenger := range all {
		if chosen[challenger] || all[challenger].incumbent {
			continue
		}
		weakest := -1
		for index := range all {
			if !chosen[index] || !all[index].incumbent || all[index].protected {
				continue
			}
			if weakest < 0 || all[index].rank > all[weakest].rank {
				weakest = index
			}
		}
		if weakest < 0 || metric == nil {
			break
		}
		if metric(all[challenger].ctx)-metric(all[weakest].ctx) > p.retain.Margin {
			delete(chosen, weakest)
			chosen[challenger] = true
			result.Traces = append(result.Traces, Trace{
				Stage: StageRetain, Rule: "retain", NodeID: all[challenger].ctx.Node.ID, Outcome: OutcomeHit,
				Detail: fmt.Sprintf("replaced %s: better by more than %.3f", all[weakest].ctx.Node.ID, p.retain.Margin),
			})
		}
	}
	kept := make([]*NodeContext, 0, seats)
	order := make([]int, 0, len(chosen))
	for index := range chosen {
		order = append(order, index)
	}
	sort.Ints(order)
	for _, index := range order {
		item := all[index]
		kept = append(kept, item.ctx)
		if item.incumbent {
			detail := "kept: previous member still passes every predicate"
			if item.protected {
				detail = "kept: within min dwell"
			}
			result.Traces = append(result.Traces, Trace{Stage: StageRetain, Rule: "retain", NodeID: item.ctx.Node.ID, Outcome: OutcomeHit, Detail: detail})
		}
	}
	for index, item := range all {
		if chosen[index] {
			continue
		}
		reason := fmt.Sprintf("beyond the first %d nodes", seats)
		if item.incumbent {
			reason = fmt.Sprintf("replaced by a node better by more than %.3f", p.retain.Margin)
		} else if metric != nil {
			reason = fmt.Sprintf("seats held by previous members (margin %.3f)", p.retain.Margin)
		}
		result.Excluded = append(result.Excluded, Exclusion{NodeID: item.ctx.Node.ID, Stage: StageRetain, Rule: "retain", Reason: reason})
	}
	result.Nodes = kept
}

// retainMetric returns "higher is better" for the first meaningful sort key,
// or nil when the order has no notion of better (name).
func retainMetric(keys []string) func(*NodeContext) float64 {
	for _, key := range keys {
		switch key {
		case "score":
			return func(item *NodeContext) float64 { return item.Score }
		case "latency":
			return func(item *NodeContext) float64 {
				if item.Node.LatencyMS == nil {
					return math.Inf(-1)
				}
				return -float64(*item.Node.LatencyMS)
			}
		case "name":
			return nil
		}
	}
	return nil
}

// retainable reports whether a previous member may keep its seat. A
// quarantined, disabled or retired node never does, even if a custom predicate
// let it through: retention is a tie-breaker, not a health override.
func retainable(state string) bool {
	switch state {
	case "quarantined", "disabled", "retired":
		return false
	default:
		return true
	}
}
