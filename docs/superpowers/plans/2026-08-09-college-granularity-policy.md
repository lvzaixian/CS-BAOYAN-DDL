# College-Level Admissions Entries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the tracked project policy require every future public admissions addition to represent one official, independently applicable college-level recruiting unit.

**Architecture:** Change only the tracked repository `AGENTS.md`. Add the rule once to the non-negotiable daily principles and once to the source/deep-scan contract, where it defines the fan-out, evidence, and private-retry behavior. Preserve historical parent entries because the additive approval path may not rewrite them.

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
  5. 学院级公开粒度：每个新增项必须对应一个官方明确可投的具体单位；`name` 记录学校或独立机构，`institute` 记录一个学院、系、研究院、国际学院、联合培养单位或其他官方招生单位。校级总通知和“全校/全院系/各学院/校级入口/招生系统级”等容器只用于发现与证据，不得成为新增公开条目。
  ```

- [x] **Step 2: Add the detailed fan-out and failure contract under source/deep scanning**

  Insert a `### 学院级条目拆分` subsection after the existing deep-scan paragraph. It must require `projectId` to use the school and unit fields, derive unit-name variants only from the most-specific current-year official application source, split an official notice across all explicitly named eligible units, retain a same-run official proof for each unit, and place unresolvable generic notices or unproven name equivalences in private retry without guessing. It must allow an independent graduate school or institute only when it is itself the official smallest application unit and has no listed child unit.

- [x] **Step 3: Preserve append-only compatibility explicitly**

  Add a final sentence to the subsection stating that existing parent entries are untouched by daily additions; splitting or correcting historical generic entries is a separately authorized maintenance migration.

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
  git add AGENTS.md docs/superpowers/plans/2026-08-09-college-granularity-policy.md
  git commit -m "docs: require college-level admissions entries"
  ```
