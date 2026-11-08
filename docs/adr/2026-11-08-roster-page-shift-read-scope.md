# Roster page shift projection and exact rotation dependencies

Status: implemented source; hosted qualification pending. This is consumer adoption of the shared presentation read architecture, not a separate loading framework.

## Verified source and issue

This isolated change is based on `c5e36cb03095527ba1fb6a0e8fc2bf54080f2c46`. Freshly fetched `main` and `alpha` were both `9dd3847b4a3ce9e4cf4df744edcf10b250dcbbb8`; their current changes do not modify these owner bodies. The root owns integration of that canonical history separately.

The ordinary `rosterWindowPage` already admits a current calling principal into one REPEATABLE READ / READ ONLY transaction. It bounds employees before canonical cell hydration. However, its shift-library call materializes all tenant rule memberships and all rotation versions to calculate `allowedRuleIds`, which hydration never consumes. The usual-shift owner independently loads every tenant rotation and every referenced shift before discarding rules unrelated to the page.

## Decision and preserved behavior

`rosterDisplayShiftsTx` selects only the grid's existing shift DTO, with the same native RLS, active-template predicate and start-time/name ordering. It returns the entire active tenant library, including legacy company templates. It does not cap or restrict available shift choices. Settings and command consumers retain `listShiftsForTenant` and its complete eligibility calculation; canonical write admission is unchanged.

The shared `rotationLookupTx` accepts an optional exact rule-ID scope. Omission retains its original complete behavior. An explicit empty scope reads no versions or shifts. A nonempty scope retains every immutable version of each named rule, with the original rule/date ordering, and fetches every referenced shift including archived sources. It introduces no date pruning, cache, new transaction, lock, timeout or permission bypass.

`usualShiftsFor` derives those dependencies from native page-member rows and live arrangement periods. An explicit employee schedule group wins. Otherwise, when live periods exist, their rules replace the current default-shift rule, including null-rule periods. With no periods the default-shift rule applies. The week fallback, earliest-period/date precedence, no-default rotation behavior and canonical cell resolver are unchanged. The caller supplies the same presentation transaction to every read. The core usual-shift owner also remains suitable for complete artifact consumers, which simply supply their complete employment set.

This bounds rotation transport by the actual employee dependencies instead of unrelated tenant history. Complete history of a referenced rule and the complete active shift library remain intentionally uncapped. It does not establish bounded latency for arbitrary user-authored relevant history or close Analytics, Payroll, Leave, Attendance, all-submenu, browser, load, worker or release acceptance.

## Qualification

The new native fixture has six distinct precedence cases, 104 tenant rotation versions (100 unrelated), active/shared/legacy company templates and an archived referenced rotation shift. A frozen copy of the original c5 usual-shift function, with only its export name changed, supplies a native parity oracle. Tests assert exact full output, independently expected cells, no-default behavior, relevant version/source retention, omitted versus empty scopes, native query parameter/row census (104 original versus four relevant rotation rows), and one-statement complete active shift projection. Foreign template isolation remains enforced by real RLS. Optional timings are reported only as a component observation, never release eligibility or a speed threshold.

Planned standard GitHub-hosted focused checks include the new native file and existing Roster presentation snapshot/RLS/Access-writer/50,000-employment tests, borrowed-reader failure settlement, schedule-rotation behavior, grid DOM and pack drift controls. Source review and external parser checks are distinct from executed behavior. Whole compiler, browser, load, staging acceptance and production authority remain separate. No local repository behavior, database, tests, generators, compiler or builds are used. No staging or production action is authorized by this ADR.

Source correction: the frozen `d6905717a02ba535a210ede9378f2f89e47bdad5` test helper omitted its `eq` import. The correction child adds that import only; the original oracle function body, production code and all test assertions remain byte-identical. This fixes an unexecuted fixture defect and supplies no passing behavior evidence.
