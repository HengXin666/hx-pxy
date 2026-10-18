package proxygroup

import "fmt"

// A proxy group is a selection, not a handle for one node.
//
// The failure this rule prevents has been measured twice in this repository:
// 2026-09-26 found 61 groups, 57 of them `manual` groups holding exactly one
// node and covering only 28 distinct nodes (one node had been wrapped five
// times); 2026-10-01 found six more built over 12 days by a script that used a
// group as "point this service at that node". Both cleanups worked and the
// shape came back, because building the wrong shape was one field cheaper than
// building the right one.
//
// The right shape already exists: `listeners.node_id` pins a service to one node
// without a group (see
// .agents/notes/implemented/feature/2026-09-26-listener-pins-a-node.md). So the
// wrong shape is refused at the one choke point every caller passes through, and
// the refusal spells out what to do instead.
//
// What this rule deliberately does NOT count as "one node":
//
//   - a single `subscription_ids` entry. The group's size is then a property of
//     the source snapshot, not of the request: a pool holding 1305 nodes today
//     can hold one tomorrow without anyone writing anything. Rejecting the write
//     would fail an unrelated edit (a rename) for a fact the caller cannot fix
//     in that request, and it would reject the legitimate "one subscription, one
//     group" shape the operator asked for.
//   - a single `group_ids` entry. That is a composition (a fallback chain of one
//     group), not a wrapper around a node; its members belong to the referenced
//     group, which this request does not know.
//   - `include_direct` alone. DIRECT is the server's own egress and there is
//     exactly one of it; "server direct" is a real single-member policy, not a
//     node dressed up as a group.
//   - `allow_empty`. A dormant group is meant to start with nothing and fill in
//     later from its source.
//
// See .agents/notes/implemented/architecture/2026-10-18-a-group-is-not-a-node-handle.md.
func rejectSingleNodeGroup(spec SourceSpec, allowSingleNode bool) error {
	if allowSingleNode || !isSingleNodeGroup(spec) {
		return nil
	}
	return fmt.Errorf("%w: 代理组节点必须 > 1：只含 1 个节点的组只是那个节点的句柄，不允许建。正确用法是建一个大节点组（通常一个订阅一个组、尽量少建组），再用 listener.node_id 把某个服务钉到具体节点上——POST /api/v1/listeners 与 PUT /api/v1/proxy-services 的 listener.node_id 都直接指定节点，不需要建组。禁止为每个节点批量创建代理组。", ErrInvalid)
}

// isSingleNodeGroup reports whether the spec describes exactly one node and
// nothing else, i.e. the shape that should have been a listener pin.
func isSingleNodeGroup(spec SourceSpec) bool {
	if spec.AllowEmpty {
		return false
	}
	if len(spec.NodeIDs) != 1 {
		return false
	}
	return len(spec.SubscriptionIDs) == 0 && len(spec.GroupIDs) == 0 && !spec.IncludeDirect
}

// sameSingleNode reports whether candidate describes the same one-node group the
// stored spec already describes, ignoring every other field. It is what lets an
// unrelated edit of a legacy one-node group through without letting a caller
// reach that shape from a two-node one.
func sameSingleNode(candidate SourceSpec, storedJSON string) bool {
	stored, err := DecodeSourceSpec(storedJSON)
	if err != nil || !isSingleNodeGroup(stored) || !isSingleNodeGroup(candidate) {
		return false
	}
	return stored.NodeIDs[0] == candidate.NodeIDs[0]
}

// updateMayKeepSingleNode decides whether an update is exempt from the one-node
// rule.
//
// An edit of a group that is *already* a one-node group must stay possible:
// renaming it, disabling it, or changing its strategy is how an operator retires
// the shape, and refusing the write would freeze the row instead of converging.
// The exemption is deliberately narrow — the member set has to be identical to
// the stored one — so it cannot be used to reach that shape in two calls (create
// with two nodes, then edit down to one).
func updateMayKeepSingleNode(request UpdateRequest, storedJSON string) bool {
	return request.AllowSingleNode || sameSingleNode(request.SourceSpec, storedJSON)
}
