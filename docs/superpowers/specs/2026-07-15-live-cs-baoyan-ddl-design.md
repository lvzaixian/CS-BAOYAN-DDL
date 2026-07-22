# 及时更新的 CS 保研 DDL 设计

## 1. 目标

在保留上游 CS-BAOYAN-DDL 主要视觉、列表、日历、筛选、搜索、倒计时、键盘操作和移动端体验的前提下，将数据来源替换为可追溯、官网核验优先、可版本化发布的更新流水线。

项目公开仓库为 `lvzaixian/CS-BAOYAN-DDL`，本地目录为 `/Users/maxwellbrooks/Workspace/CS-BAOYAN-DDL`。仓库继续保留与 `CS-BAOYAN/CS-BAOYAN-DDL` 的 fork 关系和 MIT 许可证。

## 2. 成功标准

1. 公开主列表仅包含已经过官网、官方报名系统、官方公众号或官方附件核验的项目。
2. 保研通知网、CS-BAOYAN DDL、BoardCaster 只作为发现源，不直接决定截止时间、资格、推荐信或食宿交通事实。
3. 项目按最早可执行报名截止时间升序排列；未知截止单独置后；过期项目退出进行中列表。
4. 每条记录具有稳定 `projectId`、官方链接、截止原文、规范化截止时间、最后核验时间和发现来源。
5. 每次发布具有快照 ID、内容哈希、前一快照 ID、计数摘要和可回滚版本。
6. 数据验证、Svelte 类型检查和生产构建全部通过后才允许部署。
7. 扫描、验证或部署失败时，线上继续服务上一份已批准快照。
8. 招生周期由批准快照提供，禁止在 UI 中硬编码当前周期；新周期进入快照后必须可见。
9. 桌面和移动端核心交互与上游保持一致，不引入账号、评论、数据库或在线编辑后台。

## 3. 产品边界

### 3.1 v1 包含

- 夏令营、开放日、学术活动日、推免预报名、提前面试和明确面向 2027 届的相关活动。
- 计算机、软件、人工智能、网络空间安全，以及明确相邻的信息通信、自动化、控制和电子信息项目。
- 进行中、未知截止和已过期三类信息视图。
- 官网链接、发现来源、截止时间、核验时间、食宿交通、推荐信和材料复杂度。
- Git 版本化数据、确定性导入器、差异报告、批准快照和腾讯云静态部署。

### 3.2 v1 不包含

- 用户账号、评论、公开投稿、在线管理后台、数据库、开放 API 和移动 App。
- Max 的已投项目、申请状态、个人排名、联系方式、本地证据路径和目标目录信息。
- Agent 无人审核直接发布生产。
- 全文镜像院校通知、附件或第三方聚合站内容。

## 4. 上游复用策略

### 4.1 保留

- Svelte 5、Vite 6、Tailwind CSS 4 和 TypeScript 技术栈。
- `Header`、`Toolbar`、`FilterPanel`、`ListView`、`CalendarView`、`SchoolRow`、`DetailPanel` 和键盘交互。
- 亮色/深色主题、URL 筛选状态、学校档次和省份筛选。
- 纯静态构建，不在浏览器运行数据写接口。

### 4.2 替换

- 删除将上游 BoardCaster `data.json` 整体覆盖到 `src/data/schools.json` 的自动工作流。
- 当前周期和周期目录改为读取 `data/approved/current.json`。
- 旧年度只读数据保留为 `src/data/legacy-schools.json`，不再被自动覆盖。
- 行选择键由 `学校::学院` 改为稳定 `projectId`，避免同校同学院不同轮次冲突。
- `Date.parse()` 不再负责解释日期级截止；发布器必须生成带 `+08:00` 的规范化时间和 `deadlineEpochMs`。
- 删除上游 `public/CNAME`，避免 fork 误绑定 `ddl.csbaoyan.top`。

## 5. 系统架构

```text
保研通知网 / BoardCaster / CS-BAOYAN DDL / 官网主动扫描
                         |
                         | 仅发现
                         v
scan-cs-admissions-events Skill
                         |
                         | workbook_data_*.json
                         v
scripts/import-scouting-data.ts
                         |
                         | 规范化、去重、官方证据门禁、公开白名单投影
                         v
data/staging/candidate.json + data/staging/diff.json
                         |
                         | 人工批准
                         v
data/approved/current.json
                         |
                         | test + check + build
                         v
Svelte/Vite dist/
                         |
                         | GitHub Actions over SSH
                         v
腾讯云 /srv/cs-baoyan-ddl/releases/${GIT_SHA}
                         |
                         | 原子切换 current 软链接
                         v
Nginx 只读静态站
```

## 6. 数据契约

### 6.1 快照

