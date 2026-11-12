# Rewards limits and thresholds have one owner: Limit Controls by reward year (board fc804e8c)

Date: 12 November 2026. Status: accepted by the board item owner (plan approved on item fc804e8c, with the later
owner-approved item 60f1fdcd taking precedence for how changes are confirmed); source on branch
`claude/board-rewards-limit-controls-20261112`, not installed.

## Decision

Every limit and threshold the annual review, the AI advisor and Rewards Analytics use has one stable typed key in
`packs/rewards/limit-controls-model.ts` and one owner: **Limit Controls**, a page under the Rewards Configuration menu
(`/admin/rewards/limit-controls`). Values are kept per reward year as append-only versions (`reward_limit_version`).

- **Inventory.** Salary increase pools (merit, promotion, special adjustment, Standard and JG H plans), per-person
  thresholds (increase without and with promotion, promotion increment, maximum grades up, highest grade, CR catch-up
  floor), bonus (pool cap, under-use warning, individual ceiling, individual multiplier), lump sum (share of
  remaining balance, rounding step, per-person cap, unit amount above the suggestion, individual amendments) and the
  AI advisor thresholds (override, long time without increase, peer pay gap). Group Rewards edits the Value and the
  Type (Block, Exception, Warning, Note); calculation settings are information only (their Type is fixed to Note).
- **Fixed financial invariants** are listed but never configurable, in the model and in a database CHECK: no salary
  reduction (always Block), pools never fund each other or another company, bonus payouts round down, and an
  exemption only relaxes budget caps (the salary pools and the bonus pool cap).
- **Baseline.** With no version for a year, reviews calculate exactly as before Limit Controls: the engine constants,
  with pools and lump-sum settings from the review's own policy. Amounts and checks are unchanged. A version adds two
  checks the Rules page already described but the engine did not run: the individual bonus ceiling (BUD-03) and the
  highest grade after promotion (PRO-01).
- **Versions and reviews.** A saved version takes effect at once for Draft reviews of the year. Submission keeps the
  version the review was checked with (`reward_unit_limit_pin`, written by `app.reward_limit_pin_on_submit`); a review
  past Draft from before Limit Controls keeps the baseline. Group Rewards may explicitly apply the current version to
  reviews in the approval route (BG CEO, Group Rewards, CTRO or EC stage) with a reason: their checks are recalculated
  from the new version, enforced again at the next decision, and each review's current approver is told
  (`reward-unit.limits-reapplied`). Approved and posted reviews always keep their version.
- **Access.** Group Rewards with whole-group configuration authority edits; CTRO and EC (and unit-level Group Rewards
  seats) view; every other role, and a direct link, gets "You don't have access" (`app.reward_limit_controls_access()`,
  enforced by row security and every command). The review calculation reads the confirmed values through
  `app.reward_unit_limit_version(unit)`, authorized by the review's own row security, so reviewers' checks use them
  without the values reaching their pages.
- **Projections hide limit settings from other reviewers.** The Rules page shows BU and BG CEOs, proxies and PBPs what
  each rule does in plain language, without values, Block/Exception/Warning/Note controls or references. Flags state
  what to fix and whether it stops submission, never the limit value. The Shared Rewards Configuration no longer has a
  limits block; its stored values are kept and the reviews use Limit Controls for their year.

## Deviation from the approved fc804e8c plan

The fc804e8c plan asked for "a different Group Rewards user to confirm each change". The later owner-approved item
60f1fdcd ([direct configuration](2026-11-12-rewards-direct-configuration.md)) retired second-person confirmation for
all Rewards configuration, budget-cap exemptions included. Limit changes therefore save directly with a required
reason, through the 60f1fdcd seam: "Review before saving" (`packs/rewards/config-change.ts`; high impact once a review
using the limits has been released to the BU CEO), one change-log row (area `limit`) and the co-administrator notice.

## Interface for other Rewards owners

- `rewardLimitsForUnitTx(tx,unit)` — the confirmed limits a review calculates with (typed `RewardLimits`).
- `rewardLimitsForYearTx(tx,year)` — the current version of a reward year, for Limit Controls readers.
- `rewardLimitAccessForRole(role)` — the native access level per Rewards role, for the Role permissions grid
  (db14e49c); the database function stays the authority.
- `calculateRewards(entries,policy,{limits})` — engine input; absent means the baseline.

## Not in this change

- Off-cycle reviews keep their own thresholds; board item b945f0cc pins year-specific Limit Controls for them through
  the same pin table and readers.
- The unit review's own policy form and the AI advisor settings form still show their legacy pool, lump-sum and
  advisor threshold fields to Group Rewards; once the year has a version those values are not used. Removing them
  from the unit review page is a follow-up outside this lane.
