# Mobile app deep review and prioritized improvement plan

Reviewed 27 October 2026, Asia/Kuala_Lumpur. Source baseline: canonical remote `main@67be2710c35035af433bdb2fcdfb2cb30277ceda`, verified with `git ls-remote origin refs/heads/main` and fetched during this review. This is a source review with focused executable probes and current platform research, not a staging audit, physical-device certification or a record of implemented enhancements.

## Recommendation

**RECOMMENDATION:** finish reliability, attendance evidence and recovery before expanding the app. Then deliver complete employee/approver journeys through the existing HR services. The current app is a credible online foundation, but offline clocking and robust anti-spoofing are unfinished approved work. More visual customization will not resolve those gaps.

No P0 incident or proven cross-tenant exploit is established by this review. P1 means required before a dependable field pilot; P2 means the next core product release; P3 means later extension. These are proposed engineering priorities, not existing board statuses.

## Understanding, scope and evidence

**UNDERSTANDING:** review every existing mobile function, identify unfinished prior plans, and supply actionable enhancements covering offline use, location and spoofing, plus the rest of the mobile experience. This delivery supplies the review and plans. It changes no application behavior and deploys nothing.

**FACT — checkout correction:** the instructed `.Codex/worktrees/mainwt` does not exist. Git's `.claude/worktrees/mainwt` exists but is on `codex/main-preserved-wip-20261025`, with unrelated uncommitted changes. Its `CLAUDE.md` says AGENTS.md was retired. A clean review branch, `codex/mobile-deep-review-20261027`, was created from local main and advanced to the verified remote main. The mobile files, mobile API, clock writer, geofence resolver and other named mobile owners are unchanged between the initial local `6b9f9e982` and final `67be2710c` baseline. Existing work was preserved.

**FACT — inspected scope:** all 12 native route/layout files under `mobile/app/`; mobile transport, credentials, session, company setup, capture, drafts, device registration, composition, theme, forms, team and shared controls under `mobile/lib/`; all 12 endpoint route files under `app/api/mobile/v1/`; their shared schemas/wrapper; attendance writers, geofence/device/read owners; leave receipt writer; notification and released-payslip readers; current mobile tests and architecture/history documents. The web counterparts below were inspected to identify reusable owners, not audited as complete web modules.

**OBSERVATION:** six focused probe groups reproduced current behavior using the shipped TypeScript transpiled unchanged, with OS/network/query/hook ports injected. [Results](mobile-review-2026-10-27/probe-results.json), [reproduction script](mobile-review-2026-10-27/probes.cjs). The geofence probe executes the unchanged function extracted from its source with injected query rows; it does not prove database/RLS behavior. The hook probe models hook state rather than rendering React Native. Existing integration suites were read, not rerun. No full gate, application build, GPS hardware, signed-binary, store-console or live payroll check was performed.

**UNKNOWN:** what the currently distributed binary or staging installation actually runs, current board item status, device acceptance results, real site GPS quality, staffing and delivery dates. The remote branch is source evidence only. Do not infer any deployment status from it.

## Existing plans: retain, finish and correct

| Existing owner | Verified direction | Review conclusion |
| --- | --- | --- |
| [ADR-0088](../adr/0088-native-mobile-app.md) | Shared store app, employees/approvers, claims/EA/leave cancellation, push, foreground GPS, accuracy-aware geofence, attempts, attested keys, offline queue and HR adjudication | Most requested enhancements are already approved direction. Current code delivers only part of it. Finish against acceptance criteria instead of creating a competing mobile roadmap. |
| [ADR-0070](../adr/0070-clocking-locations-geofencing.md) | One server geofence, assigned active company sites, auditable outside-site refusal | Preserve this owner. Accuracy handling must change here for both web and native; a client-only fence is insufficient. |
| [ADR-0097](../adr/0097-tenant-mobile-app-builder.md) | One app with tenant-owned, bounded declarative presentation | Keep composition as presentation. It must not introduce permissions, queries or alternate business rules. |
| [ADR-0117](../adr/0117-embedded-hr-authentication.md) | Embedded HR credentials/MFA/recovery and signed workplace setup | Supersedes ADR-0088's old WorkOS-first prerequisite. Do not reactivate cancelled Keycloak work or invent another mobile identity store. |
| [Online delivery history](../HANDOFF-HISTORY.md), `native-monolith-online` | Clock/leave/team shipped as online journeys; offline evidence, integrity, four locales and hardware checks explicitly deferred | Historical delivery explains the scope; it is not proof that remaining items are finished today. |

**FACT — platform corrections:** Apple's documented sleep-inclusive monotonic clocks exist; App Attest assertion generation is local after online key attestation. ADR-0088's unknowns should be revised with these sources. The selected native bridge, offline challenge protocol, reboot detection and device behavior still need verification. Play Integrity at upload cannot retroactively authenticate an offline location. See the [current primary-source appendix](mobile-review-2026-10-27/platform-evidence.md). Other old market, legal, pricing and quota statements in ADR-0088 were not adopted as fresh evidence here.

**ASSUMPTION:** “spoofing” includes fabricated GPS, copied registration tokens, modified clients, replayed photos/commands, false offline time, buddy punching and replayed site QR codes. These have different controls. **RECOMMENDATION:** report the evidence actually checked; never promise “spoof-proof” or “proven present.” A selfie without identity/liveness verification is a photo, not proof that its owner attended.

## Current function inventory

