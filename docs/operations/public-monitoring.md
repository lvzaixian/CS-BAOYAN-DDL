# 公开站点监控

`.github/workflows/monitor.yml` 每 6 小时在非整点运行一次，也支持从 `main` 手动触发。它检出触发时的精确 `GITHUB_SHA`，使用 Node 20 校验公开首页、`/data/current.json`、`/data/release.json`、远端快照完整性与时效，以及 TLS 证书。

## 首次配置

在 GitHub 仓库的 **Settings → Secrets and variables → Actions → Variables** 新增 repository-level Actions variable `PUBLIC_BASE_URL`，值必须是公开站点的纯 HTTPS origin，例如：

```text
https://admissions.example.edu.cn
```

不得包含账号、密码、路径、query 或 fragment，也不能使用 localhost、回环地址或私网地址。公开快照在 24 小时后产生 warning，超过 72 小时才使 monitor 失败。这两个阈值固定在 workflow 中，不读取可变仓库配置，避免静默放宽监控标准。24 小时对应每日增量扫描目标，72 小时对应全量覆盖审计周期；部署新版本时仍单独执行严格的 24 小时 freshness 门禁。

当前 production environment 中即使存在同名 `PUBLIC_BASE_URL`，监控也不会读取它。workflow 不声明 environment，只读取 repository-level `vars.PUBLIC_BASE_URL`。

仓库级 `PUBLIC_BASE_URL` 已配置为 `https://ddl.meta-mind.cn`。代码不会内置域名或回退值来掩盖缺失；变量被删除或置空时，监控会在 configuration 阶段失败关闭。

## 安全边界

- no secrets：监控不使用、读取或引用任何 GitHub secret、部署密钥或腾讯云配置；
- no environment：监控不声明或进入 production environment，不经过生产审批，也不获得 environment 变量；
- `permissions` 只有 `contents: read`，checkout 不保留凭据；
- 所有 Actions 固定到完整 commit SHA；
- URL、DNS 结果、HTTP 响应大小和类型、JSON schema、快照完整性以及证书 SAN/有效期均 fail closed；
- 同一次 DNS 解析得到的每个地址都必须是公网地址，否则整次运行停止；TLS 证书连接和三个 HTTPS 请求都直接连接选定的已验证 IP，同时保留原域名的 Host、SNI 和证书 hostname 校验，不会在请求阶段再次解析域名；
- IPv6 只接受原生 global-unicast；IPv4-compatible、IPv4-mapped、NAT64、6to4、Teredo、benchmark、documentation、discard-only、ULA、link-local、multicast 及其他 special-purpose 地址全部拒绝；
- 响应正文按流累计字节：首页上限 1 MiB、current 上限 16 MiB、release 上限 16 KiB；首次超过上限即销毁响应，不会先完整缓冲再判断。
- 30 秒整体响应 deadline 覆盖 DNS、TLS 和三个 HTTPS 响应；任何阶段失败或提前早退都会 destroy/销毁当前响应，不能让悬挂流在后台继续读取。

监控只观察公开 HTTPS 表面，不连接腾讯云主机，不读取 SSH 配置，也不会部署、回滚或修改线上状态。

## 校验内容

一次成功运行必须同时满足：

1. 首页返回成功的 HTML，响应可在大小上有界读取；
2. 公网 `/data/current.json` 使用拒绝普通与 Unicode escaped 重复键的严格 JSON 解析，并只接受共享 approved snapshot schema；
3. 远端 current 通过仓库共享的 `validateApprovedSnapshot`、canonical `dataHash` 完整性校验和 freshness 校验；快照内状态与截止时间的对应关系按 `approvedAt` 校验，运行时已过截止日期由前端即时归为“已结束”；monitor 按当前时间在 24 小时后告警、72 小时后失败，且不读取本地 `data/approved/current.json` 代替公网本体；
4. 公网 `/data/release.json` 同样严格解析，只包含 `releaseSha`、`snapshotId`、`dataHash`；
5. `releaseSha` 格式合法，`snapshotId` 与 `dataHash` 等于同次运行读取并验证的远端 current；若公开部署版本与本次检出的 `GITHUB_SHA` 不一致，monitor 产生中性 warning 并要求复核发布状态，但不会在未验证提交祖先关系时声称“部署落后”。发布动作本身仍由 deploy workflow 的精确 SHA smoke 校验负责；
6. 远端 current 的 `scanAt`、`approvedAt` 不在未来，`approvedAt` 不早于 `scanAt`，且两者不超过 72 小时硬限制；
7. TLS 证书 SAN 匹配目标 hostname，`notAfter` 至少还剩 21 个完整日。

部署产物必须在上述两个精确 `/data/*` 路径提供 JSON；它们是 monitor 的唯一数据事实源。根路径 `/release.json` 保留给 rollback 和既有部署 smoke 兼容，但不属于 monitor 契约。部署 smoke 会同时严格解析根 `/release.json` 与 `/data/release.json` 的精确三字段身份，对 `/data/current.json` 执行完整 approved snapshot schema 校验并重算 canonical `dataHash`，不信任 current 自报 hash，同时要求未知 `/data/*` 路径返回 404。任一事实源缺失、返回 SPA fallback、含普通或 Unicode escaped 重复键、schema 非法、canonical hash 不一致、含额外 identity 字段或身份不一致都会失败关闭。

失败时上传 `public-monitor-failure-*` diagnostics artifact。诊断只记录事件、ref、SHA、失败阶段和截断后的错误信息，不保存响应正文、请求头、环境变量或凭据。成功和失败都会写入 GitHub Actions step summary。

## 本地确定性验证

单元测试使用注入的 DNS、HTTP 和 TLS fixtures，不访问公网：

```bash
corepack pnpm@10.28.2 exec tsx --test tests/monitor-workflow.test.ts
```

不应使用本地执行结果替代 Actions 的真实公网和证书检查。
