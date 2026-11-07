# PR 229 staging source binding

The repository owner explicitly approved carrying forward the 28 existing provider-data approvals
on 7 November 2026, at 07:20:28 UTC, in deployment chat
`01a1b47d-abff-7992-85e4-a11a110fca0e`. The recorded answer was
“Approve carrying forward the existing 28”. This approval covers the exact provider fingerprint
`13b38cf5f2b52b1eadff341c2f1ef1c14262e3255c7d3d6bff8baab270afcf80` (1,458 files).
It preserves the original reviewer, evidence and time fields of those 28 records and leaves both
pending records byte-for-byte unchanged. It adds no provider purpose, configuration, evaluation
or promotion authority. Staging qualification, arrival and human acceptance remain separate.

The compared installed source is `a4bd903840cdae2a94e67d5f57e3b54c9e2a86ac` and the
assessed application checkpoint is `36c1036472f0e7c496a9569bd1d95770570c2f12`.
Only four provider-covered files differ: `lib/lifecycle-v9-case-form.ts`,
`lib/lifecycle-v9-model.ts`, `packs/lifecycle/onboarding/service.ts`, and
`packs/lifecycle/v9/service.ts`. Their changes implement current authorized Personnel facts,
form field visibility/removal/restoration, preserved terminal snapshots and email sensitivity.
A company rebind requires HR authority in both companies. Removed HR-only fields remain
sensitive for email handling. Provider workloads, prompts/serializers, transports, destinations,
purposes and outgoing field categories are unchanged. Package and lockfile bytes are unchanged.

Only the 28 literal source-digest values are renewed. The module-agent manifest is generated last.
The provider manifest generator excludes those literal review records, so this renewal and the
upgrade-test fixture correction preserve the approved provider fingerprint. Later covered source
changes require a new scoped assessment; tests alone do not supply human approval.

The original release runs 42349561321 and 42350277439 remain failed on their exact sources.
The former refused stale generated admission before planning; the latter exposed stale literal
approvals and a missing expected migration tail. Successful results keep their producing identities.
The repair appends the exact new migration tag/index/timestamp and independently pinned SQL hash
to the shared populated-upgrade fixture; no historical assertion or applied SQL is changed.
No release PASS, installed build, staging acceptance or production authority is claimed here.
