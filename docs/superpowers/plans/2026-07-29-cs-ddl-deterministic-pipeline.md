# CS DDL Deterministic Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use test-driven-development and execute each task in order. Shared contracts, identity rules, approval APIs, and release decisions remain parent-owned.

**Goal:** Prevent discovered admissions evidence, parent projects, pending leads, and official surfaces from disappearing silently before a public snapshot is approved.

**Architecture:** A strict private scan bundle records immutable observations rather than final publication status. Pure reducers resolve canonical identity, derive lifecycle state, update a generation-checked pending ledger, project into the existing public snapshot schema, recompute the real diff, and produce a hash-bound release gate. The approval file API validates that gate again while holding the existing approval lock.

**Tech Stack:** TypeScript, Node.js test runner, existing snapshot import/diff/integrity modules, JSON private run artifacts, SHA-256, atomic file replacement.

---

## File Map

- Create `scripts/snapshot/scan-release-contract.ts`: strict private bundle and identity-registry parser.
- Create `scripts/snapshot/scan-release-reducer.ts`: identity, evidence disposition, lifecycle and public projection pure functions.
- Create `scripts/snapshot/pending-ledger.ts`: immutable events, current projection and generation CAS.
- Create `scripts/snapshot/release-gate.ts`: gate manifest creation, review and approval-time validation.
- Create `scripts/snapshot/build-scan-release.ts`: CLI orchestrating parse, reduce, import, diff, pending and gate artifacts.
- Modify `scripts/snapshot/approve-snapshot.ts`: require and revalidate gate inside the approval lock.
- Modify `scripts/snapshot/import-scouting-data.ts`: read the single versioned identity registry format.
- Modify `scripts/snapshot/prepare-data-pr.ts`: validate the same identity registry.
- Modify `data/project-id-aliases.json`: migrate to schema v2 and add reviewed SUSTech aliases.
- Create `scripts/source/priority-sentinels.json`: versioned sentinel scope requirements.
- Create `tests/scan-release-contract.test.ts`, `tests/scan-release-reducer.test.ts`,
  `tests/pending-ledger.test.ts`, `tests/release-gate.test.ts`.
- Modify `tests/approve-snapshot.test.ts`, `tests/import-scouting-data.test.ts`,
  `tests/prepare-data-pr.test.ts`.
- Modify `package.json` and `docs/operations/data-refresh.md`.
- Modify the canonical scan skill validator, tests and contracts under
  `$CODEX_HOME/skills/scan-cs-admissions-events/`.
- Update Codex automations through the automation control API, not by editing TOML.

### Task 1: Strict Contract RED

- [ ] Add tests importing `parseScanBundle()` and `parseIdentityRegistry()`.
- [ ] Assert unknown top-level and nested fields fail with an exact JSON path.
- [ ] Assert readable surfaces require `artifactSha256`; blocked surfaces require `error`.
- [ ] Assert evidence timestamps must fall inside the run window.
- [ ] Assert legacy `pendingProjects`, `pendingProjectLeads`, and `pendingLeads` are rejected by the canonical parser.
- [ ] Run:

```bash
./node_modules/.bin/tsx --test tests/scan-release-contract.test.ts
```

Expected RED: module or exported functions are missing.

### Task 2: Strict Contract GREEN

- [ ] Implement exact-key parsing for:

```ts
parseScanBundle(input: unknown): ScanBundle
parseIdentityRegistry(input: unknown): ProjectIdentityRegistry
```

- [ ] Define evidence results as `checked | hit | no-current-notice | blocked`.
- [ ] Define official kinds as `graduate-admissions | college-notice | application-system |
  official-account | attachment | other-official`.
- [ ] Reject search and aggregator hosts as official evidence.
- [ ] Re-run Task 1 and keep all existing snapshot tests green.

### Task 3: Reducer RED

- [ ] Add BUPT fixture: first surface 412, second surface readable 2027 system, college surface blocked.
- [ ] Assert result is one school-level active project plus one unresolved pending ledger entry.
- [ ] Reverse evidence order and assert byte-equivalent lifecycle/disposition results.
- [ ] Add SUSTech fixture with parent `/graduate/3775`, current `/notices/3775`, and provisional round rename.
- [ ] Assert one canonical ID and diff `changed`, never `added + removed`.
- [ ] Add parent-active fetch-failed fixture and assert pending, not removal.
- [ ] Add same-school unrelated row fixture and assert it cannot cover an orphan project.
- [ ] Run:

```bash
./node_modules/.bin/tsx --test tests/scan-release-reducer.test.ts
```

Expected RED: reducer functions are missing.

### Task 4: Reducer GREEN

- [ ] Implement:

```ts
resolveProjectIdentity(observation, parent, registry): CanonicalIdentity
reduceScanRelease(bundle, parent, registry, pending): ScanReduction
```

- [ ] Derive terminal state from observed registration state and deadline, never from a school-level `hit`.
- [ ] Produce one evidence disposition per evidence record. Allow many evidence records to bind one canonical project.
- [ ] Preserve parent expired rows automatically.
- [ ] Auto-expire parent active rows only when their official deadline is at or before `scanFinishedAt`.
- [ ] Require every other parent active row to be observed, pending, precisely submitted-excluded,
  out-of-scope with evidence, officially closed, or identity-merged with a tombstone.
