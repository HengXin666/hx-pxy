package mihomo

import "testing"

func TestDockerEntryStateTracksWithheldEntries(t *testing.T) {
	var state dockerEntryState
	state.set([]WithheldEntry{
		{ListenerID: "a", Reason: WithheldSourceDisabled},
		{ListenerID: "b", BindAddress: "172.30.0.1", Reason: WithheldBridgeAbsent},
	})
	if entry, ok := state.get("b"); !ok || entry.Reason != WithheldBridgeAbsent {
		t.Fatalf("b = %+v %v", entry, ok)
	}
	if waiting := state.waitingAddresses(); len(waiting) != 1 || waiting[0] != "172.30.0.1" {
		t.Fatalf("waiting = %v (only bridge-absent entries wait for an address)", waiting)
	}
	state.set(nil)
	if _, ok := state.get("b"); ok {
		t.Fatal("a later apply that serves the entry must clear it")
	}
	if waiting := state.waitingAddresses(); len(waiting) != 0 {
		t.Fatalf("waiting = %v", waiting)
	}
}
