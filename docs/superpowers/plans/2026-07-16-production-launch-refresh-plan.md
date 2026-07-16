# Production Launch And Refresh Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Launch the approved static DDL site on the real BaoTa-managed Tencent host and establish a private, scheduled, approval-gated data refresh loop.

**Architecture:** Keep public serving, private discovery, and deployment authority separate. Adapt the existing atomic static release tooling to the host's custom Nginx layout, establish protected GitHub release controls, refresh the approved snapshot immediately before launch, and then schedule private discovery that can prepare but never approve or deploy changes.

**Tech Stack:** Svelte 5, TypeScript, Node.js 20, pnpm 10.28.2, Bash, GitHub Actions, BaoTa Nginx 1.28.0, OpenCloudOS 9.4, Playwright, `scan-cs-admissions-events`.

---

## File Map

- `deploy/bootstrap-server.sh`: support an explicitly selected Nginx binary while preserving rollback behavior.
- `deploy/nginx/cs-baoyan-ddl-bt-http.conf`: BaoTa-compatible HTTP validation vhost without a second default server.
- `deploy/nginx/cs-baoyan-ddl-bt-tls.conf`: final versioned HTTPS vhost with explicit certificate-path placeholders.
- `tests/deploy-scripts.test.ts`: prove the BaoTa template and custom Nginx binary behavior before implementation.
- `docs/operations/tencent-deploy.md`: host-specific bootstrap, DNS, certificate, GitHub, and first-release procedure.
- `docs/operations/data-refresh.md`: scheduled discovery, urgent-review, data-only PR, and freshness rules.
- `docs/operations/rollback.md`: second-release rollback exercise and evidence requirements.
- `data/approved/current.json`: freshly approved launch snapshot.
- `.github/workflows/monitor.yml`: post-launch public identity and certificate checks, added only after the domain is confirmed.
- `tests/monitor-workflow.test.ts`: static contract for scheduled monitoring without production secrets.
- `scripts/snapshot/check-freshness.ts`: fail-closed scan and approval age check used before merge and deployment.
- `tests/check-freshness.test.ts`: deterministic age-boundary tests.
- `work/agent-runs/2026-07-16-1251-production-launch-refresh/`: untracked orchestration evidence and handoff.

### Task 12: Freeze Launch Scope And Confirm Production Inputs

**Files:**
- Modify: `docs/superpowers/specs/2026-07-16-production-launch-refresh-design.md`
- Modify: `work/agent-runs/2026-07-16-1251-production-launch-refresh/00-task-brief.md`
- Modify: `work/agent-runs/2026-07-16-1251-production-launch-refresh/decisions.md`

- [ ] **Step 1: Record the approved scope**

Record list, calendar, filters, search, countdown, detail panel, and approved static snapshot as the complete launch surface. Record accounts, comments, database, public write API, and direct agent deployment as excluded.

- [ ] **Step 2: Verify the real production facts read-only**

Run:

```bash
ssh -o BatchMode=yes -o ConnectTimeout=10 Tecent \
  '/www/server/nginx/sbin/nginx -T 2>/dev/null | sed -n "1,220p"'
gh api repos/lvzaixian/CS-BAOYAN-DDL/environments
gh api repos/lvzaixian/CS-BAOYAN-DDL/branches/main/protection
gh api repos/lvzaixian/CS-BAOYAN-DDL/rulesets
```

Expected: BaoTa vhost include is visible, an existing default server is visible, and GitHub production controls are absent until Task 14.

- [ ] **Step 3: Confirm one exact public domain**

Propose `ddl.meta-mind.cn`, but do not create DNS or certificates until the user confirms it. Record the selected domain as a decision, not as a template default.

- [ ] **Step 4: Commit the approved design and plan**

```bash
git add docs/superpowers/specs/2026-07-16-production-launch-refresh-design.md \
  docs/superpowers/plans/2026-07-16-production-launch-refresh-plan.md
git commit -m "docs: plan production launch and refresh loop"
```

Expected: only the two durable planning documents are committed; `work/` remains untracked.

### Task 13: Add BaoTa-Compatible Nginx Bootstrap Support

**Files:**
- Create: `deploy/nginx/cs-baoyan-ddl-bt-http.conf`
- Create: `deploy/nginx/cs-baoyan-ddl-bt-tls.conf`
- Modify: `deploy/bootstrap-server.sh`
- Modify: `tests/deploy-scripts.test.ts`
- Modify: `docs/operations/tencent-deploy.md`

