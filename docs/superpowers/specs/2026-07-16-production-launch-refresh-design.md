# Production Launch And Refresh Loop Design

## Goal

Launch the verified CS admissions DDL site on the existing Tencent Cloud host, then operate a timely but approval-gated refresh loop that discovers broadly, verifies against official sources, excludes private application state, and publishes only reviewed snapshots.

## Current Baseline

- Draft PR #2 is mergeable and its Ubuntu CI run is green.
- The approved public snapshot contains 69 confirmed-open, 9 confirmed-unknown-deadline, and 14 expired opportunities; 34 pending rows remain excluded.
- The Tencent host is OpenCloudOS 9.4 with BaoTa-managed Nginx 1.28.0.
- Nginx includes `/www/server/panel/vhost/nginx/*.conf` and already has an HTTP default server.
- No dedicated deploy user, `/srv/cs-baoyan-ddl`, selected DDL domain, DNS record, DDL certificate, GitHub production environment, branch protection, or repository ruleset exists.
- `ddl.meta-mind.cn` is the leading domain candidate because the host already serves `*.meta-mind.cn`; it is not selected or configured until the user confirms it.

## Chosen Approach

Use a launch-first sequence:

1. Freeze the current product surface.
2. Make the deployment tooling compatible with the real BaoTa Nginx layout without mutating the host.
3. Establish the production trust boundary.
4. refresh and approve a current snapshot immediately before launch.
5. Merge and deploy only after an explicit production confirmation.
6. Add private scheduled discovery and human-reviewed data PRs.
7. Add monitoring, coverage accounting, and a controlled rollback exercise.

This is preferred over automation-first because the current data ages quickly and the existing verified release path is already usable. It is preferred over permanent manual maintenance because manual-only operation does not solve the product's freshness goal.

## Product Boundary

The first public release preserves the upstream interaction model:

- list and calendar views;
- filters, search, countdowns, and detail panel;
- approved static snapshot bundled at build time;
- official-source evidence and logistics, recommendation, and material summaries.

The first release does not add accounts, comments, a database, public mutation APIs, direct agent publishing, or public storage of personal application state.

## Deployment Architecture

The public site remains a versioned static release:

```text
protected main
  -> CI and public-boundary checks
  -> immutable release artifact
  -> production reviewer approval
  -> dedicated no-sudo deploy user
  -> /srv/cs-baoyan-ddl/releases/40-char-release-sha
  -> atomic /srv/cs-baoyan-ddl/current symlink
  -> BaoTa Nginx vhost
```

The repository supplies separate, versioned BaoTa-compatible HTTP-validation and final-HTTPS vhost templates. Neither declares another `default_server`. The HTTPS template has explicit certificate-path placeholders, exact-domain redirect behavior, Host rejection, static-asset handling, and SPA fallback. The bootstrap script accepts the real Nginx binary and vhost destination explicitly. It continues to fail closed, restore the previous config after an Nginx validation or reload failure, and never edits DNS, firewall, `sshd`, or TLS assets.

TLS is a production stop gate. HTTP may be used only for local host-header validation before public launch. The first public release requires a confirmed domain, DNS pointing to the host, a valid certificate whose SAN contains that exact domain, positive and negative SNI/Host checks, HTTPS smoke checks, and proof that requests for the selected domain do not receive an unrelated default certificate.

## GitHub Trust Boundary

Before merging PR #2:

- create the `production` environment;
- require a human reviewer for production deployments;
- restrict environment deployments to protected `main`;
- configure `TENCENT_HOST`, `TENCENT_PORT`, `TENCENT_USER`, `TENCENT_SSH_KEY`, and `TENCENT_KNOWN_HOSTS` as environment secrets;
- configure `PUBLIC_BASE_URL` as an environment variable;
- protect `main`, disallow force pushes, and require status context `verify` from workflow `CI`.

Every local launch commit must be pushed through an explicit approval gate. Before the PR is marked ready or merged, the workflow must prove that local `HEAD`, the remote branch head, and PR #2's head SHA are identical, then wait for status context `verify` from workflow `CI` on that exact SHA. Immediately before merge, freshness is checked against a snapshot materialized directly from the approved commit, not against a mutable working-tree file. A previously green CI run for an older PR head is not release evidence.

The scanning workflow never receives Tencent credentials. The deployment job never receives private scouting workbooks, submitted-project IDs, personal rankings, or local evidence paths.

