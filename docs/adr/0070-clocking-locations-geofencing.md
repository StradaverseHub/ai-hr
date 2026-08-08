# ADR-0070 — Clocking locations & geofencing

## Status
Accepted

## Context
The reported feedback asks for a Clocking Location Management feature: HR defines authorized
clocking sites (name + lat/lng + optional address/remarks), assigns one or more to each employee,
and can enable per-employee geofencing with a configurable radius. On check-in/check-out the
system compares the employee's browser-supplied GPS position against their assigned sites and
blocks the punch if they are outside every assigned site's radius, showing a specific message.
When geofencing is off, punches are allowed from anywhere but coordinates are still captured for
audit/history.

ADR-0054 (`location` master data) explicitly scoped out "geofencing / GPS / lat-long columns" as a
non-goal — that table exists to feed a `state` override into holiday resolution, not to gate
clocking. This ADR builds the clocking-side feature as new, additive substrate.

## Decision

### 1. Separate `clocking_location` table (not an extension of `location`)
Rejected extending `location` with lat/lng + a geofence flag. Reasons:
- **Lifecycle/semantics differ.** The request requires hard DELETE of clocking sites (in addition
  to archive). `location` backs holiday-calendar resolution and effective-dated `assignment`
  history; deleting rows from that master risks holiday calendars and historical assignment
  reads. Clocking sites (often ephemeral project sites) churn independently and are expected to be
  hard-deletable when unreferenced.
- **`location.code` is mandatory and unique** (`cleanCode` throws on empty) — a code namespace
  clocking sites have no use for and that would force meaningless values.
- **RLS visibility.** `location` RLS is `is_admin_for(company_id)` on BOTH read and write (a
  different-company admin cannot even see it). `clocking_location` deliberately uses the wider
  0065 `pay_component` tenant-catalog pattern (every tenant member reads; only admins write) — see
  point 2. Retrofitting that visibility change onto `location` would loosen access to existing
  holiday master data; a new table exposes only new data.
- **Double-master smell, acknowledged.** Two site registries (holiday-calendar `location` and
  `clocking_location`) will sit side by side on the same admin page. If a site like HQ exists in
  both, HR maintains it twice for now. A nullable convergence link
  (`clocking_location.location_id`) is flagged as a deferred follow-up, not built here.

