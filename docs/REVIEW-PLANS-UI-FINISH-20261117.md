# Review Plans UI finish evidence — 17 November 2026

## Scope and disposition

Approved board item `0c0d8710-d271-4def-90ea-7556e131b50e` is an ordinary extension of the authenticated Rewards workspace. The implemented surface agrees with the incumbent Atelier operational system. No new visual world, global token, typography role, illustration or shipping raster is needed. `DESIGN.md`, `.impeccable/design.json` and `PRODUCT.md` remain unchanged. The dedicated [Review Plans brief](../.impeccable/surfaces/app-admin-rewards-review-plans-page-tsx.md) owns the direction contract, five promises and quality bar; its grid composition is not a rule for unrelated pages.

The same finish reviewer returned **VERDICT PASS** on the six material fixes: all six **Resolved**, remaining findings **Clear**, and no material regressions observed from the repair batch. The reviewer's **SHIP** disposition covers those scored fixes only; it is not whole-surface approval or installation/release acceptance.

## Source and evidence identity

Final aggregate source: `9164a2f89ee2a4fd31633bed01975baa2b5b687a`. Hosted run: `44075796690`. Application repair batch: `d8b02fd95`. Fixture correction `1699d25bc` waits for the settled React transition before capturing the enabled recovery action; it changes no application source. Aggregate evidence identities are distinct from the documentation commits.

## Incumbent comparison

| System aspect | Observed implementation | Finding |
| --- | --- | --- |
| Palette | Shared semantic variables drive white content, neutral boundaries, orange actions/focus, destructive errors and subdued amber suggestion cells. Edited rows also carry text labels. | Agrees with the Scoped Accent Rule and semantic state vocabulary; amber is functional suggestion state, not a new brand accent. |
| Type | Shared PageHeader; compact body/controls; explicit 13 px grid content, smaller source/helper labels, tabular headcounts and dates. Atelier supplies the platform UI stack through the existing font variables. | Agrees with operational hierarchy. No display face or page kicker is introduced. |
| Layout | Year and filters lead to coverage, bulk choices, then the ordered company grid. The grid scrolls within its border and has a bounded vertical region. | Preserves the shared wide-table vocabulary. The 1100 px minimum grid and 18 rem plan column are local legibility choices, not global sizing tokens. |
| Shape and depth | Shared rounded fields/buttons, hairline table boundaries, flat structural sections and the existing native confirmation surface. | Agrees with the Flat Surface Rule, including established control and overlay exceptions. |
| State and authority | Read-only notice before the table plus row labels; text for missing PAT, suggestions, edits and job states; disabled controls reflect capability projections. | Agrees with explicit state communication. Rendered capability fixtures do not prove installed authorization. |
| Responsive behavior | Mobile save bar remains in document flow; sticky behavior begins at the shared small breakpoint. Native choices retain a 17 rem minimum within the 18 rem column; narrow tables remain horizontally scrollable. Dialog fills the phone and is bounded on desktop. | Local repair preserves access to controls without inventing another mobile component vocabulary. |
| Recovery | Inline exclusion guidance is associated through `aria-describedby` and `aria-invalid`; Refresh comparison rebuilds the review while retaining staged edits and the mounted reason field. | Agrees with honest error and recovery states. Interaction evidence and static browser evidence have separate boundaries. |

Five-line system summary:

1. Palette: incumbent neutral surfaces, Atelier fire-orange actions/focus, semantic suggestion and error states.
2. Type: shared operational heading/body/label ramp with 13 px grid content and tabular figures.
3. Layout: wrapping controls around a bordered scrollable grid; mobile save actions stay in normal flow.
4. Named rules: Scoped Accent Rule and Flat Surface Rule remain authoritative.
5. Components: shared PageHeader, Field, Button, input/table hooks and native Review before saving dialog.

## Repairs examined

The six reported findings map to the source as follows:

