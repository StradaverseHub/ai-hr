---
version: 1
slug: app-login-page-tsx
primary_target: app/login/page.tsx
related_targets: [app/login/internal-form.tsx, app/login/login-shell.tsx, app/login/login.css]
---
# Login
Visitor mode: Operate. The owner supplied a split-screen reference on 25 October 2026.
Use its structure with AIHR's real authentication, rather than adopting its OneHR identity or feature claims.

## Direction contract
THESIS: A branded welcome beside a focused sign-in form, with system-configured public media.
OWN-WORLD: Deep indigo welcome panel, white form panel, system sans, 12px input corners, clear focus rings. Authentication is readable in every app theme.
STORY: Read the welcome, identify the correct organization and account, sign in, and complete existing password/MFA steps when required.
FIRST VIEWPORT: On desktop, an approximately equal split: brand and welcome at the upper left, media below, a vertically centred 440px form on the right. On phones the compact brand precedes the full-width form and the large media panel is hidden.
FORM: The owner's supplied split composition, implemented in code; no concept selection is needed for this precise request. seed: none (user-specified structure).
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Boundaries
Preserve login, MFA, invitations, recovery, safe redirects and demo chooser semantics. No authentication rules change. Saved theme choices survive; Atelier is the default only when no supported choice exists. Media is public presentation data and has no access to employee data.

## Finish review resolution
The shipped finish review found no material visual defects. Its seed-format gate conflicts with the applicable new-work.md §3 exemption: “Never run the script for a local extension or a precisely specified narrow request; shape those directly.” This user-supplied composition uses that exemption. No concept roll ran; the FORM entry records that fact rather than asserting unavailable roll evidence. The governing exemption resolves this process-only finding without changing the approved composition. The shipped default icon is a code-authored AI monogram; the unchanged legacy ICO remains available under its former URL.
