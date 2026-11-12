# Rewards configuration is saved directly by its accountable editors (board 60f1fdcd)

Date: 12 November 2026. Status: accepted by the board item owner (plan approved on item 60f1fdcd); source on branch
`claude/board-rewards-governance-20261112`, not installed. Applies with board item 2103041d (PAT Inputs grid).

## Decision

Rewards configuration is changed directly by the person accountable for it. The second-person confirmation is retired
for salary structures, bonus matrices, company PAT, the Shared Rewards Configuration plan, Senior plan selection and
amounts, budget-cap exemptions and the unit set-up release to the BU CEO. Each item is either **Draft** (optional work
in progress) or **Active**. A legacy item waiting for a second person reads as Draft, keeps its content, and can be made
active in one step by an editor.

Control comes from three things instead of a second person:

1. **Review before saving.** Each command computes one server summary (`packs/rewards/config-change-model.ts`): the
   changed values, the reviews the change reaches and what happens to them. High-impact changes show it to the editor
   and need a reason: changing PAT, a salary structure, a bonus matrix or a budget limit once a review using it has
   been released; releasing a review to the BU CEO; removing someone's access. The save carries the summary digest and
   is refused ("This changed. Review the summary again") when the recomputed summary differs.
2. **The change log.** `reward_config_change` is append-only. Every command writes exactly one row (who, when, area,
   item, companies, version, reason, bounded old/new values, high impact) in its own transaction through
   `app.reward_config_change_record`, so a failed command leaves no row. Rows never carry an individual's pay; rows about
   named reviewees record their entries and row security never returns a row about the reader's own entry. The page
   `/admin/rewards/change-log` filters and exports it to Excel (formula-safe cells, bounded, audited).
3. **A notice to co-administrators.** Each save emits one `rewards-config.changed` event; the recipients are the other
   current Group Rewards and CTRO holders for the change's companies, never the editor's own person.

Versions are never overwritten. Restoring a salary structure or bonus matrix version copies its values into a new
draft; restoring PAT figures loads an earlier version into the grid as edits that save as a new version. Reviews that
consumed a version keep it (ADR-0137 lineage).

## What stays exactly as it was

- The approval route (BU CEO, BG CEO, Group Rewards, CTRO, EC, Payroll) with a different signer at each stage
  (ADR-0099). Nobody sees or sets their own reward. No salary reduction (Senior and upload). A change to a released
  review recalculates it and tells the current approver (the existing final-pool-changed notice).
- ADR-0137 shared-policy versions, immutability and lineage.
- Basis and stale refusals, locked set-up after release with a controlled change and reason, source invalidation and
  legacy markers from `docs/adr/rewards-unit-preparation.md`.
- Access requests from CEO proxies and PBPs keep their pending route and independent decider (0947).
- **Self rule.** Nobody changes their own access: an immediate access change may remove the editor's own seat but may
  not add, re-role or lengthen a seat for the editor's login or another login of the same person
  (`app.reward_access_self_change_guard`). Nobody changes the permission switches for a role they hold
  (`app.reward_actor_holds_role` restrictive policies on `reward_role_permission`).

## Decisions this supersedes

- `docs/adr/rewards-unit-preparation.md` (board a24cb308): "requires a second Group Rewards person to release",
  "checker must differ from every step's doer" — superseded for release independence. The step proofs (current doer
  at confirm), basis, expected release and reopen reason stay.
- The library / PAT / plan maker-checker introduced by commit f77557e00 (5 Nov 2026, "add checked libraries PAT and
  approved plan creation", migrations 2203/2204/2205); the Senior and exemption checks of a85d56b89 (29 Oct 2026,
  migration 0689); the creator-independence rule of 9fc296278 (9 Nov 2026, migration 4100) and the uploaded-award
  checker of cc9599a4a (5 Nov 2026, migration 2208). The board items that approved those features are not re-read
  here; the commits name the behaviour.
- 51f45fb0's second approval for access changes was already narrowed by a988d4503 (3 Nov 2026, migration 0947: Group
  Rewards, CTRO and HR Admin apply immediately). That is now the rule for all Rewards configuration.

## Database boundary and the parts not yet in effect

Migration 5400 (draft block 5400–5419) applies as the restricted `ai_hr_owner` and replaces **no purpose-owned
object** (docs/SCALE-AND-RELEASE-RULES.md rule 9). The 2205 identity guard `app.reward_setup_identity_guard`
(owned by `ai_hr_reward_setup_reader`) carried the "a different person must confirm" refusals; its three triggers are
re-pointed at the owner function `app.reward_config_identity_guard` with the same PERSON stamping and lineage. The
dropped CHECKs, the PAT update policy and `app.reward_setup_immutable` / `app.reward_plan_setup_immutable` /
`app.reward_preparation_check_guard` are owner objects. The installed PAT confirmation trigger
(`app.reward_pat_confirm_apply`) is unchanged: a PAT Draft is stored as the existing `pending` working version and
"make active" is its pending→confirmed transition, so repricing is byte-identical.

Three rules sit inside purpose-owned definers the migration owner cannot replace and are therefore **still enforced**
until the owner chooses a route (an installation-DBA prerequisite like `deploy/runner-control/release-rewards-roles-*`,
or new owner-owned replacements with their own row-security grants):

1. **CTRO and HR Admin edit access.** `app.reward_setup_allowed` (owned by `ai_hr_reward_setup_reader`) admits only
   Group Rewards for `manage`, and the purpose-owned setup definers (plan commit, review creation, PAT application,
   access policy events) call it. The Rewards Access grid defaults are therefore unchanged; widening them before the
   database predicate would offer actions the database refuses.
2. **Review creation by the plan's activator.** `app.reward_create_planned_unit` (4100) still requires a creator other
   than the person who made the plan active.
3. **Uploaded awards activated by their uploader.** `app.reward_uploaded_binding` (2208) still requires a different
   Group Rewards checker.

Version restore for the Shared Rewards Configuration and the Rewards Access permission grid is also not in this change
(the permission grid is rebuilt by board item db14e49c, which builds on this module).

## Interface for other Rewards configuration pages

`packs/rewards/config-change.ts` is the reusable seam (Limit Controls fc804e8c and the Role permissions grid db14e49c
build on it):

- `rewardConfigSummary({area,itemLabel,lines,affected,highImpact})` and `rewardConfigLines(before,after,label)` build a
  bounded summary; `rewardConfigSummaryDigest(summary)` is its digest.
- A page's preview action returns `{summary,digest}` computed in a read transaction; the command recomputes the same
  summary in its write transaction and calls `assertRewardConfigReviewed(summary,{reason,digest})`.
- After applying the change the command calls `recordRewardConfigChangeTx(tx,ctx,{area,action,itemId,itemLabel,
  companyIds,versionRef,reason,summary,subjectUnitId?,subjectEntryIds?,restoredFrom?})`.
- `app/admin/rewards/review-before-saving.tsx` renders the dialog (`ReviewBeforeSaving` for server forms,
  `ReviewBeforeSavingDialog` for client pages).
