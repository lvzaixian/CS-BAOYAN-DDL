# 招生活动追加式数据刷新

## 目的

日常刷新只负责发现、核验并追加新的公开招生项目。公开快照以线上 `https://ddl.meta-mind.cn/data/current.json` 为唯一父本；一个更新的候选必须严格等于“父本 + 新增项”。本轮没有发现、某个官网受阻、附件解析失败、字段不完整或外部站点没有命中，都不能删除、改写或降级既有公开条目。

项目一经发布持续保留。页面根据保存的最早行动截止时间即时显示“已过期”；日常扫描不因已过截止而修改父项，也不把网站快照的时间戳年龄当作部署阻塞条件。

## 每日发现与深挖

日常 `incremental` 优先处理新鲜搜索/聚合线索、重点哨兵、最近新入口和私有重试队列；`sweep` 用注册表分片轮转，使学院、研究院和联合单位在一周内都获得一次轻量发现。保研通知网、CS-BAOYAN、BoardCaster 与深研派 GitHub 通知合集都只产生线索，不能成为公开事实来源。

对每个官方入口进行队列式 fan-out：

1. 保存正文、最终 URL、抓取时间、Content-Type、字节数和 SHA-256；记录重定向、WAF、登录、验证码和下载失败。
2. 递归展开研究生院索引、学院/研究院子页、报名系统、公众号正文、PDF、Office 附件、图片、内嵌预览和下载链接。对校级汇总或系统学院列表，展开计算机、软件、人工智能、网安、通信、自动化、控制、电子信息和集成电路等相关单位。
3. 从 PDF/Office 中提取文本；扫描件、公告图片和不可复制 PDF 需 OCR 或逐页可读检查。附件内的新官方链接继续入队。
4. 优先使用官方报名系统和当年学院通知/附件字段；冲突时保留两份私有证据并使用优先级更高的当年来源，不能判断就不公开该新增项。
5. 建立字段卡：所有报名动作和截止、活动时间/形式/地点、材料、推荐、住宿、餐食、交通、报销、资格限制和官方链接。未公布与未能读取必须分别标注，不能以聚合摘要补全。

### 学院级公开条目契约

当前 `snapshot:approve-additive` 已在产生 release decision 或写入公开快照前，对本轮 `additions` 实施学院级的有限机器门禁；它不重新判定历史父项或历史 replay。每条新增 `projectId` 必须恰有四个非空段 `招生周期|name|institute|项目/轮次`，其中 `name` 与 `institute` 段必须分别逐字匹配公开对象的同名字段。每条未来新增项的 `name` 填学校或独立办学机构，`institute` 填一个学院、系、研究院、国际学院、联合培养单位或其他官方招生单位的完整官方名称。

门禁拒绝含 Unicode `Cf` 格式控制字符的 `institute`。对明确学校范围/系统标签的拒绝比较使用一个检查副本：NFKD 后删除 Unicode `White_Space`、`Punctuation`、`Symbol` 与 `Mark`，再转小写。该 skeleton 含 `wholeschool`（包括 `whole-school` 的符号变体）、全校、全院系、各学院/各院系、校级（包括学校级）、招生系统/报名系统/系统级，以及研究生招生办公室、研究生招生办、研究生招生处、研招办、研招处、招生办公室、招生办或招生处时会失败关闭；其恰为研究生院，或恰为 `${skeleton(name)}研究生院` 时也会失败关闭。名称含额外单位限定词的研究生院候选（例如 `新增测试大学深圳国际研究生院`）不会因该未限定研究生院规则被拒绝，但仍必须有完整官方证据和最小适用单位依据。检查副本不会重写公开 `name`、`institute` 或任何字段证据；通过后，公开字段与同轮字段证据仍须逐项精确一致。

`whole-school`、全校、全院系、各学院/各院系、校级/学校级、招生系统/报名系统/系统级、研究生招生办公室、研究生招生办、研究生招生处、研招办、研招处、招生办公室、招生办、招生处以及未限定的校级研究生院等校级通知、系统容器或标签仅可作为发现/证据入口，不能成为公开行。该明确标签/身份门禁并不能从不透明官方来源推断未披露的可投单位，也不能证明某次 fan-out 已完整；若官方通知、PDF 或系统明确列出范围内可投单位，扫描器仍必须递归展开，每个单位以同轮官方证据支持资格，并形成一条独立去重的公开行。不得臆造或复制名单；当官方证据证明多个学院/单位名称变体确为同一招生单位时，`institute` / `projectId` 必须规范为当年可读且最具体官方报名来源中的单位名称，不得臆造别名。单位范围未解或官方名称变体的同一性不能证明时，一律留在私有重试/身份隔离队列，不发布泛校级行或重复行。

学院、系、研究院、国际学院、联合培养单位或其他官方招生单位等所有候选 `institute` 类型，只有在自身是官方明确列出的最小适用招生单位且未列出更下级可申请单位时才可使用；独立研究生院或独立研究院同样适用这一统一条件。

