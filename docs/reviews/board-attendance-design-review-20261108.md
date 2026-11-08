# Attendance Formula Builder — ordinary-extension design record

Recorded 9 November 2026 against source `128bb3efa78f72ef03a7ab2a44822dd81569b990` on `codex/board-staging-integration-20261108`. This is the scoped Impeccable documentation handoff for approved feedback `dff30880`, revision 1. It records the implemented extension and the supplied fresh finish review, not a new visual world or an installation acceptance.

## Overview

The visitor mode is **Operate**. Scoped HR administrators configure company formulas; authorized attendance/payroll administrators inspect employee-period evidence and make explicit review, approval and transfer decisions. The existing OneHR operational workspace supplies the visual authority. The direction contract pins a familiar list, dedicated editor, existing employee picker and criteria builder, source editor, actual-data test controls and traceable Attendance & Pay Items results. No raster assets ship for this extension.

Inputs checked: the private `attendance-direction-contract.md`, `attendance-full-spec.txt` and all three reporter answer rounds in `answer-dff30880.json` under `/private/tmp/aihr-board-open-assets/`; incumbent `PRODUCT.md`, `DESIGN.md` and `.impeccable/design.json`; canonical `CLAUDE.md` and `docs/REPOSITORY-AND-ENVIRONMENTS.md`; Impeccable `reference/document.md`. The root session already loaded Impeccable context once. No new context or detector pass was run by this handoff.

Source checked: `app/globals.css`, `app/atelier.css`, `components/ui.tsx`, `components/formula-source-editor.tsx`, `components/attendance-formula-pay-items.tsx`, and the formula-builder editor/list/new/detail routes. The list and routes use the shared PageHeader and full-width page contract. The editor reuses Button, Field, input styling, AllowanceEmployeePicker and AllowanceEmployeeExpressionEditor. This record does not replace or regenerate the incumbent product, design or sidecar files.

## Colors

The source uses semantic background, foreground, primary, muted, input, border, ring and destructive tokens. The final screenshot metadata explicitly selects **Classic**, with indigo primary (`#4f46e5`), pale ground, white fields and muted descriptions from `app/globals.css`. These captures do not establish Atelier or Monolith rendering. Atelier remains the documented default operational identity: white ground, orange primary (`#c2410c`), neutral hairlines and flat surfaces from `app/atelier.css`. No attendance-specific palette or theme override was introduced.

Syntax colors have a functional role: primary for keywords/references, emerald for quoted strings and muted text for comments. Validation uses destructive text plus the actual named diagnostic. Result states use readable localized text, not color alone. These are existing component behaviors, not new global accent rules.

## Typography

The source retains the shared sans stack, including CJK, Thai and Tamil fallbacks, and shared monospace for formula source and technical references. The capture harness identifies its Latin face as ReviewJakarta/Plus Jakarta Sans; script-font metadata provides rendered fallback evidence where supplied. It does not establish native-language editorial review.

The implemented hierarchy is compact: shared PageHeader title uses 20px semibold before theme overrides; editor legends and section headings use 18px semibold; body, help and controls generally use 14px; shared Field labels and technical metadata use 12px. FormulaSource uses 14px monospace with 24px line height. Periods, quantities, rates and money use tabular figures. Atelier's existing 22px title and compact label overrides remain owned by the theme. No separate display face or decorative heading system is created.

## Layout

The full-width route keeps the existing page container. Editor sections use a 32px vertical rhythm; inner groups generally use 12–20px gaps, with 24px separation above sections and one-pixel token borders. General fields progress from one column to two at the shared small breakpoint and three at the large breakpoint. Test fields use the same responsive model. Workspace buttons and action rows wrap rather than requiring one long horizontal strip. Long prose stays within the existing prose measure.

FormulaSource wraps long lines, grows from 96px to a 264px cap and scrolls vertically inside that cap. Its highlighted layer mirrors textarea scroll and resizing. The variable library is bounded to 384px with internal scrolling. References use wrapping code and disclosures. Attendance & Pay Items uses an internally scrollable result table with a minimum width of 58rem; hidden columns on a phone remain reachable through that table rather than widening the document. The 32 metadata entries report no document overflow; their `scrollRegions` arrays are empty, so those entries alone do not prove a measured scroll-gesture journey. The source establishes the intended containment.

Global narrow/coarse-pointer rules retain 44px control targets and 16px form input text. Existing focus and reduced-motion rules continue to apply. This packet is limited to 1440px and 390px viewport widths; it does not establish every intermediate width, theme or assistive-technology combination.

## Elevation & Depth

The extension uses existing token borders, field shadows and rounded evidence containers. Classic captures retain Classic's material vocabulary; Atelier's flat cards and shell remain unchanged. No offset-shadow treatment, decorative depth system or new elevation token is introduced.

## Shapes

