# 招生活动数据刷新手册

## 发布边界

公开站点只读取 `data/approved/current.json`。扫描结果、待核实项目、WAF 页面、个人投递状态和本机路径只能留在私有扫描工作区或被 Git 忽略的 `data/staging/`，不得进入公开快照。

CS-BAOYAN DDL、保研通知网等聚合站只用于发现线索。`confirmed-open` 和 `confirmed-unknown-deadline` 必须有学校、学院、研究院、官方报名系统或官方公众号的直接证据；聚合站日期不能绕过官网核验。官网打不开、正文不可读、轮次不明或资格待核实的项目必须保持 pending，并只计入 `counts.pendingExcluded`。

导入命令只写暂存候选，批准命令只做本地原子替换。把包含新批准快照的提交合并到受保护 `main` 才是公开发布批准；本地生成文件或打开 PR 都不等于发布。

## 扫描频率

当前固定运行两条互补任务：

- 每日一次 `incremental`：重查全部重点哨兵、72 小时紧急队列、截止未知、新增、变更、删除和
  pending 项目；未触达的父快照活动项目只能显式 `carried-active`；
- 每 72 小时一次 `full`：逐项覆盖院校注册表、线上快照中的注册表外院校和全部重点哨兵，并展开
  研究生院索引页、学院通知、报名系统、公众号和附件；
- 距截止不足 72 小时的项目发生变化时，立即追加官网复核；
- 每次批准或部署前仍须执行一轮新鲜扫描，不得用旧候选只刷新 `scanAt`。

每轮扫描都记录实际北京时间、区域覆盖、发现来源、官方证据、受限入口和排除原因。不得把“本轮未发现”写成“确定不存在”。

定时发现必须运行在通过 `SCOUTING_WORKSPACE` 明确指定的私有扫描工作区，不运行在公开站点或腾讯云 Web 主机上。唯一允许的自动阶段是：运行 `$scan-cs-admissions-events`、保存时间戳化 XLSX/JSON、生成候选与差异、汇总新增/变更/删除/pending/72 小时内截止项目。自动任务不得持有腾讯云密钥，不得批准快照、改写 `data/approved/current.json`、推送分支、创建或合并 PR、批准部署。

每日增量和 72 小时全量均运行在私有 Codex 自动任务中。任务必须使用同一版严格协议、身份注册表、
重点哨兵和 pending ledger，但每轮必须新建目录且不得复用上一轮候选。手动运行只能作为演练；
只有真实定时运行产生并完成门禁审阅的结果，才算及时更新闭环已建立。自动任务必须先完成
工作簿隐私检查、delivery provenance、全部渲染检查和最终 SHA-256 清单，再把无删除且
`gate.status=ready` 的 pending CAS 作为最后一个可变状态操作；任何交付失败都不得提前推进
canonical pending。

每次定时运行必须写入独立的 `runId`（北京时间启动时间加随机短标识）并创建不可复用的私有输出目录。目录至少包含：最终 XLSX、`workbook_data_*.json`、候选 JSON、差异 JSON、覆盖矩阵、受限来源清单和运行摘要。运行摘要记录自动任务身份、开始/结束时间、扫描版本、实际来源、官网复核状态、输出文件 SHA-256、数量统计和 72 小时紧急队列。所有路径必须位于 `SCOUTING_WORKSPACE` 内，并保持在 Git 忽略范围之外的私有存储中。

`no-change` 运行仍保留运行摘要、覆盖矩阵和哈希证据，但不得产生公开 commit 或 PR。任一要求的官方 surface 失败且未形成对应 pending/blocked 处置、候选为空、官方证据不足、覆盖矩阵缺失或验证失败时，运行状态为失败或待人工处理，现有批准快照保持不变；不得把失败解释为“没有新项目”。聚合站入口不可达时必须记录 `blocked`、具体错误和 `checkedAt`，按扫描 Skill 契约作为软警告；不得伪造 `checked`、不得将其当作官网覆盖，也不得因此跳过官网主动扫描。

## 构建候选与门禁

先在私有工作区运行 `scan-cs-admissions-events`，生成严格的 `ScanBundle schemaVersion=2`。
生产候选只允许由版本化 reducer 从本轮 observation、线上批准父快照、院校注册表、身份注册表和
私有 pending ledger 构建。旧 `workbook_data_*.json -> snapshot:import` 路径只用于冻结历史重放，
不得再作为自动化或人工发布入口。

