# OneHR+ mobile release review

Status: **HOLD — four-area acceptance is incomplete.** Reviewed 1 November 2026.
Scope: Apple App Store and Google Play. Public name: **OneHR+** (owner confirmed).

## Current review boundary — design paused

The owner moved visual exploration to a separate wireframe/mockup session. This review freezes
visual source `8979a4945cc729b09d7c88ea15fdef72faec6bf5`; the design has **not been accepted** as
meeting the Opal reference. Continue functional, navigation, accessibility/adaptive usability,
security and notification verification here. Do not resume aesthetic iteration without direction.
All approval types remaining native-incomplete are tracked in
[MOBILE-APPROVAL-COVERAGE.md](MOBILE-APPROVAL-COVERAGE.md).

Current installed review binaries, version 1.0.3 (4), both source 8979:

- iOS simulator `f6a7e419-72b5-4d87-81bf-1a775e961ccd`, iPhone 17 Pro / iOS 26.5.
- Android APK `891a86dc-fe0b-43e7-a5ad-afd78e5ec043`, Pixel 3a emulator / API 34.

HEAD `ee7be5bf7f2fcac2aeb16881a51ca06336188f4b` differs only by a DOM-test TypeScript repair.
Earlier candidate/build descriptions below are historical checkpoints, not the installed binaries.
Both simulators have reached authenticated Home using the owner-confirmed synthetic account.
Android remains without an OS screen lock by explicit owner choice; full reauthentication on
session restoration is expected. Screen protection remains enabled. Owner explicitly approved
private synthetic-content host captures, excluding password/MFA screens.

Runtime observations on Android source 8979:

- My profile settled to authorized employee details instead of a stranded loading spinner.
- Tapping My profile's in-app Back returned to Me; Android system Back from Settings also returned
  to Me. Settings' in-app Back requires further reproduction before marking the whole control accepted.
- Home, Clock, Leave, Me and Approvals rendered authenticated content. No attendance punch, leave
  submission or approval decision was issued in this read-only navigation walkthrough.
- Appearance and language controls changed local preferences; English was restored. Light was
  selected for subsequent usability checks. This is not contrast or visual acceptance.

