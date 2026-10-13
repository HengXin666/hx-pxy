# Agent Note: 升级接管改名前的部署, 发布链路随改名一起改完

Status: implemented

## Problem

2026-10-03 的改名把仓库内的标识符统一成 `hx-pxy`, 但范围停在源码与仓库内文档上, 两条**只在发布或升级时才执行**的链路被漏掉, 而它们的失败都是静默的:

1. `.github/workflows/release.yml` 仍然编译 `./cmd/hx-proxygroupd` —— 该目录在改名后已不存在 —— 并且上传、校验、发布的是 `hx-proxygroup_<tag>_linux_<arch>.tar.gz`。而 `scripts/package-release.sh` 产出的包名是 `hx-pxy_<tag>_linux_<arch>.tar.gz`。两者对不上, 所以下一个 tag 会在 `go build` 一步直接失败; 即便编译通过, `upload-artifact` 与 `gh release create` 也会因为匹配不到文件而失败。v0.12.0 是旧配置下最后一次成功发布, 改名之后还没有 tag 进来过, 因此这条链路从未被触发。
2. `install.sh` 的升级路径假定新布局已经就位: 数据在 `/var/lib/hx-pxy`, 服务账号 `hx-pxy`, 单元 `hx-pxy.service`。由 v0.12.0 装出来的机器上这些都不存在 —— 数据在 `/var/lib/hx-proxygroup`, 单元叫 `hx-proxygroup.service`, 且**旧控制面正占着 `127.0.0.1:19090`**。直接跑新版 `upgrade` 会新建一个空数据目录, 新控制面绑不上端口, readiness 失败, 安装器回滚到旧版本; 管理员看到的是"升级失败", 而他的订阅、节点与 Listener 从头到尾没有被读过。这是改名那篇 note 已经点名的"空库"风险的第二个实例, 只是这次连接管都还没写。

两条链路的共同点是都不会在 `go build ./...` 或 `go test ./...` 里响: 前者是 YAML 里的一个字符串, 后者只在真实机器上执行。

## Decision

把改名补齐到这两条链路。

**发布**: `release.yml` 编译 `./cmd/hx-pxyd`, 并把产物前缀、artifact 名、`SHA256SUMS` 通配与 `gh release create` 的标题统一为 `hx-pxy` / `HX-Pxy`, 与 `package-release.sh` 的包名契约一致。

**升级**: `install.sh` 新增 `adopt_legacy_installation`, 并且在 `install_or_upgrade` 里排在 `ensure_account_and_directories` **之前** —— 顺序是硬要求, 否则新的空数据目录会先被建出来, 接管条件永远不成立。它只在「当前数据目录不存在」且「旧数据目录存在」时动作, 做四件事:

1. 停掉并 disable 三个旧单元。两代控制面都绑 `19090`, 不停旧的, 新的必然 readiness 失败;
2. `mv` 数据、配置、日志与安装根到新路径, 并把 `hx-proxygroup.db`(连同 `-wal` / `-shm`) 改名为 `hx-pxy.db`;
3. 把服务账号与组 `hx-proxygroup` 改名为 `hx-pxy`(单元按名字引用账号, 重建会换 uid, 数据就没人认领了), 再 `chown -R` 兜底; 改名失败时退回"保持原名 + 按现存名字 chown";
4. 删除旧单元与旧安装器 `/usr/local/sbin/hx-proxygroup-install`。

`mv` 失败时重启旧单元并终止, 不留在半接管状态。

## Alternatives considered

- **什么都不做, 让管理员手工搬目录或先 `uninstall` 再 `install`。** 最强理由: 改名是一次性事件, 受影响的部署很少, 而一段只在旧布局存在时才运行的迁移代码会永久留在安装器里, 成为没人敢删的死代码; 手工 `mv` 加 `systemctl disable` 只要几分钟, 且管理员最清楚自己的机器。否决: `sudo hx-pxy-install upgrade` 的契约就是"一条命令升到最新", README 与关于页的一键更新都按这个契约调用它; 在这条路径上留下一个会**看起来成功**的分叉, 正是改名那篇 note 判定不可接受的失败形态。而且 `uninstall` 只保留数据、不搬目录, 手工步骤的每一步都有静默搞错的余地。
- **复用控制面里已有的 `migrateLegacyDatabasePath`, 不写 bash。** 最强理由: 那段接管逻辑已经存在且有单测覆盖, 再写一遍是重复实现, 两处迟早漂移。否决: 它只处理**同一个目录内**的文件改名, 而升级要跨目录、跨服务账号、跨 systemd 单元; 更关键的是它运行的前提是新实例已经能启动并读到 `/var/lib/hx-pxy`, 而那个目录此刻还不存在 —— 顺序上它到不了。
- **两代并存: 保留旧单元与旧路径, 让新旧都能跑。** 最强理由: 兼容期最平滑, 出问题时旧单元还能手动启回来。否决: 两代控制面绑同一个端口, 物理上无法共存; 保留旧单元只会把"到底哪个在跑"变成新的排障项。接管是一次性动作, 就做成一次性的。

## Consequences

- 安装器多了一段只在旧布局存在时运行的代码; 触发条件是「新目录不存在 + 旧目录存在」, 因此全新机器与已升级过的机器上都是 no-op。
- 接管依赖 `mv` 的原子性 —— 同文件系统内成立, 而两代目录都在 `/var/lib` 下, 天然同盘。
- 账号与组改名走 `groupmod` / `usermod --login`(不 `--move-home`: 数据已经搬到新路径, 让 `usermod` 再搬一次只会互相打架), 失败时保留原名并按现存名字 `chown`。未做旧名 -> 新名的别名, 因此改名失败会留下一个叫 `hx-proxygroup` 的账号 —— 服务仍能跑, 但账号名与文档不一致。
- 接管只覆盖数据、配置、日志、安装根、数据库文件名与账号, 不覆盖 `/etc/systemd/system` 里用户自行加的 drop-in 或环境文件(`EnvironmentFile` 里若写着旧路径, 升级后需要人工改)。
- 旧安装根被整体搬走; 其中的 `current` 是相对软链, 搬迁后依然有效。
- 发布链路修好之后, 下一个 tag 才能产出可下载的 Release; 在那之前, 在线安装与关于页一键更新只会 404。

## Testing

- `TestPackageReleaseBundleContract` 钉住 `package-release.sh` 产出的包名与 `SHA256SUMS` 内容; 新增的 `TestReleaseWorkflowPublishesRenamedBundle` 钉住 `release.yml` 的编译目标、上传路径与发布路径跟它一致 —— 只有这两条合起来才能发现"发布链路没跟着改名走"。
- 新增 `TestInstallScriptAdoptsPreRenameInstallation` 钉住旧路径常量、`adopt_legacy_installation` 的存在, 以及它必须排在 `ensure_account_and_directories` 之前。
- `bash -n install.sh` 与 `go test ./...` 通过; `node .agents/skills/hx-agent-notes/scripts/verify-all.ts` 全绿。
- 真实接管(从 v0.12.0 的 systemd 布局升上来)需要一台装着旧版本的机器, 本机没有安装实例, 未验证。