公开快照采用 `schemaVersion: 1`：

```ts
interface PublicSnapshot {
  schemaVersion: 1;
  snapshotId: string;
  scanAt: string;
  approvedAt: string;
  previousSnapshotId: string | null;
  dataHash: string;
  defaultFeedId: string;
  feeds: FeedDescriptor[];
  counts: {
    confirmedOpen: number;
    confirmedUnknownDeadline: number;
    pendingExcluded: number;
    expired: number;
  };
  opportunities: PublicOpportunity[];
}
```

staging 候选只包含 `schemaVersion`、`scanAt`、`defaultFeedId`、`feeds`、`counts` 和 `opportunities`；它没有批准元数据。批准命令独占 `snapshotId`、`approvedAt`、`previousSnapshotId` 和 `dataHash` 的生成权，避免 importer 伪造批准状态。

`dataHash` 对规范化的 `{ schemaVersion, scanAt, defaultFeedId, feeds, counts, opportunities }` 计算 SHA-256。发布器和 CI 不得接受哈希不匹配的快照。

### 6.2 项目

```ts
interface PublicOpportunity {
  projectId: string;
  feedId: string;
  name: string;
  institute: string;
  project: string;
  eventType: string;
  description: string;
  verificationStatus:
    | 'confirmed-open'
    | 'confirmed-unknown-deadline'
    | 'expired';
  deadline: string | null;
  deadlineOriginal: string;
  deadlineEpochMs: number | null;
  website: string;
  tags: string[];
  province?: string;
  verifiedAt: string;
  discoverySources: PublicSourceLink[];
  logistics: FieldFactGroup;
  recommendation: FieldFactGroup;
  materials: FieldFactGroup;
}
```

周期目录由快照提供：

```ts
interface FeedDescriptor {
  id: string;
  label: string;
  admissionCycle: string;
  eventYear: number;
}
```

验证器必须确认 `defaultFeedId` 存在于 `feeds`，每个项目的 `feedId` 都能在 `feeds` 中找到，且不允许 UI 维护第二份硬编码周期表。

当前扫描输出混合夏令营、开放日和预推免，feed 标签使用 `推免活动 <入学年份>`，不把所有记录错误标成夏令营。

### 6.3 字段事实状态

食宿、交通、推荐信和材料信息不得继承项目整体核验状态。每组信息具有独立状态：

```ts
interface FieldFactGroup {
  status: 'confirmed' | 'not-published' | 'unverified' | 'not-applicable';
  summary: string;
}
```

`unverified` 和 `not-published` 状态只允许固定公开摘要，如“待官方公布”或“未公布”；不得把未经核实的原始文本复制到公开快照。

### 6.4 公开来源

```ts
interface PublicSourceLink {
  kind: 'official' | 'baoyan-notice' | 'cs-baoyan' | 'other-discovery';
  label: string;
  url: string;
}
```

主表必须至少有一个 `kind: 'official'` 的来源。聚合链接只作为补充入口。

## 7. 导入与批准

1. 导入器读取 `workbook_data_*.json`，不直接读取 Excel。
2. `mainRows` 转为 `confirmed-open` 或 `confirmed-unknown-deadline`。
3. `pendingRows` 不进入公开项目数组，只计入 `pendingExcluded`；行级待核证据只保留在原始私有 Skill 输出中，不复制到仓库 candidate 或 diff。
4. `expiredRows` 进入已过期视图。
5. 导入器拒绝聚合站作为 `officialUrl`、重复 `projectId`、无效时间、已过期主表项和缺失官方来源。
6. 在首次导入前，`data/staging/*.json` 已加入 `.gitignore`，CI 同时拒绝任何被强制跟踪的 staging JSON。
7. 稳定 ID 先按规范化官网 URL 复用已批准记录，再查显式 URL-to-ID alias；新记录才采用扫描 ID。名称修订不改变已批准 ID，官网 URL 迁移必须人工登记 alias。
8. 导入完成只写 `data/staging/`，并生成新增、修改、过期和删除候选差异。
9. 批准命令读取实际 current，生成批准时间、前一快照 ID、内容哈希和快照 ID，再原子写入 `data/approved/current.json`。
10. Git 提交和 PR 合并构成人工批准记录；CI 只部署 `data/approved/current.json`。

## 8. 页面行为

### 8.1 默认体验

- 默认数据源由快照 `defaultFeedId` 决定，周期下拉来自 `feeds`。
- 进行中项目按截止升序，24 小时内使用红色紧迫度，7 天内使用琥珀色。
- 未公布截止项目置于进行中之后。
- 已过期项目折叠在页面末尾。
- 新周期只要进入已批准快照就会自动出现在周期下拉，不需要修改 TypeScript 联合类型。

