# End decisions recorded after the contract end

Status: a reproducible unfinished edge case. The existing canonical Offboarding constructor rejects a notice date after the last working day. No proposed fix below has been applied.

A Contract decision can legitimately be recorded after the current period has expired. The source HTML still starts Offboarding with the real contract end as the last working day. Current code releases the letter, then refuses the handoff with “Last working day cannot be before notice date.” The case remains held and Personnel is unchanged.

The regression named “reproduces the overdue End handoff hold…” exercises the real preview, submission, kernel, letter release and failed handoff. It asserts that neither historical contract dates nor Personnel termination/counter data are changed. A passing reproduction is evidence of the hold, not completion of retrospective handoff.

The narrow proposed correction is:

- Keep the real contract end date as the last working day.
- Use the actual released-letter timestamp as the recorded notice date, as the existing legacy Contract handoff does. Do not clamp it backwards or imply that an employee received an earlier notice.
- Permit this chronology only for a `shared-contract` construction after its private held source intent matches every canonical input. Ordinary/manual, legacy Contract and Probation construction keep their current chronology rule.
- Mark the pending Offboarding case for People Ops to review the actual notice/dates before continuing. No clearance is fabricated.
- Preserve the existing canonical constructor, duplicate-exit protection, exact signed-letter receipt, tenant/person/company checks and source-first locks.
- Continue the user's interim: People Ops records termination manually in Personnel Management. This does not write termination or Payroll.

The companion `.patch.txt` contains the concrete unapplied correction. The private SQL intent would need a forward migration; existing migration bytes and pins must not be edited. Hosted checks must cover future/past endings, declined renewals, actual timestamps, unchanged manual/legacy/Probation chronology rules, duplicate source receipts, concurrent creation, restricted-owner migration and no automatic Personnel/Payroll effect.

This proposal does not approve merging, staging installation or release.