构建前记录线上父快照原始字节 SHA-256，并读取 pending ledger 的 generation 和 digest。以下文件
必须全部来自同一 runId。可读 evidence 与聚合站检查必须先生成
`artifact-manifest.json`，清单中的相对路径、字节数和 SHA-256 均从本轮 `artifacts/` 的真实普通
文件计算；symlink、路径穿越、缺失文件或摘要漂移都是硬失败。批准用 release 目录采用固定文件名，
并保存构建时实际读取的注册表、哨兵、身份表、已投清单和 pending 基线副本。已投清单必须冻结为
本轮私有 `submitted.json`；标题或院系名称漂移必须先经 identity registry 显式归一化，不能靠
模糊字符串排除。自动扫描若发现当前 registry 无法解释的新漂移，只能在私有 blocked/pending
中记录 `identity-review-required` 并失败待人工处理，不得修改网站工作树或临时自造 alias：

```bash
cp scripts/source/universities.json /private/run/universities.json
cp scripts/source/priority-sentinels.json /private/run/priority-sentinels.json
cp data/project-id-aliases.json /private/run/project-id-aliases.json
cp /private/input/submitted.json /private/run/submitted.json
cp /private/state/pending-ledger.json /private/run/pending-base.json
printf '[]\n' > /private/run/removal-reviews.json

pnpm run scan:build-release -- \
  --bundle /private/run/scan-bundle.json \
  --parent /private/run/public-approved-snapshot.json \
  --registry /private/run/universities.json \
  --sentinels /private/run/priority-sentinels.json \
  --identity-registry /private/run/project-id-aliases.json \
  --submitted /private/run/submitted.json \
  --pending-current /private/run/pending-base.json \
  --artifact-manifest /private/run/artifact-manifest.json \
  --artifact-root /private/run/artifacts \
  --candidate /private/run/candidate.json \
  --diff /private/run/diff.json \
  --lifecycle /private/run/lifecycle.json \
  --evidence-dispositions /private/run/evidence-dispositions.json \
  --pending-next /private/run/pending-next.json \
  --audit /private/run/release-audit.json \
  --removal-reviews /private/run/removal-reviews.json \
  --gate /private/run/gate.json
```

确定性构建必须满足：

- evidence、scope、项目 lifecycle 和 pending event 逐项守恒；evidence 的学校必须与 owner scope
  及全部 discovered scope 完全一致，禁止跨校借证据；
- `submitted-excluded` 经 identity registry 解析后必须精确命中 submitted registry；命中后仍生成
  observation 或排除项无法命中都必须 hard fail；
- full 必须覆盖全部院校注册表和版本化重点哨兵；incremental 未触达父项目只能显式
  `carried-active`，不得刷新其 `verifiedAt`；
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

`scan:build-release` 必须自行重算真实四数组 diff；调用者不得提供或覆盖 diff。存在 removed 时，
gate 必须始终为 `needs-review`。逐项审核后将 exact removal reviews 作为独立 JSON 数组传入
`--removal-reviews` 重新构建；这些 release-local 记录只提供证据，不能自行把 gate 提升为
`ready`。人工批准还必须创建 release 目录外的可信删除授权，并按原始字节 SHA-256 将其传给批准
命令。授权精确绑定 runId、父 snapshot/data hash、candidate canonical hash、removal reviews
字节 SHA-256、排序后的 exact removed IDs、审阅人、审阅时间和理由。自动任务不得生成、复用或
持有该授权。

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
git fetch --prune origin main
git merge-base --is-ancestor origin/main HEAD
git diff --cached --quiet
pnpm run data-pr:prepare -- \
  --base-ref origin/main
