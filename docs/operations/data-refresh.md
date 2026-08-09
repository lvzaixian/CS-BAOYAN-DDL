# 招生活动数据追加式刷新手册

## 运行目标

本网站是信息聚合服务。日常更新的唯一业务动作是：从本轮可读官方来源中发现项目，并把此前未公开的项目追加到 `data/approved/current.json`。它不是历史项目重审、删除、字段纠错或逐项人工审核流程。

公开数据的两个不变量：

1. 新快照必须包含父快照的全部项目记录，且既有记录的项目字段不变；相对父快照只能新增项目。
2. 已有项目是否显示为已过期由保存的最早动作截止和当前时间自动计算。扫描不删除、移动或重写旧项目来实现过期。

修正、合并、撤销、字段补录或身份迁移必须作为用户明确授权的独立维护任务；不能混入日常新增发布。

## 来源和公开边界

`data/approved/current.json` 是唯一可部署数据。私有扫描目录可以保存本轮原始 HTML/PDF/Office 文件、OCR、访问错误、重试队列和字段卡；它们、已投信息、个人状态、本机路径和凭据不得进入候选或 Git 提交。

学校研究生院、学院、研究院、官方报名系统、官方公众号及官方附件才可确认项目事实。CS-BAOYAN DDL、保研通知网和 BoardCaster 只提供线索；它们不能独立确认项目状态、截止、材料、活动安排或福利。

每轮先下载线上 `https://ddl.meta-mind.cn/data/current.json` 原始字节并记录 `snapshotId`、`dataHash`、SHA-256。候选只能以此父快照加本轮新增项构建，不能以任何旧私有 candidate、工作簿或 scan bundle 为项目输入。

## 增量发现调度

| 队列 | 频率 | 工作内容 | 不能推出的结论 |
| --- | --- | --- | --- |
| 新鲜线索 | 每日 | 聚合站、官方首页/通知页、公开检索和近期官方更新 | 无新线索不代表无项目 |
| 重点院校 | 每日 | 重点哨兵的研究生院、学院索引、报名系统入口 | 某入口受阻不代表项目不存在 |
| 注册表轮转 | 7 天内完成一轮 | 每所注册机构的当年新增通知发现 | 不是旧项目的生命周期审计 |
| 学院/系统扩展 | 发现父索引时立即 | 展开计算机、软件、AI、网安、通信、自动化、控制、电子信息、集成电路等子页 | 父索引本身不是完整项目证据 |

当前页面中的旧项目、临近截止项目或未知截止项目不需要在每轮重新扫描；它们由父快照保留和自动过期逻辑处理。阻断入口写入私有重试队列，并不会阻止其它学校的经核验新增项发布。

## 深度提取协议

对每个官方候选 URL 用去重队列做递归遍历：

1. 保存页面/文件原始字节、最终 URL、时间、Content-Type、大小、SHA-256 和读取错误。
2. 发现并读取 HTML 链接、报名系统、学院子通知、PDF、Word、Excel、图片和内嵌预览。必须识别 `pdfsrc`、`showVsbpdfIframe`、`wp_pdf_player`、`__local/*.pdf`、`_upload/article/files`、`download.jsp` 等附件入口。
3. PDF 提取页数和文本；扫描 PDF 和公告图片做 OCR 或逐页可读检查。附件继续引用的系统、学院页和附件继续入队，直到去重队列耗尽或达到预先记录的安全深度限制。
4. 以官方报名系统字段、当年学院通知及其附件、校级通知及其附件的顺序解决字段优先级。冲突且无法按此优先级判定时，不发布该新增项。
5. 结构化抽取所有可获取字段：项目/学院、报名状态、`deadlines[]`、最早 `deadline`、报名入口和动作、活动时间、形式/地点原文、材料、推荐信与模板、系统/邮件双轨、住宿、餐食、交通、报销和资格要求。

字段没有公布时写“官方未公布”；文件无法读取时写“未能读取”，并保留重试任务。不得用搜索摘要、聚合字段或校园地点推断截止、活动形式、住宿或报销。

