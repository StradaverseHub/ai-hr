# Checked preparation of annual Rewards unit reviews

Status: implementation candidate for approved feedback a24cb308; verification and release are separate.

## Context

A unit review currently combines Group Rewards preparation and reviewer work. Approvers can encounter partial figures, while preparation has no single six-step release record. The approved change requires a second Group Rewards person to release a prepared review and requires controlled, explained changes after release.

## Decision

Keep preparation in the existing reward_governance.state and its append-only governance history. A preparation proof records its step, exact input basis, named doer and time. Its basis includes the frozen unit configuration, snapshot, source records, classifications, PAT inputs, Senior selection and exemptions. It excludes recommendation-only changes and the governance digest itself. Confirm and release commands carry the basis the person reviewed; a revision or basis mismatch refuses the command.

All six current steps and their underlying readiness checks must pass. The checker must differ from every step's doer by person identity as well as account identity. An alias account cannot satisfy independence. Existing Senior selection and exemption approvals remain separate decisions. Release makes the existing review available; it does not decide the review or post payroll.

The native reward_roles function keeps its OID but filters ordinary reviewer roles until preparation is released. Its previous scoped, dated membership resolver is retained as a private audience helper. Bounded preparation notices use that audience without returning figures. A restrictive unit read policy also protects policy metadata from creator/administrator read exceptions. The private preparation reader is a nonlogin, noninheriting, non-bypass role with explicit column grants and tenant policies, including on the forced-RLS governance table. Its setup projection excludes personal awards.

| Actor | Preparing review | Unit set-up | Release preparation |
| --- | --- | --- | --- |
| Group Rewards | Full permitted review | Prepare and confirm steps | A different named person checks |
| CTRO / EC | Existing permitted review | Inspect only | No |
| BU / BG CEOs, proxies, PBP | Preparation notice only | Denied | No |
| Company administrator without a Rewards seat | No new business authority | Denied | No |

The live ownership check found reward_unit and reward_member owned by ai_hr_owner with RLS enabled but not forced; reward_governance is forced. Preserve that distinction: the new bounded reader receives its own policy rather than disabling row security.

## Changes after release

Ordinary preparation edits are locked. A Group Rewards controlled-change command requires a reason, clears confirmations and withdraws reviewer visibility. A live review already on the approval route returns to draft under the same transaction, reason and revision update before recalculation. Inspection seats cannot advance a preparing unit. Existing calculation and approval owners continue to govern changes and closed/posted work.

An independent native publisher can change source or confidentiality evidence outside a form. A bounded invalidation trigger withdraws preparation in that transaction, clears the approval digest and records one source-change event. It does not manufacture a human reason or rewrite a posted review. It leaves revision advancement with the source writer; confirmation also checks the rendered content basis to refuse an otherwise unchanged revision. Preparation notifications use the existing native membership/group eligibility owners and event deduplication. They resolve the recorded pre-change stage even after a controlled correction returns the review to draft; a stale release notice is withheld while preparation is pending. Ordinary routed notices retain their existing current-stage predicate.

## Compatibility

Existing exposed reviews retain a legacy compatibility marker and their existing Group Rewards setup editing. Checklist confirmations and release actions stay unavailable for those historical records. No historical doer, checker or release event is invented. The new setup view labels their preparation history as unrecorded. New annual reviews require the checked release process. The notice applies the existing native page matrix, current role overrides and dated personal exceptions. A bounded metadata-only notice keeps the Rewards navigation and pending review destination discoverable without exposing the raw financial unit or its entries. The compatibility marker is outside ordinary runtime form control. Off-cycle and posted payroll ownership remain unchanged.

PAT remains owned by PAT Inputs. Preparation reads its recorded binding; it neither calculates a second budget nor creates another payroll ledger. Applied library names and versions are projected only for the authorized unit, including read-only CTRO/EC inspection without granting global library editing.

## Verification

Verify role and scope withholding through services and native reads, stale basis refusal, complete independent release, same-person refusal, locked setup, source invalidation, audited notifications and preservation of posted history. Hosted behavior tests, the whole compiler, rendered screens and release acceptance establish distinct claims. No deployment is authorized by this decision.
