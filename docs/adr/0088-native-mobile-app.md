# ADR-0088 — Native mobile app: one identity resolver, a narrow versioned API, an evidence ledger for clocking

Status: **Accepted** (2026-09-30). Proposed, revised the same day after the market benchmark, and approved
by the owner ("Yes go ahead") on the revised text. Phase 1 started in r370.

Implements the "Expo app phase" pencilled in [ADR-0011](0011-attendance-time-tracking.md) Phase C and the
`push` channel reserved in [ADR-0034](0034-notification-engine.md). Extends
[ADR-0070](0070-clocking-locations-geofencing.md): its geofence rule stays the ONE rule for every front
door, and this ADR adds integrity evidence beside it. The browser path does not change.

Evidence base: `docs/research/hr-mobile-app-benchmark.md`. It covers 30+ vendors across global enterprise, global SMB, Malaysia/SEA and time-and-attendance
specialists, plus platform, store and PDPA sources, all read on 2026-09-30.

## Context

The owner's requirements (2026-09-30):

1. A **store listing** on the App Store and Google Play is required. A home-screen web app is not enough.
2. The audience is **employees and approvers**. Payroll and admin work stays on desktop.
3. **Anti-spoofing** on clock-in is required.
4. **Offline clocking**, for sites without signal, is required.
5. The **WorkOS cutover** (readiness 1.3) goes first.

Requirements 1, 3 and 4 each need a native app on their own. So the question is how to go native without
creating a second source of truth for any business rule.

### Facts measured on main@b62e078e and on production

- **FACT: there is no API.** Main has one route handler, `app/api/payroll/reprocess-job`. Every business
  operation is a server action (94 `'use server'` files) that calls `getSession()` and then a `core/`
  service. Server-action IDs are generated per build, so they are no contract for a client that ships
  through a store.
- **FACT: the actions are thin.** `app/attendance/clock/actions.ts` resolves the employment from the
  session and calls `core/attendance.ts` `checkIn(ctx, …)`. Core owns every rule, so a mobile API can call
  the same services with the same `SessionContext`.
- **FACT: production authenticates nobody.** `.env.production` has no `WORKOS_*` key and sets
  `ALLOW_DEMO_SESSION=true` (readiness 1.3, all six steps open). The whole site sits behind one shared
  HTTP Basic password (`middleware.ts`).
- **FACT: production has no HTTPS and no domain.** nginx listens on :80 with `server_name _`, and the :443
  lines are commented out.
- **FACT: WorkOS supports native sign-in.** `POST /user_management/authenticate` accepts an authorization
  code with a `code_verifier` and no client secret (PKCE). It returns a JWT access token (JWKS at
  `https://api.workos.com/sso/jwks/<clientId>`, carrying `sub` and `sid`) and a refresh token that may
  rotate. WorkOS publishes an official Expo AuthKit example that uses PKCE with SecureStore.
- **FACT: the production session path maps a WorkOS subject to a principal on every request**
  (`app.principal_by_subject`), and an offboarded user resolves to nothing. So offboarding does not depend
  on WorkOS revoking a token.
- **FACT: the web geofence refuses, not flags.** When a punch falls outside every assigned site,
  `core/attendance.ts` throws `OutsideGeofenceError`. With zero sites it fails closed. The attempt is kept
  as an `attendance.geofence.blocked` domain event, not as an attendance row (ADR-0070 §3).
- **FACT: device registration exists.** `core/attendance-device.ts` mints a server-side bearer token per
  device. When `require_registered_device` is on, `checkIn`/`checkOut` refuse a punch without a valid
  token. Nothing proves that token came from a genuine device.
