package mihomo

import (
	"context"
	"testing"
	"time"

	"github.com/HengXin666/hx-pxy/internal/store"
)

// retainRepository is a chainRepository that also stores group membership,
// the way the SQLite store does.
type retainRepository struct {
	chainRepository
	members map[string]map[string]time.Time
}

func (r *retainRepository) ListGroupMembers(context.Context) (map[string]map[string]time.Time, error) {
	return r.members, nil
}

func (r *retainRepository) ReplaceGroupMembers(_ context.Context, members map[string][]string, now time.Time) error {
	next := make(map[string]map[string]time.Time, len(members))
	for groupID, fingerprints := range members {
		next[groupID] = map[string]time.Time{}
		for _, fingerprint := range fingerprints {
			if joined, ok := r.members[groupID][fingerprint]; ok {
				next[groupID][fingerprint] = joined
			} else {
				next[groupID][fingerprint] = now
			}
		}
	}
	r.members = next
	return nil
}

func latencyCandidate(id, fingerprint string, latency int) store.GroupNodeCandidate {
	value := latency
	return store.GroupNodeCandidate{
		NodeConfigRecord: store.NodeConfigRecord{ID: id, Fingerprint: fingerprint, DisplayName: id, Protocol: "http", LifecycleState: "healthy"},
		SubscriptionIDs:  []string{"sub"}, LastLatencyMS: &value,
	}
}

func TestCompileRetainsPreviousMembersUntilANewcomerIsClearlyBetter(t *testing.T) {
	nodeA := chainNodeRecord(t, "node-a", "aaaaaaaaaaaaaaaa0000")
	nodeB := chainNodeRecord(t, "node-b", "bbbbbbbbbbbbbbbb0000")
	repository := &retainRepository{chainRepository: chainRepository{
		groups: []store.ProxyGroupRecord{{
			ID: "pool", Name: "Pool", Strategy: "manual", Enabled: true, EmptyBehavior: "fail-closed",
			SourceSpecJSON: `{"node_ids":[],"subscription_ids":["sub"],"limit":1,"retain":{"margin":50}}`,
		}},
		nodes:      []store.NodeConfigRecord{nodeA, nodeB},
		candidates: []store.GroupNodeCandidate{latencyCandidate("node-a", nodeA.Fingerprint, 100), latencyCandidate("node-b", nodeB.Fingerprint, 200)},
	}}
	compiler, err := NewCompiler(repository, plaintextCipher{})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 10, 16, 0, 0, 0, 0, time.UTC)
	compiler.now = func() time.Time { return now }
	compile := func() []string {
		compiled, err := compiler.Compile(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		if err := compiler.recordMembers(context.Background(), compiled, now); err != nil {
			t.Fatal(err)
		}
		return chainMemberNames(t, decodeDocument(t, compiled.YAML), "Pool")
	}
	first := compile()
	if len(first) != 1 || first[0] != nodeProxyName(nodeA.Fingerprint) {
		t.Fatalf("first members = %v", first)
	}
	// B becomes 20 ms faster than A: inside the margin, A keeps its seat.
	repository.candidates = []store.GroupNodeCandidate{latencyCandidate("node-a", nodeA.Fingerprint, 100), latencyCandidate("node-b", nodeB.Fingerprint, 80)}
	if second := compile(); second[0] != nodeProxyName(nodeA.Fingerprint) {
		t.Fatalf("marginal newcomer replaced the incumbent: %v", second)
	}
	// B becomes 90 ms faster: beyond the margin, B takes over.
	repository.candidates = []store.GroupNodeCandidate{latencyCandidate("node-a", nodeA.Fingerprint, 100), latencyCandidate("node-b", nodeB.Fingerprint, 10)}
	if third := compile(); third[0] != nodeProxyName(nodeB.Fingerprint) {
		t.Fatalf("clearly better newcomer did not replace the incumbent: %v", third)
	}
}