| Function | FACT: current behavior and source | Gap and priority |
| --- | --- | --- |
| Workplace onboarding | Signed setup files/links, installed trust anchors, explicit company review, pinned HTTPS server/organization; [company connection](../../mobile/lib/company-connection.tsx), [verification](../../mobile/lib/company-profile.ts), [probe](../../mobile/lib/connection-probe.ts) | P2: guided VPN/TLS/reachability diagnostics, profile renewal/rotation and recoverable setup errors. Test keys/build identity require production provisioning. |
| Sign-in, MFA, recovery | Embedded organization/password flow, password change, authenticator/recovery codes; recovery opens same server; [sign-in](../../mobile/lib/internal-sign-in.tsx) | P1 device acceptance; P2 accessible recovery guidance, password-manager/OTP behavior, missing-network recovery. No offline password authentication. |
| Session privacy | SecureStore refresh credentials, generation-owned refresh, local unlock, inactive privacy gate, screenshot protection and immediate local logout; [auth](../../mobile/lib/auth.ts), [session](../../mobile/lib/session.tsx) | Preserve. P1 durable submission recovery must coexist with these boundaries. Screen-capture/Keychain claims still need device proof. |
| Home | Current clock/team, leave/pay/inbox widgets; [Home](../../mobile/app/(tabs)/index.tsx), [composition](../../mobile/lib/composed-page.tsx) | P1 truthful loading/error/task states; P2 shared reads, actionable task destinations and permission-aware composition. |
| Clock in/out | One-shot GPS, optional/required camera, review then confirmation, registered-device policy, server-time receipt, uncertain retry; [panel](../../mobile/lib/clock-panel.tsx) | P1 durable attempts/receipt recovery, accuracy-aware geofencing; P1 integrity and offline protocol. History is the current attendance day, not a full attendance module. |
| Location | High-accuracy request, 20-second wait, finite values, age check, Android mock flag; [capture](../../mobile/lib/capture.ts) | P1 approximate/denied/services-off recovery, accuracy and timestamp checks, native evidence. Client checks do not authenticate a direct API caller. |
| Device registration | Employment-scoped UUID bearer token and server revocation; [device service](../../core/attendance-device.ts), [local store](../../mobile/lib/device-registration.ts) | P1 attested key binding; P2 device inventory/replacement/revocation. Local storage retains only one employment registration. |
| Offline use | In-memory drafts; selected files in temporary cache, launch cleanup; [drafts](../../mobile/lib/journey-drafts.tsx) | P1 no durable punch/attempt queue, time anchor or offline context. Existing app explicitly says online-only. |
| Leave balances | Canonical card values, masked values and shared pools; [leave endpoint](../../app/api/mobile/v1/leave/route.ts) | P2 entitlement notices/expanded explanation, balances after failed refresh, cycle clarity. Preserve masks; no mobile balance arithmetic. |
| Leave applications | Eligible full/half/hour forms, attachments, preview, consents, atomic replay receipt; [form](../../mobile/lib/leave-request-form.tsx), [writer](../../core/mobile-leave-command.ts) | P1 uncertain receipt recovery; P2 durable opt-in drafts, real date/time controls, document validation guidance and accurate hourly preview. |
| Leave history/cancellation | Latest 50 requests, total count, summary status; [history route](../../app/api/mobile/v1/leave-requests/route.ts) | P2 detail, date-level/partial decisions, paging/search, withdrawal/cancellation and cancellation status using canonical services. |
| Approvals | Scoped task summaries, first 50, web-directed copy; [tasks](../../app/api/mobile/v1/tasks/route.ts) | P2 no native detail or decision commands; replacement-leave tasks explicitly filtered, notice acknowledgements disabled. Needs versioned capability expansion. |
| Team availability | Server-owned membership, seven-day leave projection; approved and pending distinguished; [team route](../../app/api/mobile/v1/team/route.ts) | P2 date navigation, overlap/coverage context and paging. Does not include a full roster or live employee presence. |
| Payslips | Own active employments, released-only summaries, string money; [endpoint](../../app/api/mobile/v1/payslips/route.ts), [Me](../../mobile/app/(tabs)/me.tsx) | P2 full document, EA forms and historical employment policy; company/run context absent in displayed rows; list unpaged. |
| Inbox | Latest 50 own notifications and unread count; [screen](../../mobile/app/(tabs)/inbox.tsx) | P2 no mark-read, authenticated destinations, older pages, push registration or local shift reminders. |
| Profile/Me | Identity/contact summary, employment picker, pay, logout/company change | P2 profile correction requests and status, device management/help. Server profile workflows exist; mobile does not expose them. |
| Tenant composition/navigation | Schema 1/2 layouts and bounded widgets, internal action destinations, contrast validation; [composition contract](../../lib/mobile-composition.ts) | P2 capability-aware navigation; minimum operational controls, optional feature discovery, large-text/full-width forms and efficient shared reads. Hidden navigation is not authorization. |
| Languages/accessibility | English/Malay native catalogs, accessible two-step alternative to slider, reduced motion | P2 native parity with six server locales, manual language option, consistent statuses/dates and screen-reader/keyboard/large-text device checks. |
| Other employee work | No native routes/APIs for claims, EA, roster, attendance corrections/OT, resignation, documents, notices or performance | Claims/EA are unfinished ADR-0088 scope (P2). Other journeys are P3 proposals after primary jobs, not existing mobile regressions. “Native Performance” ADRs describe integration into the HR platform, not evidence of an Expo implementation. |
| Release/operations | Expo SDK 57, internal APK/simulator profiles, test app identifiers; [app config](../../mobile/app.json), [EAS](../../mobile/eas.json) | P1 signed-device verification; P2 app/API version negotiation, production distribution, diagnostics and rollback. No store-readiness claim. |

## Material findings and prioritized fixes

### M01 · P1 · Preserve uncertain submissions and failed attempts durably

**FACT:** `JourneyDraftProvider` uses React memory and deletes journey/picker caches at cold launch. Clock and leave preserve the exact reference only while this process survives. Clock recovery searches `current.captures`, limited by the current live attendance-day projection. A correction can remove a capture from that projection. Leave's “Check receipt” refreshes lists, but its history response has no submission reference and does not transition the uncertain draft. There is a server `ownClockReceipt` helper, but no corresponding mobile lookup endpoint.

**RISK:** after a server commit with a lost response, app termination loses the command reference and evidence. The server's idempotency is valuable but cannot stop a newly generated reference being treated as a new command. This review did not create a duplicate real punch.

**PLAN:** introduce an encrypted journal before first transmission, with immutable command ID/payload digest and owned attachment references; separate editable drafts from sent/uncertain commands. Add actor/employment-scoped receipt lookup for clock and leave, independent of today's dashboard. On launch, reconcile before allowing replacement intent. Retain an attempt record even when offline punch acceptance is disabled. Show “saved on this phone,” “awaiting server,” “recorded,” “needs review,” or “refused,” with a stable reference. An unauthenticated attempt is a local claim until the server accepts its identity/evidence.

**ACCEPTANCE:** kill/relaunch at every boundary before send, after commit/before response and during attachment upload; recover the same receipt exactly once across midnight, corrected/voided days, temporary auth/network failure and app updates. Unsent attempts survive bounded storage pressure safely or show an explicit storage failure. Another account, installation or employment cannot see or transmit them. Tests cover no-photo and required-photo paths.

### M02 · P1 · Keep data visible during refresh and bound the whole request

**FACT / PROBE:** `mobile/lib/api.ts` replaces same-scope data with null before every reload and keeps null on a 503. It clears its 15-second timeout once response headers arrive, before `res.json()` finishes. Successful JSON is cast to `T`, with no runtime response validation or body cap. Generation checks prevent stale-account results, but effects only suppress state updates rather than cancelling their requests. These outcomes were reproduced by the attached probes.

**PLAN:** use a shared request/cache owner keyed by installation, authenticated actor/generation, employment, locale and endpoint parameters. Keep prior data only within the same authorized scope, label stale data and refresh errors, deduplicate requests, cancel obsolete reads, and cap/validate response bodies within the deadline. Keep unsafe write retries explicit and immutable. Preserve 401-versus-outage semantics; honor Retry-After with bounded backoff for safe reads. Either use the existing custom transport consistently or adopt a maintained query layer through that transport—do not add a competing auth owner.

