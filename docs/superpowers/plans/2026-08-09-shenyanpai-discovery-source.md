# 深研派 GitHub 通知合集日常发现源 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将深研派 GitHub 主页和当年夏令营/预推免合集变成日常追加批准器可验证的私有发现检查，同时保证 GitHub 永远不能成为公开项目事实来源。

**Architecture:** 把日常 `AdditiveApprovalRun` 升为严格的 v3，并在现有 artifact 逐字节验证之后、`no-additions` decision 之前校验三项固定深研派检查。检查只绑定私有 GitHub artifact；新增公开项继续只能由同校官方 artifact 支撑，且新增项的所有公开 `discoverySources` 都拒绝 GitHub host。历史 ScanBundle/replay 保持 v2、完全不改。

**Tech Stack:** TypeScript、Node.js `node:test`、现有 snapshot approval CLI、Markdown、canonical Codex skill。

**执行状态（2026-08-09）：** Task 1 与 Task 2 已完成并已提交；Task 3 的项目文档部分完成，canonical scan skill 的四个说明文件正由独立 owner 同步。Task 4 的完整集成验证、范围审计与最终交付尚未完成，不能据此宣称全功能已验证。

---

## 文件结构与责任

- `scripts/snapshot/approve-snapshot.ts`：日常 v3 run 类型/解析、固定深研派检查验证、对新增公开 `discoverySources` 的 GitHub 拒绝；不得触碰 `approveSnapshotFile`、ScanBundle/replay parser 或 legacy release 函数。
- `tests/approve-additive-snapshot.test.ts`：构造私有 v3 fixture，持久化三份不同 GitHub text artifact，并回归固定检查、`blocked`、公开来源泄漏和原有追加性行为。
- `AGENTS.md`、`docs/operations/data-refresh.md`、`README.md`：让项目操作契约、v3 示例和面向贡献者的发现源说明与批准器一致。
- `$CODEX_HOME/skills/scan-cs-admissions-events/SKILL.md`、`references/research-protocol.md`、`references/aggregator-protocol.md`、`references/coverage-run-contract.md`：让扫描器生成 v3 私有检查并把深研派固定为线索源；不改 `workbook-contract.md`、脚本或历史 v2 validator。
- `$CODEX_HOME/skills/scan-cs-admissions-events/agents/openai.yaml`：只验证元数据仍与未改 frontmatter 一致；没有 frontmatter 漂移时不改。

### Task 1: 使日常私有 fixture 先失败于 v3 契约

**Files:**
- Modify: `tests/approve-additive-snapshot.test.ts:1-315`
- Modify: `scripts/snapshot/approve-snapshot.ts:150-642`
- Test: `tests/approve-additive-snapshot.test.ts`

