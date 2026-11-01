---
version: 1
slug: "mobile-app-sign-in-tsx"
primary_target: "mobile/app/sign-in.tsx"
related_targets: ["mobile/lib/ui.tsx","mobile/lib/design.tsx","mobile/lib/home-hero.tsx","mobile/lib/clock-panel.tsx","mobile/app/settings.tsx"]
---

# OneHR+ mobile redesign

Mode: Operate. Platform: adaptive (iOS and Android). Scope: all mobile routes, public setup/sign-in, lock, home, attendance, requests, inbox, profile and settings. Existing features, authorization, tenant configuration, language/appearance choices, MFA, recovery and attendance rules remain functional.

## Direction contract

THESIS: OneHR+ makes everyday employee tasks clear and calm. The user pins Opal as the visual reference for the whole app, specifically its Timer for attendance.

OWN-WORLD: Two complete surfaces: near-black/charcoal with mint and white, and cool off-white/white with deep green ink. Native system type, rounded grouped rows, broad pill actions and capsule navigation. Preserve explicit company branding and configured content.

STORY: Employees see their verified status, read what needs attention, and finish the existing authorized journey. Errors and pending submissions stay visible and recoverable.

FIRST VIEWPORT: Attendance leads with status, a prominent readable worked-time display, shift/date context, then one wide check-in or check-out action. Sign-in has a centered heading, workplace context and comfortably spaced native fields. Every screen works in both surfaces and at small/large phone sizes with text scaling and keyboard access.

FORM: User-pinned Opal reference supersedes the sign-in-only concept cards. Code-led native build. Prior exploration seed:030ca62687af43f0. References: https://mobbin.com/screens/649f9e92-3d9e-421f-8346-610bcbecd27d and the user-provided Opal app collection.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Acceptance

After redesign, complete functional, responsive, notification and security review. Record exact builds and observed results. Exercise access boundaries, expired/revoked sessions, sensitive storage and logs, network trust, deep links and offline recovery. Physical-device checks follow simulators. No claim of zero bugs or immunity from attacks; unresolved risks block readiness as appropriate.