**ACCEPTANCE:** refresh success/failure retains valid same-scope content, distinguishes first load from empty, and shows accurate refresh state. Account/employment/installation changes hide old data synchronously. Slow body, malformed/oversized JSON, 429 and captive/unreachable private networks terminate safely. Double widgets share one read without one unmount cancelling another consumer. No automatic new clock/leave command after an uncertain result.

### M03 · P1 · Accuracy-aware location and one geofence rule

**FACT / PROBE:** `resolveGeofence` accepts only coordinates for its spatial decision. It compares distance with radius and ignores accuracy, although the clock writer stores accuracy. A coordinate at a 50 m site's centre passes with 5,000 m reported uncertainty. `capturePosition` requests High accuracy but accepts that fix; its age check also accepts a timestamp ten minutes in the future. The server separately rejects new samples outside its absolute two-minute window, so the future-timestamp probe is a client feedback gap, not a demonstrated server bypass.

**PLAN:** add accuracy to the shared core adjudication input and implement the approved containment rule (`distance + reported accuracy <= assigned radius`) plus an explicit company maximum uncertainty. Accuracy is an OS estimate, not a guaranteed physical boundary; no rule makes a false coordinate trustworthy. Return typed reasons for approximate permission, stale/future fix, poor accuracy, services disabled, no assigned site and outside site. Show assigned site, distance, permitted radius, uncertainty and fresh-fix guidance before confirmation. Use bounded retries and Settings recovery when the OS cannot ask again. Retain the attempt if no acceptable fix arrives.

**ACCEPTANCE:** all web/native writers agree at centre/edge/outside, overlapping sites, no sites, archived site, removed company assignment, negative/zero/huge accuracy, approximate permission, future/stale timestamps and policy changes between preview/submit. Test difficult indoor sites on real devices before choosing policy thresholds; do not invent a universal accuracy limit or silently enlarge fences. Preserve current non-geofenced employee behavior unless an explicit policy changes it.

### M04 · P1 · Device and location integrity with honest trust levels

**FACT:** current mock detection is `if (fix.mocked)` on the client. The strict clock command has no integrity evidence fields; `mock_location` exists in response vocabulary but this route does not produce it from server-verified evidence. Registration issues a UUID bearer token, not a device-bound cryptographic key. A modified caller is not required to execute `capturePosition` before posting coordinates. This is an architectural trust gap, not a finding that authentication/RLS can be bypassed.

**PLAN:** retain original mock/simulation/accessory/provider capabilities as true/false/unavailable; capture fix time/accuracy plus native monotonic time and app version. Enroll a non-exportable device key, verify Apple App Attest / Android key and Play Integrity evidence on the server, and bind signed assertions to the canonical command or batch digest, actor, installation, employment and fresh challenge/permit. Validate app/package/environment and current revocation. Separate capability unsupported, check unavailable, invalid evidence and valid evidence. Adopt deterministic trust/review policy; attestation outages never become a successful check. Review raw metadata retention and audience without collecting full device fingerprints.

**ACCEPTANCE:** copied registration token without the key, altered coordinates/photo/time, wrong package/app/environment, replay, forged flags, revoked/replaced key, missing Play services and provider outage have named outcomes. Real devices exercise approximate GPS and known simulation paths. A false/mock-unavailable flag contributes no proof. HR sees why a record was flagged and can resolve it auditably; no AI or hidden score decides employment consequences.

### M05 · P1 · Offline attendance is a claim adjudication protocol

**FACT:** there is no mobile offline context, batch upload, monotonic anchor, signed queue or integrity adjudicator in the current routes. New online clock submissions require a sample within two minutes and stamp the server's arrival time. Retrying these commands hours later cannot implement genuine offline clocking.

**PLAN:** cache only a minimal encrypted, server-signed, expiring clock context: scope, site/radius snapshot, policy revision, device key, expected attendance context and signed server-time anchor. Capture signed/hash-chained claims atomically with UUID, sequence, prior digest, boot binding, monotonic elapsed time, claimed/fix times and photo digest. Use preissued bounded permits for offline assertions; do not generate a fake fresh server challenge offline. At sync, authenticate afresh, verify evidence and permit/counter use, reconcile current permissions/revocation/policy, derive time with uncertainty and persist received/claimed/derived instants. Adjudicate under shared attendance rules before one authoritative punch is created. Keep online server-time behavior unchanged. Label offline origin in timesheets/reports; pending/review claims must not feed payroll as confirmed attendance.

**STATE MODEL:** locally saved → awaiting upload → received → accepted / needs review / refused. “Received” is not “clocked in.” Attempt-only records remain distinct when offline clocking is disabled. Corrected or payroll-locked history requires its existing authorized resolution flow, never silent overwrite. Server policy decides whether a changed historical site/policy makes a claim acceptable, reviewable or refused; the client snapshot is evidence, not authority.

**ACCEPTANCE:** airplane mode for a shift, device sleep, wall-time/timezone change, force quit, update, reboot, missing key, expired anchor/permit, photo loss, clock drift, reordered/partial/duplicate batch, concurrent devices, revoked account and policy change all retain one stable per-claim outcome. Same batch retry cannot lose earlier valid assertions because a later counter was processed first. Hash chains detect interior tampering but cannot prove an absent unsynced tail never existed. Local storage/quota and logout have explicit outcomes. Hardware spikes are a dependency before implementation relies on iOS/Android bridge behavior.

**DECISION REQUIRED FOR BUILD, NOT FOR THIS REVIEW:** retain ADR-0088's offline-off default and proposed 24 h window / 72 h cap unless the owner changes policy. Reconfirm exceptions, retention and rollout population with HR. Do not treat those proposed limits as live tenant settings.

### M06 · P1 · Receipt recovery and privacy must share a coherent logout model

**FACT:** today sign-out invalidates local access immediately and clears registration; changing employment/account discards drafts. ADR-0088 instead suggests uploading queues first and warning of loss. That older sequence conflicts with immediate logout and cannot be copied mechanically into the new offline design.

**PLAN:** keep privacy lock, logout and authenticated submission as separate transitions. Before a voluntary logout/company switch, show the real pending count and explicit sync/discard choices. On forced revocation or expiry, close access immediately, prevent further transmission, and retain only a bounded encrypted quarantine if approved by retention policy. A return by the same authorized identity may reconcile; another login cannot adopt it. Decide who can discard evidence and what tombstone/receipt remains. OS unlock is local access control, not fresh server authorization or offline password validation.

**ACCEPTANCE:** logout during refresh/upload, removal of employment, reinstall/restore, secure storage failure, multiple organizations with matching usernames, lost-device revocation and returning to the original account cannot leak, silently reassign or silently send pending data. Backgrounding never shows private content. No logout waits indefinitely for network access.

### M07 · P2 · Complete leave management

