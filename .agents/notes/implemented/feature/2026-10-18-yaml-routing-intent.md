# Agent Note: YAML 路由是意图层, 翻译进现有规则而不是第二套编译器

Status: implemented

## Problem

指纹浏览器不能在运行中换代理。一个环境要按目标分流, 就得在 hx-pxy 热更新规则, 而且调用方拿的是一份通用 YAML, 不是 Mihomo 规则文本, 也不是现在这份 JSON 规则文档。

直接把 YAML 交给 Mihomo, 或者再写一个编译器, 会绕开现有的校验、保存和失败回滚。浏览器走的是共享入口: 用户名决定出口。普通监听器上的 `proxy` 字段则让 Mihomo 根本不看全局规则。与此同时, 同一个共享入口上还有按用户名钉死到某个节点的身份 (gh-pool), 住宅监听器在没分到节点时必须进失败关闭组。一份给浏览器写的 YAML 不能把这三类流量一起改掉。

## Decision

`POST /api/v1/routing-rules/apply` 收 YAML 正文 (上限 64KB, 超出 413)。必须是一份文档。`TranslateYAML` 把它翻成完整的 `Config`, 再走 `Service.Update`。`Update` 的锁盖住保存、热更新和回滚。

`POST /api/v1/mcp` 是同一套操作的 MCP JSON-RPC: `apply_rules(yaml)`、`list_groups()`、`get_rules()`。工具调用进的是同一个 `ApplyYAML` / 组列表 / `Get`, 不另做校验。

一条 YAML 规则变成一个规则集, id 从 `yaml-01` 起, 优先级 10、20、30。`match` 恰好一个键。`domain_suffix` 去掉开头的点, `geoip` 大写, `network` 小写。`group` 先按 id 再按唯一的启用名称解析。

`applies_to` 是这张默认值管到的代理组。不写它, `default: direct` 和 `default: reject` 不会拆掉其他监听器的 `proxy`, 也不会丢掉共享入口的用户名规则。写了它, 只有这些组的普通监听器去掉 `proxy` 改走规则, 也只有这些组里未钉节点的用户名会在 direct/reject 时去掉兜底。钉死到节点的用户名始终排在站点规则前面。

有 YAML `default` 时的顺序是: 住宅会话规则, 住宅监听器的 `IN-NAME` 兜底, 钉节点的 `IN-USER`, 站点规则, 其余组用户的 `IN-USER`, `applies_to` 里 `default: proxy` 的监听器兜底, TUN, 然后才是 `applies_to` 非空时的 tcp/udp REJECT, 最后 `MATCH,DIRECT`。没分配节点的住宅会话因此进失败关闭组, 不会先吃到 YAML 的 direct。旧 JSON 文档 `default` 为空, 顺序和 `proxy` 字段都保持原样。

管理页 PUT 只提交 `rule_sets`。请求里没有 `default` 或 `applies_to` 键时, 沿用已存的值。显式带上才覆盖。前端保存时把这两个字段原样带回去。

## Alternatives considered

### 让调用方继续 PUT JSON

`PUT /api/v1/routing-rules` 已经能整份替换并回滚。否决把它当作这次的接口: 浏览器环境手里是 YAML。PUT 留着给管理页, 并且缺省字段不再把 YAML 的 default 清掉。

### 另写一个 Mihomo YAML 编译器

issue 初稿把翻译放在 `internal/compiler`。否决: 规则文本、作用域、组名和回滚已经在 `routingrules.Compile` 和 `Service.Update` 里。

### 把 `MATCH,DIRECT` 改成可配置

否决。那一行不是“送回入站组”。入站组来自监听器的 `proxy`, 或显式的 `IN-NAME` / `IN-USER`。拒绝规则只加在这些兜底和 TUN 之后, 而且只在 `applies_to` 非空时加。

### 不区分钉节点的身份和浏览器组

把所有 `IN-USER` 都放在站点规则前面, YAML 对浏览器不生效。都放在后面, gh-pool 的 GitHub 流量会被站点规则抢走。现在只把动作是节点名、不是组名的那些规则留在站点规则前面。

### 只接受代理组 id

调用方写的是组名。名称必须唯一且启用。

## Consequences

`process_name` 仍只能用 PUT JSON。`default` 不能写成一个组名。不写 `applies_to` 时, `default: direct` 不会把整个实例的未命中流量改成直连。空规则加 `default: proxy` 会清空已存规则。`GET /api/v1/proxy-groups` 仍然是组列表的 HTTP 形式, MCP 的 `list_groups` 读的是同一份。

## Testing

`yaml_test.go` 覆盖文档形状。`compiler_yaml_order_test.go` 覆盖未限定作用域时监听器仍带 `proxy`、`applies_to` 的兜底在站点规则之后、reject 只丢掉被点名的组、住宅兜底和 TUN 在拒绝规则之前、钉节点的身份在站点规则之前, 以及旧文档的原顺序。`routing_rules_test.go` 覆盖 PUT 省略 `default` 时保留原值, 以及 MCP 的 `apply_rules` 和 `tools/list`。