- [x] **Step 1: 在测试文件中声明三条稳定的深研派检查定义与不同 artifact 内容。**

  在 `runScannedAt` 常量后加入如下 helper；它让每个 `checked` 条目都有不同 SHA，且 URL 年份由测试 run 日期的北京时间年份生成：

  ```ts
  function shanghaiYear(value: string): string {
    const year = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
    }).formatToParts(new Date(value)).find((part) => part.type === 'year')?.value;
    if (year === undefined) throw new Error(`missing Shanghai year for ${value}`);
    return year;
  }

  function shenyanpaiCheckDefinitions(finishedAt: string) {
    const year = shanghaiYear(finishedAt);
    return [
      ['shenyanpai-profile', 'https://github.com/shenyanpai'],
      ['shenyanpai-summer-camp', `https://github.com/shenyanpai/awesome-summer-camp-${year}`],
      ['shenyanpai-pre-recommend', `https://github.com/shenyanpai/awesome-pre-recommend-${year}`],
    ] as const;
  }

  function fixedDiscoveryArtifactPath(checkId: string): string {
    return `artifacts/${checkId}.html`;
  }

  function fixedDiscoveryArtifactText(checkId: string): string {
    return `<html><body>深研派固定发现检查：${checkId}</body></html>`;
  }
  ```

  把 `additiveRun()` 的 `schemaVersion` 改为 `3`，在 `artifacts` 中加入三份对应的 `text/html` artifact，并加入：

  ```ts
  fixedDiscoveryChecks: shenyanpaiCheckDefinitions(runScannedAt).map(([checkId, url]) => ({
    checkId,
    url,
    checkedAt: runScannedAt,
    result: 'checked' as const,
    artifactSha256: sha256(fixedDiscoveryArtifactText(checkId)),
    reason: null,
  })),
  ```

  在 `materializeRunArtifacts()` 中用下面的完整选择逻辑按 fixed-check SHA 写入对应正文；其余 artifact 保持官方正文逻辑：

  ```ts
  const fixedCheck = run.fixedDiscoveryChecks.find(
    (check) => check.artifactSha256 === artifact.sha256,
  );
  const defaultContent = fixedCheck === undefined
    ? artifactTextFor(run.additions.map((addition) => addition.opportunity))
    : fixedDiscoveryArtifactText(fixedCheck.checkId);
  writeFileSync(artifactPath, contents.get(artifact.path) ?? defaultContent);
  ```

- [x] **Step 2: 运行聚焦测试，确认当前 v2 parser 失败。**

  Run:

  ```bash
  corepack pnpm@10.28.2 exec tsx --test --test-concurrency=1 tests/approve-additive-snapshot.test.ts
  ```

  Expected: FAIL，错误包含 `discovery run.schemaVersion must equal 2`；不得修改 `data/approved/current.json`。

- [x] **Step 3: 定义 v3 私有类型和严格 parser。**

  在 `AdditiveApprovalRun` 前新增：

  ```ts
  export interface AdditiveFixedDiscoveryCheck {
    checkId: string;
    url: string;
    checkedAt: string;
    result: 'checked' | 'blocked';
    artifactSha256: string | null;
    reason: string | null;
  }
  ```

  将 `AdditiveApprovalRun` 改为：

  ```ts
  export interface AdditiveApprovalRun {
    schemaVersion: 3;
    runId: string;
    mode: 'incremental' | 'sweep';
    startedAt: string;
    finishedAt: string;
    parent: {
      url: 'https://ddl.meta-mind.cn/data/current.json';
      sha256: string;
      snapshotId: string;
      dataHash: string;
      privateParentCandidateUsed: false;
    };
    coverage: AdditiveCoveragePlan;
    fixedDiscoveryChecks: AdditiveFixedDiscoveryCheck[];
    scopes: AdditiveDiscoveryScope[];
    artifacts: AdditiveApprovalArtifact[];
    additions: Array<{ opportunity: PublicOpportunity; evidence: AdditiveOpportunityEvidence }>;
  }
  ```

  在 `parseAdditiveRun()` 的顶层 `exactKeys()` 中把 `fixedDiscoveryChecks` 放在 `coverage` 与 `scopes` 之间，并把 schema 判定改为 `3`。新增 `parseAdditiveFixedDiscoveryChecks()`：数组中每个元素严格只允许 `checkId,url,checkedAt,result,artifactSha256,reason`，并以 `timestampAt()` / `sha256At()` 解析；`artifactSha256` 与 `reason` 只能为 `string | null`。在 return 中返回该字段。此步骤只做形状/类型解析，不允许把 source-specific URL 逻辑分散到 parser。

- [x] **Step 4: 运行聚焦测试，确认现有行为恢复。**

  Run:

  ```bash
  corepack pnpm@10.28.2 exec tsx --test --test-concurrency=1 tests/approve-additive-snapshot.test.ts
  ```

  Expected: PASS；旧测试现在均以 v3 fixture 通过，但还没有覆盖固定检查的负例。

- [x] **Step 5: 提交 v3 结构迁移。**

  ```bash
  git add scripts/snapshot/approve-snapshot.ts tests/approve-additive-snapshot.test.ts
  git commit -m "feat: require v3 additive discovery runs"
  ```

### Task 2: 固定检查在 artifact 验证后、公开写入前强制执行

**Files:**
- Modify: `scripts/snapshot/approve-snapshot.ts:650-1155,1988-2042`
- Modify: `tests/approve-additive-snapshot.test.ts:316-1219`
- Test: `tests/approve-additive-snapshot.test.ts`

- [x] **Step 1: 写出固定检查与公开边界的失败测试。**

  先在测试文件中导入 `existsSync`，再加入这个 reusable assertion；所有 pre-decision gate 都用它，因此明确证明不会写 private decision 或 public snapshot：

  ```ts
  async function assertRejectedBeforeApproval(
    source: ReturnType<typeof paths>,
    parentText: string,
    operation: () => Promise<unknown>,
    expected: RegExp,
  ): Promise<void> {
    await assert.rejects(operation, expected);
    assert.equal(readFileSync(source.approved, 'utf8'), parentText);
    assert.equal(existsSync(source.decision), false);
  }
  ```

  在 no-additions 测试之后添加一个 happy-path 断言：所有三项 `checked` 的空 addition run 返回 `no-additions`，其三个 fixed artifact 的 path、SHA、URL 都存在于 run artifact manifest。保留既有 valid-addition 测试，并额外断言三个检查 SHA 不同。

  添加下列 table-driven 负例；每例通过 `additiveRun()` 创建 parent/run，变更后 materialize/write，再调用 `assertRejectedBeforeApproval()`：

  ```ts
  const malformedCases = [
    ['v2 schema', (run: AdditiveApprovalRun) => { (run as { schemaVersion: number }).schemaVersion = 2; }, /schemaVersion must equal 3/i],
    ['missing checks key', (run: AdditiveApprovalRun) => { delete (run as { fixedDiscoveryChecks?: unknown }).fixedDiscoveryChecks; }, /fixedDiscoveryChecks is required/i],
    ['missing required ID', (run: AdditiveApprovalRun) => { run.fixedDiscoveryChecks.pop(); }, /fixed discovery checks.*exactly/i],
    ['duplicate ID', (run: AdditiveApprovalRun) => { run.fixedDiscoveryChecks[1].checkId = 'shenyanpai-profile'; }, /duplicate/i],
    ['unexpected ID', (run: AdditiveApprovalRun) => { run.fixedDiscoveryChecks[1].checkId = 'other-source'; }, /unexpected/i],
    ['wrong owner', (run: AdditiveApprovalRun) => { run.fixedDiscoveryChecks[1].url = 'https://github.com/other/awesome-summer-camp-2026'; }, /URL must match/i],
    ['wrong year', (run: AdditiveApprovalRun) => { run.fixedDiscoveryChecks[2].url = 'https://github.com/shenyanpai/awesome-pre-recommend-2025'; }, /URL must match/i],
    ['query URL', (run: AdditiveApprovalRun) => { run.fixedDiscoveryChecks[2].url += '?spoof=1'; }, /URL must match/i],
    ['checked without artifact', (run: AdditiveApprovalRun) => { run.fixedDiscoveryChecks[0].artifactSha256 = null; }, /checked fixed discovery check.*artifact/i],
    ['checked with reason', (run: AdditiveApprovalRun) => { run.fixedDiscoveryChecks[0].reason = 'not allowed'; }, /checked fixed discovery check.*reason/i],
    ['blocked with artifact', (run: AdditiveApprovalRun) => { run.fixedDiscoveryChecks[0].result = 'blocked'; run.fixedDiscoveryChecks[0].reason = 'timeout'; }, /blocked fixed discovery check.*artifact/i],
    ['blocked without reason', (run: AdditiveApprovalRun) => { run.fixedDiscoveryChecks[0].result = 'blocked'; run.fixedDiscoveryChecks[0].artifactSha256 = null; run.fixedDiscoveryChecks[0].reason = null; }, /blocked fixed discovery check.*reason/i],
  ] as const;
  ```

  添加单独 artifact/time matrix：无 artifact、artifact URL 不同、binary `application/pdf` artifact、检查时间早于 `startedAt`/晚于 `finishedAt`、两个 checked check 复用 SHA、落盘 bytes 被篡改。每例都必须使用 `assertRejectedBeforeApproval()`。

  添加北京时间跨年 case：`finishedAt = '2026-12-31T16:00:00.000Z'` 时 `shenyanpaiCheckDefinitions()` 必须生成两个 `2027` repository URL。这个 case 不要求拒绝 trailing slash/default port，因为 URL 规范化契约允许等价表示。

  添加 `blocked` 正例：逐项将 profile、summer-camp、pre-recommend 设为 `{ result: 'blocked', artifactSha256: null, reason: 'network timeout' }`，从 manifest 删除对应 artifact，并保持一个有完整官方 evidence 的 addition；每个 subtest 都断言 `ready`。再添加 all-blocked/no-additions case，断言 `no-additions` 且 parent bytes 原样保留。

  最后添加 GitHub/public-provenance matrix：先证明 `https://github.com/shenyanpai` 不能成为 `officialUrl`、public website、primary artifact URL 或 field-evidence source/artifact URL；再在已有合法官方 source/evidence 的 addition 上，分别放入 `https://github.com/shenyanpai`、`https://gist.github.com/example` 和 `https://raw.githubusercontent.com/shenyanpai/example/main/README.md` 作为 `kind: 'other-discovery'` URL。前四类由既有官方 host gate 拒绝；后三类必须由新 gate 在 write 前拒绝。另对完整 JSON-serialized `opportunity` 的非 source 字段（如 `description`、`tags`、`projectId`、source label）注入 GitHub/raw URL、固定 check ID、URL、artifact SHA、artifact text 或 blocked 原因，并验证它们也会在 decision/public write 前失败。

