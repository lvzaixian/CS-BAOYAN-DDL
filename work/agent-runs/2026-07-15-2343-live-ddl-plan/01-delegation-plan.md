# 委派计划

## Routing Decision

本任务包含仓库结构摸排和独立架构审查两个可并行、只读的工作流。父代理负责 fork/GitHub、最终架构决策、文档编写、冲突裁决、验证、提交和 PR。

## Workstreams

| Agent | Role | Scope | Forbidden Scope | Edits Allowed | Output |
| --- | --- | --- | --- | --- | --- |
| `019f6672-b44d-77e3-991b-8106cb0636c4` | `repo_explorer` | 入口、数据流、类型、组件、工作流、测试面、数据质量和风险图 | 修改 tracked 文件、部署、推送 | 否 | repo map、行为流、风险热图、实施上下文包 |
| `019f6672-b553-79b3-8ead-50fb3f741150` | `architecture_reviewer` | 公开/私有边界、快照契约、动态批次、稳定 ID、CI/CD 和回滚 | 修改源码、云端状态、Skill | 否 | 严重度排序的架构审查与推荐边界 |

## Parent Work While Children Run

- 创建并修复 GitHub fork、本地 clone、`origin`/`upstream` 和计划分支。
- 读取上游代码和 `scan-cs-admissions-events` 契约，形成设计初稿。
- 根据两个审查结果修正动态 feed、公开 pending、稳定 ID 和部署停止点。
- 维护 production orchestration 台账，执行验证，提交并推送计划 PR。

## Wait/Close Policy

两个代理均返回结构化完成报告后再冻结设计。报告整合完成、证据写入 `agent-reports/` 后关闭代理；不让已完成代理继续占用并发名额。
