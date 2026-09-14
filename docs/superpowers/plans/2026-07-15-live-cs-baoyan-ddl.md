# Timely CS Admissions DDL Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 保留上游 CS-BAOYAN-DDL 的主要页面与交互，用官网核验优先的批准快照替换 BoardCaster-only 数据链，并通过 GitHub CI 原子部署到腾讯云静态站。

**Architecture:** `scan-cs-admissions-events` 产生候选 JSON，仓库内确定性导入器负责规范化、验证、差异和批准；Svelte 在构建时读取 `data/approved/current.json`，不使用数据库或运行时写 API。GitHub Actions 只部署已提交、已验证的批准快照，腾讯云以版本目录和 `current` 软链接实现原子切换与回滚。

**Tech Stack:** Svelte 5、Vite 6、Tailwind CSS 4、TypeScript、Node test runner via `tsx`、GitHub Actions、Nginx、SSH/rsync。

---

## File Map

### Existing files to modify

- `README.md`: 说明及时版定位、来源边界、开发和发布流程。
- `package.json`: 增加测试、快照导入、验证、差异和批准命令。
- `.gitignore`: 忽略 staging 候选和差异 JSON，只保留目录占位。
- `vite.config.ts`: 增加 `$approved` 数据别名。
- `src/App.svelte`: 使用稳定 `projectId` 处理选中和键盘导航。
- `src/lib/types.ts`: 扩展公开项目和核验状态类型。
- `src/lib/schools.ts`: 将当前周期切换为批准快照，旧周期读取遗留数据。
- `src/lib/urlState.svelte.ts`: 使用快照提供的动态批次目录校验 URL 状态。
- `src/lib/filter.ts`: 使用发布器提供的 epoch，保持截止升序。
- `src/lib/time.ts`: 只格式化规范化 epoch，不重新猜测日期级截止。
- `src/components/Header.svelte`: 从快照动态渲染批次选择器。
- `src/components/CalendarView.svelte`: 使用稳定 `projectId` 作为日历项身份。
- `src/components/ListView.svelte`: 保持原分组并使用稳定键。
- `src/components/SchoolRow.svelte`: 展示核验状态，不改变主体布局。
- `src/components/DetailPanel.svelte`: 展示截止原文、核验时间、食宿交通、推荐信、材料和来源。
- `.github/workflows/deploy.yml`: 替换 GitHub Pages 发布为腾讯云版本目录发布。
- `.github/workflows/update_json.yml`: 删除 BoardCaster 整文件覆盖工作流。

### New files

- `AGENTS.md`: 本项目事实来源、数据和发布规则。
- `src/lib/snapshot-types.ts`: 快照数据契约。
- `src/lib/snapshot-validation.ts`: 浏览器和脚本共享的纯验证函数。
- `src/data/legacy-schools.json`: 上游旧年度只读数据。
- `data/approved/current.json`: 唯一可发布当前快照。
- `data/project-id-aliases.json`: 官网 URL 修订时的稳定项目 ID 显式迁移表。
- `data/staging/.gitkeep`: 候选快照目录占位。
- `scripts/snapshot/import-scouting-data.ts`: Skill 输出到候选快照的适配器。
- `scripts/snapshot/diff-snapshots.ts`: 生成新增、修改、过期和删除差异。
- `scripts/snapshot/approve-snapshot.ts`: 验证并批准候选快照。
- `scripts/snapshot/validate-current.ts`: CI 验证入口。
- `tests/fixtures/scouting-valid.json`: 最小有效 Skill 输出。
- `tests/fixtures/scouting-invalid-aggregator-official.json`: 聚合站冒充官网负例。
- `tests/fixtures/snapshot-valid.json`: 最小有效批准快照。
- `tests/snapshot-validation.test.ts`: 数据契约测试。
- `tests/import-scouting-data.test.ts`: 导入、排除和排序测试。
- `tests/diff-snapshots.test.ts`: 快照差异测试。
- `tests/filter.test.ts`: 截止排序和稳定键测试。
- `.github/workflows/ci.yml`: PR 和 push 验证。
- `scripts/check-public.sh`: tracked staging 与公开字段泄漏门禁。
- `deploy/nginx/cs-baoyan-ddl.conf`: Nginx 只读静态站配置。
- `deploy/bootstrap-server.sh`: 一次性创建版本目录和权限。
- `deploy/smoke.sh`: 线上健康检查。
- `docs/operations/data-refresh.md`: 扫描、导入、批准和发布手册。
- `docs/operations/tencent-deploy.md`: 腾讯云和 GitHub Secrets 配置手册。
- `docs/operations/rollback.md`: 回滚手册。
- `e2e/ddl.spec.ts`: 桌面和移动端核心流程。
- `playwright.config.ts`: E2E 与截图配置。

## Task 1: Freeze Fork Safety And Baseline

**Files:**
- Create: `AGENTS.md`
- Modify: `README.md`
- Modify: `.gitignore`
- Delete: `public/CNAME`
- Delete: `.github/workflows/update_json.yml`

- [ ] **Step 1: Create the implementation branch**

Run:

```bash
git switch main
git pull --ff-only origin main
git switch -c codex/live-data-pipeline
```

Expected: the implementation work is isolated from `main` and the branch follows the required `codex/` prefix.

- [ ] **Step 2: Record the clean upstream baseline**

Run:

```bash
pnpm install --frozen-lockfile
pnpm run check
pnpm run build
git status --short
```

Expected: `svelte-check found 0 errors and 0 warnings`, Vite exits 0, and only dependency/build-generated files allowed by `.gitignore` remain untracked.

- [ ] **Step 3: Create the project rules**

Create `AGENTS.md` with:

```markdown
# Timely CS Admissions DDL Working Agreement

## Product Boundary

Preserve the upstream CS-BAOYAN-DDL interaction model. Improve freshness and evidence quality without adding accounts, comments, a database, or a public write API in v1.

## Source Authority

Aggregators are discovery sources only. A record may enter the actionable main list only when an official school, college, institute, official application system, official WeChat account, or official attachment supports it.

## Data Flow

`data/staging/candidate.json` is never deployable. Only `data/approved/current.json` may be bundled into production. Every snapshot must pass `pnpm run snapshot:validate` and preserve `snapshotId`, `previousSnapshotId`, `scanAt`, `approvedAt`, and `dataHash`.

## Privacy

Never commit submitted-project lists, personal fit scores, contact details, target-folder paths, private evidence paths, credentials, or application status.

## Release

Production deploys are static and versioned. A failed scan, validation, build, upload, or smoke check must leave the previous release serving when one exists; a failed first release must remove its `current` link. Do not grant scanning agents production SSH keys.

## Upstream

Keep the MIT license and upstream attribution. Pull UI changes from `upstream` manually. Never restore the BoardCaster whole-file overwrite workflow or the upstream CNAME.
```

- [ ] **Step 4: Protect private staging before any importer runs**

Add to `.gitignore`:

```gitignore
data/staging/*.json
!data/staging/.gitkeep
```

Verify:

```bash
test -z "$(git ls-files 'data/staging/*.json')"
```

