# Trustworthy Event Arrangement Design

## Goal

Restore a core CS-BAOYAN-DDL workflow that the current verified-data rebuild lost: users must be able to see and filter whether an admissions event is online, offline, hybrid, or not yet published, while retaining the exact official-source wording for the event time and location.

This is a pre-launch contract correction. No public production release consumes the current schema, so the repository keeps `schemaVersion: 1` and replaces the unlaunched approved snapshot atomically after proving that all project identities and record counts are preserved.

## Product Outcome

The list view shows a compact event-mode badge on every row. The detail panel adds an `活动安排` section containing:

- activity type;
- normalized mode label;
- official event-time wording and fact status;
- official form/location wording and fact status.

The filter panel adds a `形式` group with counts and OR semantics. Selected modes persist in the URL and appear as removable active-filter chips. `清空全部` clears them.

The row and detail header also show the project title and activity type so two opportunities from the same institute remain distinguishable. Search includes project title and activity type.

The existing province value is labeled `院校所在地`; it is never presented as the event location. Actual event location remains the separately sourced `formatLocation` fact.

The calendar is explicitly labeled `截止日历`. A day containing more rows than the compact preview can show exposes an interactive control that opens the complete day list; no opportunity may remain behind a non-interactive `+N` marker.

When all approved rows have no maintained school-tier classification, the existing all-zero `档次` group is hidden. The release must not fabricate institutional tiers from accommodation, school names, or inconsistent legacy tags.

Status language is neutral across event types: active actionable records are `开放`, archived records are `已结束`. Date-only deadlines remain sortable using the conservative normalized end-of-day value, but the UI identifies the missing official time and does not present that inferred time as an exact official timestamp.

An optional direct-application CTA may be shown only when a separately verified application URL exists in an approved source field. The official notice remains available and is labeled `查看官方通知`; its URL is never relabeled as `立即报名` by inference.

## Public Data Contract

Each `PublicOpportunity` receives one required object:

```ts
type EventMode = 'online' | 'offline' | 'hybrid' | 'unknown';

interface EventArrangement {
  mode: EventMode;
  time: FieldFactGroup;
  formatLocation: FieldFactGroup;
}
```

`FieldFactGroup.summary` retains the source workbook wording. The importer maps `eventTime` into `time` and `formatLocation` into `formatLocation`; it never copies private evidence paths or personal application state.

The arrangement is required even when the source is sparse. Missing or explicitly unpublished text becomes `{ status: 'not-published', summary: '未公布' }`; uncertain or future-notice wording becomes `{ status: 'unverified', summary: '待官方公布' }` only when the existing fact-status rules support that conclusion.

## Mode Classification

The deterministic classifier reads only `formatLocation` and follows these rules in order:

1. Explicit hybrid wording such as `混合`, `相结合`, or the simultaneous presence of online and offline signals produces `hybrid`.
2. Explicit online signals such as `线上`, `云端`, `腾讯会议`, or `网络远程`, without an offline signal, produce `online`.
3. Explicit offline signals such as `线下`, `现场`, `到校`, or an explicitly named campus/校区, without an online signal, produce `offline`.
4. Everything else produces `unknown`.

The classifier must not infer mode from accommodation, meals, reimbursement, transportation, a city name alone, or event type. Mixed subprogram wording remains `hybrid`; the detail text preserves the distinctions for users.

## Validation And Privacy

Candidate and approved-snapshot validation must:

- require exactly `mode`, `time`, and `formatLocation` under `eventArrangement`;
- reject unsupported mode values and extra keys;
- validate both fact groups with the existing strict fact validator;
- include the arrangement in the canonical hash and snapshot diff;
- continue rejecting private markers, filesystem paths, credentials, and non-official actionable rows.

The importer fixture proves all four modes, sparse expired-row behavior, exact source-text retention, and no inference from logistics.

## UI And Accessibility

Mode labels are `线上`, `线下`, `混合`, and `待公布`. List badges use Lucide icons and text so color is never the sole signal. They have stable compact dimensions, wrap safely with existing verification and school tags, and do not change row height unpredictably on narrow screens.

The detail section is placed after deadline information and before logistics. Fact statuses remain visible beside the corresponding source wording. Filter buttons expose `aria-pressed`, counts, and explicit Chinese labels. URL values use stable English enum values under `modes`.

## Migration

The source of truth is the latest private scouting JSON. Migration performs these checks before replacing `data/approved/current.json`:

1. import a candidate without treating the old pre-launch snapshot as deployable schema evidence;
2. compare old and new `projectId` sets and status counts;
3. require zero lost or added project identities unless a fresh official scan intentionally changed them;
4. approve to a new temporary path so the first launch snapshot has `previousSnapshotId: null`;
5. validate the new approved snapshot, then replace the repository snapshot as a generated artifact;
6. prove no submitted IDs, private paths, or private scouting-only fields are public.

Because release freshness is six hours, an older source workbook may be used for implementation verification but cannot be the final launch snapshot. A fresh scan and approval remain mandatory immediately before production publication.

## Failure Semantics

- Unknown official wording is displayed as unknown, never guessed.
- A missing required arrangement fails candidate validation.
- An invalid mode fails validation and cannot be approved.
- A failed import, identity comparison, approval, build, or browser check leaves the existing approved file unchanged.
- A stale final snapshot blocks release even if all feature tests pass.

## Acceptance Criteria

1. Every approved opportunity has a valid event arrangement.
2. The current source corpus produces deterministic online/offline/hybrid/unknown counts.
3. List, detail, filter, URL restore, browser navigation, and clear-all behavior work on desktop, iPhone-size, and Redmi-size viewports.
4. Project title/type are visible and searchable; school location and event location are not conflated.
5. Dense calendar days expose every item through an interactive complete list.
6. The all-zero school-tier group is not shown.
7. Unit, type, production build, E2E, accessibility, public-boundary, and real-data checks pass.
8. Project identity sets, public record counts, official-source requirements, and privacy guarantees remain intact.
9. Independent spec, frontend, data-contract, security/reliability, and final verification reviews have no unresolved blocking findings.

## Stop Points

Local implementation, generated local snapshots, tests, and commits are authorized by the user. Explicit confirmation remains required before changing GitHub environments or repository permissions, pushing the branch, merging PR #2, changing production server state, or approving a production deployment.
