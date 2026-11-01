---
version: 1
slug: "mobile-app-sign-in-tsx"
primary_target: "mobile/app/sign-in.tsx"
related_targets: ["mobile/lib/ui.tsx","mobile/lib/design.tsx","mobile/lib/home-hero.tsx","mobile/lib/clock-panel.tsx","mobile/app/settings.tsx","components/mobile-preview/mobile-builder.tsx"]
---

# OneHR+ mobile redesign

Mode: Operate. Platform: adaptive (iOS and Android). Scope: all mobile routes, public setup/sign-in, lock, home, attendance, requests, inbox, profile and settings. Existing features, authorization, tenant configuration, language/appearance choices, MFA, recovery and attendance rules remain functional.

## Direction contract

THESIS: OneHR+ makes everyday employee tasks clear and calm. The user pins Opal as the visual reference for the whole app, specifically its Timer for attendance.

OWN-WORLD: Two complete surfaces: near-black/charcoal with mint and white, and cool off-white/white with deep green ink. Layered workplace/city photography is the default in both appearances. Native system type with regular/medium weights, compact LCD attendance numerals, translucent edge-lit materials, illuminated pill actions, image-led snapping horizontal carousels and a smaller floating capsule navigation. Opal is a structural and material reference, not a palette-only reference. Preserve explicit company branding and configured content.

STORY: Employees see their verified status, read what needs attention, and finish the existing authorized journey. Errors and pending submissions stay visible and recoverable.

FIRST VIEWPORT: Attendance leads with status, a prominent readable worked-time display, shift/date context, then one wide check-in or check-out action. Sign-in has a centered heading, workplace context and comfortably spaced native fields. Every screen works in both surfaces and at small/large phone sizes with text scaling and keyboard access.

FORM: User-pinned Opal reference supersedes the sign-in-only concept cards. Code-led native build. Prior exploration seed:030ca62687af43f0. References: https://mobbin.com/screens/649f9e92-3d9e-421f-8346-610bcbecd27d and the user-provided Opal app collection.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Acceptance

After redesign, complete functional, responsive, notification and security review. Record exact builds and observed results. Exercise access boundaries, expired/revoked sessions, sensitive storage and logs, network trust, deep links and offline recovery. Physical-device checks follow simulators. No claim of zero bugs or immunity from attacks; unresolved risks block readiness as appropriate.

## Confirmed background direction

The owner selected Workplace & city as the shared default on 1 November. Chin Hin / 8th & Stellar is customer-specific artwork; the revised concept adds foreground framing, reflections and atmospheric depth. Original natural and AI options remain unchosen explorations.

Extend the tenant-wide Mobile App builder with separate dark/light uploads, preview, explicit save/publish, rollback and return-to-default. Images are normalized JPEGs in immutable tenant-owned storage, referenced by id in small design snapshots. Drafts remain admin-private. Bearer responses deliver only published own-tenant artwork to capable clients; older clients receive a compatible projection. Pre-sign-in and locked screens retain the shared default and no tenant artwork is persisted across account changes.

Backend and installed app support are required before customer artwork can reach production phones. This task does not publish a production design or deploy a backend.

## Structural revision requested by owner

The owner rejected the first native render as a wallpaper/palette reskin. Revamp Home, Clock, Leave, Approvals and Me layouts, with the same language on details and forms. Compare cards, opacity, background fade, typography/weights, transparency, carousel motion and navigation proportions element by element against Opal. The compact timer keeps actual HR worked-time semantics rather than substituting a countdown. Leave preserves every balance/masked/shared-pool value and request workflow. Approvals preserve explicit human decisions, details, assignment, rejection reasons, concurrency and receipt replay. The owner additionally requests that every approval task type be actionable on mobile; inventory canonical owners and implement full workflow forms instead of relabelling web links as native support.

References retrieved from Mobbin: Home `1b3deee1-a193-4e36-93b0-7e89740f9c5c`, Timer `649f9e92-3d9e-421f-8346-610bcbecd27d`, carousel `78d2246d-f084-475c-8296-1a041feb9bb6`. First independent reviewer returned **recapture**: missing Android, light and compact device evidence. This is not approval and requires a full re-review with valid captures.

## Owner-approved Daily Switch revision — 2 November 2026

The owner approved the Daily Switch mockup/wireframe package and instructed implementation.
This supersedes the prior default Opal/city layout for schema-1 screens. Use porcelain and
graphite surfaces, a chartreuse physical IN key, dark LCD worked-time display, and five
floating destinations: Home, Clock, Leave, Approvals, Me. Home prepares, reviews and
recovers the shared attendance journey directly; canonical services still record attendance.
All supported approval kinds and published schema-2 tenant compositions remain available.
No unsupported AI input is added.

Sign-in uses the original paired Opal mountain backgrounds (historic commit bc1cd8887),
restored explicitly by the owner. The Access Pass groups username and password in a single
panel, with one submit arrow, adjacent recovery, and workplace switching in the header.
MFA, enrollment and recovery-code acknowledgement retain their existing state machine.
The local approved package is /private/tmp/onehr-design-review-20261101/daily-switch-v1;
its raster boards are design references, not native runtime evidence.

Native visual acceptance remains pending until this exact candidate is rendered on iOS
and Android. Hosted compiler/bundle and behavior checks establish separate claims.

## Approved mountain Access Pass mockup

Owner approved the light/dark mountain sign-in board on 2 November 2026 and instructed
application to the app. Reference: generated_images/01a19772-0d38-76f1-a1cf-a9141aff5daa/
exec-e8d3220a-6b70-4676-8795-0485adf1f1a4.png (local design reference, not native evidence).
Use a full-bleed original mountain background, colored plus in the OneHR+ wordmark,
plain workplace control with a downward chevron, regular-weight 48-point Sign in heading,
opaque Access Pass, underlined password recovery, and chartreuse circular submit arrow.
Example organization and credentials in the board remain illustrative only; live fields
continue to show actual workplace context and the user's own input.
