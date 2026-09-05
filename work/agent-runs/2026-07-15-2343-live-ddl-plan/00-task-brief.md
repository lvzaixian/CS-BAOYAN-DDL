# 任务简报

## Objective

在 `/Users/maxwellbrooks/Workspace` 新建并连接一个 GitHub fork，形成“及时更新的 CS 保研 DDL”项目设计和可逐项执行的实施计划。页面主体、列表、日历、筛选、搜索、倒计时和快捷键尽量保持上游一致，数据更新改为官网核验优先、可审计、可回滚。

## Acceptance Criteria

- 本地仓库位于 `/Users/maxwellbrooks/Workspace/CS-BAOYAN-DDL`，GitHub 仓库为 `lvzaixian/CS-BAOYAN-DDL`。
- 保留与 `CS-BAOYAN/CS-BAOYAN-DDL` 的 fork 关系、MIT 许可证和上游只读 remote。
- 提供经过仓库检查和独立审查的设计文档与逐任务实施计划。
- 计划覆盖官网核验数据契约、私有 staging、批准快照、动态批次、稳定项目 ID、CI、隐私门禁、腾讯云原子部署、回滚和浏览器验收。
- 公开快照不得包含待核/WAF 行、个人已投状态、匹配分、食宿游玩评分、本地路径或凭据。
- 计划分支推送到 GitHub 并创建草稿 PR；本轮不修改腾讯云生产配置。

## Constraints

- 不对上游仓库推送；`upstream` push 必须保持禁用。
- 不在没有真实主机、域名、备案、证书和 Nginx 证据前修改腾讯云。
- 聚合站只作发现来源，公开项目必须绑定官网、官方系统、官方公众号或官方附件。
- 不把私有申请状态用于公共列表筛选，也不提交 staging 候选和私有差异 JSON。
- 本轮只交付 fork、设计、计划、台账和 GitHub 连接，不提前实现产品功能。

## Risk Controls

- 批准快照采用公开字段白名单，验证器拒绝未知属性、重复 ID、无效时间、聚合站冒充官网和周期引用漂移。
- `pendingRows` 仅留在私有 staging，公开快照只含 `confirmed-open`、`confirmed-unknown-deadline` 和 `expired`。
- 批次目录来自快照，避免 `camp2027` 已存在但 UI 类型写死导致静默不可见。
- 腾讯云发布使用版本目录、原子软链接、外部 smoke test 和失败回滚。

## Stop Points

- 修改安全组、SSH、DNS、TLS 或生产 Nginx 前必须取得用户明确确认。
- 首次生产部署和首次合并实现 PR 前必须确认 CI 证据与腾讯云只读盘点结果。
- 自动扫描不能拥有绕过人工批准直接发布的权限。
