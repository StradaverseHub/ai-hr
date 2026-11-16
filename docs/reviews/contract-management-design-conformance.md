# Contract Management design conformance

This compares the finished ordinary Contract extension with the incumbent AIHR/V9 system. It creates no visual world and authorizes no integration, installation or release. Global DESIGN.md, .impeccable/design.json, config, the surface brief and production files were not edited by this pass.

## Overview

The extension inherits V9 controls within the selected AIHR theme. The tracker leads with filters, actual Personnel contract periods, status and next owner; details explain source facts and the decision before commitment. Assigned approval and letter portals place the task beside routing/history. This follows the Contract surface contract's THESIS, STORY and FIRST VIEWPORT without introducing display decoration.

Checked: PRODUCT.md, DESIGN.md, .impeccable/design.json, .impeccable/surfaces/contract-shared-management.md, Impeccable document/new-work/operate references; app/lifecycle/contracts/{page.tsx,shared-tracker.tsx,shared-case-ui.tsx,shared-contract.css,signature.tsx}, [caseId]/shared-detail.tsx, approvals/[approvalId]/review.tsx, letters/[letterId]/review.tsx, settings/{page.tsx,shared-settings.tsx}, periods/[employmentId]/page.tsx, postings/page.tsx, app/lifecycle/v9/workspace.css and app/atelier.css. This samples shared patterns, not every component or authorization path.

## Colors

