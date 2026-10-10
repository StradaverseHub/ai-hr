# ADR-0097: One store app, tenant-owned presentation

Status: Accepted by owner, 2026-10-10. Implementation and release verification are recorded in the round history.

## Context and decision

The owner approved evolving Mobile App Preview into a tenant-specific builder. Customers use one
shared iOS app and one shared Android app. Signing in resolves tenant identity; a customer does not
download a separate binary. Store listing, app name and launcher identity remain platform-owned.

`lib/mobile-design.ts` owns the versioned, platform-independent presentation contract. It accepts
only approved component variants, a short brand name, a bounded raster logo, contrast-checked accent
presets, theme, motion, surface shape and permutations of known home/navigation items. It accepts no
code, CSS, remote asset URL, business rule, entitlement or permission. Home and Me stay anchored;
unavailable modules remain gated by the existing system. All eligible leave types remain visible,
including masked figures and shared-pool notices. Personal accessibility settings and OS reduced
motion take precedence over tenant animation defaults.

## Authoritative owner and isolation

The design has a lifecycle distinct from scalar tenant settings: mutable admin-private draft,
append-only published releases, and explicit restoration by publishing another snapshot. These facts
belong to `mobile_design_draft` and `mobile_design_release`, not both those tables and `tenant_setting`.
The highest published revision is the current release. There is no independently mutable live flag.

Draft reads and every write require a group administrator, mirroring `app.is_group_admin()`. A
company-only administrator cannot change the whole tenant. Every table is tenant-bound under RLS;
the app role has no UPDATE or DELETE privilege on releases. Actor checks and database timestamps
protect provenance. Draft writes lock their tenant row and compare the caller's expected revision;
publish and rollback share that lock and advance the revision. Stale commands fail rather than
overwriting another editor. Each mutation appends an actor-attributed domain event. Published
snapshots preserve the exact design; restoration never rewrites a historical snapshot.

The bearer-only `/api/mobile/v1/design` endpoint returns the current authenticated tenant's published
design with `Cache-Control: no-store`. It ignores caller-supplied tenant identifiers and never returns
a draft. Web sessions and mobile bearer sessions remain separate authenticated front doors.
No cross-tenant cache or durable native design cache is introduced. Native design state is bounded
by the existing authenticated visibility gate and request generation; signing out or locking unmounts
it. Refresh and returning to the foreground re-read publication.

## Builder and native delivery

`/mobile-preview` is the builder for group administrators and the published live experience for
other signed-in viewers. Admins deliberately open `?live=1` to use real clocking. Draft and published
design previews use the viewer's authorized records but never invoke clocking, camera, GPS or HR
submission. They demonstrate gestures with explicit preview copy. Publishing changes presentation
only; there is no attendance, leave or approval command in the publication service.

The web renderer consumes the same contract as the Expo client. The native foundation consumes
branding, light/dark tokens, surface shape, available home-section order, leave ledger/list and
available navigation order. The subsequent native-monolith-online delivery implements online
attendance, team availability and leave submission under ADR-0088; its verified API additions are
deployed at f1ef95d3. The native controls have rendered interaction tests and successful Hermes
exports; physical-device rendering and pixel parity remain unverified. New native component
capabilities need a compatible binary release. Supported configuration changes need no
customer-specific app download. No store upload has been performed. Signed distribution and the
physical-device matrix remain required before a customer pilot.

## Alternatives and consequences

Separate per-customer binaries multiply release and maintenance work without improving isolation.
An arbitrary canvas/code editor admits unsupported layouts and executable content. A single mutable
JSON setting cannot provide private drafts, immutable releases and reliable rollback. The curated,
versioned design contract gives customers useful control with a supportable shared application.

Version 1 clients reject unknown shapes and fall back to Monolith defaults. Add future schema versions
alongside old supported versions, or negotiate capabilities, rather than silently breaking an older
store-installed client. Raster logos are bounded inline PNG assets within each tenant's configuration;
no shared public upload namespace or third-party image requests are needed in this first delivery.

Native installation audit also reports the pre-existing upstream `braces` and `node-forge` advisories
(GHSA-vfj7-8cjw-p6xm / GHSA-86w9-cpqp-85rv; no patched versions listed when checked). Their packages
are unchanged by adding `expo-system-ui`. This round does not claim the native toolchain is free of
vulnerabilities; remediation and device/distribution verification remain required before a store release.
