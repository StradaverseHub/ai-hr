# Documents prepared by a Contract email step

Status: proposed and unapplied. Automatic approval review rejected the new private database adapter because it binds canonical Contract/signing documents and verified actor identities to a workflow email step. No proposed migration, table, event handler or application grant has been registered or installed. The accompanying `.proposal.ts.txt` file is review text and is not imported by the application.

The HTML and existing V9 email owner require this behavior:

1. The first execution of a specific Send email step pins the actual email template ID/version, document list and asset policy. Waiting for HR does not switch it to a later email definition.
2. If the same workflow already generated the selected letter, or the workflow was triggered by that exact letter, reuse its canonical document. Sending the signed ending letter must not generate a second copy requiring HR signatures again.
3. Other selected documents are generated once through the existing document/signing owner. Prepare all selected documents together, then wait for the first document whose HR stages are incomplete.
4. When an actual employee step becomes eligible, queue their invitation. Do not wait for that employee to sign before sending the invitation. Parallel HR/employee steps can proceed together. A missing verified employee account remains held; no substitute signs for them.
5. An internal readiness event comes only from actual canonical document progression/account binding and the exact waiting email step. It resumes that same shared-runtime step. It does not start an arbitrary authored workflow or create another workflow cursor.
6. The existing OneHR delivery queue retains its `run ID + step ID` idempotence key and sender. Repeated events, retries or resumed workers cannot queue duplicate email.
7. The private proof binds actual tenant/case/employment/person, decision revision, originating actor identity, run/step and pinned version. Historical completion may survive a period posting for the same person/company; an identity/company change cannot redirect the old workflow to someone else.
8. An email-only readiness event cannot approve a decision, create a posting, change Personnel/Payroll or reopen a closed Contract case.

The proposed private store contains references only:

```sql
CREATE TABLE public.contract_shared_email_document_step (
 tenant_id uuid NOT NULL,
 case_id uuid NOT NULL,
 workflow_run_id uuid NOT NULL,
 workflow_step_id text NOT NULL,
 email_template_id uuid NOT NULL,
 email_revision integer NOT NULL,
 subject_person_id uuid NOT NULL,
 decision_revision integer NOT NULL,
 phase text NOT NULL CHECK (phase IN ('outcome','declined')),
 documents jsonb NOT NULL DEFAULT '{}'::jsonb,
 prepared_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id,workflow_run_id,workflow_step_id)
);
-- Native foreign keys bind case/run/immutable email version.
-- Forced RLS, owner-only policies and no application table grant.
-- Prepared references and existing document-map entries are immutable.
```

The rejected adapter's API is deliberately narrow:

```ts
prepareContractSharedEmailDocuments(ownerTransaction, protectedContext, {
 step: actualSharedRuntimeStep,
 reference: {id: actualEmailTemplateId, revision: actualEmailRevision},
 create: (templateId, pinnedReference) => canonicalDocumentOwner(...)
})
// Returns the pinned definition/reference, canonical document map,
// and one waiting document ID/reason, or readiness to queue exactly once.
```

The native functions would independently require the existing held workflow capability. They validate the frozen step is actually Send email and selects that email template, choose only documents in that immutable version, and accept only the canonical same-case document receipt. Public callers cannot choose a signer, manufacture a document or claim HR completion.

Required hosted checks include HR-before-employee waiting and invitation timing, reuse of the exact already-generated outcome, multiple documents, paused/changed email definitions, missing accounts, actual identity/company changes, duplicate readiness events and worker retries, no early email/posting, literal restricted-owner upgrade, and unchanged closed-case/Personnel/Payroll facts.

Approval is requested for this bounded native workflow preparation/readiness behavior. It does not approve merging, staging installation or release.
