# CS DDL 追加式更新工作约定

## 目标与边界

`ddl.meta-mind.cn` 是一个公开招生信息聚合站。日常更新的目标是持续发现并追加有官方证据的新项目；它不是逐条人工审批、全量重审或删除同步系统。

日常更新遵循五项不可降级的规则：

1. 扫描先广后深：注册表、学院/研究院、报名系统、官方通知、附件和线索站共同发现；网页内链接、PDF、Office 附件、图片和内嵌预览必须递归展开并解析。
2. 公共条目只增不减：在线快照是唯一父本。每天只追加父本中不存在的 canonical `projectId`，绝不因本轮未命中、WAF、附件不可读、字段变化或疑似关闭而改写、删除或降级父项。
3. 过期由展示层派生：已保存的最早行动截止时间一过，前端把项目归为已过期；不为此扫描旧项目或回写其历史状态。
4. 自动化优先：保留官方证据、去重、隐私、原子写入、CI、构建和公网 smoke；日常追加不要求 pending CAS、删除授权、工作簿、逐项人工复核或 Environment 人工批准。
5. 学院级公开粒度：每条未来新增公开项目必须对应一个官方明确适用的招生单位；`name` 填学校或独立办学机构，`institute` 填学院、系、研究院、国际学院、联合培养单位或其他官方招生单位的完整官方名称。全校/全院系/各学院/校级入口/招生系统级等学校范围通知或标签仅是发现和证据容器，不能作为新公开行。

## 日常批准器

唯一日常公开数据写入入口是：

```bash
pnpm run snapshot:approve-additive -- \
  --run /private/run/discovery-run.json \
  --parent /private/run/public-parent.json \
  --approved data/approved/current.json \
  --decision /private/run/release-decision.json \
  --registry scripts/source/universities.json \
  --sentinels scripts/source/priority-sentinels.json
```

`discovery-run.json` 是私有的 `schemaVersion: 3` 日常运行文件，必须包含唯一 `runId`、`incremental` 或 `sweep` 模式、开始/结束时间、从 `https://ddl.meta-mind.cn/data/current.json` 新鲜下载的父快照原始 SHA-256、父 `snapshotId`/`dataHash`、scope 图、普通官方 artifact 清单、候选新增项和字段证据。它还必须带有 `coverage`：`{schemaVersion: 1, rotationDate, registrySha256, sentinelsSha256}`。两个 SHA-256 是本轮冻结的注册表和哨兵配置原始字节哈希；`rotationDate` 必须等于 `finishedAt` 的北京时间日期。私有候选、旧运行产物和工作簿不能充当父本。

每日 v3 run 还必须带有 `fixedDiscoveryChecks`，并且**恰好**包含以下三项私有深研派发现检查：

- `shenyanpai-profile`：`https://github.com/shenyanpai`；
- `shenyanpai-summer-camp`：`https://github.com/shenyanpai/awesome-summer-camp-<YYYY>`；
- `shenyanpai-pre-recommend`：`https://github.com/shenyanpai/awesome-pre-recommend-<YYYY>`。

`<YYYY>` 由 `finishedAt` 的 Asia/Shanghai 日历年导出。每项严格包含 `checkId`、`url`、`checkedAt`、`result`、`artifactSha256`、`reason`。`checked` 必须绑定同一规范化 URL 的本轮、已逐字节复算 SHA-256 的非空可读 UTF-8 text/HTML artifact，且 `reason` 为 `null`；`blocked` 必须没有 artifact（`artifactSha256: null`）且保留非空具体原因。`checkedAt` 必须落在本轮时间窗内，多个 `checked` 项不得复用 SHA。三项均须存在并通过形状、URL、时间、artifact/原因验证，批准器才会继续，**包括零新增 run**。`blocked` 仍计为该固定入口已经尝试，不阻断由独立同校官方证据支持的新增，也允许产生私有 `no-additions` 决定。

日常批准器只接受 v3。旧私有 v2 输入仅属于历史 `ScanBundle`/replay 或经授权维护链路，不能绕过每日固定检查进入日常追加。

批准器在一次操作中确认：

