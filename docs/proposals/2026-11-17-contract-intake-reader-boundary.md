# Contract intake reader review proposal — not applied

Automatic approval review rejected implementing a persistent SECURITY DEFINER reader granted to ai_hr_app because its exact SQL boundary was not separately approved. No rejected command executed. The isolated branch remains at a30ed7a4f45eca7a16053150a03176bdb1bc0b1f.

Requested authority: add only app.contract_admission_page(text,uuid,integer,integer), a read-only SQL-paged/search replacement for the existing intake page's one-transaction-per-company calls. Grant only EXECUTE on that reader to ai_hr_app, revoke PUBLIC. No table grants, business writes, or other permission changes.

Actual native disclosure remains effective opted-in Contract GBS plus canonical shared People Ops membership, or actual uniquely matched native PBP plus effective company/business-unit PBP role and independent verified account. Tenant/module/effective date/canonical routing/source assignment guards remain. HR administrators and named Contract View holders alone do not gain intake. Output only existing five fields id/name/employeeId/startOn/endOn plus their companyId; company flags preserve the existing filtered company choices. No pay or health facts.

One bounded page (1–100 rows), search <=100 characters, offset <=100000. Count and page in SQL, same company-name/company-id/name/id order, per-company original 2000-candidate cap. The unchanged old single-company reader supplies an independent equivalence oracle. New read holds shared Access lock only. No per-company/per-employment privileged permission function calls.

Minimal UI: server-backed company/search/pagination; no all-data preload. Existing source preview, intake, custody, health, movement, and all other writers remain unchanged.

Proofs before integration: 70 companies/1000 actual fixed-term employments; ordered new all-company vs union of old readers, exact one-company equivalence, GBS company/BU scope, native PBP routing/ambiguity, expired/revoked grants, own-person exclusion, archived actors, module expiry, void/import/blacklist and noncontract exclusions, source-field redaction, SQL paging/search count, restricted-owner migration and whole types on hosted Actions.

No merge, release or installation is authorized by this proposal. Exact candidate SQL is supplied alongside this document for review only; it has not been placed into the repository or registered.

Exact reviewed implementation: [SQL + TypeScript + UI patch](2026-11-17-contract-intake-reader-boundary.patch). SQL begins the patch; it remains an unexecuted proposal. Existing single-company reader and every writer retain their bytes. Normal journal/hash registration and the listed hosted proofs follow only after approval.

Approval question: May I implement this exact read-only Contract intake boundary: one SECURITY DEFINER app.contract_admission_page reader, granted only to the application role, preserving current native GBS/PBP rights and existing five source fields, with server-backed company/search/paging and no employment, health, access, or other business writes?
