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
  no outbound key for one). **[SUPERSEDED — see "Amended 2026-09-15 (fa2db8cb rev 2, r279)" below.]**

## Amended 2026-09-11 (f9afd1ce) — a clocking location is a shared, tenant-level record
Migration 0459. Three changes to the decision above; §1 (a separate table from `location`) stands.
- **Shared, not company-owned.** `clocking_location.company_id` is DROPPED (not made nullable — a
  nullable owner would be two kinds of row nobody asked for). One record per physical place per
  tenant, available to every company; the name index becomes `(tenant_id, name)`. Assignment is no
  longer scoped by company: an employee of company B may be assigned a gate that also serves
  company A, and the `CrossCompanyClockingLocationError` guard is deleted. RLS on
  `employee_clocking_location` (`can_admin_employment`) is unchanged and is the guard that matters
  there. Measured on production 2026-09-10: both tables held 0 rows, so there was no data step and
  no deduplication judgement; the migration reports the count it finds at apply time.
- **§2's write authority moves from admin-of-the-site's-company to GROUP ADMINISTRATOR.** A shared
  record may be in use by companies an administrator does not manage. The single `FOR ALL` policy
  (whose `USING` alone governed DELETE, so the database never restricted who deletes) is split into
  four verb policies: SELECT stays tenant-wide (unchanged reason: name resolution under non-admin
  sessions); INSERT, UPDATE and DELETE require `app.is_group_admin()`. Enforced in three places on
  purpose: RLS, the service (`assertGroupAdmin` in every writer — the one that answers in plain
  English; an UPDATE policy's `USING` filters silently rather than throwing) and the screen (forms
  rendered for group admins only; a company-scoped admin sees the register read-only with a note).
  The page guard stays `requireAdmin`: company admins still manage their own `location` rows on the
  same page and still assign sites on the personnel page.
- **The `location` link (1fff489c) becomes OPTIONAL and may point at a non-archived location of ANY
  company.** `location` is company-scoped; a site five companies share cannot honestly be required to
  belong to one company's holiday-calendar record. Unlinked sites render under "Not linked to a
  location"; a site linked to a location the caller's RLS cannot see renders under its own group
  rather than as unlinked. The personnel pre-tick (sites whose `location_id` matches the employee's
  resolved location) is kept; its empty state now reports how many sites are linked and that every
  shared site is offered, and never claims clock-in is unavailable when shared sites exist.
- Not done, as the plan said: no map, no address search, no timezone, no deduplication. **[SUPERSEDED — see "Amended 2026-09-15 (fa2db8cb rev 2, r279)" below.]**
  (The timezone and the deduplication are still not done.) "Used by"
  on the admin screen is derived from assignments (distinct companies of assigned employees), never
  stored.

## Amended 2026-09-11 (f9afd1ce rev 2, r267) — a page of its own, and a report label
Migration 0461. The shared record above is unchanged; two things are added around it.
- **`clocking_location.report_label` (nullable text).** A short name the Attendance report's Clocking
  Location column prints INSTEAD of the full site name; blank means the name is printed
  (`core/reporting.ts` reads `coalesce(report_label, name)` for that one column). Every other reader —
  the locations list, the employee's profile, the clock-in screen — keeps the name. The blank-means-name
  rule is enforced in the service (`cleanReportLabel` stores NULL for an empty label), not as a CHECK.
- **The screen.** A clocking location is added and edited on a dedicated full-width page
  (`/admin/locations/clocking/new`, `/admin/locations/clocking/[id]`, registered on the existing
  `locations` screen column) in two sections in the reporter's order — Location information, then GPS
  and clocking settings. **[The TWO SECTIONS are SUPERSEDED — see "Amended 2026-09-24 (0fe1ca2e rev 6,
  r335)" below: one section, and `Location information` is retired. Everything else in this bullet
  stands.]** The list's rows are read-only with Edit; Archive / Restore / Delete stay on the
  row. The clocking register now leads the Locations page so the "Clocking location" menu row lands on
  it. Address search and a map preview are a separate item, planned once a map provider is chosen; the
  page's section order leaves room for them and carries no placeholder. **[SUPERSEDED — see "Amended 2026-09-15 (fa2db8cb rev 2, r279)" below.]**