Controls and evidence panels use shared rounded utilities and theme-owned radii, not independent attendance values. Fields retain a visible boundary; section rules and disclosure groups organize the long task. The editor uses ordinary fieldsets, legends, headings and labeled controls. The workspace choices are a pressed-state button group, matching their implemented semantics rather than claiming an ARIA tab pattern.

## Components

### Editor, eligibility and source authoring

General fields expose formula ID, description, company, searchable Pay Item code/name, effective date, purpose, period, output unit and overlap handling. Weekly/monthly cutoffs appear for their selected methods. Saved company and formula identity remain fixed in the editor. Eligibility offers all, selected employees and matching criteria through the existing attendance selection components.

Write and Conditions share FormulaSource. Both now expose the translated **Format source** control; formatting adjusts indentation without changing authored tokens, strings or comments, preserves selection, and Enter carries indentation outside composition/modifier cases. Syntax highlighting remains presentation layered over a labeled native textarea. This is a source-authoring affordance, not execution of arbitrary code.

The variable library shows technical ID, label, unit, source/type metadata, requirements, examples and alias information. References are editable fictional examples with copy/insert actions and explanatory warnings; they are not company policy or statutory authority. Reporter terminology is Before Shift / After Shift. The three In-Shift IDs describe one category; same-meaning break aliases must not be combined. Callback Overtime, ZoneACollection and OTAssignWorkHour were removed by reporter direction. Preserved business IDs remain author/audit references rather than being renamed for presentation.

### Validation, save and test

The final repair moves named compilation validation outside the Write-only panel and places it immediately before Save, so an invalid named condition remains visible on Conditions. The status message has `attendance-source-validation`; disabled Save references it with `aria-describedby`. The error capture identifies CONDITION_2 and its line/column; the recovery capture shows corrected indented source and enabled Save. The shared editor supports diagnostic marks, but this attendance screen does not pass per-token marks: this record does not claim inline range highlighting here.

Pending operations expose `aria-busy`, disable relevant controls and retain explicit result notices. Action refusals render an alert; empty lists/searches have text. Dirty/archived state gates save, test and activation. Save creates the version to test. Test chooses a completed employee period and shows the saved evidence, trace and source details. Activation requires the current saved test/version and a separate unchecked review confirmation; editing clears that confirmation. Archived formulas are read-only in this interface.

### AI proposal and explicit pay states

Ask AI requires entered requirements, company scope and a disclosure checkbox. A returned explanation, questions, assumptions and source remain a proposal; Apply changes the draft and does not save, activate or approve pay. The screenshot fixture explicitly makes no provider call. Provider configuration or actual use is outside this record.

Attendance & Pay Items separates calculation, evidence inspection, review, approval and transfer. The UI shows formula/version, period, quantity/unit, rate, amount and readable result state. Review/approve actions require a nonblank reason; only eligible states expose the corresponding action. Only approved/posted rows can be selected for transfer. Transfer additionally requires an explicitly chosen draft-run option, selected results and reason. Payroll choices use company, period and cycle labels rather than opaque IDs. These observed client gates accompany service authorization; they do not themselves prove installed permissions or actual money movement. Historical evidence and version disclosures preserve the visible audit trail.

## Do's and Don'ts

- Do preserve the incumbent **Scoped Accent Rule**, **Flat Surface Rule**, supported themes and shared primitives; apply their existing scope rather than turning Classic fixture paint into a new house style.
- Do retain visible units, period, source/version trace, actual named refusal and explicit human controls at consequential state transitions.
- Do keep long result tables contained and workspace controls wrapping under translated copy.
- Don't treat a fictional example, AI proposal, test result or visual verdict as activation, pay approval or deployment.
- Don't promote task-specific formula IDs, screenshot harness values or pre-existing defects into normative design tokens.

## Finish-review evidence and disposition

The first fresh finish review inspected 28 captures and returned **fix** for two material issues: named condition validation was hidden while Conditions was selected, and source formatting/indentation help was missing. It otherwise matched incumbent typography, material, ground, composition and mobile containment. Source `128bb3e` repairs both items. The same fresh reviewer then inspected all 32 recaptures, scored both **Resolved**, reported no observed regressions, marked remaining findings **Clear**, and returned **ship scoped to those fixes**. This records the supplied independent reviewer verdict; it is not a new whole-product approval by this documenter. This handoff additionally sampled condition-error mobile, condition-recovered desktop and Thai results mobile against source and checked every capture's metadata inventory.

The detector ran once and returned `[]` in the private `attendance-design-detector.json`. There was no second detector scan. An empty detector result is not an accessibility, business-behavior or release guarantee.

Hosted evidence: run `42500987470`, selected job `128794828309`, source `128bb3efa78f72ef03a7ab2a44822dd81569b990`; `focused.json` records 33 assertions, exit 0, kind `FOCUSED_ONLY`, `releaseEligible: false`. It covers the attendance editor, language and rendered review fixtures. Artifact `13624724569` and SHA-256 `c29ef33215bc98b305478403e6c3c430e83070e233a2108be3ea495874ff0f46` were independently verified by the controller; that artifact-identity claim is supplied handoff evidence, not a new download by this documenter. The whole-repository compiler was still running at handoff. No full release witness is asserted.