### 2. RLS: tenant-catalog read, company-admin write (mirrors 0065 `pay_component`)
`clocking_location` policy: `USING (tenant_id = current_tenant_id())`,
`WITH CHECK (tenant_id = current_tenant_id() AND is_admin_for(company_id))`. Every tenant member
(including a plain employee) can SELECT the catalog tenant-wide; only an admin of the site's own
company can INSERT/UPDATE/DELETE it. Consequence, documented deliberately: an admin of a sister
company within the same tenant can read another company's site names/coordinates. This is treated
as low sensitivity (comparable to `pay_component`'s tenant-wide catalog read) and is what makes
matched-site NAME resolution work for a manager viewing a subordinate's attendance history and for
an employee viewing their own history after being un-assigned from a site (the join still resolves
the name via the tenant-wide read policy, not an admin-scoped one).

`employee_clocking_location` (the assignment join table): SELECT via
`app.can_see_employment(employment_id)` (same visibility as other employment-scoped rows);
INSERT/DELETE via `app.can_admin_employment(employment_id)` (mirrors
`employment_pay_component`'s policy).

### 3. Blocked attempts are domain events, not attendance rows
`attendance.check_in_geofence_status` / `check_out_geofence_status` can only be `pass` or
`not_enforced` — there is no `fail` value in the DB. A blocked attempt writes **no** attendance
row at all (the check-in/check-out transaction rolls back). The auditable fact — "this employee
tried to punch from outside their geofence" — is recorded as a domain event,
`attendance.geofence.blocked`, on `aggregateType: 'attendance-geofence'`.

**Mechanism (this is the one deliberate exception to "event follows write in the same
transaction"):** `checkIn`/`checkOut` run the existing write inside one `withTenant` transaction.
When geofencing is enforced and the employee is outside every assigned site's radius, the
transaction throws a typed `OutsideGeofenceError` and rolls back — nothing is persisted from that
transaction, including an event (an event can never commit inside a transaction that itself rolls
back). The exported `checkIn`/`checkOut` catch `OutsideGeofenceError` **outside** that transaction
and open a **second, independent** `withTenant` call whose only job is to `appendEvent(...)` the
blocked attempt, then rethrow the original error to the caller. This second transaction commits on
its own. `withTenant` sets the `app.tenant_id` / `app.user_id` / `app.grants` GUCs itself for each
call (see `db/client.ts`), and when `AUDIT_HASH_CHAIN_ENABLED` the ADR-0030 hash-chain trigger
reads those same per-transaction GUCs — so the chain is intact for this second transaction exactly
as it would be for any other. The `domain_event` append policy only checks `tenant_id`, so the
acting employee's own session can insert this event about themselves.

`subjectEmploymentId` on the blocked event is always the employment id **resolved server-side**
inside the first (rolled-back) transaction — never taken from client input — so per ADR-0015 the
employee can read their own blocked-attempt events without being able to forge someone else's.

**Caveat, documented not fixed:** the blocked event's `date`/`time` payload fields come from the
same `nowParts()` helper `app/me/actions.ts` already uses for check-in/out (UTC calendar date +
server local time-of-day). This is an existing, pre-existing inexactness in the codebase, not
introduced here; flagged because the blocked event is a compliance artifact.

### 4. Fail-closed
Geofencing ON with **zero** active assigned sites blocks the punch (same `OutsideGeofenceError` /
blocked-event path, with `nearestLocationId: null`). An employee who is enforced but has nothing
assigned is not silently exempted.

### 5. Missing browser coordinates
- Geofencing **ON**, no coordinates supplied: throws a typed `GeolocationRequiredError`. This is
  treated as a client-side precondition failure — nothing happened in the domain, so **no** event
  is appended for it (distinct from `OutsideGeofenceError`, which IS a domain fact worth an audit
  trail).
- Geofencing **OFF**, no coordinates supplied: the punch succeeds with null coordinates. A browser
  permission denial can never brick clocking when enforcement is off.

### 6. Per-punch capture columns; last writer owns that punch
`attendance` gains, **per punch** (check-in and check-out each get their own full set), all
nullable: lat/lng, matched assigned clocking-location id, distance in metres, geofence status
(`pass` | `not_enforced`), the radius that was actually applied, and the punch method
(`web` | `import`). Splitting per-punch (rather than one set of columns per attendance row) covers:
an imported check-in followed by a self-service web check-out (representable — in-side columns say
`import`/null-geo, out-side columns say `web`/stamped-geo); a mid-day radius change or geofencing
toggle between the check-in and check-out punch (each punch freezes the status/radius that applied
when IT was written, not a value that could drift after the fact).

`importAttendancePunches` and `decideAttendanceCorrection` each null the geo-capture columns of any
punch they overwrite, so an import or a correction can never leave a stale geofence attestation
sitting next to punch times it didn't actually validate. Geofencing does not apply to either path
(the terminal import's physical presence at the device is its own proof; a correction is a human
HR decision that already went through approval) — both are disclosed bypasses of the geofence, not
oversights.

### 7. Browser-GPS accuracy and spoofing — deterrent, not tamper-proof
Browser geolocation can be off by tens to hundreds of metres indoors and can be spoofed by a
technically capable user (browser dev tools, a rooted/jailbroken device, GPS-spoofing apps). This
feature is a deterrent and an audit record, not a tamper-proof control. Recommended radii are wide
(200–500 m) precisely to avoid wrongly blocking honest employees on ordinary GPS drift. Capturing
`coords.accuracy` per punch would strengthen the audit record further; flagged as a follow-up, not
built now (out of the request's explicit field list).

### 8. Skip the site query entirely when geofencing is off
When `employment.geofencing_enabled` is false, `checkIn`/`checkOut` never query
`employee_clocking_location` or compute a haversine distance — they stamp raw coordinates (when
supplied) with `status: 'not_enforced'` and leave site/distance/radius null. This keeps the
non-enforced hot path at its pre-existing query count.

## Superseded in part by 1fff489c (2026-08-09)
Two deferrals recorded below are now CLOSED, and one decision here was reversed:
- **The convergence link is built.** `clocking_location.location_id` (migration 0419) is nullable in
  the database but REQUIRED by the service, and points render grouped under their location on the
  admin screen. The "double-master smell" of §1 is resolved in the direction §1 anticipated: two
  tables, one of them now explicitly subordinate.
- **The radius moved onto the site.** `clocking_location.radius_m` (0419) is the authoritative
  allowed distance. `employment.geofence_radius_m` survives as an OPTIONAL PER-EMPLOYEE OVERRIDE,
  and `employment_geofence_radius_required` is DROPPED, because "enabled with no override" is now
  the recommended state. `resolveGeofence` was rewritten from "nearest site vs one radius" to
  "pass if ANY assigned site contains me, judged against its own radius" — the nearest site is no
  longer the deciding one when radii differ, and the nearest is computed only for the refusal
  payload. `OutsideGeofenceError.info.radiusM` is consequently nullable (null only when there is no
  nearest site, i.e. zero assigned sites, where it travels with a null `distanceM`).
- **`location` gains a `branch`** (0420), unique per COMPANY, which lets the employee's Attendance
  tab PROPOSE a work location from the branch already on their Employment tab. It never
  auto-commits.
- **A duplicate save no longer reaches the banner as SQL.** `location` carries two partial unique
  indexes (`location_code_uq`, `location_branch_uq`); tripping either used to surface drizzle's
  `Failed query: update "location" … params: TWO,Two,MY,,BUKIT JALIL,…` in `?error=`, because
  `app/admin/_redirects.ts fail()` copies `(e as Error).message` verbatim. `createLocation` /
  `updateLocation` now map 23505 to `LocationBranchTakenError` / `LocationCodeTakenError` (the
  `core/roster.ts shiftUniqueError` shape: sniff the code down the cause chain, discriminate on the
  constraint NAME), and `app/admin/actions.ts` localises them. The branch error carries the CODE of
  the location already holding the branch, resolved in a SECOND transaction because the one that hit
  the violation is aborted.
- Still deferred: the embedded map picker (no tile provider is configured and the deployed host has
  no outbound key for one).

## Consequences
- Two site registries exist side by side (see §1); the nullable
  `clocking_location.location_id` convergence link is now BUILT (1fff489c, migration 0419).
- A determined employee can still get a blocked punch recorded by filing an attendance-correction
  request, which routes through the existing HR-approval flow (`decideAttendanceCorrection`). This
  is treated as acceptable — a human approves it — but is a known, disclosed bypass alongside the
  terminal-import bypass.
- PDPA: coordinates are captured on every punch (even when geofencing is off, per the request) for
  attendance verification and audit purposes only; they must not be repurposed for movement
  profiling. The employee can see their own captured coordinates in their own attendance history
  (transparency by design). A small persistent notice on the /me clock buttons states that location
  is recorded — one translated sentence, one step beyond the literal ask, reviewer may strike it.
  Retention rides on the existing attendance-record retention posture; whether these fields need
  stronger personal-data-vault treatment is flagged as a follow-up, not decided here.
- Deferred (Phase 2, not built): an embedded map picker (coordinates are typed in as plain numbers,
  copied from Google Maps, for now); reverse-geocoding captured coordinates into a street address
  (we store coordinates + the matched named site, which satisfies "address if available" without a
  paid geocoding service); kiosk or native-mobile enforcement (neither exists in this codebase);
  additional anti-spoofing hardening; the `location` ↔ `clocking_location` convergence link (this
  last one is no longer deferred — see "Superseded in part by 1fff489c" above).
