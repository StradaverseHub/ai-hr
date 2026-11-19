# Contract email Form binding order

The actual hosted test at source `83822f528252ba4252d29a2b2fa46fcdef60fcc6` refused an employee's
own unassigned Form signing slot: the canonical binding command read Form values before the
employee was routed. Native Form privacy correctly refused that read. The repair stays within
the owner's approved exact employee self-binding and Form API boundaries.

Migration 6013 preserves the canonical source/Letter/Signing locks, verified current account and
Person, unique employee account, current waiting email pin, company, template version and exact
NULL-to-self slot checks. Only this self-binding path stores its private expected route before
calling the canonical Signing reroute. The Signing content owner uses a narrowly held metadata
branch that validates the actual retained snapshot hash and revision without evaluating hidden
Form values. Once the native route is persisted, the unchanged Form visibility rule controls
normal reads and permitted refresh. Future stages receive no premature Form-body visibility.
Any failure rolls back routing, refresh, history and callbacks together.

The two same-OID replacements add no grants, helpers, policies, tables or columns. Both functions
are already in the pending Contract function inventory; baseline-touch and added-function sets
remain disjoint. The original 1,044 migration SQL files and journal entries are preserved.
Independent source review found no concrete blocker. Runtime assertions cover hidden-before and
routed-after Form visibility, exact account/Person substitution, unchanged prior actions/revision,
no premature employee notices or authored effects, and unrelated/duplicate account rejection.
Hosted native tests and restricted-owner rehearsal remain required; this note grants no PASS,
merge, installation, acceptance or release authority.