- [ ] **Step 1: Write failing template and custom-binary tests**

Add assertions equivalent to:

```ts
test('BaoTa HTTP template avoids a competing default server', () => {
  const template = readFileSync(
    resolve(repositoryRoot, 'deploy/nginx/cs-baoyan-ddl-bt-http.conf'),
    'utf8',
  );
  assert.doesNotMatch(template, /default_server/);
  assert.match(template, /listen 80;/);
  assert.match(template, /listen \[::\]:80;/);
  assert.match(template, /server_name __SERVER_NAME__;/);
  assert.match(template, /root __DEPLOY_ROOT__\/current;/);
});

test('BaoTa TLS template defines the final HTTPS routing contract', () => {
  const template = readFileSync(
    resolve(repositoryRoot, 'deploy/nginx/cs-baoyan-ddl-bt-tls.conf'),
    'utf8',
  );
  assert.doesNotMatch(template, /default_server/);
  assert.match(template, /ssl_certificate __TLS_CERTIFICATE__;/);
  assert.match(template, /ssl_certificate_key __TLS_CERTIFICATE_KEY__;/);
  assert.match(template, /return 308 https:\/\/__SERVER_NAME__\$request_uri;/);
  assert.match(template, /if \(\$host != "__SERVER_NAME__"\)/);
  assert.match(template, /try_files \$uri \$uri\/ \/index\.html;/);
});

test('bootstrap validates with an explicitly selected Nginx binary', () => {
  // Build a custom executable in the existing fake-command harness, omit a
  // PATH nginx, set NGINX_BIN to that absolute file, and assert its `-t` call.
});

test('bootstrap requires safe TLS paths when the TLS template is selected', () => {
  // Select the TLS template, prove missing/non-absolute paths fail, then prove
  // exact absolute certificate and key paths are rendered without eval.
});
```

- [ ] **Step 2: Run focused tests and verify RED**

```bash
corepack pnpm@10.28.2 exec tsx --test --test-name-pattern='BaoTa|selected Nginx' \
  tests/deploy-scripts.test.ts
```

Expected: fail because the BaoTa templates, TLS-path rendering, and `NGINX_BIN` support do not exist.

- [ ] **Step 3: Add the BaoTa HTTP validation template**

Create a template with this public contract:

```nginx
# BaoTa HTTP validation template. TLS remains a production stop gate.
server {
    listen 80;
    listen [::]:80;
    server_name __SERVER_NAME__;
    root __DEPLOY_ROOT__/current;
    index index.html;

    if ($host != "__SERVER_NAME__") { return 444; }
    location ~ /\. { return 404; }
    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

Preserve the response headers and asset caching behavior from the existing standard template where they do not rely on default-server ownership.

- [ ] **Step 4: Add the final BaoTa HTTPS template**

Create a second template with two non-default servers:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name __SERVER_NAME__;
    if ($host != "__SERVER_NAME__") { return 444; }
    return 308 https://__SERVER_NAME__$request_uri;
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name __SERVER_NAME__;
    ssl_certificate __TLS_CERTIFICATE__;
    ssl_certificate_key __TLS_CERTIFICATE_KEY__;
    root __DEPLOY_ROOT__/current;
    index index.html;
    if ($host != "__SERVER_NAME__") { return 444; }
    location ~ /\. { return 404; }
    location / { try_files $uri $uri/ /index.html; }
}
```

Use the same reviewed security headers, immutable asset cache, `release.json` no-cache behavior, and dotfile denial as the standard template.

- [ ] **Step 5: Implement safe binary and TLS-path selection**

In `deploy/bootstrap-server.sh`:

```bash
NGINX_BIN=${NGINX_BIN:-nginx}

case "$NGINX_BIN" in
  */*) test -x "$NGINX_BIN" || fail "NGINX_BIN is not executable: $NGINX_BIN" ;;
  *) command -v "$NGINX_BIN" >/dev/null 2>&1 \
       || fail "required command is missing: $NGINX_BIN" ;;
esac
```

Remove the hard-coded `nginx` entry from the generic command loop and replace every `nginx -t` with `"$NGINX_BIN" -t`. Do not accept a shell command string or evaluate `NGINX_BIN`.

When the selected template contains `__TLS_CERTIFICATE__` or `__TLS_CERTIFICATE_KEY__`, require `TLS_CERTIFICATE` and `TLS_CERTIFICATE_KEY` to be absolute paths with the same safe path syntax as `DEPLOY_ROOT`. Render them as literal arguments in Python; never use shell interpolation or `eval`.