Expected: no staging JSON is tracked. This rule must land before Task 3 writes its first candidate.

- [ ] **Step 5: Remove upstream production coupling**

Run:

```bash
git rm public/CNAME .github/workflows/update_json.yml
```

Expected: the fork no longer contains `ddl.csbaoyan.top` as its CNAME and no scheduled workflow can overwrite local data from BoardCaster.

- [ ] **Step 6: Rewrite the README scope**

Replace the opening and data-source sections with:

```markdown
# CS 保研 DDL · 及时版

这是基于 [CS-BAOYAN-DDL](https://github.com/CS-BAOYAN/CS-BAOYAN-DDL) 的及时更新版本，保留原项目的列表、日历、筛选、搜索和倒计时体验。

本版本将保研通知网、CS-BAOYAN 和 BoardCaster 作为发现源，并回到院校官网、官方报名系统、官方公众号或官方附件核验后再发布。页面不保证覆盖所有院校，临近截止时请再次打开官方通知确认。

当前周期数据来自版本化批准快照；扫描候选、个人投递状态和本地证据不会提交到公开仓库。
```

Append an attribution section:

```markdown
## 上游与许可

界面基于 MIT 许可的 [CS-BAOYAN/CS-BAOYAN-DDL](https://github.com/CS-BAOYAN/CS-BAOYAN-DDL)。原版权声明和许可证保留在 [LICENSE](LICENSE)。
```

- [ ] **Step 7: Verify the safety boundary**

Run:

```bash
! rg -n "ddl\.csbaoyan\.top" public .github
! test -e .github/workflows/update_json.yml
test -z "$(git ls-files 'data/staging/*.json')"
git remote -v
```

Expected: both negative checks exit 0; `origin` is `lvzaixian/CS-BAOYAN-DDL`; upstream push is `DISABLED`.

- [ ] **Step 8: Commit the baseline**

```bash
git add AGENTS.md README.md .gitignore public/CNAME .github/workflows/update_json.yml
git commit -m "chore: establish timely ddl fork boundaries"
```

## Task 2: Add Snapshot Contract And Validation

**Files:**
- Create: `src/lib/snapshot-types.ts`
- Create: `src/lib/snapshot-validation.ts`
- Create: `tests/fixtures/snapshot-valid.json`
- Create: `tests/snapshot-validation.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Add the test command**

Modify `package.json` scripts:

```json
{
  "test": "tsx --test tests/**/*.test.ts",
  "test:unit": "tsx --test tests/**/*.test.ts",
  "snapshot:validate": "tsx scripts/snapshot/validate-current.ts"
}
```

Do not add a new test dependency; the repository already depends on `tsx`.

- [ ] **Step 2: Write the failing contract test**

Create `tests/snapshot-validation.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import validSnapshot from './fixtures/snapshot-valid.json' with { type: 'json' };
import { validateSnapshot } from '../src/lib/snapshot-validation';

const FIXED_NOW = Date.parse('2026-07-15T23:00:00+08:00');

test('accepts a valid approved snapshot', () => {
  assert.deepEqual(validateSnapshot(validSnapshot, FIXED_NOW), []);
});

test('rejects duplicate project ids', () => {
  const input = structuredClone(validSnapshot);
  input.opportunities.push(structuredClone(input.opportunities[0]));
  assert.match(validateSnapshot(input, FIXED_NOW).join('\n'), /duplicate projectId/);
});

test('rejects an aggregator as the official website', () => {
  const input = structuredClone(validSnapshot);
  input.opportunities[0].website = 'https://www.baoyantongzhi.com/notice/detail/1';
  assert.match(validateSnapshot(input, FIXED_NOW).join('\n'), /official website/);
});

test('rejects expired rows marked confirmed-open', () => {
  const input = structuredClone(validSnapshot);
  input.opportunities[0].deadlineEpochMs = 1;
  assert.match(validateSnapshot(input, FIXED_NOW).join('\n'), /expired confirmed-open/);
});
```

- [ ] **Step 3: Add the valid fixture**

Create `tests/fixtures/snapshot-valid.json`:

```json
{
  "schemaVersion": 1,
  "snapshotId": "2026-07-15T15:00:00.000Z-fixture",
  "scanAt": "2026-07-15T23:00:00+08:00",
  "approvedAt": "2026-07-15T23:05:00+08:00",
  "previousSnapshotId": null,
  "dataHash": "0000000000000000000000000000000000000000000000000000000000000000",
  "defaultFeedId": "camp2027",
  "feeds": [
    {
      "id": "camp2027",
      "label": "推免活动 2027",
      "admissionCycle": "2027",
      "eventYear": 2026
    }
  ],
  "counts": {
    "confirmedOpen": 1,
    "confirmedUnknownDeadline": 0,
    "pendingExcluded": 0,
    "expired": 0
  },
  "opportunities": [
    {
      "projectId": "2027|测试大学|计算机学院|夏令营",
      "feedId": "camp2027",
      "name": "测试大学",
      "institute": "计算机学院",
      "project": "2026年优秀大学生夏令营",
      "eventType": "夏令营",
      "description": "用于契约测试的记录",
      "verificationStatus": "confirmed-open",
      "deadline": "2026-07-20T23:59:00+08:00",
      "deadlineOriginal": "2026年7月20日截止，官方未给具体时刻",
      "deadlineEpochMs": 1784563140000,
      "website": "https://cs.example.edu.cn/notice/1",
      "tags": ["985"],
      "province": "北京",
      "verifiedAt": "2026-07-15T22:30:00+08:00",
      "discoverySources": [
        {
          "kind": "official",
          "label": "学院官网",
          "url": "https://cs.example.edu.cn/notice/1"
        }
      ],
      "logistics": { "status": "not-published", "summary": "未公布" },
      "recommendation": { "status": "confirmed", "summary": "未要求推荐信" },
      "materials": { "status": "confirmed", "summary": "成绩单与科研证明" }
    }
  ]
}
```

- [ ] **Step 4: Run the test to prove the validator is missing**

Run:

```bash
pnpm run test:unit
```

Expected: FAIL because `src/lib/snapshot-validation.ts` does not exist.

- [ ] **Step 5: Define the exact types**

Create `src/lib/snapshot-types.ts` with the interfaces from the approved design. Export:

```ts
export type VerificationStatus =
  | 'confirmed-open'
  | 'confirmed-unknown-deadline'
  | 'expired';

export type FactStatus = 'confirmed' | 'not-published' | 'unverified' | 'not-applicable';
export type DiscoveryKind = 'official' | 'baoyan-notice' | 'cs-baoyan' | 'other-discovery';

export interface FieldFactGroup {
  status: FactStatus;
  summary: string;
}

export interface PublicSourceLink {
  kind: DiscoveryKind;
  label: string;
  url: string;
}

export interface FeedDescriptor {
  id: string;
  label: string;
  admissionCycle: string;
  eventYear: number;
}