如有同招生周期、同学校的历史通用父项，它不替代学院级身份；有具体官方证据的单位级新增项可以追加，并与不可变的历史通用父项共存。日常工作不得隐藏、删除或降级父项；移除、拆分或纠正历史通用行必须作为经用户明确授权的维护迁移，不得在每日追加中清理。

官网受阻或身份无法确定的线索只能在构造 `additions` 前隔离并留待后续运行重试；它不会证明“没有项目”，也不会阻塞其他独立、已核验的新增项。若任一无效 addition 已被提供给批准器，批准器必须失败关闭，不写私有 `release-decision.json`，也不改写公开快照；不得在批准器内丢弃该项后继续批准其余 additions。

## 私有 v3 运行文件与确定覆盖

每次日常运行新建私有目录，并从公网下载父快照原始字节。保存父本的 SHA-256、`snapshotId` 和 `dataHash`，以及本轮 artifact。不得复用旧私有 candidate、工作簿或先前的父本下载。日常追加只接受 v3 运行文件；旧私有 v2 输入只保留给历史 `ScanBundle`/replay 或经明确授权的维护链路，不能进入日常批准器。

批准器的输入是一个严格的私有 `additive-run.json`：

```json
{
  "schemaVersion": 3,
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
  "fixedDiscoveryChecks": [
    {
      "checkId": "shenyanpai-profile",
      "url": "https://github.com/shenyanpai",
      "checkedAt": "2026-08-09T01:10:00.000Z",
      "result": "checked",
      "artifactSha256": "<private-text-or-html-artifact-sha256>",
      "reason": null
    },
    {
      "checkId": "shenyanpai-summer-camp",
      "url": "https://github.com/shenyanpai/awesome-summer-camp-2026",
      "checkedAt": "2026-08-09T01:11:00.000Z",
      "result": "checked",
      "artifactSha256": "<private-text-or-html-artifact-sha256>",
      "reason": null
    },
    {
      "checkId": "shenyanpai-pre-recommend",
      "url": "https://github.com/shenyanpai/awesome-pre-recommend-2026",
      "checkedAt": "2026-08-09T01:12:00.000Z",
      "result": "blocked",
      "artifactSha256": null,
      "reason": "network timeout while reading the fixed discovery source"
    }
  ],
  "scopes": ["...private root and child discovery scopes..."],
  "artifacts": ["...private official artifact metadata..."],
  "additions": ["...opportunity plus evidence..."]
}
```

`coverage` 的两个原始文件哈希由批准器重新核对；`rotationDate` 必须等于 `finishedAt` 的北京时间日期。批准器每日派生全部重点哨兵与稳定七分之一的“注册表学校 + 父本额外机构”，`sweep` 派生整个并集；每一项均需一个 root scope。重合的哨兵 scope 可满足同校轮转，`blocked`（带原因）表示已尝试而非已读取，会进入私有 decision，但不会阻塞独立的已证实新增项。它证明这个 run 覆盖了当天确定的尝试范围，不能追溯证明调度器从未漏跑某天。

`fixedDiscoveryChecks` 与学校 scope 独立，日常 run 必须且只能有三项：`shenyanpai-profile` 的 `https://github.com/shenyanpai`、`shenyanpai-summer-camp` 的 `https://github.com/shenyanpai/awesome-summer-camp-<YYYY>`，以及 `shenyanpai-pre-recommend` 的 `https://github.com/shenyanpai/awesome-pre-recommend-<YYYY>`。`<YYYY>` 只由 `finishedAt` 的 Asia/Shanghai 年份派生。每项严格包含 `checkId`、`url`、`checkedAt`、`result`、`artifactSha256` 和 `reason`；ID 不得缺失、重复或扩展，`checkedAt` 必须位于 `[startedAt, finishedAt]`。

`checked` 需要同一规范化 URL 的本轮私有、已逐字节复算 SHA-256 的非空可读 UTF-8 text/HTML artifact，且 `reason` 必须为 `null`；各个 `checked` 项不可复用 artifact SHA。`blocked` 必须没有 artifact（`artifactSha256: null`）并留有非空具体原因。`blocked` 计为该固定入口已尝试，不会阻断由独立同校官方证据支持的 additions，也允许全 `blocked` 的零新增 run 产生私有 `no-additions` 决定。缺项、伪造 ID/URL、越界时间、错误 artifact 绑定或不合规的 artifact/reason 组合则是结构性失败。

真实文件中的 `artifacts` 是 `{path,sha256,url,contentType,fetchedAt,extractedTextArtifactSha256}` 对象。`path` 必须是本轮目录内、无符号链接的相对普通文件；批准器会重读真实字节并复算 SHA-256。HTML/text artifact 的字段引文必须在 UTF-8 原文中实际出现且包含该字段的来源值；PDF 或 Office 原件需要通过同 URL、已复算哈希的 `text/plain` 提取 artifact 以 `extractedTextArtifactSha256` 显式绑定。ISO deadline 的日历日期必须与引文的 `deadlineOriginal` 一致，website 由规范化 exact source URL 绑定，verificationStatus 由项目原文与 deadline evidence 派生。每条 `additions` 同时携带公开 `opportunity` 和私有 `evidence`：学校名、`officialUrl`、primary artifact SHA-256，以及字段证据数组。字段证据必须记录来源 URL、artifact SHA-256、定位、提取方法、核验时间、原文和规范化字段值。批准器只接受机构/政府域名或固定官方平台，并要求 primary artifact 明确出现学校名；这是可信扫描器的可自动核验来源类别，而非 DNS 所有权证明。

