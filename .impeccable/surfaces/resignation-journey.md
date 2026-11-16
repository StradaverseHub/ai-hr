---
version: 1
slug: resignation-journey
primary_target: components/resignation/employee.tsx
related_targets: [components/resignation/case-card.tsx, components/resignation/task-panel.tsx, components/resignation/letter-card.tsx, app/configuration, app/lifecycle/resignations, app/lifecycle/offboarding/postings]
---

# Shared Configuration and resignation journey

Visitor mode: Operate. The owner approved page-by-page merge mockups based on the two supplied Resignation Journey HTML files, then authorized implementation. Their navigation, interactions and business rules govern this extension. No replacement visual direction is proposed.

## Direction contract

THESIS: Keep configuration shared and the resignation understandable as one case, with clear responsibility, next action and history.

OWN-WORLD: Extend the current AIHR Atelier operational shell and shared components. Use the incumbent sans typography, white surfaces, quiet neutral boundaries and orange primary actions recorded in DESIGN.md. Preserve visible status labels and distinguish action authority from FYI participation. The earlier lifecycle-v9 brief's indigo world is historical context, not this approved merge mockup's palette.

STORY: Administrators configure Workflows, Templates (documents and emails), Assignment groups and Routing rules in one HR Automation configuration area with a module selector. Employees submit and track their case. Managers accept or propose retention; BP sees the assigned FYI view. GBS reviews letters, CEO signs retention and BP signs acceptance; the employee's final retention signature accepts the offer. Offboarding clearance proposes a Personnel posting for human approval before the canonical termination writer acts.

FIRST VIEWPORT: Preserve the app shell, breadcrumbs and contextual company scope. Make the page title, relevant filters and pending responsibility legible before detailed content. Manager decisions show submitted facts and supporting letter, followed by accept/retention choices and current versus proposed terms. Employee tracking explains the current stage and the actual next action. Missing workflow setup records the resignation and exposes a specific HR repair action.

FORM: User-pinned interactive HTML and approved AIHR merge mockups. No generated alternate direction. Follow the final handoff where behavior differs from the illustrative prototype; the ADR records resolved integration choices.

SIGNATURE INTERACTION: A case advances through configured responsibility without exposing a private future letter or inventing a completed action. Draft retention, owner correction/recall, GBS/CEO/BP signing, employee acceptance/decline and released snapshots remain distinct. Retry failed runs and repair an unassigned decision are separate controls.

RESPONSIVE: At desktop size preserve compact tables and the app navigation. At phone width stack decision terms and controls, retain clear field labels and reachable primary actions, and avoid page-level horizontal overflow. Shared editors must remain usable at the inspected mobile viewport.

## Evidence and finish boundary

The approved artifact is the page-by-page `resignation-review/product-mockup.html` with its walkthrough screenshots, reviewed before implementation. Those screenshots are mockups, not built-app evidence. Hosted production-renderer captures of the real employee, manager, BP/CEO/GBS, Configuration and posting pages establish the implemented view. Desktop and mobile are reviewed together. Behavioral, security and scale evidence is separate from the visual verdict.

Finish requires a fresh independent finish review and the ordinary-extension documentation comparison. Preserve DESIGN.md and its sidecar; report pre-existing drift without repairing it. No new raster asset is required. Release is held pending the owner's explicit approval.

Naming clarification: the cross-session coordinator verified the owner’s explicit “Use HR Automation”
name and Resignation’s one-shared-configuration approval. The top-level label is HR Automation;
the approved mockup’s Configuration label describes the same area. No second configuration area is added.