export interface PublicOpportunity {
  projectId: string;
  feedId: string;
  name: string;
  institute: string;
  project: string;
  eventType: string;
  description: string;
  verificationStatus: VerificationStatus;
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

export interface SnapshotCandidate {
  schemaVersion: 1;
  scanAt: string;
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

export interface PublicSnapshot extends SnapshotCandidate {
  snapshotId: string;
  approvedAt: string;
  previousSnapshotId: string | null;
  dataHash: string;
}
```

- [ ] **Step 6: Implement the minimal validator**

Create `src/lib/snapshot-validation.ts` with pure checks for exact object shape (unknown properties are errors), schema version, ISO timestamps, a 64-character hexadecimal `dataHash`, duplicate `projectId`, allowed statuses, official source presence, official URL denylist, deadline/status consistency, count consistency, and deadline ascending within active records. It must also require unique feed IDs, require `defaultFeedId` to exist in `feeds`, and require every opportunity `feedId` to reference an existing feed. Expose `validateCandidate()` for the metadata-free staging contract and `validateSnapshot()` for the sealed public contract. Hash recomputation belongs to `validate-current.ts` and the approval command because a structural fixture may use a synthetic hash.

The official URL denylist must include:

```ts
const DISCOVERY_HOSTS = new Set([
  'ddl.csbaoyan.top',
  'github.com',
  'www.baoyantongzhi.com',
  'baoyantongzhi.com',
]);
```

Expose:

```ts
export function validateSnapshot(input: unknown, nowMs = Date.now()): string[];
export function validateCandidate(input: unknown, nowMs = Date.now()): string[];
```

Return errors; do not throw inside the pure function.

- [ ] **Step 7: Run contract tests**

```bash
pnpm run test:unit
```

Expected: 4 tests pass.

- [ ] **Step 8: Commit the contract**

```bash
git add package.json src/lib/snapshot-types.ts src/lib/snapshot-validation.ts tests/fixtures/snapshot-valid.json tests/snapshot-validation.test.ts
git commit -m "feat: define approved snapshot contract"
```

## Task 3: Build The Scouting Importer

**Files:**
- Create: `scripts/snapshot/import-scouting-data.ts`
- Create: `data/project-id-aliases.json`
- Create: `tests/fixtures/scouting-valid.json`
- Create: `tests/fixtures/scouting-invalid-aggregator-official.json`
- Create: `tests/import-scouting-data.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Add the import command**

Add:

```json
{
  "snapshot:import": "tsx scripts/snapshot/import-scouting-data.ts"
}
```

- [ ] **Step 2: Write failing importer tests**

Create `tests/import-scouting-data.test.ts` covering:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import fixture from './fixtures/scouting-valid.json' with { type: 'json' };
import { importScoutingData } from '../scripts/snapshot/import-scouting-data';

test('maps confirmed and expired rows while excluding pending and private fields', () => {
  const candidate = importScoutingData(fixture, { previous: null, aliases: {} });
  assert.equal(candidate.counts.confirmedOpen, 1);
  assert.equal(candidate.counts.pendingExcluded, 1);
  assert.equal(candidate.counts.expired, 1);
  assert.equal(candidate.opportunities.some((row) => row.verificationStatus.startsWith('pending-')), false);
  assert.equal('welfareScore' in candidate.opportunities[0], false);
  assert.equal('fit' in candidate.opportunities[0], false);
});

test('derives a deterministic feed catalog from admission cycle and event year', () => {
  const candidate = importScoutingData(fixture, { previous: null, aliases: {} });
  assert.equal(candidate.defaultFeedId, 'camp2027');
  assert.deepEqual(candidate.feeds, [{
    id: 'camp2027',
    label: '推免活动 2027',
    admissionCycle: '2027',
    eventYear: 2026,
  }]);
});

test('sorts active deadlines ascending and unknown deadlines after active rows', () => {
  const candidate = importScoutingData(fixture, { previous: null, aliases: {} });
  const active = candidate.opportunities.filter((row) => row.verificationStatus.startsWith('confirmed'));
  assert.deepEqual(active.map((row) => row.projectId), [
    '2027|测试大学|计算机学院|夏令营',
    '2027|未知大学|软件学院|开放日',
  ]);
});

test('rejects duplicate project ids', () => {
  const duplicate = structuredClone(fixture);
  duplicate.mainRows.push(structuredClone(duplicate.mainRows[0]));
  assert.throws(() => importScoutingData(duplicate, { previous: null, aliases: {} }), /duplicate projectId/);
});

test('reuses an approved id when display names change', () => {
  const renamed = structuredClone(fixture);
  renamed.mainRows[0].project = '修订后的项目名称';
  const candidate = importScoutingData(renamed, { previous: approvedSnapshot, aliases: {} });
  assert.equal(candidate.opportunities[0].projectId, approvedSnapshot.opportunities[0].projectId);
});
```

- [ ] **Step 3: Create minimal positive and negative fixtures**

`scouting-valid.json` must contain one deadline main row, one unknown-deadline main row, one pending row and one expired row using the field names in the 2026-07-15 Skill output. The pending row is a private staging fixture and must never appear in `opportunities`. `scouting-invalid-aggregator-official.json` must set a main row `officialUrl` to a `baoyantongzhi.com` detail URL.

- [ ] **Step 4: Run tests to verify failure**

```bash
pnpm run test:unit
```

Expected: FAIL because the importer module is absent.

- [ ] **Step 5: Implement deterministic mapping**

Create `data/project-id-aliases.json` as `{}`. Create `scripts/snapshot/import-scouting-data.ts` exporting:

```ts
export interface IdentityContext {
  previous: PublicSnapshot | null;
  aliases: Record<string, string>;
}

export function importScoutingData(input: unknown, identities: IdentityContext): SnapshotCandidate;
```

Mapping rules:

- Map `mainRows` and `expiredRows` into the public `opportunities` array.
- Exclude `pendingRows` from the public array; retain only their aggregate count as `counts.pendingExcluded`. Row-level pending evidence remains in the original private Skill output and is never copied into the repository candidate or diff.
- Derive a deterministic `feeds` catalog from each row's admission cycle and event year. For the current Skill contract, parse the four-digit year from `cycle` (`2027推免` becomes `2027`), set `id` to `camp${admissionCycle}`, use the accurate mixed-event label `推免活动 ${admissionCycle}`, and set `eventYear` from the Beijing-time year of `scanAt`. Set `defaultFeedId` to the newest active feed and assign every public row a valid `feedId`. Reject rows whose cycle has no unambiguous four-digit year instead of guessing.

- Stable ID resolution order is: exact normalized official URL match in the previous approved snapshot; explicit URL-to-ID entry in `data/project-id-aliases.json`; otherwise the Skill `projectId` for a new record. Once approved, display-name changes reuse the prior ID. If an official URL changes, the diff must remain remove/add until a reviewer records the migration explicitly in the alias file.
- School and project names are copied without inference.
- `officialUrl` becomes `website` and the required official source.
- `baoyanNoticeUrl` becomes `kind: 'baoyan-notice'`.
- `discoverySources` labels without URLs are not emitted as clickable sources.
- `deadline` must be null or normalized with `+08:00`; date-only values become `YYYY-MM-DDT23:59:00+08:00`, while `deadlineOriginal` preserves that the official time was not published.
- `accommodation`, `meals`, `transport` and `reimbursement` combine into `logistics.summary` without claiming reimbursement when the source says `未公布`.
- `recommendationLetters` and `recommendationTemplate` combine into `recommendation.summary`.
- `materialComplexity` and `materialList` combine into `materials.summary`.
- A fact group with `unverified` or `not-published` status emits only a fixed public summary such as `待官方公布` or `未公布`; raw unverified text is not copied into the public candidate.
- Drop `fit`, `welfareScore`, `cityPlatformValue`, `socialValue`, local paths and submitted IDs.
- Compute public counts from mapped rows and `pendingExcluded` from excluded staging rows, not from input-provided counts.
- Do not create `snapshotId`, `approvedAt`, `previousSnapshotId` or `dataHash`; those fields belong exclusively to the approval boundary in Task 4.

CLI usage:

```text
SCOUTING_JSON=$(find /Users/maxwellbrooks/Workspace/profile_space/outputs -type f -name 'workbook_data_*.json' -exec stat -f '%m\t%N' {} + | sort -nr | head -1 | cut -f2-)
test -n "$SCOUTING_JSON"
pnpm run snapshot:import -- --input "$SCOUTING_JSON" --aliases data/project-id-aliases.json --output data/staging/candidate.json
```

Reject relative input paths to avoid importing an unexpected file from CI working-directory drift.
The CLI accepts optional `--approved data/approved/current.json` for stable-ID reuse when a current snapshot exists; absence means first import, not an error.

- [ ] **Step 6: Run importer tests**

```bash
pnpm run test:unit
```

Expected: importer tests and contract tests pass.

- [ ] **Step 7: Verify the invalid official URL fails**

```bash
pnpm run snapshot:import -- --input "$PWD/tests/fixtures/scouting-invalid-aggregator-official.json" --aliases data/project-id-aliases.json --output /tmp/invalid.json
```

Expected: non-zero exit and an error containing `official website`.

- [ ] **Step 8: Commit the importer**

```bash
git add package.json data/project-id-aliases.json scripts/snapshot/import-scouting-data.ts tests/fixtures/scouting-valid.json tests/fixtures/scouting-invalid-aggregator-official.json tests/import-scouting-data.test.ts
git commit -m "feat: import verified scouting data"
```

## Task 4: Add Snapshot Diff And Approval

**Files:**
- Create: `scripts/snapshot/diff-snapshots.ts`
- Create: `scripts/snapshot/approve-snapshot.ts`
- Create: `scripts/snapshot/validate-current.ts`
- Create: `tests/diff-snapshots.test.ts`
- Create: `tests/approve-snapshot.test.ts`
- Create: `data/staging/.gitkeep`
- Create: `data/approved/current.json`
- Modify: `package.json`

- [ ] **Step 1: Add commands**

```json
{
  "snapshot:diff": "tsx scripts/snapshot/diff-snapshots.ts",
  "snapshot:approve": "tsx scripts/snapshot/approve-snapshot.ts",
  "snapshot:validate": "tsx scripts/snapshot/validate-current.ts"
}
```

- [ ] **Step 2: Write failing diff tests**

Cover exact behavior:

```ts
test('classifies added, changed, expired and removed ids', () => {
  const result = diffSnapshots(previous, next);
  assert.deepEqual(result.added, ['new']);
  assert.deepEqual(result.changed, ['changed']);
  assert.deepEqual(result.expired, ['expired']);
  assert.deepEqual(result.removed, ['removed']);
});
```

A deadline, website, verification status, recommendation or logistics change must place a project in `changed`. Description-only whitespace changes must not.

- [ ] **Step 3: Implement the pure diff and CLI**

Export:

```ts
export interface SnapshotDiff {
  added: string[];
  changed: string[];
  expired: string[];
  removed: string[];
}

export function diffSnapshots(previous: PublicSnapshot | null, next: SnapshotCandidate): SnapshotDiff;
```

CLI usage:

```text
pnpm run snapshot:diff -- --previous data/approved/current.json --next data/staging/candidate.json --output data/staging/diff.json
```

- [ ] **Step 4: Implement approval as a separate command**

First write `tests/approve-snapshot.test.ts` to prove that approval derives all publication metadata from the actual current snapshot:

```ts
test('seals a candidate against the current approved snapshot', () => {
  const approved = approveCandidate(candidate, current, '2026-07-15T23:05:00+08:00');
  assert.equal(approved.previousSnapshotId, current.snapshotId);
  assert.match(approved.snapshotId, /^2026-07-15T15:05:00\.000Z-[a-f0-9]{12}$/);
  assert.match(approved.dataHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(validateSnapshot(approved, FIXED_NOW), []);
});
```

`approve-snapshot.ts` must:

1. Read `data/staging/candidate.json`.
2. Run `validateCandidate` using the explicit `--approved-at` time in tests or the current time in normal use.
3. Read the current approved snapshot if it exists.
4. Set `previousSnapshotId` to the actual current `snapshotId`, or `null` only when no approved file exists.
5. Set `approvedAt`, compute SHA-256 over canonical `{ schemaVersion, scanAt, defaultFeedId, feeds, counts, opportunities }`, and set `snapshotId` to the UTC approved timestamp plus the first 12 hash characters.
6. Run `validateSnapshot` on the sealed result and independently compare its recomputed hash.
7. Write through a temporary file and `rename()` to `data/approved/current.json`.
8. Never delete the staging candidate or diff.

Export the pure boundary for tests:

```ts
export function approveCandidate(
  candidate: SnapshotCandidate,
  current: PublicSnapshot | null,
  approvedAt: string,
): PublicSnapshot;
```

CLI usage:

```text
pnpm run snapshot:approve -- --candidate data/staging/candidate.json --approved data/approved/current.json
```

- [ ] **Step 5: Add the CI validation entrypoint**

`validate-current.ts` reads `data/approved/current.json`, prints all structural validation errors, recomputes and compares the canonical hash, exits 1 when any error exists, and prints a one-line count summary on success.

- [ ] **Step 6: Seed the approved file through the real approval boundary**

Create a candidate from the scouting fixture, then approve it with a fixed time:

```bash
mkdir -p data/staging data/approved
pnpm run snapshot:import -- \
  --input "$PWD/tests/fixtures/scouting-valid.json" \
  --aliases data/project-id-aliases.json \
  --output data/staging/candidate.json
pnpm run snapshot:approve -- \
  --candidate data/staging/candidate.json \
  --approved data/approved/current.json \
  --approved-at '2026-07-15T23:05:00+08:00'
```

Replace this development snapshot with the first real approved snapshot in Task 10 before deployment. Confirm candidate JSON remains ignored.

- [ ] **Step 7: Run unit and CLI checks**

```bash
pnpm run test:unit
pnpm run snapshot:validate
```

Expected: all tests pass and validation prints `confirmedOpen=1 pendingExcluded=0 expired=0`.

- [ ] **Step 8: Commit snapshot lifecycle tooling**

```bash
git add package.json scripts/snapshot data/staging/.gitkeep data/approved/current.json tests/diff-snapshots.test.ts tests/approve-snapshot.test.ts
git commit -m "feat: add snapshot approval lifecycle"
```

## Task 5: Switch The Frontend To Approved Data

**Files:**
- Modify: `vite.config.ts`
- Modify: `src/lib/types.ts`
- Modify: `src/lib/schools.ts`
- Modify: `src/lib/urlState.svelte.ts`
- Modify: `src/lib/filter.ts`
- Modify: `src/App.svelte`
- Modify: `src/components/Header.svelte`
- Modify: `src/components/CalendarView.svelte`
- Modify: `src/components/ListView.svelte`
- Modify: `src/components/SchoolRow.svelte`
- Rename: `src/data/schools.json` to `src/data/legacy-schools.json`
- Create: `tests/filter.test.ts`

- [ ] **Step 1: Write failing stable-key and sorting tests**

Create `tests/filter.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { applyFilters, deriveSchool, rowKey } from '../src/lib/filter';
import { feedCatalog, isValidFeedId } from '../src/lib/schools';

test('uses projectId as the stable row key', () => {
  assert.equal(rowKey({ projectId: 'cycle|school|college|round' }), 'cycle|school|college|round');
});

test('accepts a newly published feed without changing a hardcoded source union', () => {
  assert.equal(isValidFeedId('camp2027'), true);
  assert.equal(feedCatalog.some((feed) => feed.id === 'camp2027'), true);
});

test('sorts active deadlines before unknown and expired rows', () => {
  const now = Date.parse('2026-07-15T00:00:00+08:00');
  const rows = [unknown, later, expired, sooner].map((row) => deriveSchool(row, now));
  assert.deepEqual(applyFilters(rows, emptyFilters).map((row) => row.projectId), [
    sooner.projectId,
    later.projectId,
    unknown.projectId,
    expired.projectId,
  ]);
});
```

- [ ] **Step 2: Run tests to prove current behavior is insufficient**

```bash
pnpm run test:unit
```

Expected: FAIL because `rowKey` and enriched fields do not exist.

- [ ] **Step 3: Add the approved-data alias**

In `vite.config.ts` add:

```ts
$approved: path.resolve('data/approved'),
```

- [ ] **Step 4: Extend the UI type without duplicating the snapshot contract**

In `src/lib/types.ts`, make `School` extend `PublicOpportunity` and retain UI-only optional tags as needed. Replace the hardcoded `Source` union with `export type FeedId = string`; `FilterState.source` becomes `FeedId`. `DerivedSchool` must retain `deadlineEpochMs`, `remainingMs` and urgency without reparsing a date-only string.

- [ ] **Step 5: Load approved current rows and legacy archives**

Move the upstream snapshot only when the replacement loader is implemented in the same commit:

```bash
git mv src/data/schools.json src/data/legacy-schools.json
```

In `src/lib/schools.ts`:

```ts
import approved from '$approved/current.json';
import legacy from '$data/legacy-schools.json';

const snapshot = approved as PublicSnapshot;

export const feedCatalog: FeedDescriptor[] = [
  ...snapshot.feeds,
  ...legacyFeedDescriptors(snapshot.feeds, legacy),
];
export const defaultFeedId: FeedId = snapshot.defaultFeedId;
export const schoolsByFeed: Record<FeedId, School[]> = buildSchoolsByFeed(snapshot, legacy);

export function isValidFeedId(value: string): value is FeedId {
  return feedCatalog.some((feed) => feed.id === value);
}
```

`sourceCounts()` iterates `feedCatalog`; it must not contain a literal list of years. `Header.svelte` renders the feed selector from `feedCatalog`, while `urlState.svelte.ts` validates query values through `isValidFeedId()` and falls back to `defaultFeedId`. Legacy rows pass through a compatibility mapper that generates ``legacy|${feedId}|${name}|${institute}|${index}`` IDs and marks unavailable enriched fields `unverified`.

- [ ] **Step 6: Stop reparsing approved deadlines**

`deriveSchool()` uses `deadlineEpochMs` when present. Only the legacy compatibility mapper may call `parseDeadline()`.

Expose:

```ts
export function rowKey(row: Pick<School, 'projectId'>): string {
  return row.projectId;
}
```

- [ ] **Step 7: Replace compound keys in components**

Replace every `${name}::${institute}` and keyed-each expression with `row.projectId`. Verify `App.svelte`, `ListView.svelte`, `SchoolRow.svelte` and `CalendarView.svelte` use the same helper.

- [ ] **Step 8: Run tests, type check and build**

```bash
pnpm run test:unit
pnpm run check
pnpm run build
```

Expected: tests pass, Svelte reports 0 errors and warnings, Vite exits 0.

- [ ] **Step 9: Commit the data switch**

```bash
git add vite.config.ts src/lib src/data/legacy-schools.json src/App.svelte src/components/Header.svelte src/components/CalendarView.svelte src/components/ListView.svelte src/components/SchoolRow.svelte tests/filter.test.ts
git commit -m "feat: render approved snapshot data"
```

## Task 6: Add Verification Details Without Redesigning The UI

**Files:**
- Modify: `src/components/ListView.svelte`
- Modify: `src/components/SchoolRow.svelte`
- Modify: `src/components/DetailPanel.svelte`
- Modify: `src/app.css`

- [ ] **Step 1: Preserve the three public groups**

Keep the existing actionable, unknown-deadline and expired grouping. The public snapshot must contain no pending or WAF rows:

```ts
const active = rows.filter((row) => row.verificationStatus === 'confirmed-open');
const unknown = rows.filter((row) => row.verificationStatus === 'confirmed-unknown-deadline');
const expired = rows.filter((row) => row.verificationStatus === 'expired');
```

Render these as `进行中`, `未知截止` and `已过期`, preserving the upstream list density and order.

- [ ] **Step 2: Add compact verification badges**

`SchoolRow.svelte` displays one compact badge:

- `已核验` for confirmed statuses.
- `已过期` for expired.

Do not add new cards, nested cards, marketing text or a hero section.

- [ ] **Step 3: Extend the detail panel**

Add unframed sections in this order:

1. 截止信息: original text, normalized time, verified time.
2. 食宿与交通: `logistics.summary` and its fact status.
3. 推荐信: `recommendation.summary`.
4. 材料: `materials.summary`.
5. 信息来源: official link first, discovery links after it.

Official CTA remains the primary footer action. Discovery links use secondary text links with `rel="noopener noreferrer"`.

- [ ] **Step 4: Guard long text and narrow screens**

Use `overflow-wrap:anywhere`, normal letter spacing and responsive grid constraints. Do not scale font size with viewport width. Preserve the existing 460px desktop drawer and full-width mobile drawer.

- [ ] **Step 5: Run static checks**

```bash
pnpm run check
pnpm run build
```

Expected: zero Svelte errors/warnings and successful production build.

- [ ] **Step 6: Commit the enriched detail view**

```bash
git add src/components/ListView.svelte src/components/SchoolRow.svelte src/components/DetailPanel.svelte src/app.css
git commit -m "feat: show verification and application facts"
```

## Task 7: Add CI And Repository Leak Gates

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `scripts/check-public.sh`
- Modify: `package.json`

- [ ] **Step 1: Add a privacy leak checker**

Create `scripts/check-public.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

if test -n "$(git ls-files 'data/staging/*.json')"; then
  printf '%s\n' 'tracked staging JSON is forbidden' >&2
  exit 1
fi

test ! -e public/CNAME
test ! -e .github/workflows/update_json.yml

if git grep -n -E 'submittedProjectIds|targets/submitted|welfareScore|cityPlatformValue|socialValue|recommendationTier|profile_space/targets|/Users/|[[:alnum:]._%+-]+@[[:alnum:].-]+\.[[:alpha:]]{2,}|1[3-9][0-9]{9}' -- data src public; then
  printf '%s\n' 'private data found in public build inputs' >&2
  exit 1
fi
```

Add the package script:

```json
{
  "check:public": "bash scripts/check-public.sh"
}
```

This gate inspects tracked public build inputs. Private staging JSON is ignored by Git and must never be force-added.

- [ ] **Step 2: Create the CI workflow**

`.github/workflows/ci.yml` must run on pull requests and pushes to `main`:

```yaml
name: CI

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 10
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm run test:unit
      - run: pnpm run snapshot:validate
      - run: pnpm run check:public
      - run: pnpm run check
      - run: pnpm run build
      - uses: actions/upload-artifact@v4
        with:
          name: dist
          path: dist
          if-no-files-found: error
```

- [ ] **Step 3: Run the exact CI sequence locally**

```bash
pnpm install --frozen-lockfile
pnpm run test:unit
pnpm run snapshot:validate
pnpm run check:public
pnpm run check
pnpm run build
```

Expected: every command exits 0.

- [ ] **Step 4: Commit CI**

```bash
git add package.json scripts/check-public.sh .github/workflows/ci.yml
git commit -m "ci: validate snapshots and public build"
```

## Task 8: Add Tencent Static Deployment And Rollback

**Files:**
- Modify: `.github/workflows/deploy.yml`
- Create: `deploy/nginx/cs-baoyan-ddl.conf`
- Create: `deploy/bootstrap-server.sh`
- Create: `deploy/smoke.sh`
- Create: `docs/operations/tencent-deploy.md`
- Create: `docs/operations/rollback.md`

- [ ] **Step 1: Create the Nginx config**

`deploy/nginx/cs-baoyan-ddl.conf`:

```nginx
server {
    listen 80;
    server_name _;
    root /srv/cs-baoyan-ddl/current;
    index index.html;

    location /assets/ {
        try_files $uri =404;
        add_header Cache-Control "public, max-age=31536000, immutable" always;
    }

    location / {
        try_files $uri $uri/ /index.html;
        add_header Cache-Control "no-cache" always;
    }

    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
}
```

TLS termination may be added only after the actual domain and certificate path are confirmed.

- [ ] **Step 2: Create the idempotent server bootstrap**

`deploy/bootstrap-server.sh` accepts `DEPLOY_USER` and creates:

```bash
command -v python3 >/dev/null
command -v curl >/dev/null
sudo install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" /srv/cs-baoyan-ddl/releases
sudo install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" /srv/cs-baoyan-ddl/shared
sudo install -m 0644 deploy/nginx/cs-baoyan-ddl.conf /etc/nginx/conf.d/cs-baoyan-ddl.conf
sudo nginx -t
sudo systemctl reload nginx
```

The script must not modify firewall, SSH daemon, DNS or TLS settings.

- [ ] **Step 3: Create the smoke script**

`deploy/smoke.sh` accepts a URL and checks:

```bash
URL=${1%/}
curl --fail --silent --show-error --location "$URL/" | rg -q 'CS 保研 DDL'
ASSET_PATH=$(curl --fail --silent --show-error --location "$URL/" | sed -n 's/.*src="\([^\"]*\/assets\/[^\"]*\.js\)".*/\1/p' | head -1)
test -n "$ASSET_PATH"
curl --fail --silent --show-error --head "$URL$ASSET_PATH" >/dev/null
```

- [ ] **Step 4: Replace the Pages workflow with Tencent deploy**

Replace `.github/workflows/deploy.yml` with:

```yaml
name: Deploy Tencent

on:
  workflow_run:
    workflows: [CI]
    types: [completed]
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: production-deploy
  cancel-in-progress: false

jobs:
  deploy:
    if: github.event_name == 'workflow_dispatch' || github.event.workflow_run.conclusion == 'success'
    runs-on: ubuntu-latest
    environment: production
    env:
      RELEASE_SHA: ${{ github.event_name == 'workflow_run' && github.event.workflow_run.head_sha || github.sha }}
      SSH_HOST: ${{ secrets.TENCENT_HOST }}
      SSH_PORT: ${{ secrets.TENCENT_PORT }}
      SSH_USER: ${{ secrets.TENCENT_USER }}
      PUBLIC_BASE_URL: ${{ vars.PUBLIC_BASE_URL }}
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ env.RELEASE_SHA }}
      - uses: pnpm/action-setup@v4
        with:
          version: 10
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm run test:unit
      - run: pnpm run snapshot:validate
      - run: pnpm run check:public
      - run: pnpm run check
      - run: pnpm run build
      - name: Configure pinned SSH host
        shell: bash
        env:
          SSH_KEY: ${{ secrets.TENCENT_SSH_KEY }}
          KNOWN_HOSTS: ${{ secrets.TENCENT_KNOWN_HOSTS }}
        run: |
          install -d -m 0700 ~/.ssh
          printf '%s\n' "$SSH_KEY" > ~/.ssh/deploy_key
          chmod 0600 ~/.ssh/deploy_key
          printf '%s\n' "$KNOWN_HOSTS" > ~/.ssh/known_hosts
          chmod 0600 ~/.ssh/known_hosts
      - name: Upload release archive
        shell: bash
        run: |
          tar -C dist -czf "release-${RELEASE_SHA}.tar.gz" .
          scp -i ~/.ssh/deploy_key -P "$SSH_PORT" \
            "release-${RELEASE_SHA}.tar.gz" \
            "$SSH_USER@$SSH_HOST:/tmp/release-${RELEASE_SHA}.tar.gz"
      - name: Switch release atomically
        id: switch
        shell: bash
        run: |
          ssh -i ~/.ssh/deploy_key -p "$SSH_PORT" "$SSH_USER@$SSH_HOST" \
            "RELEASE_SHA='$RELEASE_SHA' bash -se" <<'REMOTE'
          set -euo pipefail
          root=/srv/cs-baoyan-ddl
          archive="/tmp/release-${RELEASE_SHA}.tar.gz"
          release="$root/releases/$RELEASE_SHA"
          previous=$(readlink -f "$root/current" || true)
          install -d "$release" "$root/shared"
          tar -xzf "$archive" -C "$release"
          test -s "$release/index.html"