**FACT:** applications share the leave engine and transactional receipt. History is capped at 50 and does not expose native details/cancellation. Hourly preview deliberately returns null figures and empty overrides. The UI uses free-text date/time fields, generic preview errors, and does not render every entitlement notice already returned by the API. Server validation remains authoritative.

**PLAN:** retain the canonical engine; add scoped details, pagination/search, partial-date decision explanations, approval/cancellation progress and withdrawal/cancellation commands. Supply native date/time controls and precise validation, conditional document requirement hints/removal, entitlement/cycle explanations and specific safe rule refusals. Add an accurate hourly preview through the same engine; do not convert days to hours in the app. Persist editable leave drafts only under an approved encrypted-draft policy; submission remains online and explicit after fresh preview/consent. Resolve pending requests through M01 before allowing an amended command.

**ACCEPTANCE:** full/half/hour, overnight schedule, holiday/rest day, shared pools, hidden balances, mandatory documents, maternity facts, emergency split/conversion, policy/balance changes, stale consent, cancelled child dates and concurrent requests agree with web results. Draft/attachment failure preserves work. A different employment cannot reopen the previous draft. Request detail distinguishes approved, rejected, withdrawn, cancellation pending and partially decided states.

### M08 · P2 · Approvals that can finish the job

**FACT:** the native task widget displays kind/subject and tells users to use the web. The endpoint deliberately excludes replacement-leave tasks and notice acknowledgements; v1's kind enum is closed. No native decision route exists.

**PLAN:** add a versioned task/detail contract with current workflow stage, authorized facts/attachments, employee dates, team coverage and permitted actions. Decisions call existing canonical services with actor-bound idempotency, expected state/revision and audit events. Recheck delegation, reporting relationships and policy at submit. Approve/reject online after explicit confirmation; defer bulk decisions until single-item behavior is proven. Bulk review must name every selected item and show each result, not treat all as a single success. Use a supported-version endpoint for new task kinds instead of breaking installed v1 clients.

**ACCEPTANCE:** employee/self-approval denial, manager change, expired delegation, reassignment, already-decided item, another tenant/company, rejection reason, partial dates and timeout after commit. No approving from notification lock screen, no offline queued approval, no model decision, and no sensitive reasons in team coverage summaries.

### M09 · P2 · Full payslip and EA access without accidental disclosure

**FACT:** mobile provides released payslip totals only. The server reader covers active employments and returns every matching summary without pagination; the displayed row omits company/run context even though company is returned. EA and PDF viewers/share commands are absent. Existing web document owners are [own payslip](../../app/me/payslip/document.ts), [payslip PDF](../../app/payroll/individual-payslip/[payslipId]/pdf/route.ts) and [EA selection](../../app/me/ea/selection.tsx).

**PLAN:** bounded period/company/run navigation, released document detail and EA through bearer-authenticated self-only wrappers around existing owners. Use short-lived scoped document retrieval and temporary protected viewing; explicit OS share is separately confirmed/audited and its temporary files cleaned. No durable salary/document cache. Decide access to prior employments and former employees explicitly; current active-only behavior may not satisfy historical-document needs. Keep decimal strings and server calculations; include actual currency when supporting additional jurisdictions.

**ACCEPTANCE:** unreleased/unclosed/future-release, other employee/company/tenant, guessed ID, revoked access, stale URL, PDF failure/cancel, app background, share cancel/completion and temporary-file cleanup. Similar periods across two employments and off-cycle runs remain distinguishable. Document export cannot widen an administrator's Mine scope.

### M10 · P2 · Actionable inbox, private push and shift reminders

**FACT:** the inbox only reads the latest 50, never uses `linkPath`, and offers no mark-read action. The canonical notification service already has recipient-scoped mark-read methods. No mobile push-token lifecycle or notification package is present in the dependency/config inventory. A reserved DB `push` enum is not a delivery implementation.

**PLAN:** read/unread and paged history plus allowlisted typed destinations resolved after unlock and current authorization. Add per-installation push enrollment/rotation/revocation through the existing notification outbox/delivery owner. Payloads contain generic text/key and ID, never salary, medical reason or private employee content. Permission is contextual; denied push never blocks the in-app inbox. Local shift/forgot-out reminders use schedule data, timezone and fresh cancellation rules, with no background location. Notifications and tasks are related projections, not two owners of approval state.

**ACCEPTANCE:** token changes, offline delivery, duplicate/out-of-order push, logout/offboard, two organizations, denied permission, removed task authorization, malicious/stale link, unread count across devices and older history. Reminder changes after roster/timezone changes cannot send obsolete shift instructions. Push open performs no business mutation by itself.

### M11 · P2 · Claims, receipts and reimbursement status

**FACT:** ADR-0088 includes mobile claims but there is no native claims route/command/widget. The web's [claims actions](../../app/claims/actions.ts) and [attachment route](../../app/claims/attachment/[id]/route.ts) expose existing ownership to reuse, not permission to call web server actions from a store client.

**PLAN:** scoped claim types/limits, receipt camera/document capture, line-item validation, mileage inputs where configured, online submission, detail, return/rejection correction and reimbursement status. Encrypt editable drafts if enabled; online final submission rechecks limits/duplicates and returns a receipt. Keep monetary validation/calculation in the kernel. Optional OCR is later, human-reviewed extraction, never authoritative spending evidence or automated approval.

**ACCEPTANCE:** duplicate receipts, edit-after-return, MIME/content/size validation, interrupted upload, double submit, changed limits, multiple currencies, mileage rules, offboarded caller and other employees' documents. An unsubmitted draft is never a reimbursement payable.

### M12 · P2/P3 · Attendance history, schedules, overtime and corrections

**FACT:** Clock exposes today's live punches/shift, not month history, application history, roster, correction or overtime submission. The web has [own records](../../app/attendance/my-records/page.tsx) and [application history](../../app/attendance/application-history/page.tsx) with canonical guarded actions.

**PLAN:** P2 paged own history with raw evidence, corrected outcome and unresolved exception clearly separated, plus upcoming personal roster/holiday/rest-day context. P3 add governed missed-punch/correction, overtime and replacement-leave journeys, with current policy, relevant raw inputs, review and application receipts. Distinguish requested OT, approved OT, recorded work and payroll settlement. Never let the app edit a raw punch or calculate payable OT locally.

**ACCEPTANCE:** overnight/rotating shifts, multiple daily punches, corrected/voided days, processed-payroll locks, old policy snapshots, supervisor reassignment and replacement leave. All summaries match existing authoritative reports and keep the evidence history.

### M13 · P2/P3 · Team, profile and broader employee work