- 运行结束时间距批准时不超过 24 小时；本地 `--approved` 的原始字节仍等于冻结父本；
- 重新读取 `--registry` 与 `--sentinels`，核对其原始字节哈希，并从父本、注册表和北京时间日期导出必查范围：每日所有重点哨兵和稳定七分之一的“注册表学校 + 父本额外机构”；`sweep` 必查整个并集。哨兵 root scope 可同时满足同校轮转，`blocked` 仅作为有原因的已尝试记录写入私有 decision；
- 父快照 schema、完整性和身份成立；每条父项对象的字段和值被完全保留，只有新快照元数据、总计数和新增项会改变；
- 新增项与父本及同轮新增项均无重复 `projectId`，并按运行结束时刻进行新增项校验；
- 每个新增项保留完全一致的官方发现 URL 和 primary artifact；`name`、`institute`、`project`、`eventType`、`website`、状态、截止、活动安排、材料、推荐和后勤字段均有可追溯的字段证据，字段值与公开数据逐项一致；
- 每个字段证据都指向同轮普通 artifact，记录来源、定位、方法、原文和核验时间；artifact 的 `path` 必须相对本轮目录、逐段无符号链接，批准器会重读原始字节并复算 SHA-256。HTML/text 引文必须实际出现且包含该字段的来源值；PDF/Office 引文只能借由同 URL、同轮且哈希已核验的 `text/plain` 提取 artifact 显式绑定。ISO deadline 以 `deadlineOriginal` 原文支撑，website 由 exact source URL 绑定，verificationStatus 由项目原文与 deadline 证据共同派生。

新增项为零时，批准器只在私有目录写 `release-decision.json`，返回 `no-additions`，不会改写 `current.json`、创建公开提交或触发部署。非空追加会先写私有 `eligible` 决定，只有公开原子写入成功后才把决定更新为 `ready`。任何父项减少/改写、重复身份、证据缺失、父本漂移或过期私有运行都会失败关闭；相关线索留在私有重试/隔离队列，不影响其它后续运行。

`snapshot:validate` 验证已保存快照的 schema 和不可变完整性，不会用“今天已过截止”否定父快照中的历史状态。运行时的已过期分类由前端根据保存的截止时间派生；新追加项仍在本轮结束时接受严格日期校验。

## 来源与深扫描

学校研究生院、学院、研究院、官方报名系统、官方公众号和官方附件是事实来源。批准器只接受机构/政府域名或固定官方平台的 URL，且 primary artifact 必须明确写出对应学校；保研通知网、CS-BAOYAN DDL、BoardCaster 与深研派 GitHub 通知合集等仅用于发现线索，不能单独支撑公开字段。这是对可信扫描器的可自动核验来源类别约束，并不是 DNS 归属证明；发现器仍须如实选择同校官方入口。

对每个候选官方入口执行有去重和深度上限的遍历：保存最终 URL、抓取时间、Content-Type、字节数和 SHA-256；发现并继续读取学院子页、系统链接、PDF、Office 文件、图片、下载/预览链接。扫描件或图片需要 OCR 或可读页检查。应优先抽取系统字段和当年学院附件中的报名动作、所有截止、时间/形式/地点、材料、推荐、住宿、餐食、交通、报销和资格限制；未公布与未能读取必须如实区分，不能用聚合摘要补写官方事实。

### 学院级条目拆分

新增 `projectId` 必须采用 `招生周期|name|institute|项目/轮次`。同一招生单位在报名系统、PDF 与学院页面出现名称变体时，规范 `institute` / `projectId` 单位名称以当年可读且最具体的官方报名来源为准；仅当官方证据可证明各变体确为同一招生单位时才视为同一单位，无法证明等价关系时保留在私有身份重试/隔离队列，不追加第二条公开行。不得臆造别名，也不得用此规则改写历史父项。当同一官方通知、PDF 或报名系统明确列出多个范围内且符合资格的单位时，递归展开，按单位各建一条独立去重的新增项；每一项都必须保留同一 `runId` 的官方证据，且证据明确支持该单位的申请资格。不得臆造或复制学院名单。无法识别具体适格单位时，线索只保留在私有重试队列，不发布任何全校/全院系通用行。学院、系、研究院、国际学院、联合培养单位或其他官方招生单位等任何候选 `institute`，仅当其本身是官方明确列出的最小适用招生单位、且未列出更下级的可申请单位时才可使用；独立研究生院或独立研究院也依同一标准。若存在同招生周期、同学校的历史通用父项，它不替代学院级身份；有具体官方证据的单位级新增项可以追加，并与不可变的历史通用父项共存。日常工作不得隐藏、删除或降级该父项；移除、拆分或纠正该历史通用行必须另建经用户明确授权的维护迁移。

