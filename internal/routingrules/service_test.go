package routingrules

import (
	"testing"

	"github.com/HengXin666/hx-pxy/internal/store"
)

func TestCompileScopesRulesToAssignedGroupListeners(t *testing.T) {
	config := Config{RuleSets: []RuleSet{
		{ID: "ads", Name: "Ads", Enabled: true, Priority: 10, AppliedGroupIDs: []string{"group-a"}, Action: Action{Type: "reject"}, Rules: []Rule{{Type: "domain_suffix", Value: "ads.example"}}},
		{ID: "github", Name: "GitHub", Enabled: true, Priority: 20, Action: Action{Type: "proxy_group", ProxyGroupID: "group-b"}, Rules: []Rule{{Type: "domain", Value: "github.com"}}},
	}}
	groups := []store.ProxyGroupRecord{{ID: "group-a", Name: "A", Enabled: true}, {ID: "group-b", Name: "B", Enabled: true}}
	listeners := []store.ListenerRecord{{ID: "listener-a", ProxyGroupID: "group-a", Enabled: true}, {ID: "listener-b", ProxyGroupID: "group-b", Enabled: true}}
	rules := Compile(config, groups, listeners, func(id string) string { return "in-" + id })
	if len(rules) != 2 || rules[0] != "AND,((IN-NAME,in-listener-a),(DOMAIN-SUFFIX,ads.example)),REJECT" || rules[1] != "DOMAIN,github.com,B" {
		t.Fatalf("compiled rules = %v", rules)
	}
}

func TestCompileAllowsIndependentActionsPerProxyGroup(t *testing.T) {
	config := Config{RuleSets: []RuleSet{{
		ID: "ai", Name: "AI sites", Enabled: true, Priority: 10,
		Routes: []GroupRoute{
			{ProxyGroupID: "group-a", Action: Action{Type: "direct"}},
			{ProxyGroupID: "group-b", Action: Action{Type: "reject"}},
		},
		Rules: []Rule{{Type: "domain_suffix", Value: "example.ai"}},
	}}}
	groups := []store.ProxyGroupRecord{{ID: "group-a", Name: "A", Enabled: true}, {ID: "group-b", Name: "B", Enabled: true}}
	listeners := []store.ListenerRecord{{ID: "listener-a", ProxyGroupID: "group-a", Enabled: true}, {ID: "listener-b", ProxyGroupID: "group-b", Enabled: true}}

	if err := Validate(config, groups); err != nil {
		t.Fatal(err)
	}
	rules := Compile(config, groups, listeners, func(id string) string { return "in-" + id })
	want := []string{
		"AND,((IN-NAME,in-listener-a),(DOMAIN-SUFFIX,example.ai)),DIRECT",
		"AND,((IN-NAME,in-listener-b),(DOMAIN-SUFFIX,example.ai)),REJECT",
	}
	if len(rules) != len(want) || rules[0] != want[0] || rules[1] != want[1] {
		t.Fatalf("compiled rules = %v, want %v", rules, want)
	}
}

func TestValidateRejectsUnsafeAndMissingReferences(t *testing.T) {
	groups := []store.ProxyGroupRecord{{ID: "group-a"}}
	tests := []Config{
		{RuleSets: []RuleSet{{ID: "bad", Name: "Bad", Enabled: true, Action: Action{Type: "proxy_group", ProxyGroupID: "missing"}, Rules: []Rule{{Type: "domain", Value: "example.com"}}}}},
		{RuleSets: []RuleSet{{ID: "bad", Name: "Bad", Enabled: true, Action: Action{Type: "reject"}, Rules: []Rule{{Type: "domain", Value: "example.com,REJECT"}}}}},
		{RuleSets: []RuleSet{{ID: "bad", Name: "Bad", Enabled: true, AppliedGroupIDs: []string{"missing"}, Action: Action{Type: "direct"}, Rules: []Rule{{Type: "domain", Value: "example.com"}}}}},
	}
	for index, config := range tests {
		if err := Validate(config, groups); err == nil {
			t.Fatalf("case %d unexpectedly valid", index)
		}
	}
}
