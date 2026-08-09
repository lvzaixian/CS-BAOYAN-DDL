# 招生活动追加式数据刷新

## 目的

日常刷新只负责发现、核验并追加新的公开招生项目。公开快照以线上 `https://ddl.meta-mind.cn/data/current.json` 为唯一父本；一个更新的候选必须严格等于“父本 + 新增项”。本轮没有发现、某个官网受阻、附件解析失败、字段不完整或外部站点没有命中，都不能删除、改写或降级既有公开条目。

项目一经发布持续保留。页面根据保存的最早行动截止时间即时显示“已过期”；日常扫描不因已过截止而修改父项，也不把网站快照的时间戳年龄当作部署阻塞条件。

## 每日发现与深挖

日常 `incremental` 优先处理新鲜搜索/聚合线索、重点哨兵、最近新入口和私有重试队列；`sweep` 用注册表分片轮转，使学院、研究院和联合单位在一周内都获得一次轻量发现。聚合站只产生线索，不能成为公开事实来源。

对每个官方入口进行队列式 fan-out：

1. 保存正文、最终 URL、抓取时间、Content-Type、字节数和 SHA-256；记录重定向、WAF、登录、验证码和下载失败。
2. 递归展开研究生院索引、学院/研究院子页、报名系统、公众号正文、PDF、Office 附件、图片、内嵌预览和下载链接。对校级汇总或系统学院列表，展开计算机、软件、人工智能、网安、通信、自动化、控制、电子信息和集成电路等相关单位。
3. 从 PDF/Office 中提取文本；扫描件、公告图片和不可复制 PDF 需 OCR 或逐页可读检查。附件内的新官方链接继续入队。
4. 优先使用官方报名系统和当年学院通知/附件字段；冲突时保留两份私有证据并使用优先级更高的当年来源，不能判断就不公开该新增项。
5. 建立字段卡：所有报名动作和截止、活动时间/形式/地点、材料、推荐、住宿、餐食、交通、报销、资格限制和官方链接。未公布与未能读取必须分别标注，不能以聚合摘要补全。

官网受阻或身份无法确定只隔离相应候选，后续运行重试；它不会证明“没有项目”，也不会阻塞其他独立、已核验的新增项。

## 私有 v2 运行文件与确定覆盖

每次运行新建私有目录，并从公网下载父快照原始字节。保存父本的 SHA-256、`snapshotId` 和 `dataHash`，以及本轮 artifact。不得复用旧私有 candidate、工作簿或先前的父本下载。

批准器的输入是一个严格的私有 `additive-run.json`：

```json
{
  "schemaVersion": 2,
  "runId": "20260809-incremental-abc123",
  "mode": "incremental",
  "startedAt": "2026-08-09T01:00:00.000Z",
  "finishedAt": "2026-08-09T01:18:00.000Z",
  "parent": {
    "url": "https://ddl.meta-mind.cn/data/current.json",
    "sha256": "<raw-parent-bytes-sha256>",
    "snapshotId": "<parent-snapshot-id>",
    "dataHash": "<parent-data-hash>",
    "privateParentCandidateUsed": false
  },
  "coverage": {
    "schemaVersion": 1,
    "rotationDate": "2026-08-09",
    "registrySha256": "<raw-universities-json-sha256>",
    "sentinelsSha256": "<raw-priority-sentinels-json-sha256>"
  },
  "scopes": ["...private root and child discovery scopes..."],
  "artifacts": ["...private official artifact metadata..."],
  "additions": ["...opportunity plus evidence..."]
}
```

`coverage` 的两个原始文件哈希由批准器重新核对；`rotationDate` 必须等于 `finishedAt` 的北京时间日期。批准器每日派生全部重点哨兵与稳定七分之一的“注册表学校 + 父本额外机构”，`sweep` 派生整个并集；每一项均需一个 root scope。重合的哨兵 scope 可满足同校轮转，`blocked`（带原因）表示已尝试而非已读取，会进入私有 decision，但不会阻塞独立的已证实新增项。它证明这个 run 覆盖了当天确定的尝试范围，不能追溯证明调度器从未漏跑某天。

真实文件中的 `artifacts` 是 `{path,sha256,url,contentType,fetchedAt,extractedTextArtifactSha256}` 对象。`path` 必须是本轮目录内、无符号链接的相对普通文件；批准器会重读真实字节并复算 SHA-256。HTML/text artifact 的字段引文必须在 UTF-8 原文中实际出现且包含该字段的来源值；PDF 或 Office 原件需要通过同 URL、已复算哈希的 `text/plain` 提取 artifact 以 `extractedTextArtifactSha256` 显式绑定。ISO deadline 的日历日期必须与引文的 `deadlineOriginal` 一致，website 由规范化 exact source URL 绑定，verificationStatus 由项目原文与 deadline evidence 派生。每条 `additions` 同时携带公开 `opportunity` 和私有 `evidence`：学校名、`officialUrl`、primary artifact SHA-256，以及字段证据数组。字段证据必须记录来源 URL、artifact SHA-256、定位、提取方法、核验时间、原文和规范化字段值。批准器只接受机构/政府域名或固定官方平台，并要求 primary artifact 明确出现学校名；这是可信扫描器的可自动核验来源类别，而非 DNS 所有权证明。