## Amended 2026-09-15 (fa2db8cb rev 2, r279) — the map and the address search are BUILT, keylessly
No migration. This SUPERSEDES the four "deferred / not done" lines above that record the absence of a
map: the two in §"Amended 2026-09-11", the one in §"Amended 2026-09-11 … rev 2, r267", and the Phase 2
line under Consequences. Everything else in this ADR stands. The screen is
`/admin/locations/clocking/new` and `/admin/locations/clocking/[id]`; nothing stored changed and the
posted field set (`CLOCKING_FIELDS`) is the same eight.

- **WHY NOW, WITH NO KEY.** The original deferral said "no tile provider is configured and the deployed
  host has no outbound key for one". That is still true and is no longer a reason to wait. The item was
  approved three times and blocked twice asking the reporter for a Google Maps key; no key followed
  either time, and `.env.production` on the box holds fifteen variables, none of them one. A third
  block would repeat a move that has twice failed. The decision taken instead: build on free, keyless
  open map data now, so the reporter gets the thing they asked for without owing us anything.
- **THE PROVIDER IS A SEAM, NOT A CHOICE BAKED INTO THE SCREEN.**
  `app/admin/locations/clocking/map-provider.ts` is the one module that knows where tiles come from,
  where an address search goes and WHETHER SATELLITE EXISTS. The default is OpenStreetMap raster tiles
  plus Nominatim search, keyless. `resolveMapProvider({})` returns a working provider and never throws.
- **A KEY ALONE DOES NOT FLIP IT — the supplier's templates do, and that is deliberate.** The approved
  plan told the reporter that sending a Google key would switch the same screen over. The seam delivers
  the switch as a `.env.production` edit with no rebuild, but selection is by CONFIGURATION
  (`MAPS_TILE_URL` + `MAPS_ATTRIBUTION`, optional `MAPS_SATELLITE_TILE_URL` / `MAPS_GEOCODE_URL`, with
  `{key}` substituted from `MAPS_API_KEY`) rather than by the presence of a key. No two suppliers agree
  on a tile URL and Google's own 2D raster tiles are issued against a session token obtained by a POST,
  not a static template — writing that branch from memory would have been inventing third-party API
  behaviour, which this repo forbids. A correction is owed to the reporter on the exact wording: a key
  plus one line of configuration, not a key alone.
- **NO SATELLITE, SAID OUT LOUD.** Every supplier of satellite imagery (Google, Mapbox, MapTiler, Esri)
  requires an account and billing. The seam reports `satelliteTileUrl: null`, and the Satellite control
  renders VISIBLY DISABLED with the reason beside it rather than being quietly dropped. That disabled
  state is a promise made to the reporter and is pinned by test, in source and in rendered HTML.
- **THE POLICY LIMITS ARE DESIGN CONSTRAINTS, not footnotes.** The OSMF tile policy and the Nominatim
  usage policy forbid search-as-you-type, require attribution and guarantee no availability. So: the
  search runs ON SUBMIT ONLY (button or Enter, never `onChange`), nothing is cached, the attribution is
  rendered by us in the page's own markup (Leaflet's own control is off) so it is visible before the
  library loads and still visible if it never does, and latitude, longitude and radius REMAIN ORDINARY
  REQUIRED BOXES so a site can be created with no map at all.
- **THE CLIENT-ISLAND RULE THIS SCREEN NOW LIVES UNDER.** `clocking-form.tsx` stays a server component;
  the map and the search are two separate `'use client'` files (`clocking-map.tsx`, `address-search.tsx`)
  and each takes exactly ONE prop — the resolved provider descriptor, a plain object of strings, numbers
  and nulls. Their localised text comes from `useTranslations` inside the island, not from label props,
  so nothing callable crosses the boundary (r272 shipped a 500 doing exactly that). The islands own no
  posted value: the search WRITES `address` / `lat` / `lng` into the uncontrolled inputs and the map
  READS `lat` / `lng` / `radiusM` out of them, so the refusal-echo contract in `form-fields.ts` is
  untouched.
