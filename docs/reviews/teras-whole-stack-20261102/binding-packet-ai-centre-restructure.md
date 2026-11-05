# Binding packet: AI Centre restructure, payroll history learning (P1–P2) and dates

- **Prepared:** 5 November 2026, by the coordinator session teras-noveri-handoff-54e696.
- **For:** the repository owner's direct approval in that session. A relayed approval is refused, and no earlier approval carries over.
- **Candidate:** `claude/aiv2-centre-restructure` at ce28967e8. This is d1cf39cac plus a clean merge of main 830f8ec57 (#219, dropdowns stay inside the screen), which moves neither fingerprint.
- **Supersedes:** fingerprint 5212672b, from the AI v2 release binding r2 (commit 8fa316bad, released and accepted on staging).

## What the AI can now see or do that it could not before

1. **Payroll learning counts (P2).**
   - A new read, `payroll_learning_status`, is reached through the existing `operations_status` tool under a new topic, `payroll_learning`.
   - **Who can ask:** payroll administrators only (its own gate; `rls: administered_scope`, run as the caller).
   - **What it gives:** per company, the learning mode, the day it last learned, and how many people's usual pay range is stable, provisional, not yet learned, rebasing or contradicted.
   - **What it never gives:** an amount, a range, a person, an id, or anything per person.
     - The counts are `bands`, under the small-group rule (`suppressSmallCounts`): 1 to 4 becomes null, and the next smallest count is also withheld so that no count can be worked out from a total.
     - Spec line: a null count is "fewer than 5". The model never says a usual range changed a figure, a check or a flag.
   - **Unchanged:** no new tool, so the worst case stays at 30 tools per role (ceiling 32). Learning changes no calculation, check or permission. Baselines are computed deterministically by `core/payroll-learning/baseline-math.ts` from closed runs only (migration 2013).
2. **Dates from the HR date owner (decision 30) and the owner's rule (decision 31).**
   - For leave and attendance requests, the model passes the person's own words for a named day, and `lib/hr-date-phrase.ts` works out the date in Kuala Lumpur time. The model no longer does that arithmetic.
   - **The rule:** weeks run Monday to Sunday. "Next <weekday>" is the following week's; "this <weekday>" is the current week's, or the next one once it has passed. Malay and Chinese follow the same rule.
   - **On the card:** the other plausible date is offered with one tap. A forgotten clock-out asks only for the missing time.
3. **Single sources from the restructure (decisions 26–29), in the spec and pages.**
   - Payroll exceptions are resolved on Operations › Exceptions only.
   - "Before payroll" links My payroll readiness (`/me/payroll-readiness`) for the whole list.
   - The model's page pointers follow the new structure: wrong pointers to `/control-tower`, `/control-tower/agents` and `/control-tower/readiness` are fixed.
   - The staffing ratio is removed everywhere (decision 26).
4. **Spec v25**, digest `e3d5c13543380478704e0956ef7eef5f594e399485eefb1fb9f973b71fe9384c`.
   - v24 adds the payroll_learning topic and its line, plus the two single-source lines.
   - v25 changes only the last two sentences of the change line: a named day passes as the person's words.

**No new provider-data contract.** The payroll-learning counts and the date words travel inside the existing `teras_harness_turn_v1` turn, and `handbook_policy_values_v1` is unchanged. Gated sensitive turns still store no words.

## Fingerprints

| Closure | Before | Now |
|---|---|---|
| Provider data | 1412 files, `5212672b…` | 1420 files, `ed5d8c241a27e1cc2c1347eba8ab8af1d534408ce27b8bef683ecfcbfa26f432` |
| Module agent | 465 files, `c2898bdb…` | 465 files, `278c891982281c3c5e6e24cad544aabd8b6a384b1383a347508d76d37af16fdd` |

The coordinator recomputed both from clean archives of d1cf39cac and ce28967e8; the worker's figures match. The generator and scope scripts are byte-identical to main's.

**Against 5212672b: 8 files added, 31 changed, none removed.**
- **Added:**
  - `core/explainers/payroll-learning.ts`
  - `core/payroll-learning/{baseline-math,mode,status}.ts`
  - `core/proposals/request-dates.ts`
  - `core/semantic-model/entities-payroll-learning.ts`
  - `db/payroll-learning-schema.ts`
  - `lib/hr-date-phrase.ts`
- **Changed:**
  - `core/harness/{spec,tools}.ts`
  - `core/proposals/{attendance-request,leave-apply,proposal,suggested}.ts`
  - `core/semantic-model/{entities-payroll-readiness,entities-recommend,entities-setup,generate,topic-tools,types}.ts`
  - `core/loops/{cards,views}.ts`
  - `core/agent-registry/controls.ts`, `core/company-refs.ts`, `core/explainers/capabilities.ts`, `core/payroll-anomaly.ts`, `core/pre-salary/person-items.ts`
  - `lib/ai/agent-capability-inventory.ts`, `lib/hr-date.ts`, `lib/permissions.ts`, `lib/pre-salary/items.ts`, `lib/product-context/destinations.ts`, `lib/session.ts`
  - `messages/{en,ms,ta,th,vi,zh}.json`
- **Access-related changes, reviewed:**
  - `lib/permissions.ts` registers `/me/payroll-readiness` (scopedSession, the person's own items) and `/control-tower/agents/build-list` (requireAdmin, and only group administrators are served).
  - `lib/session.ts` shares identity and entitlement reads within one request. Each sign-in carrier still applies its own rules, a failed read is not kept, and nothing is shared across requests (`test/session-request-reads.test.ts`).
  - No grant, role or RLS policy is weakened.

## Evidence (GitHub Actions)

| Check | Run | Result |
|---|---|---|
| Focused CI on d1cf39cac | 41963174642 | Pass: 57 test files, 785 tests, typecheck and build |
| Focused CI on ce28967e8, after the #219 merge | 41966657296 | Pass: selected tests, typecheck and build. Run 41966575145 was refused at resolve by a SHA mismatch in the dispatch (coordinator error); it tested nothing. |
| Luna eval on d1cf39cac | 41964492426 | gpt-6-luna on Azure, spec v25, 2 complete passes, US$1.98, 0 safety faults |

Eval scores, as the mean over both passes on the 44 turns shared with baseline 41534700953, recomputed by the coordinator from the artifact:

| Role | Score | Bar |
|---|---|---|
| Overall | 88.1 | ≥ 82.2 |
| HR | 91.1 | ≥ 82.3 |
| Group | 86.2 | ≥ 74.4 |
| Employee | 92.7 | ≥ 91.3 |
| Manager | 93.6 | ≥ 86.2 |
| Payroll | 71.8 | ≥ 70.2 |

Turns that missed earlier, now scored on both passes:
- **emp-apply-2:** 1.0 and 1.0. It answers 13 November and offers 6 November on the card.
- **emp-clockout-1:** 0.9 and 0.9.
- **mgr-overtime-1:** 1.0 and 1.0.

The eval's facts and the emp-apply-2 ideal now state the company's date rule; no bar changed.

## On approval
1. Bind on the candidate:
   - regenerate the provider manifest;
   - give all 27 approved records the new sourceDigest;
   - give `teras_harness_turn_v1` and `handbook_policy_values_v1` evidence #ai-centre-restructure-binding and the approval time;
   - leave the pending records byte-identical;
   - regenerate the module-agent manifest last;
   - add an addendum to `docs/reviews/ai-provider-owner-approval-2026-10.md`.
2. Re-check main's migration watermark (ours: 2013, idx 1350; a Codex branch also claims idx 1350). Fast-forward main, run the full gate on main, then follow the staging queue, lease, deploy, arrival checks and the owner's acceptance.

## Limits

- **Real data:** counsel's advice (ADR-0169 §5.1) is still required before any real tenant data reaches a provider. Staging uses fictional data only.
- **Production** remains held.
- **What approval is not:** this packet is not a runtime PASS, a staging acceptance or a deployment authorisation.
- **Not in this round:**
  - claims and Leave Credit dates (not yet on the date rule);
  - native review of the Thai, Tamil and Vietnamese copy;
  - history learning P3–P5.