批准器每天强制处理全部重点哨兵和稳定七分之一的注册表/父本额外机构；`sweep` 强制处理完整并集。这个门禁证明本次 run 已尝试当天的确定范围，不能倒推某一天没有被调度。发现“无新增”不等于该校没有项目；WAF、登录、验证码、下载故障和身份冲突均只进入私有重试队列。

## 私有与公开边界

私有目录可以保存运行文件、原始 artifact、字段卡、失败原因和重试队列；它们不得被提交。不得提交个人投递信息、联系方式、评分、私有路径、原始官方文件、凭据、主机地址或任何 Secret 值。

深研派的 GitHub / `raw.githubusercontent.com` 内容仅可用于私有发现。新增项的公开 `opportunity` 序列化后，任何字段都不得包含 GitHub/raw URL，或可识别任一固定检查的 provenance：其 URL、artifact SHA、artifact text、`checkId` 或 `blocked` 的具体原因；这涵盖所有 `discoverySources` 变体（含 `other-discovery`），而非只限制 `kind: official`。普通孤立的 `checked`/`blocked` 文本不是固定检查 provenance。同校官方 `officialUrl`、primary artifact、字段证据和学院级 fan-out 仍是新增项的独立硬门槛。该公开泄漏拒绝只审查 additions，不回写或重新判定历史父项。

公开提交只可包含经批准的公开快照及必要的公开代码/文档；日常批准不得顺带引入私有文件。批准器使用锁和原子替换，失败时旧快照必须仍可读取。

## 发布与旧链路

通过批准器产生实际新增后，按受保护 `main` 的既有自动路径提交、CI、构建、部署和公网 smoke。正常日常更新不要求人工 PR 审阅；CI、不可变发布身份和公网 smoke 是发布门禁。部署保留 `production-approval` 与 `production` Environment 绑定、分支限制、Secret 隔离、原子激活和回滚。

为实现无人值守，两个 GitHub Environment 的 `required_reviewers` 必须由仓库管理员一次性移除，同时保留各自的 Environment、分支限制和 `production` 的部署 Secrets。此项是外部 GitHub 配置，文档或代码修改不代表它已经完成；每次切换前必须只读核验其实际状态。

`.github/workflows/deploy.yml` 只围绕不可变 `{releaseSha, snapshotId, dataHash, archiveSha}` 做 gate、SSH 前和 activation 前复核；它不再以公开快照时间戳年龄阻止代码/站点部署。公网 monitor 同样只检查可用性、TLS、公开 schema/完整性和 release identity。

旧的 `scan:build-release`、`pending:commit` 和 `snapshot:approve` 仍保留给历史迁移、明确授权的修正/合并或删除维护，不能作为日常追加的替代入口。任何修正、合并、删除或身份迁移都必须单独建维护任务并取得用户明确授权。

## 最低验证集

数据批准后、提交前至少运行：

```bash
pnpm run snapshot:validate
pnpm run check:public
pnpm run test:unit
pnpm run build
git diff --check
```

上线后读取 `/data/current.json` 与 `/data/release.json`，核对 `snapshotId`、`dataHash`、新增项目和页面可见性。任何步骤失败时保留上一版本，记录可处理的私有诊断；不得手工拼接线上文件或把失败扫描伪装为无新增。

## Upstream

保留 MIT 许可证与上游署名。UI 更新从 `upstream` 手动引入；不得恢复 BoardCaster 的整文件覆盖流程或上游 CNAME。
