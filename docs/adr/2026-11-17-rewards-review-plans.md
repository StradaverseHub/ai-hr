# Annual Review Plans own company coverage and explicit library rebinding

Status: implements approved board item 0c0d8710; verification and installation remain separate.

The annual owner is `reward_plan_year` with one row per tenant/year. `reward_plan_year_company` owns the unique company/year assignment from its first draft, including incomplete choices. The year owns dates, merit matrix and pool settings; a company save reads those stored settings, never accepts a separate company policy. Existing immutable shared versions and their reviews remain intact. Existing multi-company plans are projected to company rows at upgrade.

New-year creation builds every eligible draft in one transaction. The set reader resolves organisation mapping and headcount once, filters before projection, and derives coverage from the same filtered rows. Current dated assignment and future information-correction precedence determine headcount company. Company-scoped HR sees only their rows; Group Rewards, CTRO and HR Admin edit through the configuration authority and Role permissions row; EC reads metadata only. Review creation continues through the existing Group Rewards authority.

A deliberately changed salary structure or bonus matrix creates an immutable plan successor. This refines ADR-0137's rule that a review keeps its original library versions: automatic propagation remains prohibited, while this explicit command may rebind a review before final EC approval. It preserves the review's company, roster, stage, independent historical versions and decisions. The protected owner updates its policy through the existing deterministic library/PAT projection and notifies the current approver for a released review. Final approved, posted and closed reviews refuse changes.

An exact-revision marker allows the authorized native review command to bind the recalculated digest at its next mutation. It cannot heal any unrelated stale input or change approval stage. A private transaction lease, which the application role cannot write, admits the narrow immutable-binding guard exception; a caller-controlled GUC cannot authorize it.

Bulk creation is a client of the shared bulk-job kernel. A company and its applied checkpoint commit together, and a resumed step skips a company that already has its annual review. Review snapshots hold shared Access mode, allowing ordinary protected reads and Workforce work to overlap; Access configuration changes retain their exclusive owner.

Company creation, classification and published Group structure changes append a durable outbox nomination in their source transaction. The continuous protected import worker rechecks current legal-entity eligibility and open years, inserts at most 100 new company/year drafts per tick, and appends system audit events. Draft rows have no immutable legacy version until choices are saved. No old year is inferred closed; the explicit `is_open` flag owns future closure. Group Rewards holders receive a case-free configuration notice containing company/year identity, never employee pay. The grid includes eligible missing rows as a read-only safety net until the outbox catches up.

No production deployment is authorized by this decision or by a focused CI pass.