V9 binds --v9-accent to --primary, --v9-line to --border and --v9-muted to --muted-foreground. Surfaces, foreground and inputs also use native semantic variables. Captured Atelier light uses white (#ffffff), ink (#1c1c1f), fire-orange primary (#c2410c), hairline (#e8e8eb) and muted text (#5f5f67). No replacement primary palette is added. Status has explicit text; the Contract status pill is a neutral outline.

Incumbent named rules retained: the Scoped Accent Rule through the selected native theme; the Flat Surface Rule for panels. Legacy local fallback values in Contract CSS are not new global tokens.

## Typography

V9 uses var(--font-jakarta),system-ui,sans-serif. Atelier maps that variable to the platform UI stack, confirmed by capture metadata. Observed V9 ramp: page heading 26px/600/−.02em, reducing to 22px below 760px; panel heading 16px/600; body 14px with 1.5 leading; buttons 13px/600; field labels 12.5px/600; Contract fact/status labels 12px. Native theme rules can further style table headings. These observations do not replace global frontmatter.

## Layout

Shared details/portals use a flexible main column plus 280px aside and 16px gap. Facts have two equal columns and 16px gaps. Below 800px both become one column; the aside follows the task, and Renew/Convert/End stack with wrapping labels and a 44px minimum. V9 panels use 20px padding, reducing to 16px below 760px; stacks use 16px gaps. The letter portal caps at 1120px and bounds the existing document to its container with 16px mobile padding. Native table containers scroll; Contract tables retain a 780px mobile minimum. Captures show their initial left scroll position.

The tracker distinguishes actual current Personnel facts from approved scheduled next-period facts. Dates display day/month/year; ISO persistence and the shared business-date owner remain separate concerns.

## Elevation & Depth

Panels and routing rails use tone and hairlines without new shadows. Existing V9 overlay shadows remain in their established roles. No value is recorded to excuse a render defect.

## Shapes

Existing V9 panels use min(16px,var(--radius)); controls use min(8px,var(--radius)); Atelier radius is 12px. Status pills use 999px. Routing uses thin row divisions and stroke SVG icons. No new shipping app raster assets or image generation are introduced; screenshots and their provenance JSON are evidence artifacts.

## Components

- Tracker/navigation: shared native labels, selects, table, pager and V9 buttons. One component links Contract cases, Personnel postings, Settings/access and HR Automation. Selection follows the pathname.
- Decision/feedback: protected facts precede Renew/Convert/End; asynchronous preview exposes blockers, warnings and actual workflow before submission. Existing alert/status announcements and busy/disabled controls express request state. Mobile stacking repairs clipped decision labels.
- Approval/letter: existing ContractPanel, DocumentBody and ContractSignature are reused. Wording plus Review/Approve is coordinated; correction/resend remains separate. Typed/drawn signing requires valid input and consent. Unsupported Form response/signing is visibly held. Rendering a signing fixture does not prove persistence.
- Ownership/access: HR Automation owns shared Workflows, Templates and Assignment groups. Contract settings own business grants, fallback/posting groups and stalled-case/default configuration. Tenant-wide Manage access or system Access administrator authority gates role administration; company settings authority is distinct. Assigned portals are distinct from Case View. Current salary has separate permission and is absent from the tracker. Personnel owns employment facts; Payroll entry/attestation and People Ops termination remain manual.

## Do's and Don'ts

The extension preserves native theme binding, shared controls/panels, explicit status and ownership text, visible focus and structural mobile collapse. It introduces no system-wide prohibition from a local composition choice.

Not canonized or repaired: DESIGN.md's older V9 paragraph still names fixed indigo/cool ground/Plus Jakarta Sans while current CSS follows selected native theme tokens/font; its muted-ink frontmatter differs from Atelier's current muted-foreground. PRODUCT.md retains the earlier floating-indigo-shell description. Existing workflow accent sections, Segoe Script signature styling and letterhead treatments remain inherited exceptions, not new rules. This incumbent drift/legacy material is outside the write boundary.

## Evidence and limits

Production visual correction ea951d28b7f7cf55daedff10f777420db7d46f73 adds the native heading class and mobile decision stack. Composed production source: 4d33bc286d75f0683a6989b5c572890ef2af1ca1. Separate screenshot harness candidate: 75c50602907189a6461776e1f9a3640fa937bdae, hosted run 43973370968.

/private/tmp/contract-render-review-complete-evidence/ contains 22 individually opened PNGs and capture-validity-review.json: tracker, Renew, Convert, End, preview, progress, approval, letter review, company signing, employee signing and settings, each 1440×1000 and 390×844. Its record reports fonts ready, correct nonblank sections, no document overflow and no clipped decision buttons. This documenter directly opened tracker desktop and Renew mobile. The independent finish reviewer returned SHIP for those eleven English/Atelier-light component surfaces. This is actual React/CSS with authorized fictional DTOs, not an installed authenticated route or complete persisted journey.

The initial Settings fixture used the wrong pathname and highlighted Contract cases. Its test-only correction is now evidenced by /private/tmp/contract-render-review-actual-route-evidence/ui-screenshots and capture-validity-review.json, on separate peer candidate 17a545c014e58b366b84243ca3fdcec945047a71 / hosted run 43974925512. All eleven capture cases passed; all 22 PNGs were individually validated again with ready fonts, 26px/22px headings and no overflow or clipped decision controls. Settings selects Settings/access, the tracker selects Contract cases, and nested details reflect their actual pathname context. The preview uses one fictional People BP document owner. This documenter directly opened corrected Settings desktop and preview mobile. A fresh limited reviewer verdict pass resolved both the pathname-context and owner-caption limitations, observed no regressions and retained the prior eleven-component SHIP scope; it did not grant merge or release approval. The existing built-review gallery was refreshed at the same index.html path. The packet still excludes alternate themes/locales, returned-letter state, Personnel posting/pay confirmation and HR Automation captures. No contrast audit follows from variables or screenshots.

The separate build review records hosted native/DOM/performance receipts, including 43971888182 with roughly 0.8-second first-page reading for 1,000 cases across 70 companies. Run 43969303063 passed the production build, whole-repository types and 20 selected cases (14 DOM/six native) on its own separately identified candidate. Run 43972855075 passed the production build and selected DOM checks on composed source 4d33bc286d75f0683a6989b5c572890ef2af1ca1; its whole-types result is not recorded as passing here. Five render-fixture compiler errors were corrected on separate peer candidate 17a545c014e58b366b84243ca3fdcec945047a71, whose entire hosted run 43974925512 passed: eleven actual-route, one-owner and native-null fixture capture cases plus whole-repository typecheck (job 133676574203), verified from the completed hosted run. These receipts establish different candidate-scoped claims and do not grant release authority. No local tests, compiler, build or server ran in this pass.

Automatic approval review twice rejected the normal merge of peer test-fixture candidate 17a545c014e58b366b84243ca3fdcec945047a71 into the owned Codex candidate, citing the user hold as covering all merges. The proposed production app/core/lib/components/messages/packs bytes were verified identical; that does not override the rejection. No integration, cherry-pick or file-copy workaround is authorized. The concrete patch scope and approval request are in contract-render-fixture-integration-approval.md; this test-fix integration remains pending user approval. Source checkpoint 47fe6350b9c20237d345d2fd4c26ca8f7f294d5a contains the already-owned nullable-type change without runtime change; production UI remains the ea951d28b7f7cf55daedff10f777420db7d46f73 visual correction. Final corrected route-capture evidence and passing whole-repository typecheck are recorded above on the separate prepared peer. Those receipts do not establish successful integration into the owned candidate; integration remains blocked pending user approval. This report does not claim all checks complete or release readiness.

Held/unapplied boundaries remain in contract-management-build-review.md: additional native Form hold, email-document task/current-signer projection, SMTP attachment transport/provisioning, scheduler principal, manual workflow-start/recovery and overdue-End behavior. This report does not mark them implemented or accepted.

Verified checkout: /Users/zenlam/Projects/ai-hr/.codex/worktrees/contract-screens-20261117, branch codex/contract-screens-20261117; initial observed HEAD 75e6eb935d9dd3be1148b91f01cc8ed4648e2bd5, later rechecked at 47fe6350b9c20237d345d2fd4c26ca8f7f294d5a. Foreign WIP was preserved. Fetch was attempted but sandbox denied FETCH_HEAD writing, so remote freshness is unknown for this pass (cached main/alpha divergence 324 ahead/0 behind each); no base changed.

Global files retained: DESIGN.md SHA-256 20e0bc2b9193208a7919c62b2cb02acdf4e8031a47a01fab960fd9e54b725e47; .impeccable/design.json SHA-256 425dfccc9ae8e0fb8a4d44c4041aa3673c293eee50fcb2e835e338ed27a98aa1. An ordinary extension warrants no global regeneration.