### 8.2 详情面板新增内容

- 项目完整名称和活动类型。
- 截止原文、规范化时间和最后核验时间。
- 食宿交通、推荐信和材料复杂度。
- 官方通知按钮以及聚合发现链接。
- 信息状态说明，不使用“保证准确”或“保证不漏”措辞。

### 8.3 保持不变

- 视觉结构、颜色系统、卡片密度、列表和日历切换。
- 搜索、学校档次、省份和状态筛选。
- `/`、`j/k`、方向键、Enter、Esc 和 `?` 快捷键。

## 9. GitHub 与分支策略

- `origin`: `git@github.com:lvzaixian/CS-BAOYAN-DDL.git`
- `upstream`: `https://github.com/CS-BAOYAN/CS-BAOYAN-DDL.git`
- `upstream` push URL 禁用，避免误推原仓库。
- 功能分支使用 `codex/` 前缀。
- `main` 只接收通过 CI 的批准快照和代码。
- 上游 UI 更新通过人工 `git fetch upstream` 和选择性 cherry-pick/merge，不自动覆盖本地数据契约和工作流。

## 10. 腾讯云发布

v1 使用现有腾讯云服务器的 Nginx 静态托管：

- 根目录：`/srv/cs-baoyan-ddl`
- 版本目录：`/srv/cs-baoyan-ddl/releases/${GIT_SHA}`
- 当前版本：`/srv/cs-baoyan-ddl/current`
- Nginx `root`: `/srv/cs-baoyan-ddl/current`

GitHub Actions 只持有部署专用 SSH 密钥，使用 `TENCENT_HOST`、`TENCENT_PORT`、`TENCENT_USER`、`TENCENT_SSH_KEY` 和固定主机指纹 `TENCENT_KNOWN_HOSTS` 五个 secrets；公开站点地址 `PUBLIC_BASE_URL` 使用普通 environment variable。部署用户只能写上述发布目录，不持有扫描器、个人资料或腾讯云主账号凭据。

发布步骤为：构建、上传新版本目录、临时本地 HTTP 检查、原子切换软链接、外部健康检查。补偿步骤使用 `always()` 语义，即使切换步骤在改完软链接后报错也会检查真实 `current`。后续版本失败时恢复前一软链接；首次发布没有 previous 时删除失败的 `current` 链接，不能继续指向未通过外部检查的 release。

## 11. 测试与验证

### 11.1 自动检查

- Node 内置测试运行数据契约、截止解析、排序、去重、导入和差异测试。
- `svelte-check` 验证类型和组件。
- `vite build` 验证生产构建。
- CI 检查仓库中不存在上游域名 CNAME、私有路径和已投状态字段。
- CI 安装 Chromium 并运行 Playwright；腾讯部署只接受包含 E2E 的完整 CI job 成功结果。

### 11.2 页面检查

- Playwright 验证桌面和 390px 移动宽度。
- 验证列表非空、截止排序、详情面板、官网链接、日历切换和筛选。
- 验证动态周期、最长学校/学院名称不溢出，按钮和正文不重叠。

### 11.3 发布检查

- 部署前后记录 commit、snapshot ID、data hash 和 HTTP 状态。
- 检查首页、静态资源、当前快照标识和 TLS。
- 第二个验证版本上线后演练一次恢复到上一 release，再恢复新版；首次发布不存在 previous，不做伪回滚。

## 12. 上线顺序

1. 冻结数据契约、测试夹具和验证器。
2. 实现 Skill 输出导入、差异和批准命令。
3. 将当前 UI 切换到批准快照并改用稳定项目 ID。
4. 扩充详情面板和状态分组。
5. 增加 CI 和安全扫描。
6. 配置腾讯云静态目录、Nginx 和 GitHub Secrets。
7. 完成桌面、移动端、截止边界和回滚验收。
8. 发布第一份已批准快照。

## 13. 已知风险

- 当前 `scan-cs-admissions-events` 输出仍由日期化组装脚本生成，网站适配器必须防止字段漂移。
- 上游数据已出现 `camp2027` 但 UI 未暴露的漂移；动态周期目录和跨契约测试必须阻止此问题复发。
- `targets/index.md` 与某次 `submitted_project_ids` 存在项目身份漂移；公开站因此不读取或发布个人已投清单。
- 官方页面可能被 WAF、登录或公众号限制；此类项目只能进入私有 staging 的待核状态，不进入公开快照。
- 上游仓库中的校徽和第三方 Logo 许可未逐一确认；v1 可保留文字首字母回退，并逐步移除不明确素材。
- 腾讯云真实实例、域名、备案、Nginx 和证书状态尚未只读核验，部署任务必须在写生产配置前再次确认。