- [x] **Step 2: 运行新增测试，确认它们因缺少固定检查 gate 与 all-source GitHub gate 而失败。**

  Run:

  ```bash
  corepack pnpm@10.28.2 exec tsx --test --test-concurrency=1 tests/approve-additive-snapshot.test.ts
  ```

  Expected: FAIL；当前实现会让 `wrong owner`、`query URL`、`blocked` coupling、checked artifact binding 和 `other-discovery` GitHub cases 意外通过。

- [x] **Step 3: 实现单一固定检查断言。**

  在 `assertAdditiveCoverage()` 前新增固定定义与函数：

  ```ts
  const additiveFixedDiscoveryCheckIds = [
    'shenyanpai-profile',
    'shenyanpai-summer-camp',
    'shenyanpai-pre-recommend',
  ] as const;

  function expectedAdditiveFixedDiscoveryUrl(checkId: string, finishedAt: string): string {
    const year = beijingCalendarDate(finishedAt).slice(0, 4);
    switch (checkId) {
      case 'shenyanpai-profile': return 'https://github.com/shenyanpai';
      case 'shenyanpai-summer-camp': return `https://github.com/shenyanpai/awesome-summer-camp-${year}`;
      case 'shenyanpai-pre-recommend': return `https://github.com/shenyanpai/awesome-pre-recommend-${year}`;
      default: throw new Error(`unsupported fixed discovery check ${quoted(checkId)}`);
    }
  }
  ```

  实现 `assertAdditiveFixedDiscoveryChecks(run, artifactMaterials)`，严格要求 `run.fixedDiscoveryChecks.length === 3`、所有 ID 唯一且恰好为上述集合，`checkedAt` 在 run window 内。对于 `checked`，要求 `reason === null`、有 SHA、artifact material 存在、artifact 的规范化 URL 等于对应 expected URL、`material.text?.trim()` 非空，并用 `Set` 拒绝多个 checked check 复用同一 SHA。对于 `blocked`，要求 `artifactSha256 === null` 且 `reason.trim() !== ''`。任何其它 result 抛出确定错误；错误字符串必须包含 `fixed discovery check`，便于测试稳定匹配。

  在 `approveAdditiveSnapshotFile()` 中保持既有顺序，并在：

  ```ts
  const artifactMaterials = await readAndVerifyAdditiveArtifacts(runPath, run);
  ```

  后立即插入：

  ```ts
  assertAdditiveFixedDiscoveryChecks(run, artifactMaterials);
  ```

  这必须发生在 `finishedAt`/父本/coverage checks 及 `if (additions.length === 0)` 之前。

- [x] **Step 4: 实现新增项的全来源 GitHub 与私有 provenance 拒绝。**

  在 `assertAdditiveEvidence()` 的 official-source filter 前加入 discovery-source URL host 检查；随后在批准阶段对每个 `opportunity` 的完整 JSON 序列化结果执行私有 provenance 检查。它必须拒绝 GitHub/raw URL（含 GitHub 子域、编码/规范化变体）以及可识别固定检查的 URL、artifact SHA、artifact text、`checkId` 和 blocked 具体原因，无论这些值出现在公开对象的哪个字段；普通孤立的 `checked`/`blocked` 文本不构成 fixed-check provenance。固定检查记录及其状态只能留在私有 run/decision。不要改 `src/lib/snapshot-validation.ts`，从而不重新解释历史 parent 行。

  ```ts
  function isAdditiveGitHubHost(hostname: string): boolean {
    return hostname === 'github.com'
      || hostname.endsWith('.github.com')
      || hostname === 'raw.githubusercontent.com';
  }

  function assertAdditivePublicDiscoverySources(opportunity: PublicOpportunity): void {
    for (const source of opportunity.discoverySources) {
      const normalized = normalizeComparableUrl(source.url, 'addition discovery source URL');
      if (isAdditiveGitHubHost(new URL(normalized).hostname)) {
        throw new Error(`addition ${quoted(opportunity.projectId)} must not expose a GitHub discovery source`);
      }
    }
  }
  ```

  调用 `assertAdditivePublicDiscoverySources(opportunity)` 后再执行现有 official-source 精确匹配；序列化 provenance gate 仅适用于 additions。

- [x] **Step 5: 运行聚焦测试，确认正反路径通过。**

  Run:

  ```bash
  corepack pnpm@10.28.2 exec tsx --test --test-concurrency=1 tests/approve-additive-snapshot.test.ts
  ```

  Expected: PASS；`blocked` source check 不阻断独立官方 addition，所有 malformed/source-leak cases 均在 decision 或 public write 前失败。

- [x] **Step 6: 提交固定 source gate。**

  ```bash
  git add scripts/snapshot/approve-snapshot.ts tests/approve-additive-snapshot.test.ts
  git commit -m "feat: gate additive runs on shenyanpai discovery checks"
  ```

### Task 3: 同步项目运行说明与 canonical scan skill（项目文档完成；skill 同步进行中）

**Files:**
- Modify: `AGENTS.md:17-45`
- Modify: `docs/operations/data-refresh.md:31-105`
- Modify: `README.md:1-12`
- Modify: `$CODEX_HOME/skills/scan-cs-admissions-events/SKILL.md`
- Modify: `$CODEX_HOME/skills/scan-cs-admissions-events/references/research-protocol.md`
- Modify: `$CODEX_HOME/skills/scan-cs-admissions-events/references/aggregator-protocol.md`
- Modify: `$CODEX_HOME/skills/scan-cs-admissions-events/references/coverage-run-contract.md`
- Verify only: `$CODEX_HOME/skills/scan-cs-admissions-events/agents/openai.yaml`

- [x] **Step 1: 更新项目文档到准确的 v3 运行契约。**

  在 `AGENTS.md` 与 `data-refresh.md` 中将日常运行 `schemaVersion: 2` 改为 `3`，列出三个 `fixedDiscoveryChecks` 的精确 URL 模板、`checked`/`blocked` 的 artifact/reason 语义，以及“缺失或冒充拒绝、访问受阻不阻断独立 addition/no-additions”的差异。明确 GitHub/raw 以及固定检查 provenance 均不得出现在新增项目的任意序列化公开字段，且所有 `discoverySources` 变体（包括 `other-discovery`）都受限；这条只适用于 additions，父项保持不变。

  在 `README.md` 的发现源句子改为：

  ```md
