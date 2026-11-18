# Empty Contract opening event technical completion

A genuine fast-user path can submit a new-period decision before its queued, empty caseOpened
job first runs. The old revision-zero context guard then refuses context after the decision
advances. Workflow references frozen at opening are empty; no authored work needs to run.

The owner directly approved the exact reviewed private recovery operation on 17 November 2026:
SQL `4c121b4f3d8e35a1573aba4cb1a858492f6a035ec2b0981f31502e816841091d`,
handler patch `7fd8a9788895df2af22234fe1d82c2836ef1b02c223e10dd73d54c3f7882beaf`.
Independent review found no concrete source blocker. The implementation preserves the actual
human creator/account/Person, tenant/company, current period/source/intake/decision, root input,
operation, untouched plan, held lease/capability and seal checks. It refuses nonempty references,
started opening work, children, effects, unknown provenance and source drift. Other current
decision work on the same case is not mistaken for opening work.

The sole function mutation is the opening event's processed_at. The existing kernel completes
and cleans its actual job normally. It creates no context/PII response, workflow run, approval,
letter, posting, Payroll, Offboarding or access change. Generic worker/effect/event-finish guards
are unchanged; app/PUBLIC execution is revoked. The original inactive-proposal SQL header is
retained with the exact reviewed bytes. Native positive, refusal, seal and rollback tests remain
required; this note supplies no runtime PASS, installation, acceptance, merge or release authority.