- [ ] Treat any hard error or missing parent transition as gate failure.
- [ ] Re-run Task 3.

### Task 5: Pending Ledger RED/GREEN

- [ ] Test that every unresolved previous entry receives exactly one current-run event.
- [ ] Test a stale generation or digest cannot replace current projection.
- [ ] Test new blocked evidence creates one pending entry and repeated scans append events without duplication.
- [ ] Test resolved entries remain in immutable history.
- [ ] Implement:

```ts
buildNextPendingLedger(previous, updates, run): PendingLedger
commitPendingLedger(path, expectedGeneration, expectedSha256, next): Promise<void>
```

- [ ] Run:

```bash
./node_modules/.bin/tsx --test tests/pending-ledger.test.ts
```

### Task 6: Release Gate RED

- [ ] Parent A/B, candidate A: assert gate is `needs-review`.
- [ ] Supply a forged empty diff: approval must recompute and reject it.
- [ ] Supply exact review for B: assert gate becomes ready.
- [ ] Change candidate bytes or current parent after gate creation: approval must fail without replacing current.
- [ ] Assert every gate digest and metric is exact-key validated.
- [ ] Run:

```bash
./node_modules/.bin/tsx --test tests/release-gate.test.ts tests/approve-snapshot.test.ts
```

Expected RED: approval currently accepts unexplained removal.

### Task 7: Release Gate GREEN

- [ ] Implement gate creation with parent ID/hash, candidate canonical hash, real diff, artifact digests,
  zero-loss metrics and removal reviews.
- [x] Replace arbitrary candidate/gate inputs with a fixed `--release-dir` plus an external
  `--pending-current` ledger.
- [x] Re-read every release input and current while holding the existing approval lock.
- [x] Recompute the artifact manifest, reducer, diff and gate; reject drift, uncommitted pending,
  hard errors, unreviewed removals and nonzero loss metrics.
- [ ] Keep `approveCandidate()` as the pure sealing primitive, but make the public file API fail closed.
- [ ] Update all approval tests and operational commands.

### Task 8: Build CLI And Identity Registry

- [ ] Implement `build-scan-release.ts` CLI:

```text
--bundle --parent --registry --sentinels --identity-registry
--pending-current --artifact-manifest --artifact-root
--candidate --diff --lifecycle --evidence-dispositions
--gate --pending-next --audit --removal-reviews
```

- [ ] Write candidate, diff, next pending and audit atomically; write gate last.
- [ ] Migrate `data/project-id-aliases.json` to one schema-v2 registry with URL aliases,
  project aliases and tombstones.
- [ ] Add reviewed `/notices/3775` and `/notices/3776` aliases to their approved SUSTech IDs.
- [ ] Update legacy importer and data-PR validation to read that one registry.
- [ ] Add package scripts `scan:build-release`, `pending:commit`, and keep `snapshot:approve` gated.

### Task 9: Skill Validator RED/GREEN

- [ ] Add RED cases for orphan hit, blocked-only hit, same-school unrelated row, missing `warnings`,
  missing `region/kind`, future evidence timestamp, fake discovery artifact and runId mismatch.
- [ ] Run and observe RED:

```bash
node "$CODEX_HOME/skills/scan-cs-admissions-events/scripts/test_validate_scan_run.mjs"
```

- [ ] Implement strict checks and structured error codes.
- [ ] Update `SKILL.md`, `research-protocol.md`, `coverage-run-contract.md` and `aggregator-protocol.md`
  to require the versioned bundle, pending ledger and release gate.
- [ ] Re-run both skill test suites.

### Task 10: Automation Control

- [ ] Update daily `cs-ddl` incremental scope to read the private pending ledger generation and run
  `scan:build-release`.
- [ ] Retain one 72-hour full automation with registry, discovered-child fan-out and priority sentinels.
- [ ] Remove the duplicate full automation.
- [ ] Keep automations private-output only: no approval, Git, deployment or production secrets.
- [ ] Read back automation definitions and verify schedule, model, cwd and prompts.

### Task 11: Replay And Fresh Full

- [ ] Convert the frozen 2026-07-29 inputs through an explicit one-time adapter.
- [ ] Assert the old bundle fails strict parsing and the adapter accounts for all 14 pending inputs.
- [ ] Assert old public candidate fails loss metrics and deletion gate.
- [ ] Run a fresh nationwide full scan into a new runId directory.
- [ ] Require all registry and sentinel scope items, all parent transitions and all pending updates.
- [ ] Render and inspect workbook artifacts only after the deterministic gate is ready.

### Task 12: Release Verification

- [ ] Run targeted tests, all 875+ unit tests, type check, production build and public checks.
- [ ] Obtain independent verification and reliability review.
- [ ] Review every real removal and pending transition.
- [ ] If gate is ready, approve candidate, commit, push, open PR, verify CI, merge and deploy through
  existing GitHub Actions approvals.
- [ ] Download live `current.json`; verify snapshot ID/hash/counts and explicit BUPT/SUSTech assertions.
- [ ] If any gate fails, stop with NO-GO and preserve all artifacts.
