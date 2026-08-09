# 深研派 GitHub 通知合集：日常发现源设计

**日期：** 2026-08-09
**状态：** 已确认设计，待实现计划
**范围：** 日常追加发布路径、运行说明和 `scan-cs-admissions-events` skill；不改历史 replay 路径或公开快照 schema。

## 目标

把 [深研派 GitHub 主页](https://github.com/shenyanpai) 及其按年份组织的夏令营、预推免通知合集纳入每日固定发现面，减少宽发现漏项。当前年份的固定集合视图为：

- `https://github.com/shenyanpai/awesome-summer-camp-<YYYY>`
- `https://github.com/shenyanpai/awesome-pre-recommend-<YYYY>`

这里的 `<YYYY>` 由本轮 `finishedAt` 的北京时间日历年份导出；例如 2026-08-09 的两条固定视图分别是 `awesome-summer-camp-2026` 和 `awesome-pre-recommend-2026`。

深研派只提供发现线索。任何公开项目事实仍必须由同校、当年、可读的官方页面、报名系统、官方公众号或官方附件证明。它不改变“只追加、不改写父快照”、学院级 fan-out、字段证据和公开隐私边界。

## 非目标

- 不把 GitHub 或 `raw.githubusercontent.com` 加入官方来源、官方平台或公开证据白名单。
- 不把深研派 URL、抓取原文、artifact SHA 或私有检查结果写入公开 `current.json`、`release.json` 或公开 `discoverySources`。
- 不修改 `ScanBundle v2`、`scan-release-contract.ts`、`build-scan-release.ts`、`snapshot:approve` 或其他历史维护/replay 契约。
- 不把“固定来源已检查”表述为全国绝对无遗漏；它只证明本轮尝试了这一额外发现面。

## 设计

### 固定的三项私有检查

日常批准器接受的每个 `incremental` 或 `sweep` run 都必须带三项、且仅三项深研派检查：

| `checkId` | 必须匹配的规范化 URL | 作用 |
| --- | --- | --- |
| `shenyanpai-profile` | `https://github.com/shenyanpai` | 固定发现源身份锚点 |
| `shenyanpai-summer-camp` | `https://github.com/shenyanpai/awesome-summer-camp-<YYYY>` | 当年夏令营通知合集入口 |
| `shenyanpai-pre-recommend` | `https://github.com/shenyanpai/awesome-pre-recommend-<YYYY>` | 当年预推免通知合集入口 |

批准器从 `finishedAt` 的 Asia/Shanghai 日期派生 `<YYYY>`，不信任调用方自行填写的年份、仓库名、组织名、URL 前缀、查询参数或重定向后的替代地址。这样不会因“任意 GitHub 仓库”或错误年份而满足门禁。

扫描器访问三个入口后，继续按照现有宽发现和深提取规则读取合集中的相关页面、README/分类页与指向的官方链接。每一条发现到的官方入口仍建立学校 scope、学院/系统/附件 fan-out 和同校字段证据；固定 GitHub 检查本身不是学校 scope，也不替代任何 scope。

### 私有运行文件 v3

`AdditiveApprovalRun` 从私有 `schemaVersion: 2` 升为 `schemaVersion: 3`，顶层新增 `fixedDiscoveryChecks`。旧 v2 run 不再能走日常批准器，避免旧文件绕过新的每日检查；日常 run 最多只有 24 小时有效，重新执行扫描的迁移成本有限。

每项检查采用如下严格结构：

```json
{
  "checkId": "shenyanpai-summer-camp",
  "url": "https://github.com/shenyanpai/awesome-summer-camp-2026",
  "checkedAt": "2026-08-09T01:10:00.000Z",
  "result": "checked",
  "artifactSha256": "<sha256-of-private-html-artifact>",
  "reason": null
}
```

- `checked`：`artifactSha256` 必填，`reason` 必须为 `null`。它必须指向本 run 的普通、已读验证 artifact；artifact URL 与该固定 URL 规范化后完全一致，内容是可读 UTF-8 文本/HTML，且 bytes/SHA-256 已被批准器复算。每个状态为 `checked` 的项各自绑定不同的 artifact 条目和 SHA-256，符合现有 artifact manifest 的全局唯一 SHA 约束。
- `blocked`：`artifactSha256` 必须为 `null`，`reason` 必填，说明登录、验证码、网络、解析或页面不可读等具体原因。
- `checkedAt` 必须位于 `[startedAt, finishedAt]`。三个 `checkId` 不得重复、缺失或增加额外值。

错误 URL、错误组织/仓库、缺少检查、无 artifact 的 `checked`、artifact URL 不一致、超出运行窗口和不安全 artifact 都是结构性失败：不生成 private decision，不修改公开快照。页面读取受阻是正常的 `blocked`：它计为本轮已尝试，不阻塞由独立同校官方证据支持的新增项，也不把 `no-additions` 变成失败。

### 批准顺序

日常 `snapshot:approve-additive` 在读入 run 后按以下次序完成新增门禁：

1. 严格解析 v3 run 与三项 `fixedDiscoveryChecks`。
2. 验证现有 scope 图、artifact 元数据与决策文件路径边界。
3. 逐个安全打开并复算所有 artifact 原始 bytes/SHA-256。
4. 用已验证的 artifact material 断言三项深研派检查的 URL、时间、状态和 artifact 绑定。
5. 继续执行现有 run 新鲜度、父快照冻结、每日哨兵/轮转 coverage、追加性、学院级新增、官方字段证据及原子写入门禁。

第 4 步必须发生在 `no-additions` 私有 decision 和任何 `current.json` 写入之前。因此不能以“本轮没有新增”为由跳过固定发现源。

### 公私边界

深研派的 GitHub artifact 只服务 `fixedDiscoveryChecks`。它不能被 `addition.evidence.officialUrl`、primary artifact、字段证据 URL、`opportunity.website` 或 `kind: official` 的发现来源引用。批准器还必须在每个**新增项**上检查全部 `opportunity.discoverySources[].url`：`github.com` 与 `raw.githubusercontent.com` 均被拒绝，不因 `kind: other-discovery` 而例外。这个拒绝只作用于 additions，不重新审判、删除或改写历史父项。现有机构/政府域名与批准官方平台门禁继续拒绝 GitHub 作为公开事实来源；本次不扩展任何 host allowlist。

扫描器可以使用深研派页面中的链接找到官方页面，但只能在回源并完成学院级拆分后生成候选。例如，一条汇总校级通知仍须展开其中每个明确可投的学院/招生单位；未能证明具体单位时保留私有线索，不发布“全校招生”行。

### 文档与 skill 更新

实现同步修改以下持久控制面：

- 项目 `AGENTS.md`：将私有运行版本写为 v3，说明每日三项深研派检查和“线索而非事实”的硬边界。
- `docs/operations/data-refresh.md`：更新 v3 示例、检查结果语义、失败行为和批准器验收项。
- `README.md`：把深研派 GitHub 通知合集加入发现源说明，并保留官方回源要求。
- `scan-cs-admissions-events` 的 `SKILL.md`、`research-protocol.md`、`aggregator-protocol.md` 与 `coverage-run-contract.md`：从三家固定聚合发现源扩展为四家，并明确年度视图、私有 artifact、blocked 语义和学院级回源 fan-out。

`workbook-contract.md` 无需改动：它已要求官方链接不能由聚合链接替代。迁移时一并升级日常 `AdditiveApprovalRun` 的 producer、parser 和 `approve-additive-snapshot` fixtures 为 v3；历史 `ScanBundle v2`、`approveSnapshotFile`、`scan-release-contract.ts` 及其 replay fixtures 保持不动，以免改变可重放的维护输入。

## 测试与验收

在 `tests/approve-additive-snapshot.test.ts` 为现有合法 fixture 升级为 v3，并新增至少以下回归：

1. 三项 URL、时间和 SHA 绑定均正确的 run 可得出 `ready` 或 `no-additions`。
2. 缺少任一固定检查、重复检查或多出检查均在私有 decision/公开写入前失败。
3. 错误年份、错误 owner/repository/path、查询参数或 GitHub 变体 URL 失败。
4. `checked` 缺 artifact、artifact URL 不一致、artifact 非文本、检查时间越界或 SHA 不匹配失败。
5. 三项中的任一 `blocked`（带原因）不阻断另一个已由官方 evidence 支持的新增，也允许无新增的私有决定。
6. GitHub artifact 仍不能作为 `officialUrl`、primary artifact 或字段 evidence；即使公开项另有合法官方 source，`other-discovery` 也不能携带 `github.com` 或 `raw.githubusercontent.com` URL。这条新入口不放宽现有官方来源门禁。
7. 旧 ScanBundle/replay 测试保持不变并继续通过，证明 v3 只影响日常 additive 路径。
8. 已有追加性、父项不变、学院级粒度、决策路径隔离和证据完整性测试继续通过。

完成后运行相应批准器测试、完整类型检查、项目单元测试、公开边界检查和 skill 的 `quick_validate.py`。此次功能不应产生公开数据变更、部署或外部发布；后续真实扫描产生合格 additions 时才沿既有自动发布路径推进。

## 成功标准

- 每个日常 run 都可机器验证地记录指定深研派 profile 和当年两个通知合集视图的读取或受阻结果。
- 任意缺失/冒充/自报但不可验证的固定来源检查都会在公开写入前拒绝。
- GitHub 保持发现层身份，不能进入公开项目事实证据链。
- 历史 ScanBundle v2/replay 契约不受影响，日常私有 run 以 v3 清晰分流。
- 扫描 skill 和项目操作文档给出的生成契约与实际批准器完全一致。