- [ ] **Step 6: Run focused and full verification**

```bash
corepack pnpm@10.28.2 exec tsx --test tests/deploy-scripts.test.ts
corepack pnpm@10.28.2 run test:unit
corepack pnpm@10.28.2 run snapshot:validate
corepack pnpm@10.28.2 run check:public
git diff --check
```

Expected: all checks pass; macOS may retain the existing explicit util-linux `flock` skip.

- [ ] **Step 7: Document the exact BaoTa invocations**

Use a required, user-approved `SELECTED_DOMAIN` input and validate it before either command:

```bash
test -n "${SELECTED_DOMAIN:?user-approved domain is required}"
case "$SELECTED_DOMAIN" in *[!a-z0-9.-]*|.*|*..*|*.) exit 1 ;; esac

sudo env \
  DEPLOY_USER=cs-baoyan-deploy \
  SERVER_NAME="$SELECTED_DOMAIN" \
  DEPLOY_ROOT=/srv/cs-baoyan-ddl \
  NGINX_BIN=/www/server/nginx/sbin/nginx \
  NGINX_TEMPLATE="$PWD/deploy/nginx/cs-baoyan-ddl-bt-http.conf" \
  NGINX_CONFIG="/www/server/panel/vhost/nginx/$SELECTED_DOMAIN.conf" \
  bash deploy/bootstrap-server.sh
```

State that this HTTP command is only for controlled validation. The final command must select `cs-baoyan-ddl-bt-tls.conf` and pass the two exact certificate paths approved at Task 14.

- [ ] **Step 8: Commit**

```bash
git add deploy/bootstrap-server.sh deploy/nginx/cs-baoyan-ddl-bt-http.conf \
  deploy/nginx/cs-baoyan-ddl-bt-tls.conf \
  tests/deploy-scripts.test.ts docs/operations/tencent-deploy.md
git commit -m "feat: support BaoTa nginx bootstrap"
```

### Task 14: Establish The Production Trust Boundary

**Files:**
- Modify: `docs/operations/tencent-deploy.md`
- Modify: `work/agent-runs/2026-07-16-1251-production-launch-refresh/evidence/commands.md`
- Modify: `work/agent-runs/2026-07-16-1251-production-launch-refresh/verification.md`

- [ ] **Step 1: Stop for production confirmation**

Present the selected domain, exact DNS record, certificate method, certificate and key paths, deploy username, Nginx config destination, GitHub reviewer identity, environment changes, and rollback command. Store the approved values as `SELECTED_DOMAIN`, `TLS_CERTIFICATE`, and `TLS_CERTIFICATE_KEY` in the private run ledger; do not add them as repository defaults. Do not continue until the user explicitly approves production changes.

- [ ] **Step 2: Create the dedicated host identity and directories**

After approval, create `cs-baoyan-deploy` with a matching primary group and no sudo and install its restricted deploy public key. Before each reviewed BaoTa bootstrap, freeze BaoTa save/apply/reload actions and run the executable host preflight: bind PID file, master exe/cmdline, validated worker set, global error-log directive and master FDs; verify the existing vhost SELinux label when present; prove the first-install glob include when absent; and create a unique root-only `cp -a` backup or absence marker with SHA-256. Run the post-bootstrap bounded worker and error-log gate before any routing decision.

- [ ] **Step 3: Configure DNS and TLS**

Create only the approved DNS record. Issue a certificate for the exact domain through the approved BaoTa/ACME path, then rerun preflight and bootstrap with the versioned `deploy/nginx/cs-baoyan-ddl-bt-tls.conf` template and approved certificate paths. Re-run the bounded master/worker/error-log gate and the no-publication TLS routing probes; do not wait for Task 16 payload activation.

- [ ] **Step 4: Configure GitHub production controls**

Create the `production` environment, required reviewer, protected-main deployment policy, five environment secrets, and `PUBLIC_BASE_URL`. Protect `main` and require status context `verify` from workflow `CI`.

- [ ] **Step 5: Re-run read-only verification**

Expected evidence:

