# College-Level Admissions Entries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Require every future public admissions addition to represent one official, independently applicable college-level recruiting unit, and keep the bounded additions-only approver guard aligned with that policy.

**Architecture:** `AGENTS.md` defines the non-negotiable daily rule and source/deep-scan behavior; `docs/operations/data-refresh.md` records the daily run/input contract; the design document records the implemented boundary and its limits. `7593f2a` added the additions-only identity/umbrella-label gate, `d88e3f8` hardened format-control handling, and `a2a3182` adopted an inspection-only punctuation/symbol skeleton plus office/unqualified-graduate-school checks. The policy stack and code preserve immutable historical parent/replay inputs; the gate is not a substitute for scanner fan-out or a semantic proof of complete unit coverage.

**Tech Stack:** Markdown policy documents; TypeScript additive approver; focused Node tests; public/diff validation.

---

### Task 1: State and operationalize the college-level rule

**Files:**
- Modify: `AGENTS.md:7-13`
- Modify: `AGENTS.md:45-49`
- Test: policy-text inspection and `git diff --check`

- [x] **Step 1: Add the non-negotiable public-entry granularity principle**

  Change the introductory list from four to five rules and append this requirement:

  ```markdown
  5. 学院级公开粒度：每个新增项必须对应一个官方明确可投的具体单位；`name` 记录学校或独立办学机构，`institute` 记录一个学院、系、研究院、国际学院、联合培养单位或其他官方招生单位的完整官方名称。校级总通知和“全校/全院系/各学院/各院系/校级（包括学校级）/招生系统/报名系统/系统级”等容器只用于发现与证据，不得成为新增公开条目。
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

  Add a clearly titled college-level contract for `name`, `institute`, and `projectId`, official unit fan-out, same-run evidence, private handling of unresolved scopes/name equivalence, the uniform smallest-unit condition, historical-parent coexistence, and the actual additions-only machine gate. State its exact narrow scope rather than describing it as policy-only.

- [x] **Step 3: Align the design decision and compatibility boundary**

  Expand the `name` and `institute` taxonomy, add the uniform smallest-unit condition, describe generic-parent coexistence, and record the additions-only approver enforcement plus its remaining scanner/semantic limits.

- [x] **Step 4: Validate and commit the contract alignment**

  ```bash
  rg -n "学院级|招生系统级|最小适用招生单位|历史通用父项|独立办学机构" AGENTS.md docs/operations/data-refresh.md docs/superpowers/specs/2026-08-09-college-granularity-policy-design.md docs/superpowers/plans/2026-08-09-college-granularity-policy.md
  git diff --check origin/main...HEAD
  corepack pnpm@10.28.2 run check:public
  git diff --name-only origin/main...HEAD
  git add AGENTS.md docs/operations/data-refresh.md docs/superpowers/specs/2026-08-09-college-granularity-policy-design.md docs/superpowers/plans/2026-08-09-college-granularity-policy.md
  git commit -m "docs: align college entry refresh contract"
  ```

### Task 3: Add bounded machine enforcement for daily additions

**Files:**
- Modify: `scripts/snapshot/approve-snapshot.ts`
- Modify: `tests/approve-additive-snapshot.test.ts`
- Documentation sync: `AGENTS.md`, `docs/operations/data-refresh.md`, and this design record

- [x] **Step 1: Add an additions-only college identity gate**

  In `7593f2a`, require each addition to have four non-empty `projectId` segments and exact `projectId` name/institute equality with the public object. Reject the configured explicit whole-school, all-department, school-level, and admissions-system labels before a release decision or public write. The gate does not run against historical parent rows or historical replay inputs.

- [x] **Step 2: Harden the explicit-label normalization**

  In `d88e3f8`, reject Unicode `Cf` format controls in `institute` and cover typographic-dash bypasses. This is an intermediate hardening step, not a claim that every possible semantic or Unicode variant is classified.

- [x] **Step 3: Add a bounded office/graduate-school semantic guard**

  In `a2a3182`, compare an inspection-only `institute` skeleton (NFKD, remove Unicode `White_Space`/`Punctuation`/`Symbol`/`Mark`, lowercase). Reject configured umbrella/system and office labels plus only an exact unqualified graduate-school skeleton (`研究生院` or `${skeleton(name)}研究生院`); preserve qualified values such as `新增测试大学深圳国际研究生院` for normal evidence and identity validation. Public fields remain unmodified.

- [x] **Step 4: Add focused regression coverage**

  Add cases for normalized umbrella/system/office labels, malformed or mismatched `projectId`, preservation of historical umbrella and graduate-school parents, a valid concrete-college addition, a qualified graduate-school addition, Unicode format controls, and punctuation/symbol/combining-mark variants. The completed milestone is focused code-and-test coverage, not a declaration that the full suite or release path has completed.

### Follow-on deliberately not claimed by this milestone

- [ ] A scanner still must recursively fan out official pages, systems, attachments, and enumerated units. The approver cannot infer undisclosed downstream units or prove an opaque source has complete fan-out.
- [ ] Full unit/build/E2E suites, release integration, deployment, and public smoke remain separate verification scopes; this documentation/code milestone does not mark them complete.
