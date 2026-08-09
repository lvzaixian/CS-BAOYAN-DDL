# College-Level Admissions Entries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the tracked project policy require every future public admissions addition to represent one official, independently applicable college-level recruiting unit.

**Architecture:** Align the tracked policy stack: `AGENTS.md` defines the non-negotiable daily rule and source/deep-scan behavior; `docs/operations/data-refresh.md` records the corresponding daily run/input contract; this design document records scope and future enforcement limits. These documents preserve historical parent entries and do not claim a schema or approver-code change; machine enforcement remains a separate future change.

**Tech Stack:** Markdown policy document; Git diff validation.

---

### Task 1: State and operationalize the college-level rule

**Files:**
- Modify: `AGENTS.md:7-13`
- Modify: `AGENTS.md:45-49`
- Test: policy-text inspection and `git diff --check`

- [x] **Step 1: Add the non-negotiable public-entry granularity principle**

  Change the introductory list from four to five rules and append this requirement:

  ```markdown
  5. 学院级公开粒度：每个新增项必须对应一个官方明确可投的具体单位；`name` 记录学校或独立办学机构，`institute` 记录一个学院、系、研究院、国际学院、联合培养单位或其他官方招生单位的完整官方名称。校级总通知和“全校/全院系/各学院/校级入口/招生系统级”等容器只用于发现与证据，不得成为新增公开条目。
  ```

- [x] **Step 2: Add the detailed fan-out and failure contract under source/deep scanning**

  Insert a `### 学院级条目拆分` subsection after the existing deep-scan paragraph. It must require `projectId` to use the school and unit fields, derive unit-name variants only from the most-specific current-year official application source, split an official notice across all explicitly named eligible units, retain a same-run official proof for each unit, and place unresolvable generic notices or unproven name equivalences in private retry without guessing. Every candidate `institute` class must pass the same official smallest applicable recruiting-unit test, including independent graduate schools and research institutes.

- [x] **Step 3: Preserve append-only compatibility explicitly**

  Add compatibility sentences stating that an immutable same-cycle, same-school historical generic parent does not substitute for a college identity, while a specifically evidenced unit-level addition may coexist with it. Daily work cannot hide, delete, downgrade, split, or migrate that parent; its maintenance requires separate user authorization.

- [x] **Step 4: Validate the wording and scope**

  Run:

  ```bash
  rg -n "学院级公开粒度|学院级条目拆分|名称变体|全校/全院系|历史父项" AGENTS.md
  git diff --check
  git diff -- AGENTS.md
  ```

  Expected: both a high-level rule and a detailed operational contract are present; the diff changes only `AGENTS.md`; whitespace validation passes.

- [x] **Step 5: Commit the policy update**

  ```bash
  git add AGENTS.md
  git commit -m "docs: require college-level admissions entries"
  ```

### Task 2: Align the operational contract and design record

**Files:**
- Modify: `AGENTS.md:50-52`
- Modify: `docs/operations/data-refresh.md` under `## 每日发现与深挖`
- Modify: `docs/superpowers/specs/2026-08-09-college-granularity-policy-design.md`
- Modify: `docs/superpowers/plans/2026-08-09-college-granularity-policy.md`
- Test: policy-text inspection, public check, and range diff validation

- [x] **Step 1: Generalize the smallest-unit and historical-parent rules**

  Apply the same official smallest applicable recruiting-unit test to every `institute` taxonomy class, including independent graduate schools and research institutes. A same-cycle, same-school historical generic parent remains immutable; a specifically evidenced unit-level addition may coexist with it, while daily work may not hide, delete, downgrade, split, or migrate that parent.

- [x] **Step 2: Record the daily input/policy contract in the refresh guide**

  Add a clearly titled college-level contract for `name`, `institute`, and `projectId`, official unit fan-out, same-run evidence, private handling of unresolved scopes/name equivalence, the uniform smallest-unit condition, and historical-parent coexistence. State that this is documentation/run-input policy, not current machine enforcement.

- [x] **Step 3: Align the design decision and compatibility boundary**

  Expand the `name` and `institute` taxonomy, add the uniform smallest-unit condition, describe generic-parent coexistence, and retain the note that schema/approver enforcement requires a separate future change.

- [x] **Step 4: Validate and commit the documentation-only alignment**

  ```bash
  rg -n "学院级|招生系统级|最小适用招生单位|历史通用父项|独立办学机构" AGENTS.md docs/operations/data-refresh.md docs/superpowers/specs/2026-08-09-college-granularity-policy-design.md docs/superpowers/plans/2026-08-09-college-granularity-policy.md
  git diff --check origin/main...HEAD
  corepack pnpm@10.28.2 run check:public
  git diff --name-only origin/main...HEAD
  git add AGENTS.md docs/operations/data-refresh.md docs/superpowers/specs/2026-08-09-college-granularity-policy-design.md docs/superpowers/plans/2026-08-09-college-granularity-policy.md
  git commit -m "docs: align college entry refresh contract"
  ```
