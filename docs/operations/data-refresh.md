# 招生活动数据刷新手册

## 发布边界

公开站点只读取 `data/approved/current.json`。扫描结果、待核实项目、WAF 页面、个人投递状态和本机路径只能留在私有扫描工作区或被 Git 忽略的 `data/staging/`，不得进入公开快照。

CS-BAOYAN DDL、保研通知网等聚合站只用于发现线索。`confirmed-open` 和 `confirmed-unknown-deadline` 必须有学校、学院、研究院、官方报名系统或官方公众号的直接证据；聚合站日期不能绕过官网核验。官网打不开、正文不可读、轮次不明或资格待核实的项目必须保持 pending，并只计入 `counts.pendingExcluded`。

导入命令只写暂存候选，批准命令只做本地原子替换。把包含新批准快照的提交合并到受保护 `main` 才是公开发布批准；本地生成文件或打开 PR 都不等于发布。

## 扫描频率

招生高峰期按北京时间执行：

- 08:00 至 24:00 至少每两小时一次；
- 每晚增加一次凌晨扫描；
- 距截止不足 72 小时的项目发生变化时，立即追加官网复核；
- 非高峰期可降低频率，但每次发布前仍须重新扫描。

每轮扫描都记录实际北京时间、区域覆盖、发现来源、官方证据、受限入口和排除原因。不得把“本轮未发现”写成“确定不存在”。

## 导入候选

先在私有工作区运行 `scan-cs-admissions-events`，再明确指定本轮生成的 `workbook_data_*.json`。不要依赖模糊文件名或聚合站缓存：

```bash
SCOUTING_JSON=/absolute/path/to/reviewed/workbook_data_YYYYMMDD.json
test -f "$SCOUTING_JSON"

pnpm run snapshot:import -- \
  --input "$SCOUTING_JSON" \
  --approved data/approved/current.json \
  --aliases data/project-id-aliases.json \
  --output data/staging/candidate.json
```

导入必须满足：

- 所有公开项目都有稳定 `projectId` 和官方链接；
- 明确截止项目按 `deadlineEpochMs` 升序排列；
- 截止未知项目位于明确截止之后，过期项目位于所有开放项目之后；
- pending/WAF 项目不进入 `opportunities`；
- 纯宣传、纯材料、生物或药学主导且不符合方向边界的项目不进入开放主表；
- 空扫描、没有开放项目、无效数据或失败导入均不得覆盖当前批准快照。

新增招生轮次通过批准快照中的 feed 声明进入前端，不需要修改 `types.ts` 中的硬编码年份或来源集合。

## 审阅差异

生成确定性差异：

```bash
pnpm run snapshot:diff -- \
  --previous data/approved/current.json \
  --next data/staging/candidate.json \
  --output data/staging/diff.json
```

批准前必须逐项审阅：

- 所有距截止不足 72 小时的新增或变更记录；
- 所有删除记录；
- 所有从 pending 升为 confirmed 的记录；
- 截止时间、报名入口、推荐信模板、食宿交通和资格限制的冲突；
- 共用官方链接导致的项目重命名或拆分。

删除必须由官方关闭、明确过期或可解释的数据纠正支持。聚合站缺失、搜索无命中或某区域代理未发现都不能单独作为删除依据。审阅发现无法确认时，回到私有扫描数据降级为 pending 后重新导入。

## 批准与验证

差异审阅通过后执行：

```bash
pnpm run snapshot:approve -- \
  --candidate data/staging/candidate.json \
  --approved data/approved/current.json

pnpm run test:unit
pnpm run snapshot:validate
pnpm run check:public
pnpm run check
pnpm run build
pnpm run test:e2e
git diff --check
```

只有所有命令退出 0，且浏览器截图、72 小时内变更和删除记录完成复核后，才能提交 `data/approved/current.json`。`data/staging/candidate.json` 与 `data/staging/diff.json` 必须保持忽略，禁止使用 `git add -f`。

推荐提交命令：

```bash
git add data/approved/current.json docs/operations/data-refresh.md
git commit -m "data: publish first verified snapshot"
```

CI 通过后仍需由 reviewer 决定是否合并。合并到 `main` 是发布批准，部署 workflow 的 production approval 是另一个独立信任边界。

## 失败处理

- 扫描失败：保留现有批准快照，记录失败来源并重试。
- 候选为空或无开放项目：导入应失败关闭，不得用空数据替换现有站点。
- 官网与聚合站冲突：采用可读的当轮官方证据；无法确认则降级 pending。
- WAF、HTTP 412、登录或公众号正文不可读：不得复制聚合站事实冒充官方核验。
- 批准中断或校验失败：保留现有 `current.json` 和 staging 证据，不手工拼接 hash 或 snapshot ID。
- 构建或 E2E 失败：不提交、不合并、不部署；先保留诊断 artifact 并修复。

公开仓库只保留批准快照及不含个人状态的运维说明。个人投递清单、排名、联系方式、福利评分、私有扫描报告和绝对本机路径均由 `check:public` 阻断。
