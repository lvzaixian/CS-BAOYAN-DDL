# Event Arrangement And Launch Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task with spec review before code-quality review.

**Goal:** Add trustworthy online/offline/hybrid activity information end to end, remove misleading empty UI, rebuild the approved public snapshot, and re-establish full launch-readiness evidence.

**Architecture:** Extend the strict approved-snapshot contract with a required nested event-arrangement object. Classify mode deterministically from the official form/location field only, preserve source wording as fact groups, expose the normalized mode through list/detail/filter/URL surfaces, and migrate the unlaunched snapshot atomically.

**Tech Stack:** Svelte 5, TypeScript, Node.js 20, pnpm 10.28.2, Lucide Svelte, Playwright, strict JSON validation, approved static snapshots.

---

### Task 1: Freeze Contract And Migration Tests

**Files:**
- Modify: `tests/fixtures/scouting-valid.json`
- Modify: `tests/fixtures/snapshot-valid.json`
- Modify: `tests/import-scouting-data.test.ts`
- Modify: `tests/snapshot-validation.test.ts`
- Modify: `tests/approve-snapshot.test.ts`
- Modify: `tests/diff-snapshots.test.ts`

- [ ] Add failing tests for all four mode outcomes, exact source-text retention, sparse rows, required shape, invalid enums, extra keys, canonical hashing, and diff visibility.
- [ ] Prove the classifier does not use logistics or city-only wording.
- [ ] Run the focused tests and record the expected RED evidence before implementation.

### Task 2: Implement Snapshot Contract And Importer

**Files:**
- Modify: `src/lib/snapshot-types.ts`
- Modify: `src/lib/snapshot-validation.ts`
- Modify: `scripts/snapshot/import-scouting-data.ts`

- [ ] Add `EventMode` and `EventArrangement` public types.
- [ ] Add deterministic mode classification from `formatLocation` only.
- [ ] Map `eventTime` and `formatLocation` through existing fact-status semantics.
- [ ] Require and strictly validate the nested arrangement.
- [ ] Run focused tests until GREEN, then run all snapshot/import/approval/diff tests.
- [ ] Dispatch independent contract and code-quality reviews; resolve every blocking finding.

### Task 3: Add Filter Semantics And URL State

**Files:**
- Modify: `src/lib/types.ts`
- Modify: `src/lib/filter.ts`
- Modify: `src/lib/urlState.svelte.ts`
- Modify: `tests/filter.test.ts`

- [ ] Write failing mode-count, OR-filter, multi-dimension AND, clear-all, and URL source-contract tests.
- [ ] Add stable `modes` state and safe enum parsing from `?modes=`.
- [ ] Ensure unknown URL values are discarded rather than retained.
- [ ] Run focused tests and type checking.

### Task 4: Implement List, Detail, And Filter UI

**Files:**
- Modify: `src/components/SchoolRow.svelte`
- Modify: `src/components/DetailPanel.svelte`
- Modify: `src/components/FilterPanel.svelte`
- Modify: `src/components/Toolbar.svelte`
- Modify: `tests/detail-panel.test.ts`
- Modify: `tests/filter.test.ts`

- [ ] Add accessible icon-and-text mode badges to list rows.
- [ ] Add the `活动安排` detail section after deadline information.
- [ ] Show project title and activity type in rows/details and include both in search.
- [ ] Relabel province as `院校所在地`; keep event location in the sourced arrangement.
- [ ] Rename active/archive labels to `开放` and `已结束` across status filters and badges.
- [ ] Add mode filters, counts, chips, and clear behavior.
- [ ] Hide the school-tier group when the current feed has no maintained tags.
- [ ] Preserve compact, stable row and drawer layouts on narrow screens.
- [ ] Run focused tests and Svelte checking; dispatch spec and frontend-quality reviews.

### Task 5: Extend Browser And Accessibility Coverage

**Files:**
- Modify: `e2e/fixtures/current.json`
- Modify: `e2e/ddl.spec.ts`

- [ ] Add representative online, offline, hybrid, and unknown fixture rows.
- [ ] Test list badges, detail content, OR filtering, URL restore, back/forward navigation, chips, clear-all, and no-results behavior.
- [ ] Make dense deadline-calendar overflow interactive and test that every day item can be opened.
- [ ] Label the surface `截止日历` and retain raw deadline precision wording in details.
- [ ] Run axe checks and viewport checks for desktop, iPhone 15 Pro size, and Redmi K50 Ultra size.
- [ ] Verify no text overlap, horizontal scroll, blank content, or inaccessible icon-only state.

### Task 6: Migrate The Approved Snapshot

**Files:**
- Modify generated artifact: `data/approved/current.json`
- Modify generated artifact: `data/staging/candidate.json` (ignored)

- [ ] Import the latest private scouting JSON.
- [ ] Compare old/new project IDs, feed IDs, verification-status counts, and official-source coverage.
- [ ] Report deterministic mode and fact-status coverage counts.
- [ ] Approve through a temporary new path with `previousSnapshotId: null`, validate it, then atomically replace the pre-launch approved file.
- [ ] Re-run public-boundary and privacy checks.

### Task 7: Run Full Real-Data Verification

**Files:**
- Update ignored evidence under `work/agent-runs/2026-07-17-0053-event-arrangement-completion/`

- [ ] Run `pnpm test`, `pnpm check`, `pnpm snapshot:validate`, `pnpm check:public`, and `pnpm build`.
- [ ] Run complete Playwright E2E against both deterministic fixtures and the real approved payload.
- [ ] Inspect desktop, iPhone, and Redmi screenshots and verify layout pixels are nonblank and non-overlapping.
- [ ] Re-run the exact local CI command sequence at final HEAD.
- [ ] Dispatch independent security/reliability and verification reviewers; resolve all blocking findings.

### Task 8: Refresh Launch Evidence And Commit

**Files:**
- Modify: `docs/operations/data-refresh.md` if the public field contract needs operator guidance.
- Modify: `docs/operations/tencent-deploy.md` if release checks need the new schema evidence.
- Update ignored orchestration ledger.

- [ ] Record commands, hashes, counts, screenshots, review reports, residual risks, and go/no-go status.
- [ ] Validate the orchestration run structure.
- [ ] Review the final diff for generated-data privacy and unrelated churn.
- [ ] Commit the completed local implementation in logical, reviewable commits.

### Task 9: Fresh Scan And External Release Gate

- [ ] If the approved source is older than six hours, run the admissions scan again and repeat Tasks 6-8 for the launch snapshot.
- [ ] Stop for explicit authorization before GitHub environment/permission changes, push, PR readiness/merge, server mutation, or production deployment.
- [ ] After authorization, prove local HEAD, remote branch, PR head, and green CI are the same SHA before merge.
- [ ] Deploy only the fresh approved snapshot and verify HTTPS release identity, activity modes, deep links, and all three target viewports on the public domain.