下列公开字段全部需要同轮字段证据：`name`、`institute`、`project`、`eventType`、`website`、`verificationStatus`、`deadline`、`deadlineOriginal`、`eventArrangement.time`、`eventArrangement.formatLocation`、`materials`、`recommendation`、`logistics`。证据中的值必须与公开对象对应字段的 JSON 值完全一致；primary artifact、`officialUrl` 和一个 official discovery source 必须指向同一规范化官方 URL。

运行文件、artifact、字段卡、阻断原因和 `release-decision.json` 全部私有，永不提交。

## 追加批准

在网站工作树中执行：

```bash
pnpm run snapshot:approve-additive -- \
  --run /private/run/additive-run.json \
  --parent /private/run/public-parent.json \
  --approved data/approved/current.json \
  --decision /private/run/release-decision.json \
  --registry scripts/source/universities.json \
  --sentinels scripts/source/priority-sentinels.json
```

批准器会在写入前同时验证：

- `finishedAt` 不在未来且距批准不超过 24 小时；
- `--parent` 的原始字节 SHA-256 与运行文件相同，且 `--approved` 仍是同一份父快照；
- `coverage` 与传入的注册表、哨兵原始字节一致，且 root scope 覆盖了批准器从北京时间日期、父本和版本化配置重算出的当天范围；
- 父快照为 schema v2，结构、`snapshotId`、`dataHash` 和 canonical 完整性成立；
- 每条新增项在 `finishedAt` 时通过严格候选校验，且不与父本/同批 `projectId` 重复；
- 每条新增项具有完整的同轮官方字段证据，且 evidence 与公开字段、官方 URL、artifact 一一对应；
- 父项对象完整保留。批准器只重排展示顺序、追加新项、更新 counts 和生成新的快照元数据；不会改变任何父项字段或值。

新增项为零时，批准器只创建私有的 `release-decision.json`（`status: no-additions`）。非空追加先写 `status: eligible`，仅在公开原子写入完成后更新为 `status: ready`；若后续私有决定回写失败，保留 `eligible` 供对账，不能误报已提交。不得创建空提交、空 PR、CI 或部署。存在任何父本漂移、父项改写/减少、重复 ID、缺证、证据不一致、运行超时或文件类型不安全时，批准器失败关闭，`current.json` 不改变。

`snapshot:validate` 对已保存的父历史执行结构/完整性校验，不会按今日日期重新解释历史状态。新项仍按本轮结束时刻验证，避免把已经过期的项目作为“开放新增”发布。

## 提交、部署与复核

只有获得 `ready` 结果的实际新增才可产生公开 Git 变更。提交前至少运行：

```bash
pnpm run snapshot:validate
pnpm run check:public
pnpm run test:unit
pnpm run build
git diff --check
```

通过受保护 `main` 的既有 CI 路径发布。日常追加不再以人工 PR 审阅、pending CAS、删除授权、旧链路的全量 lifecycle coverage、8 表工作簿或公开快照 timestamp freshness 为前置条件；但本 run 的确定性哨兵/轮转 coverage 是批准硬门禁。部署 gate、SSH 前和 activation 前只复核不可变 `{releaseSha,snapshotId,dataHash,archiveSha}`；构建、部署、原子激活、回滚和公网 smoke 仍为硬门禁。

发布完成后独立读取 `/data/current.json` 和 `/data/release.json`，核对新 `snapshotId`、`dataHash`、新增项目和页面可见性。线上不匹配、CI 失败或 smoke 失败时保留/恢复上一版本；不得手工拼接服务器文件。

## 日常以外的维护

`scan:build-release`、`pending:commit` 和 `snapshot:approve` 是旧的 reducer/pending 路线，仅用于历史迁移或用户明确授权的修正、合并、身份迁移和删除维护。它们不是每日追加入口。

日常流程中遇到的删除线索、既有条目字段变化、疑似关闭、重复身份或公开隐私风险必须进入私有隔离/维护清单，保持父快照不变。任何真正的删除或父项修正都需单独任务和用户明确授权。

## 权限与隐私

可信更新执行器可以完成私有扫描、公开快照批准、受保护路径提交和 CI 状态读取，但不得将私有产物或凭据放入 Git。腾讯云部署 Secret 继续只存在于 `production` Environment，扫描证据与部署主机保持分离。

为无人值守，GitHub 的 `production-approval` 与 `production` Environment 应保留绑定和分支限制，但两个 Environment 的 `required_reviewers` 需要由仓库管理员一次性移除。这是外部 GitHub 配置，执行前应只读核验，不能因本文档而假定已经完成。不得把 Secrets 移至仓库级，也不得打印或记录其值。
