# 架构审查报告

## STATUS

完成。只读审查仓库、设计初稿和 `scan-cs-admissions-events` 契约。

## SCOPE

- 公开与私有数据边界。
- 数据契约、feed 演进、稳定项目身份和兼容适配。
- CI/CD、原子发布、回滚、隐私和失败语义。

## FINDINGS

- P0：扫描 Skill JSON 含 `fit`、`recommendationTier`、`welfareScore`、`socialValue`、`risks` 和已投排除逻辑，必须留在私有证据层；公开快照采用字段白名单。
- P0：公开 v1 只允许 `confirmed-open`、`confirmed-unknown-deadline`、`expired`。`pending-waf`、`pending-unconfirmed` 和 preview-only 只留在 staging。
- P0：feed catalog 必须来自快照，验证器要求默认 feed 存在且所有记录引用合法 feed，禁止 UI 维护第二份年份表。
- P0：`projectId` 必须冻结，不能每次从可能修订的显示名称重算；改名应通过 alias 处理。
- P1：公开投影器需拒绝未知字段、聚合站冒充官网、占位文本、无效日期、重复 ID 和任何私人字段注入。
- P1：发布 artifact 必须绑定 commit、snapshot ID 和 content hash；失败不能改变当前线上版本，回滚必须经过同一验证门禁。

## CHANGES

无代码或云端改动。父代理已据此修正设计与计划中的硬编码 `camp2026`、公开 pending 和组合键问题。

## VERIFICATION

- `svelte-check`：0 errors、0 warnings。
- `scan-cs-admissions-events` 验证测试：17/17 通过；超链接测试通过。
- 两份 GitHub Actions YAML 可解析。
- 检查 1,203 条现有记录、feed、字段、重复身份、日期和 URL。

## RISKS

- Skill validator 与公共 schema 若复制近似规则会逐渐漂移，应使用固定跨契约夹具或共享纯函数。
- 公开 pending 或原始证据全文会放大错误、版权、隐私和撤回成本。
- 腾讯云实例、域名、备案、Nginx、证书仍未只读核验，不能直接落生产配置。

## NEXT

先实现数据契约、夹具和泄漏测试；再实现 allowlist projector、动态 feed 和稳定 ID；最后接入 CI、腾讯云原子发布与独立验证。

## FINAL REVIEW

修订后的设计与计划经过两轮只读复验。第一轮发现 staging 忽略时序、批准元数据归属、首次部署补偿、E2E 门禁、secret/variable 数量和分支/PR 命令六项阻塞；修正后第二轮进一步闭合首次/后续发布状态机。最终结果为 `PASS`，无阻塞项，可进入实施阶段。