**PLAN:** P2 improve team availability with date/week navigation and coverage in approvals while retaining only authorized names/dates/sessions; disclose truncation and scope. P2 expose profile correction requests and status, help and device controls. P3 add notices/acknowledgements, own documents, onboarding checklist, resignation and employee performance/development tasks where the existing workflow owner supplies the action. Keep private manager notes, payroll configuration, calibration and admin processing on their existing surfaces. Do not equate `native` in the platform's OneHR ADR titles with a delivered phone feature.

**ACCEPTANCE:** explicit module/capability checks, current My Team population, hidden/private fields, protected documents, required human acknowledgements and workflow-stage changes. No employee directory assembled from approval/notification data; no separate mobile profile/person truth.

### M14 · P2 · Home, navigation, language and accessibility

**FACT:** legacy Home decides “nothing needs you” from notification data even when that request is loading or failed. Composition allows repeated data widgets across pages, per-widget requests, seven navigation items and half-width clock/forms. Current leave/team screens refresh on focus; inbox/pay/profile widgets generally need explicit refresh. Native locales are English/Malay, separate from six server catalogs; several statuses/copy strings remain raw/hardcoded.

**PLAN:** canonical actionable-work counts, truthful loading/empty/unavailable states and next actions; capabilities determine available destinations, with a discoverable More surface for additional work. Preserve minimum clock/recovery/help/Me access under tenant themes. Share reads/invalidation from M02; use virtualized/paged lists for long histories. Constrain critical forms/clock to usable widths at large text sizes; retain tap confirmation and reduced motion. Unify supported message ownership, translate the remaining four locales and statuses, and offer explicit locale selection. Keep company locale/currency/timezone separate from device display settings.

**ACCEPTANCE:** published designs cannot imply a permission grant or hide pending evidence. Seven tabs, narrow phones, landscape/tablet, long translated labels, dark/light themes, maximum text size, keyboard, VoiceOver/TalkBack, screen readers and reduced motion retain every required action. Failed task fetch never displays “all clear.” Date/punch displays identify authoritative timezone; data is revalidated at relevant focus/events without request storms.

### M15 · P1/P2 · Operational acceptance and supported-version delivery

**PLAN:** P1 run signed iOS/Android device acceptance on the intended embedded-auth installation with synthetic employees; include the exact permission/biometric/camera/document/background/secure-storage matrix in `mobile/README.md`. Add privacy-safe structured outcome metrics and support IDs: API latency, successful/failed clock capture, accuracy distribution, pending queue age, sync outcome, receipt recovery, auth refresh, crash-free sessions and upload failures. Do not send raw coordinates/photos/reasons/pay to general telemetry.

P2 add app/build/platform/API capability headers and backward-compatible capability/version negotiation. Keep old app support explicit and preserve pending uploads through schema/app upgrades; new closed enums require versioning. Establish production app identities/trust anchors, signing ownership, store privacy disclosures, release notes, rollback and migration of queued data before customer distribution. Pin/review build images and verify dependency/export/native permissions at the final candidate. Version 1 response changes remain additive/optional; don't casually add a breaking required field.

**ACCEPTANCE:** old supported binaries can read/submit their supported commands; unsupported updates cannot strand queued evidence. Real signed binaries—not only Hermes exports—pass TLS, private-network/VPN, reinstall/restore and revocation checks. Store readiness includes actual accepted distribution evidence. Neither current test branding nor historical gate counts establishes a production release.

## Offline behavior for every function

**RECOMMENDATION:** “offline mode” is an explicit policy per job, not automatic replay of every mutation. Preserve ADR-0088's memory-only private reads by default; persistent balance/team/pay caches would be a separate privacy/architecture decision.

| Job | Offline behavior proposed | Reconnect behavior |
| --- | --- | --- |
| Attendance | Encrypted minimal context and claim/attempt capture; truthful pending/review state | Authenticate, upload immutable evidence, server adjudication, stable receipt; never replace time with upload time |
| Leave/claims | Optional encrypted editable draft and owned attachments, no accepted-request claim | Fresh eligibility/preview/consent; explicit online submit and receipt recovery |
| Approvals/cancellations/profile changes | Retain an explicitly labelled private draft only if enabled; no business decision queued automatically | Re-fetch permissions/state; review and submit online |
| Payslips/EA/private documents | Existing memory only; no automatic durable download cache | Fetch authorized released document anew; explicit protected share |
| Balances/team/inbox | Same-session stale content may remain with last-updated indicator; cold offline start says unavailable | Revalidate and invalidate under current identity/scope |
| Schedule/reminders | Minimal bounded approved clock/reminder context only | Reconcile changed roster/policy/timezone and cancel obsolete reminders |
| Sign-in/company setup | Offline verification of signed setup authenticity; OS unlock of locally permitted evidence | No offline account creation/password check; server reauthorization before business effects |
| Help | Bundled non-private recovery guidance | Diagnostics carry safe codes, never credentials or HR payloads |

## Graph impact and implementation boundaries

**GRAPH IMPACT:** retain USER → PERSON → active EMPLOYMENT, tenant/installation, grant and scope owners. Add a device-key identity beside existing device registration; offline permit/time anchor; immutable capture attempt/claim; adjudication result; authoritative punch/receipt; and human exception resolution. Claim → decision → punch is distinct from attempted capture → receipt. Notifications consume transitions; payroll consumes accepted/resolved attendance only. Device trust, site corroboration, time confidence and attendance acceptance are different facts.

Every durable entity needs tenant/actor/employment ownership, version, expiry/retention and RLS/grants. Attachments belong to their attempt/request with digest and cleanup state. Device revocation, employment changes and policy changes invalidate capabilities without rewriting original evidence. Registration token compatibility must be negotiated; do not silently change v1 clock semantics. No client-selectable tenant, trust tier, approval actor, payable amount or “skip policy” flag.

**CHALLENGE:** blanket hardware refusal and a GPS-plus-selfie checklist would overstate security and block legitimate workers. Use bounded evidence, deterministic policy and an auditable HR exception path. Accuracy containment can increase indoor refusals; retain the attempt and provide recovery. Rotating site QR adds corroboration but screenshots/relay still work; a future QR feature must be challenge-bound and treated as additional evidence, not certainty.

**QUESTIONS / DECISIONS FOR IMPLEMENTATION:** offline acceptance window and retention; supported OS/device/distribution population and no-Play fallback; treatment of policy/site change while offline; unsupported/check-unavailable device tiers; historical/former-employee documents; profile/claim draft retention; voluntary discard versus quarantine of unsent evidence; first pilot sites. These do not block the review. Use existing approved defaults where applicable, but obtain policy ownership before encoding new consequences.

## Delivery order and release criteria