Post-launch refresh tooling is integrated through its own reviewed tooling PR. Monitoring reads a separately approved repository-level `PUBLIC_BASE_URL` variable because it deliberately has no production-environment access. Genuine admissions updates are created afterward from updated `main` on a clean data-only branch; tooling and workflow changes cannot be smuggled into that data PR.

## Refresh Architecture

The refresh loop remains split across private discovery and public release:

```text
official sites + official accounts + application systems
        + discovery-only aggregators
                    |
                    v
private scan-cs-admissions-events run
                    |
                    v
validated private workbook and JSON
                    |
                    v
ignored candidate + deterministic diff
                    |
              human approval
                    |
                    v
approved public snapshot -> data-only PR -> CI -> merge -> production approval
```

During the high season, private discovery uses one two-hour recurring Codex automation around the clock. This exceeds the minimum 08:00-24:00 plus overnight coverage while fitting the scheduler's stable hourly-interval contract; enabling its recurring compute cost remains a user confirmation gate. Every run checks Baoyan Notice, CS-BAOYAN DDL, and official school or college surfaces. Aggregators can create candidates but cannot establish confirmed status.

New, changed, removed, promoted-from-pending, and deadline-within-72-hours rows receive priority review. A missing aggregator entry or an unsuccessful search never proves that an official opportunity has disappeared.

## Coverage Accounting

The private workflow maintains a coverage matrix across:

- school and college watchlists for CS, software, AI, cybersecurity, and explicitly adjacent programs;
- geographic regions and school tiers;
- official graduate-school and college notice pages;
- official application systems and official public-account notices;
- Baoyan Notice, CS-BAOYAN DDL, and BoardCaster discovery feeds;
- checked, blocked, pending, confirmed, and stale-review states.

The public site continues to describe coverage as partial. The system improves evidence and timeliness but does not claim that nationwide completeness has been mathematically proven.

## Failure Semantics

- A scan failure preserves the current approved snapshot.
- An empty or no-active candidate fails closed.
- WAF-blocked or unreadable official pages remain pending.
- A validation, build, smoke, upload, or activation failure preserves the previous release when one exists.
- A failed first activation removes its `current` link.
- A stale-main deployment is rejected.
- A launch deployment fails closed when the approved snapshot's `scanAt` or `approvedAt` is older than six hours at the final pre-deploy check.
- A production deployment requires a reviewer even after main and CI are trusted.
- A rollback chooses an explicit release SHA and verifies release identity before switching.

## Verification

Local and CI verification covers:

- unit tests and deployment-script failure paths;
- approved snapshot validation and public-data leak checks;
- Svelte and production builds;
- deterministic desktop, mobile, and narrow-mobile browser checks;
- BaoTa template properties and custom Nginx binary behavior;
- exact HTTPS certificate paths, redirect, Host/SNI, static-asset, and SPA contracts;
- real host read-only preflight;
- external HTTPS release identity checks after deployment;
- iPhone, Redmi, and desktop public smoke tests;
- a rollback-to-first and forward-to-second exercise after the second release.

## Acceptance Criteria

The launch milestone is complete only when:

1. the final domain and TLS certificate are confirmed;
2. BaoTa Nginx serves only the selected Host and passes `nginx -t`;
3. the dedicated deploy user has no sudo and only the required release-root ownership;
4. GitHub main and production controls are enabled;
5. the launch snapshot was freshly scanned and approved within six hours of release;
6. local `HEAD`, the pushed branch, PR #2, and successful CI all identify the same commit before merge;
7. HTTPS smoke verifies `releaseSha`, `snapshotId`, and `dataHash`;
8. desktop and both target phones pass public validation;
9. no submitted project or private scanning state is public.

The refresh-loop milestone is complete only when an actual scheduled private scan, not only a manual rehearsal, produces a reviewed data-only PR without exposing private state, and one genuine end-to-end refresh completes the full approval, exact-SHA CI, match-head merge, production approval, and public identity verification chain. The rollback exercise follows that second genuine release so it cannot block establishment of the refresh loop.

## Stop Points

Explicit confirmation is required before:

- creating or changing DNS records;
- issuing or installing certificates;
- creating the deploy account or changing server files;
- adding SSH authorization or GitHub secrets;
- enabling GitHub environment or branch permissions;
- merging PR #2;
- approving the first production deployment;
- running a production rollback exercise.
