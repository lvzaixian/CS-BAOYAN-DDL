# 公开站点监控

`.github/workflows/monitor.yml` 每 6 小时运行一次，也支持从 `main` 手动触发。它只观察 `ddl.meta-mind.cn` 的公开 HTTPS 表面：首页、`/data/current.json`、`/data/release.json` 和 TLS 证书。它不扫描招生来源、不写数据、不部署、不回滚，也不连接腾讯云主机。

## 配置

在 GitHub 仓库的 **Settings → Secrets and variables → Actions → Variables** 设置 repository-level `PUBLIC_BASE_URL`，其值必须是无凭据、无路径、无 query/fragment 的公开 HTTPS root origin，例如：

```text
https://ddl.meta-mind.cn
```

变量缺失、为空或格式不安全时，monitor 在配置阶段失败关闭。monitor 不声明 GitHub Environment；即使 production environment 存在同名变量，也不会读取 production environment 的 `PUBLIC_BASE_URL`。

## 安全边界

- no secrets：monitor 不使用、读取或引用 Secret、SSH 密钥、腾讯云配置或部署凭据；
- no environment：monitor 不声明、不进入或使用 GitHub Environment；
- Actions 仅有 `contents: read`，checkout 不保留凭据；
- DNS、URL、HTTP 类型/大小、严格 JSON、TLS SAN/有效期和 release identity 全部 fail closed；
- 同一次 DNS 解析得到的每个地址都必须是公网地址。HTTPS 连接直接绑定所选地址，同时保留目标 Host、SNI 和证书 hostname 校验；请求阶段不会再次解析域名；
- IPv6 只接受原生 global-unicast；IPv4-compatible、IPv4-mapped、NAT64、6to4、Teredo、benchmark、documentation、discard-only、ULA、link-local、multicast 及其他 special-purpose 地址全部拒绝；
- 响应正文按流读取并受上限约束：首页 1 MiB、`current.json` 16 MiB、`release.json` 16 KiB；30 秒整体响应 deadline 覆盖 DNS、TLS 和三个 HTTPS 请求；失败或提前早退时销毁当前响应，避免悬挂流继续读取。

## 校验内容

一次成功运行必须同时满足：

1. 首页返回可识别的 HTML；
2. `/data/current.json` 通过拒绝普通与 Unicode escaped 重复键的严格 JSON 解析；
3. 远端 current 通过共享的 stored approved snapshot 结构与 canonical `dataHash` 完整性校验。它校验保存快照本身，不会因一条历史 `confirmed-open` 的截止时间已过而重写或拒绝历史；网站前端据截止时间进行运行时已过期归类；
4. `/data/release.json` 只含 `releaseSha`、`snapshotId`、`dataHash`，且身份与同次远端 current 相符；
5. `releaseSha` 格式合法。若与触发 monitor 的 `GITHUB_SHA` 不同，monitor 发出中性 release-parity warning；它不会在未验证提交祖先关系时声称线上“落后”；
6. TLS 证书的 SAN 匹配目标 hostname，且至少还剩 21 个完整日。

公开 monitor 不根据公开 `scanAt`、`approvedAt` 或快照年龄产生 warning/失败。新鲜度约束属于私有 additive run：日常批准器在写数据前要求本轮 `finishedAt` 距批准不超过 24 小时。部署的身份门禁也只验证不可变 `{releaseSha,snapshotId,dataHash,archiveSha}`。

`/data/current.json` 与 `/data/release.json` 是 monitor 的唯一数据事实源。根 `/release.json` 留给部署 rollback/smoke 兼容而非 monitor。部署 smoke 仍会检查根和 `/data/` identity、current schema/哈希、首页、SPA 深链、同源 asset 和未知 `/data/*` 的 404。

失败时 workflow 上传 `public-monitor-failure-*` diagnostics artifact。诊断只记录事件、ref、SHA、失败阶段和截断错误，不保存响应正文、请求头、环境变量或凭据；成功和失败都会写入 Actions summary。

## 本地确定性验证

单元测试使用注入的 DNS、HTTP 和 TLS fixtures，不访问公网：

```bash
corepack pnpm@10.28.2 exec tsx --test tests/monitor-workflow.test.ts
```

本地测试不能替代 Actions 对真实公网、证书和发布 identity 的核验。
