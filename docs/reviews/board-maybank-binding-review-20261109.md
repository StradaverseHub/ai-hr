# Maybank payee residency binding: design comparison

Recorded 9 November 2026 against `4f558babdee526aa79bf337b4626baa57e8cb37b`, branch `codex/board-staging-integration-20261108`, verified worktree `/private/tmp/aihr-board-staging-integration-20261108`. This ordinary Operate extension repairs an existing field binding; it introduces no visual redesign, tokens or global rules. `PRODUCT.md`, `DESIGN.md`, `.impeccable/design.json` and the surface brief remain unchanged.

The coordinator reports a successful fresh `origin main alpha` fetch this session: main `00a27edbe7de417dd97b0a82bdab48b8e79214a7` (controller preparation), alpha `ebc539814c4bdd0b878248db5c4f374d13c42488` (original frozen CI candidate). The assigned HEAD is 62 ahead/0 behind main and 2 ahead/0 behind alpha. This is coordinator-supplied freshness evidence; the assigned documentation base is retained, with no base change or installation claim.

## Scope and source comparison

Read Impeccable `reference/document.md`, the incumbent product/system records and schema-v2 sidecar, `.impeccable/surfaces/components-company-panel-tsx.md`, and the [previous Maybank design review](board-maybank-design-review-20261108.md). Sampled the global/Atelier styles, shared `Field` and `inputCls`, `PersonnelField`, `personnelControl`, the registry descriptor and `components/bank-info-card.tsx`.

The repair replaces the existing residency `Field` wrapper with `PersonnelField` and the select's literal name with canonical `personnelControl`. `PersonnelField` still renders the same shared `Field`; its registry label resolves to the same `maybankPayment.payeeResidency` key. The existing native select, `inputCls`, accessible label, nullable empty default, three options and adjacent helper are retained. The descriptor declares a current employment-scoped bank-owner fact, `bankPayeeResidency`, with reporting disabled, no import writer and protected specialist ESS metadata granting no employee self-service writer. This records source declarations, not an independent authorization audit.

A direct Git comparison confirms `components/bank-info-card.tsx` and `components/company-panel.tsx` are unchanged from capture source `b2dac482be8ca6dba29ed4d20c3689ce99c118f6` to the recorded candidate. The source preserves payee residency separately from employee tax residency and retains Not recorded rather than inference.

## System retained

1. **Palette:** existing semantic foreground, muted, card, border and primary roles; Classic captures retain indigo emphasis and neutral forms. Atelier orange and the separate public-login plum retain their incumbent scopes.
2. **Type ramp:** incumbent operational title 1.375rem/600, body .875rem/1.25rem and label .8125rem/500 remain recorded globally; this field retains the existing 14px control and 12px label/helper use. No new type role or display face is introduced.
3. **Layout and shapes:** the existing full-width residency field, adjacent guidance, rounded bordered bank card and responsive account form remain intact. No spacing, breakpoint or corner change is made.
4. **Components and depth:** the same shared Field renderer, native select, focus classes, card boundaries and save semantics carry the repair. No imagery, shadow vocabulary or motion is added.
5. **Named rules:** the incumbent Scoped Accent Rule and Flat Surface Rule remain within their documented theme scope. Canonical binding metadata does not create a new visual rule.

## Evidence and scoped disposition

The fresh finish reviewer `/root/maybank_binding_finish_review` returned **ship for this binding repair only**, with no material fixes. Its handoff reports that all twelve authenticated-artifact PNGs are pixel-identical to the previously approved captures, across `en`, `ms`, `zh`, `vi`, `ta`, `th`, desktop 1440×1000 and mobile 390×844, with no horizontal overflow. Authentication refers to evidence provenance; these remain real-component fixtures with fictional values, not an authenticated installed application journey. This documentation pass independently inspected the Tamil mobile PNG and English capture metadata, alongside source.

Evidence retains its original identities:

- Run `42511432383`; source `b2dac482be8ca6dba29ed4d20c3689ce99c118f6`; controller prefix `00a27`.
- Artifact `13629682808`; supplied SHA-256 `519fecafc60a6558f37149360f1b98900e457913b7c622ff65c0fea54a97d2ec`.
- Actual captures: `/private/tmp/aihr-board-open-assets/qualification-repair-b2da-evidence/ui-screenshots/{en,ms,zh,vi,ta,th}-maybank-settings-{desktop,mobile}.png`, with adjacent locale JSON metadata declaring Classic theme, fixture scope and original candidate/run.

The full focused run remains **FAILED**, with three unrelated pure-contract failures; the coordinating handoff reports 133 database checks passed. Neither the run nor captures are relabeled as a successful run at `4f558bab`. This documentation pass ran no tests, builds, dev servers, detectors or browser sessions.

The scoped design disposition does not establish bank-file generation or denial behavior, real-provider operation, successful bank upload, bank acceptance, settlement, an installed journey, native-language translation approval, other-theme rendering, contrast compliance, staging acceptance or release authorization.

## Defects and drift left outside the system

The previously documented Tamil phone native hash-option suffix truncation remains visible; the decisive blank-hash wording and adjacent helper remain available, and the finish reviewer required no repair. It is not adopted as a future layout/copy rule. Pre-existing 10px advisory badges, uppercase section treatments, older product language about the floating indigo shell and stronger dark-mode assurance, and other drift already recorded in `DESIGN.md` remain outside this binding-only scope. None is repaired or canonized. The separate untracked provider review and other user work are preserved; no commit, integration or deployment is performed.
