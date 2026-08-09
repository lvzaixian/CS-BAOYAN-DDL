# Timely CS Admissions DDL Working Agreement

## Product Boundary

Preserve the upstream CS-BAOYAN-DDL interaction model. Improve freshness and evidence quality without adding accounts, comments, a database, or a public write API in v1.

## Source Authority

Aggregators are discovery sources only. A record may enter the actionable main list only when an official school, college, institute, official application system, official WeChat account, or official attachment supports it.

## Data Flow

`data/staging/candidate.json` is never deployable: it must pass candidate validation and carry no approval metadata. Only approved `data/approved/current.json` may be bundled into production. An approved `current.json` must pass `pnpm run snapshot:validate` and preserve `snapshotId`, `previousSnapshotId`, `scanAt`, `approvedAt`, and `dataHash`.

For ordinary admissions updates, treat the approved snapshot as an append-only archive: a candidate must retain every parent project unchanged and may add only newly verified canonical projects. Do not infer removal, closure, correction, or field replacement from a missed scan, blocked page, stale aggregate listing, or newly found richer source. Deadline-based expiry belongs to the data/UI classification path; it must retain the historical record rather than delete it. Corrections, identity merges, and explicit removals are separate user-authorized maintenance work.

## Privacy

Never commit submitted-project lists, personal fit scores, contact details, target-folder paths, private evidence paths, credentials, or application status.

## Release

Production deploys are static and versioned. A failed scan, validation, build, upload, or smoke check must leave the previous release serving when one exists; a failed first release must remove its `current` link. Do not grant scanning agents production SSH keys.

Normal data additions should use one automated release path: validate official evidence and append-only diff, atomically approve the public snapshot, merge to protected `main`, run CI, deploy, then verify the public endpoints. Do not add a manual reviewer, deletion authorization, or private-workbook gate to an ordinary addition. Keep official-source evidence, public-boundary checks, CI, atomic activation, and smoke validation. See `docs/operations/data-refresh.md` for the target contract and its explicit code-migration status.

## Upstream

Keep the MIT license and upstream attribution. Pull UI changes from `upstream` manually. Never restore the BoardCaster whole-file overwrite workflow or the upstream CNAME.