```text
DNS A/AAAA -> approved host
certificate SAN -> exact selected domain
nginx -t -> success
existing vhost -> exact nginx -T marker and restorecon -n clean
first install -> exact BaoTa glob include visible
master -> selected binary and cmdline unchanged
worker -> new validated PID survives two consecutive bounded polls
global error log -> /www/wwwlogs/nginx_error.log crit, master FD binding stable, no severe delta
HTTP selected Host -> 308 to exact HTTPS domain
HTTPS selected SNI/Host -> selected certificate and expected pre-activation 404 from the selected vhost
unknown Host/SNI/no-SNI -> connection rejected
deploy user -> no sudo, matching primary group
production environment -> reviewer and main policy
main protection -> status context `verify` from workflow `CI` required, force pushes disabled
```

- [ ] **Step 6: Commit the finalized production procedure**

```bash
git add docs/operations/tencent-deploy.md
git commit -m "docs: finalize Tencent production procedure"
```

Expected: no private key, known-host line, server IP, certificate material, or GitHub secret value is committed.

### Task 15: Refresh And Approve The Launch Snapshot

**Files:**
- Modify: `data/approved/current.json`
- Modify only when identity review requires it: `data/project-id-aliases.json`
- Modify: `docs/operations/data-refresh.md`
- Modify: `package.json`
- Modify: `.github/workflows/deploy.yml`
- Create: `scripts/snapshot/check-freshness.ts`
- Create: `tests/check-freshness.test.ts`
- Create privately: the timestamped JSON and XLSX paths emitted by `$scan-cs-admissions-events`

- [ ] **Step 1: Run a fresh nationwide scan**

Use `$scan-cs-admissions-events` with up to 12 non-overlapping regional discovery assignments. Cover Baoyan Notice, CS-BAOYAN DDL, official pages, official application systems, and official public-account notices.

After the skill run, set and validate named inputs rather than relying on a guessed filename:

```bash
: "${SCOUTING_JSON:?set SCOUTING_JSON to the skill-emitted validated JSON path}"
: "${SUBMITTED_JSON:?set SUBMITTED_JSON to the current private submitted-ID JSON path}"
test -f "$SCOUTING_JSON"
test -f "$SUBMITTED_JSON"
SCOUTING_JSON=$(realpath "$SCOUTING_JSON")
SUBMITTED_JSON=$(realpath "$SUBMITTED_JSON")
case "$SCOUTING_JSON" in /Users/maxwellbrooks/Workspace/profile_space/outputs/*) ;; *) exit 1 ;; esac
```

- [ ] **Step 2: Validate the private scouting corpus**

```bash
node /Users/maxwellbrooks/.codex/skills/scan-cs-admissions-events/scripts/validate_scouting_data.mjs \
  "$SCOUTING_JSON" \
  "$SUBMITTED_JSON"
```

Expected: zero validation errors and zero submitted-project leaks.

- [ ] **Step 3: Import and diff without publishing**

```bash
corepack pnpm@10.28.2 run snapshot:import -- \
  --input "$SCOUTING_JSON" \
  --approved data/approved/current.json \
  --aliases data/project-id-aliases.json \
  --output data/staging/candidate.json

corepack pnpm@10.28.2 run snapshot:diff -- \
  --previous data/approved/current.json \
  --next data/staging/candidate.json \
  --output data/staging/diff.json
```

- [ ] **Step 4: Review every high-risk diff**

Review all additions, removals, confirmed promotions, deadline changes, and deadlines within 72 hours against official evidence. Downgrade unresolved rows to pending in the private corpus and repeat the import.

- [ ] **Step 5: Write failing six-hour freshness tests**

Create deterministic tests for `checkSnapshotFreshness(snapshot, now, maxAgeMs)` covering exactly-six-hours accepted, one-millisecond-over rejected, future timestamps rejected, missing approval rejected, and `approvedAt < scanAt` rejected. Add a deployment-workflow static assertion that the production deploy job rechecks the metadata age after environment approval and before writing the SSH key or contacting the host.

- [ ] **Step 6: Verify freshness RED**

```bash
corepack pnpm@10.28.2 exec tsx --test tests/check-freshness.test.ts
```

Expected: fail because the freshness module and deploy-time recheck do not exist.

- [ ] **Step 7: Implement the fail-closed freshness gate**

Add `snapshot:check-freshness`:

```bash
corepack pnpm@10.28.2 run snapshot:check-freshness -- \
  --snapshot data/approved/current.json \
  --max-age-hours 6
```