```

先显式获取最新 `origin/main`；祖先关系命令必须退出 0，否则先 rebase，不能继续规划。暂存区检查也必须退出 0；规划器要求在 `git add` 之前运行，避免暂存区与工作树代表两份不同内容。首次上线前如果 `origin/main` 尚未包含 `data/approved/current.json`，规划器按预期拒绝运行；首个功能 PR 合并后才能使用这条数据专用路径。

规划器固定要求 `origin/main`，不接受 `HEAD` 或调用者自选的弱基线。它只解析一次远端跟踪引用，后续差异和上版快照都绑定到不可变 base OID；输出前还会重新核对 base OID、HEAD OID、暂存区、变更文件集合，以及已验证 JSON 的精确字节内容，任一状态在准备过程中发生移动都会拒绝生成计划。输出同时记录解析后的 base/head OID 和每个待提交 JSON 的 SHA-256，供 `git add` 后与实际暂存对象复核。只有真实 Git diff 中确实包含稳定项目身份映射时，规划器才读取并验证 `data/project-id-aliases.json`。别名校验复用导入器的身份规则：identity registry 是跨运行真源，允许别名指向因错误快照而暂时缺失、但由历史证据恢复的 canonical ID；复合别名输入与目标仍必须属于同一招生周期，URL 归一化后不得冲突，别名不得形成环或共享 URL 多目标。规划器只输出 `no-change` 或受限的 branch/commit/PR 元数据，不执行 Git 写操作。它仅允许 `data/approved/current.json` 和可选的 `data/project-id-aliases.json`，会拒绝 staging、脚本、工作簿、绝对路径、个人投递状态、联系方式和其他私有内容。`no-change` 结果不得创建空 PR；`ready` 结果仍须经过人工检查、CI、精确 head SHA 核验、合并确认和 production approval。

## 提交 pending 与批准

gate 为 `ready` 后，先以 bundle 声明的旧 generation/digest 对私有 pending ledger 做 CAS。
若 gate 仅因 exact removals 为 `needs-review`，必须先用 release 目录外的可信删除授权和临时
approved/pending 副本完成一次全量批准重放演练；演练通过后才能对真实 pending 做 CAS，并立即
执行真实批准。若 CAS 失败，停止批准并重新读取最新 ledger；禁止覆盖另一运行。CAS 成功后再
执行锁内公开批准：

```bash
pnpm run pending:commit -- \
  --current /private/state/pending-ledger.json \
  --next /private/run/pending-next.json \
  --expected-generation 7 \
  --expected-sha256 <bundle-pending-sha256>

pnpm run snapshot:approve -- \
  --release-dir /private/run \
  --pending-current /private/state/pending-ledger.json \
  --approved data/approved/current.json \
  --removal-authorization /private/reviews/<runId>.json \
  --removal-authorization-sha256 <authorization-bytes-sha256>

pnpm run test:unit
pnpm run snapshot:validate
pnpm run snapshot:check-freshness -- \
  --snapshot data/approved/current.json \
  --max-age-hours 24
pnpm run check:public
pnpm run check
pnpm run build
pnpm run test:e2e
git diff --check
```

`snapshot:approve` 只接受固定布局的 release 目录，并要求目录外的 canonical pending ledger 已通过
CAS 等于本轮 `pending-next.json`。它在批准锁内重读 parent、bundle、registry、sentinels、identity
registry、submitted registry、pending base/next、candidate、diff、lifecycle、evidence dispositions、artifact
manifest、removal reviews、audit 和 gate，重新读取 `artifacts/` 真实字节并完整重放 reducer 与
gate。无 removed 时不应提供删除授权；有 removed 时 gate 必须保持 `needs-review`，且授权文件
必须位于 release 目录外、与命令行 SHA-256 及 exact removed 集合一致。伪造摘要、空 diff、
candidate/parent 漂移、未提交 pending、非零损失指标、hard error、授权漂移或未审 removed 均
不得替换 current。批准锁和公开 current 的替换都使用不可覆盖的捕获/恢复语义，避免检查后
unlink/rename 竞态。只有所有命令退出 0，且浏览器截图、72 小时内变更和删除记录完成复核后，
才能提交 `data/approved/current.json`。全部私有运行产物保持 Git 忽略，禁止 `git add -f`。

批准并发模型固定如下：

- 所有合法写者必须使用批准命令旁的同一把锁；扫描自动化不以具有批准写权限的服务身份运行；
- 普通读者不获取写锁，但在替换期间必须始终读到完整旧版或完整新版，不能出现 current 路径
  短暂缺失；
- 写入端先 fsync 新临时文件，再为旧 current 建立同目录恢复硬链接，随后使用单次
  `rename(temp, current)` 原子覆盖；失败恢复只能在 current 仍指向本次新 inode 时使用
  `rename(previous, current)` 原子执行；
- 与批准进程同一 Unix 用户、绕过锁直接篡改文件的恶意进程不属于此文件级协议的安全边界；
  需要防御该主体时必须使用独立 Unix 用户和目录权限隔离，不能依赖 pathname CAS。

推荐提交命令：

```bash
git add data/approved/current.json docs/operations/data-refresh.md
git commit -m "data: publish first verified snapshot"
```

CI 通过后仍需由 reviewer 决定是否合并。合并到 `main` 是发布批准，部署 workflow 的 `production-approval` Environment 是另一个独立信任边界。`production-approval` 不得配置任何 secrets，并且必须配置 required reviewer；它只批准 release metadata 校验和 24 小时 freshness gate。现有 `production` Environment 继续持有腾讯云部署 secrets；若 `production` 仍配置 required reviewer，真正部署前会出现第二次人工批准。

## 24 小时发布契约

启动发布或批准 `production-approval` gate 时，批准快照的 `scanAt` 和 `approvedAt` 都必须处于当前 UTC 时间之前且不超过 24 小时。恰好 24 小时仍可接受；超过 24 小时哪怕一毫秒也必须失败关闭。时间字段缺失、格式错误、位于未来，或 `approvedAt` 早于 `scanAt` 时，同样不得发布。

本地合并前和启动发布前都运行：

```bash
pnpm run snapshot:check-freshness -- \
  --snapshot data/approved/current.json \
  --max-age-hours 24
