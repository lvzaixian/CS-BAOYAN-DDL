# 交接

## Current State

- GitHub fork：`https://github.com/lvzaixian/CS-BAOYAN-DDL`。
- 本地仓库：`/Users/maxwellbrooks/Workspace/CS-BAOYAN-DDL`。
- 基线：`31ce9d56c1da64af98691a31d5f7b3e5403ddc11`。
- 计划分支：`codex/live-data-plan`。
- 计划提交：`88520b7`（随后仅追加本交接记录）。
- 草稿 PR：`https://github.com/lvzaixian/CS-BAOYAN-DDL/pull/1`。
- 设计和执行计划已根据 repo explorer 与 architecture reviewer 结果修正。

## Decisions

- 保持上游主要 UI 与交互，不重做产品形态。
- 私有扫描和公开快照严格分层；聚合站不构成官网证据。
- 公开快照只含官方确认或已过期记录，不公开 pending/WAF。
- feed 动态化，稳定 ID 贯穿列表、日历、详情和 diff。
- GitHub 用于源码、PR 和 CI，腾讯云用于最终静态发布。

## Open Risks

- 腾讯云事实未核验，不能直接配置生产。
- 当前上游存在日期、URL、占位值和组合键质量问题，首个公开快照不能直接把历史 JSON 标记为已核验。
- staging JSON 必须保持 ignored，避免私人字段进入公共 Git 历史。

## Next Actions

1. 从 Task 1 开始执行 `docs/superpowers/plans/2026-07-15-live-cs-baoyan-ddl.md`。
2. 推荐使用 subagent-driven execution：契约/验证器、导入器/批准、UI 适配、CI/部署、独立验证按不冲突文件范围拆分。
3. 在 Task 8/11 前只读盘点腾讯云；到修改安全组、SSH、DNS、TLS 或生产 Nginx 的停止点时再向用户确认。
4. 第一次真实快照必须重新运行 `scan-cs-admissions-events`，不能复用旧日期输出。
