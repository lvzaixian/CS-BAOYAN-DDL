# 证据记录

## Commands

| Time | Command | Exit | Evidence | Proves | Limits |
| --- | --- | --- | --- | --- | --- |
| 23:32 | `gh repo fork CS-BAOYAN/CS-BAOYAN-DDL --clone=false` | 0 | `https://github.com/lvzaixian/CS-BAOYAN-DDL` | GitHub fork 已创建 | 不证明 Actions 已配置 |
| 23:34 | `git fetch origin main && git checkout -b main --track origin/main` | 0 | `HEAD=31ce9d5` | fork 初始化竞态已修复并跟踪 main | 不验证产品构建 |
| 23:36 | `git remote -v` | 0 | origin 指向用户 fork；upstream push 为 `DISABLED` | 上游误推边界 | 只验证本地 remote |
| 23:54 | `gh repo view lvzaixian/CS-BAOYAN-DDL ...` | 0 | `isFork=true`、default branch `main` | GitHub 远端存在且是 fork | API 返回未展开 parent 名称 |
| 23:47 | 只读数据与源码扫描 | 0 | 1,203 条记录；JSON 有 `camp2027`，UI 类型只到 `camp2026` | 动态 feed 是必须项 | 基于当前 commit |
| 23:48 | `svelte-check --tsconfig ./tsconfig.json` | 0 | 0 errors、0 warnings | 当前上游类型检查基线 | 不证明生产构建和浏览器行为 |
| 23:49 | Skill validator tests | 0 | 17/17 通过 | 私有扫描契约当前自洽 | 不等于公共快照已安全 |
| 23:56 | clean clone 中 `corepack pnpm@10.28.2 install --frozen-lockfile` | 0 | lockfile 安装 113 个包 | 上游依赖可从锁文件恢复 | esbuild install scripts 被 pnpm policy 忽略 |
| 23:56 | clean clone 中 `corepack pnpm@10.28.2 run check` | 0 | `0 errors and 0 warnings` | 上游类型/Svelte 基线通过 | 不覆盖计划中的新功能 |
| 23:56 | clean clone 中 `corepack pnpm@10.28.2 run build` | 0 | 3,754 modules，`dist/index.html` 和 assets 生成 | 上游生产构建基线通过 | 存在 623.92 kB chunk warning |
| 00:08 | architecture reviewer 最终复验 | 0 | `FINDINGS: PASS` | 设计与计划无剩余阻塞矛盾 | 只验证文档，功能仍待实现 |

## Files And Artifacts

| Path | Evidence | Proves | Limits |
| --- | --- | --- | --- |
| `docs/superpowers/specs/2026-07-15-live-cs-baoyan-ddl-design.md` | 完整设计、数据契约、部署边界 | 架构决策已冻结 | 尚未实现 |
| `docs/superpowers/plans/2026-07-15-live-cs-baoyan-ddl.md` | 11 个任务、TDD 步骤、命令和验收标准 | 可逐项执行 | 尚未执行功能任务 |
| `agent-reports/repo-map.md` | 仓库结构与风险图 | 计划基于真实仓库 | 只读快照 |
| `agent-reports/architecture-review.md` | 独立架构复核 | 关键边界经过第二视角 | 不替代实现验收 |

## Citations

| Claim | Source | Evidence | Limits |
| --- | --- | --- | --- |
| 最新 feed 可静默不可见 | `src/data/schools.json`、`src/lib/types.ts`、`src/lib/schools.ts` | `camp2027` 存在而联合类型未包含 | 上游后续可能修复 |
| BoardCaster 可整文件直推 | `.github/workflows/update_json.yml` | clone、copy、commit、push 链路 | fork 尚未启用该工作流 |
| 组合键存在身份风险 | `src/App.svelte`、`src/components/SchoolRow.svelte`、数据扫描 | 使用 `name::institute` 且数据已有重复 | 需实现稳定 ID 后复测 |
