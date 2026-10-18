# Agent Note: YAML 路由是意图层, 翻译进现有规则而不是第二套编译器

Status: implemented

## Problem

指纹浏览器不能在运行中换代理。一个环境要按目标分流 (GitHub 走一组、国内直连、广告拒绝), 就得在 hx-pxy 热更新规则, 而且调用方拿的是一份通用 YAML, 不是 Mihomo 规则文本, 也不是现在这份 JSON 规则文档。

直接把 YAML 交给 Mihomo, 或者在 `internal/compiler` 再写一个编译器, 会绕开现有的校验、保存和失败回滚。`Service.Update` 已经做完这三件事。

## Decision

`POST /api/v1/routing-rules/apply` 的正文就是 YAML 文档本身 (上限 64KB)。`routingrules.TranslateYAML` 把它翻成一份完整的 `Config`, 然后走 `Service.Update`, 所以应用失败仍回滚到上一份。翻译是整份替换, 不和已存规则合并。

一条 YAML 规则变成一个规则集, 按书写顺序给 `yaml-01` 起的 id 和 10、20、30 的优先级。`match` 恰好一个键, 值是字符串或列表; 列表是同一个规则集里的多条规则, 同一动作。支持的键就是现有规则类型去掉 `process_name` (浏览器意图用不上进程名)。`domain_suffix` 去掉开头的点, `geoip` 大写, `network` 小写。`action: proxy` 的 `group` 先按 id 再按唯一名称解析, 禁用或重名都拒绝, 因为编译器会把禁用的 `proxy_group` 收成 REJECT, 重名启用组则让整份编译失败。

`default: proxy` 不产生规则。未命中的流量留在入站自己的代理组上: 编译器末尾那条写死的 `MATCH,DIRECT` 就是把流量送回这个组的那一行, `default: direct` 也是这一行, 所以同样不产生规则。`default: reject` 加一个优先级 10000 的规则集, 用 `network: tcp` 加 `network: udp` 两条规则, 排在 `MATCH,DIRECT` 前面生效。不把 `default` 设成一个代理组: 入站已经是一个组, 文档级的组覆盖得改掉那条写死的 MATCH。

## Alternatives considered

### 继续使用现有 PUT JSON 接口

保留现有接口最简单，也避免增加一种文档格式；已有管理端仍然可以用它维护规则。否决: HX-Jungle 的浏览器调用方拿到的是通用 YAML 意图文档，并需要在运行中一次性替换规则，要求它们改写为内部 JSON 结构会增加耦合，不能满足这些调用方的输入约束。

### 另写一个 Mihomo YAML 编译器

issue 初稿把翻译放在 `internal/compiler`。否决: 规则文本、AND/IN-NAME 作用域、组名解析和回滚都已经在 `routingrules.Compile` 和 `Service.Update` 里。第二套编译器会在两者不一致时静默分流。

### 把 `MATCH,DIRECT` 改成可配置

`default: reject` 看起来该替换最后那条 MATCH。否决这次改: 住宅代理兜底和 TUN 规则都排在路由规则之后、MATCH 之前, 改最后一条会连带它们。用 tcp/udp 两条规则插在路由规则自己的位置上, 只覆盖这份 YAML 的拒绝兜底。`default: direct` 不加规则, 因为那条 MATCH,DIRECT 已经是直连。

### 只接受代理组 id

调用方 (浏览器环境) 写的是组名。只认 id 会强迫它先查一遍组。名称必须唯一且启用, 因为编译器对重名启用组是整份失败, 对禁用组是把动作收成 REJECT。

## Consequences

`process_name` 不能从这份 YAML 表达, 仍可用 PUT JSON 写。`default` 不能指向一个代理组。空规则加 `default: proxy` 会清空已存规则。`GET /api/v1/proxy-groups` 已经能列出组, 这里不加第二个列表接口, 也没有 MCP。

## Testing

`internal/routingrules/yaml_test.go` 用 issue 里的文档断言编译顺序、前导点、组名/id、歧义、禁用和非法形状。`internal/api/routing_rules_test.go` 断言 POST 原样把正文交给 `ApplyYAML`。
