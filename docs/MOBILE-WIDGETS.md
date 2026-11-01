# OneHR+ attendance widgets

The owner requested iPhone/Android clock-in and clock-out widgets, then confirmed status and times in the redesign. The combined candidate includes the Daily Switch / mountain Access Pass UI contribution at e9d67c7fb and the earlier widget resolver repair at ef5c3e10f. Firebase setup remains deferred. Native installation acceptance is distinct from these source changes.

Widgets only launch the full attendance journey with a suggested direction. They never record a punch, obtain location, take a photograph, prepare or submit a command. Authentication, employment selection, saved-command recovery, device signing, location/photo policy and explicit confirmation remain with their existing owners. The default Home also retains explicit review and recovery after the UI merge.

## Presentation and freshness

- iPhone: separate small Clock in / Clock out widgets, corresponding public circular Lock Screen shortcuts, and one medium widget with both controls. The redesigned Home Screen widgets have a forest/mint tonal surface, strong time hierarchy, separate actions and light/dark variants. SDK 57 is retained; widget push is disabled.
- Android: a native AppWidgetProvider with two explicit, immutable PendingIntents to the app's own launch component. The receiver is not exported. Native resources support light/dark and the six existing languages. No network or periodic background fetch belongs to the provider.
- The app's visible, authenticated observer reads the existing authorized clock endpoint for the selected employment, on unlock/selection, after the clock/roster refresh signal, and once per minute while visible. It uses the shared read coordinator and an abortable request. A late answer is rejected after lock, revocation, account/connection change or employment switch.
- Only a narrow display projection enters widget storage: confirmed in/out status, business date, last clock times, last-confirmed time and expiry. No name, tenant, employment ID, request ID, token, location, photo or policy enters native widget properties/preferences. Pending and offline commands never become widget truth.
- The existing clock endpoint owns the Malaysia HR business day; times use that same UTC+8 clock and are explicitly labeled MYT. Overnight open visits keep their canonical open instant. Missing receipts show a dash. After a completed visit, times are paired from ordered same-business-date server receipts; a new open visit does not display a previous clock-out beside it.
- Every populated widget shows the source date and last-updated time. Snapshots expire no later than 15 minutes after the server answer. iOS schedules an empty timeline entry; Android sets an inexact native expiry alarm and rechecks freshness on every render. OS refresh can be delayed, so the dated snapshot must never be described as a live status or ticking elapsed timer. Expired/missing snapshots say to open the app to refresh.
- The iOS attendance fields are marked privacy-sensitive; circular Lock Screen shortcuts share no attendance fields. Android widgets are Home Screen only. Android display preferences are app-private, backup is disabled, and expiry removes stored attendance fields. Logout, launch initialization and actual employment/connection changes clear snapshots. Widget failures cannot block login or attendance.

## Launch scope

Deep links admit only `aihr://clock?action=in` or `action=out`. Other fields, duplicate directions, credentials, fragments and foreign schemes/hosts are refused. A direction may wait in memory for authentication for at most five minutes. It is consumed once, bound to the workplace and known employment, and discarded on mismatch or clock reversal. It is not persisted across process death. A hint never replaces a prepared, submitted, uncertain or recoverable attendance request.

## Evidence and remaining acceptance

At ef5c3e10f, the original white-widget defect was fixed by matching generic and iOS source extensions. The actual pinned small Clock in widget rendered on the iPhone 17 Pro simulator; the prior generic .ts file had shadowed the .ios.tsx renderer. Real Metro resolution is now checked in hosted typecheck/build installation hooks, including a regression self-test. This acceptance belongs to the renderer repair, not the later status/time redesign.

The combined redesign still requires successful hosted checks, native compilation, installed render/tap acceptance on both review simulators and physical-phone checks. Include unavailable/stale states, dark/light, compact sizes, text scaling, screen readers, cold/warm/locked/signed-out launches, switch/logout clearing and pending-punch recovery. Real phones additionally need actual biometrics, location accuracy/denial, camera, device checks and process/background behavior. Firebase and real Android push remain deferred.

A compatible node-forge patch was applied during dependency review. The remaining high advisory concerns the Expo CLI's build-time Zod 3 dependency; the app's direct validator is already Zod 4.6.7. Do not force a major SDK/CLI replacement or call the whole tree clean without compatibility and bundle-reachability evidence.
