package mihomo

import "strings"

// A shared-inbound rule is "AND,((IN-NAME,...),(IN-USER,...)),<action>".
// The action is a proxy group name, or a node proxy name when the listener
// is pinned to one node. Pinning is an identity, not a browser default, so
// those rules stay ahead of YAML site rules.
// See .agents/notes/implemented/feature/2026-10-18-yaml-routing-intent.md.

func scopeSet(ids []string) map[string]struct{} {
	set := make(map[string]struct{}, len(ids))
	for _, id := range ids {
		if id != "" {
			set[id] = struct{}{}
		}
	}
	return set
}

func sharedRuleAction(rule string) string {
	if index := strings.LastIndex(rule, "),"); index >= 0 {
		return rule[index+2:]
	}
	return rule
}

func partitionSharedRules(rules []string, groupNameToID map[string]string) (pinned, grouped []string) {
	for _, rule := range rules {
		if _, isGroup := groupNameToID[sharedRuleAction(rule)]; isGroup {
			grouped = append(grouped, rule)
			continue
		}
		pinned = append(pinned, rule)
	}
	return pinned, grouped
}

func withoutScopedGroups(rules []string, groupNameToID map[string]string, scope map[string]struct{}) []string {
	if len(scope) == 0 {
		return rules
	}
	kept := make([]string, 0, len(rules))
	for _, rule := range rules {
		if _, drop := scope[groupNameToID[sharedRuleAction(rule)]]; drop {
			continue
		}
		kept = append(kept, rule)
	}
	return kept
}
