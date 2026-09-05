# 仓库摸排报告

## STATUS

完成。基于 `HEAD=31ce9d56c1da64af98691a31d5f7b3e5403ddc11` 只读检查，无 tracked 源码改动。

## SCOPE

- 页面入口、Svelte 组件、数据适配、筛选与 URL 状态。
- `src/data/schools.json` 的 1,203 条记录、数据源、日期、URL 和身份冲突。
- GitHub Actions、构建命令、测试面、origin/upstream 和 fork 状态。

## FINDINGS

- 当前流为 BoardCaster 整文件覆盖 `schools.json`，随后直接部署；没有官网证据门禁、schema、差异批准或隐私投影。
- 数据文件已经包含 `camp2027` 三条记录，但 `types.ts`、`schools.ts`、`Header.svelte` 和 URL 状态仍使用硬编码来源列表，最新数据可能静默不可见。
- `App.svelte`、`SchoolRow.svelte` 和 `CalendarView.svelte` 使用学校与学院组合键，现有数据已出现冲突。
- 当前 1,203 条记录中有 4 个不可严格解析日期、2 个非 HTTP(S) 官网字段、60 个 `_No response_` 占位值。
- 仓库无单元测试、schema 验证、隐私泄漏门禁、浏览器测试和回滚验证；现有 CI 只构建。
- `Source`、`SOURCES`、`sourceCounts` 和 URL 校验分散硬编码，新增周期需要多处同步修改。

## CHANGES

无 tracked 文件改动。一次 `pnpm` 包装器尝试留下未跟踪 `pnpm-workspace.yaml`，父代理不将其纳入提交。

## VERIFICATION

- 用 `jq`/Node 检查 1,203 条数据及 feed 键、日期、URL 和重复身份。
- 检查 `.github/workflows/update_json.yml` 与 `.github/workflows/deploy.yml` 的行为链。
- 检查 `git diff`，tracked 文件无代理改动。

## RISKS

- 新周期可写入 JSON 但不出现在页面。
- 不稳定组合键会把同院多项目误当成同一记录。
- 直接覆盖发布使聚合站事实未经官网核验进入生产。
- 构建成功不能证明数据可用、公开字段安全或页面交互无回归。

## NEXT

按“快照契约与测试 → 私有导入与公开投影 → 动态 feed 和稳定 ID → CI/部署 → 浏览器与回滚验收”的顺序实施。