Extend the private release metadata artifact with `snapshotScanAt` and `snapshotApprovedAt`. In the `deploy` job, after production approval and artifact validation but before creating the SSH key or connecting to Tencent, reject either timestamp when it is missing, in the future, chronologically invalid, or older than 21,600 seconds. Do not widen the public `release.json` contract.

- [ ] **Step 8: Approve and run the full release gate**

```bash
corepack pnpm@10.28.2 run snapshot:approve -- \
  --candidate data/staging/candidate.json \
  --approved data/approved/current.json
corepack pnpm@10.28.2 run test:unit
corepack pnpm@10.28.2 run snapshot:validate
corepack pnpm@10.28.2 run snapshot:check-freshness -- \
  --snapshot data/approved/current.json --max-age-hours 6
corepack pnpm@10.28.2 run check:public
corepack pnpm@10.28.2 run check
corepack pnpm@10.28.2 run build
corepack pnpm@10.28.2 run test:e2e
git diff --check
```

- [ ] **Step 9: Commit the public-only update and freshness enforcement**

```bash
git add data/approved/current.json data/project-id-aliases.json docs/operations/data-refresh.md \
  package.json .github/workflows/deploy.yml scripts/snapshot/check-freshness.ts \
  tests/check-freshness.test.ts
git commit -m "data: refresh verified admissions snapshot"
```

Expected: ignored staging files, workbooks, submitted IDs, and personal rankings remain untracked and uncommitted.

### Task 16: Merge And Perform The First Public Release

**Files:**
- No additional repository files unless verification finds a defect.
- Modify: `work/agent-runs/2026-07-16-1251-production-launch-refresh/verification.md`

- [ ] **Step 1: Complete user acceptance testing**

Run the built production site locally and verify desktop, mobile, narrow-mobile, list, calendar, filtering, details, official links, and current snapshot counts.

- [ ] **Step 2: Stop for branch-push confirmation**

Report the local commit list and exact `LOCAL_SHA`. Push is an external publication action, so do not update the remote branch until the user confirms it.

- [ ] **Step 3: Push and prove exact PR synchronization**

```bash
test -z "$(git status --porcelain --untracked-files=no)"
LOCAL_SHA=$(git rev-parse HEAD)
git push origin HEAD:codex/live-data-pipeline
REMOTE_SHA=$(git ls-remote origin refs/heads/codex/live-data-pipeline | awk '{print $1}')
PR_SHA=$(gh pr view 2 --repo lvzaixian/CS-BAOYAN-DDL --json headRefOid --jq .headRefOid)
test "$LOCAL_SHA" = "$REMOTE_SHA"
test "$LOCAL_SHA" = "$PR_SHA"
```

Expected: all three full SHAs are identical.

- [ ] **Step 4: Mark PR #2 ready and wait for CI on the exact SHA**

```bash
gh pr ready 2 --repo lvzaixian/CS-BAOYAN-DDL
gh pr checks 2 --repo lvzaixian/CS-BAOYAN-DDL --watch
test "$(gh pr view 2 --repo lvzaixian/CS-BAOYAN-DDL --json headRefOid --jq .headRefOid)" = "$LOCAL_SHA"
test "$(gh pr view 2 --repo lvzaixian/CS-BAOYAN-DDL --json statusCheckRollup \
  --jq '[.statusCheckRollup[] | select(.name == "verify" and .conclusion == "SUCCESS")] | length')" -ge 1
```

- [ ] **Step 5: Record the approved head and stop for merge confirmation**

Set `APPROVED_SHA` to the synchronized PR head and report that exact SHA, CI run, snapshot ID, data hash, scan age, approval age, domain, certificate, merge strategy, and production control status. Merge only after explicit confirmation for that SHA.

- [ ] **Step 6: Recheck atomically and merge only the approved head**

Immediately before the merge command, repeat the PR-head equality, successful-CI, and six-hour freshness checks. Then preserve the branch commits with an exact-head merge guard:

```bash
test -n "${APPROVED_SHA:?approved PR head SHA is required}"
test "$(git rev-parse HEAD)" = "$APPROVED_SHA"
test -z "$(git status --porcelain --untracked-files=no)"
test "$(gh pr view 2 --repo lvzaixian/CS-BAOYAN-DDL --json headRefOid --jq .headRefOid)" = "$APPROVED_SHA"
test "$(gh pr view 2 --repo lvzaixian/CS-BAOYAN-DDL --json statusCheckRollup \
  --jq '[.statusCheckRollup[] | select(.name == "verify" and .conclusion == "SUCCESS")] | length')" -ge 1
APPROVED_SNAPSHOT=$(mktemp)
trap 'rm -f -- "$APPROVED_SNAPSHOT"' EXIT
git show "$APPROVED_SHA:data/approved/current.json" > "$APPROVED_SNAPSHOT"
corepack pnpm@10.28.2 run snapshot:check-freshness -- \
  --snapshot "$APPROVED_SNAPSHOT" --max-age-hours 6
gh pr merge 2 --repo lvzaixian/CS-BAOYAN-DDL --merge \
  --match-head-commit "$APPROVED_SHA"
```

