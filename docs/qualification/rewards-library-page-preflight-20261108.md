# Libraries permission preflight snapshot

Unqualified source-only child of exactf1515376df082438ca025fb65d01a8a3330a8796.
Production remains held. Read the installed Next16 Server/Client Components guide
before editing the existing server component; no framework/cache/client boundary
was changed. No local application, DB, compiler, build, native runtime or provider
checks/calls were run. Only static source-manifest generation and diff inspection.

The shared Salary Structures/Bonus Matrices page previously called setupTenant
only for library_view and manage permission preflights. Both took exclusive tenant
Access although neither appends an event or writes business data. New
rewardLibraryPageAccess owns those two checks in the existing setupReadTenant
RR/RO transaction, retaining fresh native principal/login and the exact native
NULL-company permission owner. It returns only descriptive canManage. View denial
throws; an actual nonthrowing manage predicate returns false for CTRO denial.
No catch continues an aborted SQL transaction or converts a database failure into
false permission. Native SQL failures propagate to the page's existing noAccess
fallback. A later audited read or command independently re-admits authority.
The two UI answers now describe one snapshot rather than two independently
serialized command transactions. They are never a transferable mutation permit.

No audited reader/event, export, confirmation, money calculation, schema/migration,
role/grant, dataset/order, session policy or timeout is changed. rewardLibraries
still appends its durable viewed event and still takes Access/audit-chain locks;
this does not make complete Libraries pages barrier-free or claim zeroBusy.
The separate durable-receipt design remains a proposal and is not implemented.

New native preflight cases use actual GR/CTRO setup grants, no protected-row or
permission mock, actual RR/RO/app role metadata, genericHR denial, company-only and
foreign-tenant refusal, retained-context setup/login revocation and archived login.
A held-writer case checks both real Access and audit-chain writers remain held
while preflights finish; the unchanged audited read must really refuse55P03,
leave its audit rolled back, then append exactly one viewed event on success.
Existing whole-group grant fixtures additionally exercise actual CTRO/GR grants,
revocation and People eligibility through the new owner. Existing populated
financial/history/command tests and CTRO editor rendering remain selected.
Native budgets remain20s statement/300ms lock/30s case on standard hosted runners.

Regenerated source identities provider-first/agent-last because libraries.ts is in
the provider transitive closure. Literal provider approvals/provenance/pending
contracts are untouched; changed generated hashes are not approval to call a
provider or to carry approvals onto a new source. Root owns source-binding review
and hosted dispatch after independent review. Staging still requires the full
architecture/release gates.