### Complete final capture inventory

Files and matching JSON metadata live in `.impeccable/review/board-attendance-20261109/`; the private original is `/private/tmp/aihr-board-open-assets/attendance-128bb-evidence/ui-screenshots/`. Every entry records the same candidate, run, Classic theme and Chromium `156.0.8078.79`. Dimensions below are browser viewports; full-page image heights can be longer. All six configured locales cover editor and results at both viewports; English additionally covers library, references, condition error and recovered condition.

| Capture | Viewport | Document overflow |
| --- | --- | --- |
| `en-feedback-attendance-condition-error-desktop.png` | 1440 × 1000 | No |
| `en-feedback-attendance-condition-error-mobile.png` | 390 × 844 | No |
| `en-feedback-attendance-condition-recovered-desktop.png` | 1440 × 1000 | No |
| `en-feedback-attendance-condition-recovered-mobile.png` | 390 × 844 | No |
| `en-feedback-attendance-editor-desktop.png` | 1440 × 1000 | No |
| `en-feedback-attendance-editor-mobile.png` | 390 × 844 | No |
| `en-feedback-attendance-library-desktop.png` | 1440 × 1000 | No |
| `en-feedback-attendance-library-mobile.png` | 390 × 844 | No |
| `en-feedback-attendance-references-desktop.png` | 1440 × 1000 | No |
| `en-feedback-attendance-references-mobile.png` | 390 × 844 | No |
| `en-feedback-attendance-results-desktop.png` | 1440 × 1000 | No |
| `en-feedback-attendance-results-mobile.png` | 390 × 844 | No |
| `ms-feedback-attendance-editor-desktop.png` | 1440 × 1000 | No |
| `ms-feedback-attendance-editor-mobile.png` | 390 × 844 | No |
| `ms-feedback-attendance-results-desktop.png` | 1440 × 1000 | No |
| `ms-feedback-attendance-results-mobile.png` | 390 × 844 | No |
| `ta-feedback-attendance-editor-desktop.png` | 1440 × 1000 | No |
| `ta-feedback-attendance-editor-mobile.png` | 390 × 844 | No |
| `ta-feedback-attendance-results-desktop.png` | 1440 × 1000 | No |
| `ta-feedback-attendance-results-mobile.png` | 390 × 844 | No |
| `th-feedback-attendance-editor-desktop.png` | 1440 × 1000 | No |
| `th-feedback-attendance-editor-mobile.png` | 390 × 844 | No |
| `th-feedback-attendance-results-desktop.png` | 1440 × 1000 | No |
| `th-feedback-attendance-results-mobile.png` | 390 × 844 | No |
| `vi-feedback-attendance-editor-desktop.png` | 1440 × 1000 | No |
| `vi-feedback-attendance-editor-mobile.png` | 390 × 844 | No |
| `vi-feedback-attendance-results-desktop.png` | 1440 × 1000 | No |
| `vi-feedback-attendance-results-mobile.png` | 390 × 844 | No |
| `zh-feedback-attendance-editor-desktop.png` | 1440 × 1000 | No |
| `zh-feedback-attendance-editor-mobile.png` | 390 × 844 | No |
| `zh-feedback-attendance-results-desktop.png` | 1440 × 1000 | No |
| `zh-feedback-attendance-results-mobile.png` | 390 × 844 | No |

### Limits and preserved drift

These are real component screenshot fixtures under fictional data, with framework/server/action stubs. They establish the rendered states in this packet, not a signed-in installed journey, actual provider use, approval of pay, deployed source, production acceptance, native translation quality or full contrast/accessibility compliance. Changed installed journeys and permission checks remain separate staging acceptance work; the grouped six-item staging release is not authorized by this record.

The verified checkout and branch were confirmed through Git. A fetch attempt in this documentation worker could not write the shared Git `FETCH_HEAD` under the sandbox, so remote-ref freshness was not independently re-established here. The already frozen candidate was used without choosing a new integration base or changing refs.

Not canonized or repaired: PRODUCT.md's older indigo/floating-shell description and contrast assurance, the incumbent shell brief's stale mobile note, the existing shared glyph back arrow, and the prior sidecar's preview ramps remain outside this ordinary extension. Additionally, DESIGN.md's muted-ink sample (`#66666e`) differs from Atelier's current `--muted-foreground` (`#5f5f67`); `#66666e` still exists as its tertiary ink role. This pre-existing token-role drift is reported without silently repairing the incumbent records. None of these become new attendance design rules.

Preservation check: PRODUCT.md, DESIGN.md, .impeccable/design.json and the pre-existing untracked provider review were left untouched. Only this scoped review record was written; no local tests, compiler, build, server, commit, installation or provider operation was run.
