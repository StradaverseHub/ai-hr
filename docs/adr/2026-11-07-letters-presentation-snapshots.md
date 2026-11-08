# Letters presentation uses an authorized database snapshot

Status: candidate; hosted qualification and rendered acceptance pending. Deployment remains held.

## Decision

The 35 ordinary Letters display roots own PostgreSQL REPEATABLE READ, READ ONLY
transactions. Each call copies its supplied session and nested inputs before
asynchronous work, proves its actual native login, Person binding, roles and grants
inside the transaction, and executes existing Letters capability, company, subject,
sensitive-field and row policy checks in that same snapshot. No authority or fact
result is cached across requests.

These roots cover company permissions; template, field and policy lists, details,
histories and dependencies; safe asset and signatory choices; settings readiness;
automation metadata; generation batch display and readiness; staff and recipient
letter detail; register, approval and delegate lists; audit history; pure template
preview; report departments and reports. Asset bytes and artifact downloads are
separate audit-producing operations and retain their command contract.

The read linearizes at snapshot admission, following the
[Personnel snapshot decision](2026-11-06-personnel-read-snapshots.md). A revocation
committed before admission denies the next snapshot. An admitted read overlapping
an uncommitted writer can finish with the preceding committed authority and facts.
A later commit cannot mix new source rows into that already admitted read. This
replaces waiting for an Access writer before making a presentation decision; it
does not revoke bytes already returned or cancel admitted reads retroactively.

## Native owners and effect boundary

Presentation does not acquire tenant Access or Payroll History advisory barriers.
Preview and generation batch readiness call the same canonical letter source and
snapshot functions as commands. An explicit private presentation mode omits row
FOR SHARE clauses while retaining the same employment-purpose authority, source
selection, effective date, compensation predicate, deterministic rendering and
source/content hash. The default mode remains command mode. An old immutable
revision remains intact when current facts change; readiness marks it stale and a
command must recapture a new revision before submission.

New pure Workforce picker and employment authorization seams require a native
RR/RO carrier and current actual principal, then call the existing native owner
queries. They grant no maintenance, payroll or Letters permission. The old borrowed
mutable and read-only shared-barrier picker APIs retain their original contracts.

Commands, audit-producing asset reads, access-token creation, downloads, issue,
approval decisions, generation, notification/delivery work and other effects keep
the existing READ COMMITTED History → Access → Letters arbitration and current
authorization checks. A display snapshot is never evidence authorizing an effect.
No provider, SMTP, policy, schema, migration or deployment change accompanies this
transaction boundary.

## Qualification

`test/letter-presentation-snapshot.test.ts` uses real native logins, two employee
subjects, salary and custom money fields, an approved template, a configured
approval chain, immutable drafts, an issued artifact, an awaiting approval and a
native automation job. Independent expected names, codes, dates, amounts, rendered
text and hashes accompany populated assertions. Each of the 35 roots must complete
while each actual exclusive Access and Payroll History writer is held; the test
also observes native RR/RO transaction settings and unchanged DomainEvent rows.

Additional cases prove actual SQLSTATE 25006 on a write, mutable-carrier denial,
unchanged legacy shared-barrier behavior, archived/revoked/forged login and Person
binding refusal, company/tenant/recipient/sensitive-field/capability isolation,
old committed source reads behind an uncommitted row writer, committed source
change detection, command recapture and command waiting followed by committed
capability-revocation refusal. The old Letters settings reader test now requires
completion behind an exclusive Access writer.

All application tests, compiler and build verification use standard hosted
Actions. Test source and a focused manifest alone do not establish a pass,
rendered correctness, sustained capacity, release acceptance or deployment
permission. Existing deadlines and resource limits remain unchanged.


## Conditional query-builder comparison: await the same selected source rows

Retained whole-compiler trace42482836874 on source5c8744b2 shows307 recursive type-relation depth-limit events at six person/company/assignment/position/department/compensation lock-choice expressions in `letterSources`. The selected817f integration parent retains those source expressions. The candidate moves each existing await into its selected conditional arm so TypeScript compares the resolved row results rather than two recursive Drizzle builder surfaces. Query construction, predicates, row locks, date/salary selection, native permissions, defensive ambiguity guards, public signatures and all other function bodies stay whole. The unmeasured employee-query ternary remains an unchanged control. No broad database facade, erased type, compiler option, root or heap change is introduced.

Three appended native registrations (four expanded cases) require actual assignment/compensation overlap SQLSTATE23P01 and constraint identities; use only legal superseded history; verify adjacent intervals created by canonical owners at the current-date boundary; and require exact missing-field refusals for legally absent position or compensation. Existing presentation and command results have independent known-value expectations, and preview reads leave events unchanged. Immediate native exclusions make a fixture with overlapping current rows illegal: no guard/constraint is disabled and these controls do not claim to execute the reader's defensive more-than-one-row branches. Existing cases, deadlines and the letter-workflow test remain whole; checked public preview input/result contracts remain rooted in the full compiler Program.

This is a source-authored candidate, not a causal OOM diagnosis or passing compiler/native result. The trace's type catalogue is unavailable and instrumented durations are not retained-heap attribution. A frozen candidate needs ROOT and a different peer source review, then separately authorized standard-hosted native and complete ordinary compiler verification with the full source/roots/options and existing runner limits. No provider/disclosure/source approval or release authority is renewed.
