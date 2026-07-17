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

定时发现必须运行在通过 `SCOUTING_WORKSPACE` 明确指定的私有扫描工作区，不运行在公开站点或腾讯云 Web 主机上。唯一允许的自动阶段是：运行 `$scan-cs-admissions-events`、保存时间戳化 XLSX/JSON、生成候选与差异、汇总新增/变更/删除/pending/72 小时内截止项目。自动任务不得持有腾讯云密钥，不得批准快照、改写 `data/approved/current.json`、推送分支、创建或合并 PR、批准部署。

首发节奏使用一个每两小时运行一次的私有 Codex 自动任务，覆盖全天并满足 08:00 至 24:00 的高峰期要求。创建该定时任务会产生持续算力消耗，必须在操作时向维护者列明执行频率、工作区和输出目录并取得单独确认。手动运行只能作为演练；只有真实定时运行产生并完成审阅的结果，才算及时更新闭环已建立。

每次定时运行必须写入独立的 `runId`（北京时间启动时间加随机短标识）并创建不可复用的私有输出目录。目录至少包含：最终 XLSX、`workbook_data_*.json`、候选 JSON、差异 JSON、覆盖矩阵、受限来源清单和运行摘要。运行摘要记录自动任务身份、开始/结束时间、扫描版本、实际来源、官网复核状态、输出文件 SHA-256、数量统计和 72 小时紧急队列。所有路径必须位于 `SCOUTING_WORKSPACE` 内，并保持在 Git 忽略范围之外的私有存储中。

`no-change` 运行仍保留运行摘要、覆盖矩阵和哈希证据，但不得产生公开 commit 或 PR。任一来源失败、候选为空、官方证据不足、覆盖矩阵缺失或验证失败时，运行状态为失败或待人工处理，现有批准快照保持不变；不得把失败解释为“没有新项目”。

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
- 所有开放项目都显式提供 `eventMode`、`eventTime` 和 `formatLocation`；`eventMode` 只能是 `online`、`offline`、`hybrid` 或 `unknown`；
- `eventMode` 只能由本轮官方正文、官方报名系统、官方公众号或官方附件确认。不得从住宿、报销、城市、校区或活动名称推断；整体安排未公布、条件式或不同人群采用不同形式时必须使用 `unknown`；
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
- 活动形式、活动时间和地点的官方原文及其证据状态；
- 共用官方链接导致的项目重命名或拆分。

删除必须由官方关闭、明确过期或可解释的数据纠正支持。聚合站缺失、搜索无命中或某区域代理未发现都不能单独作为删除依据。审阅发现无法确认时，回到私有扫描数据降级为 pending 后重新导入。

## 准备数据专用 PR

人工批准候选并生成新的 `data/approved/current.json` 后，使用只读规划器检查提交边界。规划器直接读取相对基线的真实 Git diff（包括未跟踪文件），不接受调用者自报清单：

```bash
pnpm run data-pr:prepare -- \
  --base-ref origin/main
```

只有真实 Git diff 中确实包含稳定项目身份映射时，规划器才读取并验证 `data/project-id-aliases.json`。规划器只输出 `no-change` 或受限的 branch/commit/PR 元数据，不执行 Git 写操作。它仅允许 `data/approved/current.json` 和可选的 `data/project-id-aliases.json`，会拒绝 staging、脚本、工作簿、绝对路径、个人投递状态、联系方式和其他私有内容。`no-change` 结果不得创建空 PR；`ready` 结果仍须经过人工检查、CI、精确 head SHA 核验、合并确认和 production approval。

## 批准与验证

差异审阅通过后执行：

```bash
pnpm run snapshot:approve -- \
  --candidate data/staging/candidate.json \
  --approved data/approved/current.json

pnpm run test:unit
pnpm run snapshot:validate
pnpm run snapshot:check-freshness -- \
  --snapshot data/approved/current.json \
  --max-age-hours 6
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

CI 通过后仍需由 reviewer 决定是否合并。合并到 `main` 是发布批准，部署 workflow 的 `production-approval` Environment 是另一个独立信任边界。`production-approval` 不得配置任何 secrets，并且必须配置 required reviewer；它只批准 release metadata 校验和六小时 freshness gate。现有 `production` Environment 继续持有腾讯云部署 secrets；若 `production` 仍配置 required reviewer，真正部署前会出现第二次人工批准。

## 六小时发布契约

启动发布或批准 `production-approval` gate 时，批准快照的 `scanAt` 和 `approvedAt` 都必须处于当前 UTC 时间之前且不超过六小时。恰好六小时仍可接受；超过六小时哪怕一毫秒也必须失败关闭。时间字段缺失、格式错误、位于未来，或 `approvedAt` 早于 `scanAt` 时，同样不得发布。

本地合并前和启动发布前都运行：

```bash
pnpm run snapshot:check-freshness -- \
  --snapshot data/approved/current.json \
  --max-age-hours 6
```

构建阶段把批准快照原样复制为公开的 `dist/data/current.json`，复制后同时核对字节内容、`snapshotId` 和 `dataHash`；把完全相同且仅含 `releaseSha`、`snapshotId`、`dataHash` 的三字段 identity 写入 `dist/data/release.json` 和兼容既有 rollback/smoke 的 `dist/release.json`。公开监控只以两个 `/data/*` 端点为事实源。`snapshotScanAt` 和 `snapshotApprovedAt` 只写入私有的 `release-build/release-metadata.json`，其六字段 schema 保持不变。发布采用三重检查：无密钥的 `production_gate` job 绑定 `production-approval`，在 reviewer 批准后下载构建 artifact，首次校验 release SHA、metadata 精确 schema、字段格式和六小时 freshness；gate 成功后，control-plane 打包和真正的 `deploy` job 才会继续。`deploy` 仍绑定持有腾讯云 secrets 的 `production`，并在已下载 artifact、完成第二次人工批准和排队后，紧邻首个 secret/SSH 步骤再次执行同样的 schema、release SHA 和六小时检查。这样可防止 `production` 第二次人工批准或 runner 排队跨过六小时形成 TOCTOU。归档上传完成且即将激活前，workflow 第三次校验同一 release metadata 和六小时窗口，关闭传输或远端预检期间跨过阈值的剩余窗口。任一检查失败时都必须失败关闭；首个 deploy 检查失败时 SSH step 保持 skipped，cleanup 不得注入 host secrets。gate 本身不引用任何 secrets、不写入 SSH key、不配置 host key，也不联系生产主机。若激活前再次检查发现六小时窗口已过，重新扫描、审阅差异并批准新快照，不得放宽阈值或复用旧批准时间。

## 失败处理

- 扫描失败：保留现有批准快照，记录失败来源并重试。
- 候选为空或无开放项目：导入应失败关闭，不得用空数据替换现有站点。
- 官网与聚合站冲突：采用可读的当轮官方证据；无法确认则降级 pending。
- 活动形式无法从官方来源确认：项目仍可保留，但 `eventMode` 必须为 `unknown`，并保留诚实的 `formatLocation` 原文或“未公布”。
- WAF、HTTP 412、登录或公众号正文不可读：不得复制聚合站事实冒充官方核验。
- 批准中断或校验失败：保留现有 `current.json` 和 staging 证据，不手工拼接 hash 或 snapshot ID。
- 构建或 E2E 失败：不提交、不合并、不部署；先保留诊断 artifact 并修复。

公开仓库只保留批准快照及不含个人状态的运维说明。个人投递清单、排名、联系方式、福利评分、私有扫描报告和绝对本机路径均由 `check:public` 阻断。