下列公开字段全部需要同轮字段证据：`name`、`institute`、`project`、`eventType`、`website`、`verificationStatus`、`deadline`、`deadlineOriginal`、`eventArrangement.time`、`eventArrangement.formatLocation`、`materials`、`recommendation`、`logistics`。证据中的值必须与公开对象对应字段的 JSON 值完全一致；primary artifact、`officialUrl` 和一个 official discovery source 必须指向同一规范化官方 URL。

运行文件、artifact、字段卡、阻断原因和 `release-decision.json` 全部私有，永不提交。深研派的 GitHub / `raw.githubusercontent.com` artifact 只可服务上述固定发现检查；它不能充当 `officialUrl`、primary artifact 或字段证据。批准器对每个新增项的完整公开 `opportunity` 序列化值做私有来源泄漏检查：GitHub/raw URL 以及可识别固定检查的 provenance（其 URL、artifact SHA、artifact text、`checkId` 或 `blocked` 的具体原因）均不得出现在任何公开字段中。这包括全部 `discoverySources` 变体（含 `other-discovery`），而不只检查官方 source；普通孤立的 `checked`/`blocked` 文本不是固定检查 provenance，固定检查记录本身不会写入公开快照。该门禁只检查 additions，不重新判定不可变的父项。

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

- 已逐字节验证所有本轮 artifact 后，三项 `fixedDiscoveryChecks` 均已存在且有效；此检查发生在任何 `no-additions` 私有 decision 或公开写入之前；
- `finishedAt` 不在未来且距批准不超过 24 小时；
- `--parent` 的原始字节 SHA-256 与运行文件相同，且 `--approved` 仍是同一份父快照；
- `coverage` 与传入的注册表、哨兵原始字节一致，且 root scope 覆盖了批准器从北京时间日期、父本和版本化配置重算出的当天范围；
- 父快照为 schema v2，结构、`snapshotId`、`dataHash` 和 canonical 完整性成立；
- 每条新增项在 `finishedAt` 时通过严格候选校验，且不与父本/同批 `projectId` 重复；
- 每条新增项在 release decision/公开写入前通过 additions-only 的四段 `projectId`、`name`/`institute` 精确对应、Unicode `Cf`、检查副本 skeleton 的明确学校范围/系统/办公室标签（包括两种全称和六种短别名）及未限定研究生院门禁；该检查不重写字段证据，也不适用于历史父项或 replay；
- 每条新增项具有完整的同轮官方字段证据，且 evidence 与公开字段、官方 URL、artifact 一一对应；
- 父项对象完整保留。批准器只重排展示顺序、追加新项、更新 counts 和生成新的快照元数据；不会改变任何父项字段或值。

新增项为零时，只有通过全部固定检查和其它日常门禁后，批准器才创建私有的 `release-decision.json`（`status: no-additions`）。非空追加先写 `status: eligible`，仅在公开原子写入完成后更新为 `status: ready`；若后续私有决定回写失败，保留 `eligible` 供对账，不能误报已提交。不得创建空提交、空 PR、CI 或部署。候选构造期间可将一条证据不足、冲突或身份不明的线索隔离，使其不进入 `additions`；但只要向批准器提供的任一 addition 无效，批准器就失败关闭，不写任何 `release-decision.json`，也不改写 `current.json`。父本漂移、父项改写/减少、重复 ID、缺证、证据不一致、固定检查不合规、运行超时或文件类型不安全也同样失败关闭。

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

`scan:build-release`、`pending:commit` 和 `snapshot:approve` 是旧的 reducer/pending 路线；历史 `ScanBundle v2` 与 replay 输入也仅保留在这些历史迁移或用户明确授权的修正、合并、身份迁移和删除维护范围。它们不是每日追加入口，不能替代 v3 `snapshot:approve-additive`。

日常流程中遇到的删除线索、既有条目字段变化、疑似关闭、重复身份或公开隐私风险必须进入私有隔离/维护清单，保持父快照不变。任何真正的删除或父项修正都需单独任务和用户明确授权。

## 权限与隐私

可信更新执行器可以完成私有扫描、公开快照批准、受保护路径提交和 CI 状态读取，但不得将私有产物或凭据放入 Git。腾讯云部署 Secret 继续只存在于 `production` Environment，扫描证据与部署主机保持分离。

为无人值守，GitHub 的 `production-approval` 与 `production` Environment 应保留绑定和分支限制，但两个 Environment 的 `required_reviewers` 需要由仓库管理员一次性移除。这是外部 GitHub 配置，执行前应只读核验，不能因本文档而假定已经完成。不得把 Secrets 移至仓库级，也不得打印或记录其值。
