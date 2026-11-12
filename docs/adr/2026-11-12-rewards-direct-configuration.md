# Rewards configuration is saved directly by its accountable editors (board 60f1fdcd)

Date: 12 November 2026. Status: accepted by the board item owner (plan approved on item 60f1fdcd); source on branches
`claude/board-rewards-governance-20261112` and `claude/board-rewards-governance-owner-fns-20261112` (migration 5580), not
installed. Applies with board item 2103041d (PAT Inputs grid).

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
   current Group Rewards, CTRO and HR Admin holders for the change's companies, never the editor's own person.

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

Three rules sat inside purpose-owned definers the migration owner cannot replace. On 12 November 2026 the owner chose
**option 2** for them: new functions owned by the migration owner, with their own row-security policies and grants,
replace the application paths; the purpose-owned functions stay installed byte for byte and are no longer called by
those paths. Migration 5580 (draft block 5580–5599, branch `claude/board-rewards-governance-owner-fns-20261112`):

1. **CTRO and HR Admin edit Salary Structures, Bonus Matrices and company PAT.** `app.reward_config_editor(company)` is
   Group Rewards (the unchanged `app.reward_setup_allowed`), CTRO (whole-group grant, setup grant, or a review seat in
   the company) or HR Admin over the company (`role_assignment` checked against the session grants). A null company is
   a group-wide item and needs group-wide authority, so a company-scoped HR Admin is refused on structures and
   matrices but edits PAT for the companies they look after. Viewing as someone never edits. Permissive policies on
   `reward_library`, `reward_library_version`, `reward_pat_version` and the library revision audit admit the editor;
   the four write triggers that called purpose-owned guards (`reward_library_input_guard`,
   `reward_library_capture_revision`, `reward_pat_input_guard`, `reward_pat_confirm_apply`) are re-pointed at owner
   copies with the editor predicate. The PAT repricing chain (`app.reward_config_pat_affected_units`,
   `…_apply_confirmed_pat`, `…_reprice_draft_pat`) is the installed body with only the authority test and names
   changed. The page readers (grade choices, companies, company structure, PAT history, library usage and lock) have
   owner copies too, used through `packs/rewards/setup-config-query-port.ts`. The Rewards Access grid shows Group
   Rewards, CTRO and HR Admin as Full on these three rows only.
2. **Reviews from an active plan, by whoever made it active.** `app.reward_config_create_planned_unit` is the 2205
   creator with the 4100 lock order and without the activator exclusion. Its authority stays **Group Rewards**: the
   creator takes the review's Group Rewards seat, which also sees EC-confidential people, so CTRO and HR Admin do not
   create reviews. As the owner of `employment` and `person` it reads only committed rows (`import_pending_attempt_id IS
   NULL`), as the staged-import policies do for the purpose reader. The annual-admission guard
   (`app.reward_policy_binding_guard`, owner-owned) admits this owner writer only while the call runs (its transaction
   id in a local setting, and the owner role, which the application role cannot assume); every snapshot and binding
   check is unchanged.
3. **The uploader makes their own uploaded awards active.** The 2208 binding triggers are re-pointed at
   `app.reward_config_uploaded_binding` (runs as the writer, so the purpose-owned validation and editable-lines checks
   keep their callers' rights) and `app.reward_config_uploaded_binding_check` (owner; reads the whole-file rows and
   computes the same digest). Only the uploader-versus-checker rule is gone: the unchanged current upload, valid awards,
   refresh and BU-stage rules stay, and the review route still needs the current version to be active.

Owner copies read forced tables through row security. Where the purpose reader had its own policy, an owner policy with
the same predicate and the editor in place of Group Rewards is added; none is wider than the caller's own
configuration authority. The change-log writer and reader and the notice recipients use the editor predicate; notices
also reach HR Admins over the change's companies (group-wide HR Admins for group-wide items), never the editor.

Still not in this change, and still Group Rewards only: the Shared Rewards Configuration plan (its commit definer
`app.reward_setup_policy_commit` and the plan tables), Senior plan and budget-cap exemption (`reward_governance`
policies), Review Set-up release (`app.reward_preparation_view` names a Group Rewards doer), uploaded-award uploads
themselves and Limit Controls. Each would need the same treatment.

**Composition with the Role permissions grid (board db14e49c, migration 5520).** That migration is not on this branch
and installs before this one. Its owner `app.reward_setup_page_allowed` overlaps `app.reward_config_editor`; this
migration keeps its `role_permission` branch of `app.reward_config_change_record` (behind `to_regprocedure`). Its
restrictive application-role policies on `reward_library`, `reward_library_version`, `reward_pat_version` and
`reward_plan_setup` read `app.reward_actor_page_level`, which considers only Group Rewards, CTRO and EC and whose
catalogue gives CTRO View only on structures and matrices and HR Admin nothing. When both are installed the integrator
must give CTRO and HR Admin Full on `salary.view`, `bonus.view` and `pat.manage` in `packs/rewards/access-policy-model.ts`
and `app.reward_role_default_level`, and include `hr_admin` in `app.reward_actor_page_level`; otherwise those
restrictive policies refuse what this migration admits.

**Composed at the board release integration (migration 5600, 13 November 2026).** Both are installed in journal order
(5520, then 5580, then 5600). `5600_rewards_config_editor_role_levels` replaces only owner-owned functions from 5520:
`app.reward_role_default_level` gives Group Rewards, CTRO and HR Admin Full on `salary.view`, `bonus.view` and
`pat.manage` (mirrored in `packs/rewards/access-policy-model.ts`; options unchanged, so structures and matrices offer
Full / View only / — and PAT offers Full / —), and `app.reward_actor_page_level` also counts `hr_admin`. It adds
`app.reward_config_page_allowed(company,page,operation)`: the configuration editor (manage) or viewer (library_view)
of the company and the page's row (Full = manage, View only = library_view), used by the library page, the library
save and preview, each PAT row save, and the Rewards menu. The grid still only narrows: CTRO or HR Admin at View only
read structures or matrices and cannot write them (the 5520 restrictive policies refuse the write); at — the page,
its rows and its menu entry are gone; a company-scoped HR Admin holding Full is still refused on group-wide items,
because `app.reward_config_editor(NULL)` stays the outer limit.

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
