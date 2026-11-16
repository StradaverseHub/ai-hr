# Employee account binding for a held email document

Status: proposed, not applied or registered as a migration. Automatic approval review rejected this authorization change; the current implementation retains the hold after the Contract period changes.

An employee may receive a document with an Employee signing step while they have no verified AIHR account. If their Contract case has already posted by the time their account is verified, the existing account-binding command cannot connect that account to the held step. The proposal permits that employee to connect their own account and complete the document.

This applies only to an email document and the actual Personnel person captured when it was generated. Exactly one verified active account must belong to that person. HR, fallback group members and other people cannot use this new path. The employee cannot choose another account, change another step, replace a completed signature, change the letter text or update Personnel or Payroll.

The native binding command first prepares the exact private route change from an empty Employee holder to this account/person. The proposed signing adapter accepts only that exact prepared change. Ordinary application callers cannot edit the private expected route. The existing behavior for all other operations remains in place.

Hosted verification [43944812872](https://github.com/StradaverseHub/ai-hr/actions/runs/43944812872), candidate `02d790546626870299694bc94f628cb0f1000d8f`, passed six native database tests. The proof helper rejects ordinary generic replacement, an HR actor, a change to another step and ambiguous employee accounts. Other tests prove unchanged closed-case state, refusal after a Personnel person change, retained original values, and safe concurrent signature/decline handling. These prove the helper and existing command boundaries; the proposed adapter itself still needs implementation and its positive/negative integration tests.

The following is an unapplied migration proposal, shown for review only:

```sql
ALTER FUNCTION app.contract_shared_signing_access(text,uuid,text)
 RENAME TO contract_shared_signing_access_before_self_binding;

CREATE FUNCTION app.contract_shared_signing_access(
 p_type text,p_subject uuid,p_operation text
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE
 WHEN p_type='contract' AND p_operation='reroute'
  AND app.contract_shared_email_self_binding_held(p_subject)
 THEN true
 ELSE app.contract_shared_signing_access_before_self_binding(
  p_type,p_subject,p_operation)
 END
$$;

-- Both helpers remain private. Application entry points call the native
-- subject owner, which checks real actor identity and its prepared policy.
REVOKE ALL ON FUNCTION
 app.contract_shared_signing_access_before_self_binding(text,uuid,text),
 app.contract_shared_signing_access(text,uuid,text)
FROM PUBLIC,ai_hr_app;
```

Approval is requested only for this bounded account-binding behavior. It does not approve merging, staging installation or release.