- **Leaflet 1.9.4 is a pinned npm dependency**, not a CDN script tag: this is a self-hosted product and
  the test environment must not reach the network. It is imported dynamically inside the mount effect
  because the library reads `window` while it initialises.
- Still NOT done, and still deferred: a timezone per clocking location (the whole system assumes
  Malaysian time); deduplication of sites; reverse-geocoding captured punch coordinates into a street
  address; dragging or clicking the marker to set the point (the boxes and the search set it).

## Amended 2026-09-24 (0fe1ca2e rev 6, r335) — ONE section, and the Location-information heading is retired
No migration, no schema change, nothing stored differently, and `CLOCKING_FIELDS` is still the same
eight. This supersedes ONLY the "two sections" half of the screen bullet under "Amended 2026-09-11
(f9afd1ce rev 2, r267)".

- **WHAT THE REPORTER CONTESTED, precisely.** Not the behaviour. r279 had already made the address
  search fill Address, Latitude and Longitude, and the search was already ABOVE Latitude — but in the
  OTHER card, with the whole of "Location information" between it and the two boxes it writes. A card
  boundary between a control and the fields it fills is the defect; the connection was invisible.
- **THE SCREEN IS NOW ONE CARD**, under the existing `admin.locations.sectionGps` heading, in the order
  the reporter approved: Find an address → Address → Latitude → Longitude → Clocking radius (metres) →
  Name → Report label → Clocking location link (rendered only when one exists) → Remarks.
- **`admin.locations.sectionInfo` is RETIRED from all six locales.** A heading no screen renders is a
  string the next reader has to prove is dead. Its absence is asserted (test/clocking-location-shared)
  so a deep-merge of an older branch's `messages/*.json` cannot resurrect it silently.
- **ADDRESS STAYS, directly under the search.** The reporter's sketch omitted it. It is the field the
  search WRITES and the one `core/reporting.ts` prints, so dropping it would have discarded the address
  just looked up. The plan told them so.
- **THE MAP STAYS DIRECTLY UNDER THE COORDINATES** it draws, above the descriptive fields. Putting four
  text boxes between lat/lng/radius and their picture would have repeated, against the map, the exact
  complaint this amendment fixes for the search.
- **Named consequence, disclosed in the plan:** Name now sits BELOW the coordinates, which reads
  slightly oddly — naming a place after locating it. The reporter was offered the option of lifting it
  back to the top with the rest of their order unaffected.
- **The three traps the move had to clear, none of them changed.** The islands still find the inputs
  through the ENCLOSING FORM (`form-bridge.ts`, `closest('form')`), so the search had to stay inside the
  same `<form>` — a layout change that moved it out would break the fill in silence, which is why
  test/clocking-map.dom.test.tsx now mounts the REAL `ClockingLocationForm` rather than a look-alike
  harness and reads the boxes back. Search is still `type="button"` with a `preventDefault`ing Enter
  handler, and the search box still carries NO `name`. Search-as-you-type remains forbidden by the free
  geocoder's usage policy: there is no debounce and there must never be one.

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
- Deferred (Phase 2, not built): **[SUPERSEDED in part — the map picker is BUILT; see "Amended
  2026-09-15 (fa2db8cb rev 2, r279)" above.]** an embedded map picker (coordinates are typed in as plain
  numbers, copied from Google Maps, for now); reverse-geocoding captured coordinates into a street address
  (we store coordinates + the matched named site, which satisfies "address if available" without a
  paid geocoding service); kiosk or native-mobile enforcement (neither exists in this codebase);
  additional anti-spoofing hardening; the `location` ↔ `clocking_location` convergence link (this
  last one is no longer deferred — see "Superseded in part by 1fff489c" above).
