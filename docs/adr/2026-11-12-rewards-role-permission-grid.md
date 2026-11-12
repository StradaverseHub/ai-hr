# Rewards Access role permissions are one levelled grid saved in batches (board db14e49c)

Date: 12 November 2026. Status: accepted by the board item owner (plan approved on item db14e49c); source on branch
`claude/board-rewards-role-permissions-20261112`, built on the Rewards governance branch (60f1fdcd), not installed.
Builds on [Rewards direct configuration](2026-11-12-rewards-direct-configuration.md).

## Decision

- **One catalogue.** `packs/rewards/access-policy-model.ts` owns every row (category, kind) and each role's default
  level, which is also the ceiling. Levels: Full > At their step > View only > —. A cell offers only its default and
  the narrower levels the server can tell apart: unit actions are on/off; Salary Structures, Bonus Matrices, Senior
  plan amounts and Limit Controls also offer View only; Restricted (EC) direct reports offer At their step or View only
  for the route roles (hiding them would stall the approval route on hidden records). Migration 5520 mirrors the
  catalogue in `app.reward_role_default_level`, `app.reward_role_level_options` and `app.reward_role_permission_locked`;
  `test/rewards-role-permission-grid-db.test.ts` checks parity for every role and row.
- **Locks the server refuses** (shape trigger and command): Group Rewards keeps Rewards Access; Submit or approve for
  BU CEO, BG CEO, Group Rewards, CTRO and EC (the proxy can be narrowed); scope, route, own reward and audit rows;
  cells with one option. A locked cell can only be returned to its default (clearing an older saved setting).
- **Storage.** `reward_role_permission.level` (nullable for the populated upgrade; the trigger fills it). `allowed` is
  kept equal to `level <> 'none'`, so every boolean reader keeps its meaning. A cell at its default is stored as no
  row. Each saved batch writes `reward_role_permission_version` (the whole saved matrix, per-cell changes, reason);
  the latest revision is the optimistic-concurrency token. Restore loads a version into the grid as edits.
- **Authority.** Immediate: Group Rewards with group setup authority, HR Admin (`app.is_group_admin`) or a whole-group
  CTRO, never while viewing as. Proposer: a company-scoped Group Rewards seat; their batch waits in
  `reward_role_permission_request` for an immediate-authority checker who is not them (nor another login of the same
  person), and lapses if the grid changed meanwhile. The 5400 self rule still applies: nobody changes the cells of a
  role they hold. HR Admin and CTRO open only the Role permissions tab (no user list, no reward figures).
- **Each save** recomputes the "Review before saving" summary in its transaction (narrowing is high impact), applies
  all cells or none under the tenant role-permission advisory lock, writes one version and one `reward_config_change`
  row (`app.reward_config_change_record` now admits `role_permission` rows from immediate authority), and the export
  access audit lists saved, waiting and decided batches plus the earlier one-cell events.
- **The formerly display-only rows now narrow the server**, with row security as the outer limit (restrictive policies
  for the application role only; purpose-owned readers keep their contracts): Salary Structures and Bonus Matrices
  (`reward_library`, `reward_library_version`: View only reads, Full writes), PAT Inputs and the Shared Rewards
  Configuration plans (writes need Full on `reward_pat_version` / `reward_plan_setup`; the pages check the level),
  Senior plan amounts (`reward_senior_award`, `reward_senior_evidence`), Restricted (EC) direct reports (the review
  service hides them at — and refuses entry at View only) and Promotion nominations. Menus use the same functions.

## Not in this change

- **Limit Controls** (board fc804e8c) is built on its own branch. Its row, defaults and SQL options exist; it is hidden
  behind `REWARD_LIMIT_CONTROLS_ROW_ENABLED` until that page wires `app.reward_actor_page_level('limits.view')`.
- **CTRO / HR Admin edit access to the other configuration pages** stays as decided in the direct-configuration ADR
  (`app.reward_setup_allowed` is purpose-owned). The grid therefore never shows Full for them on those pages.
- The stage-free entry rule for EC-confidential rows by per-review Group Rewards / CTRO / EC seats is unchanged at the
  default ("At their step"); replacing it needs the fixture evidence the plan asks for first.
