# ADR-0133 — Resumable impact gate through exact-commit unit checkpoints

- Date: 2026-10-20
- Status: Accepted by the owner (2026-10-20: "do it as its own round"); verification policy version 2.
- Amends: [ADR-0114](0114-impact-aware-release-and-learning.md). The full runner (`gate-chunked.sh`) is unchanged.

## Context

`scripts/gate-impact-run.ts` ran every selected unit — the no-DB set, each 64-file DB batch on a freshly
rebuilt cluster, the browser suite — in one uninterrupted attempt and issued PASS only at its end. On this
18 GB machine, shared by many sessions, timing-sensitive tests fail under load with zero assertion errors.
On 2026-10-20 a 14-batch selection (609 no-DB, 895 DB files, ~55 min) went red on batch 12 and restarted
from batch 1 three times. The round ended in an owner override (`atelier-css-fix`), and an earlier round
(`ai-hr-branding`) refused a hand-composed receipt because its chunks ran different commits.

The question is whether a receipt can be assembled from several attempts without proving less than one
uninterrupted attempt proves.

## Why units are independent evidence

FACT (code): each DB batch runs `dev-db-rebuild.sh` then `db:migrate` before its vitest process, so no
batch reads state another batch left. The no-DB unit runs against a closed port. The browser unit is its
own process. A unit's result is therefore a function of (commit, environment, its exact file list), not
of which units ran before it in the same attempt. That is the property a checkpoint must bind, and the
property the refused composed receipt lacked: it mixed commits.

## Decision

1. **Every** impact attempt writes one immutable checkpoint per unit it runs, under
   `~/.aihr-gate-state/impact-learning/checkpoints/<sha>/<coverageId>/` (`AIHR_IMPACT_STATE_DIR` honoured).
   A record binds: exact commit, clean tree (written only after the frozen-candidate check), environment
   hash, policy version, coverage identity, unit id/kind/index/count, the exact file list and its hash,
   the attempt's plan fingerprint and `plan.json` hash, start/end times, exit code, asked and counted
   files, and the SHA-256 of a copy of the unit's log kept beside it. Records and logs are write-once;
   no attempt deletes or overwrites them. Red checkpoints are kept.
2. **Coverage identity** (`coverageId`) is the hash of: commit, impact base, deployed base, environment
   hash, policy version, tier, the selected run list, the browser flag and the exact unit partition.
3. `bash scripts/gate.sh --resume` recomputes the plan and its units, refuses unless the tier is impact
   and green checkpoints exist for this exact `coverageId` (so a different commit, dirty tree, base,
   selection, partition, environment or policy refuses), re-verifies each green checkpoint exactly as
   release will, reruns only units without one, and issues PASS only when every unit of this coverage
   has a verified green checkpoint. A unit whose only checkpoints are red is always rerun.
4. **Every** policy-2 impact receipt lists its unit checkpoints (`checkpoints.units`: unit, id, record
   SHA-256), every attempt seen (`checkpoints.attempts`, red included) and `assembled` (true when any
   listed checkpoint came from an earlier attempt). A clean run is the special case of one attempt.
5. Release (`release-impact-gate.ts`) keeps every existing check and adds: recompute the units from
   the release-time plan, recompute `coverageId`, then for each unit load the listed record, match its
   hash, re-check every bound field, re-hash the log, and recount the vitest summary from it. Anything
   missing, altered, red, for another commit or for another partition refuses. A receipt without
   checkpoints refuses under policy 2.
6. `IMPACT_POLICY_VERSION` becomes 2. Policy-1 receipts refuse at release (they cannot be revalidated
   against a checkpoint store); re-gate.

## CHALLENGE recorded: "plan hash must match" would make resume unusable

The brief asked resume to refuse unless the `plan.json` hash matches. FACT (code,
`scripts/gate-impact.ts` `planImpact`): a red attempt saves a FAIL observation, and the next plan for the
same changes adds the reason "failure observed for a changed module in prior verification" to each
failed test's `selection` entry. The failed tests were already selected (they ran), so the run list is
unchanged, but the plan fingerprint and `plan.json` hash change. A strict plan-hash rule refuses exactly
the case resume exists for. Coverage identity therefore binds what determines the evidence — the run
list, its partition, the bases, environment and policy — and not the reason annotations. The plan hash
and fingerprint are still recorded in every checkpoint. The receipt carries the plan computed at resume
time, and release still requires that plan's fingerprint to equal its own recomputation, as before.
If learning ever adds a test the run did not include, the run list changes, `coverageId` changes and
resume refuses. CONFIDENCE: high.

## What this does not weaken

- Same commit, same clean tree, same environment, same units: a resumed PASS covers the same files on the
  same code with the same per-unit isolation as a clean PASS. Tests prove the two receipts list identical
  run and unit file lists.
- A red unit cannot be carried: assembly accepts only checkpoints that are green on re-verification.
- Retrying is not new: a red gate was always rerun until green. Resume retries only the red unit, and the
  receipt now names the red attempts that a clean rerun used to hide.

## Risks and limits

- RISK: the store and the receipt live on the same disk with no signing key. A person with write access
  can forge both, as they could forge a policy-1 receipt. The checks defend against stale, mismatched,
  edited or partial evidence and against hand-composition, not against a deliberate local forger. A key
  on the same disk would not change that, so none was added.
- The full tier (`--full`, `--shadow`, periodic full regression, high/unknown risk) still runs
  `gate-chunked.sh` uninterrupted. It is not resumable in this round; resume refuses a full plan.
- Checkpoint logs accumulate (a 64-file batch log is typically well under 1 MB). No pruning exists yet;
  deleting a commit's directory only makes its receipts unreleasable, never falsely valid.
- Release must run on the machine that holds the store. It already must: periodic-full detection reads
  the same store.