本版本将保研通知网、CS-BAOYAN、BoardCaster 和深研派 GitHub 通知合集作为发现源，并回到院校官网、官方报名系统、官方公众号或官方附件核验后再发布。
```

- [ ] **Step 2: 更新 canonical skill 的四个运行说明文件（进行中，由独立 owner 负责）。**

  在 `SKILL.md` 和 `research-protocol.md` 将每日“三家聚合站”改为四家，新增深研派 profile + `awesome-summer-camp-<YYYY>` + `awesome-pre-recommend-<YYYY>` 的固定检查。要求先保存私有 text/HTML artifact 与 SHA，然后从合集链接回源官方页面并做学院级 fan-out；禁止将 GitHub URL 用作 `officialUrl`、字段证据或公开 discovery source。

  在 `aggregator-protocol.md` 增加“深研派 GitHub 通知合集”小节：三个 exact canonical URL、当前年份由 `finishedAt` 北京时间年份派生、`checked` 要同 URL artifact、`blocked` 要具体原因并继续官方扫描。

  在 `coverage-run-contract.md` 把日常 `discovery-run.json` 改为 v3，定义 `fixedDiscoveryChecks` 的六个字段和三条唯一 checkId，说明它们不是学校 scope、所有 run 都需带、批准器在 no-additions 前验证。保留文中 `ScanBundle v2`、旧 validator/replay 的维护边界，不改它们的 schema 或脚本。

- [ ] **Step 3: 验证 skill 元数据和文档边界。**

  Run:

  ```bash
  python3 "$CODEX_HOME/skills/.system/skill-creator/scripts/quick_validate.py" "$CODEX_HOME/skills/scan-cs-admissions-events"
  rg -n 'schemaVersion: 2|三家聚合|GitHub.*官方|officialUrl.*github' AGENTS.md docs/operations/data-refresh.md README.md "$CODEX_HOME/skills/scan-cs-admissions-events"
  ```

  Expected: `quick_validate.py` reports success. Remaining `ScanBundle v2` wording only appears in explicit legacy/replay boundary prose; no daily v2 instruction or GitHub-as-official wording remains.

- [x] **Step 4: 提交项目文档；保留全局 skills 仓库的其他用户改动。**

  ```bash
  git add AGENTS.md docs/operations/data-refresh.md README.md
  git commit -m "docs: add shenyanpai discovery source contract"
  ```

  不在 `$CODEX_HOME/skills` 仓库执行全量暂存、重置、清理或提交；只保留本次四个 skill 文件的定向编辑与 validator 证据。

### Task 4: 完整验证、范围审计与交付

**Files:**
- Verify: `scripts/snapshot/approve-snapshot.ts`
- Verify: `tests/approve-additive-snapshot.test.ts`
- Verify: `AGENTS.md`, `docs/operations/data-refresh.md`, `README.md`
- Verify: `$CODEX_HOME/skills/scan-cs-admissions-events/{SKILL.md,references/*.md}`

- [ ] **Step 1: 运行批准器、类型和完整单元回归。**

  Run:

  ```bash
  corepack pnpm@10.28.2 exec tsx --test --test-concurrency=1 tests/approve-additive-snapshot.test.ts
  corepack pnpm@10.28.2 exec tsc --noEmit --pretty false
  corepack pnpm@10.28.2 run test:unit
  ```

  Expected: 每个命令退出 `0`；macOS 专属跳过测试可保留为 skip，不能有 fail。

- [ ] **Step 2: 运行公开边界与构建验证。**

  Run:

  ```bash
  corepack pnpm@10.28.2 run check:public
  corepack pnpm@10.28.2 run build
  git diff --check origin/main...HEAD
  ```

  Expected: 全部退出 `0`。此次分支不应修改 `data/approved/current.json`、创建部署或写入私有 artifact。

- [ ] **Step 3: 进行有界 diff 审计并请求独立复核。**

  Run:

  ```bash
  git diff --name-status origin/main...HEAD
  git status --short --branch
  ```

  Expected: 仅包含批准器、其测试、项目运行文档、spec/plan；canonical skill 的四个文件在其独立目录修改但不干扰该目录已有的无关改动。独立复核必须确认：v3 固定检查、blocked 语义、GitHub 无公开泄漏、legacy replay 未动、以及无数据发布。

- [ ] **Step 4: 提交验证范围内的剩余项目文件。**

  ```bash
  git add scripts/snapshot/approve-snapshot.ts tests/approve-additive-snapshot.test.ts AGENTS.md docs/operations/data-refresh.md README.md
  git commit -m "test: verify shenyanpai discovery source gate"
  ```

  若前述任务已提交所有项目文件且工作树干净，则跳过此空提交；不得为了满足步骤创建空 commit。