Hosted structural run [41310955079](https://github.com/StradaverseHub/ai-hr/actions/runs/41310955079)
finished all planned jobs: 174 selected tests in 13 files, native compiler and both production
exports passed; whole-repository compiler failed on an unsupported test query option. Preserve
that original failure. Repair run
[41312123992](https://github.com/StradaverseHub/ai-hr/actions/runs/41312123992) passed all jobs:
102 affected tests in seven files, whole/native compilers and both exports. These overlapping
counts must not be added as unique coverage. The earlier 07beeff run 41303947136 also completed
its root compiler and Linux build successfully. Focused evidence remains release-ineligible.

Functional/security/notification run
[41314593426](https://github.com/StradaverseHub/ai-hr/actions/runs/41314593426) was dispatched on exact
HEAD ee7 with ten session, native-security/journey, profile and push/notification suites. All planned jobs finished: **165 passed, three failed, zero skipped** across ten suites. The three
failures were missing `./visual` fixture dependencies in attendance-control tests, before their
assertions ran. The original log and raw JSON reports are retained privately. Test-only repair
`724f20e7442cdc63521dbd79f70e3376324cefb2` supplies the existing presentation port without altering
app behavior. [Repair run 41315044552](https://github.com/StradaverseHub/ai-hr/actions/runs/41315044552)
checks the failed control suite, protected-file lifecycle and shift reminders, plus root compiler.
Its 19 behavior tests passed with zero failures/skips; the root compiler is still pending.
Unaffected successful evidence is retained.

Physical-device secure storage, biometrics, actual APNs/FCM delivery, final signed entitlements,
all declared form factors and backend release acceptance remain open. No assertion of zero bugs
or immunity from attack is supported. Store release remains **HOLD**.

## Candidate and evidence boundary

Preparation starts from freshly fetched main `2f6e5abe6098ab4e83ecd5fc95b4d6a580e7f308`.
Alpha was one unrelated rewards fix ahead (`1a74336e68abf0c06067b19857ad68c8aeb93049`).
This branch preserves both integration branches and all other worktrees. No backend deployment,
store upload, review submission, public release, signing rotation or rollout activation is performed.
Follow [repository policy](REPOSITORY-AND-ENVIRONMENTS.md) and the
[release handoff](PRODUCTION-RELEASE-HANDOFF.md) for backend changes/acceptance.

The authenticated EAS project is `@stradaverse/ai-hr-test`, ID
`7f580e1e-293f-4ad7-9c57-bd8f992a882f`. The city-background review builds are source
`279ae747eedc6767321b5d57d9cfd4c575a6a94f`, version 1.0.3 (4):

- iOS simulator: `f5da111c-91d8-4100-9b58-7ac8deb61970`, finished and installed on iPhone 17 Pro / iOS 26.5.
- Android review APK: `007e63c6-1583-440a-9030-be15c5644b8f`, finished and installed on emulator-5554 / API 34.

Both package identities remain `ai.stradaverse.aihr.test`; the packaged public name is OneHR+.
Use pinned EAS CLI 24.10.0; the globally installed 10.2.2 is below the project's requirement.
The 188-file EAS upload archive was checked against public committed source: no untracked,
environment, backend, signing or private configuration files. No store submission was performed.

The owner requested simulator review first and explicitly authorized adb/simctl. Both installed
builds reached the synthetic staging workplace's sign-in screen. iPhone city backgrounds were
observed in light and dark mode. Android accessibility confirmed the sign-in controls; active screen
capture protection blocks automated sign-in screenshots. Authentication, final repaired binaries,
other sizes and real phones remain pending. Installed source 279 does not contain the later shared
private-Screen session guard.

## Verification of the preparation candidate

Frozen application/configuration source: `437c6b8041880534c1141db21155c29e9d175ebb`.
[Hosted focused run 41296681327](https://github.com/StradaverseHub/ai-hr/actions/runs/41296681327)
uses controller `2f6e5abe6098ab4e83ecd5fc95b4d6a580e7f308` on standard GitHub runners.

- Selected tests: **491 passed, zero failed/skipped**, across 29 files. Raw reports independently
  reconcile to 12 database files / 229 cases and 17 non-database files / 262 cases.
- Native TypeScript: **PASS**. iOS and Android production Metro/Hermes exports: **PASS**.
- Whole-repository TypeScript: **PASS** (compiler step completed 10:25:16 UTC).
- Actual local EAS archive-stage inspection with CLI 24.10.0: **185 files**, including all **28**
  shared dependency files. Inspection found no server/core/database/deployment source, environment
  files, signing credentials or node_modules. The regression suite also checks private exclusions.
- Dependency advisory review: **NOT VERIFIED**. The GitHub alert API returned 403, with Dependabot
  alerts disabled. No access scopes were expanded; a fresh mobile dependency advisory scan remains open.

The focused report explicitly has `releaseEligible: false`. This is not a full release gate,
signed native build, physical-device test, live authorization audit or store acceptance.
Documentation-only follow-ups do not relabel this evidence onto a different application commit.

### Preliminary simulator observation

The existing iPhone 17 Pro / iOS 26.5 app identifies as AI HR Test 1.0.3 (4). Its bundled JavaScript
was written 29 October at 16:20 UTC (30 October MYT), and it has no established source-SHA binding
for this review. It is **not** the frozen preparation candidate. The owner confirmed the account
is synthetic. The native lock screen hid HR content and presented the normal Face ID flow.
After simulator biometric completion, My profile rendered in dark mode with an activity spinner;
tapping Back and trying the left-edge back gesture produced no observed route change. No HR write
was performed. Root cause is unverified: repeat with the frozen candidate, known backend and clean
navigation, and verify that loading terminates in data or an actionable error. At the initial source audit, shared
HeaderBack called `router.back()` without a `canGoBack` fallback, so cold-entry navigation needs
specific coverage. This observation blocks acceptance of the installed build, without asserting a
regression in the newer candidate.

### Regression repairs and redesign checkpoint

- Back navigation: failing cold-entry regression was captured at `630692d`; the repair at
  `b3fc441` passed hosted run [41298503443](https://github.com/StradaverseHub/ai-hr/actions/runs/41298503443).
- Profile loading: real authentication/API/session controllers reproduced the stranded spinner
  for v1 and v2 after current refresh revocation at `b360389`; `5dbf19a` passed selected regressions
  and native TypeScript in [41299374958](https://github.com/StradaverseHub/ai-hr/actions/runs/41299374958).
- URL decoder: a fresh npm advisory review found the vendored 0.5.0 decoder affected by
  [GHSA-qr28-fpjm-wq7f](https://github.com/advisories/GHSA-qr28-fpjm-wq7f). The actual query parser
  exceeded its five-second watchdog at `8f8b299` in
  [41300227040](https://github.com/StradaverseHub/ai-hr/actions/runs/41300227040); the other five cases passed.
  `e712b6b` updates the integrity-checked CommonJS repack to official 0.5.1.
- The Opal-inspired UI checkpoint `bc1cd8887a5ba86bc343f138f0fe194e807348b3` passed
  [41300598303](https://github.com/StradaverseHub/ai-hr/actions/runs/41300598303): **486 tests in 38 files**,
  zero failed/skipped (16 database files / 154 cases; 22 non-database files / 332 cases), both strict
  compilers, and iOS/Android production exports. This includes the decoder repair.

### Customer artwork and security follow-up

The owner selected Workplace & city as the shared default and a deeper Chin Hin / 8th & Stellar
pair as customer artwork. Group administrators can upload separate light/dark images, preview,
save/publish, revert to defaults and roll back. Uploading alone does not publish. Tenant-owned
immutable image IDs are referenced by design snapshots; only own-tenant published JPEGs are sent
to authenticated capable clients. Older schema clients retain compatible responses. Sign-in and
lock screens use the shared default. The app reloads design on foreground/refresh. Backend and
compatible app deployment are required; no production upload or publication was performed.

Source `279ae747eedc6767321b5d57d9cfd4c575a6a94f` run
[41302053518](https://github.com/StradaverseHub/ai-hr/actions/runs/41302053518) completed all planned
jobs: native/root TypeScript, both native exports and Linux production build passed. Selected tests
had one stale default-color assertion failure (110 passed, one failed across 13 files); customer
upload, tenant isolation, RLS and compatibility tests passed. The failure is retained and repaired.
Migration 0878 is provisional, tested in hosted test databases and not installed on an environment;
recheck allocation and perform required release rehearsals before integration.

Real shared-Screen regression and real Nodemailer JSON-transport tests at `9bc32ec` reproduced
signed-out/locked/loading private-content rendering and recipient parser confusion in
[41303153415](https://github.com/StradaverseHub/ai-hr/actions/runs/41303153415). No external email was sent.
Repair `07beeff5b2380e1aa7f2b4472c865e5d831bb201` adds the Screen session boundary, patches Next to
16.4.1 and Nodemailer to 10.1.4, and preserves exact build runtime checks with matching version pins.
[41303947136](https://github.com/StradaverseHub/ai-hr/actions/runs/41303947136) selected tests passed:
**111 cases in 14 files**, no failures/skips (database 38/4 files; non-database 73/10 files).
Native TypeScript and both production exports passed; root TypeScript and Linux production build
were still running at this documentation checkpoint. CI producer/cache-policy fixtures need their
own hosted controller verification; focused evidence is not release authorization.

The patched server production lockfile advisory scan returned zero entries. The mobile audit after
the decoder repair reports 15 affected entries (4 high, 9 moderate, 2 low), including propagated Expo
tooling findings. These are not 15 demonstrated app exploits. Runtime Zod is 4.6.7; nested Expo tooling
uses Zod 3. Final binary reachability and tooling patch compatibility remain open. No forced SDK
upgrade or advisory suppression was used to conceal findings.

The source-279 APK manifest confirms target SDK 36, non-exported file providers and the public
OneHR+ name. It also contains an unnecessary SYSTEM_ALERT_WINDOW permission and allowBackup=true.
The next configuration blocks the overlay permission and sets allowBackup=false, retaining existing
SecureStore exclusions. Its actual rebuilt manifest and real-device restore behavior remain unverified.
Authenticated simulator walkthroughs, other phone sizes, physical-device push and the final design
finish review/documentation are still pending. Store release remains HOLD.

### Native UI source audit

Source has platform-specific SF/Material symbols, reduced-motion subscriptions, native text scaling
(no global `allowFontScaling=false`), explicit loading/error states, virtualized paged lists and an
accessible two-step alternative to sliding confirmation. Preserve these properties.

Accessibility still needs VoiceOver/TalkBack order and large-text measurements; performance needs
startup/scroll measurements; theme quality needs contrast and screen captures in both appearances;
platform conformance needs working Back/gestures and measured targets; adaptivity needs keyboard,
iPad/tablet and multi-window acceptance. These five dimensions are **unscored pending runtime evidence**;
source structure alone cannot establish a polished UI. Source concerns are prioritized below.

Recommended design follow-up: `$impeccable adapt` for targets/keyboard/tablets, `$impeccable harden` for
loading/navigation recovery and help/privacy entry points, then `$impeccable polish` after verification.
The existing product/design metadata is stale; a separate `init`/`document` refresh can reconcile it.
Do not alter unrelated design context during this release review.

## Findings and preparation

| Priority | Finding | Evidence and consequence | State |
| --- | --- | --- | --- |
| P1 | EAS archive excludes current shared dependencies | Root `.easignore` admits v1 only, while mobile imports v2 attendance, pay, notifications, etc., and offline contracts. A full-repository export can pass while a cloud upload cannot resolve these imports. | Explicit shared-file allowlist repaired; two regression cases and actual archive inspection passed. |
| P1 | No store build profile | Existing profiles distribute internal APK/IPA or simulator builds. | Added standalone production profile: store distribution, Android AAB, embedded auth and runtime connections. No submission automation. |
| P1 | Production workplace onboarding not established | Bundled signed profile identifies staging and uses a test trust key. There is no verified production setup in this review. | Pending signed production setup/trust provisioning and reviewer setup. Do not rename, forge or re-sign an existing profile without its owner. |
| P1 | Privacy and support entry points absent | `mobile/app/settings.tsx` contains display/security/notification/device controls, but no privacy or support link; no policy URL exists in mobile configuration. | Pending owner URLs and accessible in-app entry points, including before sign-in. |
| P1 | Android push provisioning absent in checked-in configuration | No `android.googleServicesFile` in `mobile/app.json`; Android uses native FCM tokens, not Expo push relay. | Verify/configure Firebase registration for the final package and generated native resources; validate real delivery. Keep service-account keys server-side. |
| P1 | Signed-device security and push evidence missing for this candidate | JavaScript/host-model tests cannot prove Keychain/Keystore, biometric hardware, signed entitlements, APNs/FCM delivery or process-death recovery. | Both physical-platform walkthroughs required. |
| P2 | Public brand differs across surfaces | Display name was AI HR Test; lock/permission/setup and push copy still say AI HR. | Display name changed to OneHR+; full copy/icon review remains. Bundle/package IDs and scheme preserved pending store-record verification. |
| P2 | Android compact controls can fall below platform target | Shared Button/Chip and slide-confirm fallback use 44-point minimums in `mobile/lib/ui.tsx` and `slide-confirm.tsx`. Android requires checking 48dp effective hit areas. | Confirm measured bounds and spacing; audit records the issue without redesigning controls. |
| P2 | Adaptive layout not accepted | `supportsTablet: true`, portrait orientation and disabled predictive Back are configured. | Verify iPad/tablet, keyboard, large fonts, multi-window and Android back behavior; either support declared devices or deliberately narrow scope. |

No security vulnerability or runtime break is inferred solely from an unexecuted device test.
App Attest calls exist, but no explicit App Attest entitlement appears in app.json. Verify the final
signed entitlements and server app/environment configuration before enabling attested attendance.
Default-disabled integrity/offline rollout must remain disabled until its own acceptance passes.

## Four release gates

Use synthetic employees and a known review tenant. Record exact backend SHA/build, binary SHA/build,
OS/device, test account role, result and private evidence reference for every row. Mark unrun checks
**NOT TESTED**, never PASS. Capture redacted screenshots from native devices/simulators, not browser
previews. Keep employee data, tokens, signed setup links and reviewer credentials out of public CI.

| Area | Required walkthrough on both iPhone and Android | Acceptance |
| --- | --- | --- |
| UI/UX | First-launch workplace setup; sign-in/MFA/recovery; navigation/back; dashboard, clock, leave, approvals, payslips, inbox, profile and Settings. Light/dark, small screen, large system text, VoiceOver/TalkBack, keyboard, error/empty/loading states, slow connection and safe-area insets. Inspect supported iPad/Android tablet sizes separately. | No clipped/hidden primary action, unlabeled control, inaccessible confirmation or confusing lost state. Effective targets ≥44pt iOS / ≥48dp Android; readable contrast and coherent OneHR+ brand. |
| Functionality | Employee and manager journeys: attendance with photo/location grant/refusal; leave request/status/cancel; authorized approvals; payslip/EA view and deliberate PDF share; profile changes; pagination; company/employment switch; denied/disabled modules. Interrupted send, timeout, duplicate tap, restart, airplane mode and receipt recovery. | UI and server records agree exactly; one intended write; no false success, cross-company data or silently discarded pending work. Offline claims remain unverified until server acceptance. |
| Security | Embedded login, initial password change/MFA and recovery; invalid credentials/throttling; refresh/logout/revocation/offboarding; wrong employee/company/tenant; modified/expired workplace setup; lock/background/notification shade; screenshots/recording; biometrics/passcode/cancel; reinstall/restore; protected-file cleanup and redacted diagnostics. Inspect signed permissions, privacy manifests, network trust, key storage and exact app attestation environment. | Server enforces every role/scope; expired/revoked access denied; private data hidden while locked; no credentials/HR data in push, logs or upload archives. No relaxed TLS/auth/rollout controls to make a test pass. |
| Notifications | In-context permission request, grant/refuse/later-enable, opt-out; real server-triggered APNs/FCM notification foreground/background/terminated; cold-start and locked taps; correct inbox item after unlock; stale/wrong-tenant/deleted item; logout/company change/token rotation/reinstall; badge/read state; shift reminder changes/cancellation/timezone/DST; invalid provider token and delivery retry behavior. | One expected notification, generic private payload, no duplicate writes or stale account routing. Permission denial leaves inbox usable. Provider acceptance, actual display and correct tap routing each independently observed. |

### Automation selection

Use standard GitHub-hosted `alpha-focused-checks.yml`, frozen source and exact expected SHA.
Run native TypeScript, both production Hermes exports, and focused existing suites for:

- UI: native design/composition/journey controls, date formatting, load state, paged lists.
- Functionality: native journeys, leave/attendance/pay/approvals/profile screens and API authorization.
- Security: native auth/storage races, company setup, protected documents and mobile API sessions.
- Notifications: native lifecycle, shift reminders, push API, transport and tenant isolation.
- Packaging: `test/mobile-store-archive.test.ts` (complete shared import closure and private exclusions).

Focused green checks establish their covered behaviors only. A store candidate also needs actual
upload-archive validation, signed native builds, release verification required by repository policy,
backend compatibility/acceptance and the physical walkthroughs above. Preserve original failures;
finish all dispatched jobs before repairs and rerun only failed/invalidated checks under current policy.

## Store preparation

Preserve `ai.stradaverse.aihr.test`, the EAS project and `aihr` scheme until App Store Connect and
Play Console app records/signing history are verified. A display-name change does not require new IDs.
Choose final IDs before the first public release; changing them creates a different app identity and
affects push, attestation, links and installed sessions. Never rotate existing signing custody casually.

Before building: verify production EAS environment values, signed workplace setup/trust anchors,
server mobile/push configuration, Firebase app registration, Apple signing and capabilities, Play
upload-key custody and final store identity. Compare both stores' version history, then reserve new
local build numbers above every existing upload (latest EAS number observed is 4). Version numbers
have deliberately not been guessed or incremented during this review.

After the four gates pass on the frozen candidate:

1. Inspect the actual EAS source archive; verify shared contracts are present and server/secrets absent.
2. Build the exact source using `npx eas-cli@24.10.0 build --platform ios --profile production`
   and the equivalent `--platform android`. Inspect final IPA/AAB metadata, icon, permissions,
   entitlements, privacy manifest and production endpoints; record hashes/build IDs.
3. Verify Apple Developer/App Store Connect and Google Play account access, agreements, app records,
   app-access instructions, encryption answers, age/content ratings, countries and any testing eligibility.
4. Deliver the candidate to TestFlight/Play internal testing through the verified account route. Check
   processing and tester availability, then repeat physical checks on those exact distributed binaries.
5. Complete screenshots for supported device classes and accurate Apple App Privacy / Google Data safety
   declarations. Inventory identifiers, HR/profile data, payslips, precise location, attendance photos,
   receipt/supporting files, push tokens, diagnostics, local retention and backend/processor use. Do not
   claim no collection just because data goes to an employer server or a push body is generic.
6. Provide published privacy/support URLs, reviewer contact, a synthetic reachable review tenant,
   working workplace setup and a repeatable MFA review path. Preserve MFA; do not give reviewers real
   employee accounts. Determine account-deletion obligations from actual account-creation behavior;
   HR record-retention requirements and authentication-account deletion are distinct.
7. Select exact processed builds and complete review submission only after owner acceptance of all
   four areas. Use manual public release timing so review approval is distinct from public availability.

Apple upload, review submission, approval and public availability are separate states. Android provider
upload, internal tester availability and production rollout are also separate. Report only the state
independently observed.

## Draft listing copy

Name: **OneHR+**. Suggested category: Business. Subtitle: **Your workplace, in one place**.
Short description: **Manage attendance, leave, payslips and workplace updates with your employer.**

OneHR+ connects you to your employer's HR service. View your workplace updates, check attendance,
request leave, access released payslips and manage supported employee requests from your phone.
Managers can review assigned requests when their role allows it.

Your available features depend on your employer's setup and your access. You need an employer-issued
account and workplace setup to sign in. Location and camera access are requested when a supported
attendance or document task needs them. Notifications are optional; updates remain available in the app.

Draft only: verify every advertised feature against the accepted tenant and binary. Add confirmed
support/privacy URLs, developer identity and screenshots before transferring copy into either store.

## Primary release references

- [Expo build profiles](https://docs.expo.dev/build/eas-json/)
- [Expo Android submission](https://docs.expo.dev/submit/android/)
- [Apple App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)
- [Apple account deletion](https://developer.apple.com/support/offering-account-deletion-in-your-app/)
- [Google Data safety](https://support.google.com/googleplay/android-developer/answer/10787469)

## Physical-phone acceptance worksheet

Run on both a real iPhone and Android with a synthetic workplace, on exact distributed builds.
Record device/OS, build, backend identity, result and private evidence for each row.

| Check | Procedure and expected outcome | Current evidence / remaining work |
| --- | --- | --- |
| Real push delivery | Trigger a server notification with app foreground, background and terminated; then tap while locked. One generic notification, correct screen after authentication, no private HR text on lock screen. | Server privacy, token isolation and duplicate suppression passed hosted tests; actual APNs/FCM delivery untested. Android Firebase provisioning remains a release blocker. |
| Push refusal and account transitions | Deny then enable permission; disable notifications; sign out, switch workplace, rotate/reinstall token. Inbox remains usable and prior account receives no further pushes. | Hosted lifecycle tests passed; real OS permission/token behavior untested. |
| Attendance sensors | Allow/refuse camera and location, approximate location, unavailable GPS, offline/interrupted submission and repeated taps. Verify exactly one accepted server record or an accurate refusal. | Hosted authorization/idempotency tests passed; actual sensors, accuracy, permission prompts and device integrity untested. |
| Device security | Face ID/fingerprint success, cancel, failed match, passcode fallback, background, notification shade, process death and restart. Private content remains hidden until authorized. | iOS simulator biometric restore observed; real Keychain/Keystore/biometric hardware and Android secure-lock behavior untested. |
| Files | Open payslip/EA/receipts; cancel and finish explicit sharing; background, switch employment and logout. Confirm protected temporary files are cleaned and only intended share persists. | Hosted protected-file follow-up pending; actual OS viewer/share/file cleanup needs phones. |
| Employee and manager journeys | Submit and cancel leave, profile change, attendance correction and each supported approval using synthetic records. Verify authoritative records, receipt recovery and no duplicate writes. | Read-only Android profile/inbox/navigation and narrow approval detail observed; hosted mutation tests passed. Live end-to-end writes and all approval types remain incomplete. |
| Usability | Keyboard, large text, VoiceOver/TalkBack, smallest supported phones, rotation/multi-window where declared. Primary actions remain reachable and labels/facts readable. | Android 320dp attendance detail exposed both decision controls and full facts at default text; broader sizes/large text/accessibility untested. Design remains unaccepted. |

Final source-8979 APK inspection confirms `allowBackup=false`, no SYSTEM_ALERT_WINDOW, target SDK36,
non-exported file providers and permission-protected exported Firebase/profile-installer receivers.
Final simulator iOS Info.plist has OneHR+ display name, contextual camera/location/Face ID descriptions
and `NSAllowsArbitraryLoads=false`. These do not substitute for final signed IPA/AAB inspection.
The Android emulator disconnected before this follow-up's live walkthrough; no new Android runtime
PASS is inferred. No production deployment or store submission has occurred.

The source-8979 APK resource table also lacks `google_app_id`, `gcm_defaultSenderId`,
`google_api_key` and Firebase `project_id` strings. The reviewed Android binary has no embedded
Firebase registration resources; native FCM delivery cannot be accepted until the owner-provisioned
Firebase Android registration is supplied through the controlled build environment and rebuilt.
Never place a service-account private key in the app.

## Combined mobile review candidate — 2 November 2026

The owner requested one combined build after merging the MOBILE UI contribution, rather than alternating partial installations. The owned mobile readiness branch normally merged the frozen UI source e9d67c7fb (common base 68b94ca9c), preserving the iOS widget renderer repair ef5c3e10f and all 15 approval kind implementations. The approved flat mint HR+/sideways-1 vector now owns the app/adaptive/monochrome/splash assets. Widget status/times use a minimal expiring server projection; see MOBILE-WIDGETS.md. The next native review build number is 5 on both platforms. No production, store or Firebase action is authorized by this consolidation. Staging server arrival and end-to-end acceptance of the new approval workspaces remain separate release holds.