Any failed equality, CI, freshness, or match-head check cancels the merge. Never retry with a newly observed head without a new user confirmation.

- [ ] **Step 7: Approve the first deployment**

Verify the workflow run identifies the exact merged SHA and that its post-approval freshness step will run before any SSH material is written. If the six-hour window has elapsed, do not approve; return to Task 15 and create a new verified snapshot.

- [ ] **Step 8: Verify the public release**

After the workflow has run `activate-release.sh` and switched `current`, run `deploy/smoke.sh` with the exact HTTPS origin and expected release identity. This Task 16 activation gate must verify `release.json`, the exact release identity triple, the same-origin JavaScript asset, SPA deep-link fallback, and missing asset 404. Then validate on desktop, iPhone, and Redmi and record screenshots and command evidence.

### Task 17: Schedule Private Discovery

**Files:**
- Modify: `docs/operations/data-refresh.md`
- Modify privately after approval: Codex automation configuration for `/Users/maxwellbrooks/Workspace/profile_space`

- [ ] **Step 1: Create an isolated tooling branch from released main**

```bash
git fetch origin main
git switch -c codex/refresh-operations origin/main
```

Expected: the tooling branch starts from the exact first-release main commit and contains no unmerged launch-branch-only commits.

- [ ] **Step 2: Record the exact v1 cadence**

Use one two-hour recurring Codex automation in the `profile_space` local environment. The v1 automation runs every two hours around the clock; this is intentionally more frequent than the minimum 08:00-24:00 plus overnight requirement because the automation scheduler supports a stable hourly interval without a daily exclusion window.

- [ ] **Step 3: Define the bounded automation task**

The automation runs `$scan-cs-admissions-events`, produces timestamped private XLSX and JSON artifacts, and reports confirmed, pending, expired, changed, removed, and deadline-within-72-hours rows. It does not receive Tencent credentials, change DNS, approve snapshots, push code, create or merge PRs, or deploy.

- [ ] **Step 4: Stop for recurring-cost confirmation**

Present the two-hour cadence, model, workspace, and private output contract. Create the automation only after the user confirms the recurring compute cost.

- [ ] **Step 5: Run one manual automation-equivalent rehearsal**

Verify that a no-change scan creates no public commit and that a changed scan produces only private candidate, diff, workbook, and JSON artifacts.

- [ ] **Step 6: Commit the operating procedure**

```bash
git add docs/operations/data-refresh.md
git commit -m "docs: define scheduled discovery operations"
```

### Task 18: Prepare Human-Reviewed Data-Only PRs

**Files:**
- Modify: `docs/operations/data-refresh.md`
- Modify: `package.json`
- Create: `scripts/snapshot/prepare-data-pr.ts`
- Create: `tests/prepare-data-pr.test.ts`

- [ ] **Step 1: Write failing tests for a no-change and changed candidate**

The pure planner must return `no-change` for identical hashes and a bounded public file list for a changed approved snapshot. It must reject staging paths, private absolute paths, contact data outside approved exemptions, and submitted IDs.

- [ ] **Step 2: Verify RED**

```bash
corepack pnpm@10.28.2 exec tsx --test tests/prepare-data-pr.test.ts
```

- [ ] **Step 3: Implement the bounded PR planner**

The script may prepare branch name, commit message, PR title, and validated file list. It must not approve a candidate, invoke `git push`, create a PR, merge, or deploy without separate human commands.

- [ ] **Step 4: Run full verification and commit**

```bash
corepack pnpm@10.28.2 run test:unit
corepack pnpm@10.28.2 run check:public
git diff --check
git add package.json scripts/snapshot/prepare-data-pr.ts tests/prepare-data-pr.test.ts \
  docs/operations/data-refresh.md
git commit -m "feat: prepare bounded data update reviews"
```

### Task 19: Add Monitoring And Complete A Genuine Refresh Cycle

