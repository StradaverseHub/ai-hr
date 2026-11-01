# OneHR+ simulator review — 2 November 2026

Status: review in progress; not a store, production or whole-platform acceptance record.

## Source and installed artifact

- Reviewed shared-shell candidate: `06c5c634b281ca6598fb5cb0cfd65c4ee4513705`, version 1.0.3, build 9.
- Independent iOS finish review requires an explicit Clock in/Clock out label above each small widget time. Source correction `275936c2581217096277255d9859d6081657b28c` changes only iOS widgets and the iOS build number to 10. Android runtime source and version 9 stay unchanged. The corrected iOS build and reviewer verdict remain pending.
- iPhone 17 Pro / iOS 26.5 simulator: EAS `e0e79c5a-04ee-42e7-ba17-4feea1368828`; installed executable and JavaScript match the downloaded artifact. The upload archive contained 245 exact tracked public files, no private or untracked files.
- Android candidate: EAS `3b98b255-fe08-4823-ba3b-297fc4e47e2c`; compilation and installed review remain to be completed. The emulator intentionally has no screen lock; normal protected-session restoration cannot be claimed there.
- Approval server candidate is separate: `f4362556f36cf0476cb7e5198b196d5688485fad`, [draft PR 192](https://github.com/StradaverseHub/ai-hr/pull/192). It is not installed on staging.

## Fixed defects and execution evidence

| Area | Defect and result |
| --- | --- |
| Clock preparation | A server-authorized default employment was rejected when no explicit profile selection existed. Use the current resolved subject with epoch guards; stale/switching subjects still fail closed. |
| Durable submission | An absent optional device registration token was serialized as null, failing the strict command schema before send. Normalize absence to undefined in both preparation paths; retain strict validation and encrypted staging. |
| Shared navigation | Root signed-in header and in-flow bottom navigation persist around pushed pages, forms, errors and loading. Company schema-2 published top navigation remains above content. Authentication and lock remain outside the signed-in frame. |
| Motion | Short feedback transforms a child while the hit target stays stationary. Carousel focus runs on the UI runtime. Reduce Motion removes spatial effects; no dependency added. |

The clock failures were first reproduced in hosted checks. [Affected clock recovery](https://github.com/StradaverseHub/ai-hr/actions/runs/41336148967) passed 197 tests across six files, native TypeScript and both exports at `182d34ddb`. Clock implementation bytes are unchanged in build 9. [Final navigation recovery](https://github.com/StradaverseHub/ai-hr/actions/runs/41338755564) passed 19 tests in two files at the final mobile source. Native TypeScript and both exports passed their jobs in [41338519466](https://github.com/StradaverseHub/ai-hr/actions/runs/41338519466); that workflow as a whole failed because its separately retained test selection named a nonexistent file. It is not described as a successful workflow.

## iPhone runtime observations

All observations use the owner-confirmed synthetic staging account. Private captures stay outside public artifacts.

- One explicitly authorized clock-in and one clock-out were submitted through the normal preparation and confirmation flow in build 8. Server acceptance was observed at 02:40 and 02:43 MYT, respectively. Independent Today’s record shows both and 0h02m recorded. No further attendance writes are authorized or needed for this check.
- Build 9 independently reads the same accepted pair and duration after an in-place update. Pending requests shows **0**.
- Home, Clock, Leave, Me, profile, approval queue and native attendance correction detail load. Profile Back returns to Me; approval detail Back returns to the queue. No HR approval was submitted.
- Header and five bottom destinations remain visible. Approval actions and the leave review footer sit above bottom navigation. Canceling the untouched leave form creates no request.
- Dark main pages and light Leave/form/pending views were captured. Original app Dark and OS Light preferences were restored. This does not establish every phone size, text scale or accessibility mode.
- Unchanged widget code in build 8 renders nonempty accepted times in both appearances. Medium widget shows Clocked out, IN 02:40, OUT 02:43, date and refresh time; the small IN widget shows status and IN time. Earlier widget shortcut checks reached authentication and explicit clock review without recording attendance.
- Notification permission was allowed through the normal OS dialog. Shift reminders reflect the effective enabled state; push enrollment reports unavailable on the simulator. One generic update injected with simctl displayed a banner containing no HR details. This is simulator display evidence, not APNs/FCM or backend delivery evidence. Notification tap routing and scheduled delivery remain to be observed on hardware.
- Session protection remains active across leaving the app and OS permission dialogs; simulated Face ID unlock was required. No protection was disabled.

## Expanded approval release hold

The current staging server does not expose the expanded native workspace capability, so profile change and replacement leave still show web links in the installed app. Client routing follows that response. The server candidate covers all 15 inbox kinds through canonical services, assignment/scope checks and receipt replay; do not bypass capability admission in the app.

[Final affected server checks](https://github.com/StradaverseHub/ai-hr/actions/runs/41336934461) passed 232 tests across six files and whole TypeScript. The original complete gate finished with failures; original job identities/logs are retained. The source-binding refresh was explicitly approved for the same 24 active AI input contracts, with two pending contracts unchanged. This did not authorize production deployment.

The published recovery verifier does not admit documentation and test-fixture repairs. A user choice is pending between one complete final gate exception and extending independently validated recovery. Focused checks alone do not authorize release. Installed expanded-form acceptance can follow a verified staging release.

## Required before phone and store acceptance

| Check | Remaining evidence |
| --- | --- |
| Android simulator | Install the exact final artifact after package/certificate verification; synthetic sign-in; compact/large layout, hardware Back, widgets and notification refusal states. |
| Expanded approvals | Verified server arrival and synthetic native workspace read/validation for every kind; approved disposable decision fixtures through the installed app. No decisions on real employee cases. |
| Push | Firebase owner/project and Android registration remain deferred. Verify matching backend sender, production identifiers/signing, token rotation, permission denied/recovery, foreground/background/killed delivery, safe taps and sign-out isolation on both phones. |
| Attendance hardware | Real GPS accuracy/geofence boundaries, denied/revoked permissions, camera/photo handling, network loss, interruption, process death, same-reference recovery and registered/revoked device behavior. |
| Device security | Biometrics/passcode, protected storage and keys, backup/restore, screen/recents protection, App Attest/Play Integrity and production trust provisioning on actual devices. Simulator behavior is insufficient. |
| Adaptation/accessibility | Compact and large supported iPhones/Androids, landscape where supported, larger text, VoiceOver/TalkBack, keyboard obstruction, localization and slower-device motion/performance. |
| Store release | Final production package IDs/signing/trust, privacy disclosures, review account, screenshots, permissions and store metadata; separate owner authorization for publication. |

No claim of zero bugs, absence of every security vulnerability or resistance to every attacker follows from these checks.
