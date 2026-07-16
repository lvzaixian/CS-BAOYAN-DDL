# 公开站点监控

`.github/workflows/monitor.yml` 每 6 小时在非整点运行一次，也支持从 `main` 手动触发。它检出触发时的精确 `GITHUB_SHA`，使用 Node 20 校验公开首页、`release.json`、批准快照身份、快照时效和 TLS 证书。

## 首次配置

在 GitHub 仓库的 **Settings → Secrets and variables → Actions → Variables** 新增 repository-level Actions variable `PUBLIC_BASE_URL`，值必须是公开站点的纯 HTTPS origin，例如：

```text
https://admissions.example.edu.cn
```

不得包含账号、密码、路径、query 或 fragment，也不能使用 localhost、回环地址或私网地址。仓库变量 `MAX_SNAPSHOT_AGE_HOURS` 可选；不设置时使用 `24`，只接受可转换为安全整数毫秒的正十进制小时数。

当前 production environment 中即使存在同名 `PUBLIC_BASE_URL`，监控也不会读取它。workflow 不声明 environment，只读取 repository-level `vars.PUBLIC_BASE_URL` 和可选的 `vars.MAX_SNAPSHOT_AGE_HOURS`。

## 安全边界

- no secrets：监控不使用、读取或引用任何 GitHub secret、部署密钥或腾讯云配置；
- no environment：监控不声明或进入 production environment，不经过生产审批，也不获得 environment 变量；
- `permissions` 只有 `contents: read`，checkout 不保留凭据；
- 所有 Actions 固定到完整 commit SHA；
- URL、DNS 结果、HTTP 响应大小和类型、release schema、快照完整性以及证书 SAN/有效期均 fail closed。

监控只观察公开 HTTPS 表面，不连接腾讯云主机，不读取 SSH 配置，也不会部署、回滚或修改线上状态。

## 校验内容

一次成功运行必须同时满足：

1. 首页返回成功的 HTML，响应可在大小上有界读取；
2. `/release.json` 只包含 `releaseSha`、`snapshotId`、`dataHash`，并符合严格格式；
3. `releaseSha` 等于本次检出的 `GITHUB_SHA`，其余两项等于 `data/approved/current.json`；
4. 本地批准快照通过仓库共享的严格 validator 和 canonical 完整性校验；
5. `scanAt`、`approvedAt` 不在未来，`approvedAt` 不早于 `scanAt`，且两者不超过最大年龄；
6. TLS 证书 SAN 匹配目标 hostname，`notAfter` 至少还剩 21 个完整日。

失败时上传 `public-monitor-failure-*` diagnostics artifact。诊断只记录事件、ref、SHA、失败阶段和截断后的错误信息，不保存响应正文、请求头、环境变量或凭据。成功和失败都会写入 GitHub Actions step summary。

## 本地确定性验证

单元测试使用注入的 DNS、HTTP 和 TLS fixtures，不访问公网：

```bash
corepack pnpm@10.28.2 exec tsx --test tests/monitor-workflow.test.ts
```

不应使用本地执行结果替代 Actions 的真实公网和证书检查。