| Sequence | Deliverable | Dependencies and exit evidence |
| --- | --- | --- |
| A | M01/M02/M06: durable receipt/attempt recovery and resilient transport | Threat/state model and retention decision; kill/relaunch and cross-scope refusal tests; no duplicate facts after lost response |
| B | M03: location quality and shared geofence | Existing writer inventory; before/after web+native boundary fixtures and real indoor-site samples |
| C | M04 plus M05 native spikes | Reviewed signed-command/permit protocol; App Attest airplane-mode, continuous-clock/reboot and Play distribution measurements; costs/quotas known |
| D | M05: offline claims and HR resolution | A–C; encrypted context/queue, server adjudication, payroll separation, partial-batch/replay/revocation proofs and signed-device field trial |
| E | M07–M10 and M14: complete leave, approvals, pay/EA and notifications | A/M02; versioned contracts, canonical service reuse, per-feature negative cases and accessible real-device walkthroughs |
| F | M11–M13: claims, personal records/schedules and wider employee jobs | Stable primary journeys; explicit scope per module, money/permission/history tests |
| Each release | M15 verification/observability | Exact-candidate targeted/integration checks, required repository gate, mobile typecheck/build separately, staging acceptance; no production deployment inferred |

This order is dependency-driven, not a calendar promise. Estimating weeks before the native spikes and policy decisions would be speculation. New migrations must be allocated centrally and verified on the intended environment before any release. No board items were created or changed by this review.

## Verification coverage and completion limits

- **Confirmed now:** current canonical main identified/fetched; complete native screen/API inventory reviewed; prior plans reconciled; six probe groups reproduced; platform feasibility checked against primary docs; prioritized plans cover all current functions and related missing employee jobs.
- **Preserved strengths:** server response allowlists, own-employment selection, RLS-backed services, strict command inputs, atomic clock/leave receipts, serialized refresh, immediate local logout, privacy gate and foreground-only location. Existing test files cover valuable refusal/replay boundaries; this report does not claim they were run now.
- **Required during implementation:** each M01–M15 acceptance set, both OSes and supported oldest app, organization/employment switches, actual device permission/secure storage behavior, concurrency/replay and cross-tenant/employee refusals. Run the repository's impact gate for changed server/security/data owners and separate native checks for `mobile/`.
- **Not delivered here:** implementation, staged deployment, new attendance/payroll records, business-policy approvals, live board audit, full regression/build, device/store acceptance or guarantees of detecting all spoofing. The review/planning outcome is complete; the engineering work described above remains to be built.

## Reproduction and references

Run from the reviewed repository root, with TypeScript available. The optional argument selects an existing compiler installation, so no app dependency install is needed for these lightweight probes:

```sh
bash ~/.aihr-gate-state/testlock.sh mobile-review -- node docs/research/mobile-review-2026-10-27/probes.cjs /absolute/path/to/node_modules/typescript
```

The script reports six groups and writes its JSON to `/tmp/aihr-mobile-review-probes-20261027.json`. It uses injected native/network/query/hook ports; it cannot substantiate live-device or database authorization claims. The first review run exposed a cross-context `instanceof` assertion in the probe harness; comparison was corrected to the named error and the complete probe rerun exited 0. Application code was not modified to make probes pass.