## 新增判定与候选构建

每条新增项至少应包含稳定 `projectId`、招生周期、学校/机构、项目/学院、官方 URL、当前状态和本轮同校官方证据。使用规范化身份和官方 URL 对父快照去重：

- 与父项目命中：不修改、不追加；任何更全字段记入后续维护候选，不在日常发布混入更新。
- 与另一条本轮发现冲突：合并证据后只保留一个稳定新增项；无法确认是否同一项目时不发布该项。
- 证据不足、页面被阻断或官方字段矛盾：移入私有重试队列；不得用聚合页补成公开项目。

候选等式为：`candidate = parent + validatedAdditions`。发布前的追加性校验必须确认项目集合没有 `removed` 或 `changed`，且所有父项目字段未变化。空 addition 只生成私有运行摘要，不创建空 commit/PR/部署。

## 单一路径发布

日常发布保留一组有价值的自动检查，而不是多层人工审批：

```text
official evidence + duplicate/additive validation
  -> atomic approved snapshot replacement
  -> commit/merge to protected main by trusted updater
  -> CI: schema/public-boundary/unit/build checks
  -> deployment: freshness + artifact integrity + Tencent activation
  -> public smoke: /data/current.json, /data/release.json, page visibility
```

新增更新的 release gate 只应验证：

- 父快照、私有证据和新增候选的本轮关联；
- 每条新增项的官方来源、稳定身份、schema 与去重；
- 严格追加差异；
- 公开隐私边界、快照完整性、构建与部署/公网 smoke。

以下内容不是日常新增发布门禁：全注册表本轮 100% 可读、无关入口 WAF、pending ledger CAS、删除授权、lifecycle 守恒证明、8 表 XLSX、delivery provenance、整目录哈希清单、人工 PR 审阅和人工 Environment reviewer。它们可保留为诊断或历史迁移工具。

## 权限和审批配置目标

一名可信更新执行器可同时进行私有扫描、批准公开追加快照、推送/合入 `main` 和触发/观察部署，从而消除扫描—审批—发布的人为交接。它不得提交私有证据或凭据。

`production-approval` 与 `production` Environment 保留为自动检查和 Secrets 作用域，但不配置 required reviewer。保留受保护 `main` 的自动 CI、部署 artifact 校验、24 小时 freshness、原子激活和公网 smoke。该项是一次性 GitHub 设置与 workflow 迁移目标；本文不表示当前外部 Environment 已被修改。

人工只处理独立维护迁移、实际隐私/安全事件或基础设施故障；正常新增项没有人工审批步骤。

## 本地与线上验证

数据变更前，执行与新增数据相关的最小检查：

```bash
pnpm run snapshot:validate
pnpm run check:public
pnpm run test:unit
pnpm run build
git diff --check
```

UI 代码也发生变化时，额外运行：

```bash
pnpm run check
pnpm run test:e2e
```

发布完成后下载 `/data/current.json` 与 `/data/release.json`，核对 `snapshotId`、`dataHash`、新增数量/ID 及新增项目在列表和详情中的可见性。部署/公网验证失败时保持或恢复上一版，不通过手工覆盖服务器文件修复。

## 迁移状态与失败语义

本仓库现有的 `scan:build-release`、`pending:commit`、`snapshot:approve` 仍要求旧的 pending/lifecycle/replay 结构；现有 GitHub workflow 也可能仍受 Environment reviewer 阻塞。因此它们不能被当作本手册所描述的追加式自动批准器。后续代码任务应实现“父快照 + additions”的单一批准命令，并把 Environment 改为无人工 reviewer 后做一次无数据变更的连通性演练。

- 某项新增失败：隔离该项、记录原因并继续处理其它新增项。
- 某院校/附件受阻：写入重试队列，不能使用聚合站伪造事实，也不能删除父项目。
- 追加性校验失败：拒绝整个 candidate，确保未覆盖任何父记录。
- 构建、激活或公网 smoke 失败：保持/回滚上一版，保存诊断后重试。
