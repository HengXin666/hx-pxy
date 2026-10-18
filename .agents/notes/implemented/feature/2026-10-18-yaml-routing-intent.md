# Agent Note: YAML 路由是意图层, 翻译进现有规则而不是第二套编译器

Status: implemented

## Problem

指纹浏览器不能在运行中换代理。一个环境要按目标分流 (GitHub 走一组、国内直连、广告拒绝), 就得在 hx-pxy 热更新规则, 而且调用方拿的是一份通用 YAML, 不是 Mihomo 规则文本, 也不是现在这份 JSON 规则文档。

直接把 YAML 交给 Mihomo, 或者在 `internal/compiler` 再写一个编译器, 会绕开现有的校验、保存和失败回滚。`Service.Update` 已经做完这三件事。

浏览器实际走的入站还有一层障碍: 普通监听器写了 `proxy: <组名>`, Mihomo 就不再看全局 `rules`; 共享入口的 `IN-USER` 规则又排在站点规则前面, 用户名一命中就结束。不改这两处, 翻译出来的规则对浏览器是空操作。

## Decision

`POST /api/v1/routing-rules/apply` 的正文就是 YAML 文档本身 (上限 64KB, 超出是 413)。正文必须是一份文档, 第二份或尾随语法直接 422。`routingrules.TranslateYAML` 把它翻成一份完整的 `Config` (含 `default`), 然后走 `Service.Update`。`Update` 持有锁盖住保存、热更新和失败回滚, 所以并发 POST 不会让较慢的回滚盖掉较新的文档。翻译是整份替换, 不和已存规则合并。

一条 YAML 规则变成一个规则集, 按书写顺序给 `yaml-01` 起的 id 和 10、20、30 的优先级。`match` 恰好一个键, 值是字符串或列表; 列表是同一个规则集里的多条规则, 同一动作。支持的键就是现有规则类型去掉 `process_name`。`domain_suffix` 去掉开头的点, `geoip` 大写, `network` 小写。`action: proxy` 的 `group` 先按 id 再按唯一名称解析, 禁用或重名都拒绝。

`default` 只接受 `proxy`、`direct`、`reject`。它不产生站点规则, 编译器按它改入站和收尾的顺序:

- 三个值都会拿掉普通监听器上的 `proxy` 字段, 流量才进得了 `rules`。
- `proxy`: 站点规则在前, 然后才是共享入口的 `IN-USER` 和这条入站的 `IN-NAME,<监听器>,<原组>`。没命中的浏览器流量仍进原来的组。
- `direct`: 不加这些兜底。没命中的浏览器流量落到最后一条 `MATCH,DIRECT`。
- `reject`: 同样不加这些兜底。`NETWORK,tcp,REJECT` 和 `NETWORK,udp,REJECT` 插在住宅监听器兜底和 TUN 规则之后、`MATCH,DIRECT` 之前。

住宅会话自己的规则仍在站点规则之前。没有分配节点的会话继续靠后面的 `IN-NAME` 兜底, 不被 `default: reject` 抢走。TUN 的 `IN-TYPE,TUN,<组>` 也排在拒绝规则之前。`default` 为空的旧 JSON 文档保持原样: 监听器仍写 `proxy`, 共享入口的用户名仍先于站点规则。

## Alternatives considered

### 让调用方继续 PUT JSON

现有的 `PUT /api/v1/routing-rules` 已经能整份替换并回滚。否决把它当作这次的接口: 浏览器环境手里是一份通用 YAML, 不是这套 rule set JSON。逼它自己拼 JSON 会把组名、优先级和 `default` 的语义散到每个调用方。PUT 留着, 给已经在用 JSON 的客户端。

### 另写一个 Mihomo YAML 编译器

issue 初稿把翻译放在 `internal/compiler`。否决: 规则文本、AND/IN-NAME 作用域、组名解析和回滚都已经在 `routingrules.Compile` 和 `Service.Update` 里。第二套编译器会在两者不一致时静默分流。

### 把 `MATCH,DIRECT` 改成可配置

`default: reject` 看起来该替换最后那条 MATCH。否决: 那一行不是“把流量送回入站组”的开关。入站组来自监听器的 `proxy` 字段, 或显式的 `IN-NAME` / `IN-USER` 规则。改 MATCH 会让没有 YAML 的旧文档也变行为。拒绝规则只插在住宅兜底和 TUN 之后, 不替换 MATCH。

### 只接受代理组 id

调用方写的是组名。只认 id 会强迫它先查一遍组。名称必须唯一且启用, 因为编译器对重名启用组是整份失败, 对禁用组是把动作收成 REJECT。

## Consequences

`process_name` 不能从这份 YAML 表达, 仍可用 PUT JSON 写。`default` 不能指向一个代理组。空规则加 `default: proxy` 会清空已存规则, 并让此后的浏览器流量改走规则而不是监听器上的 `proxy`。`default: direct` 不会把 TUN 或已分配的住宅会话改成直连。`GET /api/v1/proxy-groups` 已经能列出组, 这里不加第二个列表接口, 也没有 MCP。

## Testing

`internal/routingrules/yaml_test.go` 覆盖 issue 文档、多文档、组名和非法形状。`internal/dataplane/mihomo/compiler_yaml_order_test.go` 断言三种 default 下浏览器入站、共享用户、住宅兜底、TUN 和 `MATCH,DIRECT` 的先后, 以及旧文档仍保留 `proxy`。`internal/routingrules/service_test.go` 断言两次 `Update` 的 apply 不会重叠。