Primary platform sources and their specific claims are retained in [platform evidence](mobile-review-2026-10-27/platform-evidence.md). High-value checks: [Expo SDK 57 location](https://docs.expo.dev/versions/v57.0.0/sdk/location/), [Android Location](https://developer.android.com/reference/android/location/Location), [Play Integrity request binding](https://developer.android.com/google/play/integrity/standard), [Apple App Attest validation](https://developer.apple.com/documentation/devicecheck/validating-apps-that-connect-to-your-server), [Apple local-assertion clarification](https://developer.apple.com/forums/thread/838933), [Apple continuous time](https://developer.apple.com/documentation/kernel/1646199-mach_continuous_time), [Android elapsed realtime](https://developer.android.com/reference/android/os/SystemClock).


## Platform requirement clarified by the owner — 27 October 2026

The owner explicitly selected **Huawei HarmonyOS5+/NEXT** when asked which Huawei family to target.
Keep iPhone/iOS, Android and native HarmonyOS as distinct platform acceptance tracks. Recent Android
implementation is not a reduction of the shared employee/approver scope or an iOS completion claim.
The iOS app and Swift/App Attest/Keychain/server owners already exist; signed iPhone acceptance and
remaining end-to-end integration still need completion. No native HarmonyOS client/build target is
present in the reviewed tree. HarmonyOS5+/NEXT is now an explicit target, not presumed Android support.

Huawei's official native SDK lists Location, Notification/Push, Device Security/Certificate and
Universal Keystore kits with ArkTS/ArkUI/DevEco tooling. Assess native application/toolchain support,
identity and signed workplace routing, location freshness/accuracy/mock signals, secure key/proof
storage, offline time/reboot behavior and device/app integrity before selecting adapters. Preserve
the same server authorization, command identity, receipt recovery and claim/adjudication boundaries;
validate each OS provider independently. Do not treat an Android HMS Safety Detect sample as a native
HarmonyOS implementation or as proof of hardware-key custody.

Huawei states that APK installation on HarmonyOS5+ can depend on the compatibility tool's actual
support. Such installation does not establish this app's location/integrity/storage behavior. The
current Android location dependency uses Google FusedLocationProviderClient; no Huawei-native
integration or device acceptance was found. Existing Google-root verification must not be relabeled
as Huawei verification. All three platform tracks require their own signed-device evidence and
honest unsupported/unavailable/human-review behavior before a real-data attendance rollout.

Sources checked: [Huawei native development/SDK](https://developer.huawei.com/consumer/en/harmonyos/develop/),
[Huawei HarmonyOS5+ application installation guidance](https://consumer.huawei.com/cn/support/content/zh-cn16061787/),
[Huawei Android Safety Detect codelab](https://developer.huawei.com/consumer/en/codelab/HMSCoreSafetyDetect/).

## Owner decisions, 28 October 2026 (Phase E)

Status of every item below: **DECIDED, not built yet.** Each is an owner decision that binds the Phase E
work; none is evidence that the behaviour exists. The shared v2 foundation (cursor pages, v2 refusal and
command shapes, the actor-owned command receipt, the binary route wrapper, the paged list and the
protected-document sweep) is the only Phase E code at the time of writing.

- **D1 — DECIDED, not built yet.** Payslips and EA forms cover every employment of the signed-in login,
  as the web does. No access once the login is blocked.
- **D2 — DECIDED, not built yet.** Native decisions for leave (whole request and per date), leave
  cancellation, attendance correction and overtime. Every other approval kind stays read-only in the app
  with a link to the web. Claims follow after M11.
- **D3 — DECIDED, not built yet.** Bulk approval is deferred.
- **D4 — DECIDED, not built yet.** Self-approval is refused at mobile admission, even for super_admin.
- **D5 — DECIDED, not built yet.** Kernel changes are approved, each pinned by tests: an optional
  transaction on the leave approve and cancel services; an expected step for leave decisions; hourly
  days in previewLeaveDeduction; keyset paging for notifications.
- **D6 — DECIDED, not built yet.** Push uses expo-notifications with DIRECT APNs/FCM delivery (keys on
  the server). Tokens are bound to (tenant, user, installation), amending ADR-0088 §3. Payloads are
  generic only.
- **D7 — DECIDED, not built yet.** A native payslip view, plus expo-sharing for an explicitly confirmed
  and audited share of the PDF/EA. No in-app PDF viewer.
- **D8 — DECIDED, not built yet.** Shift reminders are ON by default: 15 minutes before shift start; a
  forgot-to-clock-out reminder 30 minutes after shift end; a 7-day scheduling horizon; refreshed when the
  roster changes; the employee can turn them off.
- **D9 — DECIDED, not built yet.** @react-native-community/datetimepicker for date and time entry.
- **D10 — DECIDED, not built yet.** Drafts are held in memory only.

### M07 · complete leave management — IMPLEMENTED, UNVERIFIED (28 October 2026)

Built on the branch; no test, type check, build or device run has been executed by the builder (hosted CI
verifies). Nothing below is evidence that it works until that run reports.

- **Endpoints (v2, contracts in `lib/mobile-api/v2/leave.ts`).** `GET /api/mobile/v2/leave/requests`
  (own selected employment, start date descending, keyset cursor, stored-status filter, overlap window,
  per-status counts); `GET …/requests/{id}` (the row must belong to the selected OWN employment, else
  `not_found`; per-date outcome, approval levels with names, rejection, cancellation, pending give-back,
  actions from the web's own predicates); `POST …/{id}/withdraw` (cancelOwnLeave) and
  `POST …/{id}/cancellation` (requestLeaveCancellation, tenant-local today), both inside the mobile
  command receipt; refusals carry the service's LeaveCancellationRefusal codes. Composition in
  `core/mobile-leave-history.ts`.
- **v1, additive.** Leave cards carry an optional server-translated `entitlementNoticeText`; the v1
  preview passes an hourly From/To window through to the shared rule (an incomplete or overnight window
  keeps `days: null`).
- **D5 kernel changes.** (a) optional trailing `existingTx` on cancelOwnLeave, requestLeaveCancellation,
  decideLeave, decideLeaveDates and decideLeaveCancellation; (b) optional `expectedStepIndex` on the three
  decisions, refusing `LeaveStaleStepError` (`stale_step`); (c) previewLeaveDeduction accepts
  fromTime/toTime/hours and uses `hourlyLeaveWindow` + `hourlyLeaveDays`, factored out of requestLeave.
  Keyset (`before`) and id (`ids`) options on listLeaveRequestsPage. Web callers pass none of them.
- **D9.** `@react-native-community/datetimepicker` 9.1.0 — the version Expo SDK 57.0.26's
  `bundledNativeModules.json` names; lockfile entry from the registry's published metadata.
- **D10.** Withdraw/cancel are online-only, confirmed, and held in memory; a lost answer is retried with the
  same requestId and the server's receipt replays it. The persisted submission journal is NOT extended to
  these commands (it is closed to clock/leave-submit kinds); see the round's report.
- **Native.** `mobile/app/leave/history.tsx`, `mobile/app/leave/[id].tsx`, `mobile/lib/leave-history.tsx`;
  the leave tab links to every request and opens each row's detail; the form uses the platform pickers and
  shows the entitlement notice and the hourly preview figure.
- **Tests written, not yet run.** `test/mobile-v2-leave.test.ts`, `test/leave-mobile-kernel-seams.test.ts`,
  `test/mobile-leave-history.dom.test.tsx`; `test/mobile-native-journey-screens.dom.test.tsx` updated for the
  pickers.

### M08 · approvals that can finish the job — IMPLEMENTED, UNVERIFIED (28 October 2026)

Built on the branch; no test, type check, build or device run has been executed by the builder (hosted CI
verifies). Nothing below is evidence that it works until that run reports.

- **Endpoints (v2, contracts in `lib/mobile-api/v2/tasks.ts`, composition in `core/mobile-approvals.ts`).**
  `GET /api/mobile/v2/tasks` pages `listPendingTasks` in the inbox's own order (createdAt desc, kind, id),
  replacement leave and notice acknowledgements included; `nativeDecision` is true for leave, leave cancellation
  and attendance, every other kind carries its web path (D2). `GET …/tasks/{kind}/{id}` admits through
  `isCurrentAssignedApproval`, refuses the caller's own request even for super_admin (`self_approval`, D4), and
  answers `not_assigned` for anything else (other tenant, other company, guessed id, manager change, expired
  delegation, reassigned stage); a row the caller can already read under RLS that is no longer pending is
  `already_decided`. Facts come from the inbox's readers (listLeaveRequests, leaveRequestDateBreakdown,
  listPendingLeaveCancellations, listAttendanceCorrections, dayTypesForPairs); team cover from
  resolveMyTeamScope + myTeamLeaveProjection (names, dates, approved/pending; never the subject, no type, no
  reason). `POST …/decision` runs decideLeave / decideLeaveDates / decideLeaveCancellation /
  decideAttendanceCorrection inside the mobile command receipt with the expected step/stage; the decider's
  employment is the caller's own. `GET …/tasks/leave/{id}/document` sends getLeaveAttachment's PDF, JPEG or PNG
  (signatures checked; the binary allowlist is widened for this route only, `lib/mobile-api/binary-types.ts`).
- **Overtime is an attendance application.** A self-overtime / Plan OT request is an attendance_correction with
  requested minutes and is decided by decideAttendanceCorrection; the detail labels it `overtime`.
- **No bulk (D3). Online only.** A decision is confirmed in a dialog that repeats it; a lost answer is retried with
  the same requestId and the receipt replays the first answer; a refusal reloads the task (`stale_step` included).
- **Native.** `mobile/app/approvals/index.tsx`, `mobile/app/approvals/[kind]/[id].tsx`,
  `mobile/lib/approval-decision.tsx`; the composed Tasks widget and the legacy Home tasks card link to approvals.
  The tenant composition destinations enum was not changed (the links are fixed, not tenant-configured).
- **Not done.** No native document viewer (no viewer module is installed; the detail says to open the request
  on the web). List items carry the subject's name only (`code: null`): the inbox projection drops the
  employment, and widening `PendingTaskItem` breaks exact-equality pins on it. A leave-cancellation rejection asks
  no reason because decideLeaveCancellation records none (DECISION REQUIRED if the owner wants one stored).
- **Tests written, not yet run.** `test/mobile-v2-approvals.test.ts`, `test/mobile-approvals.dom.test.tsx`.

### M09 · full payslip and EA access without accidental disclosure — IMPLEMENTED, UNVERIFIED (28 October 2026)

Built on the branch; no test, type check, build or device run has been executed by the builder (hosted CI
verifies). Nothing below is evidence that it works until that run reports.

- **Endpoints (v2, contracts in `lib/mobile-api/v2/pay.ts`, composition in `core/mobile-pay.ts` and
  `lib/mobile-api/pay-routes.ts`), all behind the Payroll module gate.** `GET /api/mobile/v2/payslips` pages
  `myReleasedPayslipRuns` (every employment of the login, current and past — D1) in a grouped order (year,
  employer, period, run) with NO amount; `GET …/payslips/{id}` is `myPayslipDocument` drawn through
  `payslipPresentationRows` with the web statement's rate formatter, amounts as two-place decimal strings plus
  the company's currency; `GET …/payslips/{id}/pdf` and `GET …/ea/pdf?employmentId&year&company&lang` go through
  `mobileBinaryRoute`; `GET …/ea` is `myEaSources`. Not own, unreleased, foreign or guessed: one `not_found`.
- **One document, two transports.** The web routes' render and file name moved, verbatim, into
  `app/me/payslip/pdf-file.ts` (`myPayslipPdfFile`) and `app/me/ea/document.ts` (`myEaPdfFile`); the web routes
  keep their parsing, session, 404s and headers, and the mobile routes call the same functions. Source pins that
  named the moved calls in the route files now name the new modules (individual-payslip, ea-pdf-i18n-keys,
  fda53352). The web PDF routes still append no audit event (follow-up below).
- **Share (D7).** `POST /api/mobile/v2/documents/share-events {requestId, shareId, document, stage}` records
  `document.share.confirmed | completed | cancelled` inside the mobile command receipt, owned by the actor,
  subject = the document's own employment, payload = identifiers only. `confirmed` admits through the owners;
  a closing stage needs this actor's `confirmed` of the same document under the same shareId and closes once.
  The app opens the OS share sheet (expo-sharing ~57.0.22, the SDK 57.0.26 bundled version) only after the
  server acknowledged `confirmed`; offline there is no share.
- **Temporary files.** The PDF lives only as a random-named file in the protected folder; it is deleted when the
  share settles, whichever way. A file in an open share is exempt from the BACKGROUND sweep (Android backgrounds
  the app for the share sheet) until its promise settles; launch, logout and employment-switch sweeps still take
  it (`mobile/lib/protected-document.ts` `shareProtectedDocument`, `sweepProtectedDocuments({keepSharing})`).
- **Native.** `mobile/app/pay/index.tsx`, `mobile/app/pay/[id].tsx`, `mobile/app/pay/ea.tsx`,
  `mobile/lib/pay-documents.tsx`; Me links to the new screen and no longer reads v1 totals (the v1 endpoint stays
  for installed clients). Held in memory only; offline shows "Payslips need a connection", never a stale copy.
- **Not done / follow-ups.** The web PDF routes do not audit downloads (unchanged; DECISION REQUIRED whether they
  should). The payslip document's labels resolve through next-intl's request locale, which is English for a bearer
  request (`lib/payslip-pdf-strings.ts` takes no locale); the EA edition is explicit. `completed` means the OS share
  sheet returned without error — neither platform reliably reports whether a target was chosen (UNKNOWN). A
  closing event that cannot be delivered after one same-reference retry is lost; the audit then shows a
  `confirmed` with no close.
- **Tests written, not yet run.** `test/mobile-v2-documents.test.ts`, `test/mobile-pay-documents.dom.test.tsx`.

### M10 (inbox part) and M14 (Home essentials) — IMPLEMENTED, UNVERIFIED (28 October 2026)

Built on the branch; no test, type check, build or device run has been executed by the builder (hosted CI
verifies). Nothing below is evidence that it works until that run reports. **Push (D6) and shift reminders (D8)
are still pending**: no push enrollment, token, payload or reminder code exists.

- **D5 kernel change.** `core/notifications.ts`: `listNotifications` now orders `created_at desc, id desc` (a
  deterministic tie order; same rows and filters for every web caller) and takes an optional `after` keyset
  (`NotificationCursor`, the instant as microsecond UTC text plus id). Sibling `listNotificationsPage` returns the
  same order with each row's exact cursor text (`cursorAt`) and an optional `ids` narrowing. No web caller changed.
- **Endpoints (v2, contracts in `lib/mobile-api/v2/notifications.ts`, composition in `core/mobile-notifications.ts`),
  behind the Notifications module gate.** `GET /api/mobile/v2/notifications?cursor&limit&unread=true` (own rows,
  recipient-only RLS, keyset-paged, `unreadCount`); `POST …/notifications/read {ids ≤ 50} | {all: true}`
  (markNotificationRead / markAllNotificationsRead; answers the fresh count and each still-owned id with its
  destination re-derived; idempotent, no receipt); `GET /api/mobile/v2/home/summary` (the v2 task list's count via
  `pendingTaskCountV2` and the unread count, each settled on its own; `unavailable` is never zero).
- **No link leaves the server.** `link_path` is never sent. `lib/mobile-api/notification-destination.ts` maps the
  registry kind to one of four list screens — `leaveHistory` (leave approved/rejected/admin-cancelled, cancellation
  approved/rejected), `leave` (toil accrued/converted/lapsed), `approvals` (cancellation requested, leave escalation,
  overtime requested, review started/manager-evaluated/reminder), `pay` (payslip ready, only while Payroll is on).
  Every other kind is `null`. Destinations carry no record id: a notification holds no business-record reference the
  recipient may read, and each list screen re-reads under the caller's session.
- **Native.** `mobile/app/(tabs)/inbox.tsx` → `mobile/lib/inbox.tsx` `InboxScreen` on the shared paged list: "{n}
  unread · Mark all read", unread dot rows (title, muted body, time, "Open … ›" for a known destination). A tap marks
  the row read, then opens the destination the server re-derived; a gone row or one whose destination no longer
  applies says "This item is no longer available". Legacy Home's "Needs you" is `HomeNeeds`: loading shows loading, a
  part that could not be read shows "Couldn't check — retry", "Nothing needs you" only when both counts were read,
  are zero and are not refreshing; the task count links to approvals (the button shows when tasks are waiting or could
  not be checked, as the composed Tasks widget shows it when tasks are waiting). Routes are reachable only unlocked
  (the root Gate renders no route while locked). en and ms copy.
- **Not done / follow-ups.** Push and reminders (above). No record-level deep link (a notification has no readable
  record reference; DECISION REQUIRED if the owner wants one, which needs a reference column written at dispatch).
  The composed (schema 2) Tasks widget still reads v1 `tasks`, which omits replacement leave and notice
  acknowledgements, so it can say "nothing needs you" while those wait (its DOM test pins the v1 read; follow-up).
  The composed Messages widget still reads v1. Stored titles/bodies that are message keys (letters, Home greetings)
  are shown as stored, as v1 does.
- **Tests written, not yet run.** `test/mobile-v2-notifications.test.ts`, `test/mobile-inbox.dom.test.tsx`.
