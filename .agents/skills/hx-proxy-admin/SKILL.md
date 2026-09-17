---
name: hx-proxy-admin
description: 通过控制面自己的能力目录（GET /api/v1/capabilities）驱动 HX-ProxyGroup 管理 API：不改代码、不读 Go 源码就能知道每个端点的字段名、封闭枚举与合法示例，并用一次 POST /api/v1/quickstart 从零跑到「可用代理」。Use when 需要「用程序或 AI 配置 HX-ProxyGroup」——自动化建订阅/建组/建 Listener、批量发号、把控制面接进 CI 或其他 Agent；或遇到 HX 管理 API 字段名记不准、枚举值被 422 拒绝、不确定某个能力到底支持不支持、要判断 quickstart 与逐步调用的取舍、AI 改配置总要先翻 Go 源码等问题时。
---

# 用能力目录驱动 HX-ProxyGroup 管理 API

控制面把自己的接口面**当作数据发布**在 `GET /api/v1/capabilities`：端点、
字段名、封闭枚举、默认值、合法示例、错误码、以及产品边界。
**先读它，再写请求** —— 这样你不需要读 Go 源码，也不会靠猜字段名和枚举值。

> 词元（端点、字段名、枚举值）以**能力目录本身**为准。目录里的枚举是从
> 服务端校验器直接读出来的，所以它和你正在跑的那个版本永远一致。
> 若你手上的副本与目录冲突，**以目录为准**。

## 1. 两个前提

| 项 | 说明 |
| --- | --- |
| 基址 | 控制面地址，例如 `https://proxy.example.com` |
| 凭证 | API Key，走 `Authorization: Bearer <key>` 或 `X-API-Key: <key>`；在设置页创建 |

管理 API 在 `/api/v1/` 下，**全部需要凭证**。API Key 不是 Cookie，
所以**不需要 CSRF token** —— 适合脚本和 Agent。

## 2. 一条命令拿到全部词汇表

`scripts/hx-catalog.py` 读目录后本地校验，**不发坏请求**：

```bash
export HX_BASE_URL=https://proxy.example.com
export HX_API_KEY=hxk_...

# 所有封闭枚举（字段能取哪些值）
python3 scripts/hx-catalog.py enums

# 所有管理端点
python3 scripts/hx-catalog.py endpoints

# 某个端点的完整字段表 + 示例
python3 scripts/hx-catalog.py show proxy_service.create

# 先本地校验，不发出去
python3 scripts/hx-catalog.py check quickstart.create \
  --body '{"name":"hk-pool","subscription_url":"https://example.com/sub"}'

# 校验通过再发
python3 scripts/hx-catalog.py call subscription.create --body '{...}'
```

`check` 会抓两类最常见的 422：**字段名拼错**（服务端拒绝未知字段，不忽略）
和**枚举值不在封闭集合内**。它抓不到语义错误（引用不存在的 id、范围越界），
那些仍然由服务端判定。

## 3. 一次调用跑到可用代理

`POST /api/v1/quickstart` 把「注册订阅 → 刷新 → 建组 → 建 Listener」合成一步：

```bash
python3 scripts/hx-catalog.py quickstart --body '{
  "name": "hk-pool",
  "subscription_url": "https://example.com/sub?token=x",
  "strategy": "url-test"
}'
```

输出里你会拿到下一步真正需要的东西：

```text
group:    group-...
listener: listener-...
share:    /sub/<share-token>      ← 交给消费者订阅
nodes:    /nodes/<share-token>    ← 交给程序内接入（见 hx-consumer-api）
auth:     svc-... / ...           ← 已生成的凭据
```

**刷新发生在建组之前**，这是刻意的：订阅没刷新时节点还不存在，此时建组会选中空集合，
发布出一个「能连上但什么都不转发」的服务。手动分步调用时，你必须自己保证这个顺序。

不传 `auth` 时代码会**生成**凭据。共享入口模式按用户名路由成员，
没有凭据的成员会被拒绝 —— 所以「一次调用」必须替你把凭据补上。

### 失败时不留半成品

任何一步失败，这次调用**自己创建的东西会被删掉**（订阅、组、Listener）。
所以报错后可以放心重试，不会积累重复的订阅或孤儿 Listener。
错误信息会指明失败的步骤。

## 4. 什么时候用 quickstart，什么时候分步

| 场景 | 用什么 |
| --- | --- |
| 从零到可用代理 | `quickstart` —— 一步到位 |
| 订阅已经存在且已刷新 | `POST /api/v1/proxy-services`（组 + Listener） |
| 要复用多个订阅 / 组合多个组 | 分步：`subscriptions` → `refresh` → `proxy-groups` → `listeners` |
| 链式（把上游组当出口），按组 | `proxy-groups` 的 `dialer_proxy_group_id` —— 任意组，任意深度 |
| 链式，按住宅渠道 | 住宅供应商端点的 `upstream_proxy_group_id` |

分步调用时的**顺序不能变**：先 `refresh`，确认有节点，再建组。
`GET /api/v1/nodes` 用来确认刷新真的产出了成员。

## 5. 控制面支持什么、不支持什么

目录的 `not_supported` 段落是**产品边界**，不是能力缺失。关键三条：

- 控制面**不承载流量**：它是控制面，数据面是 Mihomo 受管进程。
  它不会进入数据转发路径。
- 控制面**不替你轮询/选点/排名**：哪些节点可用、延迟多少，取决于你要访问的目标，
  所以由消费者自己决定。控制面只发布节点。
- **链式代理有两个层级，都能用**：
  - 组级 `dialer_proxy_group_id`（在 `POST/PUT /api/v1/proxy-groups` 上）：任意组都可以把出口
    经由另一个组，**深度不限**。目标组必须存在且已启用，不能形成环；同时设
    `source_spec.include_direct` 会被拒绝，因为 DIRECT 会绕过链路。
  - 节点级 `upstream_proxy_group_id`（只在住宅供应商上）：把该渠道**自动生成**的每个节点
    都经指定组出网。
  - 一个节点只能有一条出口路径。若某节点已由住宅渠道烧入上游，再把它所在的组配上组级链路
    会**报错**而不是静默覆盖。

用户问「支持不支持 X」时，**先查目录的 `not_supported`**，不要从别的端点推断。

## 6. 别做的事

| 别做 | 为什么 |
| --- | --- |
| 猜字段名或枚举值 | 服务端拒绝未知字段，且枚举是封闭的；先跑 `show`/`enums` |
| 假设「WebSocket path 是认证」 | path 不是认证机制，凭据才是 |
| 把控制面塞进流量转发路径 | 违反产品边界，也会让控制面变成瓶颈 |
| 让控制面替你轮询节点 | 那是消费者的职责 |
| 依赖错误**消息文本**做逻辑 | 状态码和 `error.code` 才有稳定语义 |

## 7. 目录的稳定性

- 目录**只增不改不删**字段名与枚举值。加端点、加字段不会破坏你。
- 改名、改类型、删枚举值 = 破坏性变更，控制面会开新版本路径而不是改这个。
- 因此遇到**未知枚举值要报错并上报**，那说明你的副本过期了，不是让你猜的余地。
- 完整能力目录就是运行时的事实来源：`GET /api/v1/capabilities`。