1. The dedicated brief now persists this surface's authority, direction contract, promises, quality bar and evidence boundary.
2. The save bar uses small-breakpoint sticky positioning, leaving phone controls in normal flow.
3. The plan-choice column reserves 18 rem; its select reserves 17 rem so the native choice is inspectable after horizontal scrolling.
4. Refresh comparison is explicit in the confirmation dialog. It refreshes the review and revision-bearing edits while leaving staged choices and the entered reason available.
5. Excluded companies have inline ten-character guidance, native required/minimum constraints and an accessible error association.
6. View-only guidance precedes the wide table and repeats under the company name, so the permission state is visible before scrolling to distant controls.

The reviewer's final six-fix scoring closes these findings within the stated batch scope; the comparison above records their correspondence with the incumbent system.

## Evidence checked

System sources: `PRODUCT.md`, `DESIGN.md`, `.impeccable/design.json`, `app/atelier.css`, `app/globals.css`, `components/ui.tsx`, and sampled `components/ui/{button,input,card}.tsx`. Surface sources: `app/admin/rewards/review-plans/{page,editor,new-year}.tsx`, `app/admin/rewards/review-before-saving.tsx`, and the dedicated brief. The Impeccable `reference/document.md` supplies the documentation format and token/sidecar rules; no global regeneration is warranted by this ordinary extension.

Final artifact directory:

`/Users/zenlam/Projects/ai-hr/approved-board-controller-20261117/.improve/approved-board-20261117/repair4/ui-screenshots`

Nine Review Plans state families are represented: Group Rewards, scoped HR, EC read-only, invalid exclusion, save error, saved, completed job, no year, and new-year error. Role permissions is a separate shared-confirmation regression artifact. Desktop/mobile PNGs and JSON identities accompany mobile plan-type and right-control views for applicable grid states.

The final visual sample covers `en-rewards-review-plans-save-error-desktop.png`, `en-rewards-review-plans-save-error-mobile.png`, `en-rewards-review-plans-invalid-exclusion-mobile-plan-type.png`, `en-rewards-review-plans-ec-read-only-mobile.png`, and `en-rewards-review-plans-scoped-hr-mobile-controls.png`. The settled save-error captures show enabled Refresh comparison and Save changes, the retained reason and staged choice, and the stale-source error within the native modal. The plan-type view shows the full exclusion choice and ten-character guidance; the EC view shows both the pre-table notice and row labels; the scoped-HR right-control view retains accessible save actions below the scrollable grid. This was a sample, not an independent inspection of every inventory image.

The final save-error JSON identifies the exact source/run above, Atelier, Chromium `157.0.8103.50`, desktop 1440 × 1000 and mobile 390 × 844 viewports, no page overflow, and `nativeModal: true`. The desktop modal measures 672 × 900 px; the mobile modal measures 390 × 844 px. Full-page PNG height can exceed viewport height. Native `showModal()` restores the top layer for serialized open dialogs; this rendering-fixture correction does not establish a live authenticated journey.

The controller reports **24 selected assertions PASS**, including the rendered journey, for the final source/run above. This documentation pass did not independently rerun suites, compiler, build or the design detector. The earlier scoped detector result was reported as `[]` before the final repair and is not represented as a final-candidate detector result.

## Limits and uncopied drift

The fixture renders actual page/editor/new-year source with fictional companies and mocked service capability projections. Keyboard/edit/recovery assertions execute in jsdom; Chrome renders serialized inert DOM with application CSS and restores open native dialogs to the modal top layer. This supports bounded presentation and fixture interactions. It does not establish a live installation, authenticated principal, database authorization or state transitions, payroll correctness, migration execution, native translation review, full theme/contrast coverage, human acceptance or release acceptance.

Not canonized or repaired: PRODUCT.md's legacy floating indigo register and broad contrast assurance, the incumbent sidecar's stale preview/system details, and older global documentation drift remain outside this surface's ownership. Existing compact native disclosure markers and shared table styles are not promoted into page-kicker, glyph-icon or system-display rules. No observed defect is added as a reusable global token or prohibition.
