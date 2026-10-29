---
version: 1
slug: "app-assistant-approvals-page-tsx"
primary_target: "app/assistant/approvals/page.tsx"
related_targets: ["components/assistant/assigned-decision-panel.tsx","components/assistant/module-assigned-leave-action-panel.tsx"]
---

# Saved approval decisions

Mode: Operate. This extends the existing Assistant approvals route and inherits its supported themes, components, language and native facts. Owner confirmed 30 October: at most twenty prepared reviews, each individually reviewed and selected, followed by one confirmation; independent native commits and explicit per-item uncertainty.

## Direction contract

THESIS: Review saved decisions together without turning a list selection into approval authority. Every selected row retains the existing complete review card.

OWN-WORLD: Existing shared Card, Button, fields, semantic foreground and border tokens; no new palette, typography, assets or animation language.

STORY: Load this login's saved reviews, open each full review, select only reviewed decisions, confirm the displayed count, then read each outcome or reopen its canonical receipt. No select-all and no automatic retry.

FIRST VIEWPORT: Existing heading and four flow links remain. A quiet saved-reviews control leads to an ordered list, one full-width review per row. The count and primary confirmation sit immediately after the reviewed list; mobile keeps the same reading order and touch targets.

FORM: Precisely approved local extension of the existing review sequence; no concept roll or replacement world. Each existing native review supplies its own facts and consequences. Partial success clears selected private declarations and names records that require reopening. Expiry or a refreshed scope clears selection.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Boundaries and proof

No new prepared-action kind, model tool, approval calculation or native authority. Existing four owners authorize each digest-bound item in their own transaction. Cross-login/cross-tenant custody, stale sources, pause, expiry, replay, duplicate IDs, partial success and uncertain commits require real CI evidence. Six locales, desktop/mobile, keyboard controls and neutral failure recovery are required. Preserve existing design files; document this extension only.