- **FACT: core stamps punches with the server clock** (`nowParts()`: "The browser's clock is
  display-only"). Offline clocking therefore changes the model, not just where a call happens.

### What the market benchmark showed

- **Reliability decides app ratings, not features.** Every vendor has much the same scope. Complaints are
  dominated by slow or wrong GPS fixes, false face-check rejections, forced logouts and "offline" errors
  at shift start. **Malaysian apps sit about a star lower** than global ones. The largest, Info-Tech with
  1M+ installs, rates 3.79 on Google Play; 131 of its newest 200 reviews were 1–2 stars and 30 of those
  were face or camera failures. Workers say they are **penalised for lateness** when clock-in fails.
- **Anti-spoofing across the market stops at a geofence plus a selfie.** No vendor documents App Attest,
  Play Integrity, or a trustworthy clock for offline punches. Mock-location blocking is documented by
  Connecteam and TimeTec only, and reviewers report it being defeated elsewhere.
- **FACT: mock-location flags are one-sided.** A flag reading `true` is strong evidence of spoofing. A flag
  reading `false` proves nothing. An Apple engineer said on the developer forums (Aug 2025) that
  `isSimulatedBySoftware` cannot catch third-party spoofers; desktop USB spoofers need no jailbreak and
  still pass App Attest. Root modules hide Android's `isMock()`.
- **FACT: attestation only works online.** Play Integrity needs a round trip to Google, with a default
  quota of 10,000 requests a day shared across all installs. App Attest needs a one-time challenge from
  our server. Neither can vouch for a punch made while the phone is offline.
- **FACT: iOS `systemUptime` stops counting while the phone sleeps.** Android `elapsedRealtimeNanos`
  keeps counting through sleep. On both platforms a reboot resets the counter.
- **FACT: PDPA (Act A1727).** Biometric data (data "resulting from technical processing" of physical
  characteristics) is now **sensitive personal data**, and processing it needs explicit consent under
  s.40. Other duties that now apply: breach notification within 72 hours to the Commissioner and 7 days to
  affected people (s.12B), a DPO (s.12A), processor security duties, and data portability (s.43A).
- **FACT: store policy.** Apple 4.5.4 says pushes should not carry sensitive personal data. Apple 2.1
  requires a demo account for review. Apple's in-app account deletion rule applies only "if your app
  supports account creation". Google Play's background-location declaration is avoided when location is
  taken only when the user taps. Play's Data safety form is required even for closed test tracks.

## Decision

### 1. Identity: one resolver, two carriers

- **Sign-in.** The web keeps the AuthKit cookie. The app signs in through WorkOS hosted AuthKit in the
  system browser (ASWebAuthenticationSession on iOS, Custom Tabs on Android) with PKCE, following RFC 8252.
- **Token storage.** The app keeps the refresh token in SecureStore with a `THIS_DEVICE_ONLY` keychain
  class, wiped on the first launch after a reinstall. It always replaces a rotated token, per RFC 9700.
  It sends the access token as `Authorization: Bearer`.
- **Server side.** `lib/session.ts` gains **one** alternative source of the WorkOS subject: a bearer JWT
  verified against the client's JWKS (signature, `exp`, issuer, audience). After that the path is
  identical: `principal_by_subject` → `resolveWorkosPrincipal` → `SessionContext` → the existing core
  services under the existing RLS. There is no second user table and no mobile-only permission. The demo
  switcher is **never** honoured on the bearer path.
- **App unlock.** The app is unlocked with the OS biometric prompt or the device passcode, with an in-app
  PIN as a deferred fallback, over the long-lived refresh token. **Foundation clarification (2026-10-09):**
  use the OS device passcode when biometrics are unavailable; if no OS credential is configured, discard
  the stored session and require hosted sign-in. Never treat unavailable biometrics as successful unlock.
  Do not create a second PIN credential system before its recovery and lockout model is designed.
  Login friction ("stay signed in" failing, biometrics
  dropping off, reset loops) is the top complaint for every vendor benchmarked. **OS biometric unlock
  gives the app no biometric data.** LocalAuthentication/BiometricPrompt only returns yes or no, so it is
  not biometric processing under PDPA and is not affected by section 4's exclusion.
- **Several employments.** A person with more than one employment picks which one to act as, after
  sign-in. There is one login and the choice is carried per request. This keeps
  USER ≠ PERSON ≠ EMPLOYMENT intact.
- **Onboarding.** Onboarding is by tenant-bound invite deep link or QR code, never a "company code" the
  employee has to find.

### 2. A narrow, versioned mobile API

Route handlers live under `app/api/mobile/v1/*`. Each handler parses its input against the shared
contract, calls `getSession()` through the bearer carrier, and calls a `core/` service. Handlers hold no
business rule.

- **My HR:** profile summary, leave balances, leave apply/cancel (with an **MC attachment** for sick
  leave), claims (receipt photo), payslips and **EA forms** (a Malaysian must-have; Kakitangan, SQL HRMS
  and AutoCount all list it), and notifications.
- **Clock:** today's status, clock context (section 6), online punch, offline batch upload, and attempt
  upload (section 5).
- **Approvals:** pending items. **Bulk approve** shows how many of the team are already away over the
  same dates, so the approver sees team coverage before deciding.
- **Out of scope:** payroll, admin, analytics, configuration. The AI assistant stays deferred. When mobile
  AI does arrive, the first feature should be **human-confirmed receipt/e-Invoice extraction**: the model
  proposes, deterministic validation adjudicates, the employee submits (ADR-0084). A mobile assistant
  answers and deep-links through ADR-0082 and never takes actions.
- **Documents.** A payslip or EA form is fetched by short-lived URL and is not cached. The one exception is
  an **explicit, user-initiated share** through the OS share sheet. That writes an audit event, and the
  temporary file is deleted as soon as the share sheet closes.
- **Tests.** Every endpoint gets refusal tests for another employee, another company, another tenant, a
  revoked device and an offboarded user. Every salary-bearing endpoint also gets a test that a non-self
  caller receives no money fields.

### 3. Push notifications

- **What gets sent.** ADR-0034's `push` channel is implemented. The payload holds a title key and a
  notification id, **never personal data** (Apple 4.5.4). The app fetches the content over the
  authenticated API. Android notifications use `VISIBILITY_PRIVATE`.
- **Token lifecycle.** Each device registration holds at most one push token. Revoking the device or
  offboarding the person deletes it.
- **No lock-screen actions.** Approve and reject are not offered from the lock screen. Tapping a
  notification opens the approval after unlock, because a decision about someone's leave or claim must
  not be one tap away on a locked phone.
- **Reminders.** Shift and forgot-to-clock-out reminders are **local, time-based** notifications. They need
  no background location.
- **Permission.** Notification permission is asked in context, once.

### 4. Clocking: one geofence rule, plus an evidence ledger

**The geofence rule is core's, for every front door.** ADR-0070's `OutsideGeofenceError` path applies to a
mobile punch exactly as it does to a web punch. The integrity evidence below is **added** to that rule and
never replaces it. Accuracy-aware containment (a punch is inside the fence if the fence contains its
accuracy circle, up to a configurable accuracy limit) and storing `coords.accuracy` apply to **both** doors,
which closes ADR-0070 §7's open follow-up. Before the punch, the app shows the distance to the site and the
accuracy circle. It never makes the employee wait for a perfect fix.

**Evidence, not a boolean.** Every mobile punch stores its raw evidence:
- the location fix, its accuracy, its provider, and the fix timestamp;
- `isMock` (Android), and `isSimulatedBySoftware`/`isProducedByAccessory` (iOS);
- the device registration and its attestation tier;
- the source (online, offline, or QR-corroborated).

A deterministic adjudicator (ADR-0084) derives a **trust tier** from this evidence:
- **Mock flags are one-sided.** A `true` flag lowers the tier. A `false` flag adds **nothing**.
- **`verified`** requires an attested device key, an accuracy-aware fence pass and, where the company has
  set one up, an on-site corroborator: a QR code from the site device, below.
- **Anything else** is recorded at a lower tier and **flagged for HR review**, never silently dropped.
  Whether a flagged punch is also refused is a company policy switch, off by default. That switch governs
  only the integrity signals, never the geofence (which core already enforces).

**Device registration is tiered, not pass/fail.** At registration (online), the app generates a
**hardware-backed key per user per device** and has it attested: Android key attestation plus Play
Integrity, iOS App Attest. A device that cannot attest (`isSupported` false, a lost key after reinstall,
restore or migration, a custom Android ROM) registers at a lower tier. It is **never locked out**; SAP's
close-on-root approach locks out legitimate OEM ROMs. An attestation **outage** still fails closed and
retries (Apple's rule for `serverUnavailable`: retry with the same key). It is never recorded as attested.

**On-site corroboration is the only real counter on iPhone**, because a USB desktop spoofer passes every
check the OS offers. The site device shows a **server-signed, rotating QR code** that the app can verify
offline against a short validity window. Site Wi-Fi is a possible second corroborator, but whether iOS
exposes the network identity to the app is UNKNOWN until checked. Following Zoho, a check-out must come
from the same source as its check-in, and punching through Siri/Shortcuts/App Intents is not offered.

**Location is foreground-only and one-shot**, taken when the user taps Clock. There is no background
location, no geofence-triggered reminder and no auto clock-out on leaving the site. That avoids Play's
background-location declaration and Apple's "Always" prompt, and the battery-drain complaints Connecteam
gets. On Android 17+ the app uses the platform location button. When iOS grants only approximate location,
the app shows an explicit "turn on Precise Location" screen rather than failing silently.

**Screens and reports say "verified device", never "proven present".** Attestation raises the cost of
cheating; it does not make cheating impossible.

**Face matching is out of scope.** It is sensitive personal data under Act A1727 and needs explicit consent.
The employment exception in s.40(1)(b)(i) covers only duties imposed by law, which attendance verification
probably is not (ASSUMPTION; Malaysian counsel to confirm). It would also need a non-biometric fallback and
certified liveness detection. A **non-biometric punch photo** (no template extraction) is a separate,
later decision, taken with counsel. If adopted it has a visible capture indicator, is never saved to the
camera roll, has a stated retention period and is stored in-country.

### 5. Offline clocking, and never losing proof that someone tried

**Failed attempts are kept.** Any failure to reach the server is treated the same way: no signal, a 5xx,
maintenance or an expired session. The app captures the punch locally and shows a **specific, truthful
message**, never a generic "offline". If offline clocking is **off** for the company, the capture is still
uploaded, as an **attempt record**. That is evidence for an HR correction, not a punch. It extends
ADR-0070's `attendance.geofence.blocked` attempt log to every failed mobile punch, and gives an employee
proof they tried on time when a lateness penalty is disputed.

**When offline clocking is on**, an offline punch is a **claim** that becomes an attendance fact only after
server adjudication:

- **Capture.** On the device, the punch is written to an encrypted queue. It is **signed with the
  registration's attested hardware key**, **hash-chained** to the previous queued punch, and carries a
  client UUID so a re-upload is harmless.
  - This is not a per-punch Play Integrity or App Attest call, which cannot work offline and would burn
    the shared Play quota.
  - Play Integrity runs at registration and at batch upload.
  - Whether iOS can generate an App Attest assertion with no network is UNKNOWN. It is tested on a device
    before Phase 3 relies on it.
- **Time.** The server derives the punch time from the **last server-signed anchor plus the elapsed time
  on a clock that keeps counting through sleep**, together with a **boot identifier**. It never uses the
  wall clock alone.
  - Android: `elapsedRealtimeNanos`.
  - iOS: a sleep-inclusive clock must be verified on devices. Until it is, iOS relies on the fix timestamp
    as corroboration, and its window is capped.
  - A reboot between anchor and punch gives a **"time unverified" review state, not a refusal**. The
    history is kept and a human decides.
  - The claimed, derived and received times are all stored.
- **Refusals.** The server refuses an offline punch whose anchor is older than the company's window, a
  punch from a device revoked before the upload, or one that breaks the existing duplicate/order rules.
  - The window defaults to **24 h**, configurable up to 72 h. The market's documented range is 12–24 h
    (Connecteam 12 h, Deputy kiosk 24 h), and drift on iOS grows with the window.
  - A refusal is shown to the employee and recorded.
- **Writing it.** An accepted offline punch is written through core's `checkIn`/`checkOut` rules, with a new
  method value `mobile_offline`. It is labelled "offline" on every timesheet and report. Payroll's
  attendance prefill reads it only once it is verified or HR has resolved it.
- **Policy.** Offline clocking is a company policy, **off by default**.

The server-timestamp rule is kept for online punches. Only for `mobile_offline` is it replaced, by a
derived time that is signed and anchored.

### 6. The app itself

- **Stack:** Expo (React Native + TypeScript) and EAS Build/Submit, so no local Xcode upgrade is needed.
  `@expo/app-integrity` is still alpha: pin its version or wrap a thin native module of our own.
- **Place:** `mobile/` in this repo, excluded from the root `tsc`, the vitest gate and the production rsync.
  The request and response contract lives in one module under `lib/mobile-api/`, which both the handlers
  and the app import.
- **Copy:** the app uses the same six `messages/*.json` catalogues under a `mobile` namespace. Malay must be
  first-class, not an afterthought: most local apps ship English-only, and many 1–2 star reviews are
  written in Malay.
- **Home:** task-first, the way Personio, Deel and BambooHR do it. Clock state and the Clock button, the
  items needing me (approvals, rejected claims), then balances. Five bottom tabs: Home · Clock · Requests ·
  Inbox · Me.
- **Data on the device:** payslips, balances and approval lists stay in memory only. Two things are
  persisted, both encrypted:
  - the offline punch queue (and the attempt queue);
  - a minimal **clock context**: assigned sites and radii, the current in/out state, policy flags and the
    time anchor. Without it the offline Clock screen cannot show "you are clocked in" or pre-check the
    fence.

  Signing out uploads both queues first. If it cannot, it warns that unsent punches will be lost.
- **Version policy:** the app sends its version on each request. "Update required" **never blocks a punch
  or a queued upload** from a supported version. The support window starts as the current version plus the
  two previous ones (SAP's policy).

## Phases

0. **Prerequisites (owner plus Claude).**
   - Domain and HTTPS on production.
   - The WorkOS cutover (readiness 1.3, `docs/WORKOS-CUTOVER.md`). The Basic-auth gate is lifted for real
     users once logins are real.
   - Apple Developer Program and Google Play Console **organisation** accounts. Start D-U-N-S today.
   - A privacy notice that names location at punch time and states its retention.
1. **Foundation.**
   - The bearer carrier.
   - `/api/mobile/v1` My HR, Approvals and Notifications endpoints, with the leak/refusal suite.
   - The Expo app with sign-in, biometric unlock, the employment picker, the task-first Home, Leave (+MC),
     Claims, Payslips + EA, Approvals, and **online** Clock through core.
   - Core changes: **raw evidence capture on every punch**, **accuracy-aware geofence on both doors**,
     **attempt records with truthful errors**, **foreground-only location**.
   - Store and PDPA paperwork: the **Data safety form and privacy labels before the first closed test
     track**.
2. **Push:** the delivery channel, the token lifecycle, private visibility, and local reminders.
3. **Clocking integrity.**
   - Attested hardware keys and tiered registration.
   - The trust-tier adjudicator and the HR review queue.
   - The rotating site QR code.
   - The encrypted clock context, and the signed, chained, anchored offline queue.
   - Migrations allocated centrally when the phase starts.
   - First, device spikes for the three unknowns: offline App Attest assertions, a sleep-inclusive iOS
     clock, and Wi-Fi identity on iOS.
4. **Store submission.**
   - A reviewer demo tenant whose sites cover the reviewer's location.
   - Review notes that explain accounts are employer-provisioned, with an in-app "request deletion
     through your employer" route.
   - One public listing (not a managed-Play private app).
   - The release pipeline.

## Consequences

- There are now two front doors, server actions and `/api/mobile/v1`. Both converge at `getSession()` and
  `core/`, and so does the geofence rule. What doubles is the **authorization test surface**, which is why
  every endpoint ships with its refusal suite.
- `v1` endpoints are frozen once published. A breaking change means adding `v2` beside `v1` until the
  oldest supported app version is retired.
- The attendance record gains an evidence ledger and a trust tier. **Online** punches keep today's model.
  `mobile_offline` punches are a labelled, adjudicated exception to the server-clock rule.
- Attempt records make failed clock-ins visible to HR. That is new work for HR, and it is also the
  evidence employees currently lack.

## Risks and unknowns

- **FACT (security hardening, 2026-10-09):** credential mutations are serialized and owned by a login
  generation. Logout invalidates pending browser/refresh operations immediately. A stale response cannot
  restore credentials, clear a newer refresh flight or sign out a newer account.
- **FACT:** the native foundation requires HTTPS origins, hides private routes when inactive, locks on
  background/Android blur, enables native capture/app-switcher protection before reading a stored session,
  and wipes surviving Keychain refresh credentials before creating its first-install sandbox marker.
  **UNKNOWN:** actual device behavior until the iOS/Android verification matrix is completed.
- **FACT:** WorkOS documents the AuthKit issuer as `https://api.workos.com/` or the custom Auth API domain
  ([Sessions](https://workos.com/docs/authkit/sessions), checked 2026-10-09). The mobile verifier now checks
  the exact configured issuer. AuthKit has no documented default audience; `WORKOS_JWT_AUDIENCE` enforces
  one only for an explicitly verified JWT contract. This corrects the earlier implementation's omission
  of issuer checks without guessing an OAuth Connect audience.
- **RECOMMENDATION implemented:** signing-key fetches share one flight per client, retry at most once
  per minute after a failure, and serve outage cache only until thirty minutes after the last successful
  fetch. Beyond that the API returns unavailable, never a credential refusal.

- **UNKNOWN (Phase 3 spikes, before building on them):** whether iOS can generate an App Attest assertion
  offline; whether iOS has a clock that keeps counting through sleep; whether iOS exposes site Wi-Fi
  identity to the app; whether Play Integrity works for this app's distribution.
- **UNKNOWN:** the access-token lifetime configured in our WorkOS environment. Set it to minutes.
- **RISK:** the Play Integrity quota (10,000 a day by default, shared across all tenants). Ask Google for an
  increase before scale.
- **RISK:** a rooted Android phone can pass even Play Integrity's strongest verdict with a leaked keybox
  until Google revokes it. This is why tiers and on-site corroboration, not attestation alone, decide
  `verified`.
- **RISK:** Apple requires a D-U-N-S number for organisation accounts, and getting one can take weeks.
- **RISK:** the 10 approved board items compete with this work for the same rounds. Sequencing is the
  owner's call.

## Decisions required later (not settled here)

- A non-biometric punch photo: whether, and on what terms (with Malaysian counsel).
- Former employees reaching their own old payslips and EA forms. Offboarding correctly removes app
  access, but losing those documents is a live complaint in the market. It is also a USER ≠ EMPLOYMENT
  question; web first.
- A shared-device kiosk app as a second build target, and MDM managed-configuration keys
  (`tenant`, `disableBiometric`). The Microsoft Intune App SDK does not support React Native, so Intune
  app-level protection is deferred until a named customer needs it.

## Alternatives considered

- **Installable web app only.** Rejected by requirements 1, 3 and 4. It stays the fallback: the web keeps
  working in a phone browser.
- **Capacitor wrapper around the existing web app.** Rejected: the pages are server-rendered and need a
  connection, so offline clocking would still need a native queue and an API. A thin wrapper also risks
  App Store 4.2.
- **Calling server actions from the app.** Rejected: their IDs change on every build.
- **A separate mobile backend.** Rejected: it would be a second reader of the same tables outside `core/`
  and RLS.
- **The market's gate model** (block on any failed face or location check). Rejected. It produces the
  lateness-penalty complaints that dominate Malaysian reviews, and it still does not stop a USB spoofer on
  an iPhone. The evidence ledger keeps every signal and lets a human decide the grey cases before payroll
  reads them.
