# Contract morning automation: proposed system-job boundary

Status: **exact boundary approved for isolated source implementation; no merge or release**. The initial automatic approval review rejected implementation because allowing null
creators and a system-owner path changes a persistent security boundary beyond the general feature-build request.
The adjacent patch is for review, not a migration or release artifact.

The existing kernel captures a signed-in creator and runs application-role transactions under that person's current
authority. A morning timer has no human actor. Reusing a previous administrator would misattribute reminders and make
scheduled business behavior depend on that person's account. Running the bulk scheduler outside the kernel would
conflict with the repository's bulk-work rule.

The proposed extension admits exactly two system consumers:

- `contract_schedule`: scan eligible fixed-term Personnel periods in bounded, keyset-paged units; open a case for a
  verified native period and admit due reminder events. Unknown historical contract numbers remain setup issues.
- `contract_scheduled_automation`: execute those admitted `caseOpened`, `beforeContractEnd` and `afterContractEnd`
  events through the existing shared automation runtime and OneHR email queue. No decision, approval, signature,
  posting, pay confirmation, termination or offboarding outcome is invented by a timer.

The database would permit `bulk_job.created_by` to be null only for those two kinds. A new private provenance row,
written before admission by the storage owner in the same transaction, binds job ID, tenant, fixed kind, cause/date,
native period/event and exact input digest. A deferred foreign key prevents orphan provenance. The public application
role receives no insert/update/delete or admission grant for system jobs. Existing human admission keeps its captured
grants, current-principal check, company scope, seals and cancellation behavior.

The worker would recognize the two fixed kinds only when both the registered handler and private native provenance
agree. It would use owner-only prepare/finalize hooks, with no human SessionContext, `entitlementsExempt`, synthetic
Person, service login or application-role HR transaction. Every unit retains the kernel's seal and lease-capability
checks, and rechecks tenant/module/company activation and the actual Personnel source. A handler flag alone grants
nothing. Failed or stale work records a failure; it never retries uncertain SMTP delivery as a fresh message.

Email delivery must verify the stored system event/provenance instead of requiring an invented human actor. Recipient
identity, immutable payload, private sender capability, delivery start/receipt and uncertain-delivery rules remain in
the existing mail owner. Scheduled run keys stay stable per workflow, case and due date (or day for daily repeats).

Required verification before integration:

- Existing human kernel authorization, capture, revocation, cancellation, seals and lease regressions remain green.
- Null creator with a human kind, wrong system kind, absent/foreign provenance or an application-role insert refuses.
- Mutated kind/input/plan, mismatched event/period, wrong tenant, expired/lost capability and a stale lease refuse.
- Tenant/module/company disablement or changed Personnel identity/dates/number holds work before effects.
- A real no-case fixed-term fixture opens one case and queues the correct reminder without a human actor; replay
  preserves one case/run/mail intent. Unknown counter, legacy WIP, ended employment and a self-substituted identity
  do not auto-open or receive an invented decision.
- Standard hosted runner tests cover 70 companies/1,000 employments, source changes between units and crash/retry.
- SMTP uses a fictional transport and private capability checks; no real test email is sent to employees.

Approval requested: authorize this fixed Contract-only system-job boundary so it can be implemented, tested and
reviewed. Approval would not authorize a merge, staging release, production deployment or package publication.

Implementation follow-up: after the initial generic fix-all attempt was again rejected, the user explicitly approved this exact two-kind boundary. Candidate source now implements the private provenance, fixed kinds, lease/seal checks, native period opening and existing OneHR reminder/digest path in forward migrations 5932–5935. This is source preparation only; no merge, installation or release is authorized. Timer executors and native effect proof reject approvals, document generation, posting and offboarding effects. The daily digest uses the same morning kind and sends only to actual People Ops members who currently have company-wide case viewing authority. Verification is tracked by exact hosted candidate runs, including original failures.
