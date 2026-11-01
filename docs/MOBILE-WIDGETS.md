# OneHR+ attendance widgets

Owner request: clock-in and clock-out widgets for iPhone and Android. Implemented source is a review candidate; native build and simulator acceptance are required before distribution.

The widgets launch the existing full attendance journey with a suggested direction. They do not record a punch, obtain location, take a photograph, call an API or manufacture a command. Authentication, workplace/employment selection, app locking, saved-command recovery, device signing, location/photo policy and explicit attendance confirmation remain with their existing owners.

- iPhone: separate small Clock in / Clock out widgets, corresponding circular Lock Screen shortcuts, and one medium widget containing both links. Expo Widgets and Expo UI use the existing SDK 57 line; widget push is disabled.
- Android: an AppWidgetProvider with two explicit, immutable PendingIntents to the app's own launch component. The receiver is not exported; periodic background updates are disabled. Its resources support light/dark appearance and the six existing locales.
- Only public labels enter the iPhone shared widget container. Tokens, people, workplace names, attendance state/times and pending requests never enter widget properties or Android RemoteViews.
- Deep links admit only `aihr://clock?action=in` or `action=out`. Other fields, duplicate directions, credentials, fragments and foreign schemes/hosts are refused as widget hints.
- A direction can wait in memory for authentication for at most five minutes. It is consumed once, bound to the current workplace and to a known employment, and discarded on mismatch or clock reversal. It is not persisted across process death.
- A hint never replaces a prepared, submitted, uncertain or otherwise recoverable attendance request.

Verification must distinguish pure/DOM checks, successful native compilation, installed simulator behavior and physical phones. Pending acceptance includes gallery discovery, each size and dark/light mode, real taps from cold/warm/locked/signed-out states, account/workplace changes, pending-punch recovery, large text and screen readers. Physical phones still need biometrics, location accuracy/denial, camera, signed-device checks and process/background behavior. Firebase and real Android push remain deferred separately.

The widget dependency installation also prompted a dependency audit. A compatible node-forge patch was applied. The remaining high advisory is the Expo CLI's build-time Zod 3 dependency; the app's direct validator is already Zod 4.6.7. Do not force a major SDK/CLI replacement or call the whole dependency tree clean without verifying compatibility and actual bundle reachability.
