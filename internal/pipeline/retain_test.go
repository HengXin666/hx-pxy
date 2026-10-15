package pipeline

import (
	"context"
	"strings"
	"testing"
	"time"
)

func latencyNode(id string, latency int) *Node {
	value := latency
	return &Node{ID: id, Fingerprint: "fp-" + id, DisplayName: id, LifecycleState: "healthy", LatencyMS: &value}
}

func buildRetaining(t *testing.T, total int, retain RetainSpec) *Pipeline {
	t.Helper()
	built, err := DefaultRegistry().Build(Spec{Sort: []string{"latency"}, Limit: LimitSpec{Total: total}, Retain: &retain})
	if err != nil {
		t.Fatal(err)
	}
	return built
}

func ids(result Result) string {
	out := make([]string, 0, len(result.Nodes))
	for _, item := range result.Nodes {
		out = append(out, item.Node.ID)
	}
	return strings.Join(out, ",")
}

func TestRetainKeepsIncumbentsAgainstMarginalNewcomers(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	built := buildRetaining(t, 2, RetainSpec{Margin: 50})
	nodes := []*Node{latencyNode("a", 100), latencyNode("b", 120), latencyNode("new", 90)}
	incumbents := Incumbents{JoinedAt: map[string]time.Time{"fp-a": now.Add(-time.Hour), "fp-b": now.Add(-time.Hour)}, Now: now}
	result, err := built.RunRetaining(context.Background(), nodes, incumbents)
	if err != nil {
		t.Fatal(err)
	}
	if got := ids(result); got != "a,b" {
		t.Fatalf("members = %s, want a,b (newcomer only 30ms better than b)", got)
	}
	if len(result.Excluded) != 1 || result.Excluded[0].NodeID != "new" || result.Excluded[0].Stage != StageRetain {
		t.Fatalf("excluded = %+v", result.Excluded)
	}
}

func TestRetainLetsClearlyBetterNewcomerReplaceWeakestIncumbent(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	built := buildRetaining(t, 2, RetainSpec{Margin: 50})
	nodes := []*Node{latencyNode("a", 100), latencyNode("b", 300), latencyNode("new", 90)}
	incumbents := Incumbents{JoinedAt: map[string]time.Time{"fp-a": now.Add(-time.Hour), "fp-b": now.Add(-time.Hour)}, Now: now}
	result, _ := built.RunRetaining(context.Background(), nodes, incumbents)
	if got := ids(result); got != "new,a" {
		t.Fatalf("members = %s, want new,a", got)
	}
}

func TestRetainMinDwellProtectsRecentMembers(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	built := buildRetaining(t, 1, RetainSpec{Margin: 0, MinDwellSeconds: 600})
	nodes := []*Node{latencyNode("old", 500), latencyNode("fast", 10)}
	incumbents := Incumbents{JoinedAt: map[string]time.Time{"fp-old": now.Add(-time.Minute)}, Now: now}
	result, _ := built.RunRetaining(context.Background(), nodes, incumbents)
	if got := ids(result); got != "old" {
		t.Fatalf("members = %s, want old (within min dwell)", got)
	}
	incumbents.Now = now.Add(time.Hour)
	result, _ = built.RunRetaining(context.Background(), nodes, incumbents)
	if got := ids(result); got != "fast" {
		t.Fatalf("members = %s, want fast after dwell", got)
	}
}

func TestRetainNeverKeepsQuarantinedOrFilteredIncumbents(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	built := buildRetaining(t, 1, RetainSpec{Margin: 1000})
	sick := latencyNode("sick", 50)
	sick.LifecycleState = "quarantined"
	nodes := []*Node{sick, latencyNode("ok", 80)}
	incumbents := Incumbents{JoinedAt: map[string]time.Time{"fp-sick": now.Add(-time.Hour), "fp-gone": now.Add(-time.Hour)}, Now: now}
	result, _ := built.RunRetaining(context.Background(), nodes, incumbents)
	// sick is not an incumbent (quarantined) and ranks first; ok has no claim.
	if got := ids(result); got != "sick" {
		t.Fatalf("members = %s", got)
	}
	nodes = []*Node{latencyNode("ok", 80), latencyNode("other", 70)}
	incumbents.JoinedAt = map[string]time.Time{"fp-ok": now.Add(-time.Hour)}
	result, _ = built.RunRetaining(context.Background(), nodes, incumbents)
	if got := ids(result); got != "ok" {
		t.Fatalf("members = %s, want incumbent ok", got)
	}
}

func TestRetainWithoutIncumbentsMatchesRun(t *testing.T) {
	built := buildRetaining(t, 2, RetainSpec{Margin: 50})
	nodes := []*Node{latencyNode("a", 100), latencyNode("b", 120), latencyNode("c", 90)}
	plain, _ := built.Run(context.Background(), nodes)
	retained, _ := built.RunRetaining(context.Background(), nodes, Incumbents{})
	if ids(plain) != ids(retained) || ids(plain) != "c,a" {
		t.Fatalf("plain=%s retained=%s", ids(plain), ids(retained))
	}
}

func TestRetainSpecValidation(t *testing.T) {
	if _, err := DefaultRegistry().Build(Spec{Retain: &RetainSpec{Margin: -1}}); err == nil {
		t.Fatal("negative margin accepted")
	}
	if _, err := DefaultRegistry().Build(Spec{Retain: &RetainSpec{MinDwellSeconds: 8 * 24 * 3600}}); err == nil {
		t.Fatal("dwell beyond a week accepted")
	}
}