**Files:**
- Create: `.github/workflows/monitor.yml`
- Create: `tests/monitor-workflow.test.ts`
- Modify: `docs/operations/tencent-deploy.md`
- Modify: `docs/operations/data-refresh.md`
- Modify: `work/agent-runs/2026-07-16-1251-production-launch-refresh/verification.md`

- [ ] **Step 1: Write a failing workflow contract test**

Require a scheduled and manual workflow with read-only permissions and no production environment or Tencent secrets. It reads only repository variable `PUBLIC_BASE_URL`, validates HTTPS and public `release.json`, checks the certificate SAN for the selected origin, fails when fewer than 21 full days remain, and uploads diagnostics on failure.

- [ ] **Step 2: Verify RED**

```bash
corepack pnpm@10.28.2 exec tsx --test tests/monitor-workflow.test.ts
```

- [ ] **Step 3: Implement public monitoring**

Pin every action by commit SHA. Schedule monitoring every six hours and allow manual dispatch. Use `PUBLIC_BASE_URL` only; do not load deployment credentials. Set `CERT_MIN_VALID_DAYS=21` in the workflow and fail closed on malformed release identity, wrong origin, wrong certificate SAN, or insufficient lifetime.

- [ ] **Step 4: Add the private coverage review contract**

Document per-run coverage across school watchlists, regions, official source families, aggregators, blocked sources, and stale urgent rows. Preserve the public partial-coverage disclaimer.

- [ ] **Step 5: Verify and commit monitoring**

```bash
corepack pnpm@10.28.2 run test:unit
corepack pnpm@10.28.2 run snapshot:validate
corepack pnpm@10.28.2 run check:public
corepack pnpm@10.28.2 run check
corepack pnpm@10.28.2 run build
corepack pnpm@10.28.2 run test:e2e
git diff --check
git add .github/workflows/monitor.yml tests/monitor-workflow.test.ts \
  docs/operations/tencent-deploy.md docs/operations/data-refresh.md
git commit -m "feat: monitor public release health"
```

- [ ] **Step 6: Stop for tooling publication and repository-variable confirmation**

Report every commit on `codex/refresh-operations`, the exact tooling head SHA, the proposed tooling PR title, and the repository-variable mutation. Confirm that `PUBLIC_BASE_URL` is the same exact HTTPS root origin already approved for production. Do not push, create the PR, or set the repository variable until the user confirms all three actions.

- [ ] **Step 7: Configure and verify the monitoring repository variable**

```bash
: "${PUBLIC_BASE_URL:?approved HTTPS root origin is required}"
case "$PUBLIC_BASE_URL" in https://* ) ;; * ) exit 1 ;; esac
gh variable set PUBLIC_BASE_URL --repo lvzaixian/CS-BAOYAN-DDL --body "$PUBLIC_BASE_URL"
test "$(gh variable get PUBLIC_BASE_URL --repo lvzaixian/CS-BAOYAN-DDL)" = "$PUBLIC_BASE_URL"
```

This repository variable is intentionally separate from the production-environment variable with the same name; the monitoring workflow has no production environment access.

- [ ] **Step 8: Publish and merge a separate tooling PR**

Push `codex/refresh-operations`, create a tooling PR, and store its number as `TOOLING_PR`. Prove local, remote, and PR-head SHA equality; wait for CI on that exact SHA; then stop for merge confirmation. Immediately before merge, recheck the approved head and CI and use:

```bash
: "${TOOLING_PR:?tooling PR number is required}"
: "${TOOLING_APPROVED_SHA:?approved tooling head SHA is required}"
test "$(git rev-parse HEAD)" = "$TOOLING_APPROVED_SHA"
test -z "$(git status --porcelain --untracked-files=no)"
test "$(gh pr view "$TOOLING_PR" --repo lvzaixian/CS-BAOYAN-DDL --json headRefOid --jq .headRefOid)" = "$TOOLING_APPROVED_SHA"
test "$(gh pr view "$TOOLING_PR" --repo lvzaixian/CS-BAOYAN-DDL --json statusCheckRollup \
  --jq '[.statusCheckRollup[] | select(.name == "verify" and .conclusion == "SUCCESS")] | length')" -ge 1
gh pr merge "$TOOLING_PR" --repo lvzaixian/CS-BAOYAN-DDL --merge \
  --match-head-commit "$TOOLING_APPROVED_SHA"
```

