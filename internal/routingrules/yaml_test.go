package routingrules

import (
	"strings"
	"testing"

	"github.com/HengXin666/hx-pxy/internal/store"
)

const issueDocument = `
version: 1
name: env-xxx-proxy
default: proxy
rules:
  - match: { domain_suffix: [".github.com"] }
    action: proxy
    group: "github-group"
  - match: { geoip: "cn" }
    action: direct
  - match: { domain_keyword: ["ads"] }
    action: reject
`

func groups() []store.ProxyGroupRecord {
	return []store.ProxyGroupRecord{
		{ID: "group-github", Name: "github-group", Enabled: true},
		{ID: "group-other", Name: "other", Enabled: true},
	}
}

func TestTranslateYAMLIssueDocumentCompilesInOrder(t *testing.T) {
	config, err := TranslateYAML(issueDocument, groups())
	if err != nil {
		t.Fatal(err)
	}
	if len(config.RuleSets) != 3 {
		t.Fatalf("rule sets = %d, want 3 (default proxy adds none)", len(config.RuleSets))
	}
	first := config.RuleSets[0]
	if first.Rules[0].Type != "domain_suffix" || first.Rules[0].Value != "github.com" {
		t.Fatalf("leading dot was kept: %+v", first.Rules[0])
	}
	if first.Action.Type != "proxy_group" || first.Action.ProxyGroupID != "group-github" {
		t.Fatalf("group resolved by name = %+v", first.Action)
	}
	if config.RuleSets[1].Rules[0].Value != "CN" {
		t.Fatalf("geoip = %q, want CN", config.RuleSets[1].Rules[0].Value)
	}
	compiled := Compile(config, groups(), nil, func(id string) string { return id })
	want := []string{
		"DOMAIN-SUFFIX,github.com,github-group",
		"GEOIP,CN,DIRECT",
		"DOMAIN-KEYWORD,ads,REJECT",
	}
	if strings.Join(compiled, "\n") != strings.Join(want, "\n") {
		t.Fatalf("compiled = %v, want %v", compiled, want)
	}
}

func TestTranslateYAMLResolvesGroupIDAndRejectsAmbiguousOrDisabled(t *testing.T) {
	raw := "version: 1\nname: n\ndefault: proxy\nrules:\n  - match: { domain: example.com }\n    action: proxy\n    group: group-github\n"
	config, err := TranslateYAML(raw, groups())
	if err != nil || config.RuleSets[0].Action.ProxyGroupID != "group-github" {
		t.Fatalf("id lookup config = %+v, err = %v", config, err)
	}
	ambiguous := []store.ProxyGroupRecord{
		{ID: "a", Name: "same", Enabled: true},
		{ID: "b", Name: "same", Enabled: true},
	}
	if _, err := TranslateYAML(strings.Replace(raw, "group-github", "same", 1), ambiguous); err == nil || !strings.Contains(err.Error(), "ambiguous") {
		t.Fatalf("ambiguous = %v", err)
	}
	disabled := []store.ProxyGroupRecord{{ID: "group-github", Name: "github-group", Enabled: false}}
	if _, err := TranslateYAML(raw, disabled); err == nil || !strings.Contains(err.Error(), "disabled") {
		t.Fatalf("disabled = %v", err)
	}
}

func TestTranslateYAMLRejectsShapeErrors(t *testing.T) {
	tests := []string{
		"version: 2\nname: n\ndefault: proxy\nrules: []\n",
		"version: 1\nname: n\ndefault: proxy\nrules:\n  - match: { domain: a.com, geoip: CN }\n    action: direct\n",
		"version: 1\nname: n\ndefault: proxy\nrules:\n  - match: { process_name: chrome }\n    action: direct\n",
		"version: 1\nname: n\ndefault: group-github\nrules: []\n",
		"version: 1\nname: n\ndefault: proxy\nrules:\n  - match: { domain: a.com }\n    action: direct\n    group: github-group\n",
		"version: 1\nname: n\ndefault: proxy\nextra: 1\nrules: []\n",
		"",
	}
	for index, raw := range tests {
		if _, err := TranslateYAML(raw, groups()); err == nil {
			t.Fatalf("case %d unexpectedly valid", index)
		}
	}
}

func TestTranslateYAMLDefaultDirectAddsNothingAndRejectPrecedesFallback(t *testing.T) {
	direct := "version: 1\nname: n\ndefault: direct\nrules:\n  - match: { domain: keep.example }\n    action: direct\n"
	config, err := TranslateYAML(direct, groups())
	if err != nil {
		t.Fatal(err)
	}
	if len(config.RuleSets) != 1 {
		t.Fatalf("default direct added a rule set: %+v", config.RuleSets)
	}
	reject := strings.Replace(direct, "default: direct", "default: reject", 1)
	config, err = TranslateYAML(reject, groups())
	if err != nil {
		t.Fatal(err)
	}
	compiled := Compile(config, groups(), nil, func(id string) string { return id })
	if len(compiled) != 3 || !strings.HasPrefix(compiled[len(compiled)-1], "NETWORK,udp,REJECT") {
		t.Fatalf("default reject compiled = %v", compiled)
	}
}

func TestTranslateYAMLEmptyRulesWithDefaultProxyClearsDocument(t *testing.T) {
	config, err := TranslateYAML("version: 1\nname: n\ndefault: proxy\nrules: []\n", groups())
	if err != nil {
		t.Fatal(err)
	}
	if len(config.RuleSets) != 0 || len(Compile(config, groups(), nil, func(string) string { return "" })) != 0 {
		t.Fatalf("config = %+v", config)
	}
}
