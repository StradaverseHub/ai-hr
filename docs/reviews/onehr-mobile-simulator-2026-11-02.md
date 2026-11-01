# OneHR+ simulator review — 2 November 2026

Status: review in progress; not a store, production or whole-platform acceptance record.

## Source and installed artifact

- Reviewed shared-shell candidate: `06c5c634b281ca6598fb5cb0cfd65c4ee4513705`, version 1.0.3, build 9.
- Independent iOS finish review requires an explicit Clock in/Clock out label above each small widget time. Source correction `275936c2581217096277255d9859d6081657b28c` changes only iOS widgets and the iOS build number to 10. Android runtime source and version 9 stay unchanged. The corrected iOS build is installed and the reviewer scored the label fix resolved; see the scoped finish record below.
- iPhone 17 Pro / iOS 26.5 simulator: EAS `e0e79c5a-04ee-42e7-ba17-4feea1368828`; installed executable and JavaScript match the downloaded artifact. The upload archive contained 245 exact tracked public files, no private or untracked files.
- Android build 9: EAS `3b98b255-fe08-4823-ba3b-297fc4e47e2c`; installed after matching package/version/certificate verification. Public launcher rendering exposed a cached night-mode secondary-button contrast defect. Correction `cd98f8b68cc279d6438574c1109adbb95569429c` keeps action colors in XML resources and switches visible button roles, preserving immutable deep links; Android build 10 compilation and recapture remain pending. The emulator intentionally has no screen lock; normal protected-session restoration cannot be claimed there.
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

The published recovery verifier does not admit documentation and test-fixture repairs. The owner explicitly approved one complete final gate exception: [41340260446](https://github.com/StradaverseHub/ai-hr/actions/runs/41340260446) is running on the frozen server candidate. Ticket `aea2025e-43aa-435f-8f33-d3859f17225a` is queued without claiming the active epoch-21 lease. Focused checks alone do not authorize release. Installed expanded-form acceptance can follow a verified staging release.

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


## iOS extension finish and incumbent-system comparison

This subsection supersedes the earlier pending iOS widget verdict only. The reviewed installed iOS source is `20509dd337bd3d83ee435968edf4fa8b5be9cd68`, build 10, EAS `26320e6b-2dfd-47ee-a951-bb4b5697bcbd`; executable and JavaScript hashes match the artifact. Shared shell/motion source remains `06c5c634b281ca6598fb5cb0cfd65c4ee4513705` from build 9. The independent iOS finish reviewer accepted persistent framing, unobstructed form/approval actions and motion; the sole requested correction, explicit Clock in/Clock out labels above small-widget times, is resolved in both appearances. Final scoped disposition: **ship the reviewed iOS extension**. This is not store, production, Android or expanded-server acceptance.

Evidence is the valid `.impeccable/review/combined-9-` captures: `home-ios-dark.png`, `clock-ios-dark.png`, `leave-ios-dark.png`, `me-ios-dark.png`, `profile-ios-dark.png`, `approvals-ios-dark.png`, `approval-detail-ios-dark.png`, `pending-empty-ios-light.png`, `leave-ios-light.png` and `leave-form-ios-light.png`; corrected widgets are `combined-10-widgets-ios-light.png` and `combined-10-widgets-ios-dark.png`. The dark widget capture SHA-256 is `366b5102a361b43ea47e0c7291b2989e3d8ffe63cd101c1af53cdc32dc7bb678`. The widgets read the existing accepted synthetic IN 02:40 / OUT 02:43 history; no additional punches were required.

Compared with `PRODUCT.md`, `DESIGN.md`, `.impeccable/design.json` and the superseding approved Daily Switch surface brief, this is an ordinary operational extension. Root design files remain unchanged. Source sampling covered `mobile/lib/{app-shell,daily-navigation,tenant-navigation,motion,attendance-widgets.ios}.tsx`, `daily-switch-theme.ts` and `widget-snapshot.ts`.

- **Palette:** Daily Switch preserves porcelain/graphite, chartreuse key face (`#c7f51c`), key ink (`#111600`) and dark LCD (`#101313`). The widget alone uses mint gradients: light `#D7EFE3` → `#F6FAF3`, dark `#24483C` → `#0B1D17`; ink is `#102E25` / `#F1FFF8`, metadata `#416557` / `#B3D0C3`, action mint `#A6F2D5`. These are scoped widget values, not replacements for native or web accents.
- **Type:** Incumbent native title/body/field roles remain 28/15/19 points; navigation uses 11-point labels. Widgets use light 28-point times, 13–14-point semibold actions and 9–11-point metadata/labels. Native system type remains local to native controls and data; this pass adds no system display-face rule.
- **Frame and shape:** The five labeled destinations retain the 27-point capsule, 5-point inset, 52-point tab minimum and 560-point cap. The signed-in frame keeps header/navigation in normal flow so form actions end above the dock. Lock, setup and sign-in remain outside that frame. Published schema-2 top navigation retains its own renderer above content; the owner-required global DailyNavigation supplies the bottom destinations when the published layout has no bottom bar. This is additive shell behavior; installed schema-2 tenant acceptance is not claimed.
- **Motion:** Press feedback transforms the child for 120ms using `cubic-bezier(.23,1,.32,1)` while the command hit target stays stationary. Carousel focus uses the UI runtime with at most .98 scale and 2-point displacement; Reduce Motion restores spatial identity and removes transition duration. This records implementation and scoped reviewer acceptance, not slower-device performance verification.
- **Named rules:** The Published Theme Rule and scoped native palette remain incumbent constraints; the web Scoped Accent and Flat Surface rules stay within their existing scopes. Flat mint-gradient native widget cards, explicit timestamp labels and dated refresh metadata support reading confirmed snapshots. Snapshots expire after at most 15 minutes; links open the existing clock journey rather than recording attendance from the widget.

Hosted affected checks are separate evidence: [widget checks](https://github.com/StradaverseHub/ai-hr/actions/runs/41339977904) passed 21 tests in three files, native TypeScript and exports; [navigation checks](https://github.com/StradaverseHub/ai-hr/actions/runs/41338755564) passed 19 tests in two files. No application tests, type checks or builds were run locally for this documentation pass. Native detector tooling was not used. VoiceOver, larger text, physical phones and performance remain unclaimed; Android review is independent and pending.

Not canonized or repaired: the carried generic primary-button hard shadow, PRODUCT.md's older indigo/floating-shell language, root documentation's source-only acceptance wording and old overlay-clearance description remain pre-existing drift. These are reported without changing incumbent rules or repairing application code in this documentation-only scope.
