# OneHR+ mobile — Field Notes

Approved direction, 7 November 2026. Employee work and manager approvals have equal prominence. This specification applies to the native mobile app. The web workspace has its own design system.

## Material and typography

White and near-black reading surfaces, open ruled groups and rectangular controls establish the hierarchy. Manrope provides body, controls and bold display headings. Newsreader provides the editorial section voice. Both fonts are bundled with their SIL Open Font Licenses.

The default light palette uses white, ink #111111, secondary text #555555 and rules #8a8a8a. The default dark palette uses #101010, ivory #f5f3ef, secondary text #bcbab6 and rules #686868. Primary buttons use #d92d20 with white labels. Links and selection use #c62716 in light and #ff7561 in dark. Status always includes text. Errors include an announced explanation and a recovery action.

The baseline uses 20–24 point insets, 44–48 point minimum actions, 40 point main titles with 41 point leading, 30 point detail titles with 34 point leading, 27 point section titles and 14–18 point reading text. Text scales with system accessibility settings. Titles and forms scroll with content. Public headers stay outside the scrolling form, clear of the status bar and keyboard; the forms adjust to the keyboard.

## Screen vocabulary

- Home combines the existing clock journey in a compact workday strip with a bounded preview from the authorized approval queue. A red calendar marker sits beside the greeting. Unsent clock preparations use one compact review notice; uncertain submissions retain their receipt/retry controls. The Clock screen collapses restored, unsent preparation metadata behind an expandable Saved clock attempt control; actual refusal messages and active submission recovery remain visible.
- Leave previews three server-provided balances in an open list with an All balances expansion, including masked figures, taken-only types and shared-pool labels. Requesting leave always receives the complete set of eligible types. Request drafting, attachments and history retain their existing owners.
- Approvals uses ruled request rows and opens the original full decision journey, including reason requirements, confirmation, stale-step handling and retry identity.
- Me groups existing employee and team destinations and preserves employment switching and payroll visibility.
- Detail screens, settings and forms use the shared typography, ruled surfaces and rectangular controls. The authenticated header and navigation remain in the shared shell.
- The default shared header contains the wordmark, Inbox, an initials fallback for Me, and the active company. Dense ruled groups and tight display leading follow the approved Field Notes reference. No illustrative people, balances or approval counts are substituted for server data.
- Public screens share a wordmark and light/dark controls. Workplace verification, first-password change, MFA setup, verification and recovery-code handling use their existing controllers.
- Password reset is reached through the existing server-hosted reset page. Its browser presentation is a separate surface.
- Device unlock continues to invoke the operating system's credential prompt through the existing session controller.
- Widgets use the default neutral/red palette and retain their existing snapshot and launch contracts.

## Company configuration

Published schema-2 compositions retain their configured layout, navigation, fonts and palettes. Default native screens use Field Notes. Explicit company accent choices remain supported. Logo and workplace selection continue to come from the existing presentation and connection owners.

## Verification

Profile and design display snapshots may be reused for 30 seconds inside one unlocked private tree. They remain in memory only, use the complete account/connection/locale/parameter key, bypass reuse on explicit refresh, and are cleared when that tree closes. Attendance, decision details and command eligibility always use their existing fresh server readers. First focus does not duplicate a screen's initial read; returning to a screen still refreshes it.

Hosted native type checking, production bundles, regression journeys and simulator rendering establish separate claims. Physical-device biometric, attachment, attendance and widget checks remain part of device acceptance. Firebase setup is deferred by the owner.