```

构建阶段把批准快照原样复制为公开的 `dist/data/current.json`，复制后同时核对字节内容、`snapshotId` 和 `dataHash`；把完全相同且仅含 `releaseSha`、`snapshotId`、`dataHash` 的三字段 identity 写入 `dist/data/release.json` 和兼容既有 rollback/smoke 的 `dist/release.json`。公开监控只以两个 `/data/*` 端点为事实源。`snapshotScanAt` 和 `snapshotApprovedAt` 只写入私有的 `release-build/release-metadata.json`，其六字段 schema 保持不变。发布采用三重检查：无密钥的 `production_gate` job 绑定 `production-approval`，在 reviewer 批准后下载构建 artifact，首次校验 release SHA、metadata 精确 schema、字段格式和 24 小时 freshness；gate 成功后，control-plane 打包和真正的 `deploy` job 才会继续。`deploy` 仍绑定持有腾讯云 secrets 的 `production`，并在已下载 artifact、完成第二次人工批准和排队后，紧邻首个 secret/SSH 步骤再次执行同样的 schema、release SHA 和 24 小时检查。这样可防止 `production` 第二次人工批准或 runner 排队跨过 24 小时形成 TOCTOU。归档上传完成且即将激活前，workflow 第三次校验同一 release metadata 和 24 小时窗口，关闭传输或远端预检期间跨过阈值的剩余窗口。任一检查失败时都必须失败关闭；首个 deploy 检查失败时 SSH step 保持 skipped，cleanup 不得注入 host secrets。gate 本身不引用任何 secrets、不写入 SSH key、不配置 host key，也不联系生产主机。若激活前再次检查发现 24 小时窗口已过，重新扫描、审阅差异并批准新快照，不得放宽阈值或复用旧批准时间。

## 失败处理

- 扫描失败：保留现有批准快照，记录失败来源并重试。
- 候选为空或无开放项目：导入应失败关闭，不得用空数据替换现有站点。
- 官网与聚合站冲突：采用可读的当轮官方证据；无法确认则降级 pending。
- 活动形式无法从官方来源确认：项目仍可保留，但 `eventMode` 必须为 `unknown`，并保留诚实的 `formatLocation` 原文或“未公布”。
- WAF、HTTP 412、登录或公众号正文不可读：不得复制聚合站事实冒充官方核验。
- 批准中断或校验失败：保留现有 `current.json` 和 staging 证据，不手工拼接 hash 或 snapshot ID。
- 构建或 E2E 失败：不提交、不合并、不部署；先保留诊断 artifact 并修复。

公开仓库只保留批准快照及不含个人状态的运维说明。个人投递清单、排名、联系方式、福利评分、私有扫描报告和绝对本机路径均由 `check:public` 阻断。
