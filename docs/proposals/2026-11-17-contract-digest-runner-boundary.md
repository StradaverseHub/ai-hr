# Contract daily digest: exact shared runner gate approval

Status: **review proposal only; not applied**. The daily flagged-case producer, paged private receipts and protected OneHR delivery proof exist in the candidate. The existing queue rejects a morning digest because `app.automation_can_run` requires a Contract workflow event; a digest has a genuine morning-job receipt instead. A fabricated event or saved human account would be incorrect.

Automatic approval review rejected changing this persistent shared permission predicate because the earlier specific approval named reminders and case opening. It requires explicit approval of the digest gate described here. No alternative queue or indirect guard bypass is proposed.

The adjacent patch adds one owner-private **non-definer** helper and changes only the Contract branch of existing `app.automation_can_run(text,uuid)`. The existing branch remains intact and is joined with this exact additional proof:

- The worker holds the existing lease/seal capability and immutable private provenance for a null-creator `contract_schedule` job.
- The real private digest receipt belongs to that tenant, job and anchor case.
- Its exact mail key equals the transaction-local `app.contract_digest` key, set immediately before calling the existing OneHR queue.

There are no new kinds, application grants, people, roles, impersonated users or public APIs. Probation, Offboarding and all existing Contract event guards remain byte-for-byte within their current branches. Native business-effect guards still reject a morning digest as an approval, document-generation, posting or offboarding event. Existing recipient account/person binding, current People Ops membership and company-wide viewing authority, tenant/module activation, private sender capability and uncertain-delivery rules still apply.

Proposed verification after approval: actual daily digest mail and private OneHR target; more than 100 recipients; group/access revocation; no grant without a genuine lease/provenance/receipt/key; tenant/case/key mismatch; unchanged human Contract and shared Offboarding/Probation sender regressions. The existing hosted failure is run43999497531: reminders, native 70-company/1,000-period opening and paused-decision acceptance pass; the two digest cases are refused by the current queue gate.

Approval requested: authorize only this Contract daily-digest branch extension of the existing shared queue predicate. This does not authorize merging, installation, release or additional HR outcomes.

Follow-up: the user specifically approved this exact Contract daily-digest gate. Forward migration5937 and the exact transaction-local mail-key binding are now implemented in the isolated candidate; the original rejection/proposal and failed hosted receipt are retained. No merge or release is authorized.