Do not include any admissions snapshot change in this tooling PR.

- [ ] **Step 9: Require one actual scheduled scan**

Wait for the enabled two-hour automation to start a real scheduled invocation. Record its automation run identity, start time, completed coverage, validated XLSX and JSON paths, and urgent-review summary. Manual runs remain rehearsal evidence and cannot satisfy this step.

- [ ] **Step 10: Create a clean data branch from updated main**

After the tooling PR is merged:

```bash
git fetch origin main
DATA_BRANCH="codex/data-refresh-$(date -u +%Y%m%d-%H%M%S)"
git switch -c "$DATA_BRANCH" origin/main
```

Import the actual scheduled scan, complete official-source review and manual approval, and commit only `data/approved/current.json` plus `data/project-id-aliases.json` when aliases genuinely changed. `git diff --name-only origin/main...HEAD` must contain no scripts, workflows, docs, staging files, workbooks, or private paths.

- [ ] **Step 11: Complete the genuine data-only release**

Present the scheduled scan evidence, reviewed diff, six-hour freshness result, exact data-branch SHA, and proposed PR. After push/PR confirmation, prove local/remote/PR SHA equality, wait for status context `verify` on that exact SHA, and stop for merge confirmation. Store the confirmed head as `DATA_APPROVED_SHA`. Immediately before merge, require local HEAD and PR head to equal it, require a tracked-clean worktree, materialize `data/approved/current.json` with `git show "$DATA_APPROVED_SHA:data/approved/current.json"`, check freshness against that immutable file, and use:

```bash
: "${DATA_PR:?data-only PR number is required}"
: "${DATA_APPROVED_SHA:?approved data-only head SHA is required}"
test "$(git rev-parse HEAD)" = "$DATA_APPROVED_SHA"
test -z "$(git status --porcelain --untracked-files=no)"
test "$(gh pr view "$DATA_PR" --repo lvzaixian/CS-BAOYAN-DDL --json headRefOid --jq .headRefOid)" = "$DATA_APPROVED_SHA"
test "$(gh pr view "$DATA_PR" --repo lvzaixian/CS-BAOYAN-DDL --json statusCheckRollup \
  --jq '[.statusCheckRollup[] | select(.name == "verify" and .conclusion == "SUCCESS")] | length')" -ge 1
DATA_APPROVED_SNAPSHOT=$(mktemp)
trap 'rm -f -- "$DATA_APPROVED_SNAPSHOT"' EXIT
git show "$DATA_APPROVED_SHA:data/approved/current.json" > "$DATA_APPROVED_SNAPSHOT"
corepack pnpm@10.28.2 run snapshot:check-freshness -- \
  --snapshot "$DATA_APPROVED_SNAPSHOT" --max-age-hours 6
gh pr merge "$DATA_PR" --repo lvzaixian/CS-BAOYAN-DDL --merge \
  --match-head-commit "$DATA_APPROVED_SHA"
```

Approve production only after the deploy-time freshness check, then verify the new public release identity. A no-change scheduled run does not complete this step; wait for a genuine reviewed change.

- [ ] **Step 12: Independent refresh-loop review**

Obtain a verification review and a security/reliability review. Resolve all blocking findings before declaring the refresh loop production-ready.

### Task 20: Exercise Rollback After The Second Genuine Release

**Files:**
- Modify: `work/agent-runs/2026-07-16-1251-production-launch-refresh/verification.md`
- Modify: `work/agent-runs/2026-07-16-1251-production-launch-refresh/evidence/commands.md`

- [ ] **Step 1: Confirm two genuine releases exist**

Use the initial launch release and the real Task 19 refresh release. Do not manufacture a production release solely to test rollback.

- [ ] **Step 2: Stop for rollback confirmation**

Present the current and first release SHAs, snapshot identities, and exact rollback and forward commands.

- [ ] **Step 3: Roll back to the first release and verify identity**

Use `deploy/rollback-release.sh` with the explicitly selected first SHA, then run HTTPS smoke checks and monitor checks.

- [ ] **Step 4: Forward to the second release and verify identity**

Repeat the explicit rollback command targeting the second SHA. Record recovery duration and all identity values.

- [ ] **Step 5: Record private rollback evidence**

Record the exact commands, selected SHAs, release identities, smoke results, screenshots, and recovery duration in the untracked production run ledger. The tracked rollback procedure was already integrated in the initial launch branch; do not create a post-exercise repository commit containing operational evidence.