          port=18080
          python3 -m http.server "$port" --bind 127.0.0.1 --directory "$release" \
            >"/tmp/cs-baoyan-ddl-${RELEASE_SHA}.log" 2>&1 &
          server_pid=$!
          cleanup() { kill "$server_pid" 2>/dev/null || true; }
          trap cleanup EXIT
          for attempt in 1 2 3 4 5; do
            curl --fail --silent --show-error "http://127.0.0.1:${port}/" > /tmp/release-index.html && break
            sleep 1
          done
          grep -q 'CS 保研 DDL' /tmp/release-index.html
          asset=$(sed -n 's/.*src="\([^"]*\/assets\/[^"]*\.js\)".*/\1/p' /tmp/release-index.html | head -1)
          test -n "$asset"
          curl --fail --silent --show-error --head "http://127.0.0.1:${port}${asset}" >/dev/null
          cleanup
          trap - EXIT

          switched=0
          switch_ok=0
          rollback_on_exit() {
            if test "$switched" = 1 && test "$switch_ok" != 1; then
              if test -n "$previous" && test -d "$previous"; then
                ln -sfn "$previous" "$root/current.next"
                mv -Tf "$root/current.next" "$root/current"
              else
                rm -f "$root/current"
              fi
            fi
          }
          trap rollback_on_exit EXIT
          printf '%s\n' "$previous" > "$root/shared/previous-release"
          ln -sfn "$release" "$root/current.next"
          mv -Tf "$root/current.next" "$root/current"
          switched=1
          curl --fail --silent --show-error http://127.0.0.1/ > /tmp/nginx-index.html
          grep -q 'CS 保研 DDL' /tmp/nginx-index.html
          rm -f "$archive"
          switch_ok=1
          trap - EXIT
          REMOTE
      - name: Verify attempted release and compensate
        if: ${{ always() && steps.switch.outcome != 'skipped' }}
        shell: bash
        env:
          SWITCH_OUTCOME: ${{ steps.switch.outcome }}
        run: |
          expected="/srv/cs-baoyan-ddl/releases/$RELEASE_SHA"
          served=$(ssh -i ~/.ssh/deploy_key -p "$SSH_PORT" "$SSH_USER@$SSH_HOST" \
            'readlink -f /srv/cs-baoyan-ddl/current 2>/dev/null || true')
          if test "$SWITCH_OUTCOME" = success && test "$served" = "$expected" \
            && bash deploy/smoke.sh "$PUBLIC_BASE_URL"; then
            exit 0
          fi
          ssh -i ~/.ssh/deploy_key -p "$SSH_PORT" "$SSH_USER@$SSH_HOST" \
            "RELEASE_SHA='$RELEASE_SHA' bash -se" <<'REMOTE'
          set -euo pipefail
          root=/srv/cs-baoyan-ddl
          release="$root/releases/$RELEASE_SHA"
          previous=$(cat "$root/shared/previous-release" 2>/dev/null || true)
          current=$(readlink -f "$root/current" 2>/dev/null || true)
          if test "$current" = "$release"; then
            if test -n "$previous" && test -d "$previous"; then
              ln -sfn "$previous" "$root/current.next"
              mv -Tf "$root/current.next" "$root/current"
            else
              rm -f "$root/current"
            fi
          fi
          REMOTE
          exit 1
```

Configure these five repository environment secrets:

```text
TENCENT_HOST
TENCENT_PORT
TENCENT_USER
TENCENT_SSH_KEY
TENCENT_KNOWN_HOSTS
```

Configure `PUBLIC_BASE_URL` as a non-secret `production` environment variable. The compensation step runs even when the switch step fails: it verifies the actual `current` target, removes a failed first-release link when no previous release exists, and restores the recorded previous release on later failures.

- [ ] **Step 5: Write deployment and rollback operations docs**

`docs/operations/tencent-deploy.md` records one-time bootstrap, GitHub Secret names, least-privilege SSH user, Nginx test and external smoke test. `docs/operations/rollback.md` uses:

```bash
readlink -f /srv/cs-baoyan-ddl/current
ls -1dt /srv/cs-baoyan-ddl/releases/*
select VERIFIED_RELEASE in $(ls -1dt /srv/cs-baoyan-ddl/releases/*); do
  test -n "$VERIFIED_RELEASE" && test -d "$VERIFIED_RELEASE" && break
done
ln -sfn "$VERIFIED_RELEASE" /srv/cs-baoyan-ddl/current.next
mv -Tf /srv/cs-baoyan-ddl/current.next /srv/cs-baoyan-ddl/current
curl --fail http://127.0.0.1/
```

The operator must select a concrete release directory from the displayed list; the script does not guess a rollback target.

- [ ] **Step 6: Validate shell and workflow syntax locally**

```bash
bash -n deploy/bootstrap-server.sh deploy/smoke.sh
ruby -e 'require "yaml"; YAML.load_file(".github/workflows/deploy.yml")'
pnpm run build
```

Expected: shell syntax passes and production build exits 0. Do not connect to Tencent Cloud in this step.

- [ ] **Step 7: Commit deploy tooling**

```bash
git add .github/workflows/deploy.yml deploy docs/operations/tencent-deploy.md docs/operations/rollback.md
git commit -m "feat: add atomic tencent deployment"
```

## Task 9: Add Browser Verification

**Files:**
- Create: `playwright.config.ts`
- Create: `e2e/ddl.spec.ts`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/deploy.yml`

- [ ] **Step 1: Add Playwright test tooling**

Run:

```bash
pnpm add -D @playwright/test
pnpm exec playwright install chromium
```

Add:

```json
{
  "test:e2e": "playwright test"
}
```

- [ ] **Step 2: Configure the local preview server**

`playwright.config.ts`:

```ts
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  outputDir: 'test-results',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'pnpm run build && pnpm run preview -- --host 127.0.0.1',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', use: { ...devices['iPhone 13'], viewport: { width: 390, height: 844 } } },
  ],
});
```

- [ ] **Step 3: Write core E2E behavior**

`e2e/ddl.spec.ts` verifies:

```ts
test('lists projects in deadline order and opens verified details', async ({ page }) => {
  await page.goto('/');
  const rows = page.locator('[data-row-key]');
  await expect(rows.first()).toBeVisible();
  const deadlines = await rows.evaluateAll((nodes) => nodes
    .map((node) => node.getAttribute('data-deadline-ms'))
    .filter((value): value is string => value !== null && value !== '')
    .map(Number)
    .filter(Number.isFinite));
  expect(deadlines).toEqual([...deadlines].sort((a, b) => a - b));
  await rows.first().click();
  await expect(page.getByRole('dialog', { name: '项目详情' })).toBeVisible();
  await expect(page.getByRole('link', { name: /打开官网/ })).toHaveAttribute('href', /^https?:\/\//);
});

test('mobile filters do not create horizontal overflow', async ({ page }) => {
  await page.goto('/');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(overflow).toBe(false);
});
```

Add `data-deadline-ms` to `SchoolRow.svelte` for deterministic verification.

- [ ] **Step 4: Make browser verification a production gate**

Append these steps to both the CI `verify` job and the Tencent `deploy` job after the production build:

```yaml
      - run: pnpm exec playwright install --with-deps chromium
      - run: pnpm run test:e2e
```

The Tencent deployment workflow triggers only after this complete CI job succeeds, and manual dispatch re-runs the same browser gate. It must never depend on a build-only job or permit manual dispatch to bypass E2E.

- [ ] **Step 5: Run desktop and mobile E2E**

```bash
pnpm run test:e2e
```

Expected: both projects pass. Inspect any retained screenshot or trace before modifying code.

- [ ] **Step 6: Commit E2E coverage**

```bash
git add package.json pnpm-lock.yaml playwright.config.ts e2e src/components/SchoolRow.svelte .github/workflows/ci.yml .github/workflows/deploy.yml
git commit -m "test: cover desktop and mobile ddl flows"
```

## Task 10: Import And Approve The First Real Snapshot

**Files:**
- Modify: `data/approved/current.json`
- Create: `data/staging/candidate.json`
- Create: `data/staging/diff.json`
- Create: `docs/operations/data-refresh.md`

- [ ] **Step 1: Select a fresh Skill output**

Run `scan-cs-admissions-events` at the current Beijing time. Resolve the newest generated data file deterministically and inspect the printed path. Do not reuse the 2026-07-15 snapshot if implementation occurs on a later date.

```bash
SCOUTING_JSON=$(find /Users/maxwellbrooks/Workspace/profile_space/outputs -type f -name 'workbook_data_*.json' -exec stat -f '%m\t%N' {} + | sort -nr | head -1 | cut -f2-)
test -n "$SCOUTING_JSON"
printf '%s\n' "$SCOUTING_JSON"
```

- [ ] **Step 2: Import the candidate**

```bash
pnpm run snapshot:import -- \
  --input "$SCOUTING_JSON" \
  --approved data/approved/current.json \
  --aliases data/project-id-aliases.json \
  --output data/staging/candidate.json
```

Expected: the command prints counts for confirmed, `pendingExcluded` and expired rows and exits 0. No pending row appears in the public `opportunities` array.

- [ ] **Step 3: Review the deterministic diff**

```bash
pnpm run snapshot:diff -- \
  --previous data/approved/current.json \
  --next data/staging/candidate.json \
  --output data/staging/diff.json
```

Manually inspect every added or changed record with a deadline within 72 hours and every removal. A removal requires official closure, expiry or an explicit correction; absence from an aggregator is insufficient.

- [ ] **Step 4: Approve the candidate**

```bash
pnpm run snapshot:approve -- \
  --candidate data/staging/candidate.json \
  --approved data/approved/current.json
```

Expected: atomic replacement succeeds and `previousSnapshotId` points to the prior fixture or approved snapshot.

- [ ] **Step 5: Write the refresh runbook**

`docs/operations/data-refresh.md` records:

- Run the scan at least every two hours from 08:00 to 24:00 Beijing time during peak admission season, plus one overnight scan.
- Aggregator discovery never bypasses official verification.
- Import writes staging only.
- Review all under-72-hour changes before approval.
- Merge to `main` is the publication approval.
- A failed scan or empty candidate never replaces the current approved snapshot.
- Public data excludes pending/WAF row details, personal application status and local paths.
- New feed IDs and labels come from the approved snapshot; adding a cycle never requires a `types.ts` edit.

- [ ] **Step 6: Run the full release gate**

```bash
pnpm run test:unit
pnpm run snapshot:validate
pnpm run check:public
pnpm run check
pnpm run build
pnpm run test:e2e
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 7: Commit the first real snapshot**

```bash
git add data/approved/current.json docs/operations/data-refresh.md
git commit -m "data: publish first verified snapshot"
```

Verify `git status --short --ignored data/staging` shows `candidate.json` and `diff.json` as ignored. Never use `git add -f` on either file.

## Task 11: Configure GitHub And Tencent Release

**Files:**
- No source changes unless verification finds a concrete issue.

- [ ] **Step 1: Push the implementation branch**

```bash
git push -u origin codex/live-data-pipeline
```

- [ ] **Step 2: Open a draft pull request**

```bash
gh pr create \
  --repo lvzaixian/CS-BAOYAN-DDL \
  --base main \
  --head codex/live-data-pipeline \
  --draft \
  --title "Build a verified and timely CS admissions DDL" \
  --body $'## Summary\n- Replace direct BoardCaster publishing with an official-evidence approval boundary.\n- Preserve the upstream UI while adding dynamic feeds and stable project IDs.\n- Add privacy gates, CI, browser verification, and atomic Tencent deployment tooling.\n\n## Verification\n- pnpm run test:unit\n- pnpm run snapshot:validate\n- pnpm run check:public\n- pnpm run check\n- pnpm run build\n- pnpm run test:e2e\n\n## Deployment state\nTencent production changes remain blocked until the host, domain, ICP, TLS, Nginx, and release paths are verified.'
```

The body must list the data boundary, test evidence, deployment state and unverified Tencent facts.

- [ ] **Step 3: Confirm GitHub CI before merge**

```bash
gh pr checks --repo lvzaixian/CS-BAOYAN-DDL --watch
```

Expected: CI passes. Do not merge while any required check fails.

- [ ] **Step 4: Inspect Tencent assets before external changes**

Read-only confirm the actual host, SSH port, deployment user, Nginx installation, domain, ICP status, certificate and current occupied paths. Stop before changing security groups, SSH daemon, DNS, certificates or production Nginx without explicit user confirmation.

- [ ] **Step 5: Bootstrap the release directory after confirmation**

Run `deploy/bootstrap-server.sh` on the confirmed host with the least-privilege deployment user, then verify `nginx -t` and local HTTP response.

- [ ] **Step 6: Configure GitHub environment secrets**

Create a protected `production` environment, set only the five secrets and one `PUBLIC_BASE_URL` variable documented in Task 8, and require manual approval for the first production deployment.

- [ ] **Step 7: Merge and verify production**

After user approval, merge the PR, watch the deploy workflow, run `deploy/smoke.sh "$PUBLIC_BASE_URL"`, and record the served commit and snapshot ID. The first successful release has no previous target; perform the rollback drill immediately after the second successful release, then restore the newer verified release.

## Final Acceptance Checklist

- [ ] Upstream MIT license and attribution remain present.
- [ ] `origin` is `lvzaixian/CS-BAOYAN-DDL`; upstream push is disabled.
- [ ] Upstream CNAME and BoardCaster overwrite workflow are absent.
- [ ] Public current data comes only from `data/approved/current.json`.
- [ ] Every actionable row has a stable `projectId` and official source.
- [ ] Active deadlines are ascending; unknown and expired rows are separated.
- [ ] Pending/WAF rows are absent from the public opportunity array and represented only by `counts.pendingExcluded`.
- [ ] A newly approved feed becomes selectable without changing a hardcoded source union or year list.
- [ ] No submitted-project IDs, personal scores, local paths or credentials are committed.
- [ ] Unit tests, snapshot validation, leak check, Svelte check, build and E2E pass.
- [ ] Tencent release uses version directories and atomic symlink switching; rollback is tested once a second verified release exists.
- [ ] Production serves the expected commit and snapshot ID over HTTPS when the domain is configured.
